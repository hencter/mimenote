//! Vault 领域：打开 / 概要 / 快照 / 关闭 / 启动参数。
//!
//! 宿主只做会话状态与参数映射：路径校验与扫描在 `mn-core`，索引起步在 `indexer`。

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, State};

use mn_core::scanner::{scan, EntryMeta, ScanOptions};
use mn_core::VaultRoot;

use crate::error::IpcError;
use crate::indexer;
use crate::state::{AppState, VaultCtx};

use super::run_blocking;

/// Vault 概要信息。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    /// 面向用户展示的绝对根路径。
    pub root_path: String,
    /// Vault 目录名。
    pub name: String,
    /// 条目总数（含目录）。
    pub entry_count: usize,
    /// Markdown 笔记数。
    pub note_count: usize,
    /// 目录数。
    pub folder_count: usize,
    /// 是否因条目上限而截断。
    pub truncated: bool,
    /// 因权限等原因被跳过的条目数。
    pub skipped: usize,
    /// 本次扫描耗时（毫秒）。
    pub scan_ms: u64,
}

/// 完整的扁平条目表（仅在打开/重扫时下发）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSnapshot {
    pub root_path: String,
    /// Vault 目录名。
    pub name: String,
    pub entries: Vec<EntryMeta>,
    pub note_count: usize,
    pub folder_count: usize,
    pub truncated: bool,
    /// 因权限等原因被跳过的条目数。
    pub skipped: usize,
    pub scan_ms: u64,
    pub generated_at_ms: u64,
}

// ---------------------------------------------------------------------------
// Vault 生命周期
// ---------------------------------------------------------------------------

/// 打开 Vault：校验路径 → 扫描 → 缓存快照。
///
/// **一次调用同时返回概要信息与完整条目表**：避免"先 open 再 snapshot"造成二次全量扫描
/// （1 万笔记下这是 800ms 级别的浪费，见 architecture.md §3.2）。
#[tauri::command]
pub async fn vault_open(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    path: String,
) -> Result<VaultSnapshot, IpcError> {
    let (root, options, report) = run_blocking(move || {
        let root = VaultRoot::open(&path)?;
        let options = ScanOptions::default();
        let report = scan(root.path(), &options)?;
        Ok((root, options, report))
    })
    .await?;

    let snapshot = snapshot_from(&root, &report);

    log::info!(
        "打开 Vault：{}（{} 条目 / {} 笔记 / {} 目录，扫描 {}ms，跳过 {}）",
        snapshot.root_path,
        snapshot.entries.len(),
        snapshot.note_count,
        snapshot.folder_count,
        snapshot.scan_ms,
        snapshot.skipped
    );

    // 索引是缓存：先清空，再在后台线程重建（不阻塞打开 Vault 的返回）
    let entries_for_index = report.entries.clone();
    let root_for_index = root.clone();
    state.set_vault(VaultCtx::new(root, options, report));
    indexer::reset(&state);
    indexer::spawn_build(
        Arc::clone(state.inner()),
        app,
        root_for_index,
        entries_for_index,
    );

    Ok(snapshot)
}

/// 当前会话的 Vault 概要（不重扫；未打开返回 `null`）。
#[tauri::command]
pub fn vault_info(state: State<'_, Arc<AppState>>) -> Result<Option<VaultInfo>, IpcError> {
    if !state.is_open() {
        return Ok(None);
    }
    let info = state.with_vault(|ctx| {
        Ok(VaultInfo {
            root_path: ctx.root.display(),
            name: ctx.root.name(),
            entry_count: ctx.entries.len(),
            note_count: ctx.note_count,
            folder_count: ctx.folder_count,
            truncated: ctx.truncated,
            skipped: ctx.skipped,
            scan_ms: ctx.scan_ms,
        })
    })?;
    Ok(Some(info))
}

/// 重新扫描（用户在外部增删了大量文件时使用）。
#[tauri::command]
pub async fn vault_snapshot(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<VaultSnapshot, IpcError> {
    let root = state.vault_root()?;
    let options = state.with_vault(|ctx| Ok(ctx.options.clone()))?;
    let scan_options = options.clone();
    let scan_root = root.clone();
    let report = run_blocking(move || scan(scan_root.path(), &scan_options)).await?;

    let snapshot = snapshot_from(&root, &report);
    let entries_for_index = report.entries.clone();
    let root_for_index = root.clone();
    state.set_vault(VaultCtx::new(root, options, report));
    // 文件可能在外部被大量改动，索引整轮重建（同样在后台）
    indexer::reset(&state);
    indexer::spawn_build(
        Arc::clone(state.inner()),
        app,
        root_for_index,
        entries_for_index,
    );
    log::info!(
        "重扫完成：{} 条目（{}ms）",
        snapshot.entries.len(),
        snapshot.scan_ms
    );
    Ok(snapshot)
}

/// 关闭 Vault（保留窗口，回到选择界面）。
#[tauri::command]
pub fn vault_close(state: State<'_, Arc<AppState>>) -> Result<(), IpcError> {
    indexer::reset(&state);
    state.clear_vault();
    log::info!("已关闭 Vault");
    Ok(())
}

/// 命令行指定的 Vault 路径（`mimenote.exe <目录>`）。
///
/// 前端在启动时优先打开它；返回 `null` 表示没有（例如双击启动），
/// 此时回退到"上次打开的 Vault"。
#[tauri::command]
pub fn startup_vault(state: State<'_, Arc<AppState>>) -> Option<String> {
    state.startup_vault().map(|path| path.to_string())
}

fn snapshot_from(root: &VaultRoot, report: &mn_core::scanner::ScanReport) -> VaultSnapshot {
    VaultSnapshot {
        root_path: root.display(),
        name: root.name(),
        entries: report.entries.clone(),
        note_count: report.note_count,
        folder_count: report.folder_count,
        truncated: report.truncated,
        skipped: report.skipped,
        scan_ms: report.scan_ms,
        generated_at_ms: mn_core::atomic::now_ms(),
    }
}
