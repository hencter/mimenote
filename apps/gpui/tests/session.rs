use std::fs;

use mn_core::ErrorCode;
use mimenote_gpui::VaultSession;

/// 直接调用发布的 [`VaultSession`]：扫描、读取、原子保存、过期令牌、全文搜索、双链。
#[test]
fn session_scans_reads_saves_searches_and_links() {
    let dir = tempfile::tempdir().expect("临时库");
    let source = dir.path().join("source.md");
    let target = dir.path().join("日记").join("target.md");
    fs::create_dir_all(target.parent().expect("日记目录")).expect("创建目录");
    let source_text = "see [[target]] and zephyrquill\n";
    fs::write(&source, source_text).expect("写入来源");
    fs::write(&target, "被链接的笔记\n").expect("写入目标");

    let mut session = VaultSession::open(dir.path()).expect("打开库");
    let notes: Vec<String> = session
        .notes()
        .iter()
        .map(|entry| entry.rel_path.clone())
        .collect();
    assert!(notes.iter().any(|path| path == "source.md"), "{notes:?}");
    assert!(
        notes.iter().any(|path| path == "日记/target.md"),
        "{notes:?}"
    );

    let document = session.read("source.md").expect("读取");
    assert_eq!(document.text, source_text);

    let found = session.search("zephyrquill").expect("搜索");
    assert!(
        found.hits.iter().any(|hit| hit.rel_path == "source.md"),
        "{:?}",
        found.hits
    );

    let outbound = session.note_links("source.md");
    assert!(
        outbound.outbound.iter().any(|link| {
            link.resolved_rel_path.as_deref() == Some("日记/target.md")
        }),
        "{:?}",
        outbound.outbound
    );
    let backlinks = session.note_links("日记/target.md");
    assert!(
        backlinks
            .backlinks
            .iter()
            .any(|link| link.from_rel_path == "source.md"),
        "{:?}",
        backlinks.backlinks
    );

    let updated = format!("{source_text}quillstone\n");
    let saved = session
        .save("source.md", &updated, Some(document.mtime_ms))
        .expect("保存");
    assert_eq!(fs::read(&source).expect("读盘"), updated.as_bytes());
    assert_ne!(saved.mtime_ms, document.mtime_ms, "保存后 mtime 应该前进");

    let indexed = session.search("quillstone").expect("保存后搜索");
    assert!(
        indexed.hits.iter().any(|hit| hit.rel_path == "source.md"),
        "{:?}",
        indexed.hits
    );

    let before = fs::read(&source).expect("冲突前读盘");
    let error = session
        .save("source.md", "stale write", Some(document.mtime_ms))
        .expect_err("过期令牌");
    assert_eq!(error.code(), ErrorCode::Conflict);
    assert_eq!(fs::read(&source).expect("冲突后读盘"), before);
}

/// 新建、改名改写链接、回收站恢复、属性与标签都走发布的会话。
#[test]
fn session_creates_renames_trashes_and_reads_panel() {
    let dir = tempfile::tempdir().expect("临时库");
    fs::write(
        dir.path().join("b.md"),
        "---\ntitle: 目标\ntags:\n  - 主题\n---\n#主题\n",
    )
    .expect("写入目标");
    fs::write(dir.path().join("a.md"), "see [[b]]\n").expect("写入来源");

    let mut session = VaultSession::open(dir.path()).expect("打开库");
    let created = session.create_note("新建").expect("新建");
    assert_eq!(created.rel_path, "新建.md");
    assert_eq!(
        fs::read(dir.path().join("新建.md")).expect("读新建"),
        created.text.as_bytes()
    );

    let panel = session.panel("b.md", &session.read("b.md").expect("读 b").text);
    assert!(panel.tags.iter().any(|tag| tag == "主题"), "{:?}", panel.tags);
    assert!(
        panel.properties.iter().any(|(key, value)| key == "title" && value == "目标"),
        "{:?}",
        panel.properties
    );
    assert!(panel.words > 0);
    assert!(
        panel.backlinks.iter().any(|path| path == "a.md"),
        "{:?}",
        panel.backlinks
    );

    let report = session.rename_note("b.md", "c").expect("改名");
    assert_eq!(report.new_rel_path, "c.md");
    let rewritten = String::from_utf8(fs::read(dir.path().join("a.md")).expect("读来源")).expect("utf8");
    assert!(rewritten.contains("[[c]]"), "{rewritten}");
    assert!(!dir.path().join("b.md").exists());

    let record = session.trash_note("c.md").expect("回收");
    assert!(!dir.path().join("c.md").exists());
    assert!(session.trash().expect("台账").iter().any(|item| item.id == record.id));

    let restored = session.restore_note(&record.id).expect("恢复");
    assert_eq!(restored, "c.md");
    assert!(dir.path().join("c.md").exists());
}
