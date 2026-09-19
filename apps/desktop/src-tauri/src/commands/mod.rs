//! IPC 命令：`mn-core` 能力的最小暴露面。
//!
//! 每个命令都遵守 ADR-0003 的契约：
//!
//! * `async fn` + `spawn_blocking`（文件 IO 绝不在主线程）；
//! * 参数与返回值均为 camelCase DTO；
//! * 失败返回 [`IpcError`]（稳定错误码）。
//!
//! ## 领域划分（M4 插件系统的 capability boundary）
//!
//! 宿主 IPC 按**领域**组织（一个领域一个文件）：宿主只做会话状态、参数映射、
//! 错误映射与能力暴露，业务逻辑全部在 `mn-core` / `mn-index`。每个领域的命令集合
//! 是**可枚举**的（`lib.rs` 的 `generate_handler!` 按同一分块注册），为 M4 的
//! Plugin Manifest / Permission Model 提供稳定映射：
//!
//! | 领域 | 模块 | 命令 |
//! | --- | --- | --- |
//! | Vault | [`vault`] | `vault_open` / `vault_info` / `vault_snapshot` / `vault_close` / `startup_vault` |
//! | 笔记 | [`notes`] | `note_read` / `notes_read_batch` / `note_write` / `note_create` / `note_rename` / `note_move` / `dir_rename` / `dir_move` / `note_delete` / `note_stats` |
//! | 标签 | [`tags`] | `note_set_tags` / `note_tags` / `tags_list` / `tag_notes` / `tag_filter` / `tag_rename` / `tag_move` |
//! | 回收站 | [`trash`] | `trash_list` / `note_restore` |
//! | 链接索引 | [`links`] | `index_status` / `note_links` |
//! | 知识图谱 | [`graph`] | `graph_data` / `graph_ego` |
//! | 全文搜索 | [`search`] | `search_query` |
//! | 系统 | [`system`] | `snippets_list` / `version_info` |
//! | 图片资源 | `crate::assets` | `asset_authorize` / `asset_read_base64` |
//! | 附件 | `crate::attachments` | `attachment_save` |
//! | 导出 | `crate::export` / `crate::site_export` | `export_write_html` / `export_site_plan` / `export_site_write_pages` / `export_site_copy_assets` |

use crate::error::IpcError;

pub mod graph;
pub mod links;
pub mod notes;
pub mod search;
pub mod system;
pub mod tags;
pub mod testkit;
pub mod trash;
pub mod vault;

/// 单个 Markdown 文件的读取上限。
pub(crate) const MAX_READ_BYTES: u64 = mn_core::DEFAULT_MAX_READ_BYTES;

// ---------------------------------------------------------------------------
// 后台执行器
// ---------------------------------------------------------------------------

async fn run_blocking<T, F>(task: F) -> Result<T, IpcError>
where
    F: FnOnce() -> mn_core::Result<T> + Send + 'static,
    T: Send + 'static,
{
    let joined = tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| IpcError::internal(format!("后台任务执行失败：{e}")))?;
    joined.map_err(IpcError::from)
}

/// 条目缓存里"文件名"的口径（`rel` 的最后一段）。
///
/// `pub(crate)`：附件写入复用同一处实现 —— 增量更新条目时的形状必须与扫描结果一致。
pub(crate) fn file_name_of(rel: &str) -> String {
    rel.rsplit('/').next().unwrap_or(rel).to_string()
}

/// 条目缓存里"小写扩展名"的口径（无扩展名 → `None`；`pub(crate)` 的理由同上）。
pub(crate) fn ext_of(rel: &str) -> Option<String> {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    name.rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .filter(|ext| !ext.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_path_parsing() {
        assert_eq!(file_name_of("a/b/c.md"), "c.md");
        assert_eq!(ext_of("a/b/c.MD"), Some("md".to_string()));
        assert_eq!(ext_of("a/b/README"), None);
        assert_eq!(ext_of("a/b/.gitignore"), Some("gitignore".to_string()));
    }
}
