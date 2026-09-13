//! 后台链接索引：构建、增量更新、进度上报。
//!
//! 三条纪律：
//!
//! 1. **绝不在主线程构建**：1 万篇笔记的解析是秒级操作，必须放后台线程，
//!    否则冷启动预算（≤1.5s）立刻爆掉；
//! 2. **可取消**：用户切换 Vault / 关闭应用时，正在跑的构建要能停下来；
//! 3. **增量优先**：保存/新建/删除只更新受影响的文件，不重扫全库。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use mn_core::scanner::EntryMeta;
use mn_core::VaultRoot;
use mn_index::{build_index, BuildOptions, IndexStats, NoteLinks};

use crate::state::AppState;

/// 索引进度事件名（前端监听）。
pub const INDEX_STATUS_EVENT: &str = "mn://index-status";

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
    state.set_index_status(IndexStatus::default());
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
        let (index, outcome) = build_index(
            root.path(),
            &entries_for_task,
            &BuildOptions::default(),
            Some(&cancel_flag),
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
            "链接索引{}：{} 篇 / {} 条链接（解析 {}，悬空 {}，歧义 {}），耗时 {}ms，跳过 {}",
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
            outcome.duration_ms,
            outcome.skipped
        );
    });
}

/// 保存/新建笔记后增量更新。
pub fn update_note(state: &AppState, rel_path: &str, text: &str) {
    if state.is_open() {
        state.index_write().upsert(rel_path, text);
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
}

/// 查询某篇笔记的出链与反向链接（重活，调用方负责放到后台线程）。
pub fn note_links(state: &AppState, rel_path: &str) -> NoteLinks {
    state.index_write().note_links(rel_path)
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
