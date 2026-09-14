//! # mn-core
//!
//! Mimenote 的**文件层**：与 UI 框架无关、可独立 `cargo test` 的纯粹逻辑。
//!
//! 设计约束（见 `docs/architecture.md` §2）：
//!
//! * 本 crate **不得**依赖 `tauri` 或任何 UI/运行时框架；
//! * 所有可能失败的操作返回 [`Result`]，错误携带**稳定错误码**（[`ErrorCode`]），
//!   供 UI 分支使用，而不是让 UI 解析错误文本；
//! * 所有写入必须走 [`atomic::write_atomic`]，所有删除必须走 [`trash::move_to_trash`]；
//! * 所有接收用户输入路径的 API 必须经 [`VaultRoot`] 解析，禁止直接拼接。

pub mod atomic;
pub mod error;
pub mod frontmatter;
pub mod links;
pub mod path_guard;
pub mod scanner;
pub mod tags;
pub mod text_stats;
pub mod trash;

pub use error::{Error, ErrorCode, Result};
pub use frontmatter::{
    body as frontmatter_body, editable_tags, parse as parse_frontmatter, rename_tag_fields,
    set_tags, set_tags_or_create, Frontmatter, FrontmatterField, FrontmatterValue, TagFieldRewrite,
};
pub use links::{extract_links, LinkKind, LinkRef};
pub use path_guard::VaultRoot;
pub use scanner::{scan, EntryMeta, ScanOptions, ScanReport};
pub use tags::{
    apply_tag_edits, extract_tags, normalize_tag, rename_tags, TagRef, TagRename, TagRewrite,
    TagSource,
};
pub use text_stats::TextStats;
pub use trash::TrashRecord;

/// 单个 Markdown 文件的默认读取上限（64 MiB）。
///
/// 超过该值的文件会被 [`atomic::read_text`] 拒绝，避免一次读取把内存打满。
pub const DEFAULT_MAX_READ_BYTES: u64 = 64 * 1024 * 1024;

/// 版本号，供前端展示与未来插件 API 的 `minAppVersion` 比较使用。
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
