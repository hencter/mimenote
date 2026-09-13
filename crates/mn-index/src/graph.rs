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
//! 本模块**不做任何文件 IO**：节点来自索引收录的笔记，标题优先用索引里记下的 frontmatter
//! `title`（`LinkIndex::upsert` 时顺手解析，见 [`crate::LinkIndex::title_of`]），
//! 没有就退回文件名主干。因此 1 万笔记下这个命令也只有内存遍历。

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

impl LinkIndex {
    /// 组装图谱数据（只读索引，**零文件 IO**）。
    ///
    /// `max_nodes` 是节点上限：生产路径传 [`MAX_GRAPH_NODES`]，单测注入小值来验证截断边界。
    /// 索引为空（正在构建、还没有笔记、Vault 刚打开）时返回空图谱而不是错误 ——
    /// 前端按 `index_status` 决定要不要显示"索引构建中"。
    pub fn graph_data(&self, max_nodes: usize) -> GraphData {
        let started = Instant::now();

        // 节点来源 = 索引收录的笔记（`build_index` 只把 `.md` / `.markdown` 且这一轮读成功的
        // 文件放进来）。先排好序：节点输出顺序就是契约要求的顺序，前端不再排一次。
        let mut paths: Vec<&str> = self.files.keys().map(String::as_str).collect();
        paths.sort_unstable();

        // -- 边：按 (from, to) 去重并累计 count ------------------------------------
        // 遍历顺序是确定的（路径字典序 + 文档内出现顺序），所以"首次出现的 kind 胜出"可复现。
        let mut merged: HashMap<(&str, Option<String>), GraphEdge> = HashMap::new();
        for from in &paths {
            let Some(links) = self.files.get(*from) else {
                continue;
            };
            for link in links {
                let (to, _ambiguous) = self.resolve_target(from, &link.raw_target);
                let key = (*from, to.clone());
                match merged.entry(key) {
                    // 已有一条同 (from, to) 的边：只累加条数，`kind` 与 `toRawTarget`
                    // 保持**第一条**链接的写法（同一对笔记之间的写法差异只保留最早那一种）
                    Entry::Occupied(mut occupied) => occupied.get_mut().count += 1,
                    Entry::Vacant(vacant) => {
                        vacant.insert(GraphEdge {
                            from_rel_path: (*from).to_string(),
                            to_rel_path: to,
                            to_raw_target: link.raw_target.clone(),
                            kind: link.kind,
                            count: 1,
                        });
                    }
                }
            }
        }
        let mut edges: Vec<GraphEdge> = merged.into_values().collect();

        // -- 度数：按去重后的边累加（悬空边只计出度）--------------------------------
        // 用 owned key：下面截断时要 `edges.retain(...)`，借用 `edges` 的键会让借用检查器拦住。
        let mut out_degree: HashMap<String, u32> = HashMap::new();
        let mut in_degree: HashMap<String, u32> = HashMap::new();
        for edge in &edges {
            *out_degree.entry(edge.from_rel_path.clone()).or_default() += 1;
            if let Some(to) = &edge.to_rel_path {
                *in_degree.entry(to.clone()).or_default() += 1;
            }
        }

        // -- 截断：按 (in + out) 降序 → relPath 升序，取前 max_nodes 个 --------------
        // 并列时按路径定序：同样的 Vault 得到同样的子集，前端不做二次排序也能稳定复现。
        let truncated = paths.len() > max_nodes;
        let kept: HashSet<&str> = if truncated {
            let mut ranked: Vec<(&str, u32)> = paths
                .iter()
                .copied()
                .map(|path| (path, degree_of(&out_degree, &in_degree, path)))
                .collect();
            ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
            ranked.truncate(max_nodes);
            ranked.into_iter().map(|(path, _)| path).collect()
        } else {
            paths.iter().copied().collect()
        };

        // -- 节点 ----------------------------------------------------------------
        let nodes: Vec<GraphNode> = paths
            .iter()
            .copied()
            .filter(|&path| kept.contains(path))
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

        // -- 边（截断后只留两端都在节点集合里的边；悬空边照旧）------------------------
        if truncated {
            edges.retain(|edge| {
                kept.contains(edge.from_rel_path.as_str())
                    && match edge.to_rel_path.as_deref() {
                        Some(to) => kept.contains(to),
                        None => true,
                    }
            });
        }

        edges.sort_by(|a, b| {
            a.from_rel_path
                .cmp(&b.from_rel_path)
                .then_with(|| compare_target(a.to_rel_path.as_deref(), b.to_rel_path.as_deref()))
                .then_with(|| kind_rank(a.kind).cmp(&kind_rank(b.kind)))
        });

        GraphData {
            nodes,
            edges,
            truncated,
            elapsed_ms: started.elapsed().as_millis() as u64,
        }
    }
}

/// 度数口径：入 + 出（截断排序只看它，因此单独抽出来）。
fn degree_of(
    out_degree: &HashMap<String, u32>,
    in_degree: &HashMap<String, u32>,
    path: &str,
) -> u32 {
    out_degree.get(path).copied().unwrap_or(0) + in_degree.get(path).copied().unwrap_or(0)
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
}
