#![cfg(test)]

//! 领域测试共享的夹具（建临时 Vault / 造会话状态 / 读回磁盘）。
//!
//! 任何领域的用例都只组合这些小工具，不在各自文件里重造一套 —
//! "磁盘上是什么"与"会话里是什么"的搭法只有这一份。

use mn_core::scanner::{scan, ScanOptions};
use mn_core::VaultRoot;
use mn_index::SearchIndex;

use crate::indexer;
use crate::state::{AppState, VaultCtx};

pub(crate) fn setup() -> (tempfile::TempDir, VaultRoot) {
    let dir = tempfile::tempdir().unwrap();
    let root = VaultRoot::open(dir.path()).unwrap();
    std::fs::create_dir_all(dir.path().join("notes")).unwrap();
    (dir, root)
}

pub(crate) fn state_with(files: &[(&str, &str)]) -> (tempfile::TempDir, AppState) {
    let dir = tempfile::tempdir().unwrap();
    for (rel, text) in files {
        let path = dir
            .path()
            .join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&path, text).unwrap();
    }
    let root = VaultRoot::open(dir.path()).unwrap();
    let options = ScanOptions::default();
    let report = scan(root.path(), &options).unwrap();
    let entries = report.entries.clone();
    let (index, _) = mn_index::build_index(
        root.path(),
        &entries,
        &mn_index::BuildOptions::default(),
        None,
        |_done, _total| {},
    );

    let state = AppState::default();
    state.set_vault(VaultCtx::new(root, options, report));
    *state.index_write() = index;
    // 索引阶段：真实链路里 `indexer::spawn_build` 建完会置 `Ready`。
    // `tag_rename` 用"索引是否就绪"回答"候选集能不能信"，所以这里必须如实置一次
    state.set_index_status(indexer::IndexStatus {
        phase: indexer::IndexPhase::Ready,
        indexed: files.len(),
        total: files.len(),
        ..Default::default()
    });

    // 全文搜索索引：与构建路径一样，从同一批文本喂进去（测试用内存库，不留文件）
    let search = SearchIndex::open_in_memory().unwrap();
    search.begin_rebuild().unwrap();
    for (rel, text) in files {
        search.add_note(rel, text).unwrap();
    }
    search.finish_rebuild().unwrap();
    state.install_search(search);
    (dir, state)
}

pub(crate) fn read_file(dir: &std::path::Path, rel: &str) -> String {
    std::fs::read_to_string(dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR))).unwrap()
}

pub(crate) fn owned(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_string()).collect()
}

/// 磁盘上的当前令牌（前端面板拿到的就是这个值，来自 `note_read`）。
///
/// 令牌是**必填**的：这里刻意不给"0 表示不校验"的后门，否则"绝不静默覆盖"就成了摆设。
pub(crate) fn token_of(dir: &std::path::Path, rel: &str) -> u64 {
    let path = dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
    mn_core::atomic::path_mtime_ms(&path).unwrap().unwrap_or(0)
}
