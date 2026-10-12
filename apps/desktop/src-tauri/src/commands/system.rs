//! 系统领域：版本握手 / Vault CSS 片段 / 模板文件（应用级能力，不属于任何文档域）。

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use mn_core::atomic::read_text;
use mn_core::{Error, VaultRoot};

use crate::error::IpcError;
use crate::state::AppState;

use super::run_blocking;

/// 单个 CSS 片段的大小上限。
const MAX_SNIPPET_BYTES: u64 = 512 * 1024;

/// 模板文件目录的默认值（ADR-0056）。
const DEFAULT_TEMPLATE_DIR: &str = ".mimenote/templates";

/// 单个模板的大小上限。
///
/// 只需元信息时本不必读正文，但跳过超大文件仍然有意义：模板目录里出现一个几百 MB 的
/// 东西（误放）时，列表里不该出现它 —— 用户点开才会失败，那种反馈太晚。
const MAX_TEMPLATE_BYTES: u64 = 512 * 1024;

/// 用户 CSS 片段。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetFile {
    pub name: String,
    pub css: String,
    pub size_bytes: u64,
}

/// 模板文件的**元信息**（不给正文）。
///
/// 为什么不顺带返回正文：列表只用来画下拉框，几十个模板正文全传一遍是纯浪费；
/// 正文在用户真的选中某个模板时再按 `relPath` 走 `note_read`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateFile {
    pub name: String,
    pub rel_path: String,
    pub size_bytes: u64,
}

/// 版本信息（关于面板用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub app: &'static str,
    pub core: &'static str,
    pub tauri: &'static str,
}

// ---------------------------------------------------------------------------
// 定制化：Vault CSS 片段
// ---------------------------------------------------------------------------

/// 列出 Vault 内 `.mimenote/snippets/*.css`。
#[tauri::command]
pub async fn snippets_list(state: State<'_, Arc<AppState>>) -> Result<Vec<SnippetFile>, IpcError> {
    let root = state.vault_root()?;
    run_blocking(move || list_snippets(&root)).await
}

/// 列出模板目录里的 `*.md`（ADR-0056）。
///
/// `dirRel` 可选：模板目录是**可配置**的（配置键 `templates.dir`），所以目录名由前端传；
/// 但它会被 `path_guard` 逐段校验（`..`、绝对路径、保留设备名一概拒绝），
/// 而且只返回 `.md` 的元信息 —— 这不是一个通用"列目录"接口。
#[tauri::command]
pub async fn templates_list(
    state: State<'_, Arc<AppState>>,
    dir_rel: Option<String>,
) -> Result<Vec<TemplateFile>, IpcError> {
    let root = state.vault_root()?;
    let dir = dir_rel.unwrap_or_else(|| DEFAULT_TEMPLATE_DIR.to_string());
    run_blocking(move || list_templates(&root, &dir)).await
}

/// 关于面板信息。
///
/// 前端在 bootstrap 阶段会调用一次作为**启动握手**：宿主日志里出现本行，
/// 说明 WebView 已渲染、JS 已执行、IPC 通道可用（CSP 与能力声明都没问题）。
#[tauri::command]
pub fn version_info() -> VersionInfo {
    let info = VersionInfo {
        app: env!("CARGO_PKG_VERSION"),
        core: mn_core::VERSION,
        tauri: tauri::VERSION,
    };
    log::info!(
        "IPC 握手成功：app {} / mn-core {} / tauri {}",
        info.app,
        info.core,
        info.tauri
    );
    info
}

fn list_snippets(root: &VaultRoot) -> mn_core::Result<Vec<SnippetFile>> {
    let dir = root.path().join(".mimenote").join("snippets");
    let mut out = Vec::new();
    if !dir.is_dir() {
        return Ok(out);
    }
    for item in std::fs::read_dir(&dir)
        .map_err(|e| Error::io(&dir, e))?
        .flatten()
    {
        let name = item.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || !name.to_ascii_lowercase().ends_with(".css") {
            continue;
        }
        let path = item.path();
        let meta = std::fs::metadata(&path).map_err(|e| Error::io(&path, e))?;
        if !meta.is_file() {
            continue;
        }
        if meta.len() > MAX_SNIPPET_BYTES {
            log::warn!("跳过过大的 CSS 片段：{name}（{} 字节）", meta.len());
            continue;
        }
        let css = read_text(&path, MAX_SNIPPET_BYTES)?;
        out.push(SnippetFile {
            name,
            css,
            size_bytes: meta.len(),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// 列出模板目录里的 `*.md`（按文件名升序）。
///
/// 目录不存在 → 空数组（不是错误）：还没建模板是很正常的状态，对话框据此显示空态文案。
/// 但**路径必须先过 `path_guard`**：`../outside` 这种越界要报错，
/// 而不是因为"那个目录恰好不存在"被当成"空模板目录"（路径合法性的判据只有一份）。
fn list_templates(root: &VaultRoot, dir_rel: &str) -> mn_core::Result<Vec<TemplateFile>> {
    let trimmed = dir_rel.trim().trim_matches('/');
    if trimmed.is_empty() {
        return Err(Error::invalid(
            DEFAULT_TEMPLATE_DIR,
            "模板目录不能为空（配置 templates.dir 必须是一个 Vault 内的相对目录）",
        ));
    }
    let dir = match root.resolve_existing(trimmed) {
        Ok(path) => path,
        Err(error) if error.code() == mn_core::ErrorCode::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    if !dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut out = Vec::new();
    for item in std::fs::read_dir(&dir)
        .map_err(|e| Error::io(&dir, e))?
        .flatten()
    {
        let name = item.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || !name.to_ascii_lowercase().ends_with(".md") {
            continue;
        }
        let path = item.path();
        let meta = std::fs::metadata(&path).map_err(|e| Error::io(&path, e))?;
        if !meta.is_file() {
            continue;
        }
        if meta.len() > MAX_TEMPLATE_BYTES {
            log::warn!("跳过过大的模板：{name}（{} 字节）", meta.len());
            continue;
        }
        out.push(TemplateFile {
            name: name.clone(),
            rel_path: format!("{trimmed}/{name}"),
            size_bytes: meta.len(),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::testkit::*;

    #[test]
    fn lists_only_css_snippets() {
        let (dir, root) = setup();
        let snippet_dir = dir.path().join(".mimenote/snippets");
        std::fs::create_dir_all(&snippet_dir).unwrap();
        std::fs::write(snippet_dir.join("b.css"), "body{color:red}").unwrap();
        std::fs::write(snippet_dir.join("a.css"), "/* a */").unwrap();
        std::fs::write(snippet_dir.join("readme.md"), "# not css").unwrap();
        std::fs::write(snippet_dir.join(".hidden.css"), "x").unwrap();

        let snippets = list_snippets(&root).unwrap();
        assert_eq!(snippets.len(), 2);
        assert_eq!(snippets[0].name, "a.css");
        assert_eq!(snippets[1].css, "body{color:red}");
    }

    #[test]
    fn missing_snippet_dir_is_empty_not_error() {
        let (_dir, root) = setup();
        assert!(list_snippets(&root).unwrap().is_empty());
    }

    #[test]
    fn lists_only_markdown_templates_sorted_by_name() {
        let (dir, root) = setup();
        let template_dir = dir.path().join(".mimenote/templates");
        std::fs::create_dir_all(&template_dir).unwrap();
        std::fs::write(template_dir.join("日记.md"), "@today\n").unwrap();
        std::fs::write(template_dir.join("会议.md"), "## @prompt=主题\n").unwrap();
        std::fs::write(template_dir.join("readme.txt"), "not a template").unwrap();
        std::fs::write(template_dir.join(".hidden.md"), "x").unwrap();

        let templates = list_templates(&root, DEFAULT_TEMPLATE_DIR).unwrap();
        let names: Vec<&str> = templates.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, vec!["会议.md", "日记.md"]);
        assert_eq!(templates[0].rel_path, ".mimenote/templates/会议.md");
    }

    #[test]
    fn missing_template_dir_is_empty_not_error() {
        let (_dir, root) = setup();
        assert!(list_templates(&root, DEFAULT_TEMPLATE_DIR).unwrap().is_empty());
    }

    #[test]
    fn template_dir_must_be_relative_and_non_empty() {
        let (_dir, root) = setup();
        assert_eq!(
            list_templates(&root, "   ").unwrap_err().code(),
            mn_core::ErrorCode::PathInvalid
        );
        assert_eq!(
            list_templates(&root, "../outside").unwrap_err().code(),
            mn_core::ErrorCode::PathInvalid
        );
    }

    #[test]
    fn template_dir_can_be_a_normal_scanned_directory() {
        // 配置允许把模板放在 Vault 内的普通目录（例如 `模板/`），这条路径也要能列出来
        let (dir, root) = setup();
        std::fs::create_dir_all(dir.path().join("模板")).unwrap();
        std::fs::write(dir.path().join("模板/周报.md"), "# 周报\n").unwrap();
        let templates = list_templates(&root, "模板").unwrap();
        assert_eq!(templates.len(), 1);
        assert_eq!(templates[0].rel_path, "模板/周报.md");
    }
}
