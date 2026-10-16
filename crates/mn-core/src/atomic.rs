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

/// 把**整棵目录树**从 `from` 搬到 `to`：优先一次原子 `rename`，跨卷时退回"复制 + 删源"。
///
/// 为什么目录整体 `rename` 而不是"逐文件搬"：同卷内它是一个系统调用（与子树大小无关），
/// 而且**整体成败**——绝不会出现"搬了一半"的中间态。逐文件搬会把这两条同时丢掉：
/// 1000 篇目录要 1000 次系统调用，且中途失败就留下一个"半棵子树"。
///
/// 跨卷（Vault 里有指向另一个卷的联接目录）时 `rename` 必然失败，退回递归复制 + 删源：
/// 那条路**没有原子性**（中途崩溃会留下"源和目标各半份"），因此只在必然失败时才走，
/// 与 [`move_file`] 的取舍一致；删源失败时把刚复制的目标撤掉再报错，宁可"什么都没发生"。
pub fn move_dir(from: &Path, to: &Path) -> Result<MoveMethod> {
    match fs::rename(from, to) {
        Ok(()) => Ok(MoveMethod::Rename),
        Err(error) if is_cross_device(&error) && !to.exists() => copy_dir_then_remove(from, to),
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

/// 递归复制整棵目录树（回退路径）。成功返回 [`MoveMethod::CopyAndDelete`]。
///
/// 用 `read_dir` 的 `file_type()` 而不是逐路径 `symlink_metadata`：后者在 Windows 上每个
/// 文件都要重新打开句柄（1 万文件实测 14 倍代价，见 architecture.md §6）。符号链接按**链接本身**
/// 复制而不跟随 —— `fs::copy` 会解引用，把链接目标的内容写进 Vault；指向外部的链接就会把
/// 外面的文件搬进来，随后源目录被删，原链接也没了。保留不了链接时直接失败，源目录不动。
///
/// 复制中途失败时撤掉这次创建的目标树。留下半棵树的话，重试会因为目标已存在而失败，
/// 用户也分不清那是不是一次成功的移动。
fn copy_dir_then_remove(from: &Path, to: &Path) -> Result<MoveMethod> {
    if let Err(error) = copy_dir(from, to) {
        return Err(rollback_copied_tree(to, error));
    }
    if let Err(error) = fs::remove_dir_all(from) {
        if let Err(cleanup) = fs::remove_dir_all(to) {
            return Err(Error::Io {
                path: to.to_string_lossy().into_owned(),
                source: std::io::Error::new(
                    cleanup.kind(),
                    format!("复制后删除源目录失败（{error}），且无法撤销副本（{cleanup}）"),
                ),
            });
        }
        return Err(Error::io(from, error));
    }
    Ok(MoveMethod::CopyAndDelete)
}

fn copy_dir(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir_all(to).map_err(|e| Error::io(to, e))?;
    let entries = fs::read_dir(from).map_err(|e| Error::io(from, e))?;
    for entry in entries {
        let entry = entry.map_err(|e| Error::io(from, e))?;
        let source = entry.path();
        let target = to.join(entry.file_name());
        let file_type = entry.file_type().map_err(|e| Error::io(&source, e))?;
        // 先看链接：指向目录的符号链接 `is_dir()` 为假（不跟随），但若漏判，
        // 下一支会把它当普通文件交给 `fs::copy`，那一步会把目标内容复制进来。
        if file_type.is_symlink() {
            copy_symlink(&source, &target)?;
        } else if file_type.is_dir() {
            copy_dir(&source, &target)?;
        } else {
            fs::copy(&source, &target).map_err(|e| Error::io(&target, e))?;
        }
    }
    Ok(())
}

/// 复制失败后删掉目标树。删不掉时把残留路径写进错误：源还在，但目标上可能有半份内容。
fn rollback_copied_tree(to: &Path, error: Error) -> Error {
    if !to.exists() {
        return error;
    }
    match fs::remove_dir_all(to) {
        Ok(()) => error,
        Err(cleanup) => Error::Io {
            path: to.to_string_lossy().into_owned(),
            source: std::io::Error::new(
                cleanup.kind(),
                format!("复制目录失败（{error}），且无法删除残留目标（{cleanup}）"),
            ),
        },
    }
}

/// 按链接本身复制：新链接的目标字符串与原来逐字相同（相对路径不改写成绝对路径）。
fn copy_symlink(from: &Path, to: &Path) -> Result<()> {
    let original = fs::read_link(from).map_err(|e| Error::io(from, e))?;
    create_symlink(from, &original, to).map_err(|error| Error::Io {
        path: to.to_string_lossy().into_owned(),
        source: std::io::Error::new(
            error.kind(),
            format!("无法保留符号链接，已拒绝跟随目标复制：{error}"),
        ),
    })
}

#[cfg(unix)]
fn create_symlink(_source: &Path, original: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(original, link)
}

#[cfg(windows)]
fn create_symlink(source: &Path, original: &Path, link: &Path) -> std::io::Result<()> {
    // 只为了在 Windows 上挑选 `symlink_dir` / `symlink_file`。写进新链接的仍是
    // `read_link` 拿到的原始目标。目标不存在时按文件链接处理（目录链接的目标一般还在）。
    if fs::metadata(source).is_ok_and(|meta| meta.is_dir()) {
        std::os::windows::fs::symlink_dir(original, link)
    } else {
        std::os::windows::fs::symlink_file(original, link)
    }
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
    fn moves_a_whole_directory_tree_in_one_step() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("项目");
        fs::create_dir_all(from.join("子/更深")).unwrap();
        fs::create_dir_all(from.join("空目录")).unwrap();
        fs::write(from.join("甲.md"), "# 甲\n").unwrap();
        fs::write(from.join("子").join("乙.md"), "# 乙\n").unwrap();
        fs::write(from.join("子/更深").join("图.png"), [0xff, 0x00, 0xfe]).unwrap();

        let to = dir.path().join("归档").join("项目");
        fs::create_dir_all(dir.path().join("归档")).unwrap();
        assert_eq!(move_dir(&from, &to).unwrap(), MoveMethod::Rename);

        assert!(!from.exists(), "源目录必须整体消失");
        assert_eq!(fs::read_to_string(to.join("甲.md")).unwrap(), "# 甲\n");
        assert_eq!(fs::read_to_string(to.join("子/乙.md")).unwrap(), "# 乙\n");
        assert_eq!(
            fs::read(to.join("子/更深").join("图.png")).unwrap(),
            vec![0xff, 0x00, 0xfe],
            "非 UTF-8 的附件也要逐字节搬过去"
        );
        assert!(to.join("空目录").is_dir(), "空目录同样是树的一部分");
    }

    #[test]
    fn move_dir_reports_an_io_error_instead_of_merging_into_an_existing_target() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("项目");
        fs::create_dir_all(&from).unwrap();
        fs::write(from.join("甲.md"), "# 甲\n").unwrap();
        // 目标已经是个目录：Windows 上 `rename` 到已存在的目录是失败（不是合并），
        // 这一条把"绝不覆盖/绝不合并"钉在原子层上
        let to = dir.path().join("归档");
        fs::create_dir_all(&to).unwrap();
        fs::write(to.join("别人的.md"), "# 别人的\n").unwrap();

        assert!(move_dir(&from, &to).is_err());
        assert!(from.join("甲.md").exists(), "失败时源必须原样留着");
        assert_eq!(
            fs::read_to_string(to.join("别人的.md")).unwrap(),
            "# 别人的\n"
        );
    }

    #[test]
    fn copy_dir_fallback_reproduces_the_whole_tree() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("项目");
        fs::create_dir_all(from.join("子")).unwrap();
        fs::write(from.join("甲.md"), "# 甲\n").unwrap();
        fs::write(from.join("子").join("乙.md"), "# 乙\n").unwrap();
        let to = dir.path().join("归档");

        assert_eq!(
            copy_dir_then_remove(&from, &to).unwrap(),
            MoveMethod::CopyAndDelete
        );
        assert!(!from.exists());
        assert_eq!(fs::read_to_string(to.join("甲.md")).unwrap(), "# 甲\n");
        assert_eq!(fs::read_to_string(to.join("子/乙.md")).unwrap(), "# 乙\n");
    }

    #[test]
    fn copy_dir_fallback_keeps_a_file_symlink_instead_of_copying_its_target() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("项目");
        fs::create_dir_all(&from).unwrap();
        fs::write(from.join("真身.md"), "链接指向的内容\n").unwrap();
        let link = from.join("链接.md");
        #[cfg(windows)]
        let created = std::os::windows::fs::symlink_file("真身.md", &link).is_ok();
        #[cfg(unix)]
        let created = std::os::unix::fs::symlink("真身.md", &link).is_ok();
        if !created {
            eprintln!("跳过：当前环境不允许创建符号链接（需要开发者模式/管理员）");
            return;
        }

        let to = dir.path().join("归档");
        copy_dir(&from, &to).unwrap();

        let copied = to.join("链接.md");
        assert!(
            fs::symlink_metadata(&copied)
                .unwrap()
                .file_type()
                .is_symlink(),
            "回退路径必须留下链接本身，不能把目标文件的内容复制成普通文件"
        );
        assert_eq!(fs::read_link(&copied).unwrap(), PathBuf::from("真身.md"));
        assert_eq!(
            fs::read_to_string(&copied).unwrap(),
            "链接指向的内容\n",
            "相对链接在新目录里仍然指向一起复制过去的那个文件"
        );
        assert!(from.exists(), "只调用 copy_dir 时源目录还在");
    }

    #[test]
    fn copy_dir_fallback_removes_the_partial_target_when_a_copy_fails() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("项目");
        fs::create_dir_all(&from).unwrap();
        fs::write(from.join("甲.md"), "# 甲\n").unwrap();
        // 目标位置已经是目录：`fs::copy` 写不进去。复制会先建好 `归档/`，失败后必须拆掉。
        let to = dir.path().join("归档");
        fs::create_dir_all(&to).unwrap();
        fs::create_dir_all(to.join("甲.md")).unwrap();

        assert!(copy_dir_then_remove(&from, &to).is_err());
        assert_eq!(fs::read_to_string(from.join("甲.md")).unwrap(), "# 甲\n");
        assert!(
            !to.exists(),
            "复制失败后不能留下半棵目标树，否则重试会撞上已存在的目录"
        );
    }

    #[test]
    fn copy_dir_fallback_names_the_leftover_when_the_target_cannot_be_removed() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("项目");
        fs::create_dir_all(&from).unwrap();
        fs::write(from.join("甲.md"), "# 甲\n").unwrap();
        // `归档` 是普通文件：建目录失败，随后 `remove_dir_all` 也删不掉它。
        let to = dir.path().join("归档");
        fs::write(&to, "占位").unwrap();

        let err = copy_dir_then_remove(&from, &to).unwrap_err();
        assert_eq!(fs::read_to_string(from.join("甲.md")).unwrap(), "# 甲\n");
        assert_eq!(fs::read_to_string(&to).unwrap(), "占位");
        let message = err.to_string();
        assert!(
            message.contains("残留目标"),
            "清不掉目标时必须点名残留：{message}"
        );
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
