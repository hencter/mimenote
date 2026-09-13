//! 统一错误类型与**稳定错误码**。
//!
//! UI 只允许按 [`ErrorCode`] 分支，禁止解析错误文本（文本面向人，随时可能改）。

use std::path::Path;

/// 稳定错误码：跨 IPC 传给前端，前端的 `ErrorCode` 类型必须与此一一对应。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    /// 尚未打开 Vault。
    VaultNotSet,
    /// 路径本身非法（含 `..`、绝对路径、Windows 保留名等）。
    PathInvalid,
    /// 路径语法合法，但（经符号链接解析后）逃出了 Vault 根目录。
    PathEscape,
    /// 目标不存在。
    NotFound,
    /// 目标已存在。
    AlreadyExists,
    /// 期望目录，实际不是。
    NotADirectory,
    /// 期望文件，实际是目录。
    IsDirectory,
    /// 文件超过大小上限。
    TooLarge,
    /// 文件在内存中被加载之后被外部修改（详见 ADR-0004）。
    Conflict,
    /// 破坏性操作缺少显式确认。
    ConfirmationRequired,
    /// 其他 IO 错误。
    Io,
    /// 内容不是合法 UTF-8。
    NotUtf8,
}

impl ErrorCode {
    /// 稳定的字符串形式（IPC 传输与前端 switch 的唯一依据）。
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::VaultNotSet => "VAULT_NOT_SET",
            Self::PathInvalid => "PATH_INVALID",
            Self::PathEscape => "PATH_ESCAPE",
            Self::NotFound => "NOT_FOUND",
            Self::AlreadyExists => "ALREADY_EXISTS",
            Self::NotADirectory => "NOT_A_DIRECTORY",
            Self::IsDirectory => "IS_DIRECTORY",
            Self::TooLarge => "TOO_LARGE",
            Self::Conflict => "CONFLICT",
            Self::ConfirmationRequired => "CONFIRMATION_REQUIRED",
            Self::Io => "IO",
            Self::NotUtf8 => "NOT_UTF8",
        }
    }
}

impl std::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 文件层错误。
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("尚未打开 Vault")]
    VaultNotSet,

    #[error("路径非法：{reason}（{path}）")]
    PathInvalid { path: String, reason: String },

    #[error("路径逃出 Vault 根目录：{0}")]
    PathEscape(String),

    #[error("目标不存在：{0}")]
    NotFound(String),

    #[error("目标已存在：{0}")]
    AlreadyExists(String),

    #[error("不是目录：{0}")]
    NotADirectory(String),

    #[error("是目录，不是文件：{0}")]
    IsDirectory(String),

    #[error("文件超过大小上限：{0}")]
    TooLarge(String),

    #[error("文件已被外部修改（当前 mtime={current_mtime_ms}ms）")]
    Conflict { current_mtime_ms: u64 },

    #[error("该操作需要显式确认")]
    ConfirmationRequired,

    #[error("IO 错误（{path}）：{source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },

    #[error("内容不是合法 UTF-8：{0}")]
    NotUtf8(String),
}

impl Error {
    /// 构造带路径上下文的 IO 错误。
    pub fn io(path: impl AsRef<Path>, source: std::io::Error) -> Self {
        Self::Io {
            path: path.as_ref().to_string_lossy().into_owned(),
            source,
        }
    }

    /// 构造路径非法错误。
    pub fn invalid(path: impl AsRef<Path>, reason: impl Into<String>) -> Self {
        Self::PathInvalid {
            path: path.as_ref().to_string_lossy().into_owned(),
            reason: reason.into(),
        }
    }

    /// 稳定错误码。
    pub const fn code(&self) -> ErrorCode {
        match self {
            Self::VaultNotSet => ErrorCode::VaultNotSet,
            Self::PathInvalid { .. } => ErrorCode::PathInvalid,
            Self::PathEscape(_) => ErrorCode::PathEscape,
            Self::NotFound(_) => ErrorCode::NotFound,
            Self::AlreadyExists(_) => ErrorCode::AlreadyExists,
            Self::NotADirectory(_) => ErrorCode::NotADirectory,
            Self::IsDirectory(_) => ErrorCode::IsDirectory,
            Self::TooLarge(_) => ErrorCode::TooLarge,
            Self::Conflict { .. } => ErrorCode::Conflict,
            Self::ConfirmationRequired => ErrorCode::ConfirmationRequired,
            Self::Io { .. } => ErrorCode::Io,
            Self::NotUtf8(_) => ErrorCode::NotUtf8,
        }
    }

    /// 冲突时的当前 mtime（毫秒），用于前端展示与二次确认。
    pub const fn current_mtime_ms(&self) -> Option<u64> {
        match self {
            Self::Conflict { current_mtime_ms } => Some(*current_mtime_ms),
            _ => None,
        }
    }

    /// 附加诊断信息（本地兜底原因、系统错误码等），可选。
    pub fn detail(&self) -> Option<String> {
        match self {
            Self::Io { source, .. } => Some(format!(
                "{:?}（os error {:?}）",
                source.kind(),
                source.raw_os_error()
            )),
            _ => None,
        }
    }
}

/// 本 crate 统一返回类型。
pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_stable_screaming_snake_case() {
        // 这些字符串是 IPC 契约的一部分：改动即破坏性变更，必须同步前端 ErrorCode。
        assert_eq!(ErrorCode::Conflict.as_str(), "CONFLICT");
        assert_eq!(ErrorCode::PathEscape.as_str(), "PATH_ESCAPE");
        assert_eq!(
            ErrorCode::ConfirmationRequired.as_str(),
            "CONFIRMATION_REQUIRED"
        );
        assert_eq!(ErrorCode::VaultNotSet.to_string(), "VAULT_NOT_SET");
    }

    #[test]
    fn conflict_exposes_current_mtime() {
        let err = Error::Conflict {
            current_mtime_ms: 1234,
        };
        assert_eq!(err.code(), ErrorCode::Conflict);
        assert_eq!(err.current_mtime_ms(), Some(1234));
        assert!(err.detail().is_none());
    }

    #[test]
    fn io_error_carries_kind_detail() {
        let err = Error::io(
            "C:/x/y.md",
            std::io::Error::from(std::io::ErrorKind::PermissionDenied),
        );
        assert_eq!(err.code(), ErrorCode::Io);
        assert!(err.detail().unwrap().contains("PermissionDenied"));
    }
}
