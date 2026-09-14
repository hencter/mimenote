//! Mimenote 桌面宿主。
//!
//! 这一层**只做三件事**（见 `docs/architecture.md` §2）：
//!
//! 1. 持有会话状态（[`state::AppState`]）；
//! 2. 把 `mn-core` 的能力暴露成 IPC 命令（[`commands`]）；
//! 3. 把 `mn-core` 错误映射成**稳定错误码**（[`error::IpcError`]）。
//!
//! 业务逻辑一律放在 `mn-core`，本层不做判断、不做遍历、不做拼接路径。

pub mod assets;
pub mod attachments;
pub mod commands;
pub mod error;
pub mod export;
pub mod indexer;
pub mod logging;
pub mod startup;
pub mod state;
pub mod watcher;

use std::sync::Arc;

use tauri::Manager;

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
            // 标签面板的写入口：与 note_write 同一把写锁 + 同一份 mtime 令牌 + 同一个原子写，
            // 只多一步"在区块里按最小 diff 改 tags"（见 commands.rs 的 note_set_tags 文档）
            commands::note_set_tags,
            // 标签重命名 / 合并：全库改写 frontmatter **与正文行内**标签。
            // 候选集来自标签索引，逐篇走同一个原子写 + 同一处索引增量同步，
            // 且逐篇如实汇报"改了 / 跳过了（为什么）"（见 commands.rs 的 tag_rename 文档）
            commands::tag_rename,
            // 层级编辑（把 `甲` 挂到 `父` 下 / 提回顶层）：内部复用 tag_rename 那条写路径
            commands::tag_move,
            commands::note_create,
            commands::note_rename,
            // 跨目录移动（拖拽整理 / 「移动到…」）：与重命名共用同一条"换位置 + 改写全库链接"链路
            commands::note_move,
            // 目录搬迁：整棵子树一起换路径 + 改写全库指向子树里每一篇的链接。
            // 与单篇搬迁共用同一份候选集/span 改写机制（`mn_index::dir_move`），
            // 出参也复用 `RenameOutcome` —— 前端只多一处"替换整棵子树"的状态收尾
            commands::dir_rename,
            commands::dir_move,
            commands::note_delete,
            // 回收站：列出与恢复（恢复原语在 `mn-core`，见 ADR-0017）
            commands::trash_list,
            commands::note_restore,
            commands::note_stats,
            commands::index_status,
            commands::note_links,
            commands::graph_data,
            commands::note_tags,
            commands::tags_list,
            commands::tag_notes,
            // 组合过滤（含任意一个 / 不含任何一个，可带后代）：文件树的标签过滤走它，
            // 一次往返算完 —— 前端逐个标签问会变成 N 次 IPC
            commands::tag_filter,
            commands::search_query,
            assets::asset_authorize,
            // 导出：图片内嵌（只读，走同一套路径防护）与导出落盘（唯一允许写 Vault 之外的写命令，
            // 只允许 `.html`/`.htm`，路径来自系统保存对话框）—— 见 `export.rs` 的模块文档
            assets::asset_read_base64,
            // 附件写入：把剪贴板/拖入的图片落进 Vault 的附件目录（唯一的"写图片"入口，
            // 只接受图片扩展名、只写 Vault 之内，见 `attachments.rs` 与 ADR-0013）
            attachments::attachment_save,
            export::export_write_html,
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
            // 外部改动监听（ADR-0016）需要两样东西才能起步：一个把事件推给前端的出口，
            // 以及会话状态自己的弱引用（换 Vault 发生在 `set_vault`，那里只有 `&self`）。
            // 两者都只能在这里拿到，所以接线放在 setup。
            let state = app.state::<Arc<AppState>>();
            state.attach_runtime(
                Arc::new(watcher::TauriSink::new(app.handle().clone())),
                Arc::downgrade(state.inner()),
            );
            log::debug!("窗口已创建，等待前端请求 vault_open");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}
