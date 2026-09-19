//! 回收站领域：列出与恢复（恢复原语在 `mn-core`，见 ADR-0017 / ADR-0018）。

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use mn_core::atomic::read_text;
use mn_core::scanner::EntryMeta;
use mn_core::trash::{list_trash, restore_as, restore_from_trash};
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
}
