//! 导出落盘：把前端拼好的自包含 HTML 写到**用户用系统保存对话框选定的路径**。
//!
//! 这个模块只有一条命令 [`export_write_html`]，它是宿主唯一一条"可以写到 Vault 之外"的
//! 写命令，因此约束必须写在最显眼的地方：
//!
//! * **路径来源**：`tauri-plugin-dialog` 的 `save()`（前端弹出系统保存对话框，能力声明里的
//!   `dialog:allow-save` 就是为它开的）。目标在 Vault 之外是**正常情况**（用户想导到桌面、
//!   共享盘、邮件附件目录），所以这里**刻意不做** `path_guard` 越界限制 —— 对绝对路径做
//!   越界检查没有意义，反而会把"导出到 Vault 外面"这个正当需求变成错误。
//! * **只允许 `.html` / `.htm`**：一条"给什么路径写什么文件"的命令如果放行任意扩展名，
//!   就等于给前端开了一个任意文件写入的后门（例如覆盖 `C:\Windows\...` 或某个 `.exe`）。
//!   扩展名白名单把它的能力面收窄成"写一个 HTML 文件"，这是它可以接受的前提。
//! * **不新增覆盖确认**：目标已存在时由保存对话框自己负责"是否覆盖"（用户已经点过一次
//!   "保存"了），宿主只做原子替换 —— 半写的文件在导出场景同样不可接受（ADR-0004）。
//!
//! 写入一律走 `mn_core::atomic::write_atomic`（同目录临时文件 → fsync → rename），
//! 并按 ADR-0003 放在阻塞线程上。

use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::Serialize;

use mn_core::atomic::write_atomic;
use mn_core::Error;

use crate::error::IpcError;

/// 导出文件的大小上限（32 MiB）。
///
/// 为什么宿主也要设：这条命令是"任意路径写入"的唯一入口，即使扩展名被限制成 `.html`，
/// 也不该允许一次写入把磁盘写满。超过上限直接报 `TOO_LARGE`（而不是像图片那样静默跳过）：
/// 导出是一等操作，用户必须知道"这次导出没成功"，而不是拿到一个空文件。
const MAX_EXPORT_BYTES: usize = 32 * 1024 * 1024;

/// 允许写出的扩展名（小写比较）。
///
/// 只放行 HTML：导出功能对外承诺的产物就是"一个能在浏览器里打开的 HTML 文件"。
const ALLOWED_EXPORT_EXTENSIONS: &[&str] = &["html", "htm"];

/// 导出落盘结果。
///
/// 字段名是 IPC 契约的一部分（`src/ipc/types.ts` 手工镜像），一律 camelCase。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportWriteOutcome {
    /// 实际写入的绝对路径（原样回显用户选定的路径，前端直接显示给用户）。
    pub absolute_path: String,
    /// 写入字节数。
    pub size_bytes: u64,
    /// 实际写入耗时（毫秒，含 fsync）。
    pub written_in_ms: u64,
}

/// 把导出好的 HTML 写到用户选定的绝对路径。
///
/// 参数与返回值是不可偏离的 IPC 契约（`src/ipc/types.ts` 手工镜像）：
/// 入参 `path`（绝对路径，来自系统保存对话框）、`html`（完整 HTML 文档）；
/// 出参见 [`ExportWriteOutcome`]。
///
/// 校验只有两条，但都是硬性的：扩展名必须是 `.html` / `.htm`，大小不超过
/// [`MAX_EXPORT_BYTES`]。失败返回既有错误码（`PATH_INVALID` / `TOO_LARGE` / `IO`），
/// **不新增错误码**（前端只按 `code` 分支）。
#[tauri::command]
pub async fn export_write_html(path: String, html: String) -> Result<ExportWriteOutcome, IpcError> {
    // 大小检查放在搬走字符串之前：它是 O(1) 的比较，不属于"文件 IO 必须在阻塞线程"的范畴，
    // 而且能在超限时直接拒掉，避免把一个几十 MB 的字符串搬进后台任务（ADR-0003 的口径不变）。
    ensure_export_size(html.len())?;

    let target = PathBuf::from(path);
    let bytes = html.into_bytes();

    tauri::async_runtime::spawn_blocking(move || write_export(&target, &bytes))
        .await
        .map_err(|error| IpcError::internal(format!("导出写入任务失败：{error}")))?
        .map_err(IpcError::from)
}

/// 导出大小上限校验（与 Tauri 无关，可单测）。
fn ensure_export_size(len: usize) -> Result<(), IpcError> {
    if len > MAX_EXPORT_BYTES {
        return Err(Error::TooLarge(format!(
            "导出内容 {len} 字节 > 上限 {MAX_EXPORT_BYTES} 字节"
        ))
        .into());
    }
    Ok(())
}

/// [`export_write_html`] 的主体（与 Tauri 无关，可单测）。
fn write_export(path: &Path, bytes: &[u8]) -> mn_core::Result<ExportWriteOutcome> {
    ensure_export_path(path)?;

    let started = Instant::now();
    write_atomic(path, bytes)?;

    let outcome = ExportWriteOutcome {
        absolute_path: mn_core::path_guard::display_path(path),
        size_bytes: bytes.len() as u64,
        written_in_ms: started.elapsed().as_millis() as u64,
    };
    log::info!(
        "导出 HTML：{}（{} 字节，写入 {}ms）",
        outcome.absolute_path,
        outcome.size_bytes,
        outcome.written_in_ms
    );
    Ok(outcome)
}

/// 路径校验：非空 + 扩展名白名单。
///
/// 只看扩展名、不看目录：这是唯一一条允许写 Vault 之外路径的命令，能管住它的只有
/// "能写什么类型"这一条（见模块文档）。它同时挡掉了 NTFS 备用数据流
/// （`a.html:evil` 的"扩展名"是 `html:evil`，不在白名单里）。
fn ensure_export_path(path: &Path) -> mn_core::Result<()> {
    if path.as_os_str().is_empty() {
        return Err(Error::invalid("", "导出路径为空"));
    }
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .unwrap_or_default();

    if !ALLOWED_EXPORT_EXTENSIONS.contains(&extension.as_str()) {
        return Err(Error::invalid(
            path,
            format!(
                "导出只允许写 {} 文件",
                ALLOWED_EXPORT_EXTENSIONS
                    .iter()
                    .map(|ext| format!(".{ext}"))
                    .collect::<Vec<_>>()
                    .join(" / ")
            ),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn writes_html_file_and_reports_the_contract() {
        let dir = temp_dir();
        let target = dir.path().join("设计文档.html");
        let html = "<!doctype html><p>你好</p>";

        let outcome = write_export(&target, html.as_bytes()).unwrap();

        assert_eq!(std::fs::read_to_string(&target).unwrap(), html);
        assert_eq!(
            outcome.size_bytes,
            html.len() as u64,
            "按字节计（中文 3 字节）"
        );
        assert_eq!(outcome.absolute_path, target.to_string_lossy());
        assert!(
            !outcome.absolute_path.contains(r"\\?\"),
            "必须去掉 verbatim 前缀"
        );
    }

    #[test]
    fn accepts_htm_and_uppercase_extensions_but_nothing_else() {
        let dir = temp_dir();
        for name in ["a.html", "a.HTM", "a.Html", "带空格 的.html"] {
            let target = dir.path().join(name);
            write_export(&target, b"x").unwrap();
            assert!(target.exists(), "{name} 应该被接受");
        }

        for name in [
            "a.txt",
            "a.md",
            "a.html.txt",
            "无扩展名",
            // NTFS 备用数据流：扩展名会变成 `html:ads`，不在白名单里
            "a.html:ads",
        ] {
            let target = dir.path().join(name);
            let error = write_export(&target, b"x").unwrap_err();
            assert_eq!(
                error.code(),
                mn_core::ErrorCode::PathInvalid,
                "{name} 必须被拒绝"
            );
            assert!(!target.exists(), "{name} 不该被创建");
        }
    }

    #[test]
    fn rejects_empty_path() {
        let error = write_export(Path::new(""), b"x").unwrap_err();
        assert_eq!(error.code(), mn_core::ErrorCode::PathInvalid);
    }

    #[test]
    fn overwrites_existing_file_atomically_without_leftovers() {
        let dir = temp_dir();
        let target = dir.path().join("导出.html");
        std::fs::write(&target, "旧内容").unwrap();

        write_export(&target, b"new").unwrap();

        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new");
        // 原子写的临时文件必须已被 rename 掉（ADR-0004：不留半写文件）
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(mn_core::atomic::TEMP_PREFIX)
            })
            .collect();
        assert!(leftovers.is_empty(), "不应残留临时文件：{leftovers:?}");
    }

    #[test]
    fn rejects_payloads_over_the_size_limit() {
        assert!(ensure_export_size(0).is_ok());
        assert!(ensure_export_size(MAX_EXPORT_BYTES).is_ok(), "上限本身允许");
        let error = ensure_export_size(MAX_EXPORT_BYTES + 1).unwrap_err();
        assert_eq!(error.code, "TOO_LARGE");
    }

    #[test]
    fn reports_io_errors_with_the_existing_code() {
        // 父路径是文件 → 建目录/临时文件必然失败（不新增错误码，仍是 IO）
        let dir = temp_dir();
        let blocker = dir.path().join("blocker");
        std::fs::write(&blocker, "x").unwrap();
        let target = blocker.join("out.html");

        let error = write_export(&target, b"x").unwrap_err();
        assert_eq!(error.code(), mn_core::ErrorCode::Io);
    }

    #[test]
    fn export_outcome_serializes_to_the_frontend_contract() {
        let outcome = ExportWriteOutcome {
            absolute_path: r"D:\导出\笔记.html".into(),
            size_bytes: 42,
            written_in_ms: 7,
        };
        let json = serde_json::to_string(&outcome).unwrap();
        for key in ["absolutePath", "sizeBytes", "writtenInMs"] {
            assert!(
                json.contains(&format!("\"{key}\"")),
                "缺少字段 {key}：{json}"
            );
        }
        assert!(json.contains("\"sizeBytes\":42"), "实际：{json}");
        assert!(json.contains("\"writtenInMs\":7"), "实际：{json}");
        for snake in ["absolute_path", "size_bytes", "written_in_ms"] {
            assert!(!json.contains(snake), "不该出现 snake_case {snake}：{json}");
        }
    }
}
