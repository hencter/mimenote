//! Mimenote 桌面宿主。
//!
//! 这一层**只做三件事**（见 `docs/architecture.md` §2）：
//!
//! 1. 持有会话状态（[`state::AppState`]）；
//! 2. 把 `mn-core` 的能力暴露成 IPC 命令（[`commands`]）；
//! 3. 把 `mn-core` 错误映射成**稳定错误码**（[`error::IpcError`]）。
//!
//! 业务逻辑一律放在 `mn-core`，本层不做判断、不做遍历、不做拼接路径。

pub mod commands;
pub mod error;
pub mod indexer;
pub mod logging;
pub mod startup;
pub mod state;

use std::sync::Arc;

use state::AppState;

/// 启动应用。
pub fn run() {
    let startup_vault = startup::resolve(&std::env::args().collect::<Vec<_>>());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(AppState::with_startup_vault(
            startup_vault.path_for_frontend(),
        )))
        .invoke_handler(tauri::generate_handler![
            commands::vault_open,
            commands::vault_info,
            commands::vault_snapshot,
            commands::vault_close,
            commands::note_read,
            commands::note_write,
            commands::note_create,
            commands::note_rename,
            commands::note_delete,
            commands::note_stats,
            commands::index_status,
            commands::note_links,
            commands::note_tags,
            commands::tags_list,
            commands::tag_notes,
            commands::snippets_list,
            commands::startup_vault,
            commands::version_info,
        ])
        .setup(move |app| {
            // 日志必须在 setup 里初始化：此时才能解析用户的日志目录
            let log_path = logging::init(app.handle());
            log::info!(
                "Mimenote {} 启动（mn-core {}，离线模式：无遥测、无出站请求）",
                env!("CARGO_PKG_VERSION"),
                mn_core::VERSION
            );
            if let Some(path) = log_path {
                log::info!("日志文件：{}", path.display());
            }
            startup_vault.log();
            log::debug!("窗口已创建，等待前端请求 vault_open");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}
