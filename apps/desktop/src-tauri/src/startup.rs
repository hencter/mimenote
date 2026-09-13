//! 启动参数解析。
//!
//! 支持 `mimenote.exe <vault 目录>`：从命令行 / 快捷方式 / "打开方式" 直接打开一个 Vault。
//!
//! 这也是端到端测试能**非交互**打开 Vault 的基础：测试里没法去点击系统目录选择框。
//! 因此这个特性不是"为测试而加"的开关，而是一个真实的产品能力。

use std::path::{Path, PathBuf};

/// 启动时对 Vault 参数的解析结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartupVault {
    /// 没有提供参数（正常双击启动）。
    NotProvided,
    /// 提供了参数但不是可用的目录。
    Invalid { raw: String, reason: String },
    /// 可用：已 canonicalize 的目录。
    Ready(PathBuf),
}

/// 解析命令行参数。
///
/// 规则：只看**第一个非选项参数**（不以 `-` 开头），且必须是已存在的目录。
pub fn resolve(args: &[String]) -> StartupVault {
    let Some(candidate) = args.iter().skip(1).find(|arg| !arg.starts_with('-')) else {
        return StartupVault::NotProvided;
    };

    let path = Path::new(candidate);
    if !path.exists() {
        return StartupVault::Invalid {
            raw: candidate.clone(),
            reason: "路径不存在".to_string(),
        };
    }
    if !path.is_dir() {
        return StartupVault::Invalid {
            raw: candidate.clone(),
            reason: "不是目录（M1 只支持传入 Vault 目录）".to_string(),
        };
    }
    match path.canonicalize() {
        Ok(canonical) => StartupVault::Ready(canonical),
        Err(error) => StartupVault::Invalid {
            raw: candidate.clone(),
            reason: format!("无法解析路径：{error}"),
        },
    }
}

impl StartupVault {
    /// 供前端使用的 Vault 路径（`None` 表示没有可用的启动 Vault）。
    pub fn path_for_frontend(&self) -> Option<String> {
        match self {
            Self::Ready(path) => Some(mn_core::path_guard::display_path(path)),
            _ => None,
        }
    }

    /// 记一条启动日志。
    pub fn log(&self) {
        match self {
            Self::NotProvided => {}
            Self::Invalid { raw, reason } => {
                log::warn!("忽略启动参数 {raw}：{reason}（将回到 Vault 选择界面）");
            }
            Self::Ready(path) => {
                log::info!("启动参数指定 Vault：{}", path.display());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn no_arguments_means_not_provided() {
        assert_eq!(resolve(&args(&["mimenote.exe"])), StartupVault::NotProvided);
        // 只有选项、没有位置参数
        assert_eq!(
            resolve(&args(&["mimenote.exe", "-v"])),
            StartupVault::NotProvided
        );
    }

    #[test]
    fn existing_directory_is_ready_and_canonicalized() {
        let dir = tempfile::tempdir().unwrap();
        let result = resolve(&args(&["mimenote.exe", dir.path().to_str().unwrap()]));
        match result {
            StartupVault::Ready(path) => {
                assert!(path.is_absolute());
                assert!(path.is_dir());
                // 临时目录在 Windows 上可能是短路径，canonicalize 后应当仍指向同一目录
                assert_eq!(
                    path.canonicalize().unwrap(),
                    dir.path().canonicalize().unwrap()
                );
            }
            other => panic!("应当解析成功，实际：{other:?}"),
        }
    }

    #[test]
    fn missing_path_is_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope");
        let result = resolve(&args(&["mimenote.exe", missing.to_str().unwrap()]));
        match result {
            StartupVault::Invalid { reason, .. } => assert_eq!(reason, "路径不存在"),
            other => panic!("应当为 Invalid，实际：{other:?}"),
        }
    }

    #[test]
    fn file_path_is_invalid_with_explanation() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("note.md");
        std::fs::write(&file, "# hi").unwrap();
        let result = resolve(&args(&["mimenote.exe", file.to_str().unwrap()]));
        match result {
            StartupVault::Invalid { reason, .. } => {
                assert!(reason.contains("不是目录"), "实际原因：{reason}")
            }
            other => panic!("应当为 Invalid，实际：{other:?}"),
        }
    }

    #[test]
    fn only_first_positional_argument_is_considered() {
        let dir = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let result = resolve(&args(&[
            "mimenote.exe",
            "--flag",
            dir.path().to_str().unwrap(),
            other.path().to_str().unwrap(),
        ]));
        match result {
            StartupVault::Ready(path) => {
                assert_eq!(
                    path.canonicalize().unwrap(),
                    dir.path().canonicalize().unwrap()
                )
            }
            other => panic!("应当取第一个位置参数，实际：{other:?}"),
        }
    }

    #[test]
    fn path_for_frontend_only_for_ready() {
        assert!(StartupVault::NotProvided.path_for_frontend().is_none());
        assert!(StartupVault::Invalid {
            raw: "x".into(),
            reason: "y".into()
        }
        .path_for_frontend()
        .is_none());
        assert_eq!(
            StartupVault::Ready(PathBuf::from("C:/vault")).path_for_frontend(),
            Some("C:/vault".to_string())
        );
    }
}
