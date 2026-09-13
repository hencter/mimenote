//! 本地图片的读取授权（ADR-0007）。
//!
//! 为什么不是"打开 Vault 时把整个目录加进 asset 作用域"：Tauri 的 asset 协议是拿**路径字符串**
//! 去匹配作用域、然后直接 `File::open`（`tauri/src/protocol/asset.rs`，全程没有 canonicalize）。
//! 于是 `allow_directory(root, true)` 的真实语义是"路径以 root 开头"——Vault 内一个指向外部的
//! 符号链接会被跟随读出，这与"符号链接逃逸一律拦截"的既有姿态冲突。
//!
//! 所以这里改成**逐文件授权**：
//! 1. 前端把「笔记 + 图片原始地址」解析成 Vault 相对路径（`domain/assets.ts` 只做字符串层面的拒绝）；
//! 2. 宿主用 `mn_core::path_guard` 的 `resolve_existing` 把它解析成真实文件 —— 逐级检查符号链接、
//!    拒绝越界、拒绝 Windows 保留名与 ADS；
//! 3. 只有**通过校验的那一个文件**被加进 asset 作用域，前端再把它渲染成 `<img>`。
//!
//! 批量而不是逐张：一次 IPC 换一整篇笔记的图片，避免"每张图一次往返"。

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::error::IpcError;
use crate::state::AppState;

/// 单次请求最多授权的图片数。
///
/// 上限的意义是"一条笔记里塞了几千个图片路径"不会把一次 IPC 拖成秒级；超出的部分前端会在
/// 下一次渲染里再请求（占位元素仍然在，不会丢内容）。
const MAX_ASSETS_PER_REQUEST: usize = 256;

/// 允许渲染的图片扩展名。
///
/// 加进 asset 作用域就等于"这个文件可读"，所以这里给白名单而不是放行任意文件类型。
const ALLOWED_IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "ico",
];

/// 一张图片的读取授权。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetGrant {
    /// 图片的 Vault 相对路径（与请求里的写法一致）。
    pub rel_path: String,
    /// 磁盘上的绝对路径（前端用 `convertFileSrc` 转成 asset URL）。
    pub absolute_path: String,
    pub size_bytes: u64,
}

/// 为一批图片换取读取授权。
///
/// 返回值**只包含通过校验的条目**：越界、符号链接逃逸、非图片扩展名、不存在或不是文件的路径
/// 都会被静默跳过。这是刻意的 —— 一条笔记里有一张坏图，不该让同一篇里其他图片也显示不出来，
/// 调用方把没返回的路径留在占位态即可。
#[tauri::command]
pub async fn asset_authorize(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    rel_paths: Vec<String>,
) -> Result<Vec<AssetGrant>, IpcError> {
    if rel_paths.is_empty() {
        return Ok(Vec::new());
    }

    let root = state.vault_root()?;
    let requested: Vec<String> = rel_paths.into_iter().take(MAX_ASSETS_PER_REQUEST).collect();
    let requested_count = requested.len();

    // 路径校验会读符号链接元数据（文件 IO）→ 按 ADR-0003 放到阻塞线程上
    let resolved = tauri::async_runtime::spawn_blocking(move || -> Vec<(String, PathBuf, u64)> {
        let mut out = Vec::new();
        for rel in requested {
            if !is_allowed_image(&rel) {
                continue;
            }
            // 相对路径本身非法（含 `..`、绝对路径、保留名…）与"解析后逃出 Vault"都在这一步被拒
            let Ok(absolute) = root.resolve_existing(&rel) else {
                log::debug!("图片未通过路径校验，保持占位：{rel}");
                continue;
            };
            let Ok(metadata) = std::fs::metadata(&absolute) else {
                continue;
            };
            if !metadata.is_file() {
                continue;
            }
            out.push((rel, absolute, metadata.len()));
        }
        out
    })
    .await
    .map_err(|error| IpcError::internal(format!("图片授权任务失败：{error}")))?;

    let mut grants = Vec::with_capacity(resolved.len());
    for (rel, absolute, size_bytes) in resolved {
        // 只放行这一个文件；作用域内部出错时跳过它，不影响同批其它图片
        if let Err(error) = app.asset_protocol_scope().allow_file(&absolute) {
            log::warn!("图片加入 asset 作用域失败（{rel}）：{error}");
            continue;
        }
        grants.push(AssetGrant {
            rel_path: rel,
            absolute_path: mn_core::path_guard::display_path(&absolute),
            size_bytes,
        });
    }

    log::debug!(
        "图片授权：请求 {requested_count} 张，放行 {} 张",
        grants.len()
    );
    Ok(grants)
}

/// 扩展名是否是允许渲染的图片（只看最后一段的文件名，不看目录）。
fn is_allowed_image(rel: &str) -> bool {
    let file_name = rel.rsplit('/').next().unwrap_or(rel);
    let Some((_, extension)) = file_name.rsplit_once('.') else {
        return false;
    };
    let lower = extension.to_ascii_lowercase();
    ALLOWED_IMAGE_EXTENSIONS.contains(&lower.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_common_image_extensions_case_insensitively() {
        for rel in [
            "附件/图.png",
            "图.JPG",
            "a/b/c.webp",
            "icon.ico",
            "x.SVG",
            "图.avif",
        ] {
            assert!(is_allowed_image(rel), "{rel} 应该被接受");
        }
    }

    #[test]
    fn rejects_non_image_and_extensionless_paths() {
        for rel in [
            "笔记.md",
            "附件/说明.txt",
            "无扩展名",
            "目录.图",
            "a.b/文件名",
        ] {
            assert!(!is_allowed_image(rel), "{rel} 不该被接受");
        }
    }

    #[test]
    fn asset_grant_serializes_to_the_frontend_contract() {
        let grant = AssetGrant {
            rel_path: "附件/图.png".into(),
            absolute_path: "D:\\Vault\\附件\\图.png".into(),
            size_bytes: 12,
        };
        let json = serde_json::to_string(&grant).unwrap();
        assert!(json.contains("\"relPath\":\"附件/图.png\""), "实际：{json}");
        assert!(json.contains("\"absolutePath\""), "实际：{json}");
        assert!(json.contains("\"sizeBytes\":12"), "实际：{json}");
        assert!(!json.contains("rel_path"), "不该出现 snake_case：{json}");
    }
}
