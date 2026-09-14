//! 回收站：删除一律「移动到 Vault 内 `.mimenote/trash`」并留下台账，不做 unlink。
//!
//! 理由（见 `docs/architecture.md` §5）：误删是笔记软件最不可接受的事故。
//! `.mimenote/` 默认被扫描器忽略，用户也可在 Git 里忽略它。
//! 台账 `index.jsonl` 每行一条记录，追加写入；M2 提供 UI 恢复。

use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::path_guard::VaultRoot;

/// 回收站目录（Vault 相对路径，`/` 分隔）。
pub const TRASH_REL_DIR: &str = ".mimenote/trash";

/// 管理目录（回收站、片段、配置都在这里）。
pub const META_DIR: &str = ".mimenote";

const TRASH_INDEX_FILE: &str = "index.jsonl";

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// 一条删除记录。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashRecord {
    /// 唯一 ID（时间戳 + 序号）。
    pub id: String,
    /// 被删除文件的原始 Vault 相对路径。
    pub original_rel_path: String,
    /// 在回收站中的 Vault 相对路径。
    pub stored_rel_path: String,
    /// 删除时间（毫秒时间戳）。
    pub deleted_at_ms: u64,
    /// 大小（字节；目录为递归求和）。
    pub size_bytes: u64,
    /// 是否目录。
    pub is_dir: bool,
}

/// 把 `rel_path` 指向的文件/目录移入回收站。
///
/// 调用方（IPC 层）必须已经拿到用户的**显式确认**。
pub fn move_to_trash(root: &VaultRoot, rel_path: &str) -> Result<TrashRecord> {
    let segments = crate::path_guard::validate_relative_path(rel_path)?;
    if segments[0].eq_ignore_ascii_case(META_DIR) {
        return Err(Error::invalid(rel_path, "不允许删除 .mimenote 管理目录"));
    }

    let source = root.resolve_existing(rel_path)?;
    let meta = fs::symlink_metadata(&source).map_err(|e| Error::io(&source, e))?;
    let is_dir = meta.is_dir();
    let size_bytes = if is_dir {
        dir_size(&source).unwrap_or(0)
    } else {
        meta.len()
    };

    let id = new_id();
    let original_name = source
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "unnamed".to_string());
    let stored_name = format!("{id}__{original_name}");

    let trash_dir = root.path().join(META_DIR).join("trash");
    fs::create_dir_all(&trash_dir).map_err(|e| Error::io(&trash_dir, e))?;
    let stored = trash_dir.join(&stored_name);

    match fs::rename(&source, &stored) {
        Ok(()) => {}
        Err(_) => {
            // 跨卷等情况：退化为复制 + 删除，并保证复制成功后才删除源。
            copy_recursive(&source, &stored)?;
            if is_dir {
                fs::remove_dir_all(&source).map_err(|e| Error::io(&source, e))?;
            } else {
                fs::remove_file(&source).map_err(|e| Error::io(&source, e))?;
            }
        }
    }

    let record = TrashRecord {
        id,
        original_rel_path: rel_path.replace('\\', "/"),
        stored_rel_path: format!("{TRASH_REL_DIR}/{stored_name}"),
        deleted_at_ms: crate::atomic::now_ms(),
        size_bytes,
        is_dir,
    };
    append_index(root, &record)?;
    Ok(record)
}

/// 读取回收站台账（按写入顺序）。
pub fn list_trash(root: &VaultRoot) -> Result<Vec<TrashRecord>> {
    let index = root.path().join(META_DIR).join(TRASH_INDEX_FILE);
    if !index.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(&index).map_err(|e| Error::io(&index, e))?;
    Ok(text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<TrashRecord>(l).ok())
        .collect())
}

/// 一次恢复的结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOutcome {
    /// 被恢复的那条台账记录（`original_rel_path` 是它当初被删的位置）。
    pub record: TrashRecord,
    /// 实际恢复到哪个 Vault 相对路径。
    pub restored_rel_path: String,
    /// 为了放回它，新建了哪些目录（自浅到深；没有新建则为空）。
    ///
    /// 为什么要报出来：删掉 `项目/甲.md` 之后又删掉了整个 `项目/`，恢复时必须把目录建回来 ——
    /// 界面得能说清"我顺手建了 2 个目录"，而不是让用户对着一棵树猜发生了什么。
    pub created_dirs: Vec<String>,
    /// 台账里是否已经没有它了（恢复成功一律 `true`；留着这个字段是为了 DTO 形状稳定）。
    pub removed_from_index: bool,
}

impl RestoreOutcome {
    /// 恢复到原位置（`restored_rel_path == record.original_rel_path`）？
    pub fn is_original_place(&self) -> bool {
        self.restored_rel_path == self.record.original_rel_path
    }
}

/// 把一条台账记录恢复到它**当初的位置**。
///
/// 三条纪律：
///
/// 1. **绝不覆盖**：目标位置已经有东西就 `ALREADY_EXISTS` 并原样留在回收站 ——
///    用户可能已经把一篇新笔记写到了那个名字上，静默覆盖比"删错文件"更糟。
///    界面的出路是 [`restore_as`]（换个名字放回去），而不是放宽这条判定；
/// 2. **只动台账里的东西，且只动 `.mimenote/trash` 之下的东西**：台账是磁盘上的普通
///    JSONL，手改一行就能让它指向 Vault 里任何文件。因此这里**逐条校验**：
///    `stored_rel_path` 必须真的是回收站目录下的一段（`path_guard` 会拒掉绝对路径、
///    `..`、符号链接与越界），否则 `PATH_INVALID`。没有这条，"恢复"就是一个任意文件移动原语；
/// 3. **先搬文件、后改台账**：反过来（先删台账）一旦搬失败，文件还在回收站里却再也没人知道
///    它原本叫什么；而先搬后改的最坏情况是"文件回去了、台账还留着一条" —— 再点一次恢复
///    会得到 `NOT_FOUND`，可自愈。
pub fn restore_from_trash(root: &VaultRoot, id: &str) -> Result<RestoreOutcome> {
    let record = find_record(root, id)?;
    restore_record(root, &record, &record.original_rel_path)
}

/// 把一条台账记录恢复到**指定位置**（"恢复为…"：原位置已被占用时的出路）。
///
/// `target_rel_path` 与删除一样受 `path_guard` 约束：不能指向 `.mimenote/`、不能越界。
pub fn restore_as(root: &VaultRoot, id: &str, target_rel_path: &str) -> Result<RestoreOutcome> {
    let record = find_record(root, id)?;
    restore_record(root, &record, target_rel_path)
}

fn find_record(root: &VaultRoot, id: &str) -> Result<TrashRecord> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err(Error::invalid(id, "回收站记录 ID 不能为空"));
    }
    list_trash(root)?
        .into_iter()
        .find(|record| record.id == trimmed)
        .ok_or_else(|| Error::NotFound(format!("回收站记录 {trimmed}")))
}

fn restore_record(
    root: &VaultRoot,
    record: &TrashRecord,
    target_rel_path: &str,
) -> Result<RestoreOutcome> {
    let target_segments = crate::path_guard::validate_relative_path(target_rel_path)?;
    if target_segments[0].eq_ignore_ascii_case(META_DIR) {
        return Err(Error::invalid(
            target_rel_path,
            "不能把回收站里的东西恢复到 .mimenote 管理目录",
        ));
    }

    // —— 来源必须是回收站里的东西（见函数文档第 2 条）——
    let stored_rel = record.stored_rel_path.replace('\\', "/");
    let under_trash = stored_rel.split('/').collect::<Vec<_>>();
    if under_trash.len() != 3
        || !under_trash[0].eq_ignore_ascii_case(META_DIR)
        || !under_trash[1].eq_ignore_ascii_case("trash")
    {
        return Err(Error::invalid(
            &record.stored_rel_path,
            "台账记录指向的不是回收站目录下的条目",
        ));
    }
    let source = root.resolve_existing(&stored_rel)?;

    // —— 目标不能已存在（见函数文档第 1 条）——
    let target = root.path().join(
        target_rel_path
            .replace('\\', "/")
            .split('/')
            .collect::<Vec<_>>()
            .join(std::path::MAIN_SEPARATOR_STR),
    );
    if fs::symlink_metadata(&target).is_ok() {
        return Err(Error::AlreadyExists(format!(
            "{target_rel_path}（先把那个文件移开，或用「恢复为…」换个名字）"
        )));
    }

    // —— 父目录缺了就补（删过整个目录的情况）——
    let mut created_dirs: Vec<String> = Vec::new();
    let mut accumulated = String::new();
    for segment in target_segments.iter().take(target_segments.len() - 1) {
        accumulated = if accumulated.is_empty() {
            segment.clone()
        } else {
            format!("{accumulated}/{segment}")
        };
        let dir = root.path().join(
            accumulated
                .split('/')
                .collect::<Vec<_>>()
                .join(std::path::MAIN_SEPARATOR_STR),
        );
        if fs::symlink_metadata(&dir).is_err() {
            fs::create_dir(&dir).map_err(|e| Error::io(&dir, e))?;
            created_dirs.push(accumulated.clone());
        }
    }

    // —— 搬回去（跨卷时退化为复制 + 删源，与删除同一条路径）——
    match fs::rename(&source, &target) {
        Ok(()) => {}
        Err(_) => {
            let is_dir = fs::symlink_metadata(&source)
                .map(|meta| meta.is_dir())
                .unwrap_or(record.is_dir);
            copy_recursive(&source, &target)?;
            if is_dir {
                fs::remove_dir_all(&source).map_err(|e| Error::io(&source, e))?;
            } else {
                fs::remove_file(&source).map_err(|e| Error::io(&source, e))?;
            }
        }
    }

    // —— 最后改台账（见函数文档第 3 条）——
    let removed_from_index = drop_index_entry(root, &record.id)?;

    Ok(RestoreOutcome {
        record: record.clone(),
        restored_rel_path: target_rel_path.replace('\\', "/"),
        created_dirs,
        removed_from_index,
    })
}

/// 从台账里删掉一条记录（重写整个文件：JSONL 是追加写入的，删行只能重写）。
///
/// 用 [`crate::atomic::write_atomic`] 重写而不是就地截断：截断过程中断电会留下半截台账，
/// 而台账是"用户还能不能找回删掉的东西"的唯一依据。
fn drop_index_entry(root: &VaultRoot, id: &str) -> Result<bool> {
    let index = root.path().join(META_DIR).join(TRASH_INDEX_FILE);
    if !index.exists() {
        return Ok(false);
    }
    let text = fs::read_to_string(&index).map_err(|e| Error::io(&index, e))?;
    let mut kept: Vec<&str> = Vec::new();
    let mut removed = false;
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let matches = serde_json::from_str::<TrashRecord>(line)
            .map(|record| record.id == id)
            .unwrap_or(false);
        if matches {
            removed = true;
            continue;
        }
        kept.push(line);
    }
    if !removed {
        return Ok(false);
    }
    let mut next = kept.join("\n");
    if !next.is_empty() {
        next.push('\n');
    }
    crate::atomic::write_atomic(&index, next.as_bytes())?;
    Ok(true)
}

fn append_index(root: &VaultRoot, record: &TrashRecord) -> Result<()> {
    let dir = root.path().join(META_DIR);
    fs::create_dir_all(&dir).map_err(|e| Error::io(&dir, e))?;
    let index = dir.join(TRASH_INDEX_FILE);
    let line = serde_json::to_string(record).map_err(|e| Error::io(&index, e.into()))?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&index)
        .map_err(|e| Error::io(&index, e))?;
    file.write_all(line.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|e| Error::io(&index, e))?;
    Ok(())
}

fn new_id() -> String {
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}-{seq:04}", crate::atomic::now_ms())
}

fn dir_size(dir: &Path) -> Result<u64> {
    let mut total = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let read_dir = match fs::read_dir(&current) {
            Ok(rd) => rd,
            Err(e) => return Err(Error::io(&current, e)),
        };
        for item in read_dir.flatten() {
            let path = item.path();
            let meta = match fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                stack.push(path);
            } else {
                total += meta.len();
            }
        }
    }
    Ok(total)
}

fn copy_recursive(source: &Path, target: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(source).map_err(|e| Error::io(source, e))?;
    if meta.is_dir() {
        fs::create_dir_all(target).map_err(|e| Error::io(target, e))?;
        for item in fs::read_dir(source)
            .map_err(|e| Error::io(source, e))?
            .flatten()
        {
            let name = item.file_name();
            copy_recursive(&item.path(), &target.join(name))?;
        }
    } else {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| Error::io(parent, e))?;
        }
        fs::copy(source, target).map_err(|e| Error::io(target, e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_file_to_trash_and_records_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        fs::create_dir_all(dir.path().join("notes")).unwrap();
        fs::write(dir.path().join("notes/gone.md"), "# 再见").unwrap();

        let record = move_to_trash(&root, "notes/gone.md").unwrap();
        assert_eq!(record.original_rel_path, "notes/gone.md");
        assert!(!record.is_dir);
        assert!(record.size_bytes > 0);
        assert!(record.stored_rel_path.starts_with(TRASH_REL_DIR));

        // 原位置已消失，回收站中存在且内容完好
        assert!(!dir.path().join("notes/gone.md").exists());
        let stored = root
            .path()
            .join(".mimenote/trash")
            .join(record.stored_rel_path.rsplit('/').next().unwrap());
        assert_eq!(fs::read_to_string(&stored).unwrap(), "# 再见");

        let listed = list_trash(&root).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, record.id);
    }

    #[test]
    fn moves_directory_to_trash_with_size() {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        fs::create_dir_all(dir.path().join("folder/sub")).unwrap();
        fs::write(dir.path().join("folder/sub/a.md"), "12345").unwrap();

        let record = move_to_trash(&root, "folder").unwrap();
        assert!(record.is_dir);
        assert_eq!(record.size_bytes, 5);
        assert!(!dir.path().join("folder").exists());
    }

    #[test]
    fn refuses_meta_dir_and_bad_paths() {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        assert!(move_to_trash(&root, ".mimenote/trash").is_err());
        assert_eq!(
            move_to_trash(&root, "../outside.md").unwrap_err().code(),
            crate::ErrorCode::PathInvalid
        );
        assert_eq!(
            move_to_trash(&root, "missing.md").unwrap_err().code(),
            crate::ErrorCode::NotFound
        );
    }

    #[test]
    fn index_is_append_only_jsonl() {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        fs::write(dir.path().join("a.md"), "a").unwrap();
        fs::write(dir.path().join("b.md"), "b").unwrap();
        move_to_trash(&root, "a.md").unwrap();
        move_to_trash(&root, "b.md").unwrap();

        let index = fs::read_to_string(dir.path().join(".mimenote/index.jsonl")).unwrap();
        assert_eq!(index.lines().count(), 2);
        let listed = list_trash(&root).unwrap();
        assert_eq!(listed.len(), 2);
        assert_ne!(listed[0].id, listed[1].id, "ID 必须唯一");
    }

    // -- 恢复（M2 承诺过、一直没做的那半）------------------------------------------------

    #[test]
    fn restore_puts_the_file_back_and_clears_the_entry() {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        fs::create_dir_all(dir.path().join("notes")).unwrap();
        fs::write(dir.path().join("notes/gone.md"), "# 再见\n正文").unwrap();

        let record = move_to_trash(&root, "notes/gone.md").unwrap();
        assert_eq!(list_trash(&root).unwrap().len(), 1);

        let outcome = restore_from_trash(&root, &record.id).unwrap();
        assert!(outcome.is_original_place());
        assert_eq!(outcome.restored_rel_path, "notes/gone.md");
        assert!(outcome.created_dirs.is_empty(), "父目录一直在，不该新建");
        assert!(outcome.removed_from_index);

        // 内容逐字节回来，台账里不再有它 —— 再点一次恢复应当是 NOT_FOUND
        assert_eq!(
            fs::read_to_string(dir.path().join("notes/gone.md")).unwrap(),
            "# 再见\n正文"
        );
        assert!(list_trash(&root).unwrap().is_empty());
        assert_eq!(
            restore_from_trash(&root, &record.id).unwrap_err().code(),
            crate::ErrorCode::NotFound
        );
    }

    #[test]
    fn restore_refuses_to_overwrite_something_that_took_the_place() {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        fs::write(dir.path().join("a.md"), "旧").unwrap();
        let record = move_to_trash(&root, "a.md").unwrap();

        // 用户已经把一篇新笔记写到了同一个名字上
        fs::write(dir.path().join("a.md"), "新的内容").unwrap();

        let error = restore_from_trash(&root, &record.id).unwrap_err();
        assert_eq!(error.code(), crate::ErrorCode::AlreadyExists);
        assert_eq!(
            fs::read_to_string(dir.path().join("a.md")).unwrap(),
            "新的内容",
            "绝不覆盖占位者"
        );
        assert_eq!(
            list_trash(&root).unwrap().len(),
            1,
            "失败之后台账与回收站都要原样留着，让用户能换名字再来"
        );

        // 出路：换个名字恢复
        let outcome = restore_as(&root, &record.id, "项目/a（恢复）.md").unwrap();
        assert_eq!(outcome.restored_rel_path, "项目/a（恢复）.md");
        assert_eq!(outcome.created_dirs, vec!["项目".to_string()]);
        assert_eq!(
            fs::read_to_string(dir.path().join("项目/a（恢复）.md")).unwrap(),
            "旧"
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("a.md")).unwrap(),
            "新的内容"
        );
    }

    #[test]
    fn restore_recreates_missing_parent_directories() {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        fs::create_dir_all(dir.path().join("项目/子项目")).unwrap();
        fs::write(dir.path().join("项目/子项目/甲.md"), "甲").unwrap();

        let record = move_to_trash(&root, "项目/子项目/甲.md").unwrap();
        fs::remove_dir_all(dir.path().join("项目")).unwrap();

        let outcome = restore_from_trash(&root, &record.id).unwrap();
        assert_eq!(
            outcome.created_dirs,
            vec!["项目".to_string(), "项目/子项目".to_string()],
            "自浅到深报告新建了哪些目录"
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("项目/子项目/甲.md")).unwrap(),
            "甲"
        );
    }

    #[test]
    fn restore_moves_a_whole_directory_back() {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        fs::create_dir_all(dir.path().join("folder/sub")).unwrap();
        fs::write(dir.path().join("folder/sub/a.md"), "a").unwrap();
        let record = move_to_trash(&root, "folder").unwrap();

        let outcome = restore_from_trash(&root, &record.id).unwrap();
        assert!(outcome.record.is_dir);
        assert_eq!(
            fs::read_to_string(dir.path().join("folder/sub/a.md")).unwrap(),
            "a"
        );
    }

    #[test]
    fn restore_refuses_paths_that_are_not_under_the_trash() {
        // 台账是磁盘上的普通 JSONL：手改一行就能让它指向 Vault 里的**任意**文件。
        // 没有这条校验，"恢复"就成了一个任意文件移动原语。
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        fs::write(dir.path().join("重要.md"), "不能被我搬走").unwrap();
        let record = move_to_trash(&root, "重要.md").unwrap();

        for stored in [
            "重要.md",
            "../重要.md",
            ".mimenote/trash/../重要.md",
            "/etc/passwd",
        ] {
            let tampered = TrashRecord {
                stored_rel_path: stored.to_string(),
                ..record.clone()
            };
            rewrite_index(&root, &[tampered]);
            let error = restore_from_trash(&root, &record.id).unwrap_err();
            assert!(
                matches!(
                    error.code(),
                    crate::ErrorCode::PathInvalid | crate::ErrorCode::PathEscape
                ),
                "台账指向 {stored} 时应当被拒，实际是 {:?}",
                error.code()
            );
            assert!(
                !dir.path().join("重要.md").exists(),
                "被篡改的台账不该让文件被搬动（{stored}）"
            );
        }
    }

    #[test]
    fn restore_refuses_meta_dir_as_target() {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        fs::write(dir.path().join("a.md"), "a").unwrap();
        let record = move_to_trash(&root, "a.md").unwrap();

        let error = restore_as(&root, &record.id, ".mimenote/trash/a.md").unwrap_err();
        assert_eq!(error.code(), crate::ErrorCode::PathInvalid);
        assert_eq!(list_trash(&root).unwrap().len(), 1);
    }

    #[test]
    fn restore_reports_unknown_ids_as_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        assert_eq!(
            restore_from_trash(&root, "不存在的-id").unwrap_err().code(),
            crate::ErrorCode::NotFound
        );
        assert_eq!(
            restore_from_trash(&root, "  ").unwrap_err().code(),
            crate::ErrorCode::PathInvalid
        );
    }

    /// 重写台账（测试里模拟"手改过的台账"）。
    fn rewrite_index(root: &VaultRoot, records: &[TrashRecord]) {
        let index = root.path().join(META_DIR).join(TRASH_INDEX_FILE);
        let text: String = records
            .iter()
            .map(|record| format!("{}\n", serde_json::to_string(record).unwrap()))
            .collect();
        crate::atomic::write_atomic(&index, text.as_bytes()).unwrap();
    }
}
