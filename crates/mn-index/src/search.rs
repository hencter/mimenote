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

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use rusqlite::{params, Connection};

use mn_core::{Error, Result};

/// 缓存库的 schema 版本。改动表结构就 +1：打开时版本不符直接重建（缓存而已）。
const SCHEMA_VERSION: i64 = 1;

/// `snippet` 的长度上限（**字符**，含省略号）。
const SNIPPET_CHARS: usize = 120;

/// 查询串最多取几个词（挡住病态输入把 FTS5 拖死）。
const MAX_QUERY_TERMS: usize = 16;

/// 单个查询词最多保留多少字符。
const MAX_TERM_CHARS: usize = 64;

/// 建表语句（`IF NOT EXISTS`：打开已有库时不动它）。
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

/// 全文搜索索引。
///
/// 内部持有一个 SQLite 连接（非 `Sync`），因此只能放在 `Mutex` 后面共享 ——
/// 见 `src-tauri/src/state.rs` 的 `SearchSlot`。
pub struct SearchIndex {
    conn: Connection,
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
    /// **坏库自愈**：缓存库损坏（断电、外部改坏）时删掉重建 —— 这是 ADR-0002 的直接推论：
    /// 派生数据没有"必须保留"的部分。
    pub fn open(path: &Path) -> Result<Self> {
        match Self::try_open(path) {
            Ok(index) => Ok(index),
            Err(first) => {
                // 只有"库文件已经在那儿"时才值得怀疑它坏了；否则多半是环境问题
                // （只读 Vault、磁盘满、没有权限），重试一次也是一样的结果
                if !path.exists() {
                    return Err(first);
                }
                log::warn!(
                    "全文搜索缓存库不可用，删掉重建（{}）：{first}",
                    path.display()
                );
                remove_db_files(path);
                Self::try_open(path)
            }
        }
    }

    /// 内存库（单测与"临时索引"用；生产路径永远是文件）。
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().map_err(|error| db_error(":memory:", error))?;
        Self::from_connection(conn, ":memory:")
    }

    /// 全量重建专用：**先删掉旧库文件再建**，得到一个空库。
    ///
    /// 为什么不留用旧文件：整库重写时 `DELETE FROM lines` 要为几十万行写 WAL，
    /// 而"删文件 + 新建"是常数级开销；顺带还解决了"应用没开时外面删掉的文件在索引里残留"。
    /// 删不掉（例如另一个实例正开着这个库）则退回打开旧库，由 [`Self::begin_rebuild`] 就地清空。
    pub fn open_for_rebuild(path: &Path) -> Result<Self> {
        remove_db_files(path);
        Self::open(path)
    }

    fn try_open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            // Vault 只读 / 磁盘满：这里就会失败，调用方据此降级（日志 warn + IO 错误）
            std::fs::create_dir_all(parent).map_err(|error| Error::io(parent, error))?;
        }
        let conn = Connection::open(path).map_err(|error| db_error(&label_of(path), error))?;
        let label = label_of(path);
        conn.query_row("PRAGMA journal_mode = WAL", [], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| db_error(&label, error))?;
        conn.execute_batch(
            "PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 2000;
             PRAGMA cache_size = -32768;
             PRAGMA foreign_keys = OFF;",
        )
        .map_err(|error| db_error(&label, error))?;
        Self::from_connection(conn, &label)
    }

    fn from_connection(conn: Connection, label: &str) -> Result<Self> {
        conn.execute_batch(SCHEMA)
            .map_err(|error| db_error(label, error))?;
        // schema 版本不符（老版本留下的库）：直接重建，不做迁移
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|error| db_error(label, error))?;
        if version != SCHEMA_VERSION {
            conn.execute_batch(
                "DROP TABLE IF EXISTS lines_fts;
                 DROP TABLE IF EXISTS lines;",
            )
            .map_err(|error| db_error(label, error))?;
            conn.execute_batch(SCHEMA)
                .map_err(|error| db_error(label, error))?;
            conn.pragma_update(None, "user_version", SCHEMA_VERSION)
                .map_err(|error| db_error(label, error))?;
        }
        Ok(Self {
            conn,
            label: label.to_string(),
            rebuilding: AtomicBool::new(false),
        })
    }

    /// 索引规模。
    pub fn counts(&self) -> Result<SearchCounts> {
        let lines: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM lines", [], |row| row.get(0))
            .map_err(|error| self.db(error))?;
        let notes: i64 = self
            .conn
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

    /// 开始全量重建：一个事务 + 清空行表。
    ///
    /// 随后用 [`Self::add_note`] 逐篇灌入（**只有内容表**），最后 [`Self::finish_rebuild`]
    /// 一条 `rebuild` 把 FTS 索引整体建起来。任何一步失败都要 [`Self::abort_rebuild`]。
    ///
    /// 整库重写期间刻意**放宽持久化**（`journal_mode=MEMORY` + `synchronous=OFF` + 大页缓存）：
    /// 这是几十万行的批量写，走完整 WAL+fsync 要多花好几秒。代价是"构建中途断电可能留下坏库"，
    /// 而这对**派生数据**是可接受的 —— [`Self::open`] 会自愈（删掉重建），
    /// 而且每次重建本来就会先删掉旧库文件（[`Self::open_for_rebuild`]）。
    pub fn begin_rebuild(&self) -> Result<()> {
        self.conn
            .execute_batch(
                "PRAGMA journal_mode = MEMORY;
                 PRAGMA synchronous = OFF;
                 PRAGMA cache_size = -131072;
                 BEGIN IMMEDIATE;
                 DELETE FROM lines;",
            )
            .map_err(|error| self.db(error))?;
        self.rebuilding.store(true, Ordering::Relaxed);
        Ok(())
    }

    /// 追加一篇笔记的所有行（重建与增量共用）。
    ///
    /// 返回写入的行数。空白行不进索引（搜不到任何东西，没必要占位置），
    /// 但**行号仍然是文件里的绝对行号**。
    pub fn add_note(&self, rel_path: &str, text: &str) -> Result<usize> {
        let rel = normalize_rel(rel_path);
        let bulk = self.rebuilding.load(Ordering::Relaxed);
        let mut insert = self
            .conn
            .prepare_cached(INSERT_LINE)
            .map_err(|error| self.db(error))?;
        let mut insert_fts = if bulk {
            None
        } else {
            Some(
                self.conn
                    .prepare_cached(INSERT_FTS)
                    .map_err(|error| self.db(error))?,
            )
        };

        let mut count = 0usize;
        for (line_no, line) in indexable_lines(text) {
            let indexed = space_cjk(line);
            insert
                .execute(params![rel, line_no, line, indexed])
                .map_err(|error| self.db(error))?;
            if let Some(statement) = insert_fts.as_mut() {
                statement
                    .execute(params![self.conn.last_insert_rowid(), indexed])
                    .map_err(|error| self.db(error))?;
            }
            count += 1;
        }
        Ok(count)
    }

    /// 结束全量重建：重建 FTS 索引、合并段、提交，并把持久化设置调回正常档。
    pub fn finish_rebuild(&self) -> Result<()> {
        let result = self.conn.execute_batch(
            "INSERT INTO lines_fts(lines_fts) VALUES('rebuild');
             INSERT INTO lines_fts(lines_fts) VALUES('optimize');
             COMMIT;",
        );
        self.rebuilding.store(false, Ordering::Relaxed);
        self.restore_pragmas();
        result.map_err(|error| self.db(error))
    }

    /// 放弃全量重建（取消、出错）：回滚，库里仍是上一轮提交的内容。
    pub fn abort_rebuild(&self) {
        self.rebuilding.store(false, Ordering::Relaxed);
        if let Err(error) = self.conn.execute_batch("ROLLBACK") {
            // 没有活动事务时会走到这里（正常情况），不值得 warn
            log::debug!("全文搜索重建回滚：{error}");
        }
        self.restore_pragmas();
    }

    /// 把连接调回"日常档"：WAL + `synchronous=NORMAL` + 适中的页缓存。
    ///
    /// 32MB 缓存是查询体验的关键：1 万笔记的中文索引有一百多 MB，
    /// 默认 2MB 缓存下每次查询都要重新读索引页（实测 20 次平均仍是 90ms 级别）。
    fn restore_pragmas(&self) {
        if let Err(error) = self.conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA cache_size = -32768;",
        ) {
            log::debug!("全文搜索持久化设置复位失败（不影响查询）：{error}");
        }
    }

    // -- 增量更新（保存/新建/删除/重命名） --------------------------------------

    /// 重写一篇笔记的行（保存、新建后调用）。自己开关事务。
    pub fn upsert_note(&self, rel_path: &str, text: &str) -> Result<usize> {
        let rel = normalize_rel(rel_path);
        self.in_transaction(|| {
            self.drop_path(&rel)?;
            self.add_note(&rel, text)
        })
    }

    /// 删除一篇笔记（或其整棵子树）的行。
    pub fn remove_note(&self, rel_path: &str) -> Result<usize> {
        let rel = normalize_rel(rel_path);
        self.in_transaction(|| {
            let pattern = subtree_pattern(&rel);
            self.conn
                .execute(FTS_DELETE_SUBTREE, params![rel, pattern])
                .map_err(|error| self.db(error))?;
            self.conn
                .execute(DELETE_SUBTREE, params![rel, pattern])
                .map_err(|error| self.db(error))
        })
    }

    /// 改名：把旧路径的行搬到新路径（**不需要动 FTS 索引** —— `rel_path` 不是 FTS 列）。
    pub fn rename_note(&self, old_rel_path: &str, new_rel_path: &str) -> Result<usize> {
        let old = normalize_rel(old_rel_path);
        let new = normalize_rel(new_rel_path);
        self.conn
            .execute(RENAME_PATH, params![new, old])
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

        let total: i64 = self
            .conn
            .query_row(COUNT_MATCH, params![match_query], |row| row.get(0))
            .map_err(|error| self.db(error))?;

        let mut statement = self
            .conn
            .prepare(QUERY_MATCH)
            .map_err(|error| self.db(error))?;
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

    /// 删掉某个路径的行（先给 FTS 发 `'delete'`，再删内容行）。
    fn drop_path(&self, rel: &str) -> Result<usize> {
        self.conn
            .execute(FTS_DELETE_PATH, params![rel])
            .map_err(|error| self.db(error))?;
        self.conn
            .execute(DELETE_PATH, params![rel])
            .map_err(|error| self.db(error))
    }

    /// 在一个事务里跑一段写操作，失败回滚。
    fn in_transaction<T>(&self, body: impl FnOnce() -> Result<T>) -> Result<T> {
        self.conn
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|error| self.db(error))?;
        match body() {
            Ok(value) => {
                self.conn
                    .execute_batch("COMMIT")
                    .map_err(|error| self.db(error))?;
                Ok(value)
            }
            Err(error) => {
                if let Err(rollback) = self.conn.execute_batch("ROLLBACK") {
                    log::debug!("全文搜索事务回滚失败：{rollback}");
                }
                Err(error)
            }
        }
    }

    /// rusqlite 错误 → mn-core 错误（稳定错误码 `IO`，原始原因进 `detail`）。
    fn db(&self, error: rusqlite::Error) -> Error {
        db_error(&self.label, error)
    }
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

/// 删掉缓存库及其 WAL 附属文件（失败不算错：退化成"就地重建"）。
fn remove_db_files(path: &Path) {
    for target in [
        path.to_path_buf(),
        PathBuf::from(format!("{}-wal", path.display())),
        PathBuf::from(format!("{}-shm", path.display())),
    ] {
        match std::fs::remove_file(&target) {
            Ok(()) => log::debug!("已删除全文搜索缓存：{}", target.display()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => log::debug!(
                "删除全文搜索缓存失败（将就地重建）：{}：{error}",
                target.display()
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
}
