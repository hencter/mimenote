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
}
