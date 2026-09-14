//! 全文搜索索引（SQLite FTS5）。
//!
//! ## 为什么是 SQLite FTS5
//!
//! 索引是**派生数据**（ADR-0002：删掉即可重建），但它必须扛得住 1 万笔记的全文检索，
//! 且不能引入"用户机器上还得装点东西"的依赖。`rusqlite` + `bundled` 自带 SQLite 与 FTS5：
//! 一个进程内库、一个文件、零外部服务 —— 与"本地优先、可整体搬走"的产品约束一致。
//!
//! ## 表结构（external content）
//!
//! ```text
//! lines(id INTEGER PRIMARY KEY, rel_path, line, text, indexed_text)
//! lines_fts  USING fts5(indexed_text, content='lines', content_rowid='id')
//! ```
//!
//! `lines` 是**行表**（一篇笔记一行一条），FTS5 表用 **external content** 覆盖同一批数据 ——
//! 这样 `bm25()` 排完序还能 JOIN 回 `lines` 拿到**行号**与**原文**（`SearchHit::line`
//! 与 `snippet` 都靠它）。external content 的代价是：**FTS 索引必须由我们显式维护**，
//! 所以删除走 FTS5 的 `'delete'` 指令、全量重建走 `'rebuild'`（见各方法注释）。
//!
//! ## 中文为什么要"逐字插空格"
//!
//! FTS5 内置的 `unicode61` 分词器把**一整串汉字当成一个 token**（汉字是 Unicode 字母），
//! 那样 `天气` 永远搜不到 `今天天气很好`。所以入库与查询都先经 [`space_cjk`] 把 CJK 逐字切开：
//! 正文变成 `今 天 天 气 很 好` 这样的单字 token 序列，查询词变成短语 `"天 气"`，
//! 短语匹配恰好等于"这两个字必须相邻出现" —— 这是不上分词词典时最稳的做法。
//! 取舍：没有词形还原、也没有词典分词（`研究生命的起源` 这类歧义无法消解），
//! 但**中文、日文、韩文、英文的任意子串/词前缀都能搜到**，且索引体积只随字数线性增长。
//!
//! ## 查询串为什么必须逐词加引号
//!
//! 用户输入的是**自然文本**，不是 FTS5 表达式。`a"b(c)`、`-x`、`OR`、`^` 这些都是 FTS5 的
//! 语法字符，直接拼进 `MATCH` 会报 `fts5: syntax error`。所以每个词都被包进双引号
//! （引号内的语法字符全是普通字符），内部的 `"` 用 `""` 转义；词尾再加 `*` 做前缀匹配。
//! 详见 [`build_match_query`] 与它的测试。
//!
//! ## 跨会话复用：按 `(path, mtime_ms, size)` 增量重建
//!
//! 索引是可重建的派生数据（ADR-0002），但**不等于每次打开 Vault 都要重建** ——
//! 几千篇笔记的整库重建是十几秒的 CPU 高峰。库里的 `notes_meta` 表记下每篇笔记被索引时
//! 的文件元数据（与 ADR-0004 的 mtime 版本令牌同一口径），打开时与扫描结果对账：
//! 命中的笔记**一行都不重写**（连事务都不开，FTS 表一个字节都不动），
//! 只重写新增/改动的那几篇、并清掉已消失的路径（见 [`SearchIndex::plan_incremental`]）。
//!
//! 判定键只有毫秒级 mtime 与字节数，所以**同一毫秒内、字节数又完全相同的内容改动会漏检**
//! （与 ADR-0004 的冲突检测同一取舍：要做内容级校验就得引入哈希，属 M5）。
//!
//! ## 链接 / 标签也落在同一个库里（ADR-0014）
//!
//! 链接索引与标签索引是**内存索引**，但它们同样是派生数据 —— 所以这里把每篇笔记解析出来的
//! 链接、标签、frontmatter 标题也写进同一个缓存库（`link_notes` / `link_refs` / `tag_refs`），
//! 与 `lines`、`notes_meta` **共用同一个判定键**：打开 Vault 时二者一起对账，命中的笔记
//! 既不重读文件、也不重写行。为什么不是"第二套键"：键一旦有两份，就必然出现
//! "文件变了一半"的中间状态，而那种状态没有安全的解释方式。
//!
//! 三条不变量（写代码时不许打破）：
//!
//! 1. **落盘数据与判定键同一个事务**：`link_notes` + `link_refs` + `tag_refs` 与 `notes_meta`
//!    要么一起提交、要么一起回滚。关键不是"写得整齐"，而是判定键一旦对上，索引就必须真的可复用；
//! 2. **任何改写落盘数据的路径都必须作废判定键**（`replace_note` 里删掉 `notes_meta` 那一行）：
//!    写盘时拿不到文件 mtime/size，"不知道"只能表达成"下一篇必须重读"；
//! 3. **装回内存与解析写内存走同一段记账代码**（[`crate::LinkIndex`] 的 `insert_parsed`）：
//!    复用回来的索引与从零重建的索引逐条相同，是代码结构保证的，而不是"两处实现碰巧一致"。
//!
//! 违反其中任何一条的后果都不是"慢了"，而是**复用出过期链接** —— 那比慢 5 秒严重得多，
//! 所以这里宁可多作废几次判定键（代价：下次打开多读几篇文件）。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use rusqlite::{params, Connection, ErrorCode};

use mn_core::links::{LinkKind, LinkRef};
use mn_core::scanner::EntryMeta;
use mn_core::tags::{TagRef, TagSource};
use mn_core::{Error, Result};

/// 缓存库的 schema 版本。改动表结构就 +1：打开时版本不符直接重建（缓存而已）。
///
/// 除了表结构，**索引口径的任何变化也要 +1**（分词规则、哪些行进索引、大小上限……）：
/// 增量复用会信任库里已有的行，口径变了却沿用旧行，等于把旧规则的结果当新规则的结果用。
///
/// v3：链接 / 标签 / frontmatter 标题也落盘（ADR-0014）—— 判定键不变，但库里多了一整份
/// "可以复用"的数据，口径变了必须重建，否则会拿旧口径的链接当新口径的用。
const SCHEMA_VERSION: i64 = 3;

/// `snippet` 的长度上限（**字符**，含省略号）。
const SNIPPET_CHARS: usize = 120;

/// 查询串最多取几个词（挡住病态输入把 FTS5 拖死）。
const MAX_QUERY_TERMS: usize = 16;

/// 单个查询词最多保留多少字符。
const MAX_TERM_CHARS: usize = 64;

/// mtime 不可得时库里的存值：真实 mtime 永远 ≥ 0，所以它**永远**不会等于任何扫描结果 ——
/// "不知道 mtime" 必须当成"这一篇要重读"，不能当成"没变"。
const UNKNOWN_MTIME: i64 = -1;

/// 打开连接后等待锁的时间（毫秒）：并发构建撞锁时在这里等，而不是立刻报 "database is locked"。
const BUSY_TIMEOUT_MS: u64 = 2000;

/// 增量收尾时，FTS5 段数达到多少就顺手合并一次（见 [`SearchIndex::optimize_if_fragmented`]）。
///
/// 为什么是 8：实测（`bench_optimize_after_incremental`）里跑 20 轮增量后段数在 **11–18** 之间浮动
/// ——FTS5 的 automerge 会把段数稳定在这个量级附近，不会无限增长，所以阈值要落在这个区间的下沿附近；
/// 定得更低（比如 2、3）只会在"本来就没几个段"时白花一次全库重写（30 万行约 0.9 s）。
/// 而 8 段以上正是实测里查询已经比 1 段慢 1.7–2.2× 的区间。
const OPTIMIZE_SEGMENT_THRESHOLD: usize = 8;

/// 建表语句（`IF NOT EXISTS`：打开已有库时不动它）。
///
/// `notes_meta` 是**跨会话增量复用**的判定依据（见 [`SearchIndex::plan_incremental`]）：
/// 每篇笔记一行，记下它被索引那一刻的 `(mtime, size)`。没有这张表就只能每次全量重建。
///
/// 后三张表是链接 / 标签索引的落盘形态（ADR-0014）：
///
/// * `link_notes` —— 每篇笔记**一行**，`title` 是 frontmatter 的 `title`（没有就是 NULL）。
///   它同时充当"这篇的落盘数据完整"的唯一凭证：装载时**只有**在它里面出现的路径才算有数据，
///   这样"零链接零标签的笔记"（另外两张表里一行都没有）与"数据缺失"才区分得开；
/// * `link_refs` —— 每篇的出链（`ord` 保留文档内顺序：图谱"首次出现的写法胜出"依赖它）；
/// * `tag_refs` —— 每篇的标签（`ord` 保留 frontmatter 在前、正文在后的顺序）。
///
/// 三张表都**不含** `(mtime, size)`：判定键只有 `notes_meta` 一份（见模块文档）。
const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS lines(
  id           INTEGER PRIMARY KEY,
  rel_path     TEXT NOT NULL,
  line         INTEGER NOT NULL,
  text         TEXT NOT NULL,
  indexed_text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lines_by_path ON lines(rel_path);
CREATE VIRTUAL TABLE IF NOT EXISTS lines_fts USING fts5(
  indexed_text,
  content='lines',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TABLE IF NOT EXISTS notes_meta(
  path     TEXT PRIMARY KEY,
  mtime_ms INTEGER NOT NULL,
  size     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS link_notes(
  path  TEXT PRIMARY KEY,
  title TEXT
);
CREATE TABLE IF NOT EXISTS link_refs(
  id         INTEGER PRIMARY KEY,
  path       TEXT NOT NULL,
  ord        INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  raw_target TEXT NOT NULL,
  alias      TEXT,
  anchor     TEXT,
  line       INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS link_refs_by_path ON link_refs(path, ord);
CREATE TABLE IF NOT EXISTS tag_refs(
  id     INTEGER PRIMARY KEY,
  path   TEXT NOT NULL,
  ord    INTEGER NOT NULL,
  tag    TEXT NOT NULL,
  source TEXT NOT NULL,
  line   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS tag_refs_by_path ON tag_refs(path, ord);
";

/// 一条命中（行级）。
#[derive(Debug, Clone, PartialEq)]
pub struct SearchHit {
    /// 笔记相对路径。
    pub rel_path: String,
    /// 行号（1 起）。
    pub line: u32,
    /// 命中行的裁剪版（单行、纯文本）。
    pub snippet: String,
    /// 相关性分数（`-bm25`，**越大越相关**；仅用于排序）。
    pub score: f64,
}

/// 一次查询的结果。
#[derive(Debug, Clone, PartialEq)]
pub struct SearchOutcome {
    /// 按 `score` 降序 → `rel_path` 升序 → `line` 升序排好的命中（最多 `limit` 条）。
    pub hits: Vec<SearchHit>,
    /// 命中总数（可能大于 `hits.len()`）。
    pub total: u32,
}

/// 索引规模（日志与测试用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SearchCounts {
    /// 已索引的笔记数。
    pub notes: usize,
    /// 已索引的行数。
    pub lines: usize,
}

/// 一次"打开 Vault 该写什么"的对账结果（[`SearchIndex::plan_incremental`] 的产物）。
///
/// 不变式：`changed.len() + reused == 这一轮扫描到的笔记数`；
/// `removed` 是库里还留着、这次扫描已经没有了的路径。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IncrementalPlan {
    /// 需要重写的笔记（新增、改动、或者 mtime 不可得）。
    pub changed: Vec<String>,
    /// 需要从索引里删掉的路径（文件被删、改名走了、或不再是笔记）。
    pub removed: Vec<String>,
    /// 元数据命中、内容可以原样留用的笔记数。
    pub reused: usize,
}

impl IncrementalPlan {
    /// 什么都没变：这一轮**不要碰索引表**（连事务都不该开）。
    pub fn is_noop(&self) -> bool {
        self.changed.is_empty() && self.removed.is_empty()
    }

    /// 一篇都留不住（首次构建、schema 升级后、或库与文件对不上）：整库重写比逐篇增量省得多。
    pub fn needs_full_rebuild(&self) -> bool {
        self.reused == 0
    }
}

/// 一篇笔记在索引里的**全部派生数据**：出链、标签、frontmatter 标题（ADR-0014）。
///
/// 它刻意是"落盘"与"装回内存"之间**唯一**的数据形状：写入时由 `LinkIndex` 的解析结果构造，
/// 读出时按同一段记账代码装回内存。两边共用一个类型，就不存在"某个字段忘了落盘"
/// 这种会让复用结果与全量重建分家的口子。
///
/// 不落盘的东西只有两类，都是**刻意**的：
///
/// * 反向链接（`LinkIndex::backlinks`）：它是 `links` 的一个纯投影，且在库里也随链接的改变而失效，
///   存下来只会多一份可能过期的副本；
/// * `by_path` / `by_stem`（解析消歧用的索引）：由 `rel_path` 直接算出来，存下来同理。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteIndexData {
    /// 归一化（`/` 分隔）后的相对路径。
    pub rel_path: String,
    /// 出链，**保持文档内顺序**（图谱"同一对笔记之间取首次出现的写法"依赖它）。
    pub links: Vec<LinkRef>,
    /// frontmatter 的 `title`（没有 frontmatter / 没有该字段 / 空值 → `None`）。
    pub title: Option<String>,
    /// 标签，**保持抽取顺序**（frontmatter 在前、正文在后）。
    pub tags: Vec<TagRef>,
}

impl NoteIndexData {
    /// 空数据（只有路径）：构造 `LinkIndex` 落盘数据时的起点。
    pub fn new(rel_path: impl Into<String>) -> Self {
        Self {
            rel_path: rel_path.into(),
            links: Vec::new(),
            title: None,
            tags: Vec::new(),
        }
    }
}

/// 全文搜索索引。
///
/// 内部持有一个 SQLite 连接（非 `Sync`），因此只能放在 `Mutex` 后面共享 ——
/// 见 `src-tauri/src/state.rs` 的 `SearchSlot`。
///
/// 连接包在 `Arc<Mutex<_>>` 里（而不是直接持有 `Connection`）：链接索引的落盘句柄
/// （[`IndexStore`]）必须与它**共用同一个连接**。两个连接各写各的，就等于两套事务，
/// 一个成功一个失败时库里会留下"行是新的、判定键是旧的"这种最坏状态 ——
/// 同一个连接 + 一个事务，失败时一起回滚，才谈得上"判定键对得上就一定能复用"。
pub struct SearchIndex {
    conn: Arc<Mutex<Connection>>,
    /// 缓存库路径（错误信息与日志用）。
    label: String,
    /// 全量重建进行中：此时 [`Self::add_note`] 只写内容表，FTS 索引在
    /// [`Self::finish_rebuild`] 里一次性 `rebuild`（比逐行写 FTS 快得多）。
    rebuilding: AtomicBool,
}

impl std::fmt::Debug for SearchIndex {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SearchIndex")
            .field("label", &self.label)
            .finish_non_exhaustive()
    }
}

impl SearchIndex {
    /// 打开（不存在则创建）索引库。父目录会自动创建。
    ///
    /// **坏库自愈**：缓存库**真的损坏**（断电、外部改坏）时删掉重建 —— 这是 ADR-0002 的直接推论：
    /// 派生数据没有"必须保留"的部分。
    ///
    /// **但自愈只认"真损坏"**（见 [`is_corruption`]）：锁冲突（另一个构建正在写同一个库）、
    /// 磁盘满、权限不足/Vault 只读都是一次性/环境问题，原样返回给调用方降级即可。
    /// 曾经这里不分青红皂白地删库，于是并发打开 Vault 时一个 `SQLITE_BUSY`
    /// 就把**完全健康**的缓存删了，用户白等一次十几秒的重建。
    pub fn open(path: &Path) -> Result<Self> {
        match Self::try_open(path) {
            Ok(index) => Ok(index),
            Err(failure) if failure.corrupt(path) => {
                let deleted = remove_db_files(path);
                log::warn!(
                    "全文搜索缓存库损坏，删掉重建（{}）：{failure}；已删除 {}",
                    path.display(),
                    describe_deleted(&deleted)
                );
                Self::try_open(path).map_err(|second| second.into_error(&label_of(path)))
            }
            // 环境问题（锁冲突/磁盘满/权限）：原样上报，由调用方降级，绝不删健康缓存
            Err(failure) => Err(failure.into_error(&label_of(path))),
        }
    }

    /// 内存库（单测与"临时索引"用；生产路径永远是文件）。
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().map_err(|error| db_error(":memory:", error))?;
        Self::from_connection(conn, ":memory:").map_err(|failure| failure.into_error(":memory:"))
    }

    /// 全量重建专用：**先删掉旧库文件再建**，得到一个空库。
    ///
    /// 为什么不留用旧文件：整库重写时 `DELETE FROM lines` 要为几十万行写 WAL，
    /// 而"删文件 + 新建"是常数级开销；顺带还解决了"应用没开时外面删掉的文件在索引里残留"。
    /// 删不掉（例如另一个实例正开着这个库）则退回打开旧库，由 [`Self::begin_rebuild`] 就地清空。
    ///
    /// **生产路径不再用它**：打开 Vault 现在优先复用缓存（[`Self::open`] + 增量对账），
    /// 只有"确定要整库重来"的场景与基准测试还需要它。
    pub fn open_for_rebuild(path: &Path) -> Result<Self> {
        remove_db_files(path);
        Self::open(path)
    }

    fn try_open(path: &Path) -> std::result::Result<Self, OpenFailure> {
        if let Some(parent) = path.parent() {
            // Vault 只读 / 磁盘满：这里就会失败，调用方据此降级（日志 warn + IO 错误）
            std::fs::create_dir_all(parent)
                .map_err(|error| OpenFailure::Io(Error::io(parent, error)))?;
        }
        let conn = Connection::open(path).map_err(OpenFailure::Db)?;
        let label = label_of(path);
        // **第一步就设 busy_timeout**：后面任何会取锁的语句（尤其是 `journal_mode = WAL`）
        // 撞上别的连接在写时都要在此等待，而不是立刻抛 `SQLITE_BUSY` ——
        // 曾经的顺序（先 WAL、后 timeout）让一次瞬时锁冲突变成"库损坏/不可用"。
        conn.busy_timeout(std::time::Duration::from_millis(BUSY_TIMEOUT_MS))
            .map_err(OpenFailure::Db)?;
        conn.execute_batch(
            "PRAGMA synchronous = NORMAL;
             PRAGMA cache_size = -32768;
             PRAGMA foreign_keys = OFF;",
        )
        .map_err(OpenFailure::Db)?;
        // 会取写锁的 PRAGMA 放在最后（它要改库文件头，是唯一真正可能撞锁的语句）
        conn.query_row("PRAGMA journal_mode = WAL", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(OpenFailure::Db)?;
        Self::from_connection(conn, &label)
    }

    /// 建表 + schema 版本检查。SQLite 错误原样带出去：自愈判定要按错误码分类（见 [`is_corruption`]）。
    fn from_connection(conn: Connection, label: &str) -> std::result::Result<Self, OpenFailure> {
        conn.execute_batch(SCHEMA).map_err(OpenFailure::Db)?;
        // schema 版本不符（老版本留下的库）：直接重建，不做迁移
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(OpenFailure::Db)?;
        if version != SCHEMA_VERSION {
            conn.execute_batch(&drop_all_tables())
                .map_err(OpenFailure::Db)?;
            conn.execute_batch(SCHEMA).map_err(OpenFailure::Db)?;
            conn.pragma_update(None, "user_version", SCHEMA_VERSION)
                .map_err(OpenFailure::Db)?;
        }
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            label: label.to_string(),
            rebuilding: AtomicBool::new(false),
        })
    }

    /// 拿连接。`Connection` 不是 `Sync`，索引与链接两条路都以它串行 —— 同一把锁，
    /// 因此"链接写完了、行还没写完"这种中间态在库里根本不存在（要么都在事务里，要么都不在）。
    fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// 链接 / 标签落盘数据的写句柄（挂到 [`crate::LinkIndex`] 上用，见 ADR-0014）。
    ///
    /// 返回的是一个廉价句柄：它与本索引**共用同一个连接**，所以链接那一半的写入
    /// 会与这里的行/元数据写入落在同一个事务域里。
    pub fn index_store(&self) -> IndexStore {
        IndexStore {
            conn: Arc::clone(&self.conn),
            label: self.label.clone(),
        }
    }

    /// 读出库里**所有**笔记的落盘数据（跨会话复用：装回内存时用）。
    ///
    /// 只有 `link_notes` 里出现过的路径才算有数据：零链接零标签的笔记在那三张表里是空的，
    /// 没有这张凭证就分不出"这篇什么都没有"与"这篇的数据丢了"。同一路径的行按 `ord` 升序读出，
    /// 因此**文档内顺序原样保留**。
    ///
    /// 读到无法解释的值（未知的链接类型、行号越界）时返回错误：那说明库里的数据不是我们写的，
    /// 调用方应当退回"读文件重建"，而不是拿一份看不懂的数据去凑索引。
    pub fn load_index_data(&self) -> Result<Vec<NoteIndexData>> {
        let conn = self.conn();
        load_index_data(&conn).map_err(|error| self.db(error))
    }

    /// 索引规模。
    pub fn counts(&self) -> Result<SearchCounts> {
        let conn = self.conn();
        let lines: i64 = conn
            .query_row("SELECT COUNT(*) FROM lines", [], |row| row.get(0))
            .map_err(|error| self.db(error))?;
        let notes: i64 = conn
            .query_row("SELECT COUNT(DISTINCT rel_path) FROM lines", [], |row| {
                row.get(0)
            })
            .map_err(|error| self.db(error))?;
        Ok(SearchCounts {
            notes: notes.max(0) as usize,
            lines: lines.max(0) as usize,
        })
    }

    // -- 全量重建（构建路径） ---------------------------------------------------

    /// 开始全量重建：一个事务 + 清空行表与元数据表。
    ///
    /// 随后用 [`Self::add_note_with_meta`] 逐篇灌入（**只有内容表**），最后 [`Self::finish_rebuild`]
    /// 一条 `rebuild` 把 FTS 索引整体建起来。任何一步失败都要 [`Self::abort_rebuild`]。
    ///
    /// 元数据表也一起清空：这一轮会把**所有**笔记重新写一遍（调用方只在"一篇都留不住"时
    /// 才走这条路，见 [`IncrementalPlan::needs_full_rebuild`]），留着旧元数据只会挡住下一次复用。
    ///
    /// 整库重写期间刻意**放宽持久化**（`journal_mode=MEMORY` + `synchronous=OFF` + 大页缓存）：
    /// 这是几十万行的批量写，走完整 WAL+fsync 要多花好几秒。代价是"构建中途断电可能留下坏库"，
    /// 而这对**派生数据**是可接受的 —— [`Self::open`] 会自愈（删掉重建）。
    pub fn begin_rebuild(&self) -> Result<()> {
        let conn = self.conn();
        conn.execute_batch(
            "PRAGMA journal_mode = MEMORY;
             PRAGMA synchronous = OFF;
             PRAGMA cache_size = -131072;
             BEGIN IMMEDIATE;
             DELETE FROM lines;
             DELETE FROM notes_meta;
             DELETE FROM link_notes;
             DELETE FROM link_refs;
             DELETE FROM tag_refs;",
        )
        .map_err(|error| self.db(error))?;
        self.rebuilding.store(true, Ordering::Relaxed);
        Ok(())
    }

    /// 追加一篇笔记的所有行（重建与增量共用）。
    ///
    /// 返回写入的行数。空白行不进索引（搜不到任何东西，没必要占位置），
    /// 但**行号仍然是文件里的绝对行号**。
    ///
    /// 调用方负责"这篇的旧行已经清掉"（重建时是全表清空，增量时是 [`Self::begin_incremental`]）。
    pub fn add_note(&self, rel_path: &str, text: &str) -> Result<usize> {
        let rel = normalize_rel(rel_path);
        let conn = self.conn();
        add_rows(&conn, self.rebuilding.load(Ordering::Relaxed), &rel, text)
            .map_err(|error| self.db(error))
    }

    /// 追加一篇笔记的所有行，并**记下它的文件元数据**（跨会话增量复用的依据）。
    ///
    /// 构建路径（重建与增量）都用它，`add_note` 保持"只写行"的原义。
    /// 元数据与行写在同一个事务里：不可能出现"内容更新了、元数据还是旧的"这种
    /// 会让下一轮把改动当成"没变"的状态。
    ///
    /// 链接 / 标签的落盘数据由调用方在**同一次遍历里**通过 [`Self::index_store`] 写进同一个连接
    /// （见 `mn_index::build_indexes`），因此三者共享同一个事务，不存在两半各自提交的可能。
    pub fn add_note_with_meta(
        &self,
        rel_path: &str,
        text: &str,
        mtime_ms: Option<u64>,
        size_bytes: u64,
    ) -> Result<usize> {
        let rel = normalize_rel(rel_path);
        let conn = self.conn();
        let bulk = self.rebuilding.load(Ordering::Relaxed);
        let written = add_rows(&conn, bulk, &rel, text).map_err(|error| self.db(error))?;
        conn.execute(
            UPSERT_META,
            params![rel, mtime_stamp(mtime_ms), size_stamp(size_bytes)],
        )
        .map_err(|error| self.db(error))?;
        Ok(written)
    }

    /// 结束全量重建：重建 FTS 索引、合并段、提交，并把持久化设置调回正常档。
    pub fn finish_rebuild(&self) -> Result<()> {
        let conn = self.conn();
        let result = conn.execute_batch(
            "INSERT INTO lines_fts(lines_fts) VALUES('rebuild');
             INSERT INTO lines_fts(lines_fts) VALUES('optimize');
             COMMIT;",
        );
        self.rebuilding.store(false, Ordering::Relaxed);
        restore_pragmas(&conn);
        result.map_err(|error| self.db(error))
    }

    /// 放弃全量重建（取消、出错）：回滚，库里仍是上一轮提交的内容。
    pub fn abort_rebuild(&self) {
        let conn = self.conn();
        self.rebuilding.store(false, Ordering::Relaxed);
        if let Err(error) = conn.execute_batch("ROLLBACK") {
            // 没有活动事务时会走到这里（正常情况），不值得 warn
            log::debug!("全文搜索重建回滚：{error}");
        }
        restore_pragmas(&conn);
    }

    // -- 跨会话增量复用（打开 Vault 时） -----------------------------------------
    /// 与库里的元数据对账，算出这一轮要写什么（**只读，不改库**）。
    ///
    /// `notes` 必须是这一轮真正要索引的那些笔记（调用方已按扩展名过滤），
    /// 因为判定"库里还多出来的路径"要靠它。判定键是 `(path, mtime_ms, size)`：
    ///
    /// * 三个都对上 → 这篇**原样留用**，调用方一行都不用写（FTS 表一个字节都不动）；
    /// * 新增 / 改动 / mtime 不可得 → 重写；
    /// * 库里有、这次扫描没有 → 删掉（被删、改名走了、或不再是笔记）。
    ///
    /// 取路径集合时用的是 `notes_meta ∪ lines` 而不是只看元数据表：单篇增量写入
    /// （[`Self::upsert_note`]）与直接调 [`Self::add_note`] 的调用方可能只写了行表，
    /// 漏掉它们会让旧行永远留在搜索结果里。
    pub fn plan_incremental(&self, notes: &[&EntryMeta]) -> Result<IncrementalPlan> {
        let conn = self.conn();
        let mut stored: HashMap<String, (i64, i64)> = HashMap::new();
        {
            let mut statement = conn.prepare(SELECT_META).map_err(|error| self.db(error))?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })
                .map_err(|error| self.db(error))?;
            for row in rows {
                let (path, mtime_ms, size) = row.map_err(|error| self.db(error))?;
                stored.insert(path, (mtime_ms, size));
            }
        }

        let mut indexed: Vec<String> = Vec::new();
        {
            let mut statement = conn
                .prepare(SELECT_INDEXED_PATHS)
                .map_err(|error| self.db(error))?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| self.db(error))?;
            for row in rows {
                indexed.push(row.map_err(|error| self.db(error))?);
            }
        }

        // 扫描结果是路径的权威写法（扫描统一用 `/`）；库里的路径在写入时也做了归一化
        let mut scanned: HashSet<&str> = HashSet::with_capacity(notes.len());
        let mut changed = Vec::new();
        let mut reused = 0usize;
        for entry in notes {
            scanned.insert(entry.rel_path.as_str());
            if stored.get(&entry.rel_path) == Some(&stamp_of(entry)) {
                reused += 1;
            } else {
                changed.push(entry.rel_path.clone());
            }
        }

        let removed = indexed
            .into_iter()
            .filter(|path| !scanned.contains(path.as_str()))
            .collect();

        Ok(IncrementalPlan {
            changed,
            removed,
            reused,
        })
    }

    /// 开始增量写入：清掉"要重写"和"要删除"的那些路径的旧行（内容行 + FTS + 元数据，
    /// 以及链接/标签的落盘数据）。
    ///
    /// **先删后写**是这一段的语义：`changed` 里的路径随后会被 [`Self::add_note_with_meta`]
    /// 整篇重写，链接那一半则由 `LinkIndex::upsert` 的写穿透补上。读不到内容的笔记就停在
    /// "什么都没有"的状态 —— 这与整库重建的结果一致（重建时读不到的文件本来也不会进索引，
    /// 不会留着上一次的旧内容）。
    ///
    /// 不切 `journal_mode=MEMORY`：增量通常只碰几篇，走正常 WAL 才是对的
    /// （整库重写才需要放宽持久化，见 [`Self::begin_rebuild`]）。
    pub fn begin_incremental(&self, plan: &IncrementalPlan) -> Result<()> {
        let conn = self.conn();
        conn.execute_batch("BEGIN IMMEDIATE")
            .map_err(|error| self.db(error))?;
        for rel in plan.removed.iter().chain(plan.changed.iter()) {
            drop_note_rows(&conn, rel).map_err(|error| self.db(error))?;
        }
        Ok(())
    }

    /// 结束增量写入：提交；**段攒多了就顺手合并一次**（见 [`Self::optimize_if_fragmented`]）。
    ///
    /// 这里曾经写的是"刻意**不做** `rebuild`/`optimize`"——那时的理由是"optimize 要为整个索引
    /// 合并段，几百 MB 的库上本身是秒级成本，正是增量这一轮要省掉的东西"。**那个理由对一半**：
    /// 每次增量都合并确实不该（0.9 s 白花），但**永远不合并**会让查询慢下来 —— 实测跑了 20 轮
    /// 增量之后段数在 11–18 之间浮动，查询平均 76.9 ms；合并成 1 个段后是 45.8 ms（1.68×，
    /// 另一个批次里是 2.2×）。所以改成**按段数触发**：低于阈值一个字节都不动，高于阈值合并一次。
    pub fn finish_incremental(&self) -> Result<()> {
        self.conn()
            .execute_batch("COMMIT")
            .map_err(|error| self.db(error))?;
        self.optimize_if_fragmented();
        Ok(())
    }

    /// 段数超过 [`OPTIMIZE_SEGMENT_THRESHOLD`] 就合并一次（否则什么都不做）。
    ///
    /// **失败只记日志**：合并是加速器，不是正确性的前提（ADR-0002：这一切都是派生数据）。
    /// 一次成功的增量索引不该因为"顺手做的优化"失败而变成失败。
    fn optimize_if_fragmented(&self) {
        let count = match self.segment_count() {
            Ok(count) => count,
            Err(error) => {
                log::debug!("读不到 FTS5 段数，跳过合并：{error}");
                return;
            }
        };
        if count < OPTIMIZE_SEGMENT_THRESHOLD {
            return;
        }
        let started = Instant::now();
        match self.optimize() {
            Ok(()) => log::debug!(
                "全文搜索索引合并：{} 个段 → 1 个（{} ms；查询会因此快 1.7–2.2×，见 SearchIndex::optimize 的实测）",
                count,
                started.elapsed().as_millis()
            ),
            Err(error) => log::warn!("全文搜索索引合并失败（不影响搜索结果，只是慢一点）：{error}"),
        }
    }

    // -- 增量更新（保存/新建/删除/重命名） --------------------------------------

    /// 重写一篇笔记的**内容行**（保存、新建后调用）。自己开关事务。
    ///
    /// 刻意**不碰**链接 / 标签的落盘数据：那是链接索引那一半的事（保存链路里它先跑一步），
    /// 在这里顺手删掉就会把刚写进去的数据抹掉，让这一篇下次打开白读一次文件。
    ///
    /// 顺手**删掉这篇的元数据行**：这里拿不到文件 mtime/size，而"不知道"必须表达成
    /// "下一篇必须重读"（元数据行不存在就永远不会被判成"没变"）。
    /// 留着过期元数据才是危险的：改动后的文件若 mtime/size 恰好与旧值相同，就会被误判为没变。
    ///
    /// 链接 / 标签那一半由 [`crate::LinkIndex::upsert`] 通过 [`IndexStore::replace_note`] 同步，
    /// 而它同样会作废判定键 —— 两半因此都停在"下一篇必须重读"的状态，不会有一半被信任。
    pub fn upsert_note(&self, rel_path: &str, text: &str) -> Result<usize> {
        let rel = normalize_rel(rel_path);
        let conn = self.conn();
        let bulk = self.rebuilding.load(Ordering::Relaxed);
        in_transaction(&conn, |conn| {
            drop_content_rows(conn, &rel)?;
            add_rows(conn, bulk, &rel, text)
        })
        .map_err(|error| self.db(error))
    }

    /// 合并 FTS5 的所有段（`optimize`）。
    ///
    /// **它解决的是查询速度，不是磁盘占用** —— 这一点要写在最前面，因为它跟直觉相反，
    /// 而我最初的判断正是错的：
    ///
    /// * 1 万篇 / 30 万行的库里跑 20 轮增量（每轮改 200 篇）之后，`optimize` **一个字节都没回收**
    ///   （118.5 MB → 118.5 MB）：SQLite 把释放的页留在文件里（freelist），文件大小不掉。
    ///   作者真实 Vault 的 207 MB 缓存库实测只有 **1 个段**（全量重建时已经 optimize 过），
    ///   所以"段膨胀撑大了库"这个猜测是**错的**；
    /// * 但它把**查询平均耗时从 82.8 ms 降到 37.3 ms（2.2×）**，代价是一次 937 ms 的全库重写 ——
    ///   bm25 打分要跨段读倒排表，段越少扫得越少。
    ///
    /// **什么时候该调**：增量写入会不断产生新段（FTS5 的 automerge 只做对数级合并，不会并成 1 个），
    /// 所以"跑了很久的增量库"会攒出十几个到几十个段。判据用 [`Self::segment_count`]，别按时间猜。
    /// 基准见 `lib.rs` 的 `bench_optimize_after_incremental`
    /// （`cargo test -p mn-index --release -- --ignored --nocapture bench_optimize_after_incremental`）。
    ///
    /// **调用方要克制**：这是一次全库重写（30 万行约 0.9 s），不该挂在每次保存后面。
    pub fn optimize(&self) -> Result<()> {
        let conn = self.conn();
        conn.execute_batch("INSERT INTO lines_fts(lines_fts) VALUES('optimize')")
            .map_err(|error| self.db(error))
    }

    /// FTS5 当前有多少个段（`distinct segid`）。
    ///
    /// 为什么单独暴露：它是"要不要 [`Self::optimize`]"的**判据** —— 段数是 FTS5 自己合并策略的
    /// 结果（写入模式不同，同样的写入量攒出的段数差别很大），按时间或写入次数猜都不靠谱。
    /// 代价是一次小表扫描（`lines_fts_idx` 每行一个「段 × 词」条目，真实库里 2000 行量级，亚毫秒）。
    /// 空库返回 0。
    pub fn segment_count(&self) -> Result<usize> {
        let conn = self.conn();
        let count: i64 = conn
            .query_row(
                "SELECT count(DISTINCT segid) FROM lines_fts_idx",
                [],
                |row| row.get(0),
            )
            .map_err(|error| self.db(error))?;
        Ok(count.max(0) as usize)
    }

    /// 删除一篇笔记（或其整棵子树）的全部落盘数据：内容行、FTS 行、链接/标签数据与判定键。
    pub fn remove_note(&self, rel_path: &str) -> Result<usize> {
        let rel = normalize_rel(rel_path);
        let conn = self.conn();
        in_transaction(&conn, |conn| {
            let pattern = subtree_pattern(&rel);
            conn.execute(FTS_DELETE_SUBTREE, params![rel, pattern])?;
            conn.execute(DELETE_META_SUBTREE, params![rel, pattern])?;
            conn.execute(DELETE_LINK_NOTES_SUBTREE, params![rel, pattern])?;
            conn.execute(DELETE_LINK_REFS_SUBTREE, params![rel, pattern])?;
            conn.execute(DELETE_TAG_REFS_SUBTREE, params![rel, pattern])?;
            conn.execute(DELETE_SUBTREE, params![rel, pattern])
        })
        .map_err(|error| self.db(error))
    }

    /// 改名：把旧路径的行、元数据与链接/标签数据搬到新路径。
    ///
    /// **不需要动 FTS 索引** —— `rel_path` 不是 FTS 列。元数据可以直接搬：
    /// 改名不改文件内容，mtime 与 size 都还是原来那个值（搬过去等于继续复用这一篇）。
    ///
    /// 链接 / 标签数据同样直接搬（它们以路径为主键）。注意这不是"改名后就不必更新索引"：
    /// 被改写的文件（正文里的链接目标变了）由调用方重新 `upsert`，那是另一件事 ——
    /// 这里只管"这一篇的数据跟着它走"。
    pub fn rename_note(&self, old_rel_path: &str, new_rel_path: &str) -> Result<usize> {
        let old = normalize_rel(old_rel_path);
        let new = normalize_rel(new_rel_path);
        let conn = self.conn();
        in_transaction(&conn, |conn| {
            // 目标位置若有残留元数据（同名文件先删后建），先清掉，避免主键冲突
            conn.execute(DELETE_META_PATH, params![new])?;
            conn.execute(DELETE_LINK_NOTES_PATH, params![new])?;
            conn.execute(DELETE_LINK_REFS_PATH, params![new])?;
            conn.execute(DELETE_TAG_REFS_PATH, params![new])?;
            let moved = conn.execute(RENAME_PATH, params![new, old])?;
            conn.execute(RENAME_META, params![new, old])?;
            conn.execute(RENAME_LINK_NOTES, params![new, old])?;
            conn.execute(RENAME_LINK_REFS, params![new, old])?;
            conn.execute(RENAME_TAG_REFS, params![new, old])?;
            Ok(moved)
        })
        .map_err(|error| self.db(error))
    }

    // -- 查询 -------------------------------------------------------------------

    /// 全文检索：`bm25()` 排序 → 取 `limit` 条 + 命中总数。
    ///
    /// 排序是**全序**（`score` → `rel_path` → `line`），前端不需要二次排序。
    pub fn search(&self, raw_query: &str, limit: u32) -> Result<SearchOutcome> {
        let Some(match_query) = build_match_query(raw_query) else {
            // 没有可查的词（空串、只有标点）：不碰数据库，直接空结果
            return Ok(SearchOutcome {
                hits: Vec::new(),
                total: 0,
            });
        };
        let terms = query_terms(raw_query);
        let conn = self.conn();

        let total: i64 = conn
            .query_row(COUNT_MATCH, params![match_query], |row| row.get(0))
            .map_err(|error| self.db(error))?;

        let mut statement = conn.prepare(QUERY_MATCH).map_err(|error| self.db(error))?;
        let rows = statement
            .query_map(params![match_query, limit], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, u32>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, f64>(3)?,
                ))
            })
            .map_err(|error| self.db(error))?;

        let mut hits = Vec::new();
        for row in rows {
            let (rel_path, line, text, score) = row.map_err(|error| self.db(error))?;
            hits.push(SearchHit {
                rel_path,
                line,
                snippet: build_snippet(&text, &terms),
                score,
            });
        }

        Ok(SearchOutcome {
            total: total.max(0) as u32,
            hits,
        })
    }

    // -- 内部 -------------------------------------------------------------------

    /// rusqlite 错误 → mn-core 错误（稳定错误码 `IO`，原始原因进 `detail`）。
    fn db(&self, error: rusqlite::Error) -> Error {
        db_error(&self.label, error)
    }
}

// ---------------------------------------------------------------------------
// 落盘句柄：链接 / 标签索引的写穿透（ADR-0014）
// ---------------------------------------------------------------------------

/// [`crate::LinkIndex`] 的落盘句柄：**每次索引变化都同步写进缓存库**，下次打开才能整批复用。
///
/// 为什么写成句柄而不是让索引自己开库：它与 [`SearchIndex`] 共用同一个连接与事务域
/// （见 [`SearchIndex::index_store`]），因此"链接写完了、行没写完"这种中间态在库里不存在。
///
/// 写失败一律只记 warn：落盘是**加速器**，不是正确性的前提 —— 失败时判定键（`notes_meta`）
/// 也没被更新，下次打开会重读这一篇，结果是正确的，只是慢一点。反过来（写失败却留下一个
/// 被信任的判定键）才是必须避免的，所以每次写入都在**同一个事务**里顺手删掉这篇的判定键。
#[derive(Clone)]
pub struct IndexStore {
    conn: Arc<Mutex<Connection>>,
    label: String,
}

impl std::fmt::Debug for IndexStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IndexStore")
            .field("label", &self.label)
            .finish_non_exhaustive()
    }
}

impl IndexStore {
    fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn db(&self, error: rusqlite::Error) -> Error {
        db_error(&self.label, error)
    }

    /// 用一篇笔记的解析结果替换它的落盘数据，并**作废它的判定键**。
    ///
    /// "作废判定键"是这里唯一不能省的一步：写盘时手上没有文件 mtime/size，而"不知道"
    /// 必须表达成"下一篇必须重读"。在构建路径上，调用方紧接着就会用真实的 mtime/size
    /// 重新写一次判定键（同一个事务），所以这一步不会白白浪费一次复用。
    pub fn replace_note(&self, rel_path: &str, data: &NoteIndexData) -> Result<()> {
        let rel = normalize_rel(rel_path);
        let conn = self.conn();
        in_transaction(&conn, |conn| {
            drop_rows_exact(conn, &rel)?;
            conn.execute(INSERT_LINK_NOTE, params![rel, data.title])?;
            {
                let mut insert = conn.prepare_cached(INSERT_LINK_REF)?;
                for (ord, link) in data.links.iter().enumerate() {
                    insert.execute(params![
                        rel,
                        ord as i64,
                        kind_to_str(link.kind),
                        link.raw_target,
                        link.alias,
                        link.anchor,
                        link.line as i64,
                    ])?;
                }
            }
            {
                let mut insert = conn.prepare_cached(INSERT_TAG_REF)?;
                for (ord, tag) in data.tags.iter().enumerate() {
                    insert.execute(params![
                        rel,
                        ord as i64,
                        tag.tag,
                        source_to_str(tag.source),
                        tag.line as i64,
                    ])?;
                }
            }
            conn.execute(DELETE_META_PATH, params![rel])?;
            Ok(())
        })
        .map_err(|error| self.db(error))
    }

    /// 删掉一篇笔记（**或其整棵子树**）的落盘数据与判定键。
    ///
    /// 用子树匹配而不是精确路径：删目录时调用方会逐个后代调用它，但内存索引可能是半截的
    /// （构建被取消），漏掉的那些行就会永远留在库里。路径与它的后代不可能同时是有效笔记
    /// （同名文件与目录不能并存），所以"多删一层"永远是安全的方向。
    pub fn drop_note(&self, rel_path: &str) -> Result<()> {
        let rel = normalize_rel(rel_path);
        let conn = self.conn();
        in_transaction(&conn, |conn| {
            let pattern = subtree_pattern(&rel);
            conn.execute(DELETE_META_SUBTREE, params![rel, pattern])?;
            conn.execute(DELETE_LINK_NOTES_SUBTREE, params![rel, pattern])?;
            conn.execute(DELETE_LINK_REFS_SUBTREE, params![rel, pattern])?;
            conn.execute(DELETE_TAG_REFS_SUBTREE, params![rel, pattern])?;
            Ok(())
        })
        .map_err(|error| self.db(error))
    }

    /// 读出库里所有笔记的落盘数据（与 [`SearchIndex::load_index_data`] 同一实现）。
    pub fn load_all(&self) -> Result<Vec<NoteIndexData>> {
        let conn = self.conn();
        load_index_data(&conn).map_err(|error| self.db(error))
    }

    /// 库里有多少篇笔记的落盘数据（日志与测试用）。
    pub fn note_count(&self) -> Result<usize> {
        let conn = self.conn();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM link_notes", [], |row| row.get(0))
            .map_err(|error| self.db(error))?;
        Ok(count.max(0) as usize)
    }
}

// ---------------------------------------------------------------------------
// 事务与语句级助手（链接那一半与搜索那一半共用）
// ---------------------------------------------------------------------------

/// 在一个事务里跑一段写操作，失败回滚。
///
/// **已经身处事务里时不再开新事务**：构建路径（`begin_rebuild` / `begin_incremental`）会握着
/// 一个跨越几百篇笔记的事务，链接那一半的写入必须参与其中 —— 那正是"行与判定键一起提交、
/// 一起回滚"的实现方式。SQLite 不允许嵌套 `BEGIN`，所以这里必须显式判断（`is_autocommit`）。
fn in_transaction<T>(
    conn: &Connection,
    body: impl FnOnce(&Connection) -> rusqlite::Result<T>,
) -> rusqlite::Result<T> {
    if !conn.is_autocommit() {
        return body(conn);
    }
    conn.execute_batch("BEGIN IMMEDIATE")?;
    match body(conn) {
        Ok(value) => {
            conn.execute_batch("COMMIT")?;
            Ok(value)
        }
        Err(error) => {
            if let Err(rollback) = conn.execute_batch("ROLLBACK") {
                log::debug!("索引事务回滚失败：{rollback}");
            }
            Err(error)
        }
    }
}

/// 追加一篇笔记的**内容行**（重建与增量共用；`bulk` = 整库重建中，FTS 索引稍后一次建）。
fn add_rows(conn: &Connection, bulk: bool, rel: &str, text: &str) -> rusqlite::Result<usize> {
    let mut insert = conn.prepare_cached(INSERT_LINE)?;
    let mut insert_fts = if bulk {
        None
    } else {
        Some(conn.prepare_cached(INSERT_FTS)?)
    };

    let mut count = 0usize;
    for (line_no, line) in indexable_lines(text) {
        let indexed = space_cjk(line);
        insert.execute(params![rel, line_no, line, indexed])?;
        if let Some(statement) = insert_fts.as_mut() {
            statement.execute(params![conn.last_insert_rowid(), indexed])?;
        }
        count += 1;
    }
    Ok(count)
}

/// 删掉某个路径的行（先给 FTS 发 `'delete'`，再删内容行）。
fn drop_path_rows(conn: &Connection, rel: &str) -> rusqlite::Result<usize> {
    conn.execute(FTS_DELETE_PATH, params![rel])?;
    conn.execute(DELETE_PATH, params![rel])
}

/// 删掉某个路径的**内容行**与判定键。
///
/// 刻意**不碰**链接 / 标签那三张表：保存一篇时链接那一半由 [`IndexStore::replace_note`]
/// 负责（它自己先删后写），这里若顺手把它们一起删掉，就会出现"链接数据刚写进去就被抹掉" ——
/// 结果是这一篇下次打开被迫重读（正确但慢），而那正是最容易在测试里漏过去的退化。
fn drop_content_rows(conn: &Connection, rel_path: &str) -> rusqlite::Result<usize> {
    let rel = normalize_rel(rel_path);
    let dropped = drop_path_rows(conn, &rel)?;
    conn.execute(DELETE_META_PATH, params![rel])?;
    Ok(dropped)
}

/// 删掉某个路径的**全部**落盘数据：内容行、链接/标签数据与判定键。
///
/// 用在"这篇要么被删除、要么会被整篇重写"的地方（对账时把 `changed` + `removed` 一起清掉）：
/// 读内容失败时它就停在"什么都没有"的状态 —— 与整库重建的结果一致。
/// 不自己开关事务：调用方在事务里连着删好几篇。
fn drop_note_rows(conn: &Connection, rel_path: &str) -> rusqlite::Result<usize> {
    let rel = normalize_rel(rel_path);
    let dropped = drop_content_rows(conn, &rel)?;
    conn.execute(DELETE_LINK_NOTES_PATH, params![rel])?;
    conn.execute(DELETE_LINK_REFS_PATH, params![rel])?;
    conn.execute(DELETE_TAG_REFS_PATH, params![rel])?;
    Ok(dropped)
}

/// 删掉某个路径的链接/标签落盘数据（精确路径，`replace_note` 先清后写用）。
fn drop_rows_exact(conn: &Connection, rel: &str) -> rusqlite::Result<()> {
    conn.execute(DELETE_LINK_NOTES_PATH, params![rel])?;
    conn.execute(DELETE_LINK_REFS_PATH, params![rel])?;
    conn.execute(DELETE_TAG_REFS_PATH, params![rel])?;
    Ok(())
}

/// 把连接调回"日常档"（见 [`SearchIndex::restore_pragmas`]）。
fn restore_pragmas(conn: &Connection) {
    if let Err(error) = conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA cache_size = -32768;",
    ) {
        log::debug!("全文搜索持久化设置复位失败（不影响查询）：{error}");
    }
}

/// 把库里的链接 / 标签 / 标题读成一颗"路径 → 数据"的表。
///
/// 只有 `link_notes` 里出现过的路径才算有数据（`link_refs` / `tag_refs` 里的孤儿行属于
/// 上一个版本或者失败写入留下的垃圾，直接忽略 —— 它们绝不能被当成"这篇的数据"）。
fn load_index_data(conn: &Connection) -> rusqlite::Result<Vec<NoteIndexData>> {
    let mut out: BTreeMap<String, NoteIndexData> = BTreeMap::new();

    {
        let mut statement = conn.prepare(SELECT_LINK_NOTES)?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?;
        for row in rows {
            let (path, title) = row?;
            out.insert(
                path.clone(),
                NoteIndexData {
                    rel_path: path,
                    links: Vec::new(),
                    title,
                    tags: Vec::new(),
                },
            );
        }
    }

    {
        let mut statement = conn.prepare(SELECT_LINK_REFS)?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })?;
        for row in rows {
            let (path, kind, raw_target, alias, anchor, line) = row?;
            // 看不懂的取值只可能来自"不是我们写的数据"：报错让调用方退回读文件重建
            let Some(kind) = kind_from_str(&kind) else {
                return Err(decode_error("链接类型", &kind));
            };
            let Some(line) = u32::try_from(line).ok() else {
                return Err(decode_error("链接行号", &line.to_string()));
            };
            if let Some(data) = out.get_mut(&path) {
                data.links.push(LinkRef {
                    kind,
                    raw_target,
                    alias,
                    anchor,
                    line,
                });
            }
        }
    }

    {
        let mut statement = conn.prepare(SELECT_TAG_REFS)?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?;
        for row in rows {
            let (path, tag, source, line) = row?;
            let Some(source) = source_from_str(&source) else {
                return Err(decode_error("标签来源", &source));
            };
            let Some(line) = u32::try_from(line).ok() else {
                return Err(decode_error("标签行号", &line.to_string()));
            };
            if let Some(data) = out.get_mut(&path) {
                data.tags.push(TagRef { tag, source, line });
            }
        }
    }

    Ok(out.into_values().collect())
}

/// "库里的值看不懂"错误：带上字段名与取值，日志里能直接看出是哪一列坏了。
fn decode_error(field: &str, value: &str) -> rusqlite::Error {
    rusqlite::Error::InvalidColumnType(
        0,
        format!("{field}（缓存库里的值无法解释：{value:?}）"),
        rusqlite::types::Type::Text,
    )
}

/// 链接类型的落盘写法（与前端看到的 `serde` 取值一致，`"wiki" | "embed" | "markdown"`）。
fn kind_to_str(kind: LinkKind) -> &'static str {
    match kind {
        LinkKind::Wiki => "wiki",
        LinkKind::Embed => "embed",
        LinkKind::Markdown => "markdown",
    }
}

fn kind_from_str(value: &str) -> Option<LinkKind> {
    match value {
        "wiki" => Some(LinkKind::Wiki),
        "embed" => Some(LinkKind::Embed),
        "markdown" => Some(LinkKind::Markdown),
        _ => None,
    }
}

/// 标签来源的落盘写法（与 `serde` 的 `"frontmatter" | "inline"` 一致）。
fn source_to_str(source: TagSource) -> &'static str {
    match source {
        TagSource::Frontmatter => "frontmatter",
        TagSource::Inline => "inline",
    }
}

fn source_from_str(value: &str) -> Option<TagSource> {
    match value {
        "frontmatter" => Some(TagSource::Frontmatter),
        "inline" => Some(TagSource::Inline),
        _ => None,
    }
}

/// schema 版本不符时要丢掉的全部表（少列一张就等于带着旧结构继续跑）。
fn drop_all_tables() -> String {
    [
        "DROP TABLE IF EXISTS lines_fts;",
        "DROP TABLE IF EXISTS lines;",
        "DROP TABLE IF EXISTS notes_meta;",
        "DROP TABLE IF EXISTS link_notes;",
        "DROP TABLE IF EXISTS link_refs;",
        "DROP TABLE IF EXISTS tag_refs;",
    ]
    .join("\n")
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const INSERT_LINE: &str =
    "INSERT INTO lines(rel_path, line, text, indexed_text) VALUES (?1, ?2, ?3, ?4)";
const INSERT_FTS: &str = "INSERT INTO lines_fts(rowid, indexed_text) VALUES (?1, ?2)";
/// external content 表必须**显式**告诉 FTS5"这些行要删"，否则索引里会残留旧 token
/// （残留会让搜索命中已经不存在的行，随后 JOIN 出空结果甚至报错）。
const FTS_DELETE_PATH: &str =
    "INSERT INTO lines_fts(lines_fts, rowid, indexed_text) SELECT 'delete', id, indexed_text FROM lines WHERE rel_path = ?1";
const FTS_DELETE_SUBTREE: &str =
    "INSERT INTO lines_fts(lines_fts, rowid, indexed_text) SELECT 'delete', id, indexed_text FROM lines WHERE rel_path = ?1 OR rel_path LIKE ?2 ESCAPE '\\'";
const DELETE_PATH: &str = "DELETE FROM lines WHERE rel_path = ?1";
const DELETE_SUBTREE: &str =
    "DELETE FROM lines WHERE rel_path = ?1 OR rel_path LIKE ?2 ESCAPE '\\'";
const RENAME_PATH: &str = "UPDATE lines SET rel_path = ?1 WHERE rel_path = ?2";
/// 写入/覆盖一篇笔记的文件元数据（`(mtime, size)` 就是增量复用的判定键）。
const UPSERT_META: &str = "INSERT INTO notes_meta(path, mtime_ms, size) VALUES (?1, ?2, ?3)
     ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size";
const DELETE_META_PATH: &str = "DELETE FROM notes_meta WHERE path = ?1";
const DELETE_META_SUBTREE: &str =
    "DELETE FROM notes_meta WHERE path = ?1 OR path LIKE ?2 ESCAPE '\\'";
const RENAME_META: &str = "UPDATE notes_meta SET path = ?1 WHERE path = ?2";
/// 链接 / 标签 / 标题的落盘语句（ADR-0014）。三张表都以**路径**为主键的一部分，
/// 所以改名、删除、子树清理都必须显式地跟着做（漏一张就会留下"旧路径下的幽灵数据"）。
const INSERT_LINK_NOTE: &str = "INSERT INTO link_notes(path, title) VALUES (?1, ?2)";
const INSERT_LINK_REF: &str =
    "INSERT INTO link_refs(path, ord, kind, raw_target, alias, anchor, line)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)";
const INSERT_TAG_REF: &str = "INSERT INTO tag_refs(path, ord, tag, source, line)
     VALUES (?1, ?2, ?3, ?4, ?5)";
const DELETE_LINK_NOTES_PATH: &str = "DELETE FROM link_notes WHERE path = ?1";
const DELETE_LINK_REFS_PATH: &str = "DELETE FROM link_refs WHERE path = ?1";
const DELETE_TAG_REFS_PATH: &str = "DELETE FROM tag_refs WHERE path = ?1";
const DELETE_LINK_NOTES_SUBTREE: &str =
    "DELETE FROM link_notes WHERE path = ?1 OR path LIKE ?2 ESCAPE '\\'";
const DELETE_LINK_REFS_SUBTREE: &str =
    "DELETE FROM link_refs WHERE path = ?1 OR path LIKE ?2 ESCAPE '\\'";
const DELETE_TAG_REFS_SUBTREE: &str =
    "DELETE FROM tag_refs WHERE path = ?1 OR path LIKE ?2 ESCAPE '\\'";
const RENAME_LINK_NOTES: &str = "UPDATE link_notes SET path = ?1 WHERE path = ?2";
const RENAME_LINK_REFS: &str = "UPDATE link_refs SET path = ?1 WHERE path = ?2";
const RENAME_TAG_REFS: &str = "UPDATE tag_refs SET path = ?1 WHERE path = ?2";
/// 装载时按 `path, ord` 排序读出：文档内顺序（图谱"首次出现的写法胜出"）靠它保留。
const SELECT_LINK_NOTES: &str = "SELECT path, title FROM link_notes";
const SELECT_LINK_REFS: &str =
    "SELECT path, kind, raw_target, alias, anchor, line FROM link_refs ORDER BY path, ord";
const SELECT_TAG_REFS: &str = "SELECT path, tag, source, line FROM tag_refs ORDER BY path, ord";
/// 库里**所有**有内容的路径（元数据表 ∪ 行表，理由见 [`SearchIndex::plan_incremental`]）。
///
/// 用 UNION 而不是只看 `notes_meta` 的代价是每轮打开要顺着 `lines_by_path` 索引扫一遍
/// （1 万笔记 / 30 万行实测 ≈ 150ms，相对"整轮打开 4.7s"可以接受）：换来的是**精确** ——
/// 单篇增量写入（`upsert_note` 会删掉该篇的元数据行）与直接调 `add_note` 的调用方留下的行
/// 都会被看见，不会永远残留在搜索结果里。
const SELECT_INDEXED_PATHS: &str =
    "SELECT path FROM notes_meta UNION SELECT DISTINCT rel_path FROM lines";
const SELECT_META: &str = "SELECT path, mtime_ms, size FROM notes_meta";
const COUNT_MATCH: &str = "SELECT COUNT(*) FROM lines_fts WHERE lines_fts MATCH ?1";
/// `-bm25()`：SQLite 的 `bm25()` 越小越相关，取负之后"越大越相关"，与契约一致。
const QUERY_MATCH: &str = "
SELECT l.rel_path, l.line, l.text, -bm25(lines_fts) AS score
FROM lines_fts
JOIN lines l ON l.id = lines_fts.rowid
WHERE lines_fts MATCH ?1
ORDER BY score DESC, l.rel_path ASC, l.line ASC
LIMIT ?2";

// ---------------------------------------------------------------------------
// 查询串与 snippet（纯函数，可单测）
// ---------------------------------------------------------------------------

/// 把用户输入转成**安全**的 FTS5 查询串；返回 `None` 表示没有可查的词。
///
/// 规则：按空白切词 → 丢掉不含字母数字的词（它们分词后是空的，包成短语会让 FTS5 报
/// `syntax error`）→ CJK 逐字切开 → **每个词包进双引号**（内部 `"` 转义成 `""`）→ 加前缀 `*`。
///
/// 引号是这里唯一的"安全性"来源：`( ) - : ^ * " OR AND NEAR` 在引号内全是普通字符，
/// 因此 `a"b(c)`、`-x`、`OR` 这些输入既能搜到东西，也**不会**让 `MATCH` 报错。
pub fn build_match_query(raw: &str) -> Option<String> {
    let terms = query_terms(raw);
    if terms.is_empty() {
        return None;
    }
    let quoted: Vec<String> = terms
        .iter()
        .map(|term| {
            let spaced = space_cjk(term);
            format!("\"{}\"*", spaced.replace('"', "\"\""))
        })
        .collect();
    Some(quoted.join(" "))
}

/// 查询串里的**原始**词（未加引号、未切开 CJK）：`snippet` 定位命中位置要用它。
fn query_terms(raw: &str) -> Vec<String> {
    raw.split_whitespace()
        .take(MAX_QUERY_TERMS)
        .filter(|term| term.chars().any(char::is_alphanumeric))
        .map(|term| term.chars().take(MAX_TERM_CHARS).collect())
        .collect()
}

/// 给 CJK 逐字插空格（入库与查询两侧必须用同一个函数，否则永远匹配不上）。
fn space_cjk(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    let mut space_pending = false;
    for c in text.chars() {
        if is_cjk(c) {
            if !out.is_empty() && !out.ends_with(' ') {
                out.push(' ');
            }
            out.push(c);
            space_pending = true;
        } else {
            if space_pending && !c.is_whitespace() {
                out.push(' ');
            }
            space_pending = false;
            out.push(c);
        }
    }
    out
}

/// 是否 CJK 表意文字/假名/谚文（这些字符在 `unicode61` 下不会互相分词，必须自己切开）。
fn is_cjk(c: char) -> bool {
    matches!(c,
        '\u{1100}'..='\u{11ff}'   // 谚文字母
        | '\u{3040}'..='\u{30ff}' // 平假名 / 片假名
        | '\u{3400}'..='\u{4dbf}' // CJK 扩展 A
        | '\u{4e00}'..='\u{9fff}' // CJK 基本区
        | '\u{ac00}'..='\u{d7af}' // 谚文音节
        | '\u{f900}'..='\u{faff}' // CJK 兼容表意文字
        | '\u{20000}'..='\u{3ffff}' // 扩展 B 及以后
    )
}

/// 行文本 → 单行 snippet：去首尾空白，超过 [`SNIPPET_CHARS`] 时**以命中位置为中心**裁剪，
/// 两侧按需加 `…`（省略号也占字符预算，最终长度不超过上限）。
fn build_snippet(line: &str, terms: &[String]) -> String {
    let text = line.trim();
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= SNIPPET_CHARS {
        return text.to_string();
    }

    // 命中位置尽量放在窗口靠前 1/3 处：前面留一点上下文，后面多一点看看后续内容
    let start = find_match(&chars, terms)
        .map(|at| at.saturating_sub(SNIPPET_CHARS / 3))
        .unwrap_or(0)
        .min(chars.len() - SNIPPET_CHARS);
    let head = start > 0;
    let tail = start + SNIPPET_CHARS < chars.len();

    // 两侧要加省略号时各让出 1 个字符，总长仍然恰好不超过 SNIPPET_CHARS
    let from = start + usize::from(head);
    let to = start + SNIPPET_CHARS - usize::from(tail);

    let mut out = String::with_capacity(SNIPPET_CHARS + 2);
    if head {
        out.push('…');
    }
    out.extend(chars[from..to].iter());
    if tail {
        out.push('…');
    }
    out
}

/// 命中位置（**字符**下标）：先找词的精确出现，再找"某个词的前缀"（前缀查询时命中处
/// 在行里只出现了一半）；都找不到返回 `None`（调用方从行首裁剪）。
fn find_match(chars: &[char], terms: &[String]) -> Option<usize> {
    if terms.is_empty() {
        return None;
    }
    // 逐字符小写化：**保持 1:1 对齐**（`char::to_lowercase()` 可能把一个字符变成多个，
    // 那会让命中位置的下标整体错位；这里只取首字符，snippet 定位够用）
    let folded: Vec<char> = chars.iter().copied().map(fold).collect();
    let needles: Vec<Vec<char>> = terms
        .iter()
        .map(|term| term.chars().map(fold).collect())
        .filter(|needle: &Vec<char>| !needle.is_empty())
        .collect();
    if needles.is_empty() {
        return None;
    }

    // 1) 精确出现：任意词优先，整体从左往右扫
    for start in 0..folded.len() {
        let rest = &folded[start..];
        if needles.iter().any(|needle| rest.starts_with(needle)) {
            return Some(start);
        }
    }
    // 2) 词首前缀（用户只打了一半：`hel` 命中 `hello`，行里找不到完整的 `hel`）
    let mut at_word_start = true;
    for (start, c) in folded.iter().enumerate() {
        if at_word_start {
            let rest = &folded[start..];
            if needles.iter().any(|needle| rest.starts_with(needle)) {
                return Some(start);
            }
        }
        at_word_start = !c.is_alphanumeric();
    }
    None
}

/// 单字符小写（1:1，见 [`find_match`] 的说明）。
fn fold(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/// 按行切分：1 起行号、去掉 CRLF 的 `\r`、**空白行不进索引**（但行号仍是绝对行号）。
fn indexable_lines(text: &str) -> impl Iterator<Item = (u32, &str)> {
    text.split('\n').enumerate().filter_map(|(index, raw)| {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        let trimmed = line.trim();
        (!trimmed.is_empty()).then_some(((index + 1) as u32, trimmed))
    })
}

fn normalize_rel(rel_path: &str) -> String {
    rel_path.replace('\\', "/")
}

/// 子树匹配用的 LIKE 模式（`%`/`_`/`\` 都转义：路径里带下划线是常事）。
fn subtree_pattern(rel: &str) -> String {
    let mut out = String::with_capacity(rel.len() + 2);
    for c in rel.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push_str("/%");
    out
}

fn label_of(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn db_error(label: &str, error: rusqlite::Error) -> Error {
    Error::io(label, std::io::Error::other(format!("SQLite：{error}")))
}

// ---------------------------------------------------------------------------
// 打开失败：分类 + 自愈
// ---------------------------------------------------------------------------

/// 打开失败的原始原因。
///
/// 为什么不让 [`SearchIndex::try_open`] 直接返回 `mn_core::Error`：**自愈判定要按 SQLite
/// 错误码分类**，而转成 `mn_core::Error` 之后只剩一句字符串，"库坏了"与"库正被别的连接锁着"
/// 就分不出来了 —— 那正是曾经把健康缓存误删的原因。
enum OpenFailure {
    /// 建目录 / 打开文件本身的失败（Vault 只读、磁盘满、没有权限……）：环境问题，绝不删库。
    Io(Error),
    /// SQLite 报的错（保留错误码，用于判断是不是真损坏）。
    Db(rusqlite::Error),
}

impl OpenFailure {
    /// 库文件**本身**坏了吗（只有这种才允许删掉重建）。
    fn corrupt(&self, path: &Path) -> bool {
        match self {
            Self::Io(_) => false,
            Self::Db(error) => is_corruption(error, path),
        }
    }

    fn into_error(self, label: &str) -> Error {
        match self {
            Self::Io(error) => error,
            Self::Db(error) => db_error(label, error),
        }
    }
}

impl std::fmt::Display for OpenFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "{error}"),
            Self::Db(error) => write!(f, "SQLite：{error}"),
        }
    }
}

/// 这个错误表示"库文件本身坏了"吗？
///
/// 按 SQLite 错误码分类，**只有真损坏才值得删库**：
///
/// * `SQLITE_CORRUPT`（磁盘映像损坏）/ `SQLITE_NOTADB`（文件不是数据库）→ 真损坏；
/// * `SQLITE_BUSY`/`SQLITE_LOCKED`（另一个构建正在写）、`SQLITE_FULL`（磁盘满）、
///   `SQLITE_READONLY`/`SQLITE_CANTOPEN`（Vault 只读、权限）→ 环境问题，原样返回给调用方降级。
///
/// `SQLITE_IOERR` 分不出"文件坏了"还是"这次读取没成"，所以再加一道文件头检查：
/// 截断/被覆盖的库常常只报 `SHORT_READ`，而一个健康的 SQLite 库永远以 `SQLite format 3\0` 开头。
fn is_corruption(error: &rusqlite::Error, path: &Path) -> bool {
    match error.sqlite_error_code() {
        Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase) => true,
        Some(ErrorCode::SystemIoFailure) => !has_sqlite_header(path),
        _ => false,
    }
}

/// 文件头是 SQLite 的魔数吗（文件不存在、或者长度不足 16 字节的空文件都当作"没坏"：
/// SQLite 把 0 字节文件当成一个全新的空库）。
fn has_sqlite_header(path: &Path) -> bool {
    const MAGIC: &[u8; 16] = b"SQLite format 3\0";
    let Ok(mut file) = std::fs::File::open(path) else {
        return true;
    };
    let mut head = [0u8; 16];
    match file.read_exact(&mut head) {
        Ok(()) => &head == MAGIC,
        Err(_) => std::fs::metadata(path)
            .map(|meta| meta.len() == 0)
            .unwrap_or(true),
    }
}

/// 自愈日志里"删了哪些文件"的可读描述。
fn describe_deleted(deleted: &[PathBuf]) -> String {
    if deleted.is_empty() {
        return "（没有可删的文件）".to_string();
    }
    deleted
        .iter()
        .map(|target| {
            target
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| target.display().to_string())
        })
        .collect::<Vec<_>>()
        .join("、")
}

/// 删掉缓存库及其 WAL 附属文件，返回**真正删掉**的那些（失败不算错：退化成"就地重建"）。
fn remove_db_files(path: &Path) -> Vec<PathBuf> {
    let mut deleted = Vec::new();
    for target in [
        path.to_path_buf(),
        PathBuf::from(format!("{}-wal", path.display())),
        PathBuf::from(format!("{}-shm", path.display())),
    ] {
        match std::fs::remove_file(&target) {
            Ok(()) => {
                log::debug!("已删除全文搜索缓存：{}", target.display());
                deleted.push(target);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => log::debug!(
                "删除全文搜索缓存失败（将就地重建）：{}：{error}",
                target.display()
            ),
        }
    }
    deleted
}

// ---------------------------------------------------------------------------
// 文件元数据 → 判定键
// ---------------------------------------------------------------------------

/// mtime → 库里存的整数（不可得就是 [`UNKNOWN_MTIME`]）。
fn mtime_stamp(mtime_ms: Option<u64>) -> i64 {
    mtime_ms
        .map(|ms| i64::try_from(ms).unwrap_or(i64::MAX))
        .unwrap_or(UNKNOWN_MTIME)
}

/// 字节数 → 库里存的整数。
fn size_stamp(size_bytes: u64) -> i64 {
    i64::try_from(size_bytes).unwrap_or(i64::MAX)
}

/// 一篇笔记的判定键 `(mtime_ms, size)`：与 ADR-0004 的 mtime 版本令牌同一口径。
fn stamp_of(entry: &EntryMeta) -> (i64, i64) {
    (mtime_stamp(entry.mtime_ms), size_stamp(entry.size_bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{build_indexes, BuildOptions};
    use mn_core::ErrorCode;

    /// 建一个内存索引并灌入 `(路径, 正文)`。
    fn index_of(notes: &[(&str, &str)]) -> SearchIndex {
        let index = SearchIndex::open_in_memory().unwrap();
        index.begin_rebuild().unwrap();
        for (rel, text) in notes {
            index.add_note(rel, text).unwrap();
        }
        index.finish_rebuild().unwrap();
        index
    }

    /// 命中的 (路径, 行号) 列表。
    fn hits(index: &SearchIndex, query: &str) -> Vec<(String, u32)> {
        index
            .search(query, 50)
            .unwrap()
            .hits
            .into_iter()
            .map(|hit| (hit.rel_path, hit.line))
            .collect()
    }

    // -- 段合并（optimize）-------------------------------------------------------

    /// 增量写入会让 FTS5 攒出多个段；`optimize` 把它们并成 1 个，且**一行都不能丢**。
    ///
    /// 这条测试同时钉住两件事：
    /// 1. "段会攒"是事实（不是我们想象出来的问题）—— 断言这一点，否则下面的修复就成了无的放矢；
    /// 2. 合并只影响布局，不影响搜索结果（同样的查询在合并前后返回同样的命中）。
    #[test]
    fn optimize_collapses_segments_without_losing_rows() {
        let index = index_of(&[("a.md", "甲\n乙\n丙")]);
        assert_eq!(
            index.segment_count().unwrap(),
            1,
            "全量重建自带一次 optimize"
        );

        // 反复重写同一批笔记：每次 upsert 都会往 FTS5 里追加新段
        for round in 0..40 {
            for note in 0..5 {
                index
                    .upsert_note(
                        &format!("n{note}.md"),
                        &format!("第 {round} 轮 关键词 内容"),
                    )
                    .unwrap();
            }
        }
        let fragmented = index.segment_count().unwrap();
        assert!(
            fragmented > 1,
            "增量写入应当攒出多个段（实测 {fragmented} 个），否则本测试没有覆盖到真实问题"
        );

        let before_hits = hits(&index, "关键词");
        let before_lines = index.counts().unwrap().lines;
        index.optimize().unwrap();

        assert_eq!(index.segment_count().unwrap(), 1);
        assert_eq!(
            index.counts().unwrap().lines,
            before_lines,
            "合并不该动行数"
        );
        assert_eq!(hits(&index, "关键词"), before_hits, "合并不该改变命中");
    }

    /// 段数**没到阈值**时一次都不合并（那是白花的全库重写）；到了阈值才合并。
    #[test]
    fn incremental_finish_only_merges_after_segments_pile_up() {
        let index = index_of(&[("a.md", "甲")]);
        index.optimize_if_fragmented();
        assert_eq!(index.segment_count().unwrap(), 1, "1 个段时不该做任何事");

        // 一直写到段数越过阈值（上限只是防呆：真到了上限说明 automerge 行为变了，值得有人看）
        let mut writes = 0;
        while index.segment_count().unwrap() < OPTIMIZE_SEGMENT_THRESHOLD {
            index
                .upsert_note(&format!("n{writes}.md"), "内容 关键词")
                .unwrap();
            writes += 1;
            assert!(
                writes < 2_000,
                "写了 {writes} 次仍然只有 {} 个段：FTS5 的合并行为可能变了，阈值需要重新标定",
                index.segment_count().unwrap()
            );
        }

        index.optimize_if_fragmented();
        assert_eq!(
            index.segment_count().unwrap(),
            1,
            "越过阈值后应当合并成 1 个段（{writes} 次写入才越线，这条数字本身也有参考价值）"
        );
    }

    // -- 增量复用的测试夹具 -----------------------------------------------------

    /// 写一篇笔记到磁盘。
    fn write_note(root: &Path, rel: &str, text: &str) {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&path, text).unwrap();
    }

    /// 按磁盘上的**真实**元数据造一个条目：增量判定测的就是 mtime/size，假值测不出东西。
    fn note_entry(root: &Path, rel: &str) -> EntryMeta {
        let path = root.join(rel);
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

    fn entries_of(root: &Path, rels: &[&str]) -> Vec<EntryMeta> {
        rels.iter().map(|rel| note_entry(root, rel)).collect()
    }

    /// 按磁盘**当前**状态对账一次（每次都重新取元数据：增量判定看的就是磁盘真值）。
    fn plan_of(index: &SearchIndex, root: &Path, rels: &[&str]) -> IncrementalPlan {
        let entries = entries_of(root, rels);
        let refs: Vec<&EntryMeta> = entries.iter().collect();
        index.plan_incremental(&refs).unwrap()
    }

    /// 命中的 (路径, 行号) 列表，**按路径与行号排好序**（这里不关心 bm25 的次序，
    /// 排序规则本身另有测试）。
    fn sorted_hits(index: &SearchIndex, query: &str) -> Vec<(String, u32)> {
        let mut hits = hits(index, query);
        hits.sort();
        hits
    }

    /// 宿主姿态的一轮构建：`SearchIndex::open` + `build_indexes`（与 `indexer::spawn_build` 同一路径）。
    fn run_build(
        root: &Path,
        index: &SearchIndex,
        entries: &[EntryMeta],
    ) -> crate::SearchBuildOutcome {
        let (_, outcome) = build_indexes(
            root,
            entries,
            &BuildOptions::default(),
            None,
            Some(index),
            |_, _| {},
        );
        outcome.search.expect("这轮建了搜索索引")
    }

    /// 查询结果的指纹：逐条 (路径, 行号, 片段) —— 用于"增量 vs 全量"逐条比对。
    fn fingerprint(index: &SearchIndex, query: &str) -> Vec<(String, u32, String)> {
        index
            .search(query, 100)
            .unwrap()
            .hits
            .into_iter()
            .map(|hit| (hit.rel_path, hit.line, hit.snippet))
            .collect()
    }

    /// 库里的元数据行（按路径排序）。
    fn meta_rows(path: &Path) -> Vec<(String, i64, i64)> {
        let conn = Connection::open(path).unwrap();
        let mut statement = conn
            .prepare("SELECT path, mtime_ms, size FROM notes_meta ORDER BY path")
            .unwrap();
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .unwrap();
        rows.map(|row| row.unwrap()).collect()
    }

    /// SQLite 的 `data_version`：只有**别的连接**提交了写事务它才变 ——
    /// 用它证明"全库命中时索引表一个字节都没动"。
    fn data_version(conn: &Connection) -> i64 {
        conn.query_row("PRAGMA data_version", [], |row| row.get(0))
            .unwrap()
    }

    /// 某篇笔记的行号（`lines.id`）：重写一篇会换掉它的 id，所以它也是"动没动过"的证据。
    fn row_ids(path: &Path, rel: &str) -> Vec<i64> {
        let conn = Connection::open(path).unwrap();
        let mut statement = conn
            .prepare("SELECT id FROM lines WHERE rel_path = ?1 ORDER BY id")
            .unwrap();
        let rows = statement
            .query_map([rel], |row| row.get::<_, i64>(0))
            .unwrap();
        rows.map(|row| row.unwrap()).collect()
    }

    #[test]
    fn finds_english_text_case_insensitively() {
        let index = index_of(&[
            ("甲.md", "# 标题\n\nHello World\n"),
            ("乙.md", "正文没有那个词\n"),
        ]);

        assert_eq!(
            hits(&index, "hello"),
            vec![("甲.md".to_string(), 3)],
            "大小写不敏感，行号是文件里的绝对行号"
        );
        assert_eq!(hits(&index, "HELLO"), vec![("甲.md".to_string(), 3)]);
        assert!(hits(&index, "不存在").is_empty());
        // 标题行同样可搜
        assert_eq!(hits(&index, "标题"), vec![("甲.md".to_string(), 1)]);
    }

    #[test]
    fn finds_chinese_phrases_without_a_segmenter() {
        let index = index_of(&[("笔记.md", "今天天气很好，适合写代码。\n")]);

        assert_eq!(hits(&index, "天气"), vec![("笔记.md".to_string(), 1)]);
        assert_eq!(hits(&index, "今天"), vec![("笔记.md".to_string(), 1)]);
        assert_eq!(hits(&index, "代码"), vec![("笔记.md".to_string(), 1)]);
        assert_eq!(hits(&index, "很好"), vec![("笔记.md".to_string(), 1)]);
        // 短语语义：两个字必须相邻，而 `今好` 在原文里并不相邻
        assert!(
            hits(&index, "今好").is_empty(),
            "逐字切开后是短语匹配，不相邻的字不该命中"
        );
    }

    #[test]
    fn matches_prefixes_and_reports_every_line() {
        let index = index_of(&[("甲.md", "hello\n\nhello again\n第三行 hello\n")]);

        assert_eq!(
            hits(&index, "hel"),
            vec![
                ("甲.md".to_string(), 1),
                ("甲.md".to_string(), 3),
                ("甲.md".to_string(), 4)
            ],
            "前缀能命中；空白行不进索引但行号仍然是绝对行号"
        );
    }

    #[test]
    fn limit_caps_hits_but_total_counts_all() {
        let body: String = (0..20).map(|i| format!("hello {i}\n")).collect();
        let index = index_of(&[("甲.md", &body)]);

        let outcome = index.search("hello", 5).unwrap();
        assert_eq!(outcome.hits.len(), 5);
        assert_eq!(outcome.total, 20, "total 是命中总数，不是 hits.len()");
    }

    #[test]
    fn orders_by_score_then_path_then_line() {
        // 三篇同样大小的文件、都只有一处命中 → bm25 完全相同，顺序只能由路径决定
        let index = index_of(&[
            ("c.md", "hello\n"),
            ("a.md", "hello\n"),
            ("b.md", "hello\n"),
        ]);
        assert_eq!(
            hits(&index, "hello"),
            vec![
                ("a.md".to_string(), 1),
                ("b.md".to_string(), 1),
                ("c.md".to_string(), 1)
            ],
            "同分时按 relPath 升序"
        );

        // 同一篇里同分 → 按行号升序
        let same_file = index_of(&[("甲.md", "hello\nhello\nhello\n")]);
        assert_eq!(
            hits(&same_file, "hello"),
            vec![
                ("甲.md".to_string(), 1),
                ("甲.md".to_string(), 2),
                ("甲.md".to_string(), 3)
            ]
        );

        // 更相关的（同一行里文档更短 → 长度归一化后得分更高）排在前面。
        // 路径故意取 "a-long.md" / "z-short.md"：如果是同分，路径升序会把长的那个排前面，
        // 所以"短的排前面"只可能来自 score 降序本身。
        let ranked = index_of(&[
            (
                "a-long.md",
                "hello 填充 填充 填充 填充 填充 填充 填充 填充\n",
            ),
            ("z-short.md", "hello\n"),
        ]);
        let hits = ranked.search("hello", 50).unwrap().hits;
        assert_eq!(hits[0].rel_path, "z-short.md", "短行里命中更相关：{hits:?}");
        assert!(hits[0].score > hits[1].score, "score 越大越相关：{hits:?}");
    }

    #[test]
    fn upsert_replaces_rows_without_leaving_stale_tokens() {
        let index = index_of(&[
            ("甲.md", "旧内容里有 关键词\n"),
            ("乙.md", "别人也有 关键词\n"),
        ]);

        assert_eq!(index.search("关键词", 50).unwrap().total, 2);
        index.upsert_note("甲.md", "换成了 新词\n").unwrap();

        assert_eq!(
            index.search("关键词", 50).unwrap().total,
            1,
            "旧 token 必须从 FTS 索引里一起消失（external content 的坑）"
        );
        assert_eq!(hits(&index, "新词"), vec![("甲.md".to_string(), 1)]);
        assert_eq!(index.counts().unwrap().lines, 2);
    }

    #[test]
    fn removing_a_note_removes_its_rows_and_subtree_only() {
        let index = index_of(&[
            ("a_b/甲.md", "关键词\n"),
            ("axb/乙.md", "关键词\n"),
            ("a_b/子/丙.md", "关键词\n"),
        ]);

        index.remove_note("a_b").unwrap();
        assert_eq!(
            hits(&index, "关键词"),
            vec![("axb/乙.md".to_string(), 1)],
            "LIKE 前缀必须转义 `_`：删 a_b 不能连 axb 一起删"
        );
        assert_eq!(index.counts().unwrap().notes, 1);
    }

    #[test]
    fn rename_moves_rows_to_the_new_path() {
        let index = index_of(&[
            ("笔记/甲.md", "第一行\n命中这一行\n"),
            ("笔记/乙.md", "命中这一行也行\n"),
        ]);

        let moved = index.rename_note("笔记/甲.md", "笔记/新名.md").unwrap();
        assert_eq!(moved, 2, "两行都搬走");
        assert_eq!(
            hits(&index, "命中"),
            vec![
                ("笔记/新名.md".to_string(), 2),
                ("笔记/乙.md".to_string(), 1)
            ]
        );
    }

    #[test]
    fn hostile_queries_never_error() {
        let index = index_of(&[(
            "甲.md",
            "alpha beta\nOR 是一个词\n引号 \" 与括号 ( ) 与星号 *\n",
        )]);

        for query in [
            "a\"b(c)",
            "-x",
            "OR",
            "AND",
            "NEAR",
            "*",
            "(",
            ")",
            "^",
            ":",
            "\"\"",
            "**",
            "a:b^c",
            "alpha OR beta",
            "   ",
            "\t",
            "\n",
            &"超".repeat(500),
            &"a ".repeat(200),
            "😀🎉",
            "中文 （括号） 混排",
        ] {
            let outcome = index.search(query, 20);
            assert!(outcome.is_ok(), "查询 {query:?} 不该报错：{outcome:?}");
        }

        // 引号包裹让 OR 变成普通词，而不是布尔运算符
        assert_eq!(hits(&index, "OR"), vec![("甲.md".to_string(), 2)]);
        assert_eq!(
            hits(&index, "alpha OR beta"),
            Vec::new(),
            "三个词是 AND 关系"
        );
    }

    #[test]
    fn empty_or_tokenless_queries_do_not_touch_the_database() {
        let index = index_of(&[("甲.md", "hello\n")]);
        for query in ["", "   ", "\t\n", "(((", "***", "\"", "---"] {
            let outcome = index.search(query, 10).unwrap();
            assert!(outcome.hits.is_empty(), "查询 {query:?}");
            assert_eq!(outcome.total, 0);
        }
        assert!(build_match_query("").is_none());
        assert!(build_match_query("(((").is_none());
    }

    #[test]
    fn build_match_query_quotes_every_term() {
        assert_eq!(build_match_query("alpha").unwrap(), "\"alpha\"*");
        assert_eq!(
            build_match_query("  alpha   beta  ").unwrap(),
            "\"alpha\"* \"beta\"*",
            "多个空白折叠成一个分隔"
        );
        // CJK 逐字切开后是短语（相邻匹配）
        assert_eq!(build_match_query("天气").unwrap(), "\"天 气\"*");
        assert_eq!(
            build_match_query("今天 hello").unwrap(),
            "\"今 天\"* \"hello\"*"
        );
        // 引号转义成两个引号；`(`/`)`/`-` 等留在引号内，都是普通字符
        assert_eq!(build_match_query("a\"b(c)").unwrap(), "\"a\"\"b(c)\"*");
        assert_eq!(build_match_query("-x").unwrap(), "\"-x\"*");
        assert_eq!(build_match_query("OR").unwrap(), "\"OR\"*");
        // 病态输入被截断而不是拼出一个巨大的查询
        let long = build_match_query(&"a".repeat(500)).unwrap();
        assert_eq!(long.len(), MAX_TERM_CHARS + 3, "词被截到上限：{long}");
        let many = build_match_query(&"词 ".repeat(200)).unwrap();
        assert_eq!(many.matches('*').count(), MAX_QUERY_TERMS);
    }

    #[test]
    fn space_cjk_splits_only_where_needed() {
        assert_eq!(space_cjk("今天天气"), "今 天 天 气");
        assert_eq!(space_cjk("hello"), "hello");
        assert_eq!(space_cjk("hello世界world"), "hello 世 界 world");
        assert_eq!(space_cjk("a 中"), "a 中");
        assert_eq!(space_cjk("中a"), "中 a");
        assert_eq!(space_cjk("カタカナ 한글"), "カ タ カ ナ 한 글");
        assert_eq!(space_cjk(""), "");
    }

    #[test]
    fn snippet_is_single_line_and_capped() {
        let terms = query_terms("关键词");

        // 短行原样返回（只去首尾空白）
        assert_eq!(build_snippet("   短行 关键词   ", &terms), "短行 关键词");

        // 长行：以命中处为中心裁剪，带省略号，且不超过上限
        let long = format!("{}关键词{}", "前".repeat(300), "后".repeat(300));
        let snippet = build_snippet(&long, &terms);
        assert!(snippet.contains("关键词"), "必须能看到命中的词：{snippet}");
        assert!(snippet.starts_with('…') && snippet.ends_with('…'));
        assert_eq!(snippet.chars().count(), SNIPPET_CHARS, "含省略号不超上限");
        assert!(!snippet.contains('\n'));

        // 命中在开头 → 前面不加省略号
        let at_start = format!("关键词{}", "后".repeat(300));
        let snippet = build_snippet(&at_start, &terms);
        assert!(snippet.starts_with("关键词"), "{snippet}");

        // 只打了一半的前缀也能定位
        let prefix = build_snippet(
            &format!("{}hel{}", "前".repeat(200), "后".repeat(200)),
            &query_terms("hel"),
        );
        assert!(prefix.contains("hel"), "{prefix}");
        assert!(prefix.starts_with('…'));

        // 找不到命中位置时退化成从行首裁剪（不 panic、不越界）
        let no_match = build_snippet(&"字".repeat(300), &terms);
        assert_eq!(no_match.chars().count(), SNIPPET_CHARS);
    }

    #[test]
    fn persists_across_reopen_and_heals_a_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("嵌套/目录/search.db");

        {
            let index = SearchIndex::open(&path).unwrap();
            index.begin_rebuild().unwrap();
            index.add_note("甲.md", "会被搜到的内容\n").unwrap();
            index.finish_rebuild().unwrap();
        }
        assert!(path.exists(), "父目录不存在时要自己建出来");

        // 重新打开：数据还在（缓存是要跨会话用的）
        {
            let index = SearchIndex::open(&path).unwrap();
            assert_eq!(hits(&index, "搜到"), vec![("甲.md".to_string(), 1)]);
        }

        // 外部把库写坏 → 自愈（删掉重建），而不是让整个搜索功能起不来
        std::fs::write(&path, b"this is not a sqlite database at all").unwrap();
        let healed = SearchIndex::open(&path).unwrap();
        assert_eq!(healed.counts().unwrap().lines, 0, "坏库被删掉重建");
        assert!(healed.search("搜到", 10).unwrap().hits.is_empty());
    }

    #[test]
    fn open_for_rebuild_starts_from_a_fresh_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("search.db");

        {
            let index = SearchIndex::open(&path).unwrap();
            index.begin_rebuild().unwrap();
            index.add_note("旧.md", "旧内容\n").unwrap();
            index.finish_rebuild().unwrap();
        }

        let fresh = SearchIndex::open_for_rebuild(&path).unwrap();
        assert_eq!(fresh.counts().unwrap().lines, 0, "整库重写不保留上一轮的行");
        fresh.begin_rebuild().unwrap();
        fresh.add_note("新.md", "新内容\n").unwrap();
        fresh.finish_rebuild().unwrap();
        assert_eq!(hits(&fresh, "旧内容"), Vec::new());
        assert_eq!(hits(&fresh, "新内容"), vec![("新.md".to_string(), 1)]);
    }

    #[test]
    fn impossible_path_degrades_with_io_error() {
        // 父路径是一个文件 → 建库必然失败；上层据此降级（warn + IO 错误），不能 panic
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("blocker");
        std::fs::write(&blocker, "not a dir").unwrap();

        let error = SearchIndex::open(&blocker.join("search.db")).unwrap_err();
        assert_eq!(error.code(), ErrorCode::Io);
    }

    // -----------------------------------------------------------------------
    // 坏库自愈：只有真损坏才删库（ADR-0008 后续修订）
    // -----------------------------------------------------------------------

    #[test]
    fn only_real_corruption_justifies_deleting_the_cache() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("search.db");
        let failure = |code, extended| {
            rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error {
                    code,
                    extended_code: extended,
                },
                None,
            )
        };

        // 真损坏：磁盘映像坏 / 文件根本不是数据库
        assert!(is_corruption(
            &failure(rusqlite::ErrorCode::DatabaseCorrupt, 11),
            &path
        ));
        assert!(is_corruption(
            &failure(rusqlite::ErrorCode::NotADatabase, 26),
            &path
        ));

        // 锁冲突（另一个构建正在写）、磁盘满、只读、打不开：都不是损坏 ——
        // 删掉一个健康的缓存只会让用户白等一次十几秒的重建
        for (code, extended) in [
            (rusqlite::ErrorCode::DatabaseBusy, 5),
            (rusqlite::ErrorCode::DatabaseLocked, 6),
            (rusqlite::ErrorCode::DiskFull, 13),
            (rusqlite::ErrorCode::ReadOnly, 8),
            (rusqlite::ErrorCode::CannotOpen, 14),
        ] {
            assert!(
                !is_corruption(&failure(code, extended), &path),
                "{code:?} 不是损坏，不该删库"
            );
        }

        // IO 错误要加看文件头：截断/被覆盖的库常常只报 SHORT_READ，而健康的库一定有魔数
        std::fs::write(&path, vec![0u8; 4096]).unwrap();
        assert!(is_corruption(
            &failure(rusqlite::ErrorCode::SystemIoFailure, 266),
            &path
        ));
        let mut healthy = b"SQLite format 3\0".to_vec();
        healthy.extend_from_slice(&[0u8; 4000]);
        std::fs::write(&path, healthy).unwrap();
        assert!(
            !is_corruption(&failure(rusqlite::ErrorCode::SystemIoFailure, 266), &path),
            "文件头正常时，一次 IO 失败不等于库坏了"
        );
    }

    #[test]
    fn a_locked_cache_is_reported_as_an_error_instead_of_being_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("search.db");

        {
            let index = SearchIndex::open(&path).unwrap();
            index.begin_rebuild().unwrap();
            index.add_note("甲.md", "会被搜到的内容\n").unwrap();
            index.finish_rebuild().unwrap();
        }

        // 另一个连接持有写锁：这正是"两个构建并发"时用户日志里 "database is locked" 的来源。
        // 先切回 DELETE 日志模式，让打开的 `PRAGMA journal_mode = WAL` 必须去抢那把锁。
        let blocker = Connection::open(&path).unwrap();
        blocker
            .execute_batch("PRAGMA journal_mode = DELETE")
            .unwrap();
        blocker.execute_batch("BEGIN EXCLUSIVE").unwrap();

        let error = SearchIndex::open(&path).unwrap_err();
        assert!(
            path.exists(),
            "锁冲突不是损坏：这个**健康**的缓存必须原样留着（曾经就是它被误删）"
        );
        assert!(
            error.to_string().contains("locked"),
            "错误要原样上报给调用方降级：{error}"
        );

        drop(blocker);
        // 锁一放开，同一个库立刻可用，内容一行不少（说明它从头到尾没被动过）
        let index = SearchIndex::open(&path).unwrap();
        assert_eq!(hits(&index, "搜到"), vec![("甲.md".to_string(), 1)]);
        assert_eq!(index.counts().unwrap().lines, 1);
    }

    // -----------------------------------------------------------------------
    // 增量复用
    // -----------------------------------------------------------------------

    #[test]
    fn plan_reuses_unchanged_notes_and_points_at_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_note(root, "甲.md", "关键词 甲原文内容\n");
        write_note(root, "乙.md", "关键词 乙\n");

        let index = SearchIndex::open_in_memory().unwrap();
        // 空库里什么都没有 → 全部要写
        let first = plan_of(&index, root, &["甲.md", "乙.md"]);
        assert_eq!(first.changed.len(), 2);
        assert_eq!(first.reused, 0);
        assert!(first.removed.is_empty());
        assert!(first.needs_full_rebuild());
        assert!(!first.is_noop());

        // 灌进去之后：全命中
        let entries = entries_of(root, &["甲.md", "乙.md"]);
        index.begin_rebuild().unwrap();
        for entry in &entries {
            index
                .add_note_with_meta(
                    &entry.rel_path,
                    "关键词\n",
                    entry.mtime_ms,
                    entry.size_bytes,
                )
                .unwrap();
        }
        index.finish_rebuild().unwrap();

        let same = plan_of(&index, root, &["甲.md", "乙.md"]);
        assert!(same.is_noop(), "{same:?}");
        assert_eq!(same.reused, 2);
        assert!(!same.needs_full_rebuild());

        // 改动一篇：内容变长 → size 一定变，不依赖 mtime 的毫秒精度
        write_note(root, "甲.md", "关键词 甲改过\n");
        let changed = plan_of(&index, root, &["甲.md", "乙.md"]);
        assert_eq!(changed.changed, vec!["甲.md".to_string()]);
        assert_eq!(changed.reused, 1);
        assert!(changed.removed.is_empty());

        // 真的把这一轮增量写下去（begin + 逐篇 + finish），库里这才与新内容对齐
        let entries = entries_of(root, &["甲.md"]);
        index.begin_incremental(&changed).unwrap();
        index
            .add_note_with_meta(
                "甲.md",
                "关键词 甲改过\n",
                entries[0].mtime_ms,
                entries[0].size_bytes,
            )
            .unwrap();
        index.finish_incremental().unwrap();
        assert_eq!(
            index.search("改过", 10).unwrap().total,
            1,
            "增量写入的内容要立刻能搜到"
        );
        assert_eq!(
            index.search("原文", 10).unwrap().total,
            0,
            "旧内容不能残留（先删后写）"
        );

        // 删掉一篇 → 要清掉；新增一篇 → 要写
        std::fs::remove_file(root.join("乙.md")).unwrap();
        write_note(root, "丙.md", "关键词 丙\n");
        let shrunk = plan_of(&index, root, &["甲.md", "丙.md"]);
        assert_eq!(shrunk.changed, vec!["丙.md".to_string()]);
        assert_eq!(shrunk.removed, vec!["乙.md".to_string()]);
        assert_eq!(shrunk.reused, 1, "甲刚增量写过，元数据已经是最新的");

        // mtime 不可得 = 「不知道变没变」→ 必须重读，绝不能当成没变
        let mut unknown = entries_of(root, &["甲.md", "丙.md"]);
        unknown[0].mtime_ms = None;
        let refs: Vec<&EntryMeta> = unknown.iter().collect();
        let unsure = index.plan_incremental(&refs).unwrap();
        assert!(
            unsure.changed.contains(&"甲.md".to_string()),
            "mtime 不可得必须重读：{unsure:?}"
        );
    }

    #[test]
    fn an_unchanged_vault_reuses_everything_without_touching_the_index() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_note(root, "甲.md", "第一行 hello\n第二行 关键词\n");
        write_note(root, "子/乙.md", "关键词 也在\n");
        let entries = entries_of(root, &["甲.md", "子/乙.md"]);
        let db = root.join(".mimenote/cache/search.db");

        // 第一轮：库里什么都没有 → 整库重建，顺手把文件元数据记下来
        let first = {
            let index = SearchIndex::open(&db).unwrap();
            let outcome = run_build(root, &index, &entries);
            assert!(!outcome.aborted, "{outcome:?}");
            assert_eq!(outcome.reused_notes, 0);
            assert_eq!(outcome.lines, 3);
            index.counts().unwrap()
        };
        assert_eq!(meta_rows(&db).len(), 2, "每篇笔记都要留下一条元数据");

        // 观察者连接：用来验证第二轮"一个字节都没写"（data_version 只在**别的连接**提交时才变）
        let observer = Connection::open(&db).unwrap();
        let version_before = data_version(&observer);

        // 第二轮：文件一个都没变 → 一篇都不重写，连事务都不开
        let index = SearchIndex::open(&db).unwrap();
        let outcome = run_build(root, &index, &entries);
        assert!(
            !outcome.aborted,
            "全库命中必须报成功，否则宿主不会安装连接、搜索会一直停在「构建中」：{outcome:?}"
        );
        assert_eq!(outcome.lines, 0, "一行都不该写");
        assert_eq!(outcome.reused_notes, 2);
        assert_eq!(index.counts().unwrap(), first);
        assert_eq!(
            data_version(&observer),
            version_before,
            "索引表一个字节都没动"
        );
        assert_eq!(
            sorted_hits(&index, "关键词"),
            vec![("子/乙.md".to_string(), 1), ("甲.md".to_string(), 2)]
        );

        // 对照：真改了东西时，上面那个探针必须能看出变化（否则断言等于空断言）
        write_note(root, "甲.md", "第一行 hello\n第二行 关键词 改过了\n");
        let entries = entries_of(root, &["甲.md", "子/乙.md"]);
        let outcome = run_build(root, &index, &entries);
        assert!(!outcome.aborted, "{outcome:?}");
        assert!(outcome.lines > 0, "{outcome:?}");
        assert!(
            data_version(&observer) != version_before,
            "对照：写入确实能被观察者看到"
        );
    }

    #[test]
    fn a_changed_note_does_not_rewrite_the_others() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for (rel, body) in [
            ("甲.md", "甲的内容 关键词\n"),
            ("乙.md", "乙的内容 关键词\n"),
            ("丙.md", "丙的内容 关键词\n"),
        ] {
            write_note(root, rel, body);
        }
        let db = root.join(".mimenote/cache/search.db");
        let index = SearchIndex::open(&db).unwrap();
        let entries = entries_of(root, &["甲.md", "乙.md", "丙.md"]);
        assert!(!run_build(root, &index, &entries).aborted);

        // 行 id 是"这篇有没有被重写"的证据：重写 = 先删后写 = 换新 id
        let before: Vec<Vec<i64>> = ["甲.md", "乙.md", "丙.md"]
            .iter()
            .map(|rel| row_ids(&db, rel))
            .collect();
        assert!(before.iter().all(|ids| !ids.is_empty()));

        write_note(root, "乙.md", "乙的内容 换过了\n");
        let entries = entries_of(root, &["甲.md", "乙.md", "丙.md"]);
        let outcome = run_build(root, &index, &entries);
        assert!(!outcome.aborted, "{outcome:?}");
        assert_eq!(outcome.reused_notes, 2, "只改了乙：{outcome:?}");

        assert_ne!(row_ids(&db, "乙.md"), before[1], "改过的那篇要重写");
        assert_eq!(
            row_ids(&db, "甲.md"),
            before[0],
            "没动的笔记不该被重写（连行都没有重建过）"
        );
        assert_eq!(row_ids(&db, "丙.md"), before[2]);
        assert_eq!(index.search("换过", 10).unwrap().total, 1);
        assert_eq!(index.search("丙的内容", 10).unwrap().total, 1);
    }

    #[test]
    fn deleting_a_note_clears_its_rows_and_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_note(root, "留下.md", "关键词 留下\n");
        write_note(root, "删掉.md", "关键词 删掉\n");
        let db = root.join(".mimenote/cache/search.db");
        let index = SearchIndex::open(&db).unwrap();

        let entries = entries_of(root, &["留下.md", "删掉.md"]);
        assert!(!run_build(root, &index, &entries).aborted);
        assert_eq!(index.search("关键词", 10).unwrap().total, 2);

        // 文件在应用外面被删掉（用户在资源管理器里删的）→ 下一轮必须把它从索引里清掉
        std::fs::remove_file(root.join("删掉.md")).unwrap();
        let entries = entries_of(root, &["留下.md"]);
        let outcome = run_build(root, &index, &entries);
        assert!(!outcome.aborted, "{outcome:?}");
        assert_eq!(outcome.reused_notes, 1);

        assert_eq!(
            hits(&index, "关键词"),
            vec![("留下.md".to_string(), 1)],
            "被删的笔记不能留在搜索结果里"
        );
        assert_eq!(index.counts().unwrap().notes, 1);
        assert_eq!(
            meta_rows(&db).len(),
            1,
            "元数据也要一起清掉，否则它会被反复当成「待删除」"
        );
    }

    #[test]
    fn incremental_after_edits_matches_a_full_rebuild() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let original = [
            ("甲.md", "今天天气很好\n关键词 在甲里\n"),
            ("乙.md", "关键词 在乙里\n第二行\n第三行\n"),
            ("子/丙.md", "丙的内容\n"),
            ("删掉.md", "关键词 会被删掉\n"),
        ];
        for (rel, body) in original {
            write_note(root, rel, body);
        }
        let db = root.join(".mimenote/cache/search.db");
        let index = SearchIndex::open(&db).unwrap();
        let entries = entries_of(root, &["甲.md", "乙.md", "子/丙.md", "删掉.md"]);
        let first = run_build(root, &index, &entries);
        assert!(!first.aborted, "{first:?}");
        assert_eq!(first.reused_notes, 0, "第一轮是整库重建");

        // 一串真实改动：改一篇（内容变长）、删一篇、新增一篇、给一篇加行
        write_note(
            root,
            "甲.md",
            "今天天气很好\n关键词 改成在甲里了\n新增的一行 关键词\n",
        );
        std::fs::remove_file(root.join("删掉.md")).unwrap();
        write_note(root, "新增.md", "关键词 在新增里\n");
        write_note(root, "子/丙.md", "丙的内容\n又加了一行 天气\n");

        let entries = entries_of(root, &["甲.md", "乙.md", "子/丙.md", "新增.md"]);
        let incremental = run_build(root, &index, &entries);
        assert!(!incremental.aborted, "{incremental:?}");
        assert_eq!(
            incremental.reused_notes, 1,
            "只有乙没动，其余三篇要重写：{incremental:?}"
        );

        // 同一份最终文件，另建一个库做**整库重建**：两者结果必须逐条相同
        let full = SearchIndex::open_for_rebuild(&dir.path().join("full/search.db")).unwrap();
        let full_outcome = run_build(root, &full, &entries);
        assert!(!full_outcome.aborted, "{full_outcome:?}");
        assert_eq!(full_outcome.reused_notes, 0);

        assert_eq!(
            index.counts().unwrap(),
            full.counts().unwrap(),
            "笔记数与行数必须一致"
        );
        for query in [
            "关键词",
            "今天",
            "天气",
            "丙",
            "新增",
            "第",
            "search",
            "不存在的词",
        ] {
            let left = index.search(query, 100).unwrap();
            let right = full.search(query, 100).unwrap();
            assert_eq!(left.total, right.total, "查询 {query:?} 的命中总数");
            assert_eq!(
                fingerprint(&index, query),
                fingerprint(&full, query),
                "查询 {query:?} 的逐条结果（路径/行号/片段）"
            );
            for (a, b) in left.hits.iter().zip(right.hits.iter()) {
                // 分数允许极小误差：bm25 的浮点求和顺序可能随 FTS 段结构微变
                assert!(
                    (a.score - b.score).abs() < 1e-9,
                    "查询 {query:?} 的 bm25：{a:?} vs {b:?}"
                );
            }
        }

        // 再跑一轮"什么都没变"：结果依然与全量一致（复用不会让索引慢慢漂移）
        let noop = run_build(root, &index, &entries);
        assert_eq!(noop.lines, 0);
        assert_eq!(noop.reused_notes, entries.len());
        for query in ["关键词", "今天", "天气", "新增"] {
            assert_eq!(
                fingerprint(&index, query),
                fingerprint(&full, query),
                "复用一轮之后，查询 {query:?}"
            );
        }
    }

    #[test]
    fn schema_version_bump_rebuilds_an_old_cache() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("search.db");

        {
            let index = SearchIndex::open(&path).unwrap();
            index.begin_rebuild().unwrap();
            index.add_note("甲.md", "老库里的内容\n").unwrap();
            index.finish_rebuild().unwrap();
        }

        // 模拟"上一个版本留下的库"：版本号不是当前值
        {
            let conn = Connection::open(&path).unwrap();
            conn.pragma_update(None, "user_version", SCHEMA_VERSION - 1)
                .unwrap();
        }

        let index = SearchIndex::open(&path).unwrap();
        assert_eq!(index.counts().unwrap().lines, 0, "版本不符 → 直接重建");
        assert!(meta_rows(&path).is_empty(), "老库的元数据不能留下来");
        assert!(index.search("老库", 10).unwrap().hits.is_empty());
    }

    /// 性能基准：1 万笔记下"打开 Vault 的搜索索引"要花多少 —— 整库重建 vs 复用 vs 改一篇。
    ///
    /// 运行：`cargo test -p mn-index --release -- --ignored --nocapture bench_reopen_10k_notes`
    ///
    /// 数据规模与 `lib.rs` 的 `bench_full_text_search_10k_notes` 一致（100 目录 × 100 篇 × 30 行），
    /// 这样两边的数字可以对照着看。
    #[test]
    #[ignore]
    fn bench_reopen_10k_notes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        let mut rels: Vec<String> = Vec::with_capacity(10_000);
        for d in 0..100 {
            let sub = root.join(format!("dir{d:03}"));
            std::fs::create_dir_all(&sub).unwrap();
            for f in 0..100 {
                let mut body = String::new();
                for i in 1..=29 {
                    body.push_str(&format!(
                        "第 {i} 行：这是用来测试全文搜索的中文正文，里面还有 search 这样的英文单词\n"
                    ));
                }
                if f % 10 == 0 {
                    body.push_str("这一行里有关键词，别的行没有\n");
                }
                if f % 200 == 0 {
                    body.push_str("这里有一个稀有的词：独角鲸\n");
                }
                body.push_str(&format!("末尾一行 [[note{f:03}]]\n"));
                let rel = format!("dir{d:03}/note{f:03}.md");
                std::fs::write(root.join(&rel), body).unwrap();
                rels.push(rel);
            }
        }
        let rel_refs: Vec<&str> = rels.iter().map(String::as_str).collect();
        let entries = entries_of(root, &rel_refs);
        let options = BuildOptions::default();
        let db = root.join(".mimenote/cache/search.db");

        let run = |index: &SearchIndex, entries: &[EntryMeta]| {
            let (_, outcome) = build_indexes(root, entries, &options, None, Some(index), |_, _| {});
            let search = outcome.search.expect("这轮建了搜索索引");
            assert!(!search.aborted, "{search:?}");
            (outcome.duration_ms, search)
        };

        // 链接 + 标签（内存索引，每次都全量重建）
        let links_started = std::time::Instant::now();
        let _ = crate::build_index(root, &entries, &options, None, |_, _| {});
        let links_ms = links_started.elapsed().as_millis();

        // 旧行为：每次打开 Vault 都先删库再整库重建
        let index = SearchIndex::open_for_rebuild(&db).unwrap();
        let (full_total, full_search) = run(&index, &entries);
        let counts = index.counts().unwrap();
        let db_bytes = std::fs::metadata(&db).map(|meta| meta.len()).unwrap_or(0);
        drop(index);

        // 新行为（1）：Vault 没变 → 一篇都不重写
        let index = SearchIndex::open(&db).unwrap();
        let (noop_total, noop_search) = run(&index, &entries);
        drop(index);

        // 新行为（2）：改一篇 → 只重写那一篇
        write_note(
            root,
            "dir000/note000.md",
            "改过的内容里也有关键词和独角鲸\n",
        );
        let entries = entries_of(root, &rel_refs);
        let index = SearchIndex::open(&db).unwrap();
        let (one_total, one_search) = run(&index, &entries);

        eprintln!(
            "1 万笔记 / {} 行（缓存库 {:.1} MB）：\n\
             \x20 链接+标签（内存索引，每轮都全量重建）：{} ms\n\
             \x20 旧行为 · 打开 Vault（删库 + 整库重建）：全轮 {} ms（其中搜索 {} ms，写 {} 行）\n\
             \x20 新行为 · 打开 Vault（Vault 没变）：全轮 {} ms（其中搜索 {} ms，写 {} 行，复用 {} 篇）\n\
             \x20 新行为 · 打开 Vault（改了 1 篇）：全轮 {} ms（其中搜索 {} ms，写 {} 行，复用 {} 篇）",
            counts.lines,
            db_bytes as f64 / 1_048_576.0,
            links_ms,
            full_total,
            full_search.duration_ms,
            full_search.lines,
            noop_total,
            noop_search.duration_ms,
            noop_search.lines,
            noop_search.reused_notes,
            one_total,
            one_search.duration_ms,
            one_search.lines,
            one_search.reused_notes,
        );

        assert_eq!(full_search.reused_notes, 0);
        assert_eq!(noop_search.lines, 0, "空转的那一轮一行都不该写");
        assert_eq!(noop_search.reused_notes, entries.len());
        assert_eq!(
            one_search.lines, 1,
            "只改了 1 篇 → 只写 1 行（那篇笔记现在只有 1 行）"
        );
        assert_eq!(one_search.reused_notes, entries.len() - 1);
    }
}
