//! 配置领域：Vault 配置文件（`.mimenote/config.<toml|yaml|json>`）的读写（ADR-0055）。
//!
//! 接口刻意窄 —— 它是一个"能力明确的东西"，不是"任意文件读写"的后门：
//!
//! * **不接受路径参数**：以当前打开的 Vault 为准（与 `snippets_list` 一致），
//!   文件名由格式决定，调用方无从指定目录；
//! * **格式走白名单**（`toml` / `yaml` / `yml` / `json`）；
//! * **读取只找固定的四个候选名**，不做目录遍历；
//! * **写入 ≤256 KiB**、走 `mn_core::config::write`（`.mimenote/` 不存在则创建，原子写）。
//!
//! 这与 `export_write_html` 只接受 `.html` 是同一条纪律（ADR-0011）：
//! 能力面收窄到"写一个配置文件"，它才敢存在。

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use mn_core::config::{self, ConfigFormat};
use mn_core::{Error, VaultRoot};

use crate::error::IpcError;
use crate::state::AppState;

use super::run_blocking;

/// 格式非法时错误里显示的"路径"（`Error::invalid` 需要一个人能读懂的位置）。
const CONFIG_HINT: &str = ".mimenote/config";

/// `config_read` 的结果。没有配置文件时三个字段都是 `null` —— 那是正常状态，不是错误。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFileDto {
    /// Vault 内相对路径（例如 `.mimenote/config.toml`）。
    pub path: Option<String>,
    pub format: Option<String>,
    /// 原文（**不解析**：格式判据只有前端一份）。
    pub content: Option<String>,
}

/// `config_write` 的结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigWriteOutcome {
    pub path: String,
}

/// 读取命中的配置文件。
#[tauri::command]
pub async fn config_read(state: State<'_, Arc<AppState>>) -> Result<ConfigFileDto, IpcError> {
    let root = state.vault_root()?;
    run_blocking(move || read_config(&root)).await
}

/// 写入配置文件（文件名由 `format` 决定）。
#[tauri::command]
pub async fn config_write(
    state: State<'_, Arc<AppState>>,
    format: String,
    content: String,
) -> Result<ConfigWriteOutcome, IpcError> {
    // 参数校验放在进后台线程**之前**：参数错不该占用一次 spawn_blocking，
    // 也不该让错误信息绕一圈才回到前端
    let parsed = ConfigFormat::parse_name(&format)
        .ok_or_else(|| Error::invalid(CONFIG_HINT, format!("不支持的配置格式：{format}")))?;
    let root = state.vault_root()?;
    run_blocking(move || write_config(&root, parsed, &content)).await
}

fn read_config(root: &VaultRoot) -> mn_core::Result<ConfigFileDto> {
    let Some((location, content)) = config::read(root)? else {
        return Ok(ConfigFileDto {
            path: None,
            format: None,
            content: None,
        });
    };
    Ok(ConfigFileDto {
        path: Some(location.rel_path),
        format: Some(location.format.as_str().to_string()),
        content: Some(content),
    })
}

fn write_config(
    root: &VaultRoot,
    format: ConfigFormat,
    content: &str,
) -> mn_core::Result<ConfigWriteOutcome> {
    let path = config::write(root, format, content)?;
    log::info!("配置文件已写入：{path}（{} 字节）", content.len());
    Ok(ConfigWriteOutcome { path })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::testkit::*;

    #[test]
    fn missing_config_reads_as_none() {
        let (_dir, root) = setup();
        let dto = read_config(&root).unwrap();
        assert!(dto.path.is_none());
        assert!(dto.format.is_none());
        assert!(dto.content.is_none());
    }

    #[test]
    fn write_then_read_reports_path_format_and_content() {
        let (_dir, root) = setup();
        let outcome = write_config(&root, ConfigFormat::Toml, "version = 1\n").unwrap();
        assert_eq!(outcome.path, ".mimenote/config.toml");

        let dto = read_config(&root).unwrap();
        assert_eq!(dto.path.as_deref(), Some(".mimenote/config.toml"));
        assert_eq!(dto.format.as_deref(), Some("toml"));
        assert_eq!(dto.content.as_deref(), Some("version = 1\n"));
    }

    #[test]
    fn json_and_yaml_round_trip_through_their_own_names() {
        let (_dir, root) = setup();
        write_config(&root, ConfigFormat::Json, "{}\n").unwrap();
        assert_eq!(read_config(&root).unwrap().format.as_deref(), Some("json"));

        write_config(&root, ConfigFormat::Yaml, "version: 1\n").unwrap();
        let dto = read_config(&root).unwrap();
        // toml 缺席时 yaml 才生效；这里写了 yaml 与 json，候选顺序里 yaml 在前
        assert_eq!(dto.path.as_deref(), Some(".mimenote/config.yaml"));
    }

    #[test]
    fn unknown_format_is_rejected() {
        assert!(ConfigFormat::parse_name("ini").is_none());
        let error = ConfigFormat::parse_name("ini")
            .ok_or_else(|| Error::invalid(CONFIG_HINT, "不支持的配置格式：ini"))
            .unwrap_err();
        assert_eq!(error.code(), mn_core::ErrorCode::PathInvalid);
    }

    #[test]
    fn oversized_config_is_rejected() {
        let (_dir, root) = setup();
        let huge = "x".repeat((mn_core::MAX_CONFIG_BYTES + 1) as usize);
        let error = write_config(&root, ConfigFormat::Toml, &huge).unwrap_err();
        assert_eq!(error.code(), mn_core::ErrorCode::TooLarge);
    }
}
