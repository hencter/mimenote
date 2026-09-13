//! 原子写与安全读（见 ADR-0004）。
//!
//! 写入流程：**同目录**临时文件 → `write_all` → `flush` → `fsync` → `rename` 覆盖。
//! 同目录是硬性要求：跨卷 `rename` 不具备原子性。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{Error, Result};

/// 临时文件前缀。崩溃后残留的 `.mimenote-*.tmp` 可据此识别与清理。
pub const TEMP_PREFIX: &str = ".mimenote-";

/// 原子地把 `bytes` 写入 `path`（覆盖已存在文件）。
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir: PathBuf = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| Error::invalid(path, "路径没有父目录"))?
        .to_path_buf();

    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| Error::io(&dir, e))?;
    }

    let mut tmp = tempfile::Builder::new()
        .prefix(TEMP_PREFIX)
        .suffix(".tmp")
        .tempfile_in(&dir)
        .map_err(|e| Error::io(&dir, e))?;

    tmp.write_all(bytes).map_err(|e| Error::io(path, e))?;
    tmp.flush().map_err(|e| Error::io(path, e))?;
    // fsync：保证 rename 之前数据已落盘，断电不会得到"空文件"。
    tmp.as_file().sync_all().map_err(|e| Error::io(path, e))?;

    // persist 在 Windows 上使用 MoveFileEx(REPLACE_EXISTING) 语义，可原子覆盖。
    tmp.persist(path).map_err(|e| Error::io(path, e.error))?;
    Ok(())
}

/// 带大小上限的 UTF-8 读取。
///
/// **不做**任何内容解释（BOM / 换行风格由前端领域层负责），保证 Rust 侧只搬运字节。
pub fn read_text(path: &Path, max_bytes: u64) -> Result<String> {
    let meta = fs::metadata(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            Error::NotFound(path.to_string_lossy().into_owned())
        } else {
            Error::io(path, e)
        }
    })?;
    if meta.is_dir() {
        return Err(Error::IsDirectory(path.to_string_lossy().into_owned()));
    }
    if meta.len() > max_bytes {
        return Err(Error::TooLarge(format!(
            "{}（{} 字节 > 上限 {} 字节）",
            path.to_string_lossy(),
            meta.len(),
            max_bytes
        )));
    }
    let bytes = fs::read(path).map_err(|e| Error::io(path, e))?;
    String::from_utf8(bytes).map_err(|_| Error::NotUtf8(path.to_string_lossy().into_owned()))
}

/// 文件 mtime（自 Unix 纪元起的毫秒数）；早于纪元或不可得时返回 `None`。
pub fn mtime_ms(meta: &fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

/// 路径的 mtime（毫秒），文件不存在时返回 `Ok(None)`。
pub fn path_mtime_ms(path: &Path) -> Result<Option<u64>> {
    match fs::metadata(path) {
        Ok(meta) => Ok(mtime_ms(&meta)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(Error::io(path, e)),
    }
}

/// 当前毫秒时间戳（用于台账与 ID）。
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_overwrites_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("note.md");

        write_atomic(&target, b"# v1").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "# v1");

        write_atomic(&target, "# v2 更长一些的内容".as_bytes()).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "# v2 更长一些的内容");

        // 不留临时文件
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with(TEMP_PREFIX))
            .collect();
        assert!(leftovers.is_empty(), "不应残留临时文件：{leftovers:?}");
    }

    #[test]
    fn creates_parent_directory_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("deep/nested/note.md");
        write_atomic(&target, b"x").unwrap();
        assert!(target.exists());
    }

    #[test]
    fn read_text_enforces_size_limit_and_utf8() {
        let dir = tempfile::tempdir().unwrap();
        let big = dir.path().join("big.md");
        write_atomic(&big, &vec![b'a'; 1024]).unwrap();
        assert_eq!(
            read_text(&big, 10).unwrap_err().code(),
            crate::ErrorCode::TooLarge
        );
        assert_eq!(read_text(&big, 4096).unwrap().len(), 1024);

        let bad = dir.path().join("bad.md");
        fs::write(&bad, [0xff, 0xfe, 0x00]).unwrap();
        assert_eq!(
            read_text(&bad, 4096).unwrap_err().code(),
            crate::ErrorCode::NotUtf8
        );

        assert_eq!(
            read_text(&dir.path().join("nope.md"), 4096)
                .unwrap_err()
                .code(),
            crate::ErrorCode::NotFound
        );
    }

    #[test]
    fn mtime_advances_after_write() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("n.md");
        write_atomic(&target, b"a").unwrap();
        let first = path_mtime_ms(&target).unwrap().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        write_atomic(&target, b"b").unwrap();
        let second = path_mtime_ms(&target).unwrap().unwrap();
        assert!(second >= first, "mtime 不应回退：{first} -> {second}");
        assert!(path_mtime_ms(&dir.path().join("ghost.md"))
            .unwrap()
            .is_none());
    }
}
