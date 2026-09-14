//! # mn-index
//!
//! Mimenote 的**索引层**：把"哪些笔记链接了哪些笔记"变成可查询的结构。
//!
//! 设计取舍（见 `docs/architecture.md`）：
//!
//! * 索引是**可从文件重建的缓存** —— 删掉它最多损失性能，不损失内容（ADR-0002）；
//! * 第一版是**内存索引**：启动后在后台线程构建，随保存/新建/删除增量更新。
//!   全文搜索（SQLite FTS5）会落在同一层，IPC 契约保持不变，前端无感；
//! * **不在启动时同步解析全库**：1 万篇笔记 ≈ 秒级，必须放到后台并报告进度，
//!   否则冷启动预算（≤1.5s）立刻爆掉；
//! * 解析只做"从文本里找链接"（`mn_core::links`），不依赖 Markdown AST，
//!   因此可以快速、可预测地增量更新；
//! * 标签（`#标签` / frontmatter `tags`，见 [`tags::TagIndex`]）与链接共用同一次
//!   `upsert`/`remove`：同一份文本顺手算出来，不做第二次 IO，也不会出现两者不同步；
//! * 全文搜索（SQLite FTS5，见 [`search::SearchIndex`]）也在**同一遍**里建：链接索引读到的
//!   文本直接喂给搜索索引，1 万笔记场景不会为搜索再读一遍文件；
//! * 知识图谱（见 [`graph`]）**不新增数据**：它是这份链接索引 + 标签索引的一个只读投影，
//!   顺手记下的 frontmatter `title` 让"节点标题"也不必再读文件。自我中心子图
//!   （[`LinkIndex::ego_graph`]）是**同一份投影上的子集**：BFS 用的邻接表是当场从去重后的边
//!   建出来的，因此"打开某篇笔记的图谱"既不读文件，也不把全库链接重新解析一遍。

pub mod dir_move;
pub mod graph;
pub mod rename;
pub mod search;
pub mod site;
pub mod tags;

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use serde::Serialize;

use mn_core::atomic::read_text;
use mn_core::links::{extract_links, join_relative, normalize_target, LinkKind, LinkRef};
use mn_core::scanner::EntryMeta;
use mn_core::tags::TagRef;

pub use graph::{GraphData, GraphEdge, GraphNode};
pub use search::{IndexStore, NoteIndexData, SearchIndex};
pub use site::{
    SiteLink, SiteMarker, SitePage, SitePlan, SitePreviousExport, SiteStats, SITE_TOOL_ID,
};
use tags::{TagIndex, TagSummary};

/// 单篇笔记参与索引的大小上限（超过则跳过，避免大文件拖慢构建）。
pub const MAX_INDEX_BYTES: u64 = 4 * 1024 * 1024;

/// 一条出链（已尝试解析到具体笔记）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLink {
    pub kind: LinkKind,
    /// 原始目标（已剥离锚点）。
    pub raw_target: String,
    /// UI 展示文本：别名 > 目标 > `#锚点`。
    pub display: String,
    pub alias: Option<String>,
    pub anchor: Option<String>,
    pub line: u32,
    /// 解析到的笔记相对路径（`None` = 未解析，即"悬空链接"）。
    pub resolved_rel_path: Option<String>,
    /// 同名多篇 → 存在歧义（已按规则挑选一个）。
    pub ambiguous: bool,
}

/// 一条反向链接：谁指向了当前笔记。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklinkRef {
    pub from_rel_path: String,
    pub display: String,
    pub anchor: Option<String>,
    pub line: u32,
    pub kind: LinkKind,
}

/// 某篇笔记的链接情况。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteLinks {
    pub rel_path: String,
    pub outbound: Vec<ResolvedLink>,
    pub backlinks: Vec<BacklinkRef>,
    /// 出链中无法解析的数量（悬空链接）。
    pub unresolved_count: usize,
}

/// 索引概况。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
    /// 已索引的笔记数。
    pub files: usize,
    /// 出链总数。
    pub links: usize,
    /// 已解析的出链数。
    pub resolved: usize,
    /// 悬空链接数。
    pub unresolved: usize,
    /// 反向链接条目数。
    pub backlink_entries: usize,
    /// 存在歧义（同名多篇）的链接数。
    pub ambiguous: usize,
    /// 不同标签的个数（概览里的行数）。
    pub tags: usize,
}

/// 链接索引。
///
/// ## 跨会话复用（ADR-0014）
///
/// 索引本身仍然活在内存里（查询要它，图谱、反链面板都读它），但**每一篇的解析结果都同时
/// 落进缓存库**（[`LinkIndex::attach_store`]）。于是"打开 Vault"不再必须读全库文件：
/// 判定键（`path` + `mtime` + `byte` 数，与全文搜索**共用同一张 `notes_meta`**）对得上的笔记
/// 直接从库里装回内存，只有真的变了的才重读。
///
/// 落盘句柄是**加速器，不是正确性的前提**：没有它（缓存库不可用、构建被取消）时这个索引
/// 照常工作，只是回到"每次打开重建"的老路。
#[derive(Debug, Default)]
pub struct LinkIndex {
    /// 真实相对路径（含扩展名）→ 该文件的出链（原始抽取结果）。
    files: HashMap<String, Vec<LinkRef>>,
    /// 归一化路径键（**小写、无扩展名**，与 `mn_core::links::normalize_target` 一致）
    /// → 真实相对路径。必须与链接目标用同一套归一化，否则"按路径解析"永远匹配不上。
    by_path: HashMap<String, String>,
    /// 小写文件名主干 → 相对路径列表（支持 `[[只写文件名]]`）。
    by_stem: HashMap<String, Vec<String>>,
    /// 归一化路径的**每一段后缀** → 拥有该后缀的相对路径（`a/b/c` 贡献 `a/b/c`、`b/c`、`c`）。
    ///
    /// 为什么需要它：解析链接时有一条"用户只写了路径的一部分"的兜底 ——
    /// `[[子目录/笔记]]` 而实际在 `更深的/子目录/笔记.md`。原来这条兜底是**全库扫描**
    /// `by_path`，而**悬空链接**（`[[还没写的计划]]`）走的正是这条兜底：几千条这样的链接
    /// 会让图谱/反链构建到几百毫秒（`architecture.md` §8 第 16 条记录了这个尾巴）。
    /// 把后缀预先建成表之后，命中与**不命中都是 O(1)**：不需要额外的"负缓存"，
    /// 也就不需要一套失效逻辑 —— 它和 `by_path` 在同一处被维护，不可能各自漂移。
    ///
    /// 代价是内存：每个路径贡献"段数"个条目（1 万篇、平均 3 段约 2–3 MB），
    /// 换来的是解析成本与"有没有这条链接的目标"无关。
    by_suffix: HashMap<String, Vec<String>>,
    /// 目标相对路径 → 指向它的链接（惰性重建的缓存）。
    backlinks: HashMap<String, Vec<BacklinkRef>>,
    /// `backlinks` 是否需要重建。
    dirty: bool,
    /// 标签数据：与链接同源同生命周期，只在 [`Self::upsert`] / [`Self::remove`] 里更新。
    tags: TagIndex,
    /// 相对路径 → frontmatter 的 `title`（**没有 frontmatter 或没有该字段就不留条目**）。
    ///
    /// 为什么存它：知识图谱（[`graph`]）要"frontmatter title 优先、否则文件名主干"，而**不能在
    /// 每次请求时重读全库文件**。正文在 `upsert` 时本来就在手上（标签也是同一时刻解析的），
    /// 顺手多解析一次 frontmatter 区块的成本可以忽略（只扫开头的区块，不碰正文）。
    titles: HashMap<String, String>,
    /// 落盘句柄（见结构体文档）。`None` = 这次的索引不跨会话复用。
    store: Option<IndexStore>,
}

/// 一篇笔记的**解析结果**（链接 + 标签 + frontmatter 标题）。
///
/// 与 [`LinkIndex`] 的"记账"分开是有意的：`upsert`（读文件算出来）与跨会话复用
/// （从库里读回来）**必须是同一条记账路径**，否则两条路会各自演化，
/// 而它们之间任何一点差别都表现为"复用之后链接面板变了"。
struct ParsedNote {
    links: Vec<LinkRef>,
    tags: Vec<TagRef>,
    title: Option<String>,
}

impl LinkIndex {
    pub fn new() -> Self {
        Self {
            dirty: false,
            ..Self::default()
        }
    }

    /// 清空（切换 Vault 时调用）。
    ///
    /// 顺手**解绑落盘句柄**：清空之后这个索引不再属于任何 Vault，继续用它写盘等于把上一个
    /// Vault 的解析结果写进当前缓存库（切换 Vault 的顺序是 `reset → clear → spawn_build`，
    /// 新的一轮构建会挂上属于新 Vault 的句柄）。
    pub fn clear(&mut self) {
        self.files.clear();
        self.by_path.clear();
        self.by_stem.clear();
        self.by_suffix.clear();
        self.backlinks.clear();
        self.tags.clear();
        self.titles.clear();
        self.dirty = false;
        self.store = None;
    }

    /// 挂上落盘句柄（宿主在开库之后调用；也可以由 [`build_indexes`] 从搜索索引上取）。
    pub fn attach_store(&mut self, store: IndexStore) {
        self.store = Some(store);
    }

    /// 解绑落盘句柄：内存索引与库里的内容不再保证是同一份快照（取消/回滚之后）。
    pub fn detach_store(&mut self) {
        self.store = None;
    }

    /// 是否挂着落盘句柄（日志与测试用）。
    pub fn has_store(&self) -> bool {
        self.store.is_some()
    }

    /// 落盘句柄（`build_indexes` 装载可复用的数据时用）。
    fn store(&self) -> Option<&IndexStore> {
        self.store.as_ref()
    }

    /// 新增/更新一篇笔记的出链与标签。
    ///
    /// 挂了落盘句柄时，**同一份解析结果**会顺手写进缓存库：内存与库里因此不可能不一致
    /// （不是"两次解析碰巧一致"，是同一个 `ParsedNote`）。
    pub fn upsert(&mut self, rel_path: &str, text: &str) {
        let rel = rel_path.replace('\\', "/");
        let parsed = Self::parse_note(text);
        self.persist(&rel, &parsed);
        self.forget(&rel);
        self.insert_parsed(rel, parsed);
    }

    /// 移除一篇笔记（删除/重扫时调用）：链接与标签一起清掉。
    pub fn remove(&mut self, rel_path: &str) {
        let rel = rel_path.replace('\\', "/");
        self.forget(&rel);
        self.drop_persisted(&rel);
    }

    /// 解析一篇正文（**只解析，不记账**）。
    fn parse_note(text: &str) -> ParsedNote {
        ParsedNote {
            links: extract_links(text),
            // 标签与链接同一份文本、同一个时机算出来：不额外读文件，也不可能不同步
            tags: mn_core::extract_tags(text),
            // 展示标题同理：frontmatter 区块本来就要为标签扫一遍，这里顺手取 `title`
            title: frontmatter_title(text),
        }
    }

    /// 把解析结果记进索引。**这是唯一的记账入口**：`upsert` 与复用装载都走它，
    /// 因此"复用回来的索引"与"从零重建的索引"逐条相同是结构上保证的。
    ///
    /// 调用方负责先 [`Self::forget`]（同一篇重复写入时得先清掉旧账，否则 `by_stem` 会留下幽灵条目）。
    fn insert_parsed(&mut self, rel: String, parsed: ParsedNote) {
        self.tags.replace(&rel, parsed.tags);
        if let Some(title) = parsed.title {
            self.titles.insert(rel.clone(), title);
        }

        self.by_path.insert(normalize_target(&rel), rel.clone());
        self.index_suffixes(&rel);
        if let Some(stem) = stem_of(&rel) {
            self.by_stem
                .entry(stem.to_lowercase())
                .or_default()
                .push(rel.clone());
        }
        self.files.insert(rel, parsed.links);
        self.dirty = true;
    }

    /// 把一个相对路径的**全部后缀**记进 `by_suffix`（与 [`Self::by_path`] 同一处调用）。
    fn index_suffixes(&mut self, rel: &str) {
        for suffix in suffixes_of(&normalize_target(rel)) {
            self.by_suffix
                .entry(suffix)
                .or_default()
                .push(rel.to_string());
        }
    }

    /// 撤销 [`Self::index_suffixes`]（与 [`Self::by_path`] 的删除同一处调用）。
    fn unindex_suffixes(&mut self, rel: &str) {
        for suffix in suffixes_of(&normalize_target(rel)) {
            if let Some(list) = self.by_suffix.get_mut(&suffix) {
                list.retain(|candidate| candidate != rel);
                if list.is_empty() {
                    self.by_suffix.remove(&suffix);
                }
            }
        }
    }

    /// "路径以 `key` 结尾（或就是 `key`）"的那些笔记 —— **O(1)**，见 [`Self::by_suffix`]。
    fn suffix_matches(&self, key: &str) -> Vec<String> {
        self.by_suffix.get(key).cloned().unwrap_or_default()
    }

    /// 只清内存（不动落盘数据）：`upsert` 与 `remove` 共用。
    fn forget(&mut self, rel: &str) {
        // 标签与标题都独立于链接数据，必须无条件清理 —— 否则删掉笔记后标签面板/图谱里还留着它
        self.tags.remove(rel);
        self.titles.remove(rel);
        if self.files.remove(rel).is_none() {
            return;
        }
        self.by_path.remove(&normalize_target(rel));
        self.unindex_suffixes(rel);
        if let Some(stem) = stem_of(rel) {
            let key = stem.to_lowercase();
            if let Some(list) = self.by_stem.get_mut(&key) {
                list.retain(|candidate| candidate != rel);
                if list.is_empty() {
                    self.by_stem.remove(&key);
                }
            }
        }
        self.dirty = true;
    }

    /// 把一篇笔记的解析结果写进缓存库（挂了句柄时）。
    ///
    /// 失败只记 warn：库里没写成功，判定键也一并被作废，下次打开会重读这一篇 ——
    /// 结果仍然正确，只是少了这一篇的复用。
    fn persist(&self, rel: &str, parsed: &ParsedNote) {
        let Some(store) = self.store.as_ref() else {
            return;
        };
        let data = NoteIndexData {
            rel_path: rel.to_string(),
            links: parsed.links.clone(),
            title: parsed.title.clone(),
            tags: parsed.tags.clone(),
        };
        if let Err(error) = store.replace_note(rel, &data) {
            log::warn!("链接/标签索引写盘失败（{rel}，下次打开会重读这一篇）：{error}");
        }
    }

    /// 把一篇笔记的落盘数据删掉（挂了句柄时）。
    fn drop_persisted(&self, rel: &str) {
        let Some(store) = self.store.as_ref() else {
            return;
        };
        if let Err(error) = store.drop_note(rel) {
            log::warn!("链接/标签索引删除落盘数据失败（{rel}）：{error}");
        }
    }

    /// 把**库里读回来的**一篇笔记装进索引（跨会话复用路径）。
    ///
    /// 刻意**不写盘**：数据本来就是从库里读出来的，写回去只会把刚对上的判定键又作废一次。
    pub(crate) fn apply_persisted(&mut self, data: NoteIndexData) {
        let rel = data.rel_path.replace('\\', "/");
        self.forget(&rel);
        self.insert_parsed(
            rel,
            ParsedNote {
                links: data.links,
                tags: data.tags,
                title: data.title,
            },
        );
    }

    /// 是否已索引某篇笔记。
    pub fn contains(&self, rel_path: &str) -> bool {
        self.files.contains_key(&rel_path.replace('\\', "/"))
    }

    /// 列出某个目录下的所有后代笔记（删除目录时用）。
    ///
    /// 判定用 [`path_inside`]（段感知）：朴素的 `starts_with` 会把 `归档2/甲.md` 也算成
    /// `归档` 的后代 —— 那种错在"移动/删除目录"上会**动错文件**。
    pub fn paths_under(&self, prefix: &str) -> Vec<String> {
        let dir = prefix.replace('\\', "/");
        let mut out: Vec<String> = self
            .files
            .keys()
            .filter(|path| path_inside(path, &dir))
            .cloned()
            .collect();
        out.sort();
        out
    }

    /// 全部已索引笔记的相对路径（字典序）。
    ///
    /// 目录搬迁要用它算出"谁指向子树里某一篇"：候选集是**全部出链目标落在子树前缀内**的文件，
    /// 逐个 `referrers_of` 会退化成 O(笔记数 × 子树篇数)（1000 篇目录 ⇒ 千万级比较），
    /// 而这里一趟线性遍历就够了（与 `referrers_of` 用的是同一套解析规则）。
    pub fn paths(&self) -> Vec<String> {
        let mut out: Vec<String> = self.files.keys().cloned().collect();
        out.sort();
        out
    }

    /// 一篇笔记的**原始出链目标**（按文档内顺序）；未收录 → 空。
    ///
    /// 目录搬迁要判断"这篇里有没有链接指向被搬走的子树"，只需原始目标 + [`Self::resolve`]，
    /// 不需要构造 [`ResolvedLink`]（那要克隆别名/锚点等字段，1 万笔记下是白花的分配）。
    pub fn raw_targets(&self, rel_path: &str) -> Vec<&str> {
        self.files
            .get(&rel_path.replace('\\', "/"))
            .map(|links| links.iter().map(|link| link.raw_target.as_str()).collect())
            .unwrap_or_default()
    }

    /// 已索引的笔记数。
    pub fn len(&self) -> usize {
        self.files.len()
    }

    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }

    /// 某篇笔记的出链（已按索引规则解析，**按文档内顺序**）；未收录 → 空。
    ///
    /// 与 [`Self::note_links`] 的差别只有两点，但都很重要：
    ///
    /// * 只需要 `&self` —— 它**不重建反链缓存**（那是一次全库解析），因此可以在只读借用下
    ///   被调用（站点计划就是这样遍历全库的：每篇都要出链，但反链由计划自己顺手算）；
    /// * 不带反链，也不报告 `unresolved_count`（要那个数的人自己数 `href.is_none()`）。
    ///
    /// 解析规则与 [`Self::note_links`] **完全同源**（同一个 `resolve_link`），
    /// 绝不在这里另写一份"看起来等价"的匹配：导出的站点里一条链接悬空、而应用里那条
    /// 链接是好的，是用户最难理解的一类不一致。
    pub fn outbound_of(&self, rel_path: &str) -> Vec<ResolvedLink> {
        let rel = rel_path.replace('\\', "/");
        self.files
            .get(&rel)
            .map(|links| {
                links
                    .iter()
                    .map(|link| self.resolve_link(&rel, link))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 查询某篇笔记的出链与反向链接。
    pub fn note_links(&mut self, rel_path: &str) -> NoteLinks {
        let rel = rel_path.replace('\\', "/");
        self.ensure_backlinks();

        let outbound: Vec<ResolvedLink> = self
            .files
            .get(&rel)
            .map(|links| {
                links
                    .iter()
                    .map(|link| self.resolve_link(&rel, link))
                    .collect()
            })
            .unwrap_or_default();

        let backlinks = self.backlinks.get(&rel).cloned().unwrap_or_default();
        let unresolved_count = outbound
            .iter()
            .filter(|link| link.resolved_rel_path.is_none())
            .count();

        NoteLinks {
            rel_path: rel,
            outbound,
            backlinks,
            unresolved_count,
        }
    }

    /// 某篇笔记的反向链接（不含出链）。
    pub fn backlinks_of(&mut self, rel_path: &str) -> Vec<BacklinkRef> {
        self.ensure_backlinks();
        self.backlinks
            .get(&rel_path.replace('\\', "/"))
            .cloned()
            .unwrap_or_default()
    }

    /// 用索引的解析规则把一个链接目标解析成具体笔记（`None` = 悬空）。
    ///
    /// 重命名改写必须与索引看到**同一套**规则：否则会出现"反链面板能解析、
    /// 改写后却悬空"这种最难查的不一致。
    pub fn resolve(&self, from_rel: &str, raw_target: &str) -> Option<String> {
        self.resolve_target(from_rel, raw_target).0
    }

    /// 所有出链解析到 `target_rel` 的笔记（重命名改写"候选集"的唯一来源）。
    ///
    /// 与 [`Self::backlinks_of`] 的差别：这里**包含自引用** —— `甲.md` 里的 `[[甲]]`
    /// 在改名后必须跟着改；而反链面板刻意不含自引用（那是 UI 噪音）。
    /// 纯锚点链接（`[[#小节]]`、`[x](#锚点)`）指向文件自身、改名后依然成立，不算在内。
    pub fn referrers_of(&self, target_rel: &str) -> Vec<String> {
        let target = target_rel.replace('\\', "/");
        let mut out: Vec<String> = Vec::new();
        for (from_rel, refs) in &self.files {
            let hit = refs.iter().any(|link| {
                !link.raw_target.trim().is_empty()
                    && self.resolve_target(from_rel, &link.raw_target).0.as_deref()
                        == Some(target.as_str())
            });
            if hit {
                out.push(from_rel.clone());
            }
        }
        // HashMap 的遍历顺序不稳定；排序后调用方（改写计划的日志与结果）才是可复现的
        out.sort();
        out
    }

    /// 索引概况。
    pub fn stats(&mut self) -> IndexStats {
        self.ensure_backlinks();

        let mut links = 0usize;
        let mut resolved = 0usize;
        let mut ambiguous = 0usize;

        for (rel, refs) in &self.files {
            for reference in refs {
                links += 1;
                let link = self.resolve_link(rel, reference);
                if link.resolved_rel_path.is_some() {
                    resolved += 1;
                }
                if link.ambiguous {
                    ambiguous += 1;
                }
            }
        }

        IndexStats {
            files: self.files.len(),
            links,
            resolved,
            unresolved: links - resolved,
            backlink_entries: self.backlinks.values().map(|list| list.len()).sum(),
            ambiguous,
            tags: self.tags.key_count(),
        }
    }

    // -- 标签（数据由 `upsert`/`remove` 顺带维护，这里只做查询） -------------------

    /// 某篇笔记的标签（保序：frontmatter 在前、正文在后）。未收录 → 空。
    ///
    /// 注意"未收录"与"收录了但没有标签"都返回空：调用方若要区分，用 [`Self::contains`]。
    pub fn tags_of(&self, rel_path: &str) -> Vec<TagRef> {
        self.tags.tags_of(rel_path)
    }

    /// 全库标签概览（`count` 降序 → `key` 升序）。
    pub fn tag_summary(&self) -> Vec<TagSummary> {
        self.tags.summary()
    }

    /// 某个标签下的笔记（字典序）。`key` 传原始写法（含 `#`、任意大小写）也能命中。
    pub fn notes_with_tag(&self, key: &str) -> Vec<String> {
        self.tags.notes_of(key)
    }

    /// 组合过滤：含 `any` 里任意一个（空 = 全部有标签的笔记）且不含 `none` 里任何一个。
    ///
    /// 语义与实现都在 [`crate::tags::TagIndex::filter_notes`]；这里只是转发，
    /// 让宿主不必知道标签索引的内部结构（与 [`Self::notes_with_tag`] 同一姿态）。
    pub fn filter_tags(
        &self,
        any: &[String],
        none: &[String],
        include_children: bool,
    ) -> Vec<String> {
        self.tags.filter_notes(any, none, include_children)
    }

    /// 有标签的笔记数（"共 N 篇"里的 N）。没有标签的笔记不计入。
    pub fn tagged_note_count(&self) -> usize {
        self.tags.note_count()
    }

    /// 不同标签的个数。
    pub fn tag_count(&self) -> usize {
        self.tags.key_count()
    }

    // -- 展示标题（图谱用） ------------------------------------------------------

    /// 某篇笔记在 frontmatter 里声明的 `title`（没有 frontmatter / 没有该字段 → `None`）。
    ///
    /// 图谱的"展示标题"优先用它（见 [`graph`]），拿不到再退回文件名主干。
    /// 它随 `upsert`/`remove`/`clear` 与链接、标签同生命周期，因此**不需要任何文件 IO**。
    pub fn title_of(&self, rel_path: &str) -> Option<&str> {
        self.titles
            .get(&rel_path.replace('\\', "/"))
            .map(String::as_str)
    }

    /// 把一条原始链接解析成具体笔记。
    fn resolve_link(&self, from_rel: &str, link: &LinkRef) -> ResolvedLink {
        let (resolved_rel_path, ambiguous) = self.resolve_target(from_rel, &link.raw_target);
        let display = match (&link.alias, link.raw_target.is_empty(), &link.anchor) {
            (Some(alias), _, _) => alias.clone(),
            (None, false, _) => link.raw_target.clone(),
            (None, true, Some(anchor)) => format!("#{anchor}"),
            (None, true, None) => String::new(),
        };

        ResolvedLink {
            kind: link.kind,
            raw_target: link.raw_target.clone(),
            display,
            alias: link.alias.clone(),
            anchor: link.anchor.clone(),
            line: link.line,
            resolved_rel_path,
            ambiguous,
        }
    }

    /// 解析规则（与 Obsidian 保持一致的直觉）：
    ///
    /// 1. 目标带目录：先按"相对当前文件所在目录"找，再按"相对 Vault 根"找，
    ///    最后退化到"路径后缀匹配"；
    /// 2. 目标只有文件名：按**文件名主干**匹配全库（同名多篇时：同目录优先 → 路径更短优先 → 字典序）；
    /// 3. 找不到 → `None`（悬空链接，UI 会标红，未来可一键创建）。
    fn resolve_target(&self, from_rel: &str, raw_target: &str) -> (Option<String>, bool) {
        let key = normalize_target(raw_target);
        if key.is_empty() {
            // `[[#小节]]`：指向自身
            let self_path = self.by_path.get(&normalize_target(from_rel)).cloned();
            return (self_path, false);
        }

        if key.contains('/') {
            // 先按"相对当前文件所在目录"找（Markdown 链接的常见写法），再按"相对 Vault 根"找。
            //
            // 候选必须**折叠 `..`**：名字/目录搬迁会把链接改写成 `../目标` 形态
            //（`别的/引用.md` 里的 `[[../工程/乙]]`），而 by_path 的键是规范路径 ——
            // 不折叠就永远查不到，于是"搬迁之后链接全部悬空"。语义上折叠也是对的：
            // `别的/../工程/乙` 指的就是 `工程/乙`（与 `mn_core::links::join_relative` 同一口径）。
            let from_dir = parent_of(&from_rel.replace('\\', "/"));
            let candidates: Vec<String> = [join_relative(&from_dir, &key), join_relative("", &key)]
                .into_iter()
                .flatten()
                .map(|candidate| fold_dots(&candidate))
                .collect();
            for candidate in candidates {
                if let Some(real) = self.by_path.get(&candidate) {
                    return (Some(real.clone()), false);
                }
            }
            // 后缀匹配：用户常写 `[[子目录/笔记]]` 而实际在更深一层（`by_suffix` 的 O(1) 查表，
            // 命中与不命中一样快 —— 悬空链接走的正是这一条，见该字段的文档）
            return pick_candidate(self.suffix_matches(&key), from_rel);
        }

        // 只有文件名（或主干）
        let stem_key = stem_of(&key).unwrap_or(key.clone()).to_lowercase();
        let mut matches = self.by_stem.get(&stem_key).cloned().unwrap_or_default();

        if matches.is_empty() {
            // 兜底：当作路径后缀（例如目标是 `某目录/笔记` 但被上面的分支漏掉，或带了扩展名）
            matches = self.suffix_matches(&key);
        }

        pick_candidate(matches, from_rel)
    }

    /// 重建反向链接缓存（惰性）。
    fn ensure_backlinks(&mut self) {
        if !self.dirty {
            return;
        }

        let mut backlinks: HashMap<String, Vec<BacklinkRef>> = HashMap::new();
        for (from_rel, refs) in &self.files {
            for reference in refs {
                let (resolved, _) = self.resolve_target(from_rel, &reference.raw_target);
                let Some(target) = resolved else { continue };
                // 自引用（`[[#小节]]`、`[x](#锚点)`）不算反向链接，否则面板里全是噪音
                if &target == from_rel {
                    continue;
                }
                let display = match (&reference.alias, reference.raw_target.is_empty()) {
                    (Some(alias), _) => alias.clone(),
                    (None, false) => reference.raw_target.clone(),
                    (None, true) => from_rel.clone(),
                };
                backlinks.entry(target).or_default().push(BacklinkRef {
                    from_rel_path: from_rel.clone(),
                    display,
                    anchor: reference.anchor.clone(),
                    line: reference.line,
                    kind: reference.kind,
                });
            }
        }

        // 稳定排序：先按来源路径，再按行号 —— 面板展示才不会是随机的
        for list in backlinks.values_mut() {
            list.sort_by(|a, b| {
                a.from_rel_path
                    .cmp(&b.from_rel_path)
                    .then_with(|| a.line.cmp(&b.line))
            });
        }

        self.backlinks = backlinks;
        self.dirty = false;
    }
}

/// 在候选里挑一个：同目录优先 → 路径更短优先 → 字典序。返回是否"存在歧义"。
fn pick_candidate(mut matches: Vec<String>, from_rel: &str) -> (Option<String>, bool) {
    matches.sort();
    matches.dedup();
    match matches.len() {
        0 => (None, false),
        1 => (matches.into_iter().next(), false),
        _ => {
            let from_dir = parent_of(from_rel);
            let mut best: Option<&String> = None;
            for candidate in &matches {
                let better = match best {
                    None => true,
                    Some(current) => {
                        let candidate_same_dir =
                            !from_dir.is_empty() && parent_of(candidate) == from_dir;
                        let current_same_dir =
                            !from_dir.is_empty() && parent_of(current) == from_dir;
                        match (candidate_same_dir, current_same_dir) {
                            (true, false) => true,
                            (false, true) => false,
                            _ => {
                                let by_len =
                                    candidate.chars().count().cmp(&current.chars().count());
                                if by_len == std::cmp::Ordering::Equal {
                                    candidate < current
                                } else {
                                    by_len == std::cmp::Ordering::Less
                                }
                            }
                        }
                    }
                };
                if better {
                    best = Some(candidate);
                }
            }
            (best.cloned(), true)
        }
    }
}

/// 一个归一化路径键的**全部后缀**（含它自己）：`a/b/c` → `a/b/c`、`b/c`、`c`。
///
/// 这是 [`LinkIndex::by_suffix`] 的建表口径，也是"用户只写了路径的一部分"这条解析兜底的
/// 全部可能形态：`[[子目录/笔记]]` 能匹配到的，必须正好是某个路径以 `/子目录/笔记` 结尾
/// （或者路径本身就是 `子目录/笔记`）。空键返回空 —— 它代表 `[[#小节]]`，由调用方另行处理。
fn suffixes_of(key: &str) -> Vec<String> {
    if key.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(4);
    out.push(key.to_string());
    for (index, _) in key.match_indices('/') {
        out.push(key[index + 1..].to_string());
    }
    out
}

fn parent_of(rel_path: &str) -> String {
    match rel_path.rfind('/') {
        Some(index) => rel_path[..index].to_string(),
        None => String::new(),
    }
}

/// 折叠路径里的 `.` 与 `..`（`别的/../工程/乙` → `工程/乙`）。
///
/// 为什么必须有：搬迁（改名/移动）会把链接改写成 `../目标` 形态，而 `by_path` 的键是规范路径。
/// 不折叠的话那些链接永远解析不到 —— 表现是"搬完之后全库的链接都悬空了"。
fn fold_dots(rel: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for segment in rel.split('/') {
        match segment {
            "" | "." => continue,
            // 越出 Vault 根（`..` 多于层级）时保留原样：它本来就在 Vault 之外，解析不到才是对的
            ".." => {
                if out.pop().is_none() {
                    out.push("..");
                }
            }
            other => out.push(other),
        }
    }
    out.join("/")
}

/// `rel_path` 是否**在目录 `dir` 之内**（段感知；`dir` 为空串 = Vault 根，即"任何路径都在内"）。///
/// 为什么不能直接用 `starts_with`：`归档2/甲.md` 以 `归档` 开头却不是它的后代。
/// 目录搬迁与目录删除都靠这条判定决定"动谁"，判错就是动错文件。
pub fn path_inside(rel_path: &str, dir: &str) -> bool {
    // 尾随 `/` 一律容忍：调用方既有传 `去掉我` 的，也有传 `去掉我/` 的
    let dir = dir.trim_end_matches('/');
    if dir.is_empty() {
        return true;
    }
    rel_path
        .strip_prefix(dir)
        .is_some_and(|rest| rest.starts_with('/'))
}

/// 把 `rel_path`（必须已在 `old_dir` 之内）映射到 `new_dir` 下的对应位置。
///
/// `rename.rs` 与 `dir_move.rs` 都要做这一步（把"旧前缀下的路径"换成"新前缀下的路径"），
/// 各写一遍就会在"目录名本身含分隔符的边界"上分家。
pub fn remap_prefix(rel_path: &str, old_dir: &str, new_dir: &str) -> Option<String> {
    let rest = if old_dir.is_empty() {
        rel_path
    } else {
        rel_path.strip_prefix(old_dir)?.strip_prefix('/')?
    };
    Some(if new_dir.is_empty() {
        rest.to_string()
    } else {
        format!("{new_dir}/{rest}")
    })
}

/// 文件名主干：`a/b/Note.md` → `Note`。
///
/// 实现已经**提升到 `mn_core::site::document_stem`**：导出要拿它当页面标题、
/// 图谱要拿它当没有 frontmatter `title` 时的节点标题，两条路必须是同一把尺子。
/// 这个私有壳子保留下来只为不动既有调用点（`by_stem` 的建键、`graph` 的标题兜底），
/// 它**不含任何判定** —— 规则只有一份，在这里转发是刻意的（见 `document_stem` 的文档）。
fn stem_of(rel_path: &str) -> Option<String> {
    mn_core::site::document_stem(rel_path)
}

/// 取 frontmatter 的 `title`（供图谱做展示标题）。
///
/// 只有**非空标量**才算数：`title: [a, b]` 这类非标量、`title:` 空值、`title: '  '` 空白
/// 都当作"没有标题"，让调用方退回文件名主干 —— 总比在卡片上显示 `null` 或空串好。
fn frontmatter_title(text: &str) -> Option<String> {
    let frontmatter = mn_core::frontmatter::parse(text)?;
    let title = frontmatter.get("title")?.as_str()?.trim();
    (!title.is_empty()).then(|| title.to_string())
}

/// 索引构建选项。
#[derive(Debug, Clone)]
pub struct BuildOptions {
    /// 参与索引的扩展名（小写，不含点）。
    pub note_extensions: Vec<String>,
    /// 单文件大小上限。
    pub max_bytes: u64,
    /// 每处理多少个文件回调一次进度。
    pub progress_every: usize,
}

impl Default for BuildOptions {
    fn default() -> Self {
        Self {
            note_extensions: ["md", "markdown"].iter().map(|s| s.to_string()).collect(),
            max_bytes: MAX_INDEX_BYTES,
            progress_every: 50,
        }
    }
}

/// 构建结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildOutcome {
    /// 已索引的笔记数。
    pub indexed: usize,
    /// 跳过的条目数（非笔记、过大、读失败）。
    pub skipped: usize,
    /// 参与索引的候选总数。
    pub total: usize,
    /// 耗时（毫秒）。
    pub duration_ms: u64,
    /// 是否被取消（例如用户切换了 Vault）。
    pub cancelled: bool,
    /// 全文搜索索引的构建结果（这一轮没建搜索索引时为 `None`）。
    pub search: Option<SearchBuildOutcome>,
    /// 这一轮**没有读文件**、直接从缓存库里复用落盘索引的笔记数（ADR-0014）。
    ///
    /// 它存在的意义不只是统计：`reused_notes == total` 就是"Vault 没变，一次文件读都没发生"
    /// 的可断言证据（见 `tests/persisted_index.rs`）。
    pub reused_notes: usize,
    /// 这一轮**花在复用上**的时间（毫秒）：增量对账 + 从库里装载链接/标签数据。
    ///
    /// 与 `duration_ms` 分开报，才能说清"打开 Vault 剩下的时间花在哪"：
    /// 复用省掉的是文件 IO，不是这几毫秒的对账。
    pub reuse_ms: u64,
}

/// 全文搜索索引的构建结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchBuildOutcome {
    /// 本轮写入的行数（全库命中、什么都没变时是 0）。
    pub lines: usize,
    /// 本轮**花在搜索索引上**的时间（毫秒）：对账 + 写入 + 收尾，不含链接/标签那一遍。
    ///
    /// 刻意不用"从构建开始到收尾"的墙钟时间：增量复用之后，搜索索引可能只花几十毫秒，
    /// 而整轮构建要读全库文件几秒钟 —— 那样报出来的数字会让人以为搜索仍然很慢。
    pub duration_ms: u64,
    /// 失败/取消导致这轮**没有提交**（库仍是上一轮的内容）。
    pub aborted: bool,
    /// 失败原因（有值时这轮搜索索引不可用，但链接索引不受影响）。
    pub error: Option<String>,
    /// 按文件元数据**原样留用**（一行都没重写）的笔记数。
    pub reused_notes: usize,
}

/// 这一轮全文搜索索引的写模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SearchMode {
    /// 全库命中、也没有要删的：**不动索引表**（连事务都不开）。
    Noop,
    /// 整库重建：清空后逐篇写内容表，最后一次性 `rebuild` FTS 索引。
    Full,
    /// 增量：只重写变化的那几篇（FTS 按行维护）。
    Incremental,
}

/// 从磁盘构建索引（链接 + 标签 + 可选全文搜索）。
///
/// `cancel` 用于在切换 Vault / 关闭应用时中断（每处理一个文件检查一次）。
/// `progress` 每 `options.progress_every` 个文件回调一次 `(已处理, 总数)`。
/// `search` 给了就**在这一遍里顺带建全文搜索索引**（同一份文本，不重读文件）：
/// 先按 `(path, mtime, size)` 与缓存库对账，能留用的笔记**一行都不重写**
/// （见 `search::SearchIndex::plan_incremental`；ADR-0008「后续修订」）。
///
/// 链接 / 标签索引与它复用**同一次对账、同一张判定键、同一个连接**（ADR-0014）：
/// 判定键对上的笔记连文件都不读，直接把上次落盘的解析结果装回内存；
/// 只有新增/改动/mtime 不可得的那些才重读文件并重新落盘。
/// Vault 一个字节都没变时，这一整轮的成本就是"对账 + 反序列化"。
///
/// 返回 `(索引, 结果)`。
pub fn build_indexes(
    root: &Path,
    entries: &[EntryMeta],
    options: &BuildOptions,
    cancel: Option<&AtomicBool>,
    search: Option<&SearchIndex>,
    mut progress: impl FnMut(usize, usize),
) -> (LinkIndex, BuildOutcome) {
    let started = Instant::now();
    let notes: Vec<&EntryMeta> = entries
        .iter()
        .filter(|entry| !entry.is_dir && is_note(entry, &options.note_extensions))
        .collect();
    let total = notes.len();

    let mut index = LinkIndex::new();
    let mut indexed = 0usize;
    let mut skipped = 0usize;
    let mut cancelled = false;
    let mut reused_notes = 0usize;

    // 全文搜索：先与库里的文件元数据对账，再决定写什么。
    // 任何一步失败都只让"搜索这一路"降级，链接索引照常建完。
    let mut search_nanos: u128 = 0;
    let mut search_lines = 0usize;
    let mut search_reused = 0usize;
    let mut search_error: Option<String> = None;
    let mut search_mode: Option<SearchMode> = None;
    let mut search_sink: Option<&SearchIndex> = None;
    let mut search_changed: HashSet<String> = HashSet::new();
    // 对账、开事务、逐篇写入任一环失败：这一轮搜索索引不算数（回滚，库里仍是上一轮的内容）
    let mut search_failed = false;

    // 复用：`None` = 这一轮所有笔记都要重读（没给搜索索引 / 对账失败）；
    // `Some(空集)` = 全库命中（一篇都不用读）；`Some(集合)` = 只有集合里的要重读。
    let mut reload: Option<HashSet<String>> = None;
    let mut reuse_nanos: u128 = 0;

    if let Some(target) = search {
        let planning = Instant::now();
        match target.plan_incremental(&notes) {
            Ok(plan) if plan.is_noop() => {
                // 全库命中、也没有要删的：这就是"Vault 没变时打开几乎是常数开销"的由来
                search_reused = plan.reused;
                search_mode = Some(SearchMode::Noop);
                reload = Some(HashSet::new());
                // 库里已提交的内容与内存即将装成的内容是同一份快照 —— 这时挂上写穿透才是对的。
                // 注意**只在会写入的那几种模式下挂**：对账失败/开事务失败时库里是"上一轮的快照"，
                // 这一轮的内存索引与它并不是同一份，继续写盘只会把半截数据混进去。
                index.attach_store(target.index_store());
            }
            Ok(plan) => {
                search_reused = plan.reused;
                reload = Some(plan.changed.iter().cloned().collect());
                let begun = if plan.needs_full_rebuild() {
                    target.begin_rebuild().map(|()| SearchMode::Full)
                } else {
                    target
                        .begin_incremental(&plan)
                        .map(|()| SearchMode::Incremental)
                };
                match begun {
                    Ok(mode) => {
                        search_changed = plan.changed.into_iter().collect();
                        search_mode = Some(mode);
                        search_sink = Some(target);
                        // 写穿透与搜索那一半共用连接：这一轮的文件读取结果会与行、判定键
                        // 落在**同一个事务**里（见 search.rs 的模块文档：三条不变量）
                        index.attach_store(target.index_store());
                    }
                    Err(error) => {
                        log::warn!("全文搜索索引无法开始写入（本轮跳过）：{error}");
                        search_error = Some(error.to_string());
                        search_failed = true;
                    }
                }
            }
            Err(error) => {
                log::warn!("全文搜索索引增量对账失败（本轮跳过）：{error}");
                search_error = Some(error.to_string());
                search_failed = true;
            }
        }
        reuse_nanos += planning.elapsed().as_nanos();
    }

    // 装载可复用的那一半：这一批笔记**一个文件都不读**，索引直接来自上次落盘的结果。
    // 只有在 `link_notes` 里留下过凭证的路径才算数（零链接零标签的笔记也在其中），
    // 缺凭证的那些会让循环退回"读文件"，因此库里少一份数据只会慢一点，不会错。
    let mut persisted: HashMap<String, NoteIndexData> = HashMap::new();
    if let Some(changed) = reload.as_ref() {
        if let Some(store) = index.store() {
            let loading = Instant::now();
            // 扫描到的路径一次性建成集合：库里的行是 O(笔记数)，逐行去 `notes` 里线性查一遍
            // 就是 1 万笔记下的亿级字符串比较（实测把复用一轮从 0.2s 拖到 0.6s）
            let scanned: HashSet<&str> = notes.iter().map(|note| note.rel_path.as_str()).collect();
            match store.load_all() {
                Ok(all) => {
                    for data in all {
                        // 判定键没对上 → 这一轮要重读；扫描里已经没有它 → 不该出现在索引里
                        if changed.contains(&data.rel_path) {
                            continue;
                        }
                        if !scanned.contains(data.rel_path.as_str()) {
                            continue;
                        }
                        persisted.insert(data.rel_path.clone(), data);
                    }
                }
                Err(error) => {
                    // 库里的落盘数据读不出来：整轮退回"读文件重建"。索引内容不受影响，
                    // 只是这一次没能省下文件 IO（判定键没被信任，所以不会用到看不懂的数据）。
                    log::warn!("链接/标签索引无法从缓存库装载（本轮整库重读）：{error}");
                    persisted.clear();
                }
            }
            reuse_nanos += loading.elapsed().as_nanos();
        }
    }

    // 走整库重建时所有笔记都要写；走增量时只写对账说"变了"的那些
    let whole_library = search_mode == Some(SearchMode::Full);

    for (position, entry) in notes.iter().enumerate() {
        if cancel.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
            cancelled = true;
            break;
        }

        // 复用：库里已经有这一篇的完整解析结果，连文件都不用碰。
        // `remove` 是幂等的取用（同一篇不会既复用又被读），拿不到就走下面的读文件分支。
        if let Some(data) = persisted.remove(&entry.rel_path) {
            index.apply_persisted(data);
            indexed += 1;
            reused_notes += 1;
        } else {
            #[cfg(test)]
            count_note_read();
            let path = root.join(entry.rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
            let needs_search_write = whole_library || search_changed.contains(&entry.rel_path);
            match read_text(&path, options.max_bytes) {
                Ok(text) => {
                    // 链接/标签先写：它在同一个事务里作废这篇的判定键，紧接着的行写入
                    // 会用真实的 mtime/size 重新写一次 —— 顺序反了只会让这篇多读一次文件
                    index.upsert(&entry.rel_path, &text);
                    indexed += 1;
                    // 同一份文本顺手喂给全文搜索（**不重读文件**）；能留用的笔记直接跳过
                    if let Some(target) = search_sink {
                        if needs_search_write {
                            let writing = Instant::now();
                            let written = target.add_note_with_meta(
                                &entry.rel_path,
                                &text,
                                entry.mtime_ms,
                                entry.size_bytes,
                            );
                            search_nanos += writing.elapsed().as_nanos();
                            match written {
                                Ok(lines) => search_lines += lines,
                                Err(error) => {
                                    log::warn!(
                                        "全文搜索索引写入失败，本轮搜索索引放弃（链接索引不受影响）：{error}"
                                    );
                                    search_error = Some(error.to_string());
                                    search_sink = None;
                                    search_failed = true;
                                }
                            }
                        }
                    }
                }
                Err(error) => {
                    // 单个文件读失败（被删、权限、非 UTF-8、过大）不应中断整轮索引。
                    // 对搜索索引来说这就等于"这篇现在没有可索引的行"：它的旧行已经在对账
                    // （或整库清空）时删掉了，所以结果与整库重建一致 —— 不会留下过期内容。
                    log::debug!("索引跳过 {}：{error}", entry.rel_path);
                    skipped += 1;
                }
            }
        }

        if options.progress_every > 0 && position % options.progress_every == 0 {
            progress(position + 1, total);
        }
    }

    // 取消/失败时库里已经回滚（或压根没写），内存索引与它不再是同一份快照 ——
    // 立刻解绑：后面那一次保存若继续写盘，就会把"半截索引"当成这一轮的结果混进库里。
    if cancelled || search_failed {
        index.detach_store();
    }

    progress(indexed, total);

    // 收尾：取消/出错都回滚（库仍是上一轮提交的内容）；
    // 全库命中时什么都没动，直接报告成功（否则调用方不会安装连接，搜索会一直停在"构建中"）
    let search = match search {
        None => None,
        Some(target) => {
            if cancelled || search_failed {
                target.abort_rebuild();
                Some(SearchBuildOutcome {
                    lines: 0,
                    duration_ms: millis(search_nanos),
                    aborted: true,
                    error: search_error,
                    reused_notes: 0,
                })
            } else if search_mode == Some(SearchMode::Noop) {
                // 全库命中：这一轮一个字节都没写（连事务都没开过）
                Some(SearchBuildOutcome {
                    lines: 0,
                    duration_ms: millis(search_nanos),
                    aborted: false,
                    error: None,
                    reused_notes: search_reused,
                })
            } else {
                let finishing = Instant::now();
                let finished = if search_mode == Some(SearchMode::Full) {
                    target.finish_rebuild()
                } else {
                    target.finish_incremental()
                };
                search_nanos += finishing.elapsed().as_nanos();
                match finished {
                    Ok(()) => Some(SearchBuildOutcome {
                        lines: search_lines,
                        duration_ms: millis(search_nanos),
                        aborted: false,
                        error: None,
                        reused_notes: search_reused,
                    }),
                    Err(error) => {
                        log::warn!("全文搜索索引提交失败（已回滚）：{error}");
                        target.abort_rebuild();
                        Some(SearchBuildOutcome {
                            lines: 0,
                            duration_ms: millis(search_nanos),
                            aborted: true,
                            error: Some(error.to_string()),
                            reused_notes: 0,
                        })
                    }
                }
            }
        }
    };

    (
        index,
        BuildOutcome {
            indexed,
            skipped,
            total,
            duration_ms: started.elapsed().as_millis() as u64,
            cancelled,
            search,
            reused_notes,
            reuse_ms: millis(reuse_nanos),
        },
    )
}

/// 纳秒 → 毫秒（搜索索引的耗时用纳秒累加：增量一轮可能不到 1ms，四舍五入成 0 是诚实的）。
fn millis(nanos: u128) -> u64 {
    (nanos / 1_000_000) as u64
}

// 测试用探针：本线程上"真的读了几个笔记文件"。
//
// 为什么需要它（而不是只看耗时）："Vault 没变时一个文件都不读"是这一轮的核心承诺，
// 而耗时只是间接证据。计数器是直接证据（`#[cfg(test)]`：生产二进制里根本不存在它）。
// 线程局部而不是全局：`cargo test` 并行跑用例，全局计数会被别的用例污染。
#[cfg(test)]
thread_local! {
    static NOTE_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn count_note_read() {
    NOTE_READS.with(|counter| counter.set(counter.get() + 1));
}

/// 本线程累计读过的笔记文件数（`#[cfg(test)]`）。
#[cfg(test)]
fn note_reads() -> usize {
    NOTE_READS.with(std::cell::Cell::get)
}

/// 把本线程的读计数清零（`#[cfg(test)]`）。
#[cfg(test)]
fn reset_note_reads() {
    NOTE_READS.with(|counter| counter.set(0));
}

fn is_note(entry: &EntryMeta, extensions: &[String]) -> bool {
    entry.ext.as_deref().is_some_and(|ext| {
        extensions
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(ext))
    })
}

/// 只建链接/标签索引（不碰全文搜索）。等价于 [`build_indexes`] 传 `None`。
pub fn build_index(
    root: &Path,
    entries: &[EntryMeta],
    options: &BuildOptions,
    cancel: Option<&AtomicBool>,
    progress: impl FnMut(usize, usize),
) -> (LinkIndex, BuildOutcome) {
    build_indexes(root, entries, options, cancel, None, progress)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(rel: &str) -> EntryMeta {
        EntryMeta {
            rel_path: rel.to_string(),
            name: rel.rsplit('/').next().unwrap().to_string(),
            is_dir: false,
            size_bytes: 10,
            mtime_ms: Some(1),
            ext: Some("md".to_string()),
        }
    }

    fn index_of(files: &[(&str, &str)]) -> LinkIndex {
        let mut index = LinkIndex::new();
        for (rel, text) in files {
            index.upsert(rel, text);
        }
        index
    }

    #[test]
    fn resolves_wikilink_by_file_stem() {
        let mut index = index_of(&[("笔记/甲.md", "看 [[乙]]"), ("笔记/乙.md", "# 乙")]);
        let links = index.note_links("笔记/甲.md");
        assert_eq!(links.outbound.len(), 1);
        assert_eq!(
            links.outbound[0].resolved_rel_path.as_deref(),
            Some("笔记/乙.md")
        );
        assert!(!links.outbound[0].ambiguous);
        assert_eq!(links.unresolved_count, 0);
    }

    #[test]
    fn resolves_markdown_link_relative_to_current_file() {
        let mut index = index_of(&[
            ("笔记/甲.md", "[看这里](../别的/丙.md)"),
            ("别的/丙.md", "# 丙"),
        ]);
        let links = index.note_links("笔记/甲.md");
        assert_eq!(
            links.outbound[0].resolved_rel_path.as_deref(),
            Some("别的/丙.md"),
            "Markdown 链接按相对当前文件解析"
        );
    }

    #[test]
    fn dangling_link_is_reported_unresolved() {
        let mut index = index_of(&[("甲.md", "[[还不存在的笔记]]")]);
        let links = index.note_links("甲.md");
        assert_eq!(links.outbound[0].resolved_rel_path, None);
        assert_eq!(links.unresolved_count, 1);
    }

    #[test]
    fn same_directory_wins_when_names_collide() {
        let mut index = index_of(&[
            ("a/甲.md", "[[同名]]"),
            ("a/同名.md", "A"),
            ("b/同名.md", "B"),
            ("c/d/同名.md", "C"),
        ]);
        let links = index.note_links("a/甲.md");
        assert_eq!(
            links.outbound[0].resolved_rel_path.as_deref(),
            Some("a/同名.md")
        );
        assert!(links.outbound[0].ambiguous, "应当标记为存在歧义");
    }

    #[test]
    fn shortest_path_wins_without_same_directory_match() {
        let mut index = index_of(&[
            ("x/甲.md", "[[同名]]"),
            ("b/同名.md", "B"),
            ("c/d/同名.md", "C"),
        ]);
        let links = index.note_links("x/甲.md");
        assert_eq!(
            links.outbound[0].resolved_rel_path.as_deref(),
            Some("b/同名.md")
        );
        assert!(links.outbound[0].ambiguous);
    }

    #[test]
    fn path_link_matches_suffix() {
        let mut index = index_of(&[
            ("甲.md", "[[项目/设计]]"),
            ("很深的目录/项目/设计.md", "# 设计"),
        ]);
        let links = index.note_links("甲.md");
        assert_eq!(
            links.outbound[0].resolved_rel_path.as_deref(),
            Some("很深的目录/项目/设计.md")
        );
    }

    /// 后缀表的口径：一个路径键贡献"它自己 + 每个 `/` 之后的部分"。
    #[test]
    fn suffixes_are_every_tail_of_a_path_key() {
        assert_eq!(
            suffixes_of("a/b/c"),
            vec!["a/b/c".to_string(), "b/c".to_string(), "c".to_string()]
        );
        assert_eq!(suffixes_of("顶层"), vec!["顶层".to_string()]);
        // 空键代表 `[[#小节]]`，由调用方另行处理 —— 这里不能给出一个空后缀条目
        assert!(suffixes_of("").is_empty());
    }

    /// 后缀表与 `by_path` / `by_stem` 在同处维护：增、删、再增之后解析结果都要跟着变。
    ///
    /// 这条测试防的是"引入一张新表但忘了在某一处同步" —— 那种 bug 的表现是
    /// "新建的笔记链接不上、删掉的笔记还解析得到"，而且只在特定操作顺序下出现。
    #[test]
    fn suffix_table_follows_insert_and_forget() {
        let mut index = LinkIndex::new();
        assert!(
            index.resolve("引用.md", "深层/目标").is_none(),
            "空索引里解析不到"
        );

        index.upsert("深层/目标.md", "# 目标");
        assert_eq!(
            index.resolve("引用.md", "深层/目标").as_deref(),
            Some("深层/目标.md"),
            "刚加进来的笔记要能被后缀解析到"
        );

        index.remove("深层/目标.md");
        assert!(
            index.resolve("引用.md", "深层/目标").is_none(),
            "删掉之后不该还解析得到（后缀表忘了同步就会这样）"
        );

        index.upsert("深层/目标.md", "# 目标");
        assert_eq!(
            index.resolve("引用.md", "深层/目标").as_deref(),
            Some("深层/目标.md"),
            "重新加回来要能解析（重复条目会让 pick_candidate 变成歧义）"
        );

        index.clear();
        assert!(
            index.resolve("引用.md", "深层/目标").is_none(),
            "clear 之后后缀表也得空掉"
        );
    }

    /// 悬空链接的解析**不再扫描全库**：同样的解析结果，代价与库的大小无关。
    ///
    /// 为什么值得一个基准而不是单测：这条路径的旧实现是 `by_path.iter()` 全扫，
    /// 而悬空链接（"还没写的计划"）恰恰走的就是它 —— 用户 Vault 越大越慢，
    /// 且慢在**图谱/反链构建**这种批量场景里（架构 §8 第 16 条记录过这个尾巴）。
    /// 这里同时量"现在的查表"和"旧的全扫"（在测试里保留一份参考实现），
    /// 让"快了多少"是个可复核的数字，而不是"感觉快了"。
    #[test]
    #[ignore]
    fn bench_resolve_dangling_links() {
        // 4000 篇、路径深度与真实 Vault 接近（`目录/子目录/笔记`）；其中前 2000 篇各指向一个
        // **还不存在的笔记**（"计划中的笔记"），另外各带一条能解析的链接（让图谱有真实的边）
        let notes: Vec<(String, String)> = (0..4_000)
            .map(|i| {
                let rel = format!("dir{:03}/子目录/note{:03}.md", i / 40, i % 40);
                let body = if i < 2_000 {
                    format!("看 [[还没写的计划{i:04}]] 与 [[note000]]")
                } else {
                    "看 [[note000]]".to_string()
                };
                (rel, body)
            })
            .collect();
        let refs: Vec<(&str, &str)> = notes
            .iter()
            .map(|(rel, body)| (rel.as_str(), body.as_str()))
            .collect();
        let index = index_of(&refs);

        // 2000 个**互不相同**的悬空目标：这正是"计划中的笔记"的真实形态，
        // 也是旧实现里最坏的情况（每个键都要全扫一遍，而全扫结果都是空）
        let dangling: Vec<String> = (0..2_000).map(|i| format!("还没写的计划{i:04}")).collect();

        let started = Instant::now();
        let mut resolved = 0usize;
        for target in &dangling {
            if index.resolve("引用.md", target).is_some() {
                resolved += 1;
            }
        }
        let map_ms = started.elapsed().as_secs_f64() * 1000.0;

        // 旧实现（保留在测试里做对照）：把目标当路径后缀，全扫 by_path
        let started = Instant::now();
        let mut scanned = 0usize;
        for target in &dangling {
            let key = mn_core::links::normalize_target(target);
            let suffix = format!("/{key}");
            let matches: Vec<String> = index
                .by_path
                .iter()
                .filter(|(normalized, _)| *normalized == &key || normalized.ends_with(&suffix))
                .map(|(_, real)| real.clone())
                .collect();
            if !matches.is_empty() {
                scanned += 1;
            }
        }
        let scan_ms = started.elapsed().as_secs_f64() * 1000.0;

        // 端到端对照：图谱构建里最吃解析的就是"每篇都指向一个还不存在的笔记"这种形态。
        // 两个变体只差"有没有那 2000 条悬空链接"：差值就是**悬空解析**在 graph_data 里的实际开销。
        let graph_started = Instant::now();
        let graph = index.graph_data(crate::graph::MAX_GRAPH_NODES);
        let graph_ms = graph_started.elapsed().as_secs_f64() * 1000.0;

        let clean: Vec<(String, String)> = notes
            .iter()
            .map(|(rel, _)| (rel.clone(), "看 [[note000]]".to_string()))
            .collect();
        let clean_refs: Vec<(&str, &str)> = clean
            .iter()
            .map(|(rel, body)| (rel.as_str(), body.as_str()))
            .collect();
        let clean_index = index_of(&clean_refs);
        let clean_started = Instant::now();
        let clean_graph = clean_index.graph_data(crate::graph::MAX_GRAPH_NODES);
        let clean_ms = clean_started.elapsed().as_secs_f64() * 1000.0;

        eprintln!(
            "解析 {} 条悬空链接（库 {} 篇）：\n\
             \x20 查后缀表：{map_ms:.1} ms（{:.4} ms/条）\n\
             \x20 旧的全扫：{scan_ms:.1} ms（{:.4} ms/条）\n\
             \x20 提速：{:.1}×（两者都解析不到任何东西：{resolved} / {scanned}）\n\
             \x20 graph_data（含 2000 条悬空）：{graph_ms:.1} ms（{} 节点 / {} 边）\n\
             \x20 graph_data（同规模、无悬空）：{clean_ms:.1} ms（{} 节点 / {} 边）\n\
             \x20 ⇒ 两者差 {:.1} ms：**不全是**解析的功劳（边也多了 2000 条），解析本身按上一行算\n\
             \x20 ⇒ 2000 条悬空链接的解析成本：改前 {scan_ms:.1} ms → 改后 {map_ms:.1} ms",
            dangling.len(),
            index.by_path.len(),
            map_ms / dangling.len() as f64,
            scan_ms / dangling.len() as f64,
            scan_ms / map_ms.max(0.001),
            graph.nodes.len(),
            graph.edges.len(),
            clean_graph.nodes.len(),
            clean_graph.edges.len(),
            graph_ms - clean_ms
        );

        // 对照必须"都没有解析到"，否则量的是两件不同的事
        assert_eq!(resolved, 0);
        assert_eq!(scanned, 0);
        assert!(
            scan_ms > map_ms * 5.0,
            "查表应当明显快于全扫（实测 {map_ms:.1} ms vs {scan_ms:.1} ms）——\
             如果差距没了，说明全扫被谁改回来了，或者后缀表没建起来"
        );
    }

    #[test]
    fn case_insensitive_matching() {
        let mut index = index_of(&[("甲.md", "[[note]]"), ("Note.md", "# Note")]);
        let links = index.note_links("甲.md");
        assert_eq!(
            links.outbound[0].resolved_rel_path.as_deref(),
            Some("Note.md")
        );
    }

    #[test]
    fn backlinks_are_collected_and_sorted() {
        let mut index = index_of(&[
            ("甲.md", "指向 [[乙]]"),
            ("丙.md", "也指向 [[乙]]\n第二行 [[乙|别名]]"),
            ("乙.md", "# 乙"),
        ]);
        let backlinks = index.backlinks_of("乙.md");
        assert_eq!(backlinks.len(), 3);
        assert_eq!(backlinks[0].from_rel_path, "丙.md");
        assert_eq!(backlinks[0].line, 1);
        assert_eq!(backlinks[1].from_rel_path, "丙.md");
        assert_eq!(backlinks[1].display, "别名");
        assert_eq!(backlinks[2].from_rel_path, "甲.md");
    }

    #[test]
    fn updating_a_file_replaces_its_links() {
        let mut index = index_of(&[("甲.md", "[[乙]]"), ("乙.md", ""), ("丙.md", "")]);
        assert_eq!(index.backlinks_of("乙.md").len(), 1);

        index.upsert("甲.md", "改成 [[丙]]");
        assert!(index.backlinks_of("乙.md").is_empty(), "旧链接必须消失");
        assert_eq!(index.backlinks_of("丙.md").len(), 1);
    }

    #[test]
    fn removing_a_file_clears_its_outgoing_and_incoming() {
        let mut index = index_of(&[("甲.md", "[[乙]]"), ("乙.md", "[[甲]]")]);
        assert_eq!(index.backlinks_of("甲.md").len(), 1);

        index.remove("乙.md");
        assert_eq!(index.len(), 1);
        assert!(
            index.backlinks_of("甲.md").is_empty(),
            "乙的链接应随文件一起消失"
        );
    }

    #[test]
    fn self_anchor_link_points_to_itself() {
        let mut index = index_of(&[("甲.md", "见 [[#小节]]")]);
        let links = index.note_links("甲.md");
        assert_eq!(
            links.outbound[0].resolved_rel_path.as_deref(),
            Some("甲.md")
        );
        assert_eq!(links.outbound[0].display, "#小节");
    }

    #[test]
    fn embeds_count_as_backlinks() {
        let mut index = index_of(&[("甲.md", "![[乙]]"), ("乙.md", "")]);
        assert_eq!(index.backlinks_of("乙.md").len(), 1);
        assert_eq!(index.backlinks_of("乙.md")[0].kind, LinkKind::Embed);
    }

    #[test]
    fn stats_report_resolution_ratio() {
        let mut index = index_of(&[("甲.md", "[[乙]] [[不存在]] [[乙|重复]]"), ("乙.md", "")]);
        let stats = index.stats();
        assert_eq!(stats.files, 2);
        assert_eq!(stats.links, 3);
        assert_eq!(stats.resolved, 2);
        assert_eq!(stats.unresolved, 1);
        assert_eq!(stats.backlink_entries, 2);
    }

    #[test]
    fn clears_completely() {
        let mut index = index_of(&[("甲.md", "[[乙]]"), ("乙.md", "")]);
        index.clear();
        assert!(index.is_empty());
        assert_eq!(index.stats().links, 0);
        assert!(index.backlinks_of("乙.md").is_empty());
    }

    #[test]
    fn tags_follow_upsert_and_remove() {
        // 标签与链接共用同一个 upsert/remove：同一次写入里两者都必须更新
        let mut index = index_of(&[("笔记/甲.md", "正文 #甲 与 [[乙]]\n"), ("乙.md", "#乙\n")]);

        assert_eq!(index.tags_of("笔记/甲.md").len(), 1);
        assert_eq!(index.tag_count(), 2);
        assert_eq!(index.notes_with_tag("#甲"), vec!["笔记/甲.md".to_string()]);
        assert_eq!(index.stats().tags, 2);
        assert_eq!(index.stats().links, 1, "标签不影响链接统计");

        // 保存后改了标签 → 旧键消失、新键立刻可查（"编辑笔记加标签，面板立刻能看到"的前提）
        index.upsert("笔记/甲.md", "换成了 #新标签\n");
        assert!(
            index.notes_with_tag("甲").is_empty(),
            "旧标签必须随重算一起消失"
        );
        assert_eq!(
            index.notes_with_tag("新标签"),
            vec!["笔记/甲.md".to_string()]
        );

        // 删除 → 标签与链接一起清掉
        index.remove("笔记/甲.md");
        assert!(index.tags_of("笔记/甲.md").is_empty());
        assert!(index.notes_with_tag("新标签").is_empty());
        assert_eq!(index.tag_count(), 1, "只剩 乙.md 的 #乙");
        assert_eq!(index.stats().links, 0);

        // 重扫（clear）后标签也清空，不会留下上一轮 Vault 的标签
        index.clear();
        assert_eq!(index.tag_count(), 0);
        assert!(index.tag_summary().is_empty());
    }

    #[test]
    fn build_index_collects_tags_from_disk() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("甲.md"),
            "---\ntags: [项目/甲]\n---\n\n正文 #行内\n",
        )
        .unwrap();
        std::fs::write(dir.path().join("乙.md"), "正文 #行内 与 #其它\n").unwrap();
        std::fs::write(dir.path().join("图.png"), "binary").unwrap();

        let entries = vec![note("甲.md"), note("乙.md")];
        let (index, _) = build_index(
            dir.path(),
            &entries,
            &BuildOptions::default(),
            None,
            |_done, _total| {},
        );

        let summary = index.tag_summary();
        assert_eq!(summary.len(), 3, "项目/甲、行内、其它：{summary:?}");
        let shared = summary.iter().find(|item| item.key == "行内").unwrap();
        assert_eq!(shared.count, 2, "两篇都有 #行内");
        assert_eq!(
            index.notes_with_tag("行内"),
            vec!["乙.md".to_string(), "甲.md".to_string()],
            "按路径字典序"
        );
        assert_eq!(index.tags_of("甲.md")[0].tag, "项目/甲");
    }

    #[test]
    fn builds_from_disk_and_reports_outcome() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("甲.md"), "# 甲\n\n[[乙]]\n").unwrap();
        std::fs::write(dir.path().join("乙.md"), "# 乙\n\n[[丙]]\n").unwrap();
        std::fs::write(dir.path().join("图.png"), "binary").unwrap();

        let entries = vec![note("甲.md"), note("乙.md")];
        let (mut index, outcome) = build_index(
            dir.path(),
            &entries,
            &BuildOptions::default(),
            None,
            |_done, _total| {},
        );

        assert_eq!(outcome.indexed, 2);
        assert!(!outcome.cancelled);
        assert_eq!(index.len(), 2);
        assert_eq!(index.backlinks_of("乙.md").len(), 1);
        // 丙 不存在 → 悬空
        let stats = index.stats();
        assert_eq!(stats.links, 2);
        assert_eq!(stats.resolved, 1);
        assert_eq!(stats.unresolved, 1);
    }

    #[test]
    fn build_indexes_fills_the_search_index_in_the_same_pass() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("甲.md"), "hello world\n第二行关键词\n").unwrap();
        std::fs::write(dir.path().join("乙.md"), "关键词 也在\n").unwrap();
        let entries = vec![note("甲.md"), note("乙.md")];

        let search = SearchIndex::open_in_memory().unwrap();
        let (index, outcome) = build_indexes(
            dir.path(),
            &entries,
            &BuildOptions::default(),
            None,
            Some(&search),
            |_done, _total| {},
        );

        let search_outcome = outcome.search.expect("这轮建了搜索索引");
        assert!(!search_outcome.aborted, "{search_outcome:?}");
        assert_eq!(search_outcome.lines, 3, "每篇 2 / 1 行");
        assert_eq!(index.len(), 2, "链接索引不受影响");
        assert_eq!(search.search("关键词", 10).unwrap().total, 2);
        assert_eq!(search.search("hello", 10).unwrap().hits[0].line, 1);

        // 没给搜索索引时，结果里不该出现 search 字段
        let (_, plain) = build_index(
            dir.path(),
            &entries,
            &BuildOptions::default(),
            None,
            |_, _| {},
        );
        assert!(plain.search.is_none());
    }

    #[test]
    fn cancelled_build_rolls_the_search_index_back() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("甲.md"), "关键词\n").unwrap();
        let entries = vec![note("甲.md")];
        let search = SearchIndex::open_in_memory().unwrap();

        // 第一轮：正常建好
        let (_, first) = build_indexes(
            dir.path(),
            &entries,
            &BuildOptions::default(),
            None,
            Some(&search),
            |_, _| {},
        );
        assert!(!first.search.unwrap().aborted);
        assert_eq!(search.search("关键词", 10).unwrap().total, 1);

        // 第二轮：一开始就取消 → 回滚，库里仍是上一轮**完整**的内容（不是空的，也不是半截的）
        let cancel = AtomicBool::new(true);
        let (_, second) = build_indexes(
            dir.path(),
            &entries,
            &BuildOptions::default(),
            Some(&cancel),
            Some(&search),
            |_, _| {},
        );
        let cancelled = second.search.unwrap();
        assert!(cancelled.aborted);
        assert_eq!(cancelled.lines, 0);
        assert!(second.cancelled);
        assert_eq!(
            search.search("关键词", 10).unwrap().total,
            1,
            "取消不能让搜索索引变空或半截"
        );
    }

    ///
    /// 运行：`cargo test -p mn-index --release -- --ignored --nocapture bench_build_index_10k_notes`
    ///
    /// 同时分别打印 `extract_links` / `extract_tags` 各自跑 1 万遍的耗时 ——
    /// 那是"给索引加标签"这件事的真实增量成本（扫描本身的预算见 mn-core 的 bench）。
    #[test]
    #[ignore]
    fn bench_build_index_10k_notes() {
        let dir = tempfile::tempdir().unwrap();
        let body = "---\ntags: [项目/甲, 乙]\n---\n\n正文 #行内 与 [[另一篇]] 结束\n";
        for d in 0..100 {
            let sub = dir.path().join(format!("dir{d:03}"));
            std::fs::create_dir_all(&sub).unwrap();
            for f in 0..100 {
                std::fs::write(sub.join(format!("note{f:03}.md")), body).unwrap();
            }
        }
        let entries: Vec<EntryMeta> = (0..100)
            .flat_map(|d| (0..100).map(move |f| note(&format!("dir{d:03}/note{f:03}.md"))))
            .collect();

        let (mut index, outcome) = build_index(
            dir.path(),
            &entries,
            &BuildOptions::default(),
            None,
            |_done, _total| {},
        );

        let started = Instant::now();
        let mut links = 0usize;
        for _ in 0..10_000 {
            links += extract_links(body).len();
        }
        let links_ms = started.elapsed().as_millis();

        let started = Instant::now();
        let mut tags = 0usize;
        for _ in 0..10_000 {
            tags += mn_core::extract_tags(body).len();
        }
        let tags_ms = started.elapsed().as_millis();

        let stats = index.stats();
        eprintln!(
            "build_index 1 万笔记：{} ms（索引 {} 篇 / {} 链接 / {} 反链 / {} 个标签）\n\
             纯解析 1 万遍：extract_links {} ms（{} 条），extract_tags {} ms（{} 条）",
            outcome.duration_ms,
            outcome.indexed,
            stats.links,
            stats.backlink_entries,
            stats.tags,
            links_ms,
            links,
            tags_ms,
            tags
        );
        // 建索引含 1 万次小文件读 + fsync 之后的元数据，放宽到 8s 只用来挡住"灾难性回退"
        assert!(
            outcome.duration_ms <= 8_000,
            "索引构建耗时超回归阈值：{}ms",
            outcome.duration_ms
        );
    }

    /// 性能基准：1 万笔记 / 每篇 30 行的**全文搜索**构建与查询耗时。
    ///
    /// 运行：`cargo test -p mn-index --release -- --ignored --nocapture bench_full_text_search_10k_notes`
    ///
    /// 同一份数据连建两轮（不带搜索 / 带搜索），差值就是"全文搜索这一路"的真实成本。
    #[test]
    #[ignore]
    fn bench_full_text_search_10k_notes() {
        let dir = tempfile::tempdir().unwrap();

        for d in 0..100 {
            let sub = dir.path().join(format!("dir{d:03}"));
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
                    // 只有极少数笔记才有的稀有词：代表"一次真实查询"（命中几十条）
                    body.push_str("这里有一个稀有的词：独角鲸\n");
                }
                body.push_str(&format!("末尾一行 [[note{f:03}]]\n"));
                std::fs::write(sub.join(format!("note{f:03}.md")), body).unwrap();
            }
        }
        let entries: Vec<EntryMeta> = (0..100)
            .flat_map(|d| (0..100).map(move |f| note(&format!("dir{d:03}/note{f:03}.md"))))
            .collect();
        let options = BuildOptions::default();

        // 第一轮：只建链接 + 标签（基线）
        let (_, baseline) = build_index(dir.path(), &entries, &options, None, |_, _| {});

        // 第二轮：同一批文件，顺带建全文搜索索引
        let db_path = dir.path().join(".mimenote/cache/search.db");
        let search = SearchIndex::open_for_rebuild(&db_path).unwrap();
        let (_, with_search) = build_indexes(
            dir.path(),
            &entries,
            &options,
            None,
            Some(&search),
            |_, _| {},
        );
        let search_outcome = with_search.search.unwrap();
        let counts = search.counts().unwrap();
        let db_bytes = std::fs::metadata(&db_path)
            .map(|meta| meta.len())
            .unwrap_or(0);

        eprintln!(
            "1 万笔记 / 每篇 30 行（共 {} 行）：\n\
             \x20 链接+标签（基线）：{} ms\n\
             \x20 全文搜索（同一次遍历里顺带建）：{} ms（库 {:.1} MB）\n\
             \x20 合计：{} ms",
            counts.lines,
            baseline.duration_ms,
            search_outcome.duration_ms,
            db_bytes as f64 / 1_048_576.0,
            with_search.duration_ms
        );

        for query in ["独角鲸", "关键词", "全文搜索", "search", "关键"] {
            let started = Instant::now();
            let outcome = search.search(query, 50).unwrap();
            eprintln!(
                "  查询 {query:?}：{} ms（total={}，返回 {} 条）",
                started.elapsed().as_millis(),
                outcome.total,
                outcome.hits.len()
            );
        }
        let started = Instant::now();
        for _ in 0..20 {
            search.search("关键词", 50).unwrap();
        }
        eprintln!(
            "  查询 \"关键词\" × 20 次平均：{:.2} ms",
            started.elapsed().as_secs_f64() * 1000.0 / 20.0
        );

        assert!(
            search_outcome.lines > 100_000,
            "行数不对：{}",
            search_outcome.lines
        );
        assert!(!search_outcome.aborted);
    }

    /// 性能基准：**长期只走增量**的缓存库会攒下多少段，`optimize` 能回收多少。
    ///
    /// 运行：`cargo test -p mn-index --release -- --ignored --nocapture bench_optimize_after_incremental`
    ///
    /// 为什么值得单独量：全量重建在 `finish_rebuild` 里自带一次 `optimize`，而**日常路径是增量**
    /// ——打开 Vault 只重写改过的那几篇、保存一篇只 `upsert_note` 一篇，而 FTS5 的删除是
    /// **打墓碑**，空间要等段合并才回收。作者的真实 Vault（50 万行）里实测到 2669 个段、
    /// 7326 个数据块、207 MB，所以"跑一段时间之后补一次 optimize 值不值"是个有真实语料背景的问题。
    ///
    /// 基准做的事：建 1 万篇 / 30 万行的库 → 跑 20 轮增量（每轮改 200 篇，模拟"用一阵子"）→
    /// 量 optimize 前后的**库大小**与**查询耗时**，并打印 optimize 自己的耗时（那是它的代价）。
    #[test]
    #[ignore]
    fn bench_optimize_after_incremental() {
        let dir = tempfile::tempdir().unwrap();
        for d in 0..100 {
            let sub = dir.path().join(format!("dir{d:03}"));
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
                body.push_str(&format!("末尾一行 [[note{f:03}]]\n"));
                std::fs::write(sub.join(format!("note{f:03}.md")), body).unwrap();
            }
        }
        let entries: Vec<EntryMeta> = (0..100)
            .flat_map(|d| (0..100).map(move |f| note(&format!("dir{d:03}/note{f:03}.md"))))
            .collect();

        let db_path = dir.path().join(".mimenote/cache/search.db");
        let search = SearchIndex::open_for_rebuild(&db_path).unwrap();
        let (_, built) = build_indexes(
            dir.path(),
            &entries,
            &BuildOptions::default(),
            None,
            Some(&search),
            |_, _| {},
        );

        let size_mb = |path: &std::path::Path| {
            std::fs::metadata(path).map(|m| m.len()).unwrap_or(0) as f64 / 1_048_576.0
        };
        let segments = || search.segment_count().unwrap_or(0);

        let query_ms = |query: &str| {
            let started = Instant::now();
            let rounds = 20;
            for _ in 0..rounds {
                let _ = search.search(query, 50).unwrap();
            }
            started.elapsed().as_secs_f64() * 1000.0 / f64::from(rounds)
        };

        eprintln!(
            "全量重建后：{:.1} MB（段 {}，查询 {:.2} ms；全文搜索这一路 {} ms，共 {} 行）",
            size_mb(&db_path),
            segments(),
            query_ms("关键词"),
            built.search.map(|s| s.duration_ms).unwrap_or(0),
            search.counts().map(|c| c.lines).unwrap_or(0)
        );

        // 20 轮增量：每轮把 200 篇的正文换掉（路径不变、内容不同 —— 这正是"编辑一篇笔记"）
        const ROUNDS: usize = 20;
        const PER_ROUND: usize = 200;
        for round in 0..ROUNDS {
            for i in 0..PER_ROUND {
                let index = round * PER_ROUND + i;
                let (d, f) = (index % 100, (index / 100) % 100);
                let rel = format!("dir{d:03}/note{f:03}.md");
                let mut body = String::new();
                for line in 1..=29 {
                    body.push_str(&format!(
                        "第 {line} 行：第 {round} 轮改过的正文，中文内容与英文 search 混排\n"
                    ));
                }
                body.push_str("这一行里有关键词，别的行没有\n");
                search.upsert_note(&rel, &body).unwrap();
            }
            if round % 5 == 4 {
                eprintln!(
                    "  第 {} 轮增量后：{:.1} MB，段 {}，查询 {:.2} ms",
                    round + 1,
                    size_mb(&db_path),
                    segments(),
                    query_ms("关键词")
                );
            }
        }

        let before_size = size_mb(&db_path);
        let before_segments = segments();
        let before_query = query_ms("关键词");
        let started = Instant::now();
        search.optimize().unwrap();
        let optimize_ms = started.elapsed().as_millis();
        let after_size = size_mb(&db_path);
        let after_segments = segments();
        let after_query = query_ms("关键词");

        eprintln!(
            "{ROUNDS} 轮增量（每轮 {PER_ROUND} 篇）之后：\n\
             \x20 optimize 前：{before_size:.1} MB，段 {before_segments}，查询平均 {before_query:.2} ms\n\
             \x20 optimize 后：{after_size:.1} MB，段 {after_segments}，查询平均 {after_query:.2} ms\n\
             \x20 optimize 自身耗时：{optimize_ms} ms（文件大小变化 {:.1} MB，{:.1}%；查询 {:.2}×）",
            before_size - after_size,
            (before_size - after_size) / before_size * 100.0,
            before_query / after_query
        );

        // optimize 只该让库变小或持平，且查询不该因此变慢（这是"值不值得做"的底线）
        assert!(
            after_size <= before_size + 0.5,
            "optimize 之后库变大了：{before_size:.1} → {after_size:.1} MB"
        );
        assert!(
            after_query <= before_query * 1.5 + 0.5,
            "optimize 之后查询变慢了：{before_query:.2} → {after_query:.2} ms"
        );
    }

    #[test]
    fn build_can_be_cancelled() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..20 {
            std::fs::write(dir.path().join(format!("n{i}.md")), "# x").unwrap();
        }
        let entries: Vec<EntryMeta> = (0..20).map(|i| note(&format!("n{i}.md"))).collect();
        let cancel = AtomicBool::new(true); // 一开始就取消

        let (index, outcome) = build_index(
            dir.path(),
            &entries,
            &BuildOptions::default(),
            Some(&cancel),
            |_done, _total| {},
        );
        assert!(outcome.cancelled);
        assert_eq!(index.len(), 0);
    }

    // -----------------------------------------------------------------------
    // 跨会话复用（ADR-0014）
    // -----------------------------------------------------------------------

    /// 写一篇笔记并返回按**磁盘真实元数据**造的条目（增量判定看的就是它，假值测不出东西）。
    fn write_note(root: &Path, rel: &str, text: &str) -> EntryMeta {
        let path = root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&path, text).unwrap();
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

    #[test]
    fn an_unchanged_vault_reads_no_note_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let entries = vec![
            write_note(root, "甲.md", "---\ntitle: 甲\n---\n见 [[乙]] 与 #标签甲\n"),
            write_note(root, "子/乙.md", "正文 #共享\n[去](甲.md)\n"),
        ];

        // 库在内存里：同一个实例连建两轮，就是"同一个 Vault 打开两次"
        let search = SearchIndex::open_in_memory().unwrap();

        reset_note_reads();
        let (first, outcome) = build_indexes(
            root,
            &entries,
            &BuildOptions::default(),
            None,
            Some(&search),
            |_, _| {},
        );
        assert_eq!(first.len(), 2);
        assert_eq!(outcome.reused_notes, 0, "第一次打开只能读文件");
        assert_eq!(note_reads(), 2, "首轮必须读这两篇");

        // 第二轮：一个文件都不该读，索引内容却要一字不差
        reset_note_reads();
        let (second, outcome) = build_indexes(
            root,
            &entries,
            &BuildOptions::default(),
            None,
            Some(&search),
            |_, _| {},
        );
        assert_eq!(note_reads(), 0, "Vault 没变时不许读任何笔记文件");
        assert_eq!(outcome.reused_notes, 2);
        assert_eq!(outcome.indexed, 2);
        assert_eq!(outcome.skipped, 0);
        assert!(
            second.has_store(),
            "复用之后要挂上写穿透，不然下一次保存跟不上"
        );

        let mut first = first;
        let mut second = second;
        for (rel, links) in [("甲.md", 1), ("子/乙.md", 1)] {
            assert_eq!(
                second.note_links(rel).outbound,
                first.note_links(rel).outbound
            );
            assert_eq!(links, second.note_links(rel).outbound.len());
        }
        assert_eq!(second.title_of("甲.md"), Some("甲"));
        assert_eq!(second.backlinks_of("乙.md"), first.backlinks_of("乙.md"));
        assert_eq!(second.tag_summary(), first.tag_summary());
        assert_eq!(second.notes_with_tag("共享").len(), 1);
        assert_eq!(
            second.graph_data(graph::MAX_GRAPH_NODES).nodes,
            first.graph_data(graph::MAX_GRAPH_NODES).nodes
        );
        assert_eq!(second.stats(), first.stats());
    }

    #[test]
    fn a_missing_payload_falls_back_to_reading_that_note() {
        // 库里少一份数据（理论上不会发生）时不许"装作没事"：这一篇退回读文件，其余照常复用
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let entries = vec![
            write_note(root, "甲.md", "见 [[乙]]\n"),
            write_note(root, "乙.md", "# 乙\n"),
        ];
        let db = root.join(".mimenote/cache/search.db");
        let search = SearchIndex::open(&db).unwrap();
        let (_, first) = build_indexes(
            root,
            &entries,
            &BuildOptions::default(),
            None,
            Some(&search),
            |_, _| {},
        );
        assert_eq!(first.reused_notes, 0);

        // 手动抹掉乙的凭证行（模拟"落盘数据丢了、但判定键还在"：那正是会复用出空索引的状态）
        let raw = rusqlite::Connection::open(&db).unwrap();
        raw.execute("DELETE FROM link_notes WHERE path = '乙.md'", [])
            .unwrap();
        drop(raw);

        reset_note_reads();
        let (mut rebuilt, outcome) = build_indexes(
            root,
            &entries,
            &BuildOptions::default(),
            None,
            Some(&search),
            |_, _| {},
        );
        assert_eq!(note_reads(), 1, "只有丢了数据的那一篇要重读");
        assert_eq!(outcome.reused_notes, 1);
        assert_eq!(rebuilt.len(), 2);
        assert!(rebuilt.contains("乙.md"));
        assert_eq!(
            rebuilt.backlinks_of("乙.md").len(),
            1,
            "重读出来的反链是对的"
        );
    }

    #[test]
    fn a_degraded_build_without_a_cache_keeps_working() {
        // 没给搜索索引（缓存库不可用）时：索引照常建出来，只是没有复用，也没有写穿透
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let entries = vec![
            write_note(root, "甲.md", "见 [[乙]]\n"),
            write_note(root, "乙.md", ""),
        ];

        reset_note_reads();
        let (mut index, outcome) =
            build_index(root, &entries, &BuildOptions::default(), None, |_, _| {});
        assert_eq!(note_reads(), 2);
        assert_eq!(outcome.reused_notes, 0);
        assert!(!index.has_store());
        assert_eq!(index.backlinks_of("乙.md").len(), 1);
    }
}
