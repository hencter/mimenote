//! 笔记领域：读写 / 新建 / 重命名 / 移动 / 目录搬迁 / 删除 / 磁盘统计。
//!
//! 宿主只做会话状态、参数映射与错误映射：正文解析、链接改写、原子写都在
//! `mn-core` / `mn-index`（每条命令的注释里写了对应入口）。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use tauri::State;

use mn_core::atomic::{read_text, write_atomic};
use mn_core::path_guard::sanitize_file_stem;
use mn_core::scanner::EntryMeta;
use mn_core::trash::{move_to_trash, TrashRecord};
use mn_core::{Error, VaultRoot};
use mn_index::rename::{LinkUpdate, RenameReport};

use crate::error::IpcError;
use crate::indexer;
use crate::state::AppState;

use super::{ext_of, file_name_of, run_blocking, MAX_READ_BYTES};

/// 笔记内容。`text` 是**原始文本**（BOM/换行风格由前端领域层解释）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteContent {
    pub rel_path: String,
    pub text: String,
    pub size_bytes: u64,
    /// 版本令牌：保存时必须回传（见 ADR-0004）。
    pub mtime_ms: u64,
}

/// 写入结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteOutcome {
    pub rel_path: String,
    /// 写入后的新版本令牌。
    pub mtime_ms: u64,
    pub size_bytes: u64,
    /// 实际写入耗时（毫秒，含 fsync），状态栏展示用。
    pub written_in_ms: u64,
}

/// 重命名时被改写了链接的某个文件。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameLinkUpdate {
    pub rel_path: String,
    /// 该文件里被改写的链接条数。
    pub count: u32,
}

impl From<LinkUpdate> for RenameLinkUpdate {
    fn from(update: LinkUpdate) -> Self {
        Self {
            rel_path: update.rel_path,
            count: update.count,
        }
    }
}

/// 重命名结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameOutcome {
    pub old_rel_path: String,
    pub new_rel_path: String,
    /// 改名后的新版本令牌（口径与 `NoteContent.mtimeMs` 一致）。
    ///
    /// 类型刻意跟随现有 DTO 用 `u64`（JSON 里同样是数字，前端镜像为 `number` 即可）。
    pub new_mtime_ms: u64,
    /// 被改写了链接的文件，按 `relPath` 字典序。
    ///
    /// 被改名的笔记**自身**若含自链接，它的条目用**旧路径**报告 —— 前端要在"改名前的
    /// 坐标系"里判断"我正在编辑的这一篇也被改写了"（见 `app/actions.ts`）。
    pub updated_links: Vec<RenameLinkUpdate>,
    /// 被改写链接的总数（`updated_links` 的 count 之和）。
    pub updated_link_count: u32,
    /// 整条命令的实测耗时（毫秒）。
    pub elapsed_ms: u64,
}

/// 磁盘上某个文档的真实统计（与编辑器内的即时统计互为校验）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentStats {
    pub rel_path: String,
    pub size_bytes: u64,
    pub mtime_ms: u64,
    pub stats: mn_core::TextStats,
}

// ---------------------------------------------------------------------------
// 笔记读写
// ---------------------------------------------------------------------------

/// 读取笔记原文。
#[tauri::command]
pub async fn note_read(
    state: State<'_, Arc<AppState>>,
    rel_path: String,
) -> Result<NoteContent, IpcError> {
    let root = state.vault_root()?;
    let rel = rel_path.clone();
    let (text, size_bytes, mtime_ms) = run_blocking(move || {
        let path = root.resolve_existing(&rel)?;
        let meta = std::fs::metadata(&path).map_err(|e| Error::io(&path, e))?;
        if meta.is_dir() {
            return Err(Error::IsDirectory(rel));
        }
        let text = read_text(&path, MAX_READ_BYTES)?;
        Ok((
            text,
            meta.len(),
            mn_core::atomic::mtime_ms(&meta).unwrap_or(0),
        ))
    })
    .await?;

    Ok(NoteContent {
        rel_path,
        text,
        size_bytes,
        mtime_ms,
    })
}

/// 一次批量读取的结果（契约 `NotesBatch`）。
///
/// 为什么要有"批量"而不是让前端循环调 [`note_read`]：整库导出要把**每一篇笔记**的正文拿到
/// 前端去渲染（几千次 IPC 往返是不可接受的开销，而且每次往返都要重新取一次 Vault 锁）。
/// 出参是 `NoteContent`（与 [`note_read`] 同一个类型），前端不需要第二套正文模型。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesBatch {
    /// 读成功的笔记（按请求顺序）。
    pub items: Vec<NoteContent>,
    /// 读失败的笔记 + 原因（按请求顺序）。**单篇失败不整批失败**：
    /// 导出 4267 篇时不能因为一篇被删/非 UTF-8 就让另外 4266 篇白跑。
    pub skipped: Vec<crate::site_export::SiteSkip>,
}

/// 单批最多读几篇。
///
/// 上限的意义与其它批量命令一致：让**一次 IPC 的报文体积**有硬边界。一篇笔记渲染前是纯文本，
/// 64 篇在正常笔记上不到 1 MB，而 4267 篇一次性发过来是几十 MB —— 那已经是一次内存事故。
/// 超限返回 `PATH_INVALID`（与"路径不合法"同码：请求本身的形状不对，而不是某一篇读不到）。
const MAX_BATCH_NOTES: usize = 64;

/// 批量读取笔记原文（整库导出用；口径与 [`note_read`] 逐字相同）。
///
/// 逐篇独立失败：每篇各自的处境（已被删、非 UTF-8、超过读取上限、权限不足）都不该影响别人。
/// 入参超过 [`MAX_BATCH_NOTES`] 条 → `PATH_INVALID`；空数组返回空结果（**不报错**）。
#[tauri::command]
pub async fn notes_read_batch(
    state: State<'_, Arc<AppState>>,
    rel_paths: Vec<String>,
) -> Result<NotesBatch, IpcError> {
    check_batch_size(rel_paths.len())?;
    if rel_paths.is_empty() {
        return Ok(NotesBatch {
            items: Vec::new(),
            skipped: Vec::new(),
        });
    }

    let root = state.vault_root()?;
    run_blocking(move || Ok(read_notes_batch(&root, &rel_paths))).await
}

/// 批量读取的数量上限校验（与 Tauri 无关，可单测）。
fn check_batch_size(count: usize) -> Result<(), IpcError> {
    if count > MAX_BATCH_NOTES {
        return Err(Error::invalid(
            format!("{count} 篇"),
            format!("一次最多批量读取 {MAX_BATCH_NOTES} 篇笔记"),
        )
        .into());
    }
    Ok(())
}

/// [`notes_read_batch`] 的主体（与 Tauri 无关，可单测）。
fn read_notes_batch(root: &VaultRoot, rel_paths: &[String]) -> NotesBatch {
    let mut items = Vec::with_capacity(rel_paths.len());
    let mut skipped = Vec::new();

    for rel in rel_paths {
        match read_note_for_export(root, rel) {
            Ok(content) => items.push(content),
            Err(error) => skipped.push(crate::site_export::SiteSkip::new(
                rel,
                crate::site_export::SiteSkipReason::from_read_error(&error),
                error.to_string(),
            )),
        }
    }

    NotesBatch { items, skipped }
}

/// 读一篇笔记的原文 + 条目表要的形状。
///
/// 与 [`note_read`] 是**同一套口径**（同一个 `resolve_existing`、同一个 `MAX_READ_BYTES`、
/// 同一个"是目录就拒绝"、同一个 mtime 令牌）。没有把 `note_read` 改造成调用它，是为了
/// 不给那条既有路径引入任何行为变化（`note_read` 是编辑器每次打开笔记都要走的路径）。
fn read_note_for_export(root: &VaultRoot, rel: &str) -> mn_core::Result<NoteContent> {
    let path = root.resolve_existing(rel)?;
    let meta = std::fs::metadata(&path).map_err(|e| Error::io(&path, e))?;
    if meta.is_dir() {
        return Err(Error::IsDirectory(rel.to_string()));
    }
    let text = read_text(&path, MAX_READ_BYTES)?;
    Ok(NoteContent {
        rel_path: rel.to_string(),
        text,
        size_bytes: meta.len(),
        mtime_ms: mn_core::atomic::mtime_ms(&meta).unwrap_or(0),
    })
}

/// 保存笔记：mtime 令牌校验 → 原子写 → 增量更新缓存。
///
/// `force = true` 表示用户在冲突横幅里明确选择了「覆盖保存」。
#[tauri::command]
pub async fn note_write(
    state: State<'_, Arc<AppState>>,
    rel_path: String,
    text: String,
    base_mtime_ms: Option<u64>,
    force: bool,
) -> Result<WriteOutcome, IpcError> {
    let root = state.vault_root()?;
    let app = Arc::clone(state.inner());
    let rel = rel_path.clone();

    let (size_bytes, mtime_ms, written_in_ms) = run_blocking(move || {
        // 写锁：把「读取当前 mtime → 比对 → 原子写」变成临界区，
        // 避免两次并发保存互相覆盖（见 ADR-0004）。
        let _write_guard = app.write_guard();

        let path = root.resolve_for_write(&rel)?;
        if path.is_dir() {
            return Err(Error::IsDirectory(rel));
        }
        if let Some(base) = base_mtime_ms {
            let current = mn_core::atomic::path_mtime_ms(&path)?;
            if !force {
                if let Some(cur) = current {
                    if cur != base {
                        return Err(Error::Conflict {
                            current_mtime_ms: cur,
                        });
                    }
                }
            }
        }

        let started = Instant::now();
        write_atomic(&path, text.as_bytes())?;
        let written = started.elapsed().as_millis() as u64;

        // 链接索引增量更新：与写在同一个后台任务里完成，避免为索引再复制一份正文
        indexer::update_note(&app, &rel, &text);

        let meta = std::fs::metadata(&path).map_err(|e| Error::io(&path, e))?;
        Ok((
            meta.len(),
            mn_core::atomic::mtime_ms(&meta).unwrap_or(0),
            written,
        ))
    })
    .await?;

    state.update_vault(|ctx| {
        ctx.upsert(EntryMeta {
            rel_path: rel_path.clone(),
            name: file_name_of(&rel_path),
            is_dir: false,
            size_bytes,
            mtime_ms: Some(mtime_ms),
            ext: ext_of(&rel_path),
        })
    });
    // 链接索引在写入后台任务里已增量更新（见上面的 indexer::update_note）

    log::debug!("保存 {rel_path}（{size_bytes} 字节，写入 {written_in_ms}ms）");
    Ok(WriteOutcome {
        rel_path,
        mtime_ms,
        size_bytes,
        written_in_ms,
    })
}

/// 新建笔记：唯一命名，写入初始标题。
#[tauri::command]
pub async fn note_create(
    state: State<'_, Arc<AppState>>,
    parent_rel: String,
    title: String,
) -> Result<NoteContent, IpcError> {
    let root = state.vault_root()?;
    let (entry, note) = run_blocking(move || create_note(&root, &parent_rel, &title)).await?;
    state.update_vault(|ctx| ctx.upsert(entry));
    indexer::update_note(&state, &note.rel_path, &note.text);
    log::info!("新建笔记：{}", note.rel_path);
    Ok(note)
}

/// 重命名笔记：同目录改名 + 全库指向它的链接精确改写。
///
/// `update_links` 缺省 `true`（`false` = 只改名、不碰任何其他文件）。
///
/// 宿主在这里只做三件事：拿状态、把结果搬成 DTO、增量更新条目缓存 ——
/// 改名与改写规则全在 `mn_index::rename`（见 `docs/architecture.md` §2 第 3 条）。
#[tauri::command]
pub async fn note_rename(
    state: State<'_, Arc<AppState>>,
    rel_path: String,
    new_title: String,
    update_links: Option<bool>,
) -> Result<RenameOutcome, IpcError> {
    let started = Instant::now();
    let app = Arc::clone(state.inner());
    let rel = rel_path;
    let update = update_links.unwrap_or(true);

    let report = run_blocking(move || rename_note_in(&app, &rel, &new_title, update)).await?;

    // 条目缓存增量更新：换掉旧路径（笔记数不变），不重扫目录
    apply_renamed_entry(&state, &report);

    let outcome = rename_outcome_from(report, started.elapsed().as_millis() as u64);
    log::info!(
        "重命名：{} → {}（改写 {} 个文件 / {} 条链接，耗时 {}ms）",
        outcome.old_rel_path,
        outcome.new_rel_path,
        outcome.updated_links.len(),
        outcome.updated_link_count,
        outcome.elapsed_ms
    );
    Ok(outcome)
}

/// 跨目录移动笔记（拖拽整理 / 命令面板的「移动到…」）。
///
/// 出参**复用 [`RenameOutcome`]**：宿主不为"换个位置"发明第二套契约形状，前端于是能复用
/// 同一套状态收尾（条目表换路径、正在编辑的文档换路径、标签页对账、链接面板刷新）。
///
/// 入参口径：
///
/// * `rel_path` —— 要移动的笔记（相对 Vault 根的 POSIX 路径）；
/// * `target_parent_rel` —— **目标父目录**（空串 = Vault 根；反斜杠与首尾 `/` 都容忍）。
///   目录还不存在时会创建 —— "移动到新目录"是键盘路径下的正常需求；
/// * `new_title` —— `None` 时沿用原文件名（拖拽就是这种情况：只换目录）；
///   给了就顺带改名（扩展名沿用原文件）；
/// * `update_links` —— 缺省 `true`：改写全库指向它的链接。跨目录时链接一律写成
///   **相对新位置的路径**（见 `mn_index::rename` 的模块文档：裸名链接会被"同目录优先"
///   的消歧规则重新解释，换目录后可能指向另一篇同名笔记）。
///
/// 错误码：
///
/// * 目标目录已有同名文件 → `ALREADY_EXISTS`（**绝不覆盖**，也不改一个字节）；
/// * 移到自己所在目录（新旧路径相同）→ 成功返回、无任何副作用；
/// * 源不存在 → `NOT_FOUND`；源是目录 → `IS_DIRECTORY`（目录移动仍推迟）；
/// * 越界/非法目录名 → `PATH_INVALID` / `PATH_ESCAPE`。
///
/// 与 `note_rename` 共用同一把写锁与同一份索引：移动与链接改写必须在"没有并发写"的
/// 临界区里完成（ADR-0004），否则移动瞬间可能撞上一次自动保存。
#[tauri::command]
pub async fn note_move(
    state: State<'_, Arc<AppState>>,
    rel_path: String,
    target_parent_rel: String,
    new_title: Option<String>,
    update_links: Option<bool>,
) -> Result<RenameOutcome, IpcError> {
    let started = Instant::now();
    let app = Arc::clone(state.inner());
    let rel = rel_path;
    let target = target_parent_rel;
    let update = update_links.unwrap_or(true);

    let report =
        run_blocking(move || move_note_in(&app, &rel, &target, new_title.as_deref(), update))
            .await?;

    // 条目缓存增量更新：换掉旧路径（笔记数不变），并把**这次新建的目录**补进条目表
    apply_renamed_entry(&state, &report);
    register_moved_dirs(&state, &report.new_rel_path);

    let outcome = rename_outcome_from(report, started.elapsed().as_millis() as u64);
    log::info!(
        "移动：{} → {}（改写 {} 个文件 / {} 条链接，耗时 {}ms）",
        outcome.old_rel_path,
        outcome.new_rel_path,
        outcome.updated_links.len(),
        outcome.updated_link_count,
        outcome.elapsed_ms
    );
    Ok(outcome)
}

/// 重命名**目录**（连同整棵子树）：磁盘上换名字 + 全库指向子树里每一篇的链接精确改写。
///
/// 出参**复用 [`RenameOutcome`]**（与 `note_rename` / `note_move` 同一形状）：一次目录搬迁要
/// 交代的仍然是"旧路径 / 新路径 / 被改写的文件与条数"，前端因此能复用同一套状态收尾
/// （条目表换整棵子树、正在编辑的文档换路径、标签页对账、链接面板刷新）。
/// 唯一的字段语义差别是 `newMtimeMs` —— 目录不是版本令牌的载体（ADR-0004 的令牌是**文件**
/// mtime），这里如实返回 `0`，前端对目录作用域的搬迁不会拿它当令牌用。
///
/// 入参口径与 [`note_rename`] 一致（`new_title` 不带扩展名；前端偶尔连路径一起传时取末段）。
///
/// 错误码：
///
/// * 目标位置已有同名目录 → `ALREADY_EXISTS`（**绝不覆盖、也绝不合并**两棵子树）；
/// * 源不存在 → `NOT_FOUND`；源是文件 → `NOT_A_DIRECTORY`；
/// * 越界/非法名字 → `PATH_INVALID` / `PATH_ESCAPE`；`.mimenote` 内部目录一律拒绝。
#[tauri::command]
pub async fn dir_rename(
    state: State<'_, Arc<AppState>>,
    rel_path: String,
    new_title: String,
    update_links: Option<bool>,
) -> Result<RenameOutcome, IpcError> {
    let started = Instant::now();
    let app = Arc::clone(state.inner());
    let rel = rel_path;
    let update = update_links.unwrap_or(true);

    let report = run_blocking(move || rename_dir_in(&app, &rel, &new_title, update)).await?;

    apply_renamed_dir(&state, &report);
    let outcome = rename_outcome_from(report, started.elapsed().as_millis() as u64);
    log::info!(
        "目录改名：{} → {}（改写 {} 个文件 / {} 条链接，耗时 {}ms）",
        outcome.old_rel_path,
        outcome.new_rel_path,
        outcome.updated_links.len(),
        outcome.updated_link_count,
        outcome.elapsed_ms
    );
    Ok(outcome)
}

/// 移动**目录**（连同整棵子树）：整棵子树的路径跟着变 + 全库链接精确改写。
///
/// 入参口径与 [`note_move`] 一致：`target_parent_rel` 是**目标父目录**（空串 = Vault 根；
/// 不存在时创建），`new_title` 为 `None` 时沿用目录名（拖拽就是这种情况）。
///
/// 与拖拽的关系：文件夹拖到文件夹上 = 移进那个文件夹；拖到树的空白区域 = 移到 Vault 根。
/// 前端还会拦"拖进自己的后代"并给出原因，宿主这里同样兜底拒绝（`PATH_INVALID`）——
/// 文件系统层面那种操作只会给一句"系统找不到指定的路径"，用户无法据以行动。
#[tauri::command]
pub async fn dir_move(
    state: State<'_, Arc<AppState>>,
    rel_path: String,
    target_parent_rel: String,
    new_title: Option<String>,
    update_links: Option<bool>,
) -> Result<RenameOutcome, IpcError> {
    let started = Instant::now();
    let app = Arc::clone(state.inner());
    let rel = rel_path;
    let target = target_parent_rel;
    let update = update_links.unwrap_or(true);

    let report =
        run_blocking(move || move_dir_in(&app, &rel, &target, new_title.as_deref(), update))
            .await?;

    apply_renamed_dir(&state, &report);
    register_moved_dirs(&state, &report.new_rel_path);
    let outcome = rename_outcome_from(report, started.elapsed().as_millis() as u64);
    log::info!(
        "目录移动：{} → {}（改写 {} 个文件 / {} 条链接，耗时 {}ms）",
        outcome.old_rel_path,
        outcome.new_rel_path,
        outcome.updated_links.len(),
        outcome.updated_link_count,
        outcome.elapsed_ms
    );
    Ok(outcome)
}

/// 删除笔记/目录（移入回收站）。必须 `confirm = true`。
#[tauri::command]
pub async fn note_delete(
    state: State<'_, Arc<AppState>>,
    rel_path: String,
    confirm: bool,
) -> Result<TrashRecord, IpcError> {
    if !confirm {
        return Err(Error::ConfirmationRequired.into());
    }
    let root = state.vault_root()?;
    let rel = rel_path.clone();
    let record = run_blocking(move || move_to_trash(&root, &rel)).await?;
    state.update_vault(|ctx| ctx.remove(&record.original_rel_path));
    indexer::remove_note(&state, &record.original_rel_path);
    log::info!(
        "删除到回收站：{} -> {}",
        record.original_rel_path,
        record.stored_rel_path
    );
    Ok(record)
}

/// 读取磁盘上某个文档的真实统计（字数/行数/阅读时长）。
///
/// 编辑器内的即时统计走前端本地计算（每次按键都要刷新，不能付 IPC 往返成本）；
/// 本命令提供**磁盘真实值**，两者互为校验，也让 `mn-core::text_stats`
/// 成为后续索引层的唯一权威实现。
#[tauri::command]
pub async fn note_stats(
    state: State<'_, Arc<AppState>>,
    rel_path: String,
) -> Result<DocumentStats, IpcError> {
    let root = state.vault_root()?;
    let rel = rel_path.clone();
    run_blocking(move || {
        let path = root.resolve_existing(&rel)?;
        let meta = std::fs::metadata(&path).map_err(|e| Error::io(&path, e))?;
        if meta.is_dir() {
            return Err(Error::IsDirectory(rel));
        }
        let text = read_text(&path, MAX_READ_BYTES)?;
        Ok(DocumentStats {
            rel_path: rel,
            size_bytes: meta.len(),
            mtime_ms: mn_core::atomic::mtime_ms(&meta).unwrap_or(0),
            stats: mn_core::text_stats::stats(&text),
        })
    })
    .await
}

// ---------------------------------------------------------------------------
// 内部实现（与 Tauri 无关，可单测）
// ---------------------------------------------------------------------------

fn create_note(
    root: &VaultRoot,
    parent_rel: &str,
    title: &str,
) -> mn_core::Result<(EntryMeta, NoteContent)> {
    let parent = parent_rel.trim().replace('\\', "/");
    let parent = parent.trim_matches('/').to_string();

    if !parent.is_empty() {
        let dir = root.resolve_existing(&parent)?;
        if !dir.is_dir() {
            return Err(Error::NotADirectory(parent));
        }
    }

    let stem = sanitize_file_stem(title);
    let (rel, path) = unique_note_path(root, &parent, &stem)?;

    // 有标题就写入一行 H1 作为初始内容；标题为空（或全是空白）时留空文件
    let trimmed = title.trim();
    let body = if trimmed.is_empty() {
        String::new()
    } else {
        format!("# {trimmed}\n")
    };

    write_atomic(&path, body.as_bytes())?;
    let meta = std::fs::metadata(&path).map_err(|e| Error::io(&path, e))?;
    let mtime_ms = mn_core::atomic::mtime_ms(&meta).unwrap_or(0);

    let entry = EntryMeta {
        rel_path: rel.clone(),
        name: file_name_of(&rel),
        is_dir: false,
        size_bytes: meta.len(),
        mtime_ms: Some(mtime_ms),
        ext: Some("md".to_string()),
    };
    let note = NoteContent {
        rel_path: rel,
        text: body.clone(),
        size_bytes: meta.len(),
        mtime_ms,
    };
    Ok((entry, note))
}

/// 在 `parent` 下为 `stem` 找一个不冲突的 `.md` 路径。
fn unique_note_path(
    root: &VaultRoot,
    parent: &str,
    stem: &str,
) -> mn_core::Result<(String, PathBuf)> {
    for attempt in 0..1000usize {
        let file_name = if attempt == 0 {
            format!("{stem}.md")
        } else {
            format!("{stem} {attempt}.md")
        };
        let rel = if parent.is_empty() {
            file_name.clone()
        } else {
            format!("{parent}/{file_name}")
        };
        let path = root.resolve_for_write(&rel)?;
        if !path.exists() {
            return Ok((rel, path));
        }
    }
    Err(Error::AlreadyExists(format!(
        "{stem}.md 的重名尝试超过 1000 次"
    )))
}

/// 重命名命令的主体（与 Tauri 无关，可单测）。
///
/// 与保存共用同一把写锁：改名与链接改写必须在"没有并发写"的临界区里完成（ADR-0004），
/// 否则改名瞬间可能撞上一次自动保存，把刚改好的链接又写回旧名字。
pub(crate) fn rename_note_in(
    state: &AppState,
    rel_path: &str,
    new_title: &str,
    update_links: bool,
) -> mn_core::Result<RenameReport> {
    let root = state.vault_root()?;
    let _write_guard = state.write_guard();
    let mut index = state.index_write();
    // 链接索引由 mn-index 在同一临界区里增量同步（旧路径移除、新路径 upsert）
    // 全文搜索索引同理：路径搬过去、被改写文件的新文本重新入库；未就绪时只走链接索引
    match state.try_search(|search| {
        mn_index::rename::rename_note(
            &root,
            &mut index,
            rel_path,
            new_title,
            update_links,
            Some(search),
        )
    }) {
        Some(result) => result,
        None => mn_index::rename::rename_note(
            &root,
            &mut index,
            rel_path,
            new_title,
            update_links,
            None,
        ),
    }
}

/// 目录改名命令的主体（与 Tauri 无关，可单测）。
///
/// 与 `rename_note_in` 共用同一把写锁、同一份索引、同一套全文搜索降级：目录搬迁在这三层上
/// 与单篇搬迁没有任何区别，只是候选集从"一篇"变成"整棵子树"。
fn rename_dir_in(
    state: &AppState,
    rel_path: &str,
    new_title: &str,
    update_links: bool,
) -> mn_core::Result<RenameReport> {
    let root = state.vault_root()?;
    let _write_guard = state.write_guard();
    let mut index = state.index_write();
    match state.try_search(|search| {
        mn_index::dir_move::rename_dir(
            &root,
            &mut index,
            rel_path,
            new_title,
            update_links,
            Some(search),
        )
    }) {
        Some(result) => result,
        None => mn_index::dir_move::rename_dir(
            &root,
            &mut index,
            rel_path,
            new_title,
            update_links,
            None,
        ),
    }
}

/// 目录移动命令的主体（与 Tauri 无关，可单测）。
fn move_dir_in(
    state: &AppState,
    rel_path: &str,
    target_parent_rel: &str,
    new_title: Option<&str>,
    update_links: bool,
) -> mn_core::Result<RenameReport> {
    let root = state.vault_root()?;
    let _write_guard = state.write_guard();
    let mut index = state.index_write();
    match state.try_search(|search| {
        mn_index::dir_move::move_dir_tree(
            &root,
            &mut index,
            rel_path,
            target_parent_rel,
            new_title,
            update_links,
            Some(search),
        )
    }) {
        Some(result) => result,
        None => mn_index::dir_move::move_dir_tree(
            &root,
            &mut index,
            rel_path,
            target_parent_rel,
            new_title,
            update_links,
            None,
        ),
    }
}

/// 移动命令的主体（与 Tauri 无关，可单测）。
///
/// 与 `rename_note_in` 是同一条链路的两个入口：写锁、索引同步、全文搜索降级都一致 ——
/// "换个位置"和"换个名字"在这三层上没有任何区别（见 `mn_index::rename` 的模块文档）。
fn move_note_in(
    state: &AppState,
    rel_path: &str,
    target_parent_rel: &str,
    new_title: Option<&str>,
    update_links: bool,
) -> mn_core::Result<RenameReport> {
    let root = state.vault_root()?;
    let _write_guard = state.write_guard();
    let mut index = state.index_write();
    match state.try_search(|search| {
        mn_index::rename::move_note(
            &root,
            &mut index,
            rel_path,
            target_parent_rel,
            new_title,
            update_links,
            Some(search),
        )
    }) {
        Some(result) => result,
        None => mn_index::rename::move_note(
            &root,
            &mut index,
            rel_path,
            target_parent_rel,
            new_title,
            update_links,
            None,
        ),
    }
}

/// 改名成功后增量更新条目缓存（纯内存，不重扫目录）。
fn apply_renamed_entry(state: &AppState, report: &RenameReport) {
    let old_rel = report.old_rel_path.clone();
    let new_rel = report.new_rel_path.clone();
    let mtime_ms = report.mtime_ms;
    let size_bytes = report.size_bytes;
    state.update_vault(|ctx| {
        // 先删后加：笔记数净变化为 0，目录计数不受影响
        ctx.remove(&old_rel);
        ctx.upsert(EntryMeta {
            rel_path: new_rel.clone(),
            name: file_name_of(&new_rel),
            is_dir: false,
            size_bytes,
            mtime_ms: Some(mtime_ms),
            ext: ext_of(&new_rel),
        });
    });
}

/// 目录搬迁成功后就地替换**整棵子树**的条目（纯内存，不重扫目录）。
///
/// 为什么必须整棵子树一起换：`VaultCtx::remove` 会连同后代一起摘掉，只补回目录本身会让
/// 子树里每一篇笔记都从条目表里消失 —— 前端文件树会空一片（而磁盘上它们好好的）。
/// 逐条按 `新前缀 + 旧路径的后半段` 重写路径（复用 `mn_index::remap_prefix`，与链接改写
/// 同一份前缀映射），其余字段（size/mtime/ext）原样保留，条目形状与扫描口径因此不会漂移。
fn apply_renamed_dir(state: &AppState, report: &RenameReport) {
    let old_rel = report.old_rel_path.clone();
    let new_rel = report.new_rel_path.clone();
    state.update_vault(|ctx| {
        // `remove` 会连后代一起摘掉，所以先把整棵子树的条目**取出来**（含目录自身），再换路径入表
        let doomed: Vec<EntryMeta> = ctx
            .paths_under(&old_rel)
            .into_iter()
            .filter_map(|rel| ctx.entries.get(&rel).cloned())
            .collect();
        ctx.remove(&old_rel);
        for entry in doomed {
            let Some(rel_path) = mn_index::remap_prefix(&entry.rel_path, &old_rel, &new_rel) else {
                continue;
            };
            ctx.upsert(EntryMeta {
                name: file_name_of(&rel_path),
                rel_path,
                ..entry
            });
        }
    });
}

/// 把 `new_rel` 的父目录（含缺失的祖先）补进条目缓存。
///
/// 为什么必须做：移动到**新建目录**时磁盘上多了几层目录，而条目缓存是"打开 Vault 时扫一次"
/// 的快照。缺了父目录条目，前端 `domain/tree` 会把这篇笔记当成"父目录缺失"而**提升成根节点**
/// —— 文件树里的表现是"笔记跑到了最外层，新建的目录看不见"，比报错更难查。
/// 自顶向下入表，父目录一定先于子目录存在（`VaultCtx::upsert` 只加不排序，顺序由前端树重建决定）。
///
/// `pub(crate)`：附件写入（`attachments.rs`）也要把新建的附件目录补进同一条缓存 ——
/// 目录条目的形状只允许有一处定义，不能再写第二遍。
pub(crate) fn register_moved_dirs(state: &AppState, new_rel: &str) {
    let Some(index) = new_rel.rfind('/') else {
        return;
    };
    let dir = &new_rel[..index];
    if dir.is_empty() {
        return;
    }
    state.update_vault(|ctx| {
        let mut accumulated = String::new();
        for segment in dir.split('/') {
            if accumulated.is_empty() {
                accumulated.push_str(segment);
            } else {
                accumulated.push('/');
                accumulated.push_str(segment);
            }
            if ctx.entries.contains_key(&accumulated) {
                continue;
            }
            ctx.upsert(EntryMeta {
                rel_path: accumulated.clone(),
                name: segment.to_string(),
                is_dir: true,
                size_bytes: 0,
                // 目录的 mtime 在扫描口径里本来就是 `None`（见 mn-core::scanner）
                mtime_ms: None,
                ext: None,
            });
        }
    });
}

/// `mn-index` 的结果 → IPC DTO（宿主唯一的"搬运"职责）。
fn rename_outcome_from(report: RenameReport, elapsed_ms: u64) -> RenameOutcome {
    RenameOutcome {
        old_rel_path: report.old_rel_path,
        new_rel_path: report.new_rel_path,
        new_mtime_ms: report.mtime_ms,
        updated_links: report
            .updated_links
            .into_iter()
            .map(RenameLinkUpdate::from)
            .collect(),
        updated_link_count: report.updated_link_count,
        elapsed_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::search::search_query_in;
    use crate::commands::testkit::*;

    #[test]
    fn creates_note_with_title_and_unique_names() {
        let (_dir, root) = setup();
        let (entry, note) = create_note(&root, "", "我的第一篇").unwrap();
        assert_eq!(entry.rel_path, "我的第一篇.md");
        assert_eq!(note.text, "# 我的第一篇\n");
        assert_eq!(entry.ext.as_deref(), Some("md"));
        assert!(entry.mtime_ms.is_some());

        let (entry2, _) = create_note(&root, "", "我的第一篇").unwrap();
        // 重名从「 1」开始（与 mock 适配器、Obsidian 的习惯一致）
        assert_eq!(entry2.rel_path, "我的第一篇 1.md", "重名必须自动避让");
        let (entry3, _) = create_note(&root, "", "我的第一篇").unwrap();
        assert_eq!(entry3.rel_path, "我的第一篇 2.md");
    }

    #[test]
    fn creates_note_inside_existing_folder_and_sanitizes_title() {
        let (dir, root) = setup();
        let (entry, _) = create_note(&root, "notes", "关于/安全: 测试").unwrap();
        assert!(entry.rel_path.starts_with("notes/"));
        assert!(
            !entry.rel_path.contains(':'),
            "文件名不得含 Windows 禁用字符"
        );
        assert!(dir.path().join("notes").join(entry.name.clone()).exists());
    }

    #[test]
    fn rejects_missing_or_non_directory_parent() {
        let (_dir, root) = setup();
        assert_eq!(
            create_note(&root, "nope", "x").unwrap_err().code(),
            mn_core::ErrorCode::NotFound
        );
        std::fs::write(root.path().join("file.md"), "x").unwrap();
        assert_eq!(
            create_note(&root, "file.md", "x").unwrap_err().code(),
            mn_core::ErrorCode::NotADirectory
        );
    }

    #[test]
    fn empty_title_gets_fallback_name() {
        let (_dir, root) = setup();
        let (entry, note) = create_note(&root, "", "   ").unwrap();
        assert_eq!(entry.rel_path, "未命名.md");
        assert_eq!(note.text, "", "空标题不写占位标题行");
    }

    // -- 重命名（note_rename） ----------------------------------------------

    /// 建一个"已打开 Vault + 已建索引"的应用状态（与 App 启动链路一致）。
    #[test]
    fn rename_rejects_invalid_titles() {
        let (dir, state) = state_with(&[("笔记/甲.md", "[[乙]]\n"), ("笔记/乙.md", "# 乙\n")]);

        for title in [
            "", "   ", " 乙 ", "乙\n", "子/乙", "子\\乙", "..\\乙", "...", "con", "丙:丁",
        ] {
            let error = rename_note_in(&state, "笔记/乙.md", title, true).unwrap_err();
            assert_eq!(
                error.code(),
                mn_core::ErrorCode::PathInvalid,
                "应拒绝标题：{title:?}"
            );
        }

        // 校验失败必须是"什么都没发生"
        assert!(dir.path().join("笔记").join("乙.md").exists());
        assert_eq!(read_file(dir.path(), "笔记/甲.md"), "[[乙]]\n");
    }

    #[test]
    fn rename_reports_missing_directory_and_existing_target() {
        let (dir, state) = state_with(&[("乙.md", "# 乙\n"), ("目标.md", "")]);
        std::fs::create_dir_all(dir.path().join("某个目录")).unwrap();

        assert_eq!(
            rename_note_in(&state, "不存在.md", "新名", true)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::NotFound
        );
        assert_eq!(
            rename_note_in(&state, "某个目录", "新名", true)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::IsDirectory,
            "目录重命名不在本轮范围"
        );
        assert_eq!(
            rename_note_in(&state, "乙.md", "目标", true)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::AlreadyExists
        );
        assert!(dir.path().join("乙.md").exists(), "失败时源文件不能被动过");
    }

    #[test]
    fn rename_without_vault_is_rejected() {
        let state = AppState::default();
        assert_eq!(
            rename_note_in(&state, "乙.md", "丙", true)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::VaultNotSet
        );
    }

    #[test]
    fn rename_rewrites_backlinks_and_updates_caches() {
        let (dir, state) = state_with(&[
            ("笔记/甲.md", "见 [[乙]] 与 [x](乙.md)\n"),
            ("笔记/层级/丙.md", "[[笔记/乙]]\n"),
            ("笔记/乙.md", "# 乙\n"),
        ]);

        let report = rename_note_in(&state, "笔记/乙.md", "戊", true).unwrap();
        assert_eq!(report.old_rel_path, "笔记/乙.md");
        assert_eq!(report.new_rel_path, "笔记/戊.md");
        assert_eq!(report.updated_link_count, 3);
        assert_eq!(report.updated_links.len(), 2);
        assert_eq!(
            read_file(dir.path(), "笔记/甲.md"),
            "见 [[戊]] 与 [x](戊.md)\n"
        );
        assert_eq!(read_file(dir.path(), "笔记/层级/丙.md"), "[[../戊]]\n");
        assert!(report.mtime_ms > 0);

        // 条目缓存 + 索引都在同一条命令里同步好了
        apply_renamed_entry(&state, &report);
        state
            .with_vault(|ctx| {
                assert!(!ctx.entries.contains_key("笔记/乙.md"));
                assert!(ctx.entries.contains_key("笔记/戊.md"));
                assert_eq!(ctx.entries["笔记/戊.md"].name, "戊.md");
                assert_eq!(ctx.entries["笔记/戊.md"].ext.as_deref(), Some("md"));
                assert_eq!(ctx.note_count, 3, "改名不改变笔记数");
                assert!(ctx.order.contains(&"笔记/戊.md".to_string()));
                Ok(())
            })
            .unwrap();

        let mut index = state.index_write();
        assert!(!index.contains("笔记/乙.md"), "旧路径必须从索引里消失");
        assert!(index.contains("笔记/戊.md"));
        // 甲.md 里两条链接 + 丙.md 里一条 = 3 条反链
        assert_eq!(index.backlinks_of("笔记/戊.md").len(), 3);
    }

    #[test]
    fn rename_with_update_links_false_touches_no_other_file() {
        let (dir, state) = state_with(&[("甲.md", "[[乙]]\n"), ("乙.md", "# 乙\n")]);
        let before = std::fs::metadata(dir.path().join("甲.md"))
            .unwrap()
            .modified()
            .unwrap();

        let report = rename_note_in(&state, "乙.md", "丙", false).unwrap();

        assert_eq!(report.new_rel_path, "丙.md");
        assert!(report.updated_links.is_empty());
        assert_eq!(report.updated_link_count, 0);
        assert_eq!(read_file(dir.path(), "甲.md"), "[[乙]]\n");
        assert_eq!(
            std::fs::metadata(dir.path().join("甲.md"))
                .unwrap()
                .modified()
                .unwrap(),
            before,
            "不更新链接时连 mtime 都不该变（说明根本没写）"
        );
        assert!(dir.path().join("丙.md").exists());
        assert!(!dir.path().join("乙.md").exists());
        // 索引也必须切到新路径，而不是留下旧路径的幽灵条目
        assert!(!state.index_write().contains("乙.md"));
        assert!(state.index_write().contains("丙.md"));
    }

    // -- 跨目录移动（note_move） ------------------------------------------------

    #[test]
    fn move_relocates_the_file_and_updates_every_cache() {
        let (dir, state) = state_with(&[
            ("笔记/甲.md", "见 [[乙]] 与 [x](乙.md)\n"),
            ("别的/乙.md", "# 乙\n"),
        ]);

        let report = move_note_in(&state, "别的/乙.md", "归档", None, true).unwrap();
        assert_eq!(report.old_rel_path, "别的/乙.md");
        assert_eq!(report.new_rel_path, "归档/乙.md");
        assert_eq!(report.updated_link_count, 2);
        assert!(dir.path().join("归档").join("乙.md").exists());
        assert!(!dir.path().join("别的").join("乙.md").exists());

        // 链接改写成"相对新位置的路径"（裸名会被同目录优先的消歧规则重新解释）
        assert_eq!(
            read_file(dir.path(), "笔记/甲.md"),
            "见 [[../归档/乙]] 与 [x](../归档/乙.md)\n"
        );

        // 条目缓存：换路径 + 新建目录入表（否则前端树会把笔记提升成根节点）
        apply_renamed_entry(&state, &report);
        register_moved_dirs(&state, &report.new_rel_path);
        state
            .with_vault(|ctx| {
                assert!(!ctx.entries.contains_key("别的/乙.md"));
                assert_eq!(ctx.entries["归档/乙.md"].name, "乙.md");
                assert_eq!(ctx.entries["归档/乙.md"].ext.as_deref(), Some("md"));
                assert!(ctx.entries["归档"].is_dir, "新建的目标目录必须在条目表里");
                assert_eq!(ctx.folder_count, 3, "笔记 + 别的 + 新建的归档");
                assert_eq!(ctx.note_count, 2);
                assert!(ctx.order.contains(&"归档".to_string()));
                Ok(())
            })
            .unwrap();

        // 索引：旧路径消失、新路径可查、反链跟着走
        let mut index = state.index_write();
        assert!(!index.contains("别的/乙.md"));
        assert!(index.contains("归档/乙.md"));
        assert_eq!(index.backlinks_of("归档/乙.md").len(), 2);
    }

    #[test]
    fn move_to_a_brand_new_directory_creates_it_and_registers_the_entry() {
        let (dir, state) = state_with(&[("笔记/甲.md", "# 甲\n")]);
        let report = move_note_in(&state, "笔记/甲.md", "归档/2026", None, true).unwrap();

        apply_renamed_entry(&state, &report);
        register_moved_dirs(&state, &report.new_rel_path);

        assert!(dir.path().join("归档").join("2026").join("甲.md").exists());
        state
            .with_vault(|ctx| {
                assert!(ctx.entries["归档"].is_dir);
                assert!(ctx.entries["归档/2026"].is_dir, "缺失的祖先目录要一起补上");
                assert_eq!(ctx.folder_count, 3, "笔记 + 归档 + 归档/2026");
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn move_never_overwrites_an_existing_file() {
        let (dir, state) = state_with(&[
            ("笔记/甲.md", "[[乙]]\n"),
            ("笔记/乙.md", "# 笔记里的乙\n"),
            ("归档/乙.md", "# 归档里的乙\n"),
        ]);

        let error = move_note_in(&state, "笔记/乙.md", "归档", None, true).unwrap_err();
        assert_eq!(error.code(), mn_core::ErrorCode::AlreadyExists);
        // 跨 IPC 的错误码必须与前端 `ErrorCode` 逐字一致（UI 只按 code 分支）
        assert_eq!(IpcError::from(error).code, "ALREADY_EXISTS");
        assert_eq!(read_file(dir.path(), "归档/乙.md"), "# 归档里的乙\n");
        assert!(dir.path().join("笔记").join("乙.md").exists());
        assert_eq!(read_file(dir.path(), "笔记/甲.md"), "[[乙]]\n");
    }

    #[test]
    fn move_to_the_same_directory_is_a_no_op() {
        let (dir, state) = state_with(&[("笔记/甲.md", "[[乙]]\n"), ("笔记/乙.md", "")]);
        let before = std::fs::metadata(dir.path().join("笔记/乙.md"))
            .unwrap()
            .modified()
            .unwrap();

        let report = move_note_in(&state, "笔记/乙.md", "笔记", None, true).unwrap();

        assert_eq!(report.new_rel_path, "笔记/乙.md");
        assert_eq!(report.updated_link_count, 0);
        assert_eq!(read_file(dir.path(), "笔记/甲.md"), "[[乙]]\n");
        assert_eq!(
            std::fs::metadata(dir.path().join("笔记/乙.md"))
                .unwrap()
                .modified()
                .unwrap(),
            before,
            "无操作时不该写盘"
        );
    }

    #[test]
    fn move_reports_missing_source_directory_target_and_unopened_vault() {
        let (dir, state) = state_with(&[("笔记/甲.md", ""), ("目录/里面的.md", "")]);
        std::fs::write(dir.path().join("占位.md"), "x").unwrap();

        assert_eq!(
            move_note_in(&state, "不存在.md", "归档", None, true)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::NotFound
        );
        assert_eq!(
            move_note_in(&state, "目录", "归档", None, true)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::IsDirectory,
            "目录移动仍推迟"
        );
        assert_eq!(
            move_note_in(&state, "笔记/甲.md", "占位.md", None, true)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::NotADirectory
        );
        assert_eq!(
            move_note_in(&state, "笔记/甲.md", "../外面", None, true)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::PathInvalid
        );

        let closed = AppState::default();
        assert_eq!(
            move_note_in(&closed, "笔记/甲.md", "归档", None, true)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::VaultNotSet
        );
    }

    #[test]
    fn move_with_a_new_title_and_search_index_stays_in_step() {
        let (_dir, state) = state_with(&[
            ("笔记/甲.md", "[[乙|别名]]\n"),
            ("笔记/乙.md", "第一行 关键词\n"),
        ]);

        let report = move_note_in(&state, "笔记/乙.md", "归档", Some("丙"), true).unwrap();
        assert_eq!(report.new_rel_path, "归档/丙.md");

        // 全文搜索：路径搬过去了，被改写的来源笔记也换了新文本
        let hits = search_query_in(&state, "关键词", None).unwrap().hits;
        assert_eq!(hits[0].rel_path, "归档/丙.md");
        assert_eq!(
            search_query_in(&state, "归档/丙", None).unwrap().total,
            1,
            "来源笔记里的链接文本也必须是改写后的"
        );
    }

    #[test]
    fn move_outcome_reuses_the_rename_contract() {
        let (_dir, state) = state_with(&[("笔记/甲.md", "[[乙]]\n"), ("笔记/乙.md", "")]);
        let report = move_note_in(&state, "笔记/乙.md", "归档", None, true).unwrap();
        let outcome = rename_outcome_from(report, 3);

        assert_eq!(outcome.old_rel_path, "笔记/乙.md");
        assert_eq!(outcome.new_rel_path, "归档/乙.md");
        assert_eq!(outcome.updated_links.len(), 1);
        assert_eq!(outcome.updated_links[0].rel_path, "笔记/甲.md");
        assert_eq!(outcome.updated_links[0].count, 1);
        assert_eq!(outcome.elapsed_ms, 3);

        let json = serde_json::to_string(&outcome).unwrap();
        for key in [
            "oldRelPath",
            "newRelPath",
            "newMtimeMs",
            "updatedLinks",
            "updatedLinkCount",
            "elapsedMs",
        ] {
            assert!(
                json.contains(&format!("\"{key}\"")),
                "note_move 复用 RenameOutcome，字段名必须一致：缺少 {key}：{json}"
            );
        }
    }

    // -- 目录重命名 / 目录移动（dir_rename / dir_move） --------------------------

    #[test]
    fn dir_rename_moves_the_whole_subtree_and_updates_the_entry_cache() {
        let (dir, state) = state_with(&[
            ("项目/甲.md", "# 甲\n"),
            ("项目/子/丙.md", "# 丙\n"),
            ("别的/引用.md", "见 [[项目/甲]] 与 [[项目/子/丙]]。\n"),
        ]);

        let report = rename_dir_in(&state, "项目", "工程", true).unwrap();
        assert_eq!(report.old_rel_path, "项目");
        assert_eq!(report.new_rel_path, "工程");
        assert_eq!(report.updated_link_count, 2);

        apply_renamed_dir(&state, &report);

        // 磁盘：整棵子树搬过去了
        assert!(dir.path().join("工程").join("甲.md").exists());
        assert!(dir.path().join("工程").join("子").join("丙.md").exists());
        assert!(!dir.path().join("项目").exists());
        assert_eq!(
            read_file(dir.path(), "别的/引用.md"),
            "见 [[../工程/甲]] 与 [[../工程/子/丙]]。\n"
        );

        // 条目缓存：**整棵子树**换路径，一篇都不能少（少一篇 = 文件树空一片）
        let state_ref = &state;
        state_ref
            .with_vault(|ctx| {
                let paths = ctx.paths_under("工程");
                assert_eq!(
                paths,
                vec![
                    "工程/子".to_string(),
                    "工程/子/丙.md".to_string(),
                    "工程/甲.md".to_string()
                ],
                "`工程` 自身的目录条目由 `register_moved_dirs` 补上（它把 `new_rel` 的祖先链补齐）"
            );
                assert!(ctx.paths_under("项目").is_empty());
                assert_eq!(ctx.note_count, 3, "笔记数不变");
                assert_eq!(ctx.folder_count, 2, "目录数不变（项目 → 工程）");
                Ok(())
            })
            .unwrap();

        // 索引：旧路径消失、新路径可查
        let index = state_ref.index_write();
        assert!(index.contains("工程/甲.md"));
        assert!(!index.contains("项目/甲.md"));
    }

    #[test]
    fn dir_move_into_another_directory_and_into_the_root() {
        let (dir, state) = state_with(&[
            ("项目/甲.md", "# 甲\n"),
            ("归档/说明.md", "见 [[项目/甲]]。\n"),
        ]);

        let report = move_dir_in(&state, "项目", "归档", None, true).unwrap();
        assert_eq!(report.new_rel_path, "归档/项目");
        apply_renamed_dir(&state, &report);
        register_moved_dirs(&state, &report.new_rel_path);
        assert!(dir.path().join("归档").join("项目").join("甲.md").exists());

        // 再移到 Vault 根：链接写法跟着变成"从根起算"
        let report = move_dir_in(&state, "归档/项目", "", None, true).unwrap();
        assert_eq!(report.new_rel_path, "项目");
        apply_renamed_dir(&state, &report);
        assert_eq!(
            read_file(dir.path(), "归档/说明.md"),
            "见 [[../项目/甲]]。\n"
        );
        assert!(state
            .vault_root()
            .unwrap()
            .resolve_existing("项目/甲.md")
            .is_ok());
    }

    #[test]
    fn dir_move_refuses_self_nesting_duplicate_target_and_missing_source() {
        let (dir, state) = state_with(&[
            ("项目/甲.md", "# 甲\n"),
            ("项目/子/丙.md", "# 丙\n"),
            ("归档/项目/甲.md", "# 归档里的甲\n"),
        ]);

        // 拖/输到自己的后代上：必须给一句能读懂的原因（不是系统的"找不到路径"）
        let error = move_dir_in(&state, "项目", "项目/子", None, true).unwrap_err();
        assert_eq!(error.code(), mn_core::ErrorCode::PathInvalid);
        assert!(error.to_string().contains("子目录"), "实际：{error}");

        // 目标同名目录：绝不覆盖、也绝不合并
        let error = move_dir_in(&state, "项目", "归档", None, true).unwrap_err();
        assert_eq!(error.code(), mn_core::ErrorCode::AlreadyExists);
        assert_eq!(read_file(dir.path(), "归档/项目/甲.md"), "# 归档里的甲\n");
        assert!(dir.path().join("项目").join("甲.md").exists());

        // 源不存在 / 源是文件
        assert_eq!(
            move_dir_in(&state, "不存在", "归档", None, true)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::NotFound
        );
        assert_eq!(
            move_dir_in(&state, "项目/甲.md", "归档", None, true)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::NotADirectory
        );

        // 内部工作目录不参与搬迁
        std::fs::create_dir_all(dir.path().join(".mimenote")).unwrap();
        assert_eq!(
            move_dir_in(&state, ".mimenote", "归档", None, true)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::PathInvalid
        );
    }

    #[test]
    fn dir_move_reuses_the_rename_contract() {
        let (_dir, state) =
            state_with(&[("项目/甲.md", "[[子/丙]]\n"), ("项目/子/丙.md", "# 丙\n")]);
        let report = move_dir_in(&state, "项目", "归档", None, true).unwrap();
        let outcome = rename_outcome_from(report, 7);

        assert_eq!(outcome.old_rel_path, "项目");
        assert_eq!(outcome.new_rel_path, "归档/项目");
        assert_eq!(outcome.new_mtime_ms, 0, "目录不是版本令牌的载体，如实报 0");
        assert_eq!(outcome.elapsed_ms, 7);

        let json = serde_json::to_string(&outcome).unwrap();
        for key in [
            "oldRelPath",
            "newRelPath",
            "newMtimeMs",
            "updatedLinks",
            "updatedLinkCount",
            "elapsedMs",
        ] {
            assert!(
                json.contains(&format!("\"{key}\"")),
                "dir_move 复用 RenameOutcome，字段名必须一致：缺少 {key}：{json}"
            );
        }
    }

    #[test]
    fn dir_rename_without_vault_is_rejected() {
        let state = AppState::default();
        assert_eq!(
            rename_dir_in(&state, "项目", "工程", true)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::VaultNotSet
        );
        assert_eq!(
            move_dir_in(&state, "项目", "归档", None, true)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::VaultNotSet
        );
    }

    #[test]
    fn rename_outcome_serializes_to_the_frontend_contract() {
        let (_dir, state) = state_with(&[("笔记/甲.md", "[[乙]]\n"), ("笔记/乙.md", "")]);
        let report = rename_note_in(&state, "笔记/乙.md", "丙", true).unwrap();
        let outcome = rename_outcome_from(report, 7);

        assert_eq!(outcome.old_rel_path, "笔记/乙.md");
        assert_eq!(outcome.new_rel_path, "笔记/丙.md");
        assert_eq!(outcome.updated_link_count, 1);
        assert_eq!(outcome.elapsed_ms, 7);
        assert!(outcome.new_mtime_ms > 0);
        assert_eq!(outcome.updated_links.len(), 1);

        let json = serde_json::to_string(&outcome).unwrap();
        for key in [
            "oldRelPath",
            "newRelPath",
            "newMtimeMs",
            "updatedLinks",
            "updatedLinkCount",
            "elapsedMs",
            "relPath",
            "count",
        ] {
            assert!(
                json.contains(&format!("\"{key}\"")),
                "缺少字段 {key}：{json}"
            );
        }
        assert!(json.contains("\"relPath\":\"笔记/甲.md\""), "实际：{json}");
        assert!(json.contains("\"count\":1"), "实际：{json}");
        assert!(json.contains("\"elapsedMs\":7"), "实际：{json}");
        assert!(
            !json.contains("old_rel_path"),
            "字段名必须是 camelCase：{json}"
        );
    }

    // -- 批量读取（整库导出的入口）----------------------------------------------

    #[test]
    fn notes_read_batch_reports_skips_with_reasons() {
        let (dir, state) = state_with(&[("甲.md", "# 甲\n正文\n"), ("乙.md", "乙\n")]);
        // 非 UTF-8 的那一篇（`read_text` 会拒）
        std::fs::write(dir.path().join("坏.md"), [0xff, 0xfe, 0x00]).unwrap();
        // 目录：路径存在，但不是笔记
        std::fs::create_dir_all(dir.path().join("目录.md")).unwrap();

        let batch = read_notes_batch(
            &state.vault_root().unwrap(),
            &[
                "甲.md".to_string(),
                "不存在.md".to_string(),
                "坏.md".to_string(),
                "目录.md".to_string(),
                "乙.md".to_string(),
            ],
        );

        // 单篇失败不影响别人：前面的成功项照样在 `items` 里，顺序保持
        assert_eq!(
            batch
                .items
                .iter()
                .map(|item| item.rel_path.as_str())
                .collect::<Vec<_>>(),
            vec!["甲.md", "乙.md"]
        );
        assert_eq!(batch.items[0].text, "# 甲\n正文\n");
        assert_eq!(batch.items[0].size_bytes, "# 甲\n正文\n".len() as u64);
        assert!(
            batch.items[0].mtime_ms > 0,
            "版本令牌要一起带回来（与 note_read 同一口径）"
        );

        // 四个原因值就是前端分支的依据，逐条钉住
        assert_eq!(
            batch
                .skipped
                .iter()
                .map(|skip| skip.reason)
                .collect::<Vec<_>>(),
            vec![
                crate::site_export::SiteSkipReason::NotFound,
                crate::site_export::SiteSkipReason::NotUtf8,
                crate::site_export::SiteSkipReason::Unreadable,
            ]
        );
        let json = serde_json::to_string(&NotesBatch {
            items: Vec::new(),
            skipped: batch.skipped.clone(),
        })
        .unwrap();
        for reason in ["\"not-found\"", "\"not-utf8\"", "\"unreadable\""] {
            assert!(json.contains(reason), "缺少 {reason}：{json}");
        }
        assert!(json.contains("\"skipped\""), "实际：{json}");

        // 空数组不是错误（前端第一次调用可能还没有清单）
        let empty = read_notes_batch(&state.vault_root().unwrap(), &[]);
        assert!(empty.items.is_empty() && empty.skipped.is_empty());
    }

    #[test]
    fn notes_read_batch_rejects_oversized_batches() {
        let (_dir, _state) = state_with(&[("甲.md", "正文\n")]);

        // 超过 64 篇 → PATH_INVALID（请求的形状不对，而不是某一篇读不到）。
        // 这条上限的意义是让一次 IPC 的报文体积有硬边界
        assert_eq!(MAX_BATCH_NOTES, 64);
        let too_many: Vec<String> = (0..MAX_BATCH_NOTES + 1)
            .map(|index| format!("笔记{index}.md"))
            .collect();
        let error = check_batch_size(too_many.len()).unwrap_err();
        assert_eq!(error.code, "PATH_INVALID");
        assert!(
            error.message.contains("64"),
            "说明要写清上限：{}",
            error.message
        );

        // 边界：正好 64 篇放行（由命令函数自己判，这里直接验判定函数）
        assert!(check_batch_size(MAX_BATCH_NOTES).is_ok());
        assert!(check_batch_size(0).is_ok());
    }
}
