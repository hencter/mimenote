//! 原子写与安全读（见 ADR-0004）。
//!
//! 写入流程：**同目录**临时文件 → `write_all` → `flush` → `fsync` → `rename` 覆盖。
//! 同目录是硬性要求：跨卷 `rename` 不具备原子性。
//!
//! 同一条纪律的另一半是[`move_file`]：文件换位置时优先 `rename`（同卷原子），
//! 只有在"必然失败"的情况下才退回"复制 + 删源"。

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

/// 文件搬迁实际走的方式。
///
/// 调用方据此决定要不要留痕：跨卷回退是**正确的降级**，但它丢掉了原子的那一刻
/// （中途崩溃会留下"源和目标各半份"），值得在日志里显形。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MoveMethod {
    /// 原子 `rename`（同卷内的正常路径）。
    Rename,
    /// `rename` 不可用 → 复制 + 删源（跨卷联接等场景）。
    CopyAndDelete,
}

/// 把文件从 `from` 搬到 `to`：**优先原子 rename**，跨卷时退回"复制 + 删除源"。
///
/// 为什么需要回退：Vault 里可以出现指向另一个卷的**联接（junction）**目录
/// （`path_guard` 拦的是"符号链接逃逸出根"，盘内联接仍在根内），这时 `fs::rename`
/// 必然返回 `ERROR_NOT_SAME_DEVICE`；而"把这篇笔记挪到那个文件夹"本身是完全合法的操作。
///
/// 回退的两条纪律：
///
/// 1. **只在必然失败时回退**：`rename` 失败还有"目标已存在""权限不足"等原因，
///    那些情况下 `fs::copy` 会**覆盖**目标 —— 那会违背"绝不覆盖同名文件"的上层契约；
/// 2. **先复制成功再删源**：删源失败时把刚写出的副本撤掉再报错。宁可"什么都没发生"，
///    也不留下"两个目录各一份、不知道该信哪个"的半成品。
pub fn move_file(from: &Path, to: &Path) -> Result<MoveMethod> {
    match fs::rename(from, to) {
        Ok(()) => Ok(MoveMethod::Rename),
        Err(error) if is_cross_device(&error) && !to.exists() => copy_then_remove(from, to),
        Err(error) => Err(Error::io(to, error)),
    }
}

/// `rename` 是否属于"这个文件系统根本不支持跨位置改名"那一类。
fn is_cross_device(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::CrossesDevices | std::io::ErrorKind::Unsupported
    )
}

/// 复制 + 删源（回退路径）。成功返回 [`MoveMethod::CopyAndDelete`]。
fn copy_then_remove(from: &Path, to: &Path) -> Result<MoveMethod> {
    fs::copy(from, to).map_err(|e| Error::io(to, e))?;
    if let Err(error) = fs::remove_file(from) {
        // 副本已经写完，但源还占着旧位置：撤掉副本、把错误原样报上去，
        // 让上层看到"这次移动没有发生"，而不是一个位置对不上的中间态。
        if let Err(cleanup) = fs::remove_file(to) {
            return Err(Error::Io {
                path: to.to_string_lossy().into_owned(),
                source: std::io::Error::new(
                    cleanup.kind(),
                    format!("复制后删除源失败（{error}），且无法撤销副本（{cleanup}）"),
                ),
            });
        }
        return Err(Error::io(from, error));
    }
    Ok(MoveMethod::CopyAndDelete)
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

    #[test]
    fn moves_a_file_between_directories_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("目标");
        fs::create_dir_all(&target).unwrap();
        let from = dir.path().join("甲.md");
        fs::write(&from, "# 甲\n").unwrap();

        let to = target.join("甲.md");
        assert_eq!(move_file(&from, &to).unwrap(), MoveMethod::Rename);
        assert!(!from.exists(), "源必须消失");
        assert_eq!(fs::read_to_string(&to).unwrap(), "# 甲\n");
        // 不留临时文件（rename 不产生中间产物）
        let leftovers = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with(TEMP_PREFIX))
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn missing_source_reports_not_found_style_io_error() {
        let dir = tempfile::tempdir().unwrap();
        let error =
            move_file(&dir.path().join("没有这篇.md"), &dir.path().join("x.md")).unwrap_err();
        assert_eq!(error.code(), crate::ErrorCode::Io);
    }

    /// 覆盖回退路径本身：`fs::rename` 在跨卷时返回 `ERROR_NOT_SAME_DEVICE`，
    /// 单测里造不出两个卷，所以直接验证回退原语的语义（内容完整、源被删、不留中间态）。
    #[test]
    fn copy_and_remove_fallback_keeps_content_and_deletes_source() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("甲.md");
        // 用非 UTF-8 字节，确认回退是**逐字节**搬运而不是走文本路径
        let bytes: &[u8] = &[0xff, 0x00, b'a', 0xfe];
        fs::write(&from, bytes).unwrap();
        let to = dir.path().join("乙.md");

        assert_eq!(
            copy_then_remove(&from, &to).unwrap(),
            MoveMethod::CopyAndDelete
        );
        assert_eq!(fs::read(&to).unwrap(), bytes);
        assert!(!from.exists());
    }

    #[test]
    fn copy_and_remove_fallback_rolls_back_when_the_target_cannot_be_written() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("甲.md");
        fs::write(&from, "内容").unwrap();
        // 目标是目录 → copy 必然失败：源必须原样留着
        let to = dir.path().join("占位");
        fs::create_dir_all(&to).unwrap();

        assert!(copy_then_remove(&from, &to).is_err());
        assert_eq!(fs::read_to_string(&from).unwrap(), "内容");
    }

    #[test]
    fn cross_device_detection_covers_the_two_kinds_that_mean_give_up() {
        for kind in [
            std::io::ErrorKind::CrossesDevices,
            std::io::ErrorKind::Unsupported,
        ] {
            assert!(is_cross_device(&std::io::Error::from(kind)));
        }
        // "目标已存在""权限不足"绝不能触发回退 —— 那会让 copy 覆盖别人的文件
        for kind in [
            std::io::ErrorKind::AlreadyExists,
            std::io::ErrorKind::PermissionDenied,
            std::io::ErrorKind::NotFound,
        ] {
            assert!(!is_cross_device(&std::io::Error::from(kind)));
        }
    }
}
