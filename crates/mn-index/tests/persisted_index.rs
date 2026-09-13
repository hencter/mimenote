//! 跨会话复用（ADR-0014）的**不变量测试**。
//!
//! 这一层的核心承诺是："复用回来的索引"与"从零全量重建的索引"**逐条相同**。
//! 因此这里的每条测试都遵循同一个形状：
//!
//! 1. 造一个真实的小 Vault（真实文件、真实 mtime/size）；
//! 2. **复用侧**：打开缓存库 → 按 `(path, mtime, size)` 对账 → 可复用的装回内存；
//! 3. **对照侧**：把另一个库整个删掉，同一批文件从头重建；
//! 4. 把两侧的出链、反链、标签、标题、图谱与概况摊平成文本**逐条比对**。
//!
//! 只要有一条路径会在复用后变得陈旧 —— 漏了写盘、判错了"没变"、两半各自提交、
//! 或者落盘时丢了某个字段 —— 这个形状就会失败。

use std::path::{Path, PathBuf};
use std::time::Duration;

use mn_core::scanner::EntryMeta;
use mn_core::VaultRoot;
use mn_index::graph::MAX_GRAPH_NODES;
use mn_index::search::SearchIndex;
use mn_index::{build_indexes, BuildOptions, BuildOutcome, LinkIndex};
use rusqlite::Connection;

/// 缓存库相对 Vault 根的位置（与 `indexer::SEARCH_CACHE_REL` 同一个值）。
const DB_REL: &str = ".mimenote/cache/search.db";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

fn note_path(root: &Path, rel: &str) -> PathBuf {
    root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR))
}

fn write_note(root: &Path, rel: &str, text: &str) {
    let path = note_path(root, rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(&path, text).unwrap();
}

fn read_note(root: &Path, rel: &str) -> String {
    std::fs::read_to_string(note_path(root, rel)).unwrap()
}

/// 按磁盘上的**真实**元数据造一个条目：增量判定测的就是 mtime/size，假值测不出东西。
fn entry_of(root: &Path, rel: &str) -> EntryMeta {
    let path = note_path(root, rel);
    let meta = std::fs::metadata(&path).unwrap();
    EntryMeta {
        rel_path: rel.to_string(),
        name: path.file_name().unwrap().to_string_lossy().into_owned(),
        is_dir: false,
        size_bytes: meta.len(),
        mtime_ms: mn_core::atomic::mtime_ms(&meta),
        ext: Some("md".to_string()),
    }
}

fn entries_of(root: &Path, rels: &[String]) -> Vec<EntryMeta> {
    rels.iter().map(|rel| entry_of(root, rel)).collect()
}

/// 判定键：与索引层内部口径一致（毫秒 mtime + 字节数）。
fn stamp(entry: &EntryMeta) -> (Option<u64>, u64) {
    (entry.mtime_ms, entry.size_bytes)
}

/// 改写一篇笔记，并**保证**它的判定键真的变了。
///
/// 不变的话测的就不是"复用"，而是"同一毫秒 + 同字节数"的已知漏检边界：
/// 测试必须是确定的，所以这里要么让内容变长，要么等到毫秒过去。
fn rewrite_note(root: &Path, rel: &str, text: &str) -> EntryMeta {
    let before = entry_of(root, rel);
    write_note(root, rel, text);
    let mut after = entry_of(root, rel);
    if stamp(&after) == stamp(&before) {
        std::thread::sleep(Duration::from_millis(5));
        write_note(root, rel, text);
        after = entry_of(root, rel);
    }
    assert_ne!(stamp(&after), stamp(&before), "改写后判定键必须变：{rel}");
    after
}

/// 磁盘上真实存在的笔记（相对路径，字典序）。
///
/// 刻意**不用索引**来算它：比对的前提是"文件系统说了算"。
fn disk_notes(root: &Path) -> Vec<String> {
    fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
        for item in std::fs::read_dir(dir).unwrap() {
            let path = item.unwrap().path();
            if path.is_dir() {
                walk(&path, root, out);
                continue;
            }
            let rel = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            // 缓存库自己在 `.mimenote/` 下，当然不算笔记
            if rel.starts_with(".mimenote/") {
                continue;
            }
            if rel.ends_with(".md") || rel.ends_with(".markdown") {
                out.push(rel);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.sort();
    out
}

/// 宿主姿态的一轮构建：`SearchIndex::open` + `build_indexes`（与 `indexer::spawn_build` 同一条路径）。
fn build(root: &Path, search: &SearchIndex, entries: &[EntryMeta]) -> (LinkIndex, BuildOutcome) {
    let (index, outcome) = build_indexes(
        root,
        entries,
        &BuildOptions::default(),
        None,
        Some(search),
        |_, _| {},
    );
    assert!(!outcome.cancelled, "测试里不该被取消");
    (index, outcome)
}

/// 打开当前 Vault（复用侧：库跨轮保留）。
fn open_vault(root: &Path, db: &Path) -> (SearchIndex, LinkIndex, BuildOutcome) {
    let search = SearchIndex::open(db).unwrap();
    let rels = disk_notes(root);
    let entries = entries_of(root, &rels);
    let (index, outcome) = build(root, &search, &entries);
    (search, index, outcome)
}

/// 从零全量重建（对照侧：库每次都删掉）。
fn rebuild_from_scratch(root: &Path, db: &Path) -> (SearchIndex, LinkIndex) {
    let search = SearchIndex::open_for_rebuild(db).unwrap();
    let rels = disk_notes(root);
    let entries = entries_of(root, &rels);
    let (index, outcome) = build(root, &search, &entries);
    assert_eq!(
        outcome.reused_notes, 0,
        "对照侧必须是一篇都不复用的整库重建"
    );
    (search, index)
}

fn indexed_paths(index: &LinkIndex) -> Vec<String> {
    let mut paths = index.paths_under("");
    paths.sort();
    paths
}

/// 库里的落盘数据必须覆盖索引里的**每一篇**。
///
/// 这一条钉的是一类不会让结果出错的退化：某个写入口漏了写盘（或者把刚写进去的数据又删了），
/// 于是这一篇下次打开被迫重读文件 —— 逐条比对完全看不出问题，只有"库里少了一份数据"能看出来。
fn assert_all_persisted(db: &Path, index: &LinkIndex) {
    let stored: std::collections::HashSet<String> =
        query_rows(db, "SELECT path FROM link_notes", &[])
            .into_iter()
            .collect();
    for path in indexed_paths(index) {
        assert!(
            stored.contains(&path),
            "库里缺少 {path} 的落盘数据：这一篇下次打开会白读一次文件"
        );
    }
}

/// 索引的**逐条指纹**：所有对外可见的数据都摊平成可比较的文本。
///
/// 刻意覆盖每一种查询（出链、反链、标签、标题、概况、图谱节点与边、标签概览）：
/// "落盘漏了某个字段"只会在其中一件上露出来。
fn fingerprint(index: &mut LinkIndex, rels: &[String]) -> Vec<String> {
    let mut out = Vec::new();

    out.push(format!("路径={:?}", indexed_paths(index)));
    for rel in rels {
        let links = index.note_links(rel);
        out.push(format!(
            "{rel} 出链={:?} 悬空={} 反链={:?}",
            links.outbound, links.unresolved_count, links.backlinks
        ));
        out.push(format!(
            "{rel} 标签={:?} 标题={:?}",
            index.tags_of(rel),
            index.title_of(rel)
        ));
    }

    out.push(format!("概况={:?}", index.stats()));
    let graph = index.graph_data(MAX_GRAPH_NODES);
    out.push(format!("图谱节点={:?}", graph.nodes));
    out.push(format!("图谱边={:?}", graph.edges));
    out.push(format!("图谱截断={}", graph.truncated));

    let summary = index.tag_summary();
    out.push(format!("标签概览={summary:?}"));
    for item in &summary {
        out.push(format!(
            "标签[{}]={:?}",
            item.key,
            index.notes_with_tag(&item.key)
        ));
    }
    out
}

/// 两侧逐条相同，且索引里没有磁盘上已经不存在的路径。
fn assert_same(actual: &mut LinkIndex, expected: &mut LinkIndex, rels: &[String], label: &str) {
    let on_disk = disk_notes_here(rels);
    for path in indexed_paths(actual) {
        assert!(
            on_disk.contains(&path),
            "{label}：索引里不该有磁盘上不存在的路径：{path}"
        );
    }
    assert_eq!(
        indexed_paths(actual),
        indexed_paths(expected),
        "{label}：两侧收录的路径必须一致"
    );
    assert_eq!(
        fingerprint(actual, rels),
        fingerprint(expected, rels),
        "{label}：复用与全量重建必须逐条相同"
    );
}

fn disk_notes_here(rels: &[String]) -> Vec<String> {
    let mut sorted = rels.to_vec();
    sorted.sort();
    sorted
}

/// 一条 SQL 的首列（诊断与"没被重写"的证据）：统一转成字符串，避免整数列被静默读成空串。
fn query_rows(db: &Path, sql: &str, params: &[&str]) -> Vec<String> {
    use rusqlite::types::ValueRef;
    let conn = Connection::open(db).unwrap();
    let mut statement = conn.prepare(sql).unwrap();
    let mut rows = statement.query(rusqlite::params_from_iter(params)).unwrap();
    let mut out = Vec::new();
    while let Some(row) = rows.next().unwrap() {
        out.push(match row.get_ref(0).unwrap() {
            ValueRef::Null => String::new(),
            ValueRef::Integer(value) => value.to_string(),
            ValueRef::Real(value) => value.to_string(),
            ValueRef::Text(bytes) => String::from_utf8_lossy(bytes).into_owned(),
            ValueRef::Blob(_) => "<blob>".to_string(),
        });
    }
    out
}

fn link_row_ids(db: &Path, rel: &str) -> Vec<String> {
    query_rows(
        db,
        "SELECT id FROM link_refs WHERE path = ?1 ORDER BY id",
        &[rel],
    )
}

/// `PRAGMA data_version`：只有**别的连接**提交了写事务它才变。
fn data_version(conn: &Connection) -> i64 {
    conn.query_row("PRAGMA data_version", [], |row| row.get(0))
        .unwrap()
}

// ---------------------------------------------------------------------------
// 1. 核心不变式：任何改动之后，复用与全量重建逐条相同
// ---------------------------------------------------------------------------

/// 一个覆盖了各种形态的初始 Vault。
fn seed_vault(root: &Path) {
    write_note(
        root,
        "甲.md",
        "---\ntitle: 甲标题\ntags: [入口]\n---\n\n见 [[乙]] 与 #甲标签 与 [[还不存在]]\n",
    );
    write_note(
        root,
        "子/乙.md",
        "---\ntags: [项目/乙, 共享]\n---\n\n[去甲](甲.md) 与 ![[丙.md]]\n",
    );
    write_note(root, "子/丙.md", "# 丙\n\n[[乙|别名]] 与 [[#小节]]\n");
    write_note(root, "同名/丁.md", "正文 #共享\n\n[[同名]]\n");
    write_note(root, "别的/丁.md", "另一个 #别的\n");
    write_note(root, "去掉我/里面/深层.md", "会被整棵删掉 #临时\n");
}

/// 一次"关闭再打开"：复用侧重开、对照侧重建，两边逐条比对之后交给下一轮当现场。
struct Session {
    search: SearchIndex,
    index: LinkIndex,
}

impl Session {
    /// `expect_reuse` = 这一轮应当真的走了复用（除了第一次打开，其余每一轮都该有可复用的东西）。
    /// 加上这条断言是为了让测试**测到自己想测的那条路**：如果哪天复用被静默关掉，
    /// 后面的逐条比对会全绿，而这一条会红。
    fn start(
        root: &Path,
        reuse_db: &Path,
        full_db: &Path,
        label: &str,
        expect_reuse: bool,
    ) -> Self {
        let rels = disk_notes(root);
        let (search, mut index, outcome) = open_vault(root, reuse_db);
        let (_, mut expected) = rebuild_from_scratch(root, full_db);
        assert_eq!(outcome.skipped, 0, "{label}：不该有读失败");
        if expect_reuse {
            assert!(
                outcome.reused_notes > 0,
                "{label}：这一轮必须真的复用了落盘索引，否则这条断言等于空断言：{outcome:?}"
            );
        }
        assert_same(&mut index, &mut expected, &rels, label);
        assert_all_persisted(reuse_db, &index);
        Self { search, index }
    }
}

#[test]
fn reuse_matches_a_full_rebuild_after_every_kind_of_change() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let reuse_db = root.join(DB_REL);
    let full_db = root.join(".mimenote/cache/full.db");
    let vault = VaultRoot::open(root).unwrap();
    seed_vault(root);

    // 会话 1：从零建（这一轮没有任何可复用的东西）
    let mut session = Session::start(root, &reuse_db, &full_db, "初始状态", false);
    assert_eq!(session.index.len(), disk_notes(root).len());

    // -- 改一篇（内容变长，标题、标签、链接目标全变）----------------------------
    let text = "---\ntitle: 甲新标题\ntags: [入口, 新增]\n---\n\n改成 [[丙]] 与 #换过的标签\n";
    rewrite_note(root, "甲.md", text);
    session.index.upsert("甲.md", text);
    session.search.upsert_note("甲.md", text).unwrap();
    session = reopen(session, root, &reuse_db, &full_db, "改一篇之后");

    // -- 新增一篇（丢进已有目录）----------------------------------------------
    let text = "新的正文 #新笔记\n\n[[乙]] 与 [[同名]]\n";
    write_note(root, "子/戊.md", text);
    session.index.upsert("子/戊.md", text);
    session.search.upsert_note("子/戊.md", text).unwrap();
    session = reopen(session, root, &reuse_db, &full_db, "新增一篇之后");

    // -- 新增目录（目录不进索引，里面的笔记要进）--------------------------------
    let text = "全新的目录里的笔记 #新目录\n\n[[丙]]\n";
    write_note(root, "全新的目录/己.md", text);
    session.index.upsert("全新的目录/己.md", text);
    session
        .search
        .upsert_note("全新的目录/己.md", text)
        .unwrap();
    session = reopen(session, root, &reuse_db, &full_db, "新增目录之后");

    // -- 保存（改标题、删标签、删链接）----------------------------------------
    let text = "---\ntitle: 乙的新标题\n---\n\n正文没有链接了\n";
    rewrite_note(root, "子/乙.md", text);
    session.index.upsert("子/乙.md", text);
    session.search.upsert_note("子/乙.md", text).unwrap();
    session = reopen(session, root, &reuse_db, &full_db, "保存之后");

    // -- 同目录改名（mn_index::rename：改名 + 全库链接精确改写）-----------------
    mn_index::rename::rename_note(
        &vault,
        &mut session.index,
        "子/丙.md",
        "丙改名",
        true,
        Some(&session.search),
    )
    .unwrap();
    session = reopen(session, root, &reuse_db, &full_db, "同目录改名之后");

    // -- 跨目录移动（会换目录上下文，链接一律改写成相对新位置的路径）------------
    mn_index::rename::move_note(
        &vault,
        &mut session.index,
        "同名/丁.md",
        "新的家/更深",
        None,
        true,
        Some(&session.search),
    )
    .unwrap();
    session = reopen(session, root, &reuse_db, &full_db, "跨目录移动之后");

    // -- 在应用外面删掉一篇（没人通知索引，靠对账的 removed 发现）----------------
    std::fs::remove_file(note_path(root, "别的/丁.md")).unwrap();
    session = reopen(session, root, &reuse_db, &full_db, "外部删除之后");
    assert!(
        query_rows(
            &reuse_db,
            "SELECT path FROM link_notes WHERE path = ?1",
            &["别的/丁.md"]
        )
        .is_empty(),
        "被删路径的落盘数据必须一起清掉，否则它会被反复当成「待删除」"
    );

    // -- 删除整棵子树（宿主：文件先走回收站，再把目录与后代逐个摘出索引）--------
    std::fs::remove_dir_all(note_path(root, "去掉我")).unwrap();
    let doomed = session.index.paths_under("去掉我/");
    session.index.remove("去掉我");
    for path in doomed {
        session.index.remove(&path);
    }
    session.search.remove_note("去掉我").unwrap();
    session = reopen(session, root, &reuse_db, &full_db, "删除子树之后");
    for rel in ["去掉我/里面/深层.md", "去掉我"] {
        assert!(
            query_rows(
                &reuse_db,
                "SELECT path FROM link_notes WHERE path = ?1",
                &[rel]
            )
            .is_empty(),
            "{rel} 的落盘数据必须消失"
        );
    }

    // -- 什么都没变：纯复用一轮（这一轮的成本就是"对账 + 装载"）------------------
    let rels = disk_notes(root);
    let (search, mut index, outcome) = open_vault(root, &reuse_db);
    let (_, mut expected) = rebuild_from_scratch(root, &full_db);
    assert_eq!(
        outcome.reused_notes,
        rels.len(),
        "全库命中时一篇都不该重读：{outcome:?}"
    );
    assert_eq!(outcome.skipped, 0);
    assert_same(&mut index, &mut expected, &rels, "什么都没变");
    drop(expected);
    drop(index);
    drop(search);
    drop(session);
}

/// 关闭当前会话再打开（"下次启动应用"）：先 drop 掉旧连接，再按复用侧重开并对账。
fn reopen(previous: Session, root: &Path, reuse_db: &Path, full_db: &Path, label: &str) -> Session {
    drop(previous);
    Session::start(root, reuse_db, full_db, label, true)
}

// ---------------------------------------------------------------------------
// 2. Vault 没变 → 一个笔记文件都不读
// ---------------------------------------------------------------------------

#[test]
fn an_unchanged_vault_is_served_from_the_cache_without_reading_any_note() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let db = root.join(DB_REL);

    let pristine = "---\ntitle: 甲\n---\n\n见 [[乙]] 与 #标签甲\n";
    write_note(root, "甲.md", pristine);
    write_note(root, "子/乙.md", "正文 #共享\n\n[[甲]]\n");
    let rels = disk_notes(root);

    // 第一轮：整库重建（库里什么都没有）
    let (search, mut first_index, first) = open_vault(root, &db);
    assert_eq!(first.reused_notes, 0);
    assert_eq!(first.indexed, 2);

    // 对照：同一批**原始**文件从零重建出来的索引
    let full_db = root.join(".mimenote/cache/full.db");
    let (_, mut expected) = rebuild_from_scratch(root, &full_db);
    assert_same(&mut first_index, &mut expected, &rels, "第一轮（无缓存）");

    // 行为证明"复用路径一个文件都没读"：把正文换成**同样字节数**的另一份内容
    // （标题与链接目标都不同），再把 mtime 拨回原值 —— 判定键于是完全没变。
    // 复用路径若真的读了文件，索引里出现的就会是"丁/丙/标贴"，与上面那份对照必然对不上。
    for rel in &rels {
        let path = note_path(root, rel);
        let meta = std::fs::metadata(&path).unwrap();
        let modified = meta.modified().unwrap();
        let original = std::fs::read_to_string(&path).unwrap();
        // 每个替换都是"等字符数 → 等字节数"（汉字在 UTF-8 里都是 3 字节）
        let garbled = original
            .replace('甲', "丁")
            .replace('乙', "丙")
            .replace("标签", "标贴");
        assert_eq!(
            garbled.len(),
            original.len(),
            "替换必须保持字节数（否则判定键就变了，这个证明不成立）"
        );
        std::fs::write(&path, &garbled).unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        assert_eq!(
            mn_core::atomic::mtime_ms(&std::fs::metadata(&path).unwrap()),
            mn_core::atomic::mtime_ms(&meta),
            "mtime 必须拨回原值：{rel}"
        );
    }
    assert_eq!(
        entries_of(root, &rels)
            .iter()
            .map(stamp)
            .collect::<Vec<_>>(),
        rels.iter()
            .map(|rel| stamp(&entry_of(root, rel)))
            .collect::<Vec<_>>(),
        "判定键与第一轮完全一致"
    );
    assert!(
        read_note(root, "甲.md").contains('丁'),
        "磁盘上确实换了内容"
    );

    // 观察者连接：用来证明第二轮**连库都没写**
    let observer = Connection::open(&db).unwrap();
    let version_before = data_version(&observer);

    let (_, mut reused_index, outcome) = open_vault(root, &db);

    assert_eq!(outcome.reused_notes, 2, "两篇都必须走复用");
    assert_eq!(outcome.indexed, 2, "索引里仍然要有这两篇");
    assert_eq!(outcome.skipped, 0);
    assert_eq!(
        data_version(&observer),
        version_before,
        "全库命中时索引表一个字节都不该动"
    );

    // 磁盘上是"丁/丙/标贴"，索引里仍然是"甲/乙/标签" —— 这就是"没读文件"的直接证据
    assert_eq!(reused_index.title_of("甲.md"), Some("甲"));
    assert_eq!(
        reused_index.note_links("甲.md").outbound[0]
            .resolved_rel_path
            .as_deref(),
        Some("子/乙.md")
    );
    assert_eq!(reused_index.notes_with_tag("标签甲").len(), 1);
    assert_same(&mut reused_index, &mut expected, &rels, "全库命中");

    drop(search);
}

// ---------------------------------------------------------------------------
// 3. 只改一篇：其他篇的行一个都不重写
// ---------------------------------------------------------------------------

#[test]
fn only_the_changed_note_is_rewritten() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let db = root.join(DB_REL);
    for rel in ["甲.md", "乙.md", "丙.md"] {
        write_note(root, rel, &format!("{rel} 的正文 #共享\n\n[[甲]]\n"));
    }

    let (search, _index, outcome) = open_vault(root, &db);
    assert_eq!(outcome.reused_notes, 0, "第一轮只能读文件");

    let before: Vec<Vec<String>> = ["甲.md", "乙.md", "丙.md"]
        .iter()
        .map(|rel| link_row_ids(&db, rel))
        .collect();
    assert!(before.iter().all(|ids| !ids.is_empty()), "{before:?}");

    // 只改乙（内容长度也变，判定键一定变）
    rewrite_note(root, "乙.md", "乙改过了 的正文 #换过\n\n[[丙]] 与 [[甲]]\n");
    let (_, reloaded, outcome) = open_vault(root, &db);
    assert_all_persisted(&db, &reloaded);
    assert!(reloaded.contains("乙.md"));

    assert_eq!(outcome.reused_notes, 2, "只改了乙：{outcome:?}");
    assert_eq!(
        link_row_ids(&db, "甲.md"),
        before[0],
        "没动的笔记不该被重写"
    );
    assert_eq!(
        link_row_ids(&db, "丙.md"),
        before[2],
        "没动的笔记不该被重写"
    );
    assert_ne!(link_row_ids(&db, "乙.md"), before[1], "改过的那篇要重写");

    drop(search);
}

// ---------------------------------------------------------------------------
// 4. 写入口：保存 / 新建 / 删除 / 改名 / 跨目录移动之后，**落盘**的索引与内存一致
// ---------------------------------------------------------------------------

#[test]
fn a_write_through_invalidates_the_reuse_key() {
    // 这一条钉的是**安全网**：写盘时手上没有文件 mtime/size，而"不知道"只能表达成
    // "下一篇必须重读"。少了它，改动后的文件若 mtime/size 恰好与旧值相同，
    // 就会被判成"没变"，于是复用出**旧链接** —— 那就是本 ADR 最不能接受的结果。
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let db = root.join(DB_REL);
    write_note(root, "甲.md", "见 [[乙]] 与 #旧\n");
    write_note(root, "乙.md", "正文\n");

    let (search, mut index, _) = open_vault(root, &db);
    assert_eq!(
        query_rows(&db, "SELECT path FROM notes_meta", &[]).len(),
        2,
        "第一轮之后两篇都留下了判定键"
    );

    // 保存（内存 upsert + 搜索整篇重写，与 `indexer::update_note` 同序）
    let text = "见 [[乙]] 与 #新\n";
    index.upsert("甲.md", text);
    search.upsert_note("甲.md", text).unwrap();

    assert!(
        query_rows(
            &db,
            "SELECT path FROM notes_meta WHERE path = ?1",
            &["甲.md"]
        )
        .is_empty(),
        "改动过的笔记必须失去判定键（否则下一次打开可能拿它去复用出旧链接）"
    );
    assert_eq!(
        query_rows(
            &db,
            "SELECT path FROM notes_meta WHERE path = ?1",
            &["乙.md"]
        )
        .len(),
        1,
        "没动过的笔记不受影响"
    );

    // 下一轮：只有这一篇重读，其余照常复用
    let (_, _, outcome) = open_vault(root, &db);
    assert_eq!(outcome.reused_notes, 1, "{outcome:?}");
    assert_eq!(outcome.indexed, 2);
    drop(search);
    drop(index);
}

/// 每个写入口之后都做同一件事：把内存索引与"重新打开库里那一份"逐条比对。
///
/// 这一条钉的是最危险的一类错误：内存是对的、库里是旧的 —— 那会让**下一次打开**
/// 拿到过期链接，而当前会话里完全看不出来。
#[test]
fn every_write_path_keeps_the_persisted_index_in_step() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let db = root.join(DB_REL);
    let vault = VaultRoot::open(root).unwrap();
    seed_vault(root);

    // 重开一次库（"下次打开 Vault"），与内存里的那一份逐条比对。
    fn disk_matches_memory(root: &Path, db: &Path, index: &mut LinkIndex, label: &str) {
        let (_, mut reloaded, outcome) = open_vault(root, db);
        let rels = disk_notes(root);
        // 断言的是"内容一致"，不是"复用了多少"：写入口只作废动过的那几篇，
        // 但即使整库重读，逐条比对的结论也必须成立
        assert_eq!(outcome.skipped, 0, "{label}：不该有读失败");
        assert!(
            outcome.reused_notes > 0,
            "{label}：没被动过的笔记必须真的复用（否则这条比对测不到复用路径）：{outcome:?}"
        );
        assert_same(&mut reloaded, index, &rels, label);
        assert_all_persisted(db, index);
    }

    let (search, mut index, _) = open_vault(root, &db);

    // -- 保存（`indexer::update_note` 的两步：内存 upsert + 搜索整篇重写）--------
    let text = "---\ntitle: 保存后的标题\ntags: [保存]\n---\n\n见 [[丙]] 与 #保存标签\n";
    rewrite_note(root, "甲.md", text);
    index.upsert("甲.md", text);
    search.upsert_note("甲.md", text).unwrap();
    disk_matches_memory(root, &db, &mut index, "保存之后");

    // -- 新建（同一个入口）---------------------------------------------------
    let text = "新建 #新\n\n[[甲]]\n";
    write_note(root, "新建的.md", text);
    index.upsert("新建的.md", text);
    search.upsert_note("新建的.md", text).unwrap();
    disk_matches_memory(root, &db, &mut index, "新建之后");

    // -- 同目录改名 ---------------------------------------------------------
    mn_index::rename::rename_note(
        &vault,
        &mut index,
        "子/丙.md",
        "丙新名",
        true,
        Some(&search),
    )
    .unwrap();
    disk_matches_memory(root, &db, &mut index, "改名之后");

    // -- 跨目录移动 ---------------------------------------------------------
    mn_index::rename::move_note(
        &vault,
        &mut index,
        "新建的.md",
        "归档/2026",
        Some("搬过来的"),
        true,
        Some(&search),
    )
    .unwrap();
    disk_matches_memory(root, &db, &mut index, "移动之后");

    // -- 删除一篇 -----------------------------------------------------------
    std::fs::remove_file(note_path(root, "别的/丁.md")).unwrap();
    index.remove("别的/丁.md");
    search.remove_note("别的/丁.md").unwrap();
    disk_matches_memory(root, &db, &mut index, "删除之后");

    // -- 删除整棵子树（宿主会把目录与后代逐个摘掉）----------------------------
    std::fs::remove_dir_all(note_path(root, "去掉我")).unwrap();
    let doomed = index.paths_under("去掉我/");
    index.remove("去掉我");
    for path in doomed {
        index.remove(&path);
    }
    search.remove_note("去掉我").unwrap();
    disk_matches_memory(root, &db, &mut index, "删除子树之后");

    // 库里不该留下被删路径的任何落盘数据（含判定键）
    for rel in ["别的/丁.md", "去掉我/里面/深层.md"] {
        assert!(
            query_rows(&db, "SELECT path FROM link_notes WHERE path = ?1", &[rel]).is_empty(),
            "{rel} 的落盘数据必须一起消失"
        );
        assert!(
            query_rows(&db, "SELECT path FROM notes_meta WHERE path = ?1", &[rel]).is_empty(),
            "{rel} 的判定键必须一起消失"
        );
    }

    drop(search);
}

// ---------------------------------------------------------------------------
// 5. 坏库自愈 / 锁冲突 / schema 升级（同样适用于链接表）
// ---------------------------------------------------------------------------

#[test]
fn a_corrupt_cache_is_rebuilt_instead_of_reused() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let db = root.join(DB_REL);
    seed_vault(root);

    let (search, _, _) = open_vault(root, &db);
    drop(search);

    // 外部把库写坏 → 自愈（删掉重建）→ 这一轮只能整库重读，但结果必须与对照一致
    std::fs::write(&db, b"this is not a sqlite database at all").unwrap();
    let (search, mut healed, outcome) = open_vault(root, &db);
    assert_eq!(outcome.reused_notes, 0, "坏库重建之后没有任何东西可复用");
    assert_eq!(
        search.index_store().note_count().unwrap(),
        disk_notes(root).len(),
        "重建要把链接数据重新写进去"
    );

    let (_, mut expected) = rebuild_from_scratch(root, &dir.path().join(".mimenote/cache/full.db"));
    let rels = disk_notes(root);
    assert_same(&mut healed, &mut expected, &rels, "坏库自愈之后");
    drop(search);
}

#[test]
fn a_locked_cache_is_reported_and_never_deleted() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let db = root.join(DB_REL);
    seed_vault(root);

    let (search, _, _) = open_vault(root, &db);
    drop(search);

    // 另一个连接持有写锁（这正是"两个构建并发"时日志里 "database is locked" 的来源）
    let blocker = Connection::open(&db).unwrap();
    blocker
        .execute_batch("PRAGMA journal_mode = DELETE")
        .unwrap();
    blocker.execute_batch("BEGIN EXCLUSIVE").unwrap();

    let error = SearchIndex::open(&db).unwrap_err();
    assert!(db.exists(), "锁冲突不是损坏：健康的缓存必须原样留着");
    assert!(
        error.to_string().contains("locked"),
        "错误要原样上报给调用方降级：{error}"
    );

    drop(blocker);

    // 锁一放开：缓存完好，链接索引整批复用（说明它从头到尾没被动过）
    let (search, mut index, outcome) = open_vault(root, &db);
    let rels = disk_notes(root);
    assert_eq!(
        outcome.reused_notes,
        rels.len(),
        "缓存没被删掉，所以全部可复用：{outcome:?}"
    );
    let (_, mut expected) = rebuild_from_scratch(root, &dir.path().join(".mimenote/cache/full.db"));
    assert_same(&mut index, &mut expected, &rels, "锁释放之后");
    drop(search);
}

#[test]
fn a_schema_version_bump_rebuilds_the_link_tables() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let db = root.join(DB_REL);
    seed_vault(root);

    let (search, _, _) = open_vault(root, &db);
    drop(search);

    // 模拟"上一个版本留下的库"：版本号不是当前值
    {
        let conn = Connection::open(&db).unwrap();
        conn.pragma_update(None, "user_version", 2).unwrap();
    }

    let search = SearchIndex::open(&db).unwrap();
    assert!(
        search.load_index_data().unwrap().is_empty(),
        "版本不符 → 链接数据一起丢掉（口径变了就不能沿用旧口径的结果）"
    );
    assert_eq!(search.index_store().note_count().unwrap(), 0);

    let rels = disk_notes(root);
    let entries = entries_of(root, &rels);
    let (mut index, outcome) = build(root, &search, &entries);
    assert_eq!(outcome.reused_notes, 0, "升级后的第一次打开是整库重建");

    let (_, mut expected) = rebuild_from_scratch(root, &dir.path().join(".mimenote/cache/full.db"));
    assert_same(&mut index, &mut expected, &rels, "schema 升级之后");
    drop(search);
}

// ---------------------------------------------------------------------------
// 6. 边界：读不到的笔记、非笔记改名
// ---------------------------------------------------------------------------

#[test]
fn a_note_that_cannot_be_read_disappears_from_both_sides() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let db = root.join(DB_REL);
    write_note(root, "好.md", "见 [[坏]] 与 #好\n");
    write_note(root, "坏.md", "# 坏\n");

    let (search, _, _) = open_vault(root, &db);
    drop(search);

    // 非 UTF-8：`read_text` 会失败 → 这一篇不进索引（两侧必须一致）
    std::fs::write(note_path(root, "坏.md"), [0xff, 0xfe, 0x00, 0x01]).unwrap();

    let (search, mut index, outcome) = open_vault(root, &db);
    assert!(
        outcome.reused_notes == 1 && outcome.skipped == 1,
        "一篇复用、一篇读失败：{outcome:?}"
    );
    assert!(!index.contains("坏.md"), "读不到的笔记不该进索引");

    let (_, mut expected) = rebuild_from_scratch(root, &dir.path().join(".mimenote/cache/full.db"));
    let rels = disk_notes(root);
    assert_same(&mut index, &mut expected, &rels, "有一篇读不到时");
    drop(search);
}

#[test]
fn renaming_a_non_note_does_not_pollute_the_cache() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let db = root.join(DB_REL);
    write_note(root, "甲.md", "见 [[图]]\n");
    write_note(root, "附件/图.png", "不是笔记");

    let (search, mut index, _) = open_vault(root, &db);
    let vault = VaultRoot::open(root).unwrap();
    assert!(
        !query_rows(&db, "SELECT path FROM link_notes", &[]).is_empty(),
        "笔记的落盘数据要在"
    );

    mn_index::rename::rename_note(
        &vault,
        &mut index,
        "附件/图.png",
        "图2",
        true,
        Some(&search),
    )
    .unwrap();

    // 索引本来不收录附件，改名也不该把它收进来（否则 `[[图2]]` 会被一个 png 劫持）
    assert!(!index.contains("附件/图.png"));
    assert!(!index.contains("附件/图2.png"));
    assert!(query_rows(
        &db,
        "SELECT path FROM link_notes WHERE path = ?1",
        &["附件/图.png"]
    )
    .is_empty());
    assert!(query_rows(
        &db,
        "SELECT path FROM notes_meta WHERE path = ?1",
        &["附件/图.png"]
    )
    .is_empty());

    // 重开之后仍然与全量重建一致（"附件不进索引"这条口径没有因为落盘而漂移）
    let (_, mut reloaded, _) = open_vault(root, &db);
    let (_, mut expected) = rebuild_from_scratch(root, &dir.path().join(".mimenote/cache/full.db"));
    let rels = disk_notes(root);
    assert_same(&mut reloaded, &mut expected, &rels, "非笔记改名之后");
    drop(search);
}

// ---------------------------------------------------------------------------
// 基准：1 万笔记下"打开 Vault"的三档耗时
// ---------------------------------------------------------------------------

/// 性能基准：1 万笔记下"打开 Vault（链接 + 标签 + 全文搜索）"的耗时。
///
/// 运行：`cargo test -p mn-index --release --test persisted_index -- --ignored --nocapture bench_open_vault_10k_notes`
///
/// 数据规模与 `search.rs` 的 `bench_reopen_10k_notes` 一致（100 目录 × 100 篇 × 30 行 + 链接 + 标签），
/// 两边数字可以对照着看。
#[test]
#[ignore]
fn bench_open_vault_10k_notes() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let db = root.join(DB_REL);

    let mut rels: Vec<String> = Vec::with_capacity(10_000);
    for d in 0..100 {
        let sub = root.join(format!("dir{d:03}"));
        std::fs::create_dir_all(&sub).unwrap();
        for f in 0..100 {
            let mut body = String::new();
            for i in 1..=29 {
                body.push_str(&format!(
                    "第 {i} 行：这是用来测试索引的中文正文，里面还有 search 这样的英文单词\n"
                ));
            }
            if f % 10 == 0 {
                body.push_str("这一行里有关键词，别的行没有\n");
            }
            if f % 200 == 0 {
                body.push_str("这里有一个稀有的词：独角鲸\n");
            }
            if f % 3 == 0 {
                body.push_str("标签行 #项目/甲 #共享\n");
            }
            body.push_str(&format!("末尾一行 [[note{f:03}]] 与 [[不存在的{f:03}]]\n"));
            let rel = format!("dir{d:03}/note{f:03}.md");
            std::fs::write(root.join(&rel), body).unwrap();
            rels.push(rel);
        }
    }

    // 每条都从"打开缓存库"开始计时：那才是用户感知到的"打开 Vault"
    let open = |label: &str, from_scratch: bool| -> (u64, BuildOutcome) {
        let entries = entries_of(root, &rels);
        let started = std::time::Instant::now();
        let search = if from_scratch {
            SearchIndex::open_for_rebuild(&db).unwrap()
        } else {
            SearchIndex::open(&db).unwrap()
        };
        let opened = started.elapsed().as_millis() as u64;
        let (mut index, outcome) = build(root, &search, &entries);
        let total = started.elapsed().as_millis() as u64;
        let stats = index.stats();
        let search_ms = outcome
            .search
            .as_ref()
            .map(|it| it.duration_ms)
            .unwrap_or(0);
        let search_lines = outcome.search.as_ref().map(|it| it.lines).unwrap_or(0);
        eprintln!(
            "  {label}：整轮 {total} ms（开库 {opened} ms / 复用 {} 篇 / 对账与装载 {} ms\n\
             \x20     其中搜索 {search_ms} ms、写 {search_lines} 行；索引 {} 篇 / 链接 {} 条 / 标签键 {} 个）",
            outcome.reused_notes, outcome.reuse_ms, outcome.indexed, stats.links, stats.tags
        );
        drop(search);
        (total, outcome)
    };

    eprintln!("1 万笔记（100 目录 × 100 篇 × 30 行 + 链接 + 标签）：");

    // 旧行为的**链接那一侧**：不挂缓存库的内存索引全量重建（同一批文件、同一份解析成本）。
    // 它也是写放大的对照：与"整库重建"那一轮里链接那一半的耗时之差，就是"多写一遍链接/标签"的钱。
    {
        let entries = entries_of(root, &rels);
        let started = std::time::Instant::now();
        let (mut links_only, _) =
            mn_index::build_index(root, &entries, &BuildOptions::default(), None, |_, _| {});
        let links_only_ms = started.elapsed().as_millis();
        let stats = links_only.stats();
        eprintln!(
            "  旧行为 · 链接+标签（内存索引，不带缓存库）：{links_only_ms} ms（{} 篇 / {} 条链接）",
            stats.files, stats.links
        );
    }

    // 旧行为 = 每次打开都从零重建（库刚被删掉）
    let (full_total, full) = open("旧行为 · 整库重建", true);
    assert_eq!(full.reused_notes, 0);
    assert!(
        full_total <= 20_000,
        "整库重建耗时超回归阈值：{full_total}ms"
    );

    // Vault 没变 → 一篇都不读
    let (noop_total, noop) = open("Vault 没变 · 复用", false);
    assert_eq!(noop.reused_notes, rels.len());
    assert_eq!(noop.skipped, 0);

    // 改一篇 → 只重读那一篇
    let rel = rels[0].clone();
    rewrite_note(root, &rel, "改过的内容里也有关键词与独角鲸 #改过\n");
    let (one_total, one) = open("改了 1 篇 · 增量", false);
    assert_eq!(one.reused_notes, rels.len() - 1, "{one:?}");

    let db_bytes = std::fs::metadata(&db).map(|meta| meta.len()).unwrap_or(0);
    eprintln!(
        "  缓存库 {:.1} MB；复用一轮比整库重建快 {:.1} 倍",
        db_bytes as f64 / 1_048_576.0,
        full_total as f64 / noop_total.max(1) as f64
    );

    // 归因：复用这一轮剩下的时间花在哪 —— 对账（扫一遍路径集合）与装载（读三张表 + 建内存索引）。
    // 这只是诊断用的额外一遍，不在上面的计时里。
    {
        let entries = entries_of(root, &rels);
        let refs: Vec<&EntryMeta> = entries.iter().collect();
        let search = SearchIndex::open(&db).unwrap();
        let started = std::time::Instant::now();
        let plan = search.plan_incremental(&refs).unwrap();
        let plan_ms = started.elapsed().as_millis();
        let started = std::time::Instant::now();
        let loaded = search.load_index_data().unwrap();
        let load_ms = started.elapsed().as_millis();
        eprintln!(
            "  归因：对账 {plan_ms} ms（changed {} / removed {} / reused {}）+ 装载 {load_ms} ms（{} 篇）",
            plan.changed.len(),
            plan.removed.len(),
            plan.reused,
            loaded.len()
        );
    }

    // 单篇保存的成本：写穿透开启 vs 关闭（各 100 篇，取平均）。
    // 这一项回答的是"每次 Ctrl+S 要多付多少钱"，也是 blob 方案真正的痛点所在：
    // 整库一段 blob 的话，每存一篇都要把整份索引序列化一遍。
    {
        let (search, mut index, _) = open_vault(root, &db);
        let text = "保存成本测试 #标签\n\n[[note000]]\n";
        let saves = |index: &mut LinkIndex, label: &str| -> f64 {
            let started = std::time::Instant::now();
            for rel in rels.iter().take(100) {
                index.upsert(rel, text);
            }
            let per = started.elapsed().as_secs_f64() * 1000.0 / 100.0;
            eprintln!("  单篇保存（{label}）：{per:.3} ms/篇");
            per
        };
        let with_store = saves(&mut index, "写穿透明细");
        index.detach_store();
        let without = saves(&mut index, "不写穿透明细");
        eprintln!("  写穿透的增量成本：{:.3} ms/篇", with_store - without);
        drop(index);
        drop(search);
    }

    // 相对断言：机器快慢不影响结论（绝对阈值只用来挡灾难性回退）
    assert!(
        noop_total * 4 < full_total,
        "复用必须显著快于整库重建：复用 {noop_total}ms vs 全量 {full_total}ms"
    );
    assert!(
        one_total * 3 < full_total,
        "只改一篇也必须显著快于整库重建：{one_total}ms vs {full_total}ms"
    );
}
