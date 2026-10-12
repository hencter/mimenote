//! 回收站领域：列出、恢复与永久删除（恢复/永久删除的原语在 `mn-core`，见 ADR-0018）。

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use mn_core::atomic::read_text;
use mn_core::scanner::EntryMeta;
use mn_core::trash::{
    list_trash, purge_all_trash, purge_from_trash, restore_as, restore_from_trash, PurgeFailure,
    PurgeFailureReason, PurgeOutcome, PurgeResult,
};
use mn_core::Error;

use crate::error::IpcError;
use crate::indexer;
use crate::state::AppState;

use super::{ext_of, file_name_of, run_blocking, MAX_READ_BYTES};

// ---------------------------------------------------------------------------
// 回收站（删除之后还能拿回来）
// ---------------------------------------------------------------------------

/// 回收站里的一条：台账记录 + **它现在还在不在**。
///
/// 为什么要多一个 `present`：台账是追加写入的，用户在文件管理器里清理过 `.mimenote/trash`
/// （或者同步盘把它搬走了）之后，台账里仍留着指向不存在文件的记录。界面必须能如实区分
/// "可以恢复"与"东西已经没了"，而不是点下去才报 `NOT_FOUND`。
///
/// 扁平结构（`TrashRecord` 的字段 + 一个 `present`）而不是嵌套：出参要在前端手工镜像，
/// 少一层就少一处能写歪的地方。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    pub id: String,
    pub original_rel_path: String,
    pub stored_rel_path: String,
    pub deleted_at_ms: u64,
    pub size_bytes: u64,
    pub is_dir: bool,
    /// 回收站里那个文件还在不在（`false` = 台账里的孤儿记录，只能从列表里去掉）。
    pub present: bool,
}

/// 列出回收站（按删除时间倒序：最近删的最可能要找回来）。
#[tauri::command]
pub async fn trash_list(state: State<'_, Arc<AppState>>) -> Result<Vec<TrashEntry>, IpcError> {
    let app = Arc::clone(state.inner());
    let entries = run_blocking(move || trash_list_in(&app)).await?;
    Ok(entries)
}

/// [`trash_list`] 的主体（可单测）。
fn trash_list_in(state: &AppState) -> Result<Vec<TrashEntry>, Error> {
    let root = state.vault_root()?;
    let mut entries: Vec<TrashEntry> = list_trash(&root)?
        .into_iter()
        .map(|record| {
            // 台账里有、回收站里没有 = 孤儿记录（用户手工清理过，或同步盘搬走了）
            let present = root
                .resolve_existing(&record.stored_rel_path)
                .map(|path| path.exists())
                .unwrap_or(false);
            TrashEntry {
                id: record.id,
                original_rel_path: record.original_rel_path,
                stored_rel_path: record.stored_rel_path,
                deleted_at_ms: record.deleted_at_ms,
                size_bytes: record.size_bytes,
                is_dir: record.is_dir,
                present,
            }
        })
        .collect();
    // 最近删的排最前（`Reverse` 让"降序"写成一次 key 提取，而不是比较器里手工调换两侧）
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.deleted_at_ms));
    Ok(entries)
}

/// 把回收站里的一条恢复回来。
///
/// 不传 `target_rel_path` 时恢复到**当初的位置**（[`restore_from_trash`]）；传了就恢复到那个位置
/// （[`restore_as`]，也就是界面上的「恢复为…」—— 原位置已经被别的笔记占用时的出路）。
///
/// **绝不覆盖**：目标位置已经有东西就返回 `ALREADY_EXISTS`，记录与文件都原样留在回收站里
/// （理由见 `mn_core::trash` 的文档：用户可能已经把一篇新笔记写到了那个名字上）。
///
/// 恢复之后的索引与条目表：
///
/// * **单篇**：就地补条目 + `indexer::update_note`，与 `note_create` 是同一条收尾 ——
///   文件树、标签、搜索、图谱立刻一致，不需要重扫；
/// * **整目录**：**不做**逐条猜。一个目录可能带几百个文件，逐个构造 `EntryMeta` 就等于把
///   扫描器的口径抄第二遍（扩展名、忽略规则、大小统计任何一处漂移都是"恢复之后树里少几篇"）。
///   出参里带 `needs_rescan = true`，由前端调既有的静默重扫（`vault_snapshot`）——
///   与外部改动走同一条链路（ADR-0016），代价是一次复用缓存的增量构建。
#[tauri::command]
pub async fn note_restore(
    state: State<'_, Arc<AppState>>,
    id: String,
    target_rel_path: Option<String>,
) -> Result<RestoreSummary, IpcError> {
    let app = Arc::clone(state.inner());
    let summary =
        run_blocking(move || note_restore_in(&app, &id, target_rel_path.as_deref())).await?;
    Ok(summary)
}

/// [`note_restore`] 的主体（可单测）。
fn note_restore_in(
    state: &AppState,
    id: &str,
    target_rel_path: Option<&str>,
) -> Result<RestoreSummary, Error> {
    let root = state.vault_root()?;
    let outcome = match target_rel_path {
        Some(target_rel) => restore_as(&root, id, target_rel)?,
        None => restore_from_trash(&root, id)?,
    };

    let mut needs_rescan = false;
    if outcome.record.is_dir {
        // 目录：让扫描器说话（见上面的文档）
        needs_rescan = true;
    } else if let Some((entry, text)) = read_restored_entry(state, &outcome.restored_rel_path) {
        state.update_vault(|ctx| ctx.upsert(entry));
        indexer::update_note(state, &outcome.restored_rel_path, &text);
    } else {
        // 读回来失败（刚好被别的程序删掉/锁住）：文件确实已经搬回来了，索引下一轮会补
        needs_rescan = true;
    }

    log::info!(
        "从回收站恢复：{} → {}（{}）",
        outcome.record.stored_rel_path,
        outcome.restored_rel_path,
        if outcome.is_original_place() {
            "原位置"
        } else {
            "指定位置"
        }
    );

    Ok(RestoreSummary {
        id: outcome.record.id.clone(),
        original_rel_path: outcome.record.original_rel_path.clone(),
        restored_rel_path: outcome.restored_rel_path.clone(),
        is_dir: outcome.record.is_dir,
        created_dirs: outcome.created_dirs.clone(),
        restored_to_original_place: outcome.is_original_place(),
        needs_rescan,
    })
}

/// 读取刚恢复回来的那一篇，给出条目表要的形状。
///
/// 与扫描器同一份口径的字段（`name`/`ext`/`size`/`mtime`）直接取自文件系统；
/// 读不到（被删、不可读、太大）时返回 `None` —— 调用方据此退回重扫。
fn read_restored_entry(state: &AppState, rel_path: &str) -> Option<(EntryMeta, String)> {
    let root = state.with_vault(|ctx| Ok(ctx.root.clone())).ok()?;
    let path = root.resolve_existing(rel_path).ok()?;
    let meta = std::fs::symlink_metadata(&path).ok()?;
    if meta.is_dir() {
        return None;
    }
    let text = read_text(&path, MAX_READ_BYTES).ok()?;
    let entry = EntryMeta {
        rel_path: rel_path.replace('\\', "/"),
        name: file_name_of(rel_path),
        is_dir: false,
        size_bytes: meta.len(),
        mtime_ms: mn_core::atomic::mtime_ms(&meta),
        ext: ext_of(rel_path),
    };
    Some((entry, text))
}

/// 永久删除回收站里的**一条**。必须 `confirm = true`。
///
/// 与 [`note_delete`](super::notes::note_delete) 的 `confirm` 同一条思路：把"用户按下的那一下"
/// 变成契约上的一等公民，而不是指望每一处调用方都记得先弹确认框。
///
/// **不可逆**：这一步真的 `unlink`/`remove_dir_all`，之后再没有别的入口能把东西找回来。
/// 因此安全边界全部落在这里：
///
/// * **逐条重新校验台账**：不接受"列表里看过了所以可信"。台账是磁盘上的普通 JSONL，
///   手改一行就能让它指向 Vault 里任何文件 —— 判定与恢复共用 `mn-core` 的
///   `stored_path_under_trash` + `path_guard`（绝对路径、`..`、盘符、保留名、符号链接逃逸全拒）；
/// * **只删 `.mimenote/trash` 之下的东西**：管理目录里的 cache / snippets / 配置一概不碰；
/// * 被拒的那一条**不进"失败即抛错"**那条路，而是如实进 `failed`，台账记录也原样留着
///   （见 [`PurgeSummary`] 的字段说明）—— 一次点一条的入口要能让用户看见"为什么这条没清掉"。
#[tauri::command]
pub async fn trash_delete(
    state: State<'_, Arc<AppState>>,
    id: String,
    confirm: bool,
) -> Result<PurgeSummary, IpcError> {
    require_purge_confirm(confirm)?;
    let app = Arc::clone(state.inner());
    // 出参里没有 id（见 `PurgeSummary` 的文档），但日志要指明"删的是哪一条"——
    // 所以这里留一份副本给日志，而不是把它塞进 DTO
    let logged_id = id.clone();
    let summary = run_blocking(move || trash_delete_in(&app, &id)).await?;
    log::info!(
        "永久删除回收站条目 {}：删除 {} 项、清理 {} 条孤儿记录、释放 {} 字节、{} 条被拒或失败",
        logged_id,
        summary.removed.len(),
        summary.missing.len(),
        summary.bytes_freed,
        summary.failed.len()
    );
    Ok(summary)
}

/// **清空回收站**：对当前台账里的**所有**条目执行与 [`trash_delete`] 同一套逐条逻辑。
///
/// 台账在 `mn-core` 里读一次（`purge_all_trash`）：用户刚刚确认的是"此刻列表上这些东西"，
/// 再删进来一条却顺手把它也永久删掉，就超出了他按下的那一下。
/// 一条失败**不中断整批**（逐条记结果），每一条都在 `failed` 里如实说明。
#[tauri::command]
pub async fn trash_empty(
    state: State<'_, Arc<AppState>>,
    confirm: bool,
) -> Result<PurgeSummary, IpcError> {
    require_purge_confirm(confirm)?;
    let app = Arc::clone(state.inner());
    let summary = run_blocking(move || trash_empty_in(&app)).await?;
    log::info!(
        "清空回收站：删除 {} 项、清理 {} 条孤儿记录、释放 {} 字节、{} 条被拒或失败",
        summary.removed.len(),
        summary.missing.len(),
        summary.bytes_freed,
        summary.failed.len()
    );
    Ok(summary)
}

/// 永久删除的 `confirm` 闸门（与 `note_delete` 同一处判定，单测能直接撞它）。
///
/// 抽成函数是为了**能测**：`#[tauri::command]` 那两个函数拿不到可构造的 `State`，
/// 而这个"少了 `confirm = true` 就一律拒绝"的契约必须有真实用例钉住 ——
/// 它是"永久删除"唯一挡住"某个调用方忘了弹确认框"的东西。
fn require_purge_confirm(confirm: bool) -> Result<(), Error> {
    if confirm {
        Ok(())
    } else {
        Err(Error::ConfirmationRequired)
    }
}

/// [`trash_delete`] 的主体（可单测）。
fn trash_delete_in(state: &AppState, id: &str) -> Result<PurgeSummary, Error> {
    let root = state.vault_root()?;
    let outcome = purge_from_trash(&root, id)?;
    Ok(purge_summary_in(std::iter::once(outcome)))
}

/// [`trash_empty`] 的主体（可单测）。
fn trash_empty_in(state: &AppState) -> Result<PurgeSummary, Error> {
    let root = state.vault_root()?;
    Ok(purge_summary_in(purge_all_trash(&root)?.into_iter()))
}

/// 把逐条结果折成出参（见 [`PurgeSummary`] 每个字段的语义）。
fn purge_summary_in(outcomes: impl Iterator<Item = PurgeOutcome>) -> PurgeSummary {
    let mut summary = PurgeSummary::default();
    for outcome in outcomes {
        let id = outcome.record.id.clone();
        match outcome.result {
            PurgeResult::Removed { bytes_freed } => {
                summary.bytes_freed += bytes_freed;
                summary.removed.push(id);
            }
            // 台账里有、回收站里没有：**算清理成功**（用户要的就是"别再占着列表"），
            // 只是不计入释放的字节 —— 没有一个字节是我们释放的
            PurgeResult::AlreadyGone => summary.missing.push(id),
            PurgeResult::Failed(failure) => summary.failed.push(purge_failure(&failure)),
        }
    }
    summary
}

/// 一条永久删除失败的记录 → 出参形状。
///
/// 刻意**不带** `storedRelPath`：那是台账（磁盘上可手改的文件）里的一段字符串，而它是
/// 我们唯一**不信任**的输入。界面要认出"是哪一行"用 `id` 即可（列表里那行还在，
/// 因为被拒的记录不许从台账里去掉），具体原因在 `message` 里原样带出。
fn purge_failure(failure: &PurgeFailure) -> PurgeFailureDto {
    PurgeFailureDto {
        id: failure.id.clone(),
        original_rel_path: failure.original_rel_path.clone(),
        reason: PurgeSkipReason::of(failure.reason),
        message: failure.message.clone(),
    }
}

/// 永久删除的出参：**逐条如实汇报**，而不是"成功 / 失败"两态。
///
/// 为什么不做成 `Result<()>`：一次清空可能碰上几十条处境不同的记录（其中还有被拒的）。
/// 把"部分成功"折叠成一个 `Ok` 或一个错误码，界面就再也说不出"删了 12 项、释放了 3.4 MB、
/// 有 1 条记录指向回收站之外所以没敢动"。
///
/// 四个字段的语义（`removed` 与 `missing` 分开，是因为它们对用户是**两件事**）：
///
/// * `removed`：真的从磁盘上删掉的条目 ID（文件或整棵目录树）；
/// * `missing`：台账里有、`.mimenote/trash` 里已经没有的条目 ID（孤儿记录）——
///   这一次只把那条台账记录清掉了，**没有释放任何空间**（`bytesFreed` 不含它们）；
/// * `failed`：**没有执行**的条目（校验不过或删不动），连同稳定原因与原话；
///   这些记录的台账条目**原样留着**，用户还能在列表里看见它们；
/// * `bytes_freed`：本次实际释放的字节数，只累计 `removed` 里那些条目的实测大小。
///
/// 没有 `needsRescan`：删的只是 `.mimenote/trash` 里的东西，它本来就不在扫描范围
/// （`.mimenote/` 被扫描器忽略），条目表与索引不受影响。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeSummary {
    /// 真的从磁盘上删掉的条目 ID。
    pub removed: Vec<String>,
    /// 台账里有、回收站里已经没有（孤儿记录）的条目 ID —— 只清了台账记录。
    pub missing: Vec<String>,
    /// 没有执行的那些条目（校验不过或删不动）；台账记录原样留着。
    pub failed: Vec<PurgeFailureDto>,
    /// 本次实际释放的字节数（只含 `removed` 里的条目）。
    pub bytes_freed: u64,
}

/// 一条被拒绝/删不动的条目。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeFailureDto {
    /// 台账记录的 ID（界面据此认出列表里的哪一行）。
    pub id: String,
    /// 它当初被删的位置（界面按这个称呼它）。
    pub original_rel_path: String,
    /// 稳定原因（界面按它给出一句人话）。
    pub reason: PurgeSkipReason,
    /// 具体原因（`mn-core` / 文件系统的原话）。
    pub message: String,
}

/// 永久删除被跳过的**稳定原因**（`mn_core::trash::PurgeFailureReason` 的镜像）。
///
/// 与 `TagSkipReason` 同一套形态：字符串枚举而不是错误码 —— 一次批量操作里每条记录的
/// 处境不同，用错误码表达等于把"哪几条没成"折叠成"整批失败"。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PurgeSkipReason {
    /// 台账那条记录指向的不是 `.mimenote/trash` 之下的条目。
    PathInvalid,
    /// 解析出来的路径越出了 Vault（`..`、符号链接逃逸）—— `path_guard` 拒绝。
    PathEscape,
    /// 校验通过，但删除失败（权限、被占用、IO 错误）。
    Io,
}

impl PurgeSkipReason {
    /// `mn-core` 的原因 → 出参的原因。
    ///
    /// 这一处映射是**唯一**把两侧接起来的地方：多一个变体就会在这里编译失败，
    /// 而不是悄悄漏到界面上变成一句"未知原因"。
    fn of(reason: PurgeFailureReason) -> Self {
        match reason {
            PurgeFailureReason::PathInvalid => Self::PathInvalid,
            PurgeFailureReason::PathEscape => Self::PathEscape,
            PurgeFailureReason::Io => Self::Io,
        }
    }
}

/// [`note_restore`] 的出参（`RestoreOutcome` 里那部分台账细节不必给前端看）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSummary {
    pub id: String,
    pub original_rel_path: String,
    pub restored_rel_path: String,
    pub is_dir: bool,
    /// 为了放回它新建了哪些目录（自浅到深）—— 界面要能说清"顺手建了 2 个目录"。
    pub created_dirs: Vec<String>,
    pub restored_to_original_place: bool,
    /// 前端收到 `true` 时要调一次静默重扫（目录恢复，或读回单篇失败时的兜底）。
    pub needs_rescan: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::testkit::*;
    use mn_core::trash::move_to_trash;

    // -- 回收站（trash_list / note_restore）------------------------------------
    #[test]
    fn trash_list_reports_records_whose_file_is_gone() {
        let (dir, state) = state_with(&[("笔记/甲.md", "# 甲\n")]);
        let root = state.vault_root().unwrap();
        let record = move_to_trash(&root, "笔记/甲.md").unwrap();

        let entries = trash_list_in(&state).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, record.id);
        assert!(entries[0].present, "刚删进回收站，文件当然在");
        assert_eq!(entries[0].original_rel_path, "笔记/甲.md");
        assert!(!entries[0].is_dir);

        // 用户在文件管理器里清掉了回收站：台账还在，但东西没了 —— 界面要能如实区分
        let stored = dir.path().join(
            record
                .stored_rel_path
                .replace('/', std::path::MAIN_SEPARATOR_STR),
        );
        std::fs::remove_file(&stored).unwrap();

        let entries = trash_list_in(&state).unwrap();
        assert_eq!(
            entries.len(),
            1,
            "孤儿记录仍然要列出来（用户可以据此知道发生了什么）"
        );
        assert!(!entries[0].present, "东西没了就必须说没了");
    }

    #[test]
    fn trash_list_is_sorted_by_deletion_time_desc() {
        let (_dir, state) = state_with(&[("a.md", "a"), ("b.md", "b")]);
        let root = state.vault_root().unwrap();
        let first = move_to_trash(&root, "a.md").unwrap();
        let second = move_to_trash(&root, "b.md").unwrap();

        let entries = trash_list_in(&state).unwrap();
        assert_eq!(entries.len(), 2);
        // 最近删的排最前（`deleted_at_ms` 可能同毫秒，所以只断言"第二新的不早于第一旧的"）
        assert!(entries[0].deleted_at_ms >= entries[1].deleted_at_ms);
        assert!(
            entries.iter().any(|entry| entry.id == first.id)
                && entries.iter().any(|entry| entry.id == second.id)
        );
    }

    #[test]
    fn restore_puts_the_note_back_and_syncs_tree_and_index() {
        let (dir, state) = state_with(&[
            ("笔记/甲.md", "# 甲\n\n#标签甲 与 [[乙]]\n"),
            ("笔记/乙.md", "# 乙\n"),
        ]);
        let root = state.vault_root().unwrap();
        let record = move_to_trash(&root, "笔记/甲.md").unwrap();
        // 删除之后条目与索引里都不该有它（`note_delete` 的收尾）
        state.update_vault(|ctx| ctx.remove("笔记/甲.md"));
        indexer::remove_note(&state, "笔记/甲.md");

        let summary = note_restore_in(&state, &record.id, None).unwrap();
        assert_eq!(summary.restored_rel_path, "笔记/甲.md");
        assert!(summary.restored_to_original_place);
        assert!(!summary.is_dir);
        assert!(!summary.needs_rescan, "单篇恢复要就地同步，不需要重扫");
        assert!(summary.created_dirs.is_empty());

        // 磁盘、条目表、索引（标签）三处都要回来
        assert_eq!(
            read_file(dir.path(), "笔记/甲.md"),
            "# 甲\n\n#标签甲 与 [[乙]]\n"
        );
        assert!(state
            .with_vault(|ctx| Ok(ctx.entries.contains_key("笔记/甲.md")))
            .unwrap());
        let tags = indexer::tags_of(&state, "笔记/甲.md").unwrap_or_default();
        assert!(
            tags.iter().any(|tag| tag.tag == "标签甲"),
            "恢复之后标签索引要认识这篇（否则标签面板与图谱还是缺一块）"
        );
        // 台账里不该再有它
        assert!(trash_list_in(&state).unwrap().is_empty());
    }

    #[test]
    fn restore_refuses_to_overwrite_and_keeps_the_record() {
        let (dir, state) = state_with(&[("a.md", "旧内容")]);
        let root = state.vault_root().unwrap();
        let record = move_to_trash(&root, "a.md").unwrap();
        // 用户已经把一篇新笔记写到了同一个名字上
        std::fs::write(dir.path().join("a.md"), "新内容").unwrap();

        let error = note_restore_in(&state, &record.id, None).unwrap_err();
        assert_eq!(error.code(), mn_core::ErrorCode::AlreadyExists);
        assert_eq!(read_file(dir.path(), "a.md"), "新内容", "绝不覆盖占位者");
        assert_eq!(
            trash_list_in(&state).unwrap().len(),
            1,
            "失败之后记录要留着，让用户换名字再来"
        );

        // 出路：「恢复为…」
        let summary = note_restore_in(&state, &record.id, Some("恢复/a.md")).unwrap();
        assert_eq!(summary.restored_rel_path, "恢复/a.md");
        assert!(!summary.restored_to_original_place);
        assert_eq!(summary.created_dirs, vec!["恢复".to_string()]);
        assert_eq!(read_file(dir.path(), "恢复/a.md"), "旧内容");
        assert_eq!(
            read_file(dir.path(), "a.md"),
            "新内容",
            "占位者仍然原样不动"
        );
    }

    #[test]
    fn restoring_a_directory_asks_the_caller_to_rescan() {
        let (dir, state) = state_with(&[("folder/a.md", "a\n"), ("folder/sub/b.md", "b\n")]);
        let root = state.vault_root().unwrap();
        let record = move_to_trash(&root, "folder").unwrap();
        assert!(record.is_dir);

        let summary = note_restore_in(&state, &record.id, None).unwrap();
        assert!(summary.is_dir);
        assert!(
            summary.needs_rescan,
            "目录恢复要交给扫描器：逐条猜 EntryMeta 会把扫描口径抄第二遍"
        );
        assert_eq!(read_file(dir.path(), "folder/sub/b.md"), "b\n");
    }

    #[test]
    fn restoring_an_unknown_id_is_not_found() {
        let (_dir, state) = state_with(&[("a.md", "a")]);
        assert_eq!(
            note_restore_in(&state, "不存在的-id", None)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::NotFound
        );
    }

    // -- 永久删除与清空（trash_delete / trash_empty）----------------------------

    #[test]
    fn purge_delete_removes_the_file_from_disk_and_clears_the_entry() {
        let (dir, state) = state_with(&[("笔记/甲.md", "# 甲\n")]);
        let root = state.vault_root().unwrap();
        let record = move_to_trash(&root, "笔记/甲.md").unwrap();
        let stored = dir.path().join(
            record
                .stored_rel_path
                .replace('/', std::path::MAIN_SEPARATOR_STR),
        );
        assert!(stored.exists());

        let summary = trash_delete_in(&state, &record.id).unwrap();
        assert_eq!(summary.removed, vec![record.id.clone()]);
        assert!(summary.missing.is_empty());
        assert!(summary.failed.is_empty());
        assert!(summary.bytes_freed > 0, "释放的字节数要如实报出来");
        assert!(!stored.exists(), "磁盘上真的没有了");
        assert!(
            trash_list_in(&state).unwrap().is_empty(),
            "列表里也不该再有它"
        );
    }

    #[test]
    fn purge_delete_of_an_orphan_record_only_clears_the_entry() {
        // 孤儿记录（用户在文件管理器里清过回收站）：这一步只清台账，
        // 界面要能据此说"清掉了 1 条记录，没有释放空间"
        let (dir, state) = state_with(&[("笔记/甲.md", "# 甲\n")]);
        let root = state.vault_root().unwrap();
        let record = move_to_trash(&root, "笔记/甲.md").unwrap();
        std::fs::remove_file(
            dir.path().join(
                record
                    .stored_rel_path
                    .replace('/', std::path::MAIN_SEPARATOR_STR),
            ),
        )
        .unwrap();

        let summary = trash_delete_in(&state, &record.id).unwrap();
        assert!(summary.removed.is_empty());
        assert_eq!(summary.missing, vec![record.id.clone()]);
        assert_eq!(summary.bytes_freed, 0, "没有释放任何空间");
        assert!(trash_list_in(&state).unwrap().is_empty());
    }

    #[test]
    fn purge_delete_rejects_a_tampered_ledger_entry() {
        // 台账是磁盘上的普通 JSONL：手改一行就能让它指向 Vault 里的笔记。
        // 这条断言"永久删除"不会变成任意文件删除原语 —— 而且凭据要说清为什么没删。
        let (dir, state) = state_with(&[("重要.md", "不能删"), ("别的.md", "别的")]);
        let root = state.vault_root().unwrap();
        let record = move_to_trash(&root, "别的.md").unwrap();

        let index = dir.path().join(".mimenote/index.jsonl");
        let tampered = format!(
            "{}\n",
            serde_json::to_string(&mn_core::trash::TrashRecord {
                stored_rel_path: "重要.md".to_string(),
                ..record.clone()
            })
            .unwrap()
        );
        mn_core::atomic::write_atomic(&index, tampered.as_bytes()).unwrap();

        let summary = trash_delete_in(&state, &record.id).unwrap();
        assert!(summary.removed.is_empty());
        assert_eq!(summary.failed.len(), 1);
        assert_eq!(summary.failed[0].id, record.id);
        assert_eq!(summary.failed[0].original_rel_path, "别的.md");
        assert!(matches!(
            summary.failed[0].reason,
            PurgeSkipReason::PathInvalid | PurgeSkipReason::PathEscape
        ));
        assert_eq!(
            read_file(dir.path(), "重要.md"),
            "不能删",
            "一个字节都不能少"
        );
        assert_eq!(
            trash_list_in(&state).unwrap().len(),
            1,
            "被拒的记录要留着，用户还能看见它"
        );
    }

    #[test]
    fn purge_empty_removes_everything_and_reports_each_one() {
        let (dir, state) = state_with(&[("a.md", "aaa"), ("folder/b.md", "bb"), ("c.md", "c")]);
        let root = state.vault_root().unwrap();
        let first = move_to_trash(&root, "a.md").unwrap();
        let folder = move_to_trash(&root, "folder").unwrap();
        let orphan = move_to_trash(&root, "c.md").unwrap();
        // 其中一条变成孤儿记录：清空要**照常**把它的台账记录也清掉
        std::fs::remove_file(
            dir.path().join(
                orphan
                    .stored_rel_path
                    .replace('/', std::path::MAIN_SEPARATOR_STR),
            ),
        )
        .unwrap();

        let summary = trash_empty_in(&state).unwrap();
        assert_eq!(summary.removed.len(), 2, "两份真文件（一篇 + 一棵目录）");
        assert!(summary.removed.contains(&first.id));
        assert!(summary.removed.contains(&folder.id));
        assert_eq!(summary.missing, vec![orphan.id.clone()]);
        assert!(summary.failed.is_empty());
        assert_eq!(summary.bytes_freed, 3 + 2, "只算真删掉的那些");
        assert!(trash_list_in(&state).unwrap().is_empty());
        assert_eq!(
            std::fs::read_dir(dir.path().join(".mimenote/trash"))
                .unwrap()
                .count(),
            0
        );
        assert!(
            dir.path().join(".mimenote").exists(),
            "只清回收站，管理目录本身不许动"
        );
    }

    #[test]
    fn purge_requires_an_explicit_confirmation() {
        // 缺了 confirm = true 一律拒绝：这是"某个调用方忘了弹确认框"的唯一兜底
        assert_eq!(
            require_purge_confirm(false).unwrap_err().code(),
            mn_core::ErrorCode::ConfirmationRequired
        );
        assert!(require_purge_confirm(true).is_ok());
    }

    #[test]
    fn purging_an_unknown_id_is_not_found_and_changes_nothing() {
        let (dir, state) = state_with(&[("a.md", "a")]);
        let root = state.vault_root().unwrap();
        let record = move_to_trash(&root, "a.md").unwrap();

        assert_eq!(
            trash_delete_in(&state, "不存在的-id").unwrap_err().code(),
            mn_core::ErrorCode::NotFound
        );
        // 那条真实的记录与它的文件都原样还在
        assert!(dir
            .path()
            .join(
                record
                    .stored_rel_path
                    .replace('/', std::path::MAIN_SEPARATOR_STR)
            )
            .exists());
        assert_eq!(trash_list_in(&state).unwrap().len(), 1);
    }
}
