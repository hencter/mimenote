//! 后台链接索引：构建、增量更新、进度上报。
//!
//! 三条纪律：
//!
//! 1. **绝不在主线程构建**：1 万篇笔记的解析是秒级操作，必须放后台线程，
//!    否则冷启动预算（≤1.5s）立刻爆掉；
//! 2. **可取消**：用户切换 Vault / 关闭应用时，正在跑的构建要能停下来；
//! 3. **增量优先**：保存/新建/删除只更新受影响的文件，不重扫全库。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use mn_core::scanner::EntryMeta;
use mn_core::tags::TagRef;
use mn_core::VaultRoot;
use mn_index::search::SearchOutcome;
use mn_index::tags::TagSummary;
use mn_index::{build_indexes, BuildOptions, IndexStats, NoteLinks, SearchIndex};

use crate::state::AppState;

/// 索引进度事件名（前端监听）。
pub const INDEX_STATUS_EVENT: &str = "mn://index-status";

/// 全文搜索缓存库的相对位置（派生数据，删掉即可重建，见 ADR-0002）。
pub const SEARCH_CACHE_REL: &str = ".mimenote/cache/search.db";

/// 全文搜索缓存库的绝对路径。
pub fn search_db_path(root: &VaultRoot) -> PathBuf {
    root.path()
        .join(".mimenote")
        .join("cache")
        .join("search.db")
}

/// 索引阶段。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum IndexPhase {
    /// 没有打开 Vault。
    Idle,
    /// 正在后台构建。
    Building,
    /// 已就绪。
    Ready,
    /// 被取消（切换 Vault 或退出）。
    Cancelled,
    /// 构建失败（理论上只会因为 Vault 已关闭）。
    Failed,
}

/// 索引状态（也通过事件推给前端）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub phase: IndexPhase,
    /// 已处理的文件数。
    pub indexed: usize,
    /// 总文件数。
    pub total: usize,
    /// 构建耗时（毫秒；构建中为已用时）。
    pub duration_ms: u64,
    /// 已建立的链接条目数（就绪后有意义）。
    pub links: usize,
}

impl Default for IndexStatus {
    fn default() -> Self {
        Self {
            phase: IndexPhase::Idle,
            indexed: 0,
            total: 0,
            duration_ms: 0,
            links: 0,
        }
    }
}

impl IndexStatus {
    fn building(indexed: usize, total: usize) -> Self {
        Self {
            phase: IndexPhase::Building,
            indexed,
            total,
            duration_ms: 0,
            links: 0,
        }
    }
}

/// 关闭/切换 Vault 时取消正在进行的构建。
pub fn cancel(state: &AppState) {
    state.cancel_index_build();
}

/// 清空索引（打开新 Vault 前调用）。
pub fn reset(state: &AppState) {
    state.cancel_index_build();
    state.clear_index_cancel();
    state.index_write().clear();
    // 搜索索引的连接属于上一个 Vault（甚至已经被删）：整轮重扫时先放下
    state.clear_search();
    state.set_index_status(IndexStatus::default());
}

/// 打开（并整库重建）全文搜索索引；失败时记 warn + 把原因存进状态，返回 `None`。
///
/// **绝不让搜索索引影响主流程**：Vault 只读、磁盘满、缓存库被别的程序占着 —— 这些
/// 都只让搜索功能降级（`search_query` 返回 `IO` 错误并带上原因），
/// 打开 Vault、链接索引、标签全都照常。
fn prepare_search(state: &AppState, root: &VaultRoot) -> Option<SearchIndex> {
    match SearchIndex::open_for_rebuild(&search_db_path(root)) {
        Ok(index) => Some(index),
        Err(error) => {
            log::warn!("全文搜索索引不可用（本轮跳过，功能降级）：{error}");
            state.fail_search(error.to_string());
            None
        }
    }
}

/// 启动后台构建（不阻塞调用方）。
pub fn spawn_build(state: Arc<AppState>, app: AppHandle, root: VaultRoot, entries: Vec<EntryMeta>) {
    // 先取消上一轮（切换 Vault 时可能出现）
    cancel(&state);

    let cancel_flag = Arc::new(AtomicBool::new(false));
    state.set_index_cancel(Some(Arc::clone(&cancel_flag)));

    let entries_for_task = entries.clone();
    let total = entries
        .iter()
        .filter(|entry| !entry.is_dir && is_note_extension(entry))
        .count();
    state.set_index_status(IndexStatus::building(0, total));
    emit(&app, &state.index_status_snapshot());

    tauri::async_runtime::spawn_blocking(move || {
        let last_emitted = std::sync::atomic::AtomicUsize::new(0);
        // 全文搜索：整轮重建（缓存库，删掉即可重建）。拿不到就降级，不阻塞其它索引
        let search = prepare_search(&state, &root);
        let (index, outcome) = build_indexes(
            root.path(),
            &entries_for_task,
            &BuildOptions::default(),
            Some(&cancel_flag),
            search.as_ref(),
            |done, all| {
                // 进度节流：每 200 个文件推一次，避免刷爆前端
                let previous = last_emitted.load(Ordering::Relaxed);
                if done == all || done.saturating_sub(previous) >= 200 {
                    last_emitted.store(done, Ordering::Relaxed);
                    state.set_index_status(IndexStatus {
                        phase: IndexPhase::Building,
                        indexed: done,
                        total: all,
                        duration_ms: 0,
                        links: 0,
                    });
                    emit(&app, &state.index_status_snapshot());
                }
            },
        );

        // 构建结果只在"仍然是同一个 Vault"时采纳（避免旧任务覆盖新 Vault 的索引）
        let still_current = state
            .vault_root()
            .map(|current| current.path() == root.path())
            .unwrap_or(false);

        if !still_current {
            log::debug!("索引构建完成但 Vault 已切换，丢弃结果");
            return;
        }

        // 搜索索引的归属规则与链接索引一致：只有这轮**成功提交**才安装它。
        // 取消（没有 error）时保持"正在构建"——后面还会有一轮完整的构建。
        match outcome.search.as_ref() {
            Some(search_outcome) if !search_outcome.aborted => {
                if let Some(search) = search {
                    state.install_search(search);
                }
            }
            Some(search_outcome) => {
                if let Some(error) = search_outcome.error.as_ref() {
                    state.fail_search(error.clone());
                }
            }
            None => {}
        }

        let stats: IndexStats = {
            let mut guard = state.index_write();
            *guard = index;
            guard.stats()
        };

        let phase = if outcome.cancelled {
            IndexPhase::Cancelled
        } else {
            IndexPhase::Ready
        };
        state.set_index_status(IndexStatus {
            phase,
            indexed: outcome.indexed,
            total: outcome.total,
            duration_ms: outcome.duration_ms,
            links: stats.links,
        });
        emit(&app, &state.index_status_snapshot());

        log::info!(
            "链接索引{}：{} 篇 / {} 条链接（解析 {}，悬空 {}，歧义 {}）/ {} 个标签，耗时 {}ms，跳过 {}",
            if outcome.cancelled {
                "被取消"
            } else {
                "就绪"
            },
            outcome.indexed,
            stats.links,
            stats.resolved,
            stats.unresolved,
            stats.ambiguous,
            stats.tags,
            outcome.duration_ms,
            outcome.skipped
        );

        if let Some(search_outcome) = outcome.search {
            if search_outcome.aborted {
                log::warn!("全文搜索索引本轮未提交（{}ms）", search_outcome.duration_ms);
            } else {
                log::info!(
                    "全文搜索索引就绪：{} 行，耗时 {}ms",
                    search_outcome.lines,
                    search_outcome.duration_ms
                );
            }
        }
    });
}

/// 保存/新建笔记后增量更新。
pub fn update_note(state: &AppState, rel_path: &str, text: &str) {
    if state.is_open() {
        state.index_write().upsert(rel_path, text);
        // 全文搜索：未就绪时静默跳过（下一轮全量构建会把内容补上）
        if let Some(Err(error)) = state.try_search(|search| search.upsert_note(rel_path, text)) {
            log::warn!("全文搜索增量更新失败（{rel_path}）：{error}");
        }
    }
}

/// 删除笔记后增量更新（目录会连同后代一起移除）。
pub fn remove_note(state: &AppState, rel_path: &str) {
    if !state.is_open() {
        return;
    }
    let prefix = format!("{rel_path}/");
    let mut guard = state.index_write();
    let descendants = guard.paths_under(&prefix);
    guard.remove(rel_path);
    for path in descendants {
        guard.remove(&path);
    }
    // 搜索索引按**前缀**删，目录删除也能一次清干净
    if let Some(Err(error)) = state.try_search(|search| search.remove_note(rel_path)) {
        log::warn!("全文搜索删除失败（{rel_path}）：{error}");
    }
}

/// 查询某篇笔记的出链与反向链接（重活，调用方负责放到后台线程）。
pub fn note_links(state: &AppState, rel_path: &str) -> NoteLinks {
    state.index_write().note_links(rel_path)
}

/// 某篇笔记的标签（索引里的权威数据）。
///
/// 返回 `None` 表示**索引里没有这篇笔记**（还在构建、太大被跳过、或不是笔记）——
/// 与"收录了但这篇没有标签"（`Some(vec![])`）是两件事，调用方据此决定要不要现算。
pub fn tags_of(state: &AppState, rel_path: &str) -> Option<Vec<TagRef>> {
    let index = state.index_write();
    index.contains(rel_path).then(|| index.tags_of(rel_path))
}

/// 全库标签概览（`count` 降序 → `key` 升序）。
pub fn tag_summary(state: &AppState) -> Vec<TagSummary> {
    state.index_write().tag_summary()
}

/// 某个标签下的笔记（字典序；`key` 传原始写法也能命中）。
pub fn notes_with_tag(state: &AppState, key: &str) -> Vec<String> {
    state.index_write().notes_with_tag(key)
}

/// 全文搜索（重活，调用方负责放到后台线程）。
///
/// 索引未就绪/不可用时返回 `IO` 错误 —— 交给人看的是**原因**（"正在构建"还是"Vault 只读"），
/// 而不是一个伪装成"没有结果"的空列表。
pub fn search(state: &AppState, query: &str, limit: u32) -> mn_core::Result<SearchOutcome> {
    state.with_search(|index| index.search(query, limit))
}

/// 当前索引状态快照。
pub fn status(state: &AppState) -> IndexStatus {
    state.index_status_snapshot()
}

fn emit(app: &AppHandle, status: &IndexStatus) {
    // 事件只是"通知"，失败不影响索引本身
    if let Err(error) = app.emit(INDEX_STATUS_EVENT, status) {
        log::debug!("索引状态事件发送失败：{error}");
    }
}

fn is_note_extension(entry: &EntryMeta) -> bool {
    entry
        .ext
        .as_deref()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown"))
}
