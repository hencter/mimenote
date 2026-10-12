//! 回收站：删除一律「移动到 Vault 内 `.mimenote/trash`」并留下台账，不做 unlink。
//!
//! 理由（见 `docs/architecture.md` §5）：误删是笔记软件最不可接受的事故。
//! `.mimenote/` 默认被扫描器忽略，用户也可在 Git 里忽略它。
//! 台账 `index.jsonl` 每行一条记录，追加写入；恢复与永久删除见 ADR-0018。
//!
//! 因此这里有三组动作：**移动**（[`move_to_trash`]）、**恢复**（[`restore_from_trash`] /
//! [`restore_as`]）、**永久删除**（[`purge_from_trash`] / [`purge_all_trash`]）。
//! 三者共用同一条纪律：台账是磁盘上的普通 JSONL，**逐条校验**它指向的位置真的在
//! `.mimenote/trash` 之下，否则拒绝执行那一条（见 [`stored_path_under_trash`]）。

use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::path_guard::VaultRoot;

/// 回收站目录（Vault 相对路径，`/` 分隔）。
pub const TRASH_REL_DIR: &str = ".mimenote/trash";

/// 管理目录（回收站、片段、配置都在这里）。
pub const META_DIR: &str = ".mimenote";

const TRASH_INDEX_FILE: &str = "index.jsonl";

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// 一条删除记录。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashRecord {
    /// 唯一 ID（时间戳 + 序号）。
    pub id: String,
    /// 被删除文件的原始 Vault 相对路径。
    pub original_rel_path: String,
    /// 在回收站中的 Vault 相对路径。
    pub stored_rel_path: String,
    /// 删除时间（毫秒时间戳）。
    pub deleted_at_ms: u64,
    /// 大小（字节；目录为递归求和）。
    pub size_bytes: u64,
    /// 是否目录。
    pub is_dir: bool,
}

/// 把 `rel_path` 指向的文件/目录移入回收站。
///
/// 调用方（IPC 层）必须已经拿到用户的**显式确认**。
pub fn move_to_trash(root: &VaultRoot, rel_path: &str) -> Result<TrashRecord> {
    let segments = crate::path_guard::validate_relative_path(rel_path)?;
    if segments[0].eq_ignore_ascii_case(META_DIR) {
        return Err(Error::invalid(rel_path, "不允许删除 .mimenote 管理目录"));
    }

    let source = root.resolve_existing(rel_path)?;
    let meta = fs::symlink_metadata(&source).map_err(|e| Error::io(&source, e))?;
    let is_dir = meta.is_dir();
    let size_bytes = if is_dir {
        dir_size(&source).unwrap_or(0)
    } else {
        meta.len()
    };

    let id = new_id();
    let original_name = source
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "unnamed".to_string());
    let stored_name = format!("{id}__{original_name}");

    let trash_dir = root.path().join(META_DIR).join("trash");
    fs::create_dir_all(&trash_dir).map_err(|e| Error::io(&trash_dir, e))?;
    let stored = trash_dir.join(&stored_name);

    match fs::rename(&source, &stored) {
        Ok(()) => {}
        Err(_) => {
            // 跨卷等情况：退化为复制 + 删除，并保证复制成功后才删除源。
            copy_recursive(&source, &stored)?;
            if is_dir {
                fs::remove_dir_all(&source).map_err(|e| Error::io(&source, e))?;
            } else {
                fs::remove_file(&source).map_err(|e| Error::io(&source, e))?;
            }
        }
    }

    let record = TrashRecord {
        id,
        original_rel_path: rel_path.replace('\\', "/"),
        stored_rel_path: format!("{TRASH_REL_DIR}/{stored_name}"),
        deleted_at_ms: crate::atomic::now_ms(),
        size_bytes,
        is_dir,
    };
    append_index(root, &record)?;
    Ok(record)
}

/// 读取回收站台账（按写入顺序）。
pub fn list_trash(root: &VaultRoot) -> Result<Vec<TrashRecord>> {
    let index = root.path().join(META_DIR).join(TRASH_INDEX_FILE);
    if !index.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(&index).map_err(|e| Error::io(&index, e))?;
    Ok(text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<TrashRecord>(l).ok())
        .collect())
}

/// 一次恢复的结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOutcome {
    /// 被恢复的那条台账记录（`original_rel_path` 是它当初被删的位置）。
    pub record: TrashRecord,
    /// 实际恢复到哪个 Vault 相对路径。
    pub restored_rel_path: String,
    /// 为了放回它，新建了哪些目录（自浅到深；没有新建则为空）。
    ///
    /// 为什么要报出来：删掉 `项目/甲.md` 之后又删掉了整个 `项目/`，恢复时必须把目录建回来 ——
    /// 界面得能说清"我顺手建了 2 个目录"，而不是让用户对着一棵树猜发生了什么。
    pub created_dirs: Vec<String>,
    /// 台账里是否已经没有它了（恢复成功一律 `true`；留着这个字段是为了 DTO 形状稳定）。
    pub removed_from_index: bool,
}

impl RestoreOutcome {
    /// 恢复到原位置（`restored_rel_path == record.original_rel_path`）？
    pub fn is_original_place(&self) -> bool {
        self.restored_rel_path == self.record.original_rel_path
    }
}

/// 把一条台账记录恢复到它**当初的位置**。
///
/// 三条纪律：
///
/// 1. **绝不覆盖**：目标位置已经有东西就 `ALREADY_EXISTS` 并原样留在回收站 ——
///    用户可能已经把一篇新笔记写到了那个名字上，静默覆盖比"删错文件"更糟。
///    界面的出路是 [`restore_as`]（换个名字放回去），而不是放宽这条判定；
/// 2. **只动台账里的东西，且只动 `.mimenote/trash` 之下的东西**：台账是磁盘上的普通
///    JSONL，手改一行就能让它指向 Vault 里任何文件。因此这里**逐条校验**：
///    `stored_rel_path` 必须真的是回收站目录下的一段（`path_guard` 会拒掉绝对路径、
///    `..`、符号链接与越界），否则 `PATH_INVALID`。没有这条，"恢复"就是一个任意文件移动原语；
/// 3. **先搬文件、后改台账**：反过来（先删台账）一旦搬失败，文件还在回收站里却再也没人知道
///    它原本叫什么；而先搬后改的最坏情况是"文件回去了、台账还留着一条" —— 再点一次恢复
///    会得到 `NOT_FOUND`，可自愈。
pub fn restore_from_trash(root: &VaultRoot, id: &str) -> Result<RestoreOutcome> {
    let record = find_record(root, id)?;
    restore_record(root, &record, &record.original_rel_path)
}

/// 把一条台账记录恢复到**指定位置**（"恢复为…"：原位置已被占用时的出路）。
///
/// `target_rel_path` 与删除一样受 `path_guard` 约束：不能指向 `.mimenote/`、不能越界。
pub fn restore_as(root: &VaultRoot, id: &str, target_rel_path: &str) -> Result<RestoreOutcome> {
    let record = find_record(root, id)?;
    restore_record(root, &record, target_rel_path)
}

fn find_record(root: &VaultRoot, id: &str) -> Result<TrashRecord> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err(Error::invalid(id, "回收站记录 ID 不能为空"));
    }
    list_trash(root)?
        .into_iter()
        .find(|record| record.id == trimmed)
        .ok_or_else(|| Error::NotFound(format!("回收站记录 {trimmed}")))
}

fn restore_record(
    root: &VaultRoot,
    record: &TrashRecord,
    target_rel_path: &str,
) -> Result<RestoreOutcome> {
    let target_segments = crate::path_guard::validate_relative_path(target_rel_path)?;
    if target_segments[0].eq_ignore_ascii_case(META_DIR) {
        return Err(Error::invalid(
            target_rel_path,
            "不能把回收站里的东西恢复到 .mimenote 管理目录",
        ));
    }

    // —— 来源必须是回收站里的东西（见函数文档第 2 条）——
    let stored_rel = stored_path_under_trash(record)?;
    let source = root.resolve_existing(&stored_rel)?;

    // —— 目标不能已存在（见函数文档第 1 条）——
    let target = root.path().join(
        target_rel_path
            .replace('\\', "/")
            .split('/')
            .collect::<Vec<_>>()
            .join(std::path::MAIN_SEPARATOR_STR),
    );
    if fs::symlink_metadata(&target).is_ok() {
        return Err(Error::AlreadyExists(format!(
            "{target_rel_path}（先把那个文件移开，或用「恢复为…」换个名字）"
        )));
    }

    // —— 父目录缺了就补（删过整个目录的情况）——
    let mut created_dirs: Vec<String> = Vec::new();
    let mut accumulated = String::new();
    for segment in target_segments.iter().take(target_segments.len() - 1) {
        accumulated = if accumulated.is_empty() {
            segment.clone()
        } else {
            format!("{accumulated}/{segment}")
        };
        let dir = root.path().join(
            accumulated
                .split('/')
                .collect::<Vec<_>>()
                .join(std::path::MAIN_SEPARATOR_STR),
        );
        if fs::symlink_metadata(&dir).is_err() {
            fs::create_dir(&dir).map_err(|e| Error::io(&dir, e))?;
            created_dirs.push(accumulated.clone());
        }
    }

    // —— 搬回去（跨卷时退化为复制 + 删源，与删除同一条路径）——
    match fs::rename(&source, &target) {
        Ok(()) => {}
        Err(_) => {
            let is_dir = fs::symlink_metadata(&source)
                .map(|meta| meta.is_dir())
                .unwrap_or(record.is_dir);
            copy_recursive(&source, &target)?;
            if is_dir {
                fs::remove_dir_all(&source).map_err(|e| Error::io(&source, e))?;
            } else {
                fs::remove_file(&source).map_err(|e| Error::io(&source, e))?;
            }
        }
    }

    // —— 最后改台账（见函数文档第 3 条）——
    let removed_from_index = drop_index_entry(root, &record.id)?;

    Ok(RestoreOutcome {
        record: record.clone(),
        restored_rel_path: target_rel_path.replace('\\', "/"),
        created_dirs,
        removed_from_index,
    })
}

/// 校验一条记录的 `stored_rel_path` 并返回它（POSIX 写法）。
///
/// 恢复与永久删除**共用**这一处判定：台账是磁盘上的普通 JSONL，手改一行就能让它指向 Vault 里
/// 任何文件。若直接按它搬或按它删，`restore` 就是"任意文件移动"、`purge` 就是"任意文件删除"。
/// 两份判定写两遍迟早会漂移，而**漂移掉的那一份就是一条任意删除原语**。
///
/// 这里只做形状判定（必须是 `.mimenote/trash/某一段`，恰好三段的相对路径）；"解析出来的绝对
/// 路径是不是真的还在 Vault / 回收站里"由调用方接着用 `root.resolve_existing` 问 `path_guard`
/// —— 它会拒掉绝对路径、`..`、盘符、保留名，以及**逐级检查符号链接**（回收站里预先躺着一条
/// 指向 Vault 之外的链接时，那条记录同样不该被照做）。
fn stored_path_under_trash(record: &TrashRecord) -> Result<String> {
    let stored_rel = record.stored_rel_path.replace('\\', "/");
    let segments = stored_rel.split('/').collect::<Vec<_>>();
    if segments.len() != 3
        || !segments[0].eq_ignore_ascii_case(META_DIR)
        || !segments[1].eq_ignore_ascii_case("trash")
    {
        return Err(Error::invalid(
            &record.stored_rel_path,
            "台账记录指向的不是回收站目录下的条目",
        ));
    }
    Ok(stored_rel)
}

/// 永久删除的结果（三种：真删了 / 东西早就不在但记录清了 / 被拒或删不动）。
///
/// 为什么不是 `Result`：一次永久删除可能碰上一批记录，其中某一条失败不该让整批中断，
/// 界面也要能逐条说清"哪条没成、为什么"。用错误码表达等于把"部分成功"折叠成"失败"。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum PurgeResult {
    /// 文件/目录真的被删掉了，附带实际释放的字节数（见 [`purge_record`] 的口径）。
    Removed {
        /// 实际释放的字节数（按删除前的实测大小；实测不到时退回台账记录的大小）。
        bytes_freed: u64,
    },
    /// 台账里有、`.mimenote/trash` 里已经没有（用户手工清过回收站）：只清掉那条台账记录。
    ///
    /// 它不是失败 —— 用户点"永久删除"的意图正是"别再让它占着回收站列表"，
    /// 而东西早就没了。因此它**照常从台账里去掉**，只是不计入释放的字节。
    AlreadyGone,
    /// 这一条**没有执行**，台账记录也**原样留着**：校验不过（`path-invalid` / `path-escape`）
    /// 或删不动（`io`）。理由见 [`purge_from_trash`] 的文档。
    Failed(PurgeFailure),
}

/// 一条被拒/删不动的记录，以及**为什么**。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeFailure {
    /// 台账记录的 ID。
    pub id: String,
    /// 它当初被删的位置（界面按这个称呼它）。
    pub original_rel_path: String,
    /// 台账里写的回收站内路径（**仅供日志与测试**：它是不可信的输入，不进 IPC 出参）。
    pub stored_rel_path: String,
    /// 稳定原因（界面按它给出一句人话）。
    pub reason: PurgeFailureReason,
    /// 具体原因（宿主/文件系统的原话，或者我们自己写的那句"台账指向的不是回收站目录下的条目"）。
    pub message: String,
}

/// 一条记录被拒绝永久删除的**稳定原因**。
///
/// 与 `TagSkipReason` 同一套思路：一次批量操作会碰上多条处境不同的记录，用错误码表达
/// 等于把"哪几条没成"折叠成"整批失败"，界面也就无法如实汇报。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PurgeFailureReason {
    /// 台账那条记录的 `stored_rel_path` 形状不对（指的不是回收站目录下的条目）。
    PathInvalid,
    /// 解析出来的绝对路径越出了 Vault（`..`、符号链接逃逸等）—— `path_guard` 拒绝。
    PathEscape,
    /// 校验通过了，但删除本身失败（权限、文件被占用、IO 错误）。
    Io,
}

/// 一次永久删除操作：逐条结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeOutcome {
    /// 这一次**尝试**处理了哪条记录（与输入一一对应；`purge_all_trash` 时是当时的全部台账记录）。
    pub record: TrashRecord,
    /// 这一条的结果。
    pub result: PurgeResult,
    /// 台账里已经不再有它了。
    ///
    /// 只有三种情况为 `false`：校验不过或删不动的那些（[`PurgeResult::Failed`]）——
    /// 那时记录**故意留着**，让用户还能看见"这条我没能清掉"。
    pub dropped_from_index: bool,
}

/// 永久删除回收站里的**一条**（真删文件 + 去掉台账记录）。
///
/// 与 [`restore_from_trash`] 的三条纪律一一对应，但方向相反：
///
/// 1. **逐条重新校验**：不接受"列表里看过了所以可信"。`stored_rel_path` 必须真的在
///    `.mimenote/trash` 之下（形状由 [`stored_path_under_trash`] 判，绝对路径由 `path_guard` 判），
///    否则这一条**拒绝执行**，并如实进 [`PurgeResult::Failed`] —— 这是"永久删除"这个
///    不可逆动作唯一能有的兜底；
/// 2. **只删回收站里的东西**：`.mimenote/` 里的 cache / snippets / 配置一概不碰。
///    判定的落点是"路径真的在 trash 之下"，不是"路径以 .mimenote 开头"；
/// 3. **先删文件、后台账**（与恢复同为"先动文件"）。反过来（先删台账）会留下
///    "台账说删了、文件还在"—— 那句谎话会让用户以为空间已经回收，而磁盘上那份东西
///    再也**没有任何入口**能删（列表里已经没有它了）。先删后改的最坏结果是
///    "文件删了、台账留了一条孤儿记录"：界面本来就会把孤儿记录标成"文件已不在回收站"，
///    用户再点一次"永久删除"即可清掉 —— **可自愈**。
///
/// 目录要整棵删（删过一个目录再永久删除时，回收站里存着的是一棵树）。
pub fn purge_from_trash(root: &VaultRoot, id: &str) -> Result<PurgeOutcome> {
    let record = find_record(root, id)?;
    Ok(purge_record(root, &record))
}

/// 永久删除**当前台账里的全部记录**（清空回收站）。
///
/// 与 [`purge_from_trash`] 是同一套逐条逻辑（每一条都要重新校验），差别只有"处理哪些记录"。
/// 台账在开头读一次：中途删进来的东西不在这一轮的范围内 —— 用户刚刚确认的是"此刻列表上
/// 这些东西"，再删进来一条却顺手把它也永久删掉，就超出了他按下的那一下。
///
/// 一条失败**不中断整批**（逐条记结果），但每一条都如实说清。
pub fn purge_all_trash(root: &VaultRoot) -> Result<Vec<PurgeOutcome>> {
    let records = list_trash(root)?;
    Ok(records
        .iter()
        .map(|record| purge_record(root, record))
        .collect())
}

/// 永久删除一条记录（调用方已确保它来自台账）。
fn purge_record(root: &VaultRoot, record: &TrashRecord) -> PurgeOutcome {
    let failed = |reason: PurgeFailureReason, message: String| PurgeOutcome {
        record: record.clone(),
        result: PurgeResult::Failed(PurgeFailure {
            id: record.id.clone(),
            original_rel_path: record.original_rel_path.clone(),
            stored_rel_path: record.stored_rel_path.clone(),
            reason,
            message,
        }),
        // 校验不过的记录**留着**：它是用户唯一还能看见"这里有一条我没能清掉"的地方
        dropped_from_index: false,
    };

    // —— 逐条校验（见函数文档第 1、2 条）——
    let stored_rel = match stored_path_under_trash(record) {
        Ok(rel) => rel,
        Err(error) => return failed(PurgeFailureReason::PathInvalid, error.to_string()),
    };
    let stored = match root.resolve_existing(&stored_rel) {
        Ok(path) => path,
        Err(Error::NotFound(_)) => {
            // 孤儿记录：东西早就没了，这一条只是清台账（见 `PurgeResult::AlreadyGone` 的文档）
            return PurgeOutcome {
                record: record.clone(),
                result: PurgeResult::AlreadyGone,
                dropped_from_index: drop_index_entry(root, &record.id).unwrap_or(false),
            };
        }
        Err(error) => return failed(purge_reason_of(&error), error.to_string()),
    };
    let meta = match fs::symlink_metadata(&stored) {
        Ok(meta) => meta,
        Err(error) => {
            return failed(
                PurgeFailureReason::Io,
                Error::io(&stored, error).to_string(),
            )
        }
    };

    // 实测大小而不是照抄台账：台账里的 `size_bytes` 是**删除那一刻**记下的，之后文件可能被
    // 恢复过又删了一次、或用户手工往里塞了东西。界面上那句"释放了 X"必须是我们真删掉的量。
    let measured = if meta.is_dir() {
        dir_size(&stored).unwrap_or(record.size_bytes)
    } else {
        meta.len()
    };

    // —— 先删文件（见函数文档第 3 条）——
    let removal = if meta.is_dir() {
        fs::remove_dir_all(&stored).map_err(|error| Error::io(&stored, error))
    } else {
        fs::remove_file(&stored).map_err(|error| Error::io(&stored, error))
    };
    if let Err(error) = removal {
        // 目录可能恰好在我们检查之后被清空/删掉了：那已经是我们想要的结果，不算失败
        if !stored.exists() {
            return PurgeOutcome {
                record: record.clone(),
                result: PurgeResult::Removed { bytes_freed: 0 },
                dropped_from_index: drop_index_entry(root, &record.id).unwrap_or(false),
            };
        }
        return failed(PurgeFailureReason::Io, error.to_string());
    }

    // —— 后台账（见函数文档第 3 条）——
    PurgeOutcome {
        record: record.clone(),
        result: PurgeResult::Removed {
            bytes_freed: measured,
        },
        dropped_from_index: drop_index_entry(root, &record.id).unwrap_or(false),
    }
}

/// 把 `path_guard` 的错误码翻成永久删除的稳定原因。
///
/// 只有"越界"这一类配得上 `PathEscape`：那正是"台账想把我们引到回收站外面去"的信号，
/// 值得在界面上单独说一句。其余（非法路径段、保留名、控制字符……）一律归 `PathInvalid`。
fn purge_reason_of(error: &Error) -> PurgeFailureReason {
    match error.code() {
        crate::ErrorCode::PathEscape => PurgeFailureReason::PathEscape,
        _ => PurgeFailureReason::PathInvalid,
    }
}

/// 从台账里删掉一条记录（重写整个文件：JSONL 是追加写入的，删行只能重写）。
///
/// 用 [`crate::atomic::write_atomic`] 重写而不是就地截断：截断过程中断电会留下半截台账，
/// 而台账是"用户还能不能找回删掉的东西"的唯一依据。
fn drop_index_entry(root: &VaultRoot, id: &str) -> Result<bool> {
    let index = root.path().join(META_DIR).join(TRASH_INDEX_FILE);
    if !index.exists() {
        return Ok(false);
    }
    let text = fs::read_to_string(&index).map_err(|e| Error::io(&index, e))?;
    let mut kept: Vec<&str> = Vec::new();
    let mut removed = false;
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let matches = serde_json::from_str::<TrashRecord>(line)
            .map(|record| record.id == id)
            .unwrap_or(false);
        if matches {
            removed = true;
            continue;
        }
        kept.push(line);
    }
    if !removed {
        return Ok(false);
    }
    let mut next = kept.join("\n");
    if !next.is_empty() {
        next.push('\n');
    }
    crate::atomic::write_atomic(&index, next.as_bytes())?;
    Ok(true)
}

fn append_index(root: &VaultRoot, record: &TrashRecord) -> Result<()> {
    let dir = root.path().join(META_DIR);
    fs::create_dir_all(&dir).map_err(|e| Error::io(&dir, e))?;
    let index = dir.join(TRASH_INDEX_FILE);
    let line = serde_json::to_string(record).map_err(|e| Error::io(&index, e.into()))?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&index)
        .map_err(|e| Error::io(&index, e))?;
    file.write_all(line.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|e| Error::io(&index, e))?;
    Ok(())
}

fn new_id() -> String {
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}-{seq:04}", crate::atomic::now_ms())
}

fn dir_size(dir: &Path) -> Result<u64> {
    let mut total = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let read_dir = match fs::read_dir(&current) {
            Ok(rd) => rd,
            Err(e) => return Err(Error::io(&current, e)),
        };
        for item in read_dir.flatten() {
            let path = item.path();
            let meta = match fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                stack.push(path);
            } else {
                total += meta.len();
            }
        }
    }
    Ok(total)
}

fn copy_recursive(source: &Path, target: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(source).map_err(|e| Error::io(source, e))?;
    if meta.is_dir() {
        fs::create_dir_all(target).map_err(|e| Error::io(target, e))?;
        for item in fs::read_dir(source)
            .map_err(|e| Error::io(source, e))?
            .flatten()
        {
            let name = item.file_name();
            copy_recursive(&item.path(), &target.join(name))?;
        }
    } else {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| Error::io(parent, e))?;
        }
        fs::copy(source, target).map_err(|e| Error::io(target, e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_file_to_trash_and_records_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        fs::create_dir_all(dir.path().join("notes")).unwrap();
        fs::write(dir.path().join("notes/gone.md"), "# 再见").unwrap();

        let record = move_to_trash(&root, "notes/gone.md").unwrap();
        assert_eq!(record.original_rel_path, "notes/gone.md");
        assert!(!record.is_dir);
        assert!(record.size_bytes > 0);
        assert!(record.stored_rel_path.starts_with(TRASH_REL_DIR));

        // 原位置已消失，回收站中存在且内容完好
        assert!(!dir.path().join("notes/gone.md").exists());
        let stored = root
            .path()
            .join(".mimenote/trash")
            .join(record.stored_rel_path.rsplit('/').next().unwrap());
        assert_eq!(fs::read_to_string(&stored).unwrap(), "# 再见");

        let listed = list_trash(&root).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, record.id);
    }

    #[test]
    fn moves_directory_to_trash_with_size() {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        fs::create_dir_all(dir.path().join("folder/sub")).unwrap();
        fs::write(dir.path().join("folder/sub/a.md"), "12345").unwrap();

        let record = move_to_trash(&root, "folder").unwrap();
        assert!(record.is_dir);
        assert_eq!(record.size_bytes, 5);
        assert!(!dir.path().join("folder").exists());
    }

    #[test]
    fn refuses_meta_dir_and_bad_paths() {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        assert!(move_to_trash(&root, ".mimenote/trash").is_err());
        assert_eq!(
            move_to_trash(&root, "../outside.md").unwrap_err().code(),
            crate::ErrorCode::PathInvalid
        );
        assert_eq!(
            move_to_trash(&root, "missing.md").unwrap_err().code(),
            crate::ErrorCode::NotFound
        );
    }

    #[test]
    fn index_is_append_only_jsonl() {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        fs::write(dir.path().join("a.md"), "a").unwrap();
        fs::write(dir.path().join("b.md"), "b").unwrap();
        move_to_trash(&root, "a.md").unwrap();
        move_to_trash(&root, "b.md").unwrap();

        let index = fs::read_to_string(dir.path().join(".mimenote/index.jsonl")).unwrap();
        assert_eq!(index.lines().count(), 2);
        let listed = list_trash(&root).unwrap();
        assert_eq!(listed.len(), 2);
        assert_ne!(listed[0].id, listed[1].id, "ID 必须唯一");
    }

    // -- 恢复（M2 承诺过、一直没做的那半）------------------------------------------------

    #[test]
    fn restore_puts_the_file_back_and_clears_the_entry() {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        fs::create_dir_all(dir.path().join("notes")).unwrap();
        fs::write(dir.path().join("notes/gone.md"), "# 再见\n正文").unwrap();

        let record = move_to_trash(&root, "notes/gone.md").unwrap();
        assert_eq!(list_trash(&root).unwrap().len(), 1);

        let outcome = restore_from_trash(&root, &record.id).unwrap();
        assert!(outcome.is_original_place());
        assert_eq!(outcome.restored_rel_path, "notes/gone.md");
        assert!(outcome.created_dirs.is_empty(), "父目录一直在，不该新建");
        assert!(outcome.removed_from_index);

        // 内容逐字节回来，台账里不再有它 —— 再点一次恢复应当是 NOT_FOUND
        assert_eq!(
            fs::read_to_string(dir.path().join("notes/gone.md")).unwrap(),
            "# 再见\n正文"
        );
        assert!(list_trash(&root).unwrap().is_empty());
        assert_eq!(
            restore_from_trash(&root, &record.id).unwrap_err().code(),
            crate::ErrorCode::NotFound
        );
    }

    #[test]
    fn restore_refuses_to_overwrite_something_that_took_the_place() {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        fs::write(dir.path().join("a.md"), "旧").unwrap();
        let record = move_to_trash(&root, "a.md").unwrap();

        // 用户已经把一篇新笔记写到了同一个名字上
        fs::write(dir.path().join("a.md"), "新的内容").unwrap();

        let error = restore_from_trash(&root, &record.id).unwrap_err();
        assert_eq!(error.code(), crate::ErrorCode::AlreadyExists);
        assert_eq!(
            fs::read_to_string(dir.path().join("a.md")).unwrap(),
            "新的内容",
            "绝不覆盖占位者"
        );
        assert_eq!(
            list_trash(&root).unwrap().len(),
            1,
            "失败之后台账与回收站都要原样留着，让用户能换名字再来"
        );

        // 出路：换个名字恢复
        let outcome = restore_as(&root, &record.id, "项目/a（恢复）.md").unwrap();
        assert_eq!(outcome.restored_rel_path, "项目/a（恢复）.md");
        assert_eq!(outcome.created_dirs, vec!["项目".to_string()]);
        assert_eq!(
            fs::read_to_string(dir.path().join("项目/a（恢复）.md")).unwrap(),
            "旧"
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("a.md")).unwrap(),
            "新的内容"
        );
    }

    #[test]
    fn restore_recreates_missing_parent_directories() {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        fs::create_dir_all(dir.path().join("项目/子项目")).unwrap();
        fs::write(dir.path().join("项目/子项目/甲.md"), "甲").unwrap();

        let record = move_to_trash(&root, "项目/子项目/甲.md").unwrap();
        fs::remove_dir_all(dir.path().join("项目")).unwrap();

        let outcome = restore_from_trash(&root, &record.id).unwrap();
        assert_eq!(
            outcome.created_dirs,
            vec!["项目".to_string(), "项目/子项目".to_string()],
            "自浅到深报告新建了哪些目录"
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("项目/子项目/甲.md")).unwrap(),
            "甲"
        );
    }

    #[test]
    fn restore_moves_a_whole_directory_back() {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        fs::create_dir_all(dir.path().join("folder/sub")).unwrap();
        fs::write(dir.path().join("folder/sub/a.md"), "a").unwrap();
        let record = move_to_trash(&root, "folder").unwrap();

        let outcome = restore_from_trash(&root, &record.id).unwrap();
        assert!(outcome.record.is_dir);
        assert_eq!(
            fs::read_to_string(dir.path().join("folder/sub/a.md")).unwrap(),
            "a"
        );
    }

    #[test]
    fn restore_refuses_paths_that_are_not_under_the_trash() {
        // 台账是磁盘上的普通 JSONL：手改一行就能让它指向 Vault 里的**任意**文件。
        // 没有这条校验，"恢复"就成了一个任意文件移动原语。
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        fs::write(dir.path().join("重要.md"), "不能被我搬走").unwrap();
        let record = move_to_trash(&root, "重要.md").unwrap();

        for stored in [
            "重要.md",
            "../重要.md",
            ".mimenote/trash/../重要.md",
            "/etc/passwd",
        ] {
            let tampered = TrashRecord {
                stored_rel_path: stored.to_string(),
                ..record.clone()
            };
            rewrite_index(&root, &[tampered]);
            let error = restore_from_trash(&root, &record.id).unwrap_err();
            assert!(
                matches!(
                    error.code(),
                    crate::ErrorCode::PathInvalid | crate::ErrorCode::PathEscape
                ),
                "台账指向 {stored} 时应当被拒，实际是 {:?}",
                error.code()
            );
            assert!(
                !dir.path().join("重要.md").exists(),
                "被篡改的台账不该让文件被搬动（{stored}）"
            );
        }
    }

    #[test]
    fn restore_refuses_meta_dir_as_target() {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        fs::write(dir.path().join("a.md"), "a").unwrap();
        let record = move_to_trash(&root, "a.md").unwrap();

        let error = restore_as(&root, &record.id, ".mimenote/trash/a.md").unwrap_err();
        assert_eq!(error.code(), crate::ErrorCode::PathInvalid);
        assert_eq!(list_trash(&root).unwrap().len(), 1);
    }

    #[test]
    fn restore_reports_unknown_ids_as_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        assert_eq!(
            restore_from_trash(&root, "不存在的-id").unwrap_err().code(),
            crate::ErrorCode::NotFound
        );
        assert_eq!(
            restore_from_trash(&root, "  ").unwrap_err().code(),
            crate::ErrorCode::PathInvalid
        );
    }

    /// 重写台账（测试里模拟"手改过的台账"）。
    fn rewrite_index(root: &VaultRoot, records: &[TrashRecord]) {
        let index = root.path().join(META_DIR).join(TRASH_INDEX_FILE);
        let text: String = records
            .iter()
            .map(|record| format!("{}\n", serde_json::to_string(record).unwrap()))
            .collect();
        crate::atomic::write_atomic(&index, text.as_bytes()).unwrap();
    }

    /// 台账文件里的**原始**记录（绕开 `list_trash`：它会把解析不出来的行丢掉，
    /// 而"被拒的那条到底还在不在台账里"正是这几条用例要断言的东西）。
    fn raw_index(root: &VaultRoot) -> Vec<TrashRecord> {
        let index = root.path().join(META_DIR).join(TRASH_INDEX_FILE);
        if !index.exists() {
            return Vec::new();
        }
        fs::read_to_string(&index)
            .unwrap()
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    // -- 永久删除与清空（ADR-0018 的后续修订）--------------------------------------------

    /// 把一条记录（或它的 `stored_rel_path`）塞进台账，模拟"手改过的台账"。
    fn tamper(root: &VaultRoot, record: &TrashRecord, stored_rel_path: &str) -> TrashRecord {
        let tampered = TrashRecord {
            stored_rel_path: stored_rel_path.to_string(),
            ..record.clone()
        };
        rewrite_index(root, std::slice::from_ref(&tampered));
        tampered
    }

    #[test]
    fn purge_deletes_the_file_and_clears_the_entry() {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        fs::write(dir.path().join("gone.md"), "12345").unwrap();
        let record = move_to_trash(&root, "gone.md").unwrap();
        let stored = root
            .path()
            .join(".mimenote/trash")
            .join(record.stored_rel_path.rsplit('/').next().unwrap());
        assert!(stored.exists(), "删除之后文件先在回收站里");

        let outcome = purge_from_trash(&root, &record.id).unwrap();
        assert_eq!(
            outcome.result,
            PurgeResult::Removed { bytes_freed: 5 },
            "释放的字节数是**实测**的（不是照抄台账）"
        );
        assert!(outcome.dropped_from_index);
        assert!(!stored.exists(), "磁盘上真的没有了");
        assert!(list_trash(&root).unwrap().is_empty());

        // 再点一次：记录已经不在台账里了 —— 这不是错误，而是一条 Failed 的如实汇报
        // （界面能指着它说"这条记录已经不在了"，而不是整批操作抛一个错误码）
        let again = purge_from_trash(&root, &record.id).unwrap_err();
        assert_eq!(again.code(), crate::ErrorCode::NotFound);
    }

    #[test]
    fn purge_removes_a_whole_directory_tree() {
        // 删过一个目录再永久删除时，回收站里存着的是一棵树
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        fs::create_dir_all(dir.path().join("folder/sub")).unwrap();
        fs::write(dir.path().join("folder/sub/a.md"), "12345").unwrap();
        fs::write(dir.path().join("folder/b.md"), "abc").unwrap();
        let record = move_to_trash(&root, "folder").unwrap();
        assert!(record.is_dir);

        let outcome = purge_from_trash(&root, &record.id).unwrap();
        assert_eq!(outcome.result, PurgeResult::Removed { bytes_freed: 8 });
        let stored_dir = dir.path().join(".mimenote/trash");
        assert_eq!(
            fs::read_dir(&stored_dir).unwrap().count(),
            0,
            "整棵树都要没了，连空壳目录都不留"
        );
        assert!(list_trash(&root).unwrap().is_empty());
    }

    #[test]
    fn purge_clears_the_entry_of_an_orphan_record() {
        // 用户在文件管理器里清过 `.mimenote/trash`：台账还在，东西没了。
        // 这一条不是失败 —— 用户点"永久删除"要的就是"别再让它占着列表"
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        fs::write(dir.path().join("gone.md"), "x").unwrap();
        let record = move_to_trash(&root, "gone.md").unwrap();
        let stored = dir.path().join(
            record
                .stored_rel_path
                .replace('/', std::path::MAIN_SEPARATOR_STR),
        );
        fs::remove_file(&stored).unwrap();

        let outcome = purge_from_trash(&root, &record.id).unwrap();
        assert_eq!(outcome.result, PurgeResult::AlreadyGone);
        assert!(
            outcome.dropped_from_index,
            "孤儿记录要被清掉，否则永远留在列表里"
        );
        assert!(list_trash(&root).unwrap().is_empty());
        assert!(raw_index(&root).is_empty());
    }

    #[test]
    fn purge_refuses_paths_that_are_not_under_the_trash() {
        // 台账是磁盘上的普通 JSONL：手改一行就能让它指向 Vault 里**任意**文件（或 Vault 之外）。
        // 没有这条校验，"永久删除"就是一个任意文件删除原语 —— 而且不可逆。
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        fs::write(dir.path().join("重要.md"), "不能被我删掉").unwrap();
        let record = move_to_trash(&root, "重要.md").unwrap();
        // 恢复回来，让它重新躺在 Vault 里（现在它是"不该被删的东西"）
        restore_from_trash(&root, &record.id).unwrap();
        assert!(dir.path().join("重要.md").exists());

        for stored in [
            "重要.md",
            "../重要.md",
            ".mimenote/trash/../重要.md",
            "/etc/passwd",
            ".mimenote/cache/index.db",
            ".mimenote/trash", // 段数不对：回收站目录本身不是一个条目
            ".mimenote/snippets/x.css",
        ] {
            tamper(&root, &record, stored);
            let outcome = purge_from_trash(&root, &record.id).unwrap();
            let failure = match &outcome.result {
                PurgeResult::Failed(failure) => failure,
                other => panic!("台账指向 {stored} 时应当被拒，实际是 {other:?}"),
            };
            assert!(
                matches!(
                    failure.reason,
                    PurgeFailureReason::PathInvalid | PurgeFailureReason::PathEscape
                ),
                "台账指向 {stored} 时应当被拒，实际是 {:?}",
                failure.reason
            );
            assert_eq!(failure.id, record.id);
            assert!(
                !outcome.dropped_from_index,
                "被拒的记录要留着（{stored}）：它是用户唯一还能看见「这里有一条没清掉」的地方"
            );
            let left = raw_index(&root);
            assert_eq!(left.len(), 1, "被拒的记录必须原样留在台账里（{stored}）");
            assert_eq!(left[0].stored_rel_path, stored);
            assert!(
                dir.path().join("重要.md").exists(),
                "被篡改的台账不该让文件被删掉（{stored}）"
            );
            assert!(
                dir.path().join(".mimenote/trash").exists(),
                "更不该顺手把回收站目录删了（{stored}）"
            );
        }
    }

    #[test]
    fn purge_refuses_a_symlink_that_escapes_the_vault() {
        // 回收站里预先躺着一条指向 Vault 之外的链接：台账那行看起来完全合法
        // （`.mimenote/trash/xxx__名字`），只有 `path_guard` 的逐级符号链接检查能拦住它。
        let outer = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        fs::write(dir.path().join("gone.md"), "x").unwrap();
        let record = move_to_trash(&root, "gone.md").unwrap();
        // 先把真文件拿回来（这样"Vault 之外的东西还在不在"与"回收站里的那个条目"互不干扰）
        restore_from_trash(&root, &record.id).unwrap();

        let secret = outer.path().join("secret.md");
        fs::write(&secret, "绝不能被删").unwrap();
        fs::create_dir_all(dir.path().join(".mimenote/trash")).unwrap();
        let link_rel = ".mimenote/trash/link.md";
        let link = dir
            .path()
            .join(link_rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        #[cfg(windows)]
        let created = std::os::windows::fs::symlink_file(&secret, &link).is_ok();
        #[cfg(unix)]
        let created = std::os::unix::fs::symlink(&secret, &link).is_ok();
        if !created {
            eprintln!("跳过：当前环境不允许创建符号链接（需要开发者模式/管理员）");
            return;
        }

        // 台账那行指向"回收站里的这条链接"——看起来完全合法
        tamper(&root, &record, link_rel);

        let outcome = purge_from_trash(&root, &record.id).unwrap();
        match &outcome.result {
            PurgeResult::Failed(failure) => assert_eq!(
                failure.reason,
                PurgeFailureReason::PathEscape,
                "逃出 Vault 的符号链接要按 PATH_ESCAPE 报出来"
            ),
            other => panic!("逃出 Vault 的符号链接不该被照做，实际是 {other:?}"),
        }
        assert!(secret.exists(), "Vault 之外的那个文件一个字节都不能少");
        assert_eq!(raw_index(&root).len(), 1, "被拒的记录留着");
    }

    #[test]
    fn purge_all_clears_everything_including_orphans() {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        fs::create_dir_all(dir.path().join("folder")).unwrap();
        fs::write(dir.path().join("a.md"), "aaa").unwrap();
        fs::write(dir.path().join("folder/b.md"), "bb").unwrap();

        let first = move_to_trash(&root, "a.md").unwrap();
        let second = move_to_trash(&root, "folder").unwrap();
        // 其中一条变成孤儿记录（手工清理过回收站）与"清空"这件事互不干扰
        let orphan = dir.path().join(
            second
                .stored_rel_path
                .replace('/', std::path::MAIN_SEPARATOR_STR),
        );
        fs::remove_dir_all(&orphan).unwrap();

        let outcomes = purge_all_trash(&root).unwrap();
        assert_eq!(outcomes.len(), 2, "当时台账里有两条，就处理两条");
        assert!(outcomes.iter().all(|item| item.dropped_from_index));
        assert_eq!(
            outcomes
                .iter()
                .filter(|item| matches!(item.result, PurgeResult::Removed { .. }))
                .count(),
            1
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|item| item.result == PurgeResult::AlreadyGone)
                .count(),
            1
        );
        assert!(outcomes.iter().any(|item| item.record.id == first.id));
        assert!(outcomes.iter().any(|item| item.record.id == second.id));

        assert!(list_trash(&root).unwrap().is_empty());
        assert!(raw_index(&root).is_empty());
        assert_eq!(
            fs::read_dir(dir.path().join(".mimenote/trash"))
                .unwrap()
                .count(),
            0,
            "文件全删了"
        );
        assert!(
            dir.path().join(".mimenote").exists(),
            "只删回收站里的东西，管理目录本身不许动"
        );
    }

    #[test]
    fn purge_all_keeps_going_after_a_rejected_record() {
        // 一条被拒**不中断整批**：另外两条照删，被拒的那条如实报出来且留在台账里
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        fs::write(dir.path().join("a.md"), "aaa").unwrap();
        fs::write(dir.path().join("b.md"), "bb").unwrap();
        fs::write(dir.path().join("重要.md"), "不能删").unwrap();

        let good = move_to_trash(&root, "a.md").unwrap();
        let bad = move_to_trash(&root, "b.md").unwrap();
        restore_from_trash(&root, &bad.id).unwrap(); // 让 b.md 回到 Vault
        let other = move_to_trash(&root, "重要.md").unwrap();
        restore_from_trash(&root, &other.id).unwrap(); // 让 重要.md 也回到 Vault

        // 手改台账：一条指向回收站里的真东西（good），一条指向 Vault 里的 重要.md（bad）
        let good_in_index = list_trash(&root).unwrap()[0].clone();
        assert_eq!(good_in_index.id, good.id, "只剩 good 还在台账里");
        let tampered_bad = TrashRecord {
            stored_rel_path: "重要.md".to_string(),
            ..bad.clone()
        };
        rewrite_index(&root, &[good_in_index, tampered_bad.clone()]);

        let outcomes = purge_all_trash(&root).unwrap();
        assert_eq!(outcomes.len(), 2);
        assert!(matches!(outcomes[0].result, PurgeResult::Removed { .. }));
        assert!(matches!(outcomes[1].result, PurgeResult::Failed(_)));
        assert!(dir.path().join("重要.md").exists(), "被拒的那条不许删文件");
        assert!(
            !dir.path().join("a.md").exists(),
            "a.md 早已被删进回收站，Vault 里本来就没有它"
        );
        assert!(
            dir.path().join("b.md").exists(),
            "b.md 是上一轮恢复回来的普通笔记，手改的台账没提它，本轮一个字节都不该动它"
        );
        let left = raw_index(&root);
        assert_eq!(left.len(), 1, "只留下被拒的那条");
        assert_eq!(left[0].id, tampered_bad.id);
    }

    #[test]
    fn purge_reports_unknown_ids_as_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        assert_eq!(
            purge_from_trash(&root, "不存在的-id").unwrap_err().code(),
            crate::ErrorCode::NotFound
        );
        assert_eq!(
            purge_from_trash(&root, "  ").unwrap_err().code(),
            crate::ErrorCode::PathInvalid
        );
    }

    #[test]
    fn purge_on_an_empty_ledger_is_a_no_op() {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        assert!(purge_all_trash(&root).unwrap().is_empty());
        assert!(purge_all_trash(&root).unwrap().is_empty(), "再点一次也一样");
    }

    #[test]
    fn purge_leaves_files_outside_the_trash_alone() {
        // "只删回收站里的东西"落到判据上：删完一遍之后 Vault 里的笔记、管理目录里的 cache 与
        // snippets 全都原样在
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        fs::create_dir_all(dir.path().join(".mimenote/snippets")).unwrap();
        fs::create_dir_all(dir.path().join(".mimenote/cache")).unwrap();
        fs::write(dir.path().join("笔记.md"), "留着").unwrap();
        fs::write(dir.path().join(".mimenote/snippets/a.css"), "body{}").unwrap();
        fs::write(dir.path().join(".mimenote/cache/index.db"), "db").unwrap();
        fs::write(dir.path().join("gone.md"), "删我").unwrap();
        move_to_trash(&root, "gone.md").unwrap();

        let outcomes = purge_all_trash(&root).unwrap();
        assert_eq!(outcomes.len(), 1);
        assert_eq!(
            fs::read_to_string(dir.path().join("笔记.md")).unwrap(),
            "留着"
        );
        assert_eq!(
            fs::read_to_string(dir.path().join(".mimenote/snippets/a.css")).unwrap(),
            "body{}"
        );
        assert_eq!(
            fs::read_to_string(dir.path().join(".mimenote/cache/index.db")).unwrap(),
            "db"
        );
    }
}
