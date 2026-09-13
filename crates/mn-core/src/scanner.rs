//! Vault 扫描：迭代式（不递归）遍历目录树，产出**扁平条目表**。
//!
//! 关键设计：
//!
//! * **迭代而非递归**：深度不可控的目录树不会爆栈；
//! * **默认不跟随符号链接**：避免链接环与越界读取；开启时逐级校验仍在根内；
//! * **忽略规则 + 条目上限**：1 万笔记级 Vault 的扫描预算 ≤800ms，且必须在
//!   `spawn_blocking` 里跑（见 ADR-0003），绝不占用主线程；
//! * **元数据只用 `DirEntry` 的缓存结果**：Windows 上 `DirEntry::file_type()` /
//!   `metadata()` 复用目录枚举返回的数据，而 `fs::symlink_metadata(path)` 每文件都要
//!   打开句柄 —— 1 万文件实测 145ms vs 2227ms（见 `examples/scan_bench.rs`）；
//! * **确定性顺序**：DFS 前序、同级按名称（小写不敏感）排序 —— 父目录一定在子项之前，
//!   前端可据此构建树，测试可稳定断言。
//!
//! 前端只接收本函数的产物，不做二次目录遍历。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::Serialize;

use crate::error::{Error, Result};

/// 单个条目元信息（跨 IPC 传给前端）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryMeta {
    /// Vault 相对路径，统一 `/` 分隔。
    pub rel_path: String,
    /// 文件/目录名（不含路径）。
    pub name: String,
    /// 是否目录。
    pub is_dir: bool,
    /// 文件字节数；目录为 0。
    pub size_bytes: u64,
    /// mtime（毫秒），不可得时为 `null`。
    pub mtime_ms: Option<u64>,
    /// 小写扩展名（不含点）；目录为 `null`。
    pub ext: Option<String>,
}

/// 扫描选项。
#[derive(Debug, Clone)]
pub struct ScanOptions {
    /// 条目总数上限，超出则 `truncated = true` 并停止。
    pub max_entries: usize,
    /// 目录深度上限（根为 0）。
    pub max_depth: usize,
    /// 忽略的目录名（不区分大小写）。
    pub ignore_dir_names: Vec<String>,
    /// 忽略的文件名（不区分大小写）。
    pub ignore_file_names: Vec<String>,
    /// 视为笔记的扩展名（小写，不含点）。
    pub note_extensions: Vec<String>,
    /// 是否包含以 `.` 开头的隐藏条目。
    pub include_hidden: bool,
    /// 是否跟随符号链接（跟随前会校验目标仍在 Vault 内）。
    pub follow_symlinks: bool,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            max_entries: 200_000,
            max_depth: 64,
            ignore_dir_names: [
                ".git",
                ".mimenote",
                ".obsidian",
                ".trash",
                ".svn",
                ".hg",
                "node_modules",
                "target",
                "dist",
                "__pycache__",
                "$RECYCLE.BIN",
                "System Volume Information",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect(),
            ignore_file_names: [".DS_Store", "Thumbs.db", "desktop.ini"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            note_extensions: ["md", "markdown"].iter().map(|s| s.to_string()).collect(),
            include_hidden: false,
            follow_symlinks: false,
        }
    }
}

/// 扫描结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    /// 扁平条目表（DFS 前序：父目录总是在其子项之前）。
    pub entries: Vec<EntryMeta>,
    /// Markdown 笔记数。
    pub note_count: usize,
    /// 目录数。
    pub folder_count: usize,
    /// 是否因达到 `max_entries` 而截断。
    pub truncated: bool,
    /// 因权限/链接等原因被跳过的条目数。
    pub skipped: usize,
    /// 扫描耗时（毫秒）。
    pub scan_ms: u64,
}

/// 扫描 `root` 下的目录树。
pub fn scan(root: &Path, opts: &ScanOptions) -> Result<ScanReport> {
    let started = Instant::now();
    if !root.is_dir() {
        return Err(Error::NotADirectory(crate::path_guard::display_path(root)));
    }

    let mut entries: Vec<EntryMeta> = Vec::new();
    let mut note_count = 0usize;
    let mut folder_count = 0usize;
    let mut skipped = 0usize;
    let mut truncated = false;

    // (目录绝对路径, 深度, 相对前缀)
    let mut stack: Vec<(PathBuf, usize, String)> = vec![(root.to_path_buf(), 0, String::new())];

    'walk: while let Some((dir, depth, prefix)) = stack.pop() {
        let read_dir = match fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };

        let mut children: Vec<(String, fs::DirEntry)> = Vec::new();
        for item in read_dir {
            match item {
                Ok(entry) => {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    children.push((name, entry));
                }
                Err(_) => skipped += 1,
            }
        }
        // 确定性顺序，便于测试与稳定渲染。
        children.sort_by(|a, b| {
            a.0.to_lowercase()
                .cmp(&b.0.to_lowercase())
                .then_with(|| a.0.cmp(&b.0))
        });

        let mut subdirs: Vec<(PathBuf, usize, String)> = Vec::new();
        for (name, entry) in children {
            if entries.len() >= opts.max_entries {
                truncated = true;
                break 'walk;
            }
            if !opts.include_hidden && name.starts_with('.') {
                continue;
            }

            // ⚡ 性能关键点（实测 1 万文件）：
            // `DirEntry::file_type()` / `DirEntry::metadata()` 在 Windows 上直接复用
            // 目录枚举已经返回的数据，无需额外系统调用（+7ms）；
            // 而 `fs::symlink_metadata(path)` 每个文件都要打开句柄，
            // 同一份数据实测慢 ~16 倍（2227ms vs 145ms）。
            let file_type = match entry.file_type() {
                Ok(kind) => kind,
                Err(_) => {
                    skipped += 1;
                    continue;
                }
            };
            let is_symlink = file_type.is_symlink();
            let path = entry.path();
            if is_symlink {
                if !opts.follow_symlinks {
                    continue;
                }
                if crate::path_guard::ensure_no_escape(root, &path).is_err() {
                    skipped += 1;
                    continue;
                }
            }
            let is_dir = if is_symlink {
                path.is_dir()
            } else {
                file_type.is_dir()
            };
            if is_dir {
                if is_ignored(&name, &opts.ignore_dir_names) {
                    continue;
                }
            } else if is_ignored(&name, &opts.ignore_file_names) {
                continue;
            }

            // 目录不需要 size/mtime（size 恒为 0），因此只对文件取元数据。
            let (size_bytes, mtime_ms) = if is_dir {
                (0, None)
            } else {
                match entry.metadata() {
                    Ok(meta) => (meta.len(), crate::atomic::mtime_ms(&meta)),
                    Err(_) => {
                        skipped += 1;
                        continue;
                    }
                }
            };

            let rel_path = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            let ext = if is_dir {
                None
            } else {
                path.extension()
                    .and_then(|e| e.to_str())
                    .map(|s| s.to_ascii_lowercase())
            };
            let is_note = !is_dir
                && ext.as_deref().is_some_and(|e| {
                    opts.note_extensions
                        .iter()
                        .any(|n| n.eq_ignore_ascii_case(e))
                });
            if is_note {
                note_count += 1;
            }
            if is_dir {
                folder_count += 1;
            }

            entries.push(EntryMeta {
                rel_path: rel_path.clone(),
                name,
                is_dir,
                size_bytes,
                mtime_ms,
                ext,
            });

            if is_dir && depth < opts.max_depth {
                subdirs.push((path, depth + 1, rel_path));
            }
        }

        // 逆序入栈 → 出栈顺序与排序一致。
        for item in subdirs.into_iter().rev() {
            stack.push(item);
        }
    }

    Ok(ScanReport {
        entries,
        note_count,
        folder_count,
        truncated,
        skipped,
        scan_ms: started.elapsed().as_millis() as u64,
    })
}

fn is_ignored(name: &str, list: &[String]) -> bool {
    list.iter().any(|n| n.eq_ignore_ascii_case(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_tree(root: &Path) {
        let w = |p: &str, c: &str| {
            let full = root.join(p);
            fs::create_dir_all(full.parent().unwrap()).unwrap();
            fs::write(full, c).unwrap();
        };
        w("a.md", "# a");
        w("b.markdown", "# b");
        w("notes/c.md", "# c");
        w("notes/deep/d.md", "# d");
        w("notes/image.png", "png");
        w(".hidden/e.md", "# e");
        w(".git/config", "git");
        w("node_modules/pkg/index.md", "# nope");
        w("Thumbs.db", "x");
    }

    #[test]
    fn scans_expected_entries_and_counts() {
        let dir = tempfile::tempdir().unwrap();
        make_tree(dir.path());

        let report = scan(dir.path(), &ScanOptions::default()).unwrap();
        let paths: Vec<&str> = report.entries.iter().map(|e| e.rel_path.as_str()).collect();

        assert!(paths.contains(&"a.md"));
        assert!(paths.contains(&"b.markdown"));
        assert!(paths.contains(&"notes/c.md"));
        assert!(paths.contains(&"notes/deep/d.md"));
        assert!(paths.contains(&"notes/image.png"));
        // 忽略：隐藏目录、.git、node_modules、Thumbs.db
        assert!(!paths.iter().any(|p| p.starts_with(".hidden")));
        assert!(!paths.iter().any(|p| p.starts_with(".git")));
        assert!(!paths.iter().any(|p| p.starts_with("node_modules")));
        assert!(!paths.iter().any(|p| p.starts_with("Thumbs.db")));

        assert_eq!(report.note_count, 4, "a/b/c/d 共 4 篇笔记");
        // notes、notes/deep（.hidden/.git/node_modules 被忽略，不计入）
        assert_eq!(report.folder_count, 2);
        assert!(!report.truncated);
        assert_eq!(report.skipped, 0);
    }

    #[test]
    fn parent_entries_precede_children() {
        let dir = tempfile::tempdir().unwrap();
        make_tree(dir.path());
        let report = scan(dir.path(), &ScanOptions::default()).unwrap();
        let index_of = |target: &str| {
            report
                .entries
                .iter()
                .position(|e| e.rel_path == target)
                .unwrap_or_else(|| panic!("缺少 {target}"))
        };
        assert!(index_of("notes") < index_of("notes/c.md"));
        assert!(index_of("notes") < index_of("notes/deep"));
        assert!(index_of("notes/deep") < index_of("notes/deep/d.md"));
    }

    #[test]
    fn hidden_entries_included_when_requested() {
        let dir = tempfile::tempdir().unwrap();
        make_tree(dir.path());
        let opts = ScanOptions {
            include_hidden: true,
            ignore_dir_names: vec![".git".into(), "node_modules".into()],
            ..ScanOptions::default()
        };
        let report = scan(dir.path(), &opts).unwrap();
        assert!(report.entries.iter().any(|e| e.rel_path == ".hidden/e.md"));
    }

    #[test]
    fn respects_max_entries_and_reports_truncation() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..25 {
            fs::write(dir.path().join(format!("n{i:02}.md")), "x").unwrap();
        }
        let opts = ScanOptions {
            max_entries: 10,
            ..ScanOptions::default()
        };
        let report = scan(dir.path(), &opts).unwrap();
        assert_eq!(report.entries.len(), 10);
        assert!(report.truncated);
    }

    #[test]
    fn respects_max_depth() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("l1/l2/l3")).unwrap();
        fs::write(dir.path().join("l1/l2/l3/deep.md"), "x").unwrap();
        fs::write(dir.path().join("l1/shallow.md"), "x").unwrap();
        let opts = ScanOptions {
            max_depth: 1,
            ..ScanOptions::default()
        };
        let report = scan(dir.path(), &opts).unwrap();
        let paths: Vec<&str> = report.entries.iter().map(|e| e.rel_path.as_str()).collect();
        assert!(paths.contains(&"l1/shallow.md"));
        assert!(!paths.iter().any(|p| p.contains("l3")));
    }

    #[test]
    fn scan_rejects_non_directory() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.md");
        fs::write(&file, "x").unwrap();
        assert_eq!(
            scan(&file, &ScanOptions::default()).unwrap_err().code(),
            crate::ErrorCode::NotADirectory
        );
    }

    /// 性能基准：1 万文件的扫描耗时（默认 ignore，因为会真的创建 1 万个文件）。
    ///
    /// 运行：`cargo test -p mn-core --release -- --ignored --nocapture bench_scan_10k_notes`
    /// 更细的分阶段数据：`cargo run -p mn-core --release --example scan_bench`
    #[test]
    #[ignore]
    fn bench_scan_10k_notes() {
        let dir = tempfile::tempdir().unwrap();
        for d in 0..100 {
            let sub = dir.path().join(format!("dir{d:03}"));
            fs::create_dir_all(&sub).unwrap();
            for f in 0..100 {
                fs::write(sub.join(format!("note{f:03}.md")), "# hello\n\nworld\n").unwrap();
            }
        }
        let report = scan(dir.path(), &ScanOptions::default()).unwrap();
        assert_eq!(report.entries.len(), 10_100);
        eprintln!("scan 10100 条（含 100 目录）：{} ms", report.scan_ms);
        // 预算 800ms；这里放宽到 1500ms 作为回归门禁（CI 机器可能更慢）
        assert!(
            report.scan_ms <= 1500,
            "扫描耗时超回归阈值：{}ms（预算 800ms）",
            report.scan_ms
        );
    }
}
