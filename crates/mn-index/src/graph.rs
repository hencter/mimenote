//! 知识图谱：把链接索引里的「笔记 + 链接」一次性摊平成前端卡片画布要用的节点与边。
//!
//! 为什么落在索引层（`docs/architecture.md` §2 第 2 条）：去重、度数、截断、排序都是
//! **业务规则**，而且必须与索引用同一套解析规则 —— 图谱里的一条边与反链面板看到的是同一次
//! 解析结果，不会出现"面板能解析、图谱却悬空"这种最难查的不一致。宿主只负责取锁与搬运。
//!
//! 四个刻意的口径（前端按这些口径画图，**不要二次推断**）：
//!
//! 1. **边按 `(from, to)` 去重**：一对笔记之间写 3 条 `[[乙]]` 只产生 1 条边、`count = 3`。
//!    合并后一条边只留一个 `kind` 与一个 `toRawTarget`：都取文档里**首次出现**的那条链接的
//!    写法（`count` 仍累计全部）。悬空边没有目标笔记，`toRawTarget` 就是画布上唯一能显示
//!    "指向谁"的信息；同一篇里指向不同不存在目标的链接会合并成同一条边、只留下第一条的写法
//!    （契约里 `toRelPath: null` 不携带目标，这是合并口径的必然结果，不是实现疏漏）；
//! 2. **度数按去重后的边计**：`outDegree` = 从该笔记出发的边条数，`inDegree` = 指向它的边条数。
//!    这样卡片上的数字与画布上真实画出的线数一致（`[[甲]] [[甲]] [[甲]]` 只算 1 度）；
//! 3. **悬空边不计入任何节点的 `inDegree`**（它没有目标节点，画布上只画成断头线）；
//! 4. **自链接算一条边**（`[[#小节]]`、`[[自己]]`）：同时计入出度与入度。这里不过滤
//!    （反链面板过滤自引用是 UI 噪音考虑，图谱里自环是有意义的），要不要画成自环由前端决定。
//!
//! ## 截断
//!
//! 节点数超过 [`MAX_GRAPH_NODES`] 时：先算**全图**度数 → 取度数（in + out）最高的 N 个节点
//! → 只保留"两端都在保留集合里"的边（悬空边照旧保留）→ `truncated = true`。
//!
//! 注意"先算全图度数"这个顺序：截断后某个节点的 `outDegree` 可能大于它在 `edges` 里能看到的
//! 线数。这是**刻意的** —— 度数表达"这篇笔记在全库里有多连通"，而不是"这次返回了多少条边"；
//! 前端给出"数据已截断"提示时按此解释。
//!
//! ## 自我中心子图（ego graph）
//!
//! [`LinkIndex::ego_graph`] 是同一份口径上的**子集投影**：以某一篇笔记为中心，沿链接**双向**
//! （出链 + 反链）走 `depth` 跳，只把能到达的笔记交出去，形状与 [`GraphData`] 完全一样。
//!
//! 为什么不在 `graph_data` 的结果上做 BFS（前端自己筛）：`graph_data` 会在大 Vault 上按度数
//! 截断（[`MAX_GRAPH_NODES`]），从那批数据里走出来的"邻居"**可能根本不完整** —— 用户看到的是
//! "这篇只连着 3 篇"，而真相是"另外 7 篇被截断掉了"。邻接只有索引知道，所以 BFS 必须发生在
//! 把节点筛掉**之前**，也就是必须落在这里。
//!
//! 三条与全图不同的口径，都是"以某篇为中心"这个视角带来的：
//!
//! 1. **起点永远在结果里**（哪怕它一条链接都没有）—— 圆心不在图上，环就无从画起；
//! 2. **截断按"离起点近优先 → 同层度数（in + out）降序 → 路径字典序"**。距离是排序的**主键**，
//!    于是"被留下的节点，它的 BFS 父节点必然也被留下"（父节点距离更小 ⇒ 排在前面）：子图永远
//!    连通，前端从圆心出发就能走遍每一个节点（`layout-ego.ts` 里那个"正常不该发生"的
//!    `unreachable` 依靠的正是这一条）。要浮到界面上的是 `truncated`，**不是**静默少画几张卡片；
//! 3. **悬空边只保留起点自己发出的那些**：别的节点的悬空边属于它们各自的视角，画在这个子图里
//!    就是一条从某张卡片通向画布外的虚线（点不到、也解释不清）。
//!
//! 起点不在索引里（路径还没被收录）→ 空结果、`truncated = false`、**不报错**：调用方在"刚打开
//! Vault、当前笔记还没进索引"时就会走到这里，报错会把"索引正在构建"变成一条吓人的红色提示；
//! 与 [`LinkIndex::graph_data`] 一样，这种情况**不新增**任何一种错误码。
//!
//! ### 为什么走两趟
//!
//! 选点要先知道"谁连着谁"，而这份关系只有把全库链接解析一遍才拿得到 —— 索引里没有现成的反向
//! 表：反链缓存是按"某篇的反链"组织的、还刻意排除了自引用（见 [`crate::LinkIndex::referrers_of`]），
//! 拿它当邻接表等于在"邻居怎么算"上引入第二套规则。所以：第一趟扫全库，只收"全库度数 + 邻接表"；
//! 选点之后第二趟只为选中的那几十/几百篇构造节点元数据与边。两趟**共用同一段组装代码**
//! （[`Scope`] 只决定"这一趟要构造什么"），因此不存在两份口径；省下来的是上万篇没人看的笔记的
//! 标题/标签/文件夹字符串，以及画布上根本不会出现的那些边。
//!
//! 代价同样要写清楚：**入度只能按全库算**（度数表达"这篇笔记在全库里有多连通"，与
//! `graph_data` 的截断口径同源），所以每次调用都会解析一遍全库链接。实测（1 万笔记 / 2 万条
//! 链接，release）：自我中心子图 ≈50–60 ms、全图 `graph_data` ≈70–80 ms，其中纯链接解析
//! ≈20 ms —— 换句话说，选点（BFS）与"只构造子集"在这个量级上已经可以忽略。
//! 这就是"毫秒级"在这里的全部含义 —— **纯内存遍历，一个文件都不读**；要让这个数字再降一个
//! 量级，得把度数缓存进索引并在 `upsert`/`remove` 里增量维护，而"别人新建一篇笔记就能让原先
//! 悬空的链接变得可解析"意味着那套缓存还得处理失效，远比这几十毫秒贵。
//!
//! 本模块**不做任何文件 IO**：节点来自索引收录的笔记，标题优先用索引里记下的 frontmatter
//! `title`（`LinkIndex::upsert` 时顺手解析，见 [`crate::LinkIndex::title_of`]），
//! 没有就退回文件名主干。因此 1 万笔记下这个命令也只有内存遍历。自我中心子图的 BFS 同理：
//! 它的邻接表是从**同一批解析结果**现建出来的（出链 + 反链两个方向），中途不读任何文件，
//! 也不把链接重新解析第二遍以上（第一趟全库解析一次；第二趟只为子集里那几篇再解析一次，
//! 因为第一趟把"用不上的对"的边信息丢掉了 —— 留着它才是真正的浪费）。

use std::collections::{hash_map::Entry, HashMap, HashSet};
use std::time::Instant;

use serde::Serialize;

use mn_core::links::LinkKind;

use crate::LinkIndex;

/// 默认节点上限：超过就只返回度数最高的一部分，并置 `truncated = true`。
///
/// 上限放在索引层（而不是前端）是为了让**报文体积有硬上限**，而不是因为画布画不动：
/// 画布按视口裁剪，一帧只挂载几十张卡片，实测 1 万节点的布局 46 ms、裁剪 0.09 ms/帧。
///
/// 8000 是从"真实 Vault 会多大"倒推的：几千篇的 Vault 很常见（本项目手工验收用的真实
/// Vault 是 3985 篇），而 3000 的旧上限会把它**截断掉四分之一** —— 用户看到的是"图谱不全"，
/// 却不一定注意到那行被截断的提示。8000 时的报文约 0.8–1.0 MB（实测 1 万节点 / 2 万条链接
/// ≈ 1.0 MB），一次 IPC 的量级仍然可接受。再往上（几万篇）就该换成分页/按需拉取，
/// 而不是继续抬高这个常量。
pub const MAX_GRAPH_NODES: usize = 8000;

/// 单个节点最多带几个标签。
///
/// 画布上的卡片放不下更多，而且这是 1 万笔记报文里最容易被忽略的体积来源
/// （每篇多带 10 个标签 ≈ 多 200KB）。需要完整标签列表的场景用 `tags_list` / `tag_notes`。
pub const MAX_GRAPH_TAGS: usize = 8;

/// 自我中心子图允许的最大跳数。
///
/// 5 跳是从"环还看得清"倒推的：同心环每一跳占一圈，第 5 环上的卡片已经要缩到读不出标题。
/// 更深的关联不该靠继续加半径解决，而是让用户点中心旁边那篇笔记、以它为圆心重取一次
/// （重取一次的成本就是下面那段两趟扫描：纯内存、无文件 IO）。上限写在这一层（而不是前端）
/// 是为了让**归一化只有一处**：宿主与前端不会各自夹一个不同的范围，然后"传 9 到底走几跳"
/// 取决于谁先夹。
pub const MAX_EGO_DEPTH: u32 = 5;

/// 自我中心子图的缺省跳数：只给"直接相关"的那一圈（出链 + 反链）。
///
/// 缺省值定在这里、由宿主转发，理由与 [`MAX_EGO_DEPTH`] 相同：前端可以不传 `depth`，
/// 但"不传时走几跳"必须只有一个答案。
pub const DEFAULT_EGO_DEPTH: u32 = 1;

/// 自我中心子图的缺省节点上限。
///
/// 80 ≈ "圆心 + 一两圈"的量级：自我中心视图是给"读着这一篇时顺手看关联"用的，超过这个数
/// 已经超出"一眼看得完"，而重取一次（换中心或加 `depth`）比在一屏里塞 300 张卡片更接近用户
/// 想做的事。真正的硬上限是 [`MAX_EGO_NODES`]（前端显式传 `maxNodes` 时用它）。
pub const DEFAULT_EGO_MAX_NODES: usize = 80;

/// 自我中心子图的节点上限。
///
/// 与 [`MAX_GRAPH_NODES`]（8000，全库视图）差一个数量级是有意的：全库视图的报文是"一次拉全、
/// 反复重画"的，自我中心视图却是**切换笔记就可能重跑**的命令，报文（300 节点 ≈ 几十 KB）
/// 与组装成本都得压住。需要看更多关联时正确的做法是提高 `depth` 或换一个圆心，
/// 而不是把上限抬到和全库一样 —— 那时"以某篇为中心"这个前提也就没有意义了。
pub const MAX_EGO_NODES: usize = 300;

/// 图谱中的一个节点（一篇笔记）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    /// Vault 相对路径（POSIX）。
    pub rel_path: String,
    /// 展示标题：frontmatter 的 `title` 字段优先，否则文件名主干（不含扩展名）。
    pub title: String,
    /// 所在目录（POSIX，Vault 根为 `""`）——前端按它把卡片分组到文件夹容器里。
    pub folder: String,
    /// 该笔记的标签（原始写法，最多 [`MAX_GRAPH_TAGS`] 个）。
    pub tags: Vec<String>,
    /// 出链数（指向其它笔记，含悬空）；口径见模块文档第 2 条。
    pub out_degree: u32,
    /// 入链数（只统计有目标节点的边，悬空边不计入）。
    pub in_degree: u32,
}

/// 图谱中的一条边（一处链接）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    /// 源笔记相对路径。
    pub from_rel_path: String,
    /// 目标笔记；`null` = 悬空链接（目标还不存在）。
    pub to_rel_path: Option<String>,
    /// 链接的**原始目标写法**（已剥离锚点），例如 `[[还不存在的笔记]]` → `还不存在的笔记`。
    /// 悬空边只能靠它显示"指向谁"；解析成功时它同样有意义（用户写的可能和解析结果不同）。
    ///
    /// 口径：一对 `(from, to)` 合并成一条边时，取**第一条**链接的写法（见模块文档第 1 条）。
    ///
    /// 注意纯锚点链接（`[[#小节]]`、`[x](#锚点)`）的原始目标按定义就是空串 —— 它们总是指向
    /// 文件自身、一定能解析出 `toRelPath`，调用方只因悬空边才需要这个名字，因此不需要额外处理。
    pub to_raw_target: String,
    /// 链接类型：复用 `mn_core::links::LinkKind`（`"wiki"` | `"embed"` | `"markdown"`）。
    ///
    /// 合并后的边只保留**首次出现**的那条链接的类型。
    pub kind: LinkKind,
    /// 同一对 `(from, to)` 之间的链接条数（**去重后**的合并结果）。
    pub count: u32,
}

/// 一次交给前端的完整图谱数据。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphData {
    /// 节点（按 `relPath` 字典序，前端不再排序）。
    pub nodes: Vec<GraphNode>,
    /// 边（按 `fromRelPath` → `toRelPath`（`None` 排最后）→ `kind`，前端不再排序）。
    pub edges: Vec<GraphEdge>,
    /// 节点数超过上限时为 `true`（只返回度数最高的一部分）。
    pub truncated: bool,
    /// 遍历索引与组装结果的实测耗时（毫秒）。
    ///
    /// 不含后台线程排队与取索引锁的等待时间；本命令没有任何文件 IO，所以这就是全部成本。
    pub elapsed_ms: u64,
}

/// 一趟组装的产出：[`LinkIndex::graph_data`]（全图）与 [`LinkIndex::ego_graph`]（子图）
/// 共用的中间产物。
///
/// 抽出来只有一条理由：**同一篇笔记在两个视图里的度数/标题/标签/目录必须逐字相同**。
/// 对前端来说 `GraphNode` 就是 `GraphNode`（两种视图共用同一个 DTO 与同一份绘制代码），
/// 各写一份组装代码迟早漂移成"全图说 in=7、自我中心图说 in=3"——那是最难向用户解释、
/// 也最难查的一类不一致，因为两边单看都"像是对的"。
struct GraphParts {
    /// 节点元数据，**按 `relPath` 字典序**（两个调用方都不再排序）；只含本次范围要的节点。
    nodes: Vec<GraphNode>,
    /// 按 `(from, to)` 去重后的边（顺序未定：由调用方用 [`sort_edges`] 排）。
    edges: Vec<GraphEdge>,
    /// 出度表。度数按**全库**算（见模块文档的截断一节）：两个视图共用同一把尺子。
    ///
    /// `Scope::Only` 那一趟是空的（它只走子集里的文件，收不全），由调用方用扫描趟的结果补上。
    out_degree: HashMap<String, u32>,
    /// 入度表（悬空边不计入，见模块文档第 3 条）。口径与置空规则同 [`Self::out_degree`]。
    in_degree: HashMap<String, u32>,
}

/// 一趟组装要哪些节点与边 —— 全图与自我中心子图的差别**只有这一处**，
/// 遍历（解析、去重、度数、`count` 的取值规则）因此仍然只有一份实现。
enum Scope<'a> {
    /// 全图：所有节点与所有边都要，并收集全库度数（[`LinkIndex::graph_data`]）。
    All,
    /// 一个节点、一条边都不要：只要**全库度数**与（按需的）邻接表。
    ///
    /// 自我中心子图的**第一趟**用它。为什么选点之前必须先来一趟这样的扫描：BFS 要在"谁连着谁"
    /// 上走，而这份关系只有遍历全库链接才能得到 —— 于是先用一趟本钱最小的扫描把
    /// "全库度数 + 邻接表"拿到手，再决定哪些节点值得构造。
    Scan,
    /// 只要这些节点，以及两端都在其中的边（自我中心子图的**第二趟**）。
    ///
    /// 这一趟**不走全库**：一条两端都在子集里的边只可能由子集里的笔记发出（子集是 BFS 闭包，
    /// 见 [`LinkIndex::ego_graph`]），所以不在子集里的文件连解析都不必做。
    /// 代价是这一趟收不全全库度数（缺了子集之外指向子集的那些边），度数由第一趟给出。
    Only(&'a HashSet<String>),
}

impl Scope<'_> {
    /// 遍历到这一篇时，它的节点元数据与它发出的边要不要构造。
    fn wants(&self, path: &str) -> bool {
        match self {
            Scope::All => true,
            Scope::Scan => false,
            Scope::Only(kept) => kept.contains(path),
        }
    }

    /// 这条边的目标要不要留在结果里（`None` = 悬空边：它没有目标节点，留不留由调用方再筛）。
    fn wants_target(&self, to: Option<&str>) -> bool {
        match to {
            Some(to) => self.wants(to),
            None => true,
        }
    }

    /// 遍历要不要覆盖全库。
    ///
    /// 这个判断同时决定了两件事，它们其实是同一件事的两面：不覆盖全库的那一趟（`Only`）
    /// 既省下了一遍解析，也**收不全全库度数** —— 调用方必须拿第一趟的度数补上。
    fn whole_library(&self) -> bool {
        !matches!(self, Scope::Only(_))
    }
}

/// "谁连着谁"的邻接表：出链与反链两个方向。
///
/// 只有自我中心子图的选点需要它（BFS 必须**双向**走），而索引里现成的邻接只有出链一个方向，
/// 反链缓存（[`crate::LinkIndex::backlinks_of`]）又是按"某篇的反链"组织的、口径也经过 UI 过滤。
/// 建全表要克隆全库的目标路径，因此全图那条路（`graph_data`）不会构造它。
#[derive(Default)]
struct Adjacency {
    /// `from` → 它的出链目标。
    out: HashMap<String, Vec<String>>,
    /// `to` → 指向它的笔记。
    into: HashMap<String, Vec<String>>,
}

impl Adjacency {
    /// 记一条**去重后的边**的两个方向（调用方保证每个 `(from, to)` 只调一次）。
    ///
    /// 先 `get_mut` 再插入：入度为 1000 的枢纽节点会连续插 1000 个邻居，每次都克隆一遍键
    /// 是白花的分配。
    fn link(&mut self, from: &str, to: &str) {
        match self.out.get_mut(from) {
            Some(neighbours) => neighbours.push(to.to_string()),
            None => {
                self.out.insert(from.to_string(), vec![to.to_string()]);
            }
        }
        match self.into.get_mut(to) {
            Some(sources) => sources.push(from.to_string()),
            None => {
                self.into.insert(to.to_string(), vec![from.to_string()]);
            }
        }
    }
}

impl GraphParts {
    /// 全库度数（in + out）：全图的截断排序与自我中心的选点用的是同一个排序键。
    fn degree_of(&self, path: &str) -> u32 {
        self.out_degree.get(path).copied().unwrap_or(0)
            + self.in_degree.get(path).copied().unwrap_or(0)
    }

    /// 选出自我中心子图的节点（选点 = 自我中心子图的第二步）：从 `root` 出发用 `adjacency`
    /// **双向**走 `depth` 跳，按"距离升序 → 同层度数降序 → 路径字典序"取前 `max_nodes` 个。
    /// 返回 `(路径, 是否被截断)`。
    ///
    /// 返回 **owned 路径**而不是借用：调用方拿到之后要拿它当范围再组装一趟，
    /// 借用 `self` 里的路径会让借用检查器把这一步拦下来。
    fn select_ego(
        &self,
        adjacency: &Adjacency,
        root: &str,
        depth: u32,
        max_nodes: usize,
    ) -> (Vec<String>, bool) {
        // BFS：出链与反链都算一跳。逐层推进到 `depth` 为止 —— 距离就是"第几环"，
        // 也是下面排序的主键。悬空边不在邻接表里（它连不上任何一篇笔记），因此不会出现
        // "走到一条边却没有对面节点"的情况。
        let mut distance: HashMap<&str, u32> = HashMap::new();
        distance.insert(root, 0);
        let mut frontier: Vec<&str> = vec![root];
        for hop in 1..=depth {
            let mut next: Vec<&str> = Vec::new();
            for node in &frontier {
                let neighbours = adjacency
                    .out
                    .get(*node)
                    .into_iter()
                    .flatten()
                    .chain(adjacency.into.get(*node).into_iter().flatten())
                    .map(String::as_str);
                for neighbour in neighbours {
                    // 已访问过就不再改距离：BFS 先到的那次一定是最短路
                    if let Entry::Vacant(slot) = distance.entry(neighbour) {
                        slot.insert(hop);
                        next.push(neighbour);
                    }
                }
            }
            if next.is_empty() {
                break; // 已经走不动了（或整块图就这么大）：再深的 hop 都是空转
            }
            frontier = next;
        }

        // 排序：**距离是主键**。这保证了"被留下的节点，它的 BFS 父节点必然也被留下"
        // （父节点距离更小 ⇒ 一定排在它前面），于是截断后的子图仍然连通 —— 前端从圆心出发
        // 就能走遍每一个节点。若把度数放在第一级，"留下了一个二跳节点、却丢掉了它的父节点"
        // 就会真的发生：画面上会出现一张没有任何连线的孤立卡片。
        let mut ranked: Vec<(&str, u32)> = distance.into_iter().collect();
        ranked.sort_by(|a, b| {
            a.1.cmp(&b.1)
                .then_with(|| self.degree_of(b.0).cmp(&self.degree_of(a.0)))
                .then_with(|| a.0.cmp(b.0))
        });

        let truncated = ranked.len() > max_nodes;
        ranked.truncate(max_nodes);
        (
            ranked
                .into_iter()
                .map(|(path, _)| path.to_string())
                .collect(),
            truncated,
        )
    }
}

impl LinkIndex {
    /// **唯一一处**遍历索引里的链接并记账的实现：节点元数据、去重后的边、度数、邻接表。
    ///
    /// 两个视图（全图 / 自我中心子图）的差别全部收在 [`Scope`] 里，而不是各写一份组装 ——
    /// `(from, to)` 去重、`count` 的累计、`kind` / `toRawTarget` 取第一条、度数按去重后的边算、
    /// 悬空边只计出度……这些规则只要有两份实现，迟早会在同一篇笔记上给出两个答案。
    ///
    /// `want_adjacency` 决定要不要顺手建邻接表：只有自我中心子图的第一趟要它
    /// （选点必须走在"谁连着谁"上），而全图那条路不该为一个用不上的表克隆全库的目标路径。
    fn assemble(&self, scope: &Scope<'_>, want_adjacency: bool) -> (GraphParts, Adjacency) {
        // 节点来源 = 索引收录的笔记（`build_index` 只把 `.md` / `.markdown` 且这一轮读成功的
        // 文件放进来）。先排好序：节点输出顺序就是契约要求的顺序，前端不再排一次。
        let mut paths: Vec<&str> = self.files.keys().map(String::as_str).collect();
        paths.sort_unstable();
        if !scope.whole_library() {
            // 只要子集：不在子集里的笔记连链接都不必解析（理由见 `Scope::Only`）。
            // `retain` 保序，因此节点顺序仍是字典序。
            paths.retain(|path| scope.wants(path));
        }

        let mut out_degree: HashMap<String, u32> = HashMap::new();
        let mut in_degree: HashMap<String, u32> = HashMap::new();
        let mut edges: Vec<GraphEdge> = Vec::new();
        let mut adjacency = Adjacency::default();

        for from in &paths {
            let Some(links) = self.files.get(*from) else {
                continue;
            };
            let emit = scope.wants(from);
            // 这一篇内部的去重表：（目标 → 那一条边，或"只为度数记一笔"）。
            // 每个 `(from, to)` 只记一次，因此 `count` 的累计与度数的累加天然都是"去重后的边"；
            // 而"首次出现的写法胜出"依赖文档内顺序 —— 表只活在这一篇里，下一篇开始时丢弃，
            // 所以内存只与单篇的链接数有关，与全库规模无关。
            let mut pairs: HashMap<Option<String>, PairSlot> = HashMap::new();
            for link in links {
                let (to, _ambiguous) = self.resolve_target(from, &link.raw_target);
                match pairs.entry(to) {
                    // 已有一条同 (from, to) 的边：只累加条数，`kind` 与 `toRawTarget`
                    // 保持**第一条**链接的写法（同一对笔记之间的写法差异只保留最早那一种）。
                    // 不为度数记账的对（`DegreesOnly`）第二次出现时什么都不做 —— 它已经算过了。
                    Entry::Occupied(mut occupied) => {
                        if let PairSlot::Edge(edge) = occupied.get_mut() {
                            edge.count += 1;
                        }
                    }
                    Entry::Vacant(vacant) => {
                        // 借 key 拿目标，省一次克隆；度数只在"第一次见到这个对"时各加一笔
                        let target = vacant.key().as_deref();
                        if scope.whole_library() {
                            bump(&mut out_degree, from);
                            if let Some(target) = target {
                                bump(&mut in_degree, target);
                            }
                        }
                        if want_adjacency {
                            if let Some(target) = target {
                                adjacency.link(from, target);
                            }
                        }
                        let slot = if emit && scope.wants_target(target) {
                            PairSlot::Edge(GraphEdge {
                                from_rel_path: (*from).to_string(),
                                to_rel_path: vacant.key().clone(),
                                to_raw_target: link.raw_target.clone(),
                                kind: link.kind,
                                count: 1,
                            })
                        } else {
                            PairSlot::DegreesOnly
                        };
                        vacant.insert(slot);
                    }
                }
            }
            // 这一篇的边一次性收进结果（顺序由调用方统一排，见 [`sort_edges`]）
            for (_, slot) in pairs {
                if let PairSlot::Edge(edge) = slot {
                    edges.push(edge);
                }
            }
        }

        // -- 节点元数据（只含本次范围要的节点，顺序是字典序）------------------------
        let nodes: Vec<GraphNode> = paths
            .iter()
            .copied()
            .filter(|path| scope.wants(path))
            .map(|path| GraphNode {
                rel_path: path.to_string(),
                // frontmatter 的 title 在索引里（upsert 时顺手解析，零额外 IO）；
                // 拿不到才退回文件名主干 —— 为一个标题再读 3000 个文件是笔亏本买卖
                title: self
                    .title_of(path)
                    .map(str::to_string)
                    .or_else(|| crate::stem_of(path))
                    .unwrap_or_else(|| path.to_string()),
                folder: crate::parent_of(path),
                tags: self
                    .tags_of(path)
                    .into_iter()
                    .take(MAX_GRAPH_TAGS)
                    .map(|tag| tag.tag)
                    .collect(),
                out_degree: out_degree.get(path).copied().unwrap_or(0),
                in_degree: in_degree.get(path).copied().unwrap_or(0),
            })
            .collect();

        (
            GraphParts {
                nodes,
                edges,
                out_degree,
                in_degree,
            },
            adjacency,
        )
    }

    /// 组装图谱数据（只读索引，**零文件 IO**）。
    ///
    /// `max_nodes` 是节点上限：生产路径传 [`MAX_GRAPH_NODES`]，单测注入小值来验证截断边界。
    /// 索引为空（正在构建、还没有笔记、Vault 刚打开）时返回空图谱而不是错误 ——
    /// 前端按 `index_status` 决定要不要显示"索引构建中"。
    pub fn graph_data(&self, max_nodes: usize) -> GraphData {
        let started = Instant::now();
        let (mut parts, _adjacency) = self.assemble(&Scope::All, false);

        // -- 截断：按 (in + out) 降序 → relPath 升序，取前 max_nodes 个 --------------
        let truncated = parts.nodes.len() > max_nodes;
        if truncated {
            // 并列时按路径定序：同样的 Vault 得到同样的子集，前端不做二次排序也能稳定复现。
            let mut ranked: Vec<&GraphNode> = parts.nodes.iter().collect();
            ranked.sort_by(|a, b| {
                parts
                    .degree_of(&b.rel_path)
                    .cmp(&parts.degree_of(&a.rel_path))
                    .then_with(|| a.rel_path.cmp(&b.rel_path))
            });
            ranked.truncate(max_nodes);
            // owned key：下面要 `retain` 这两个 Vec，借用 `parts` 里的路径会让借用检查器拦住
            let kept: HashSet<String> = ranked.iter().map(|node| node.rel_path.clone()).collect();

            parts.nodes.retain(|node| kept.contains(&node.rel_path));
            parts.edges.retain(|edge| {
                kept.contains(&edge.from_rel_path)
                    && match edge.to_rel_path.as_deref() {
                        Some(to) => kept.contains(to),
                        // 悬空边照旧保留：全图视角下它是一条合法的断头线（目标还不存在）
                        None => true,
                    }
            });
        }

        sort_edges(&mut parts.edges);

        GraphData {
            nodes: parts.nodes,
            edges: parts.edges,
            truncated,
            elapsed_ms: started.elapsed().as_millis() as u64,
        }
    }

    /// 以 `root_rel_path` 为中心的**自我中心子图**（双向 `depth` 跳，只读索引，**零文件 IO**）。
    ///
    /// 形状与 [`Self::graph_data`] 完全一样（同一个 [`GraphData`]、同一份 `GraphNode`/`GraphEdge`），
    /// 只是节点与边被限制在"从起点走 `depth` 跳能到"的那个子集里。去重、`count`、度数、排序
    /// 等口径**逐条相同** —— 它们来自同一段组装代码（[`LinkIndex::assemble`]，
    /// 差别只是 [`Scope`]），不是两份"看起来一样"的实现。
    ///
    /// 两趟走完（见 [`Scope`] 的文档）：第一趟扫全库拿"全库度数 + 邻接表"并选点，第二趟只为
    /// 选中的子集构造节点与边。**这不是为了省解析**（第一趟已经把全库链接解析了一遍 ——
    /// 入度只能这么来），而是为了不给 9700 篇没人看的笔记拼标题/标签/文件夹字符串，
    /// 也不为看不见的边分配结构：这是"打开某篇笔记就可能跑一次"的命令。
    ///
    /// * `depth` 归一化到 `1..=`[`MAX_EGO_DEPTH`]、`max_nodes` 归一化到 `1..=`[`MAX_EGO_NODES`]
    ///   （缺省值由调用方用 [`DEFAULT_EGO_DEPTH`] / [`DEFAULT_EGO_MAX_NODES`] 传进来）；
    /// * 起点永远在结果里（哪怕它一条链接都没有）：圆心不在图上，环就无从画起；
    /// * 节点数超过 `max_nodes` → 按"离起点近优先 → 同层度数降序 → 路径字典序"取，
    ///   并置 `truncated = true`（**不静默截断**：界面要能如实说出"只显示了最近的一部分"）；
    /// * 起点不在索引里 → 空结果 + `truncated = false`，**不报错**（理由见模块文档）；
    /// * "Vault 没打开"这类**调用方错误不在这里判定**（与 `graph_data` 同一姿态：宿主负责
    ///   `VAULT_NOT_SET`，索引层只回答"索引里有什么"）。
    pub fn ego_graph(&self, root_rel_path: &str, depth: u32, max_nodes: usize) -> GraphData {
        let started = Instant::now();
        // 路径口径与索引一致：宿主可能传来带 `\` 的 Windows 形态，而索引里的键一律是 POSIX
        let root = root_rel_path.replace('\\', "/");
        // 归一化只在这里做一次：越界的值从前端或宿主都可能传进来，而"合法范围是多少"
        // 必须只有一处答案（否则传 9 到底走 5 跳还是 9 跳，取决于谁先夹）
        let depth = depth.clamp(1, MAX_EGO_DEPTH);
        // 下限是 1 而不是 0：`max_nodes = 0` 不能把圆心也截掉（那会画出空画布，看起来像图谱坏了）
        let max_nodes = max_nodes.clamp(1, MAX_EGO_NODES);

        // 起点不在索引里（含"索引还在构建"这个空索引的情形）→ 空结果，不报错。
        // 判定放在扫描**之前**：索引构建期间这个命令会被频繁调用，不必为一次注定为空的查询
        // 先扫一遍全库。
        if !self.files.contains_key(&root) {
            return GraphData {
                nodes: Vec::new(),
                edges: Vec::new(),
                truncated: false,
                elapsed_ms: started.elapsed().as_millis() as u64,
            };
        }

        // -- 第一步：全库扫描（只要度数 + 邻接表），据此选点 --------------------------
        let (scan, adjacency) = self.assemble(&Scope::Scan, true);
        let (kept, truncated) = scan.select_ego(&adjacency, &root, depth, max_nodes);
        let kept: HashSet<String> = kept.into_iter().collect();

        // -- 第二步：只为选中的子集造节点与边 ---------------------------------------
        // 这一趟不走全库（`Scope::Only` 的文档解释了为什么可以），因此它的度数表是残的 ——
        // 度数必须用第一步的**全库**度数：它表达"这篇笔记在全库里有多连通"，
        // 而不是"这个子图里连了几条线"（与 `graph_data` 的截断口径同源）。
        let (mut parts, _no_adjacency) = self.assemble(&Scope::Only(&kept), false);
        parts.out_degree = scan.out_degree;
        parts.in_degree = scan.in_degree;
        // 节点上刻着度数，也要一起回填（第二趟只有子集里的文件，收不全全库度数）。
        // 这一步不能省：前端把度数直接印在卡片上，两个视图里的同一个数字必须一样。
        for node in &mut parts.nodes {
            node.out_degree = parts.out_degree.get(&node.rel_path).copied().unwrap_or(0);
            node.in_degree = parts.in_degree.get(&node.rel_path).copied().unwrap_or(0);
        }

        // 悬空边只保留**起点自己**发出的那些：别人的悬空边属于它们各自的视角，
        // 画在这个子图里就是一条从某张卡片通向画布外的虚线（点不到、也解释不清）。
        // （有目标节点的边在组装时已经按"两端都要在子集里"筛过了。）
        parts
            .edges
            .retain(|edge| edge.to_rel_path.is_some() || edge.from_rel_path == root);

        sort_edges(&mut parts.edges);

        GraphData {
            nodes: parts.nodes,
            edges: parts.edges,
            truncated,
            elapsed_ms: started.elapsed().as_millis() as u64,
        }
    }
}

/// 一度 +1（只在**首次见到某个去重后的 `(from, to)` 对**时调用）。
///
/// 先用 `get_mut` 试、没有再插入：这样每个节点只克隆一次键，而不是每条边克隆一次
/// （1 万笔记的 Vault 上是几万次分配的区别）。
fn bump(counts: &mut HashMap<String, u32>, key: &str) {
    match counts.get_mut(key) {
        Some(count) => *count += 1,
        None => {
            counts.insert(key.to_string(), 1);
        }
    }
}

/// 遍历过程中一个 `(from, to)` 对的记账。见 [`LinkIndex::assemble`] 的去重表。
enum PairSlot {
    /// 这一对要交给前端（带完整的边信息）。
    Edge(GraphEdge),
    /// 这一对只在度数里露过面（自我中心子图里的"外面"），**不构造边**。
    ///
    /// 它必须占一个位置：没有它就没法判断"这个对是不是第一次见到"，
    /// 而入度、出度都按去重后的对算。
    DegreesOnly,
}

/// 边的输出顺序：`fromRelPath` → `toRelPath`（`None` 排最后）→ `kind`。
///
/// 全图与自我中心子图必须用**同一把尺子**：契约规定前端不做二次排序，同一批边在两个视图里
/// 顺序不同的话，前端的"稳定复现"（以及卡片的手工位置）就会莫名其妙地漂。
fn sort_edges(edges: &mut [GraphEdge]) {
    edges.sort_by(|a, b| {
        a.from_rel_path
            .cmp(&b.from_rel_path)
            .then_with(|| compare_target(a.to_rel_path.as_deref(), b.to_rel_path.as_deref()))
            .then_with(|| kind_rank(a.kind).cmp(&kind_rank(b.kind)))
    });
}

/// 目标比较：`None`（悬空）排在最后 —— 契约规定前端不做二次排序，所以这里必须定死。
fn compare_target(a: Option<&str>, b: Option<&str>) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    match (a, b) {
        (Some(left), Some(right)) => left.cmp(right),
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
    }
}

/// 链接类型的排序权重（按枚举声明顺序）：
/// 一条边只有一个 `kind`，因此这只是防御性的最后一级 tie-break，不会真的分岔。
fn kind_rank(kind: LinkKind) -> u8 {
    match kind {
        LinkKind::Wiki => 0,
        LinkKind::Embed => 1,
        LinkKind::Markdown => 2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index_of(files: &[(&str, &str)]) -> LinkIndex {
        let mut index = LinkIndex::new();
        for (rel, text) in files {
            index.upsert(rel, text);
        }
        index
    }

    fn node<'a>(data: &'a GraphData, rel: &str) -> &'a GraphNode {
        data.nodes
            .iter()
            .find(|node| node.rel_path == rel)
            .unwrap_or_else(|| panic!("缺少节点 {rel}（实际：{:?}）", paths_of(data)))
    }

    fn paths_of(data: &GraphData) -> Vec<&str> {
        data.nodes
            .iter()
            .map(|node| node.rel_path.as_str())
            .collect()
    }

    fn edge<'a>(data: &'a GraphData, from: &str, to: Option<&str>) -> &'a GraphEdge {
        data.edges
            .iter()
            .find(|edge| edge.from_rel_path == from && edge.to_rel_path.as_deref() == to)
            .unwrap_or_else(|| panic!("缺少边 {from} → {to:?}（实际：{:?}）", data.edges))
    }

    /// 一个覆盖了各种形态的小 Vault：frontmatter 标题、行内标签、悬空链接、
    /// 一对笔记之间的多条链接、embed 与 markdown 链接、无标签无链接的孤立笔记。
    fn sample() -> GraphData {
        index_of(&[
            (
                "项目/设计.md",
                "---\ntitle: 设计文档\ntags: [项目, 架构]\n---\n\n见 [[路线图]] 与 [[路线图]] 与 [[还不存在]]\n",
            ),
            ("项目/路线图.md", "---\ntitle: 路线图\n---\n\n[设计](设计.md)\n"),
            ("其他/笔记.md", "正文 #其他\n\n![[设计]]\n"),
            ("孤立.md", "没有链接也没有标签\n"),
        ])
        .graph_data(MAX_GRAPH_NODES)
    }

    #[test]
    fn nodes_carry_title_folder_tags_and_degrees() {
        let data = sample();
        assert!(!data.truncated);

        // 按 relPath 字典序（UTF-8 字节序，不是"拼音/笔画"：其 E5 85 < 孤 E5 AD < 项 E9 A1；
        // 同为「项目/」前缀时 设 E8 AE BE < 路 E8 B7 AF）
        assert_eq!(
            paths_of(&data),
            vec!["其他/笔记.md", "孤立.md", "项目/设计.md", "项目/路线图.md"],
            "节点必须按 relPath 字典序"
        );

        let design = node(&data, "项目/设计.md");
        assert_eq!(design.title, "设计文档", "frontmatter 的 title 优先");
        assert_eq!(design.folder, "项目");
        assert_eq!(design.tags, vec!["项目", "架构"]);
        assert_eq!(design.out_degree, 2, "去重后：→路线图 1 条 + 悬空 1 条");
        assert_eq!(
            design.in_degree, 2,
            "路线图的 markdown 链接 + 其他/笔记.md 的 embed"
        );

        let roadmap = node(&data, "项目/路线图.md");
        assert_eq!(roadmap.title, "路线图");
        assert_eq!(roadmap.folder, "项目");
        assert!(roadmap.tags.is_empty());
        assert_eq!((roadmap.out_degree, roadmap.in_degree), (1, 1));

        let other = node(&data, "其他/笔记.md");
        assert_eq!(other.title, "笔记", "没有 frontmatter title → 文件名主干");
        assert_eq!(other.folder, "其他");
        assert_eq!(other.tags, vec!["其他"], "行内标签也进图谱");
        assert_eq!((other.out_degree, other.in_degree), (1, 0));

        let orphan = node(&data, "孤立.md");
        assert_eq!(orphan.title, "孤立");
        assert_eq!(orphan.folder, "", "Vault 根的目录是空串（POSIX）");
        assert_eq!((orphan.out_degree, orphan.in_degree), (0, 0));
    }

    #[test]
    fn edges_are_deduped_by_pair_and_accumulate_count() {
        let data = sample();

        let repeated = edge(&data, "项目/设计.md", Some("项目/路线图.md"));
        assert_eq!(
            repeated.count, 2,
            "同一对之间的两条 [[路线图]] 合并成一条边"
        );
        assert_eq!(repeated.kind, LinkKind::Wiki);
        assert_eq!(repeated.to_raw_target, "路线图", "原始写法也取第一条的");

        assert_eq!(
            edge(&data, "项目/路线图.md", Some("项目/设计.md")).kind,
            LinkKind::Markdown
        );
        assert_eq!(
            edge(&data, "其他/笔记.md", Some("项目/设计.md")).kind,
            LinkKind::Embed
        );
        assert_eq!(data.edges.len(), 4, "3 篇有链接的笔记一共 4 条去重后的边");
    }

    #[test]
    fn dangling_edges_carry_what_the_user_wrote() {
        // 悬空边是画布上唯一需要靠原始写法显示"指向谁"的地方
        let data = index_of(&[
            (
                "项目/甲.md",
                "[[还不存在的笔记]] 与 [说明](../别的/也还没有.md)\n",
            ),
            ("项目/乙.md", "[[谁？？]]\n"),
        ])
        .graph_data(MAX_GRAPH_NODES);

        // 甲的两条悬空链接（wikilink + markdown）解析后都是 `None` → 按 (from, to) 合并成一条边，
        // 只留下**第一条**的写法与类型
        let merged = edge(&data, "项目/甲.md", None);
        assert_eq!(merged.to_raw_target, "还不存在的笔记");
        assert_eq!(merged.count, 2);
        assert_eq!(merged.kind, LinkKind::Wiki);

        // 不同笔记的悬空边彼此独立，各自带着自己写的名字（画布上显示两种不同的名字）
        let raws: Vec<(&str, &str)> = data
            .edges
            .iter()
            .filter(|edge| edge.to_rel_path.is_none())
            .map(|edge| (edge.from_rel_path.as_str(), edge.to_raw_target.as_str()))
            .collect();
        assert_eq!(
            raws,
            vec![("项目/乙.md", "谁？？"), ("项目/甲.md", "还不存在的笔记")],
            "顺序由 fromRelPath 决定（乙 U+4E59 在 甲 U+7532 之前）"
        );
    }

    #[test]
    fn merged_edges_keep_the_first_raw_writing() {
        // 同一目标写了三种写法：合并成一条边，`toRawTarget` 保留**用户第一眼写的**那个，count 仍累计
        let data = index_of(&[
            ("甲.md", "[[乙|别名]] 与 [[乙.md]] 与 ![[乙]]\n"),
            ("乙.md", ""),
        ])
        .graph_data(MAX_GRAPH_NODES);

        assert_eq!(data.edges.len(), 1);
        let merged = &data.edges[0];
        assert_eq!(merged.to_raw_target, "乙", "取第一条链接的写法");
        assert_eq!(merged.count, 3);
        assert_eq!(merged.kind, LinkKind::Wiki, "kind 同样取第一条");
    }

    #[test]
    fn dangling_links_are_null_edges_and_never_count_as_in_degree() {
        let data = sample();
        let dangling = edge(&data, "项目/设计.md", None);
        assert_eq!(dangling.kind, LinkKind::Wiki);
        assert_eq!(dangling.count, 1);
        assert_eq!(dangling.to_raw_target, "还不存在", "悬空边靠它显示'指向谁'");

        // 悬空边只计入来源的出度，任何节点的入度都不该被它抬高
        assert_eq!(node(&data, "项目/设计.md").out_degree, 2);
        assert_eq!(
            data.nodes.iter().map(|n| n.in_degree).sum::<u32>(),
            3,
            "入度总和 = 有目标的三条边"
        );
    }

    #[test]
    fn a_merged_edge_keeps_the_first_kind_it_saw() {
        let data = index_of(&[
            ("甲.md", "![[乙]] 与 [[乙]] 与 [乙](乙.md)\n"),
            ("乙.md", ""),
        ])
        .graph_data(MAX_GRAPH_NODES);

        assert_eq!(data.edges.len(), 1, "(from, to) 相同的三条链接合并成一条");
        let merged = &data.edges[0];
        assert_eq!(merged.count, 3);
        assert_eq!(merged.kind, LinkKind::Embed, "保留首次出现的类型");
        assert_eq!(
            (
                node(&data, "甲.md").out_degree,
                node(&data, "乙.md").in_degree
            ),
            (1, 1)
        );
    }

    #[test]
    fn dangling_links_to_different_targets_share_one_null_edge() {
        // 悬空目标解析后都是 `None`，所以同一篇里的三条悬空链接合并成一条边：
        // `toRawTarget` 只能留下**第一条**的写法（合并口径的必然结果，画布上少显示两条线）
        let data =
            index_of(&[("甲.md", "[[没A]] 与 [[没B]] 与 [[没C]]\n")]).graph_data(MAX_GRAPH_NODES);

        assert_eq!(data.edges.len(), 1);
        assert_eq!(data.edges[0].to_rel_path, None);
        assert_eq!(data.edges[0].to_raw_target, "没A", "保留第一条的写法");
        assert_eq!(data.edges[0].count, 3);
        assert_eq!(node(&data, "甲.md").out_degree, 1, "出度按去重后的边算");
    }

    #[test]
    fn self_links_are_edges_and_count_on_both_sides() {
        let data = index_of(&[("甲.md", "见 [[#小节]] 与 [[甲]]\n")]).graph_data(MAX_GRAPH_NODES);

        assert_eq!(data.edges.len(), 1, "两条自链接合并成一条自环");
        assert_eq!(data.edges[0].to_rel_path.as_deref(), Some("甲.md"));
        assert_eq!(
            data.edges[0].to_raw_target, "",
            "纯锚点链接 `[[#小节]]` 的原始目标按定义就是空串（它总是指向文件自身、必然解析成功）"
        );
        assert_eq!(data.edges[0].count, 2);
        let only = node(&data, "甲.md");
        assert_eq!(
            (only.out_degree, only.in_degree),
            (1, 1),
            "自环同时计入两侧"
        );
    }

    #[test]
    fn edges_sort_by_from_then_target_with_dangling_last() {
        let data = index_of(&[
            ("b.md", "[[a]]\n[[没有]]\n"),
            ("a.md", "[[b]]\n"),
            ("c.md", "[[b]]\n"),
        ])
        .graph_data(MAX_GRAPH_NODES);

        let order: Vec<(&str, Option<&str>)> = data
            .edges
            .iter()
            .map(|edge| (edge.from_rel_path.as_str(), edge.to_rel_path.as_deref()))
            .collect();
        assert_eq!(
            order,
            vec![
                ("a.md", Some("b.md")),
                ("b.md", Some("a.md")),
                ("b.md", None),
                ("c.md", Some("b.md")),
            ],
            "fromRelPath → toRelPath（None 排最后）"
        );
    }

    #[test]
    fn empty_index_yields_an_empty_graph() {
        let data = LinkIndex::new().graph_data(MAX_GRAPH_NODES);
        assert!(data.nodes.is_empty());
        assert!(data.edges.is_empty());
        assert!(!data.truncated, "空索引不是'被截断'");
    }

    #[test]
    fn notes_without_links_still_become_nodes() {
        let data = index_of(&[("甲.md", "没有链接\n"), ("乙.md", "")]).graph_data(MAX_GRAPH_NODES);
        assert_eq!(paths_of(&data), vec!["乙.md", "甲.md"]);
        assert!(data.edges.is_empty());
    }

    #[test]
    fn truncation_keeps_the_most_connected_nodes_and_their_edges() {
        let index = index_of(&[
            ("a.md", "[[b]] [[c]] [[d]]\n"),
            ("b.md", ""),
            ("c.md", ""),
            ("d.md", ""),
            ("e.md", ""),
        ]);

        // 5 个节点，上限 3 → 度数降序（a=3，b/c/d=1 并列按路径，e=0 被丢）
        let data = index.graph_data(3);
        assert!(data.truncated);
        assert_eq!(paths_of(&data), vec!["a.md", "b.md", "c.md"]);
        assert_eq!(
            data.edges.len(),
            2,
            "指向被丢弃的 d.md 的那条边必须一起过滤"
        );
        assert_eq!(
            node(&data, "a.md").out_degree,
            3,
            "度数仍是全图度数（见模块文档）"
        );
        assert_eq!(node(&data, "b.md").in_degree, 1);
        assert_eq!(node(&data, "c.md").in_degree, 1);
    }

    #[test]
    fn truncation_is_off_at_and_below_the_limit() {
        let index = index_of(&[
            ("a.md", "[[b]] [[c]] [[d]]\n"),
            ("b.md", ""),
            ("c.md", ""),
            ("d.md", ""),
            ("e.md", ""),
        ]);

        // 边界：正好等于上限 → 原样返回
        let exact = index.graph_data(5);
        assert!(!exact.truncated, "节点数等于上限时不算截断");
        assert_eq!(exact.nodes.len(), 5);
        assert_eq!(exact.edges.len(), 3);

        // 上限少 1 → 截断，且只少一个节点
        let over = index.graph_data(4);
        assert!(over.truncated);
        assert_eq!(paths_of(&over), vec!["a.md", "b.md", "c.md", "d.md"]);
        assert_eq!(over.edges.len(), 3, "四条边的两端都还在");
    }

    #[test]
    fn tags_are_capped_but_keep_the_original_writing() {
        let text = "正文 #一 #二 #三 #四 #五 #六 #七 #八 #九 #十\n";
        let data = index_of(&[("甲.md", text)]).graph_data(MAX_GRAPH_NODES);
        let tags = &node(&data, "甲.md").tags;
        assert_eq!(tags.len(), MAX_GRAPH_TAGS, "卡片放不下更多标签");
        assert_eq!(tags.first().map(String::as_str), Some("一"));
        assert_eq!(tags.last().map(String::as_str), Some("八"));
    }

    #[test]
    fn title_falls_back_to_the_file_stem() {
        let data = index_of(&[
            ("目录/我的笔记.md", "正文\n"),
            ("目录/带标题.md", "---\ntitle: 显式标题\n---\n正文\n"),
            ("其他/空标题.md", "---\ntitle: '   '\n---\n正文\n"),
        ])
        .graph_data(MAX_GRAPH_NODES);

        assert_eq!(node(&data, "目录/我的笔记.md").title, "我的笔记");
        assert_eq!(node(&data, "目录/带标题.md").title, "显式标题");
        assert_eq!(
            node(&data, "其他/空标题.md").title,
            "空标题",
            "空白的 frontmatter title 视为没有 → 退回主干"
        );
        assert_eq!(node(&data, "目录/我的笔记.md").folder, "目录");
    }

    #[test]
    fn index_titles_follow_upsert_rename_and_remove() {
        // 标题跟着索引走：保存改了 frontmatter、改名换了路径，图谱必须跟着变
        let mut index = index_of(&[("甲.md", "---\ntitle: 旧标题\n---\n正文\n")]);
        assert_eq!(index.title_of("甲.md"), Some("旧标题"));
        assert_eq!(index.graph_data(MAX_GRAPH_NODES).nodes[0].title, "旧标题");

        index.upsert("甲.md", "---\ntitle: 新标题\n---\n正文\n");
        assert_eq!(index.title_of("甲.md"), Some("新标题"));

        index.remove("甲.md");
        assert_eq!(index.title_of("甲.md"), None, "删掉笔记不能留下幽灵标题");
        assert!(index.graph_data(MAX_GRAPH_NODES).nodes.is_empty());

        index.upsert("甲.md", "---\ntitle: 新标题\n---\n正文\n");
        index.clear();
        assert_eq!(index.title_of("甲.md"), None, "重扫 clear 后标题也要清掉");
    }

    // -- 自我中心子图（ego_graph） ----------------------------------------------

    #[test]
    fn ego_graph_keeps_the_root_even_without_links() {
        // 圆心必须有卡片：哪怕这篇一条链接都没有，"以它为中心"仍然是一张合法的图。
        // 反过来说，这条在防"没链接的笔记打开自我中心视图是一片空白"——用户会以为图谱坏了。
        let index = index_of(&[("孤立.md", "没有任何链接\n"), ("别的.md", "")]);
        let data = index.ego_graph("孤立.md", 1, MAX_EGO_NODES);

        assert_eq!(paths_of(&data), vec!["孤立.md"]);
        assert!(data.edges.is_empty());
        assert!(!data.truncated, "起点本来就没有邻居，不算被截断");
    }

    #[test]
    fn ego_graph_walks_both_directions() {
        // 双向是这条命令的核心语义（用户说的"先关联"）：A → B 时从 B 出发也该看到 A。
        // 这条在防"只走出链"：用户在一篇还没被引用过的笔记上打开图谱，看到的是一个孤零零的圆，
        // 而真相是"有好几篇笔记正链接到它"。
        let index = index_of(&[("a.md", "[[b]]\n"), ("b.md", ""), ("c.md", "[[a]]\n")]);

        let from_a = index.ego_graph("a.md", 1, MAX_EGO_NODES);
        assert_eq!(
            paths_of(&from_a),
            vec!["a.md", "b.md", "c.md"],
            "出链（b）与反链（c）都算一跳"
        );
        assert_eq!(from_a.edges.len(), 2, "两条边的两端都在子图里");
        edge(&from_a, "a.md", Some("b.md"));
        edge(&from_a, "c.md", Some("a.md"));

        let from_b = index.ego_graph("b.md", 1, MAX_EGO_NODES);
        assert_eq!(
            paths_of(&from_b),
            vec!["a.md", "b.md"],
            "从 B 出发也能看到 A"
        );
    }

    #[test]
    fn ego_graph_respects_depth() {
        // 链式 a→b→c→d：跳数就是"离中心第几环"，多一跳必须多给一圈、少一跳不能多给。
        // 这条在防"深度被忽略或算错方向"（双向走法最容易把 `depth` 当成"出链层数"）。
        let index = index_of(&[
            ("a.md", "[[b]]\n"),
            ("b.md", "[[c]]\n"),
            ("c.md", "[[d]]\n"),
            ("d.md", ""),
        ]);

        assert_eq!(
            paths_of(&index.ego_graph("a.md", 1, MAX_EGO_NODES)),
            vec!["a.md", "b.md"]
        );
        assert_eq!(
            paths_of(&index.ego_graph("a.md", 2, MAX_EGO_NODES)),
            vec!["a.md", "b.md", "c.md"]
        );
        assert_eq!(
            paths_of(&index.ego_graph("a.md", 3, MAX_EGO_NODES)),
            vec!["a.md", "b.md", "c.md", "d.md"]
        );
        assert_eq!(
            paths_of(&index.ego_graph("a.md", 5, MAX_EGO_NODES)),
            vec!["a.md", "b.md", "c.md", "d.md"],
            "深度超过链长不会凭空多出节点"
        );
    }

    #[test]
    fn ego_graph_excludes_unrelated_notes() {
        // 与中心没有任何路径的另一簇必须完全不出现 —— 否则"以这篇为中心"就没有意义了。
        // 这条在防"顺手把全图节点都带上"（那样节点数、报文、画布布局全都等于没筛选）。
        let index = index_of(&[
            ("a.md", "[[b]]\n"),
            ("b.md", ""),
            ("x.md", "[[y]]\n"),
            ("y.md", "[[x]]\n"),
        ]);

        let data = index.ego_graph("a.md", 5, MAX_EGO_NODES);
        assert_eq!(paths_of(&data), vec!["a.md", "b.md"]);
        assert_eq!(data.edges.len(), 1);
        assert!(
            data.nodes.iter().all(|node| node.rel_path != "x.md"),
            "X/Y 那一簇与中心无关"
        );
    }

    #[test]
    fn ego_graph_drops_dangling_edges_of_other_notes() {
        // 悬空边只在"起点自己"的视角下有意义（用户正看着这篇笔记，知道它指向一个还不存在的
        // 目标）；别人的悬空边画在这个子图里就是一条从某张卡片通向画布外的虚线
        // （点不到、也解释不清）。这条在防"只按 to 过滤、from 没管"。
        let index = index_of(&[
            ("中心.md", "[[邻.md]] 与 [[还不存在]]\n"),
            ("邻.md", "[[也还没有]]\n"),
        ]);

        let data = index.ego_graph("中心.md", 1, MAX_EGO_NODES);
        let dangling: Vec<&str> = data
            .edges
            .iter()
            .filter(|edge| edge.to_rel_path.is_none())
            .map(|edge| edge.from_rel_path.as_str())
            .collect();
        assert_eq!(dangling, vec!["中心.md"], "只留起点自己发出的悬空边");
        assert_eq!(edge(&data, "中心.md", None).to_raw_target, "还不存在");
        assert!(
            !data
                .edges
                .iter()
                .any(|edge| edge.from_rel_path == "邻.md" && edge.to_rel_path.is_none()),
            "邻.md 指向不存在笔记的那条边不该出现"
        );
        // 起点自己的悬空边照旧计入出度，且度数仍是**全图**口径（与 graph_data 一致）
        assert_eq!(node(&data, "中心.md").out_degree, 2);
    }

    #[test]
    fn ego_graph_truncates_by_nearest_first_and_reports_it() {
        // 截断的三级排序：距离 → 同层度数 → 路径。root 有 4 个一跳邻居（b1..b4），
        // 其中 b1 还连着一跳之外的两个。
        let index = index_of(&[
            ("root.md", "[[b1]] [[b2]] [[b3]] [[b4]]\n"),
            ("b1.md", "[[f1]] [[f2]]\n"),
            ("b2.md", ""),
            ("b3.md", ""),
            ("b4.md", ""),
            ("f1.md", ""),
            ("f2.md", ""),
        ]);

        // 上限 3：圆心 + 两个最近的邻居。二跳的 f1/f2 一个都进不来 —— **距离是排序主键**，
        // 因此被留下的节点，它的一跳父节点必然也在（子图仍然连通，不会出现孤立卡片）。
        let data = index.ego_graph("root.md", 2, 3);
        assert!(data.truncated, "丢弃了节点就必须如实置 truncated");
        assert_eq!(paths_of(&data), vec!["b1.md", "b2.md", "root.md"]);
        assert!(data.nodes.iter().all(|node| node.rel_path != "f1.md"));
        assert_eq!(
            data.edges.len(),
            2,
            "指向被丢弃节点的边一起过滤（root→b1、root→b2）"
        );
        assert_eq!(
            node(&data, "root.md").out_degree,
            4,
            "度数仍是全图度数（见模块文档的截断一节）"
        );

        // 上限 2 才看得出"同层按出入度降序"：b1（度数 3）压过只有 1 度的 b2/b3/b4
        let tighter = index.ego_graph("root.md", 2, 2);
        assert!(tighter.truncated);
        assert_eq!(paths_of(&tighter), vec!["b1.md", "root.md"]);

        // 上限够大时不截断：前端据此决定要不要显示"已截断"
        let full = index.ego_graph("root.md", 2, 7);
        assert!(!full.truncated);
        assert_eq!(full.nodes.len(), 7);
    }

    #[test]
    fn ego_graph_returns_empty_for_an_unknown_root() {
        // "刚打开 Vault、当前笔记还没进索引"走的就是这条路：必须是空结果，而不是错误 ——
        // 报错会把"索引正在构建"变成一条吓人的红色提示（前端据此显示"还没进入索引"）。
        let index = index_of(&[("甲.md", "[[乙]]\n"), ("乙.md", "")]);
        let data = index.ego_graph("还没进索引.md", 3, MAX_EGO_NODES);
        assert!(data.nodes.is_empty());
        assert!(data.edges.is_empty());
        assert!(!data.truncated, "什么都没截：这个子图本来就是空的");

        // 空索引（索引正在构建）同样是空结果、不 panic —— 与 graph_data 返回空图谱同一个口径
        let building = LinkIndex::new().ego_graph("甲.md", 3, MAX_EGO_NODES);
        assert!(building.nodes.is_empty());
        assert!(!building.truncated);

        // 路径口径与索引一致：Windows 形态的 `\` 也要认得出同一篇笔记
        let nested = index_of(&[("目录/甲.md", "[[乙]]\n"), ("乙.md", "")]);
        let windows = nested.ego_graph("目录\\甲.md", 1, MAX_EGO_NODES);
        assert_eq!(paths_of(&windows), vec!["乙.md", "目录/甲.md"]);
    }

    #[test]
    fn ego_graph_matches_graph_data_degrees() {
        // 这条防"两份口径漂移"：同一份 Vault 上，ego 子图里每个节点的度数/标题/标签/目录必须与
        // graph_data 里的**逐字相同**。两处组装代码分家的最早征兆就是度数不一样 ——
        // 前端两个视图共用同一份 `GraphNode` 与同一套绘制代码，不一致立刻会变成"同一张卡片
        // 在全图里写 in=2、在中心视图里写 in=1"这种没法解释的画面。
        let index = index_of(&[
            (
                "项目/设计.md",
                "---\ntitle: 设计文档\ntags: [项目, 架构]\n---\n\n见 [[路线图]] 与 [[路线图]] 与 [[还不存在]]\n",
            ),
            ("项目/路线图.md", "---\ntitle: 路线图\n---\n\n[设计](设计.md)\n"),
            ("其他/笔记.md", "正文 #其他\n\n![[设计]]\n"),
            ("孤立.md", "没有链接也没有标签\n"),
        ]);

        let full = index.graph_data(MAX_GRAPH_NODES);
        let ego = index.ego_graph("项目/设计.md", 3, MAX_EGO_NODES);

        assert_eq!(
            paths_of(&ego),
            vec!["其他/笔记.md", "项目/设计.md", "项目/路线图.md"],
            "孤立.md 与中心没有任何路径，不该出现"
        );
        for node in &ego.nodes {
            let same = full
                .nodes
                .iter()
                .find(|candidate| candidate.rel_path == node.rel_path)
                .unwrap_or_else(|| panic!("graph_data 里没有 {}", node.rel_path));
            assert_eq!(node.out_degree, same.out_degree, "{} 的出度", node.rel_path);
            assert_eq!(node.in_degree, same.in_degree, "{} 的入度", node.rel_path);
            assert_eq!(node.title, same.title);
            assert_eq!(node.tags, same.tags);
            assert_eq!(node.folder, same.folder);
        }
        // 度数本身也钉一次：不然"两边都算错成同一个值"会一起通过
        assert_eq!(node(&ego, "项目/设计.md").out_degree, 2);
        assert_eq!(node(&ego, "项目/设计.md").in_degree, 2);

        // 边同理：子图里的每条边都能在 graph_data 里找到逐字相同的那一条
        for edge in &ego.edges {
            assert!(
                full.edges.iter().any(|candidate| candidate == edge),
                "边 {edge:?} 与 graph_data 里同一条不一致"
            );
        }
        assert_eq!(
            ego.edges.len(),
            4,
            "设计→路线图、路线图→设计、其他→设计，外加起点自己那条悬空边"
        );
    }

    #[test]
    fn ego_graph_normalizes_depth_and_max_nodes() {
        // 归一化是契约的一部分（`depth` 到 1..=5、`maxNodes` 到安全范围）：越界的入参不能变成
        // "深度 0 的空图"或"上限 0 连圆心都没有"，也不能让 99 跳去跑全库。这条在防"夹取写成
        // 了直接透传"，以及"宿主与索引各夹一个不同范围"。
        let index = index_of(&[("a.md", "[[b]]\n"), ("b.md", "[[c]]\n"), ("c.md", "")]);

        let zero = index.ego_graph("a.md", 0, MAX_EGO_NODES);
        assert_eq!(
            paths_of(&zero),
            vec!["a.md", "b.md"],
            "depth = 0 归一化成 1"
        );
        assert_eq!(
            index.ego_graph("a.md", 99, MAX_EGO_NODES).nodes.len(),
            3,
            "99 跳被夹到 5 跳（这条链一共只有 3 篇）"
        );

        let none = index.ego_graph("a.md", 1, 0);
        assert_eq!(
            paths_of(&none),
            vec!["a.md"],
            "maxNodes = 0 夹到 1，圆心必须留着"
        );
        assert!(none.truncated);

        let huge = index.ego_graph("a.md", 5, usize::MAX);
        assert_eq!(huge.nodes.len(), 3, "上限被夹到 MAX_EGO_NODES，不影响结果");
        assert!(!huge.truncated);
    }
}
