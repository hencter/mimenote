//! Vault 扫描基准（可重复、可对比）。
//!
//! 用法：
//! ```text
//! cargo run -p mn-core --release --example scan_bench            # 默认 10000 个文件
//! cargo run -p mn-core --release --example scan_bench 100000     # 更大规模
//! cargo run -p mn-core --release --example scan_bench 10000 --keep-dir ./.bench-vault
//! ```
//!
//! 输出分阶段耗时，用来判断瓶颈在**目录枚举**还是**元数据读取**：
//! - `read_dir only`：只枚举目录条目（不做任何 stat）
//! - `scan()`：完整扫描（含 mtime/size/忽略规则/排序）
//!
//! 为什么要有这个工具：性能预算（1 万笔记 ≤800ms）必须能在本机复现，
//! 并且优化前后有同一把尺子可量。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use mn_core::scanner::{scan, ScanOptions};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let file_count: usize = args
        .iter()
        .find_map(|arg| arg.parse::<usize>().ok())
        .unwrap_or(10_000);
    let keep_dir = args
        .iter()
        .position(|arg| arg == "--keep-dir")
        .and_then(|index| args.get(index + 1))
        .map(PathBuf::from);

    let (root, _temp) = match &keep_dir {
        Some(dir) => {
            fs::create_dir_all(dir).expect("创建基准目录失败");
            (dir.clone(), None)
        }
        None => {
            let temp = tempfile::tempdir().expect("创建临时目录失败");
            (temp.path().to_path_buf(), Some(temp))
        }
    };

    let created = seed_vault(&root, file_count);
    eprintln!("基准目录：{}（{created} 个文件）", root.display());

    // 0) 分阶段定位瓶颈：目录枚举 vs 每文件元数据
    let enumeration = time(|| enumerate_only(&root));
    println!("read_dir only            : {:>8.1} ms", ms(enumeration));

    let file_type = time(|| walk_with_entry_file_type(&root));
    println!("+ DirEntry::file_type()   : {:>8.1} ms", ms(file_type));

    let entry_meta = time(|| walk_with_entry_metadata(&root));
    println!("+ DirEntry::metadata()    : {:>8.1} ms", ms(entry_meta));

    let path_meta = time(|| walk_with_path_symlink_metadata(&root));
    println!("+ fs::symlink_metadata()  : {:>8.1} ms", ms(path_meta));

    // 1) 完整扫描 ×3
    for round in 1..=3 {
        let report = scan(&root, &ScanOptions::default()).expect("扫描失败");
        println!(
            "scan() round {round}           : {:>8.1} ms（{} 条目，{} 笔记，跳过 {}）",
            report.scan_ms,
            report.entries.len(),
            report.note_count,
            report.skipped
        );
    }

    // 2) 汇总：与性能预算对比
    let budget_ms = 800.0;
    let warm = scan(&root, &ScanOptions::default())
        .expect("扫描失败")
        .scan_ms as f64;
    println!(
        "热缓存扫描               : {:>8.1} ms（预算 {budget_ms:.0} ms → {}）",
        warm,
        if warm <= budget_ms {
            "达标"
        } else {
            "超标"
        }
    );
}

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

fn time(task: impl FnOnce()) -> Duration {
    let started = Instant::now();
    task();
    started.elapsed()
}

/// 只枚举目录条目，不做任何元数据查询。
fn enumerate_only(root: &Path) {
    walk(root, |_entry| {});
}

/// 枚举 + `DirEntry::file_type()`（Windows 上来自目录枚举结果，通常无额外系统调用）。
fn walk_with_entry_file_type(root: &Path) {
    walk(root, |entry| {
        let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        std::hint::black_box(is_dir);
    });
}

/// 枚举 + `DirEntry::metadata()`（需要 size/mtime）。
fn walk_with_entry_metadata(root: &Path) {
    walk(root, |entry| {
        if let Ok(meta) = entry.metadata() {
            std::hint::black_box((meta.len(), meta.modified().ok()));
        }
    });
}

/// 枚举 + `fs::symlink_metadata(path)`（当前实现的做法）。
fn walk_with_path_symlink_metadata(root: &Path) {
    walk(root, |entry| {
        if let Ok(meta) = fs::symlink_metadata(entry.path()) {
            std::hint::black_box((meta.len(), meta.modified().ok()));
        }
    });
}

fn walk(root: &Path, mut visit: impl FnMut(&fs::DirEntry)) {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(read_dir) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in read_dir.flatten() {
            let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
            if is_dir {
                stack.push(entry.path());
            }
            visit(&entry);
        }
    }
}

/// 生成 100 个目录 × file_count/100 个 Markdown 文件。
fn seed_vault(root: &Path, file_count: usize) -> usize {
    let dirs = 100usize;
    let per_dir = (file_count / dirs).max(1);
    let body = "# 标题\n\n正文内容，用于基准测试。\n";
    let mut created = 0usize;
    for dir_index in 0..dirs {
        let sub = root.join(format!("dir{dir_index:03}"));
        if !sub.is_dir() {
            fs::create_dir_all(&sub).expect("创建子目录失败");
        }
        for file_index in 0..per_dir {
            let path = sub.join(format!("note{file_index:03}.md"));
            if !path.exists() {
                fs::write(&path, body).expect("写文件失败");
                created += 1;
            }
        }
    }
    created
}
