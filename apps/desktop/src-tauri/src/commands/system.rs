//! 系统领域：版本握手 / Vault CSS 片段（应用级能力，不属于任何文档域）。

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

/// 用户 CSS 片段。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetFile {
    pub name: String,
    pub css: String,
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
}
