//! Vault 配置文件（`.mimenote/config.<toml|yaml|json>`）的**定位与读写**（ADR-0055）。
//!
//! 这一层只回答三件事：**该读哪一个文件**（固定候选顺序）、**字节是什么**、
//! **怎么写回规范文件名**。它**不解析** TOML / YAML / JSON ——
//! 格式判据在前端（`apps/desktop/src/domain/config-file.ts`），字段与默认值也在前端
//! （`state/settings-store.ts`）。宿主再解析一遍就会立刻长出第二份默认值与第二套校验，
//! 而那正是 ADR-0048 在 frontmatter 上刻意避开的分叉。
//!
//! 定位逻辑放在 `mn-core` 而不是宿主命令里，是为了**可独立测试**：
//! "四个候选名、只有第一个存在的生效、`.yml` 只读不写"这些是行为约定，
//! 不该只能在启动一个 tauri 应用之后才能验证。

use std::fs;
use std::path::PathBuf;

use crate::atomic::{read_text, write_atomic};
use crate::error::{Error, Result};
use crate::path_guard::VaultRoot;

/// 应用在 Vault 内的私有目录（扫描器忽略它，因此配置文件不会被索引/文件树看见）。
pub const CONFIG_DIR: &str = ".mimenote";

/// 单个配置文件的大小上限（256 KiB）。
///
/// 配置文件是人类手写的小东西：给一个明确上限，可以让"误把别的东西改名成 config.toml"
/// 这件事在读的时候就失败，而不是把几百 MB 读进内存。
pub const MAX_CONFIG_BYTES: u64 = 256 * 1024;

/// 支持的配置格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigFormat {
    Toml,
    Yaml,
    Json,
}

impl ConfigFormat {
    /// **读取**候选顺序（`config.yml` 只是兼容入口）。
    pub const READ_CANDIDATES: [(&'static str, ConfigFormat); 4] = [
        ("config.toml", ConfigFormat::Toml),
        ("config.yaml", ConfigFormat::Yaml),
        ("config.yml", ConfigFormat::Yaml),
        ("config.json", ConfigFormat::Json),
    ];

    /// 规范文件名：**应用自己写回时**用哪个名字。
    ///
    /// `yaml` 只写 `config.yaml`：`.yml` 是给别人手工放进来的兼容入口，
    /// 应用不主动制造第二种拼法（否则同一个 Vault 里会同时出现 `config.yaml` 与
    /// `config.yml`，谁生效要靠文档解释 —— 那是可以避免的歧义）。
    pub const fn file_name(self) -> &'static str {
        match self {
            Self::Toml => "config.toml",
            Self::Yaml => "config.yaml",
            Self::Json => "config.json",
        }
    }

    /// 写命令的参数白名单（前端传来的字符串 → 格式）。
    pub fn parse_name(name: &str) -> Option<Self> {
        match name.trim().to_ascii_lowercase().as_str() {
            "toml" => Some(Self::Toml),
            "yaml" | "yml" => Some(Self::Yaml),
            "json" => Some(Self::Json),
            _ => None,
        }
    }

    /// 供 DTO 使用的稳定字符串（与前端 `ConfigFormat` 一致）。
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Toml => "toml",
            Self::Yaml => "yaml",
            Self::Json => "json",
        }
    }
}

/// 命中的配置文件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigLocation {
    /// Vault 内相对路径（展示与写回都用它）。
    pub rel_path: String,
    pub format: ConfigFormat,
    /// 通过路径校验后的绝对路径（已解符号链接的最后一跳见 `resolve_existing`）。
    pub path: PathBuf,
}

/// 写回目标（相对路径 + 绝对路径）。
pub fn write_target(root: &VaultRoot, format: ConfigFormat) -> Result<(String, PathBuf)> {
    let rel = format!("{CONFIG_DIR}/{}", format.file_name());
    let path = root.resolve_for_write(&rel)?;
    Ok((rel, path))
}

/// 按 {@link ConfigFormat::READ_CANDIDATES} 的顺序找**第一个存在**的配置文件。
///
/// 找不到不是错误（返回 `None`）：没有配置文件就是"全用默认值并准备迁移"的正常状态。
pub fn locate(root: &VaultRoot) -> Result<Option<ConfigLocation>> {
    for (name, format) in ConfigFormat::READ_CANDIDATES {
        let rel = format!("{CONFIG_DIR}/{name}");
        let absolute = root.path().join(CONFIG_DIR).join(name);
        if !absolute.is_file() {
            continue;
        }
        // 存在才做路径校验：符号链接指向 Vault 之外的文件必须在这里被拒绝，
        // 而不是让"读配置"变成读任意文件的入口
        let path = root.resolve_existing(&rel)?;
        return Ok(Some(ConfigLocation {
            rel_path: rel,
            format,
            path,
        }));
    }
    Ok(None)
}

/// 读取命中的配置文件（原文，不解析）。
pub fn read(root: &VaultRoot) -> Result<Option<(ConfigLocation, String)>> {
    let Some(location) = locate(root)? else {
        return Ok(None);
    };
    let content = read_text(&location.path, MAX_CONFIG_BYTES)?;
    Ok(Some((location, content)))
}

/// 把内容写进 `format` 对应的规范文件名（`.mimenote/` 不存在则创建），返回相对路径。
///
/// 写入走 `atomic::write_atomic`：同目录临时文件 → fsync → rename。
/// 配置文件被 git 同步、被同步盘监听，半截文件比写失败糟得多。
pub fn write(root: &VaultRoot, format: ConfigFormat, content: &str) -> Result<String> {
    if content.len() as u64 > MAX_CONFIG_BYTES {
        return Err(Error::TooLarge(format!(
            "配置内容 {} 字节，超过 {} 字节上限",
            content.len(),
            MAX_CONFIG_BYTES
        )));
    }
    let (rel, path) = write_target(root, format)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| Error::io(parent, e))?;
    }
    write_atomic(&path, content.as_bytes())?;
    Ok(rel)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root_of(dir: &tempfile::TempDir) -> VaultRoot {
        VaultRoot::open(dir.path()).unwrap()
    }

    #[test]
    fn format_names_are_stable_and_yml_is_read_only() {
        assert_eq!(ConfigFormat::Toml.as_str(), "toml");
        assert_eq!(ConfigFormat::Yaml.as_str(), "yaml");
        assert_eq!(ConfigFormat::Json.as_str(), "json");
        assert_eq!(ConfigFormat::parse_name("YML"), Some(ConfigFormat::Yaml));
        assert_eq!(ConfigFormat::parse_name("ini"), None);
        // 规范文件名里没有 .yml：读取认它，写回不产生它
        assert_eq!(ConfigFormat::Yaml.file_name(), "config.yaml");
        assert!(ConfigFormat::READ_CANDIDATES
            .iter()
            .any(|(name, _)| *name == "config.yml"));
    }

    #[test]
    fn missing_config_is_none_not_error() {
        let dir = tempfile::tempdir().unwrap();
        let root = root_of(&dir);
        assert!(read(&root).unwrap().is_none());
        assert!(locate(&root).unwrap().is_none());
    }

    #[test]
    fn toml_wins_over_yaml_and_json() {
        let dir = tempfile::tempdir().unwrap();
        let root = root_of(&dir);
        let config_dir = dir.path().join(CONFIG_DIR);
        fs::create_dir_all(&config_dir).unwrap();
        fs::write(config_dir.join("config.json"), "{}").unwrap();
        fs::write(config_dir.join("config.yaml"), "version: 1\n").unwrap();
        fs::write(config_dir.join("config.toml"), "version = 1\n").unwrap();

        let (location, content) = read(&root).unwrap().unwrap();
        assert_eq!(location.format, ConfigFormat::Toml);
        assert_eq!(location.rel_path, ".mimenote/config.toml");
        assert!(content.contains("version = 1"));
    }

    #[test]
    fn write_then_read_round_trips_and_creates_dir() {
        let dir = tempfile::tempdir().unwrap();
        let root = root_of(&dir);
        let rel = write(&root, ConfigFormat::Yaml, "version: 1\n").unwrap();
        assert_eq!(rel, ".mimenote/config.yaml");
        assert!(dir.path().join(".mimenote/config.yaml").is_file());

        let (location, content) = read(&root).unwrap().unwrap();
        assert_eq!(location.format, ConfigFormat::Yaml);
        assert_eq!(content, "version: 1\n");
    }

    #[test]
    fn oversized_content_is_rejected_before_touching_disk() {
        let dir = tempfile::tempdir().unwrap();
        let root = root_of(&dir);
        let huge = "x".repeat((MAX_CONFIG_BYTES + 1) as usize);
        let error = write(&root, ConfigFormat::Toml, &huge).unwrap_err();
        assert_eq!(error.code(), crate::ErrorCode::TooLarge);
        assert!(!dir.path().join(".mimenote/config.toml").exists());
    }

    #[test]
    fn write_target_is_determined_by_format_only() {
        // 调用方**无法指定目录**：目标由格式唯一决定，且一定落在 `.mimenote/` 之下。
        // 这条性质是"配置写入不是任意文件写入后门"的结构性保证 ——
        // 不需要（也无法）用一个越界字符串去证伪，因为它根本没有那个入参。
        let dir = tempfile::tempdir().unwrap();
        let root = root_of(&dir);
        for (format, expected) in [
            (ConfigFormat::Toml, ".mimenote/config.toml"),
            (ConfigFormat::Yaml, ".mimenote/config.yaml"),
            (ConfigFormat::Json, ".mimenote/config.json"),
        ] {
            let (rel, path) = write_target(&root, format).unwrap();
            assert_eq!(rel, expected);
            assert_eq!(path.file_name().unwrap(), format.file_name());
            assert!(rel.starts_with(".mimenote/"));
        }
    }
}
