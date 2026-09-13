//! IPC 错误类型：`mn-core` 错误 → 前端可分支的稳定错误码。

use serde::Serialize;

use mn_core::Error;

/// 附件类型 / 载荷不被接受（`attachments.rs` 的 `attachment_save`）。
///
/// 为什么新增一个错误码：`mn_core::ErrorCode` 里的码都是**文件层**语义，没有一个能表达
/// "'这段字节'不是我们能接受的图片"。借用 `PATH_INVALID` 会让前端把它翻译成
/// "路径不合法或被拒绝（已阻止越界访问）" —— 用户拖进来一个 `.pdf`，看到的却是一句
/// 关于路径越界的话，比不说还糟。前端 `src/ipc/types.ts` 的 `ErrorCode`/`KNOWN_CODES`
/// 必须同步加上这个字符串，否则它会被归到 `UNKNOWN`（`MimenoteError` 的白名单口径）。
pub const UNSUPPORTED_MEDIA: &str = "UNSUPPORTED_MEDIA";

/// 跨 IPC 的错误载荷。
///
/// 前端 `src/ipc/types.ts` 的 `IpcError` 必须与本结构字段一致。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcError {
    /// 稳定错误码（`CONFLICT` / `PATH_ESCAPE` / ...）。UI 只按此字段分支。
    pub code: &'static str,
    /// 面向人的说明，可自由演化，**禁止**被 UI 解析。
    pub message: String,
    /// 附加诊断信息（系统错误码等）。
    pub detail: Option<String>,
    /// 冲突时磁盘上的当前 mtime（毫秒）。
    pub current_mtime_ms: Option<u64>,
}

impl IpcError {
    /// 宿主内部错误（例如后台任务 panic / join 失败）。
    pub fn internal(message: impl Into<String>) -> Self {
        Self {
            code: "INTERNAL",
            message: message.into(),
            detail: None,
            current_mtime_ms: None,
        }
    }

    /// 尚未打开 Vault。
    pub fn vault_not_set() -> Self {
        Error::VaultNotSet.into()
    }

    /// 附件类型 / 载荷不被接受（见 [`UNSUPPORTED_MEDIA`] 的说明）。
    pub fn unsupported_media(message: impl Into<String>) -> Self {
        Self {
            code: UNSUPPORTED_MEDIA,
            message: message.into(),
            detail: None,
            current_mtime_ms: None,
        }
    }
}

impl From<Error> for IpcError {
    fn from(err: Error) -> Self {
        Self {
            code: err.code().as_str(),
            message: err.to_string(),
            detail: err.detail(),
            current_mtime_ms: err.current_mtime_ms(),
        }
    }
}

impl std::fmt::Display for IpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mn_core::ErrorCode;

    #[test]
    fn maps_conflict_with_mtime() {
        let err: IpcError = Error::Conflict {
            current_mtime_ms: 42,
        }
        .into();
        assert_eq!(err.code, "CONFLICT");
        assert_eq!(err.current_mtime_ms, Some(42));
    }

    #[test]
    fn maps_path_and_io_errors() {
        let path_err: IpcError = Error::PathEscape("x".into()).into();
        assert_eq!(path_err.code, ErrorCode::PathEscape.as_str());

        let io_err: IpcError = Error::io(
            "C:/x",
            std::io::Error::from(std::io::ErrorKind::PermissionDenied),
        )
        .into();
        assert_eq!(io_err.code, "IO");
        assert!(io_err.detail.is_some());
    }

    #[test]
    fn serializes_camel_case() {
        let json = serde_json::to_string(&IpcError::internal("boom")).unwrap();
        assert!(json.contains("\"currentMtimeMs\":null"), "实际：{json}");
        assert!(json.contains("\"code\":\"INTERNAL\""));
    }

    #[test]
    fn maps_unsupported_media_to_a_stable_code() {
        // 这个码不在 `mn_core::ErrorCode` 里（它是宿主侧新增的），所以必须由
        // `IpcError::unsupported_media` 构造 —— 前端按字符串分支，两侧要一个字都不差
        let error = IpcError::unsupported_media("只接受图片附件");
        assert_eq!(error.code, "UNSUPPORTED_MEDIA");
        assert_eq!(error.message, "只接受图片附件");
        assert!(error.detail.is_none());
    }
}
