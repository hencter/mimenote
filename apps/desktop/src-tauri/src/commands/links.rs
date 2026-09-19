//! 链接索引领域：索引进度 / 单篇出链与反向链接（索引本体在 `mn-index` 与 `indexer`）。

use std::sync::Arc;

use tauri::State;

use mn_index::NoteLinks;

use crate::error::IpcError;
use crate::indexer::{self, IndexStatus};
use crate::state::AppState;

use super::run_blocking;

// ---------------------------------------------------------------------------
// 链接索引
// ---------------------------------------------------------------------------

/// 索引进度与概况。
#[tauri::command]
pub fn index_status(state: State<'_, Arc<AppState>>) -> IndexStatus {
    indexer::status(&state)
}

/// 查询某篇笔记的出链与反向链接。
///
/// 反向链接缓存是惰性重建的（可能涉及全库解析），因此放到后台线程执行。
#[tauri::command]
pub async fn note_links(
    state: State<'_, Arc<AppState>>,
    rel_path: String,
) -> Result<NoteLinks, IpcError> {
    let app = Arc::clone(state.inner());
    let rel = rel_path.clone();
    let links: NoteLinks = run_blocking(move || Ok(indexer::note_links(&app, &rel))).await?;
    Ok(links)
}
