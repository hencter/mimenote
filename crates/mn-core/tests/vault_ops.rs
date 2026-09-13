//! `mn-core` 的集成测试：真实临时目录上的端到端文件层行为。
//!
//! 覆盖：扫描 → 读取 → 原子写 → 冲突检测（mtime 令牌）→ 回收站流程。

use std::fs;

use mn_core::atomic::{read_text, write_atomic};
use mn_core::path_guard::VaultRoot;
use mn_core::scanner::{scan, ScanOptions};
use mn_core::trash::{list_trash, move_to_trash};
use mn_core::{ErrorCode, DEFAULT_MAX_READ_BYTES};

fn seed_vault(root: &std::path::Path) {
    fs::create_dir_all(root.join("日记/2025")).unwrap();
    fs::create_dir_all(root.join("项目")).unwrap();
    fs::write(root.join("README.md"), "# Vault\n").unwrap();
    fs::write(root.join("日记/2025/01-01.md"), "# 元旦\n\n今天很好。\n").unwrap();
    fs::write(root.join("项目/设计.md"), "# 设计\n").unwrap();
    fs::write(root.join("项目/图.png"), "not-a-real-png").unwrap();
}

#[test]
fn full_file_layer_roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    let root = VaultRoot::open(dir.path()).unwrap();
    seed_vault(dir.path());

    // 1. 扫描
    let report = scan(root.path(), &ScanOptions::default()).unwrap();
    assert_eq!(report.note_count, 3);
    assert!(!report.truncated);
    let rel_paths: Vec<&str> = report.entries.iter().map(|e| e.rel_path.as_str()).collect();
    assert!(rel_paths.contains(&"日记/2025/01-01.md"));

    // 2. 读取（路径经防护解析）
    let target = root.resolve_existing("日记/2025/01-01.md").unwrap();
    let text = read_text(&target, DEFAULT_MAX_READ_BYTES).unwrap();
    assert!(text.contains("元旦"));
    let base_mtime = mn_core::atomic::path_mtime_ms(&target).unwrap();

    // 3. 原子写 + mtime 变化
    write_atomic(&target, "# 元旦（已编辑）\n".as_bytes()).unwrap();
    assert_eq!(
        read_text(&target, DEFAULT_MAX_READ_BYTES).unwrap(),
        "# 元旦（已编辑）\n"
    );
    let new_mtime = mn_core::atomic::path_mtime_ms(&target).unwrap();
    assert!(new_mtime >= base_mtime);

    // 4. 越界写入被拒绝（即便目标在磁盘上真实存在）
    let escape = root.resolve_for_write("../outside.md").unwrap_err();
    assert_eq!(escape.code(), ErrorCode::PathInvalid);

    // 5. 删除进回收站
    let record = move_to_trash(&root, "项目/图.png").unwrap();
    assert!(!dir.path().join("项目/图.png").exists());
    assert_eq!(list_trash(&root).unwrap().len(), 1);
    assert_eq!(record.original_rel_path, "项目/图.png");

    // 6. 重扫：笔记数不变（PNG 本就不计），条目少 1
    let after = scan(root.path(), &ScanOptions::default()).unwrap();
    assert_eq!(after.note_count, 3);
    assert_eq!(after.entries.len(), report.entries.len() - 1);
    // 回收站被忽略，不污染文件树
    assert!(!after
        .entries
        .iter()
        .any(|e| e.rel_path.starts_with(".mimenote")));
}

/// 模拟外部修改（用户用别的编辑器改了文件），验证 mtime 令牌能识别冲突。
#[test]
fn detects_external_modification_via_mtime_token() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("note.md");
    fs::write(&file, "v1").unwrap();

    let base = mn_core::atomic::path_mtime_ms(&file).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    // 外部程序改了内容
    fs::write(&file, "external edit").unwrap();
    let current = mn_core::atomic::path_mtime_ms(&file).unwrap();

    let conflict = current != base;
    assert!(conflict, "外部修改后 mtime 必须变化，否则无法识别冲突");

    // 应用侧若仍以 base 为基线保存，必须被上层拒绝（此处以断言表达契约）
    if current != base {
        let err = mn_core::Error::Conflict {
            current_mtime_ms: current.unwrap(),
        };
        assert_eq!(err.code(), ErrorCode::Conflict);
        assert_eq!(err.current_mtime_ms(), current);
    }
    // 外部内容未被破坏
    assert_eq!(fs::read_to_string(&file).unwrap(), "external edit");
}
