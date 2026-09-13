//! 日志初始化。
//!
//! * **开发**（`tauri dev`）：写到 stderr，直接在终端里看。
//! * **生产**：同时写入用户日志目录（Windows 为 `%LOCALAPPDATA%\<identifier>\logs`），
//!   便于用户在出问题时把日志发给我们，而不是只看到"界面没反应"。
//!
//! 另外：前端在 bootstrap 阶段会调用 `version_info` 做**启动握手**，因此日志里出现
//! "IPC 握手成功"就说明 WebView 已渲染、JS 已执行、IPC 通道可用 —— 这是排查
//! "白屏" 类问题最快的证据。

use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

/// 单个日志文件的大小上限，超过则截断重来（避免无限增长）。
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

/// 同时写 stderr 与文件的输出目标。
struct Tee {
    file: std::fs::File,
}

impl Write for Tee {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        // stderr 失败不影响文件写入
        let _ = io::stderr().write_all(buf);
        self.file.write_all(buf)?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        let _ = io::stderr().flush();
        self.file.flush()
    }
}

/// 初始化日志，返回日志文件路径（不可用时返回 `None`，此时只写 stderr）。
pub fn init(app: &AppHandle) -> Option<PathBuf> {
    let file = open_log_file(app)?;
    let logger =
        env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
            .format_timestamp_millis()
            .target(env_logger::Target::Pipe(Box::new(Tee { file })))
            .try_init();

    match logger {
        // 已经初始化过（例如测试）：保持原样
        Err(_) => None,
        Ok(()) => log_file_path(app),
    }
}

fn log_file_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_log_dir().ok()?;
    Some(dir.join("mimenote.log"))
}

fn open_log_file(app: &AppHandle) -> Option<std::fs::File> {
    let path = log_file_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok()?;
    }
    // 过大就截断，保证日志不会无限膨胀
    if std::fs::metadata(&path)
        .map(|meta| meta.len() > MAX_LOG_BYTES)
        .unwrap_or(false)
    {
        let _ = std::fs::remove_file(&path);
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok()
}
