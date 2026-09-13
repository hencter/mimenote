//! 图片附件写入：把前端粘贴 / 拖入的图片落进 Vault 的**附件目录**（见 ADR-0013）。
//!
//! 为什么需要这一层：ADR-0007 只解决了"**读**本地图片"（asset 协议逐文件授权），
//! 而"在编辑器里 `Ctrl+V` 粘一张截图"缺的是"**写**"。写比读危险得多 ——
//! 读失败的表现是"图片不显示"，写失败的表现是"渲染进程能让宿主往 Vault 里写任意字节"。
//! 所以本模块的每一条约束都是**硬性**的，不依赖前端是否老实（前端那两道提示只是"提前说一声"）：
//!
//! | 约束 | 拦住什么 |
//! | --- | --- |
//! | 扩展名白名单（与 [`crate::assets`] **同一份**常量） | 被攻破的前端把 `.exe` / `.dll` / `autorun.inf` 写进 Vault |
//! | 单张 ≤ 8 MiB、一批 ≤ 32 MiB、≤ 32 张 | 一次 IPC 就把内存或磁盘打满 |
//! | 目录与文件名都过 `path_guard`（`resolve_for_write`） | 目录穿越、符号链接逃逸、Windows 保留名与 NTFS 备用数据流 |
//! | 文件名必须是**单段**且非空 | 用 `../x.png`、`a/b.png` 绕开"附件目录"这个设置 |
//! | `mn_core::atomic::write_atomic` | 崩溃 / 断电留下半写的图片（ADR-0004） |
//! | 先把一批的**全部**目标路径算完再写 | "三张落盘、第四张被拒"的中间态 |
//!
//! 与 [`crate::export`] 的分工：导出命令是宿主里**唯一**允许写 Vault **之外**路径的命令
//! （路径来自系统保存对话框）；本命令只写 Vault **之内**，而且落点由"附件目录 + 文件名"
//! 拼出来，因此**必须**过 `path_guard`，不能自己 `Path::join` 用户输入。
//!
//! 内容走 base64 而不是"前端给一个磁盘路径"：WebView 里拿到的 `File` / `ClipboardEvent`
//! 只有**字节**，没有可用的本地路径（这是浏览器的安全模型，不是实现偷懒）；
//! 反过来，若允许前端传"源路径"让宿主自己去 `fs::copy`，那就等于开了一条
//! "让宿主读任意文件并复制进 Vault"的通道 —— 这正是 ADR-0007 花力气避免的事。
//! 代价是 base64 会把报文撑大约 4/3，靠 8 MiB / 32 MiB 两道闸门兜住。

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use mn_core::atomic::write_atomic;
use mn_core::{EntryMeta, Error, VaultRoot};

use crate::assets::{base64_decode, is_allowed_image, ALLOWED_IMAGE_EXTENSIONS};
use crate::error::IpcError;
use crate::state::AppState;

/// 单张附件的大小上限（8 MiB）。
///
/// 与 `assets.rs` 的 `MAX_EMBED_IMAGE_BYTES` 同一量级：导出**内嵌**一张图的限制是 8 MiB，
/// 那么允许**写进 Vault** 的图也不该比它更大 —— 否则会出现"能存进去、导出时却嵌不进去"的
/// 诡异组合。超过就报 `TOO_LARGE`（不静默跳过：用户刚粘了一张图，必须知道它没落盘）。
pub const MAX_ATTACHMENT_BYTES: u64 = 8 * 1024 * 1024;

/// 一次请求的**原始字节**总量上限（32 MiB，base64 之后约为此值的 4/3）。
///
/// 与单张上限是两道独立的闸门：张数上限挡"几百张小图"，字节上限挡"四张大图"。
/// 与 `MAX_EMBED_BATCH_BYTES` 同量级，理由同上。
pub const MAX_ATTACHMENT_BATCH_BYTES: u64 = 32 * 1024 * 1024;

/// 一次请求最多接受的张数。
///
/// 一次粘贴 / 拖放的真实规模是个位数；32 是"批量拖一整个文件夹的图"也够用、
/// 而不会被拿来当文件上传通道的折中。
pub const MAX_ATTACHMENTS_PER_REQUEST: usize = 32;

/// 同名去重的最大尝试次数（与 `commands.rs` 的 `unique_note_path` 同一口径）。
const MAX_DEDUPE_ATTEMPTS: u32 = 1000;

/// 一张待写入的附件（`src/ipc/types.ts` 的 `AttachmentInput` 手工镜像）。
///
/// `name` 是**用户可见的文件名**（含扩展名，如 `屏幕截图 2025-01-01.png`）；
/// 命名与去重由前端先做一遍（那里有"从 MIME 推断扩展名"的规则），宿主只做**校验 + 去重兜底**。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInput {
    pub name: String,
    /// **标准 base64**（RFC 4648，含 `=` 填充）的原始字节。
    pub data_base64: String,
}

/// 写入成功的一张附件。
///
/// 字段名是 IPC 契约的一部分（`src/ipc/types.ts` 手工镜像），一律 camelCase。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentSaved {
    /// 落盘后的 Vault 相对路径（POSIX，已含去重后的最终名字）。
    pub rel_path: String,
    /// **原始字节数**（不是 base64 之后的长度）。
    pub size_bytes: u64,
}

/// 写入成功的一张附件（宿主内部用：多带一个 mtime 供条目缓存使用，不进 IPC）。
#[derive(Debug, Clone)]
struct SavedFile {
    rel_path: String,
    size_bytes: u64,
    mtime_ms: u64,
}

/// 三道闸门的取值（做成一个结构，单测才能用**小载荷**把每条分支都走一遍）。
#[derive(Debug, Clone, Copy)]
struct AttachmentLimits {
    max_bytes: u64,
    max_batch_bytes: u64,
    max_files: usize,
}

/// 生产取值（与模块文档里的策略逐字对应）。
const LIMITS: AttachmentLimits = AttachmentLimits {
    max_bytes: MAX_ATTACHMENT_BYTES,
    max_batch_bytes: MAX_ATTACHMENT_BATCH_BYTES,
    max_files: MAX_ATTACHMENTS_PER_REQUEST,
};

/// 把一批图片写进 Vault 的附件目录，返回它们落盘后的相对路径。
///
/// 参数口径（`src/ipc/types.ts` 手工镜像）：
///
/// * `dir_rel` —— 附件目录（相对 Vault 根，空串 = Vault 根目录）。不存在时**自动创建**；
///   反斜杠与首尾 `/` 都容忍（与 `note_move` 的目录参数同一口径）；
/// * `files` —— 待写入的图片（文件名 + base64 字节）。
///
/// 错误码（前端只按 `code` 分支）：
///
/// * 非图片扩展名 / 载荷为空或不是合法 base64 / 文件名含分隔符 → `UNSUPPORTED_MEDIA`；
/// * 文件名或目录非法（保留名、`..`、非法字符）→ `PATH_INVALID`；逃出 Vault → `PATH_ESCAPE`；
/// * 超过单张 / 单批 / 张数上限 → `TOO_LARGE`；
/// * 磁盘错误 → `IO`。
///
/// **不做**静默跳过：与只读的 `asset_read_base64` 刻意不同 —— 那里跳过一张坏图的代价是
/// "占位文字"，而这里跳过一张图的代价是"用户以为图存下来了"。
#[tauri::command]
pub async fn attachment_save(
    state: State<'_, Arc<AppState>>,
    dir_rel: String,
    files: Vec<AttachmentInput>,
) -> Result<Vec<AttachmentSaved>, IpcError> {
    if files.is_empty() {
        return Ok(Vec::new());
    }

    let root = state.vault_root()?;
    let app = Arc::clone(state.inner());
    let dir = dir_rel;

    // 建目录 + 原子写都是文件 IO → 按 ADR-0003 放阻塞线程
    let saved = tauri::async_runtime::spawn_blocking(move || {
        // 写锁：让「找一个不重名的名字 → 落盘」成为临界区。否则两次并发粘贴（或一次多张里
        // 名字相同）会各自看到"这个名字还空着"，后写的把先写的覆盖掉。
        // 与 `note_write` 共用同一把锁（ADR-0004）。
        let _write_guard = app.write_guard();
        save_attachments(&root, &dir, &files)
    })
    .await
    .map_err(|error| IpcError::internal(format!("附件写入任务失败：{error}")))??;

    // 条目缓存的增量更新（不重扫目录）：先补父目录再补文件。
    // 缺了父目录条目，前端 `domain/tree` 会把附件当成"父目录缺失"而提升到根节点 ——
    // 表现是"新建的附件目录看不见、图片挂在最外层"（同一个坑见 commands.rs 的
    // `register_moved_dirs`，这里刻意复用同一份实现而不是再写一遍）。
    for item in &saved {
        crate::commands::register_moved_dirs(&state, &item.rel_path);
        let rel_path = item.rel_path.clone();
        let size_bytes = item.size_bytes;
        let mtime_ms = item.mtime_ms;
        state.update_vault(|ctx| {
            ctx.upsert(EntryMeta {
                name: crate::commands::file_name_of(&rel_path),
                ext: crate::commands::ext_of(&rel_path),
                rel_path,
                is_dir: false,
                size_bytes,
                mtime_ms: Some(mtime_ms),
            })
        });
    }

    log::info!(
        "附件写入：{} 张，共 {} 字节 → {}",
        saved.len(),
        saved.iter().map(|item| item.size_bytes).sum::<u64>(),
        saved
            .iter()
            .map(|item| item.rel_path.as_str())
            .collect::<Vec<_>>()
            .join("、")
    );

    Ok(saved
        .into_iter()
        .map(|item| AttachmentSaved {
            rel_path: item.rel_path,
            size_bytes: item.size_bytes,
        })
        .collect())
}

/// [`attachment_save`] 的主体（与 Tauri 无关，可单测）：生产取值直接喂给
/// [`save_attachments_with`]。
fn save_attachments(
    root: &VaultRoot,
    dir_rel: &str,
    files: &[AttachmentInput],
) -> Result<Vec<SavedFile>, IpcError> {
    save_attachments_with(root, dir_rel, files, LIMITS)
}

/// 真正的实现（上限作为参数传入，便于用**小载荷**单测每一道闸门）。
///
/// 两阶段：
///
/// 1. **只校验**：扩展名 → 大小 → base64 → 目标路径（含去重）。任何一条不通过都直接返回，
///    此时**一个字节都没落盘**（连附件目录都不会被创建）；
/// 2. **写入**：建目录 → 逐张原子写。
///
/// 为什么值得分两阶段：一次拖入四张图、其中一张是 `.pdf` 时，用户想要的是
/// "整批被拒绝、告诉我为什么"，不是"三张进了 Vault、树里多三个文件、链接里只插了一条"。
/// 第二阶段中途失败（磁盘满、权限）仍可能留下已写好的前几张 —— 那时返回 `IO`，
/// 前端不会插入任何链接，落下的文件是**孤儿附件**（不覆盖、不破坏，用户可自行删掉）。
fn save_attachments_with(
    root: &VaultRoot,
    dir_rel: &str,
    files: &[AttachmentInput],
    limits: AttachmentLimits,
) -> Result<Vec<SavedFile>, IpcError> {
    if files.len() > limits.max_files {
        return Err(Error::TooLarge(format!(
            "一次最多接受 {} 张图片（本次 {} 张）",
            limits.max_files,
            files.len()
        ))
        .into());
    }

    let dir = normalize_dir(dir_rel);
    let dir_path = resolve_dir(root, &dir)?;

    let mut planned: Vec<(String, PathBuf, Vec<u8>)> = Vec::with_capacity(files.len());
    // 同一批里已经占用的相对路径：只查磁盘会把"本批前一张刚定的名字"漏掉
    let mut reserved: HashSet<String> = HashSet::new();
    let mut total_bytes: u64 = 0;

    for file in files {
        let name = file.name.trim();
        if name.contains('/') || name.contains('\\') {
            return Err(Error::invalid(name, "附件文件名不能含路径分隔符").into());
        }
        // 扩展名白名单（与渲染授权共用同一份常量）：不是图片就**连 base64 都不解码**
        if !is_allowed_image(name) {
            return Err(IpcError::unsupported_media(format!(
                "只接受图片附件（{}），已拒绝：{}",
                allowed_extensions_hint(),
                if name.is_empty() {
                    "（文件名为空）"
                } else {
                    name
                }
            )));
        }
        // 只有扩展名、没有名字（`.png`）也拒掉：它落到磁盘上就是个隐藏文件，
        // 之后同名去重只能造出 ` 1.png` 这种谁也认不出的名字。
        // （前端会把这类名字换成带时间戳的名字，这里是兜底）
        if name
            .rsplit_once('.')
            .is_none_or(|(stem, _)| stem.trim().is_empty())
        {
            return Err(IpcError::unsupported_media(format!(
                "附件文件名缺少名字部分，已拒绝：{name}"
            )));
        }
        // 用编码长度估一个上界（4 字符 ≤ 3 字节），避免为一个 100 MB 的载荷真的分配出 75 MB
        // 的 Vec；正因为是上界，`estimate ≤ 上限` 就能保证解码后的结果也不超限，无需再比一次。
        if estimated_bytes(file.data_base64.len()) > limits.max_bytes {
            return Err(Error::TooLarge(format!(
                "{name}：{}+ 字节 > 单张上限 {} 字节",
                estimated_bytes(file.data_base64.len()),
                limits.max_bytes
            ))
            .into());
        }
        let Some(bytes) = base64_decode(&file.data_base64) else {
            return Err(IpcError::unsupported_media(format!(
                "附件载荷不是合法的 base64：{name}"
            )));
        };
        if bytes.is_empty() {
            // 空载荷写出来就是一个 0 字节的"图片"：它既显示不出来，又占着名字，
            // 后续同名粘贴会被去重成 ` 1` —— 宁可直接拒掉。
            return Err(IpcError::unsupported_media(format!(
                "附件内容为空，已拒绝：{name}"
            )));
        }

        total_bytes = total_bytes.saturating_add(bytes.len() as u64);
        if total_bytes > limits.max_batch_bytes {
            return Err(Error::TooLarge(format!(
                "本批附件合计超过上限 {} 字节（写到 {name} 时已达 {total_bytes} 字节）",
                limits.max_batch_bytes
            ))
            .into());
        }

        let (rel, path) = unique_target(root, &dir, name, &reserved)?;
        reserved.insert(rel.clone());
        planned.push((rel, path, bytes));
    }

    // 目录在**校验全部通过之后**才创建：校验失败时 Vault 里不该多出任何东西
    std::fs::create_dir_all(&dir_path).map_err(|e| Error::io(&dir_path, e))?;

    let mut saved = Vec::with_capacity(planned.len());
    for (rel_path, path, bytes) in planned {
        write_atomic(&path, &bytes)?;
        let metadata = std::fs::metadata(&path).map_err(|e| Error::io(&path, e))?;
        saved.push(SavedFile {
            rel_path,
            size_bytes: bytes.len() as u64,
            mtime_ms: mn_core::atomic::mtime_ms(&metadata).unwrap_or(0),
        });
    }
    Ok(saved)
}

/// base64 文本长度 → **原始字节的上界**（4 个字符最多承载 3 字节）。
///
/// 用字节长度而不是字符数：非 ASCII 只会让这个上界更保守（更早拒绝），方向是安全的。
fn estimated_bytes(encoded_len: usize) -> u64 {
    (encoded_len / 4 * 3) as u64
}

/// 归一化附件目录：反斜杠 → `/`、去掉首尾 `/`（`''` 表示 Vault 根）。
///
/// 只做"形状"归一，不在这里判非法 —— `..`、保留名之类的判定只有一处（`path_guard`），
/// 这里再判一次就又多了一份口径要维护。
fn normalize_dir(dir_rel: &str) -> String {
    dir_rel
        .trim()
        .replace('\\', "/")
        .trim_matches('/')
        .to_string()
}

/// 解析附件目录（不存在时**先不创建**，只在最后写入前创建）。
fn resolve_dir(root: &VaultRoot, dir: &str) -> Result<PathBuf, IpcError> {
    if dir.is_empty() {
        return Ok(root.path().to_path_buf());
    }
    // 逐段校验 + 逐级符号链接检查；目录还不存在时检查止于缺失的那一段
    let path = root.resolve_for_write(dir)?;
    if path.exists() && !path.is_dir() {
        return Err(Error::NotADirectory(dir.to_string()).into());
    }
    Ok(path)
}

/// 在 `dir` 下为 `name` 找一个不冲突的相对路径（同名追加 ` 1` / ` 2` …，**绝不覆盖**）。
fn unique_target(
    root: &VaultRoot,
    dir: &str,
    name: &str,
    reserved: &HashSet<String>,
) -> Result<(String, PathBuf), IpcError> {
    // `is_allowed_image` 已经保证名字里有点且有白名单扩展名，这里只是防御性写法
    let (stem, extension) = name.rsplit_once('.').unwrap_or((name, ""));
    for attempt in 0..MAX_DEDUPE_ATTEMPTS {
        let candidate_name = if attempt == 0 {
            name.to_string()
        } else {
            format!("{stem} {attempt}.{extension}")
        };
        let rel = if dir.is_empty() {
            candidate_name
        } else {
            format!("{dir}/{candidate_name}")
        };
        // 目标路径**必须**经 path_guard：越界、符号链接、保留名、ADS 都在这一步被拒
        let path = root.resolve_for_write(&rel)?;
        if reserved.contains(&rel) || path.exists() {
            continue;
        }
        return Ok((rel, path));
    }
    Err(Error::AlreadyExists(format!("{name} 的重名尝试超过 {MAX_DEDUPE_ATTEMPTS} 次")).into())
}

/// 错误提示里列出的扩展名（取自白名单本身，不另写一份）。
fn allowed_extensions_hint() -> String {
    ALLOWED_IMAGE_EXTENSIONS
        .iter()
        .map(|ext| format!(".{ext}"))
        .collect::<Vec<_>>()
        .join(" / ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_vault() -> (tempfile::TempDir, VaultRoot) {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        (dir, root)
    }

    /// 一个附件输入（base64 由 `assets::base64_encode` 生成 —— 编解码只允许有一处实现）。
    fn input(name: &str, bytes: &[u8]) -> AttachmentInput {
        AttachmentInput {
            name: name.to_string(),
            data_base64: crate::assets::base64_encode(bytes),
        }
    }

    /// 小而紧的三道闸门：单张 12 字节的 base64 **上界**（= 最多 12 字节的图）、
    /// 一批 20 字节、最多 3 张。
    ///
    /// 注意这里比的是 base64 长度的上界（见 `estimated_bytes`），所以用 7 字节 / 12 字节
    /// 这类"刚好卡在边界上"的载荷来验证两个方向。
    const TINY: AttachmentLimits = AttachmentLimits {
        max_bytes: 12,
        max_batch_bytes: 20,
        max_files: 3,
    };

    fn read(dir: &std::path::Path, rel: &str) -> Vec<u8> {
        std::fs::read(dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR))).unwrap()
    }

    #[test]
    fn writes_into_the_attachment_directory_and_creates_it() {
        let (dir, root) = temp_vault();
        assert!(!dir.path().join("附件").exists(), "起点不该有附件目录");

        let saved = save_attachments(&root, "附件", &[input("图.png", b"png-bytes")]).unwrap();

        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].rel_path, "附件/图.png");
        assert_eq!(saved[0].size_bytes, 9);
        assert_eq!(read(dir.path(), "附件/图.png"), b"png-bytes", "逐字节落盘");
        assert!(dir.path().join("附件").is_dir(), "目录应被自动创建");
    }

    #[test]
    fn empty_dir_means_the_vault_root() {
        let (dir, root) = temp_vault();
        let saved = save_attachments_with(&root, "", &[input("图.png", b"ok")], TINY).unwrap();
        assert_eq!(saved[0].rel_path, "图.png");
        assert_eq!(read(dir.path(), "图.png"), b"ok");
    }

    #[test]
    fn tolerates_backslashes_and_surrounding_slashes_in_the_directory() {
        let (_, root) = temp_vault();
        let cases = [(r"\素材\图片\", "甲.png"), ("/素材/图片/", "乙.png")];
        for (candidate, name) in cases {
            let saved =
                save_attachments_with(&root, candidate, &[input(name, b"ok")], TINY).unwrap();
            assert_eq!(
                saved[0].rel_path,
                format!("素材/图片/{name}"),
                "输入：{candidate}"
            );
        }
    }

    #[test]
    fn trims_surrounding_whitespace_in_the_file_name() {
        // 浏览器给的 `File.name` 一般很干净，但剪贴板/某些工具会带上首尾空白；
        // 直接落盘会得到一个"看起来一样、实际不同"的文件名（Windows 还会静默截断尾部空格）
        let (_, root) = temp_vault();
        let saved = save_attachments(&root, "附件", &[input("  图.png  ", b"ok")]).unwrap();
        assert_eq!(saved[0].rel_path, "附件/图.png");
    }

    #[test]
    fn keeps_the_original_file_name() {
        let (dir, root) = temp_vault();
        let saved =
            save_attachments(&root, "附件", &[input("屏幕截图 2025-01-01.png", b"ok")]).unwrap();
        assert_eq!(saved[0].rel_path, "附件/屏幕截图 2025-01-01.png");
        assert!(dir.path().join("附件/屏幕截图 2025-01-01.png").exists());
    }

    #[test]
    fn dedupes_existing_names_without_overwriting() {
        let (dir, root) = temp_vault();
        save_attachments(&root, "附件", &[input("图.png", b"first")]).unwrap();

        let second = save_attachments(&root, "附件", &[input("图.png", b"second")]).unwrap();
        let third = save_attachments(&root, "附件", &[input("图.png", b"third")]).unwrap();

        assert_eq!(second[0].rel_path, "附件/图 1.png");
        assert_eq!(third[0].rel_path, "附件/图 2.png");
        // 第一张**一个字节都不能变**（绝不覆盖是这条规则的唯一目的）
        assert_eq!(read(dir.path(), "附件/图.png"), b"first");
        assert_eq!(read(dir.path(), "附件/图 1.png"), b"second");
    }

    #[test]
    fn dedupes_within_one_batch() {
        let (_, root) = temp_vault();
        let saved = save_attachments(
            &root,
            "附件",
            &[input("图.png", b"a"), input("图.png", b"b")],
        )
        .unwrap();
        assert_eq!(saved[0].rel_path, "附件/图.png");
        assert_eq!(
            saved[1].rel_path, "附件/图 1.png",
            "同一批里的第二张也要让位（只查磁盘会漏掉它）"
        );
    }

    #[test]
    fn accepts_every_whitelisted_extension_case_insensitively() {
        // 白名单是渲染授权、导出内嵌与附件写入**共用**的那一份（`assets.rs`）——
        // 这里逐个扩展名确认"能渲染的图也一定写得进去"，两边漂移会表现成
        // "显示得了、粘不进来"这种只在某个扩展名上出现的怪状态
        let (_, root) = temp_vault();
        for ext in ALLOWED_IMAGE_EXTENSIONS {
            let name = format!("图.{}", ext.to_ascii_uppercase());
            let saved = save_attachments(&root, "附件", &[input(&name, b"ok")])
                .unwrap_or_else(|error| panic!("{ext} 应被接受：{error}"));
            assert_eq!(saved[0].rel_path, format!("附件/{name}"));
        }
    }

    #[test]
    fn rejects_non_image_extensions_without_touching_the_disk() {
        let (dir, root) = temp_vault();
        for name in ["说明.pdf", "脚本.exe", "笔记.md", "无扩展名", ".png", ""] {
            let error = save_attachments(&root, "附件", &[input(name, b"x")]).unwrap_err();
            assert_eq!(error.code, "UNSUPPORTED_MEDIA", "{name} 必须被拒绝");
        }
        // 整批被拒 = Vault 里什么都不该多出来（连附件目录都不建）
        assert!(!dir.path().join("附件").exists());
    }

    #[test]
    fn rejects_one_bad_file_out_of_a_batch_as_a_whole() {
        let (dir, root) = temp_vault();
        let files = [input("好图.png", b"ok"), input("说明.pdf", b"x")];
        let error = save_attachments_with(&root, "附件", &files, TINY).unwrap_err();

        assert_eq!(error.code, "UNSUPPORTED_MEDIA");
        assert!(
            error.message.contains("说明.pdf"),
            "提示要点名：{}",
            error.message
        );
        assert!(!dir.path().join("附件").exists(), "不允许半批落盘");
    }

    #[test]
    fn rejects_names_with_path_separators() {
        let (dir, root) = temp_vault();
        for name in ["子目录/图.png", r"子目录\图.png"] {
            let error = save_attachments(&root, "附件", &[input(name, b"x")]).unwrap_err();
            assert_eq!(
                error.code,
                mn_core::ErrorCode::PathInvalid.as_str(),
                "{name}"
            );
        }
        assert!(!dir.path().join("附件").exists());
    }

    #[test]
    fn rejects_traversal_reserved_names_and_illegal_characters() {
        let (dir, root) = temp_vault();
        // 越界的目录（`..` 是 path_guard 的拒绝面）
        assert!(save_attachments(&root, "../外面", &[input("图.png", b"x")]).is_err());
        // 文件名侧：Windows 保留名、非法字符、没有名字部分
        for name in ["con.png", "COM1.png", "a:b.png", "a?b.png", ".png"] {
            let error = save_attachments(&root, "附件", &[input(name, b"x")]).unwrap_err();
            assert!(
                error.code == "PATH_INVALID" || error.code == "UNSUPPORTED_MEDIA",
                "{name} 必须被拒绝（实际码：{}）",
                error.code
            );
        }
        assert!(!dir.path().join("附件").exists());
    }

    #[test]
    fn rejects_empty_and_malformed_payloads() {
        let (dir, root) = temp_vault();
        let empty = AttachmentInput {
            name: "图.png".into(),
            data_base64: String::new(),
        };
        let malformed = AttachmentInput {
            name: "图.png".into(),
            data_base64: "Zm9v!".into(),
        };
        for file in [empty, malformed] {
            let error = save_attachments(&root, "附件", &[file]).unwrap_err();
            assert_eq!(error.code, "UNSUPPORTED_MEDIA");
        }
        assert!(!dir.path().join("附件").exists());
    }

    #[test]
    fn rejects_payloads_over_the_per_file_limit() {
        let (_, root) = temp_vault();
        // 13 字节 → base64 20 字符 → 上界 15 字节 > 单张 12 字节
        let big = vec![b'a'; 13];
        let error =
            save_attachments_with(&root, "附件", &[input("大.png", &big)], TINY).unwrap_err();
        assert_eq!(error.code, "TOO_LARGE");
        assert!(error.message.contains("大.png"), "{}", error.message);

        // 刚好卡在上界上的载荷允许（边界是"**超过**才拒"）
        let ok = save_attachments_with(&root, "附件", &[input("小.png", &[b'a'; 12])], TINY);
        assert_eq!(ok.unwrap()[0].size_bytes, 12);
    }

    #[test]
    fn stops_when_the_batch_budget_is_used_up() {
        let (dir, root) = temp_vault();
        // 每张 7 字节、一批 20 字节 → 前两张（14）通过，第三张（21）被挡
        let seven = vec![b'a'; 7];
        let files = [
            input("甲.png", &seven),
            input("乙.png", &seven),
            input("丙.png", &seven),
        ];
        let error = save_attachments_with(&root, "附件", &files, TINY).unwrap_err();
        assert_eq!(error.code, "TOO_LARGE");
        assert!(error.message.contains("丙.png"), "{}", error.message);
        assert!(!dir.path().join("附件").exists(), "超限时不落任何一张");
    }

    #[test]
    fn rejects_batches_over_the_file_count_limit() {
        let (dir, root) = temp_vault();
        let files = [
            input("甲.png", b"a"),
            input("乙.png", b"b"),
            input("丙.png", b"c"),
            input("丁.png", b"d"),
        ];
        let error = save_attachments_with(&root, "附件", &files, TINY).unwrap_err();
        assert_eq!(error.code, "TOO_LARGE");
        assert!(error.message.contains('4'), "{}", error.message);
        assert!(!dir.path().join("附件").exists());
    }

    #[test]
    fn rejects_a_directory_that_is_actually_a_file() {
        let (dir, root) = temp_vault();
        std::fs::write(dir.path().join("附件"), "我是文件").unwrap();

        let error = save_attachments(&root, "附件", &[input("图.png", b"x")]).unwrap_err();
        assert_eq!(error.code, "NOT_A_DIRECTORY");
    }

    #[test]
    fn leaves_no_temporary_files_behind() {
        let (dir, root) = temp_vault();
        save_attachments(&root, "附件", &[input("图.png", b"ok")]).unwrap();

        let leftovers: Vec<_> = std::fs::read_dir(dir.path().join("附件"))
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(mn_core::atomic::TEMP_PREFIX)
            })
            .collect();
        assert!(leftovers.is_empty(), "不应残留临时文件：{leftovers:?}");
    }

    /// 附件目录是指向 Vault 之外的符号链接时必须被拒（与 ADR-0007 的读取面同一姿态）。
    #[test]
    fn rejects_a_symlinked_attachment_directory_escaping_the_vault() {
        let (dir, root) = temp_vault();
        let outside = tempfile::tempdir().unwrap();

        let link = dir.path().join("附件");
        #[cfg(windows)]
        let created = std::os::windows::fs::symlink_dir(outside.path(), &link).is_ok();
        #[cfg(unix)]
        let created = std::os::unix::fs::symlink(outside.path(), &link).is_ok();

        if !created {
            // 环境不允许创建符号链接（需要开发者模式）：跳过，但**不**把跳过当通过
            eprintln!("跳过：当前环境不允许创建符号链接");
            return;
        }

        let error = save_attachments(&root, "附件", &[input("图.png", b"x")]).unwrap_err();
        assert_eq!(error.code, "PATH_ESCAPE");
        assert!(
            !outside.path().join("图.png").exists(),
            "绝不能写到 Vault 之外"
        );
    }

    #[test]
    fn attachment_saved_serializes_to_the_frontend_contract() {
        let saved = AttachmentSaved {
            rel_path: "附件/图.png".into(),
            size_bytes: 3,
        };
        let json = serde_json::to_string(&saved).unwrap();
        assert!(json.contains("\"relPath\":\"附件/图.png\""), "实际：{json}");
        assert!(json.contains("\"sizeBytes\":3"), "实际：{json}");
        assert!(!json.contains("rel_path"), "不该出现 snake_case：{json}");
        assert!(!json.contains("size_bytes"), "不该出现 snake_case：{json}");
    }

    #[test]
    fn attachment_input_deserializes_from_the_frontend_contract() {
        // 入参也是契约的一半：前端发的是 `{ name, dataBase64 }`（camelCase）
        let parsed: AttachmentInput = serde_json::from_str(
            r#"{"name":"粘贴图片 2025-01-01 123456.png","dataBase64":"Zm9v"}"#,
        )
        .unwrap();
        assert_eq!(parsed.name, "粘贴图片 2025-01-01 123456.png");
        assert_eq!(parsed.data_base64, "Zm9v");
    }

    #[test]
    fn limits_match_the_documented_policy() {
        // 策略（写在模块文档里）：单张 ≤ 8 MiB、一批 ≤ 32 MiB、一次 ≤ 32 张。
        // 这三个数字是行为契约（超限报 TOO_LARGE、不静默丢弃），改它们等于改"能粘什么图"。
        assert_eq!(LIMITS.max_bytes, 8 * 1024 * 1024);
        assert_eq!(LIMITS.max_batch_bytes, 32 * 1024 * 1024);
        assert_eq!(LIMITS.max_files, 32);
        // 单张上限必须小于批次上限，否则"一批"永远只能装下一张（编译期不变式）
        const { assert!(LIMITS.max_bytes <= LIMITS.max_batch_bytes) };
    }

    #[test]
    fn estimates_an_upper_bound_of_the_decoded_size() {
        // 上界换算：4 字符 ≤ 3 字节。上界必须**不小于**真实长度，否则会放过超限载荷。
        assert_eq!(estimated_bytes(0), 0);
        assert_eq!(estimated_bytes(4), 3);
        assert_eq!(estimated_bytes(8), 6);
        assert_eq!(estimated_bytes(6), 3, "带填充的尾部按上界算，方向保守");
        let encoded = crate::assets::base64_encode(&[0u8; 100]);
        assert!(estimated_bytes(encoded.len()) >= 100);
    }

    #[test]
    fn allowed_extensions_hint_lists_the_shared_whitelist() {
        let hint = allowed_extensions_hint();
        for ext in ALLOWED_IMAGE_EXTENSIONS {
            assert!(hint.contains(&format!(".{ext}")), "缺少 {ext}：{hint}");
        }
    }
}
