//! 整库导出的**索引投影**：把链接索引读成"一个静态站点应该长什么样"的计划。
//!
//! 宿主拿到计划之后做三件事：把计划交给前端（前端渲染每页正文）、按计划把图片复制进
//! `assets/`、把前端回传的页面落盘。本层**零文件 IO** —— 页面清单、双链解析、标签、
//! 反链全部来自索引，这也是 4000 篇的 Vault 上"导出"能在点下按钮的那一刻就说出
//! "共 N 页、M 条链接、K 条悬空"的原因。
//!
//! # 链接解析不在这里（只转发）
//!
//! 每页的出链一律走 [`LinkIndex::outbound_of`]，它内部用的是与反链面板、图谱、
//! 重命名改写**完全相同**的那一套规则（`resolve_target`）。这里绝不自己写一份"看起来等价"的
//! 路径匹配：导出的站点里一条链接悬空、而应用里那条链接是好的，是用户最难理解的一类不一致
//! （"为什么笔记里能点开，导出之后点不动了？"），而两份规则只要有一天不同步就必然出现。
//!
//! # 页面顺序与内容顺序
//!
//! 页面按 `paths()`（字节序）产出，链接按文档出现顺序，反链与标签排过序 —— 一切都是显式的。
//! 加上"页面里不含时间戳"（只有索引页与标记文件带 `exportedAtMs`，那是前端传的值），
//! 同一个 Vault 连续导出两次的产物因此逐字节相同（见 `plan_site_is_byte_identical_for_the_same_vault`）。
//!
//! # 图片清单：**本层不做**（`assets` 恒为空数组）
//!
//! 契约里的 `assets` 是"这一趟要复制哪些图片"的清单。它留空是刻意的，理由是**规则不要第二份**：
//!
//! * 前端渲染时已经有一份完整的图片解析规则（`apps/desktop/src/domain/assets.ts` 的
//!   `createAssetResolver`）：相对当前笔记、`/` 开头的 Vault 绝对、以及"只有裸文件名才走
//!   全库同名兜底（按路径更短 → 字典序挑一个）"。它**必须**存在，因为 `<img src>` 是它填的；
//! * 在 Rust 侧照抄一遍，需要的东西这里根本没有：索引只收录 `.md`/`.markdown`
//!   （[`crate::MAX_INDEX_BYTES`]），**附件一个都不在索引里**，所以"这张图存在吗、
//!   同名的是哪一张"在这里无从判断 —— 要么加上文件 IO（本层就不再有"零 IO"这个性质，
//!   4000 篇的 Vault 上会退化成遍历全库），要么凭正文文本猜（猜错了就是"导出的站点里有张破图"）；
//! * 更糟的是漂移的后果不对称：两份规则不一致时，前端按自己的规则写出 `<img src="...">`，
//!   宿主按另一份规则复制文件 —— 结果是**页面指向一张没有被复制的图**，
//!   而这件事只在"某个 Vault 恰好有一张同名图"时才发生。
//!
//! 因此契约里那句"前端仍会自己收集并在计划之外补上它发现的图片，两边以**并集**为准"
//! 在这里只有一侧：**图片清单由前端渲染时收集后随 `export_site_copy_assets` 一起发来**，
//! 宿主侧的 `copy_assets` 只负责"逐个校验路径 + 原子复制 + 如实汇报跳过"。
//! 宿主**不做安全决策**这件事没有变：每一个落盘的源路径仍然要过 `path_guard`。
//!
//! # 与计划一起回给前端的两个"宿主才知道"的字段
//!
//! [`SitePlan::vault_name`] / [`SitePlan::output_dir`] / [`SitePlan::previous`] 这一层都不知道
//! （分别来自 Vault 根目录名、用户选定的输出目录、目标目录里的标记文件），
//! 所以它们在 [`plan_site`] 的返回值里恒为空/`None`，由宿主用结构体更新语法填上。

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::{Deserialize, Serialize};

use mn_core::site::{
    document_stem, encode_url_path, is_markdown_note, relative_href, reserve_page_paths, PageRename,
};
use mn_core::tags::normalize_tag;

use crate::LinkIndex;

/// 标记文件里那个"这是我们写的"的标识（`mimenote-export.json` 的 `tool` 字段）。
///
/// 覆盖策略完全建立在它之上：目录非空但标记文件不是我们的 → 一律拒绝写入。
/// 写成常量而不是散落的字面量，是因为**前端也要写同一个值**，它是对外契约的一部分。
pub const SITE_TOOL_ID: &str = "mimenote";

/// 站内一页里的一个链接（契约 `SiteLink`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteLink {
    /// 原文里写的目标（已剥离锚点与别名），与前端渲染出的 `data-target` **逐字一致** ——
    /// 前端就是拿它回查这张表，取到 `href` 再改写到 `<a>` 上。
    ///
    /// 注意 `[文本](某篇.md)` 这类 Markdown 链接同样出现（`kind` 不在这里区分），
    /// 图片嵌入（`![](图.png)` / `![[图.png]]`）也在其中且多半是悬空 —— 前端把它们渲染成
    /// `<img>`、不查这张表，但**不能因此把它们过滤掉**：少了哪一条，就是前端查表时的一次落空，
    /// 而落空的那一侧会把链接渲染成死链。
    pub target: String,
    /// 锚点（`[[笔记#小节]]` 的 `小节`、`[[#小节]]` 的 `小节`）；没有 = `None`。
    pub anchor: Option<String>,
    /// 相对**本页**的 href（已编码，含片段）；悬空 = `None`。
    pub href: Option<String>,
    /// 显示文本：别名优先，与前端 `wikilinkDisplayText` 同一口径（来自索引的解析结果）。
    pub display: String,
}

/// 站内一页（契约 `SitePage`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SitePage {
    /// 源笔记的 Vault 相对路径（POSIX）。
    pub rel_path: String,
    /// 站内相对路径，如 `项目/设计.html`。
    pub page_path: String,
    /// 编码后的站内路径，如 `%E9%A1%B9%E7%9B%AE/%E8%AE%BE%E8%AE%A1.html`。
    pub url_path: String,
    /// 展示标题：frontmatter 的 `title` 优先，否则文件名主干（与图谱的节点标题同一口径）。
    pub title: String,
    /// 该篇的标签（按归一化键去重、按键字典序；值取首次出现的展示写法）。
    pub tags: Vec<String>,
    /// 出链（按正文出现顺序）。
    pub links: Vec<SiteLink>,
    /// 指向本页的来源笔记相对路径（已排序、已去重、不含自引用）。
    pub backlinks: Vec<String>,
}

/// 导出概况（契约 `SiteStats`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteStats {
    /// 索引里的笔记数（本次计划的输入）。
    pub notes: usize,
    /// 实际产出的页面数（当前与 `notes` 相等：每篇笔记都有页面）。
    pub pages: usize,
    /// 链接总数（含悬空）。
    pub links: usize,
    /// 悬空链接数（`href` 为 `None` 的那些）。
    pub dangling: usize,
    /// 图片清单条数（恒为 0，见模块文档：清单由前端收集后单独发来）。
    pub assets: usize,
    /// 因为重名被改了名的页面（见 [`reserve_page_paths`]）。
    ///
    /// 复用 `mn_core::site::PageRename` 而不是在本层再定义一个同形状的 `SiteRename`：
    /// 契约要的是 JSON 形状（`{relPath, pagePath}`），而两个字段完全相同的结构体
    /// 迟早会因为一次"顺手加个字段"而分家。
    pub renamed: Vec<PageRename>,
}

/// 上一次导出留下的标记（契约 `SitePreviousExport`，字段名就是标记文件里的字段名）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SitePreviousExport {
    /// 上次导出的时刻（毫秒时间戳，由前端写入）。
    pub exported_at_ms: u64,
    /// 上次写出过哪些站内相对路径。
    ///
    /// 宿主**从不删除**任何文件（与 ADR-0018 同一条底线），所以"上次有、这次没有"的文件会
    /// 留在原处；这份清单存在的唯一目的是让前端能如实汇报"有 N 个文件是上一版的残留"。
    pub files: Vec<String>,
    /// 上次导出的是哪个 Vault（换库导出到同一个目录时，前端要能提醒用户）。
    pub vault_name: String,
}

/// `mimenote-export.json` 的**内容形状**。
///
/// 这个文件由**前端**写出（它也是 `SiteFile` 之一，按契约最后一批写），宿主只读它。
/// 字段顺序固定（`serde` 保序，不许用 `HashMap`）：同一个 Vault 两次导出的产物必须逐字节相同，
/// 而 JSON 对象的键序在这种"给机器比对的文件"上是会被人看出来的差别。
///
/// 除 `tool` 之外全部 `#[serde(default)]`：标记文件是**跨版本**的凭证，未来多加一个字段
/// （它一定会加，比如记录导出选项）不该让"我们上次导出的目录"变成"别人的目录"从而
/// 让用户面对一次莫名其妙的 `ALREADY_EXISTS`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteMarker {
    /// 写这个文件的工具；只有 [`SITE_TOOL_ID`] 才算我们的。
    pub tool: String,
    /// 产物格式版本（留给未来的不兼容改动）。
    #[serde(default)]
    pub version: u32,
    /// 导出时刻（毫秒时间戳）。
    #[serde(default)]
    pub exported_at_ms: u64,
    /// Vault 根目录名。
    #[serde(default)]
    pub vault_name: String,
    /// 本次写出过的站内相对路径。
    #[serde(default)]
    pub files: Vec<String>,
}

impl SiteMarker {
    /// 这个标记是不是我们写的。
    pub fn is_ours(&self) -> bool {
        self.tool == SITE_TOOL_ID
    }

    /// 转成给前端的"上次导出"摘要。
    pub fn previous(&self) -> SitePreviousExport {
        SitePreviousExport {
            exported_at_ms: self.exported_at_ms,
            files: self.files.clone(),
            vault_name: self.vault_name.clone(),
        }
    }
}

/// 一次导出的完整计划（契约 `SitePlan`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SitePlan {
    /// Vault 根目录名（**宿主**填：索引层不知道 Vault 在哪，见模块文档）。
    pub vault_name: String,
    /// 规范化后的输出目录绝对路径；前端没传输出目录 = `None`（**宿主**填）。
    pub output_dir: Option<String>,
    /// 目标目录里我们上次写的标记；没有/不是我们的 = `None`（**宿主**填）。
    pub previous: Option<SitePreviousExport>,
    /// 页面（按 `relPath` 字节序）。
    pub pages: Vec<SitePage>,
    /// 概况。
    pub stats: SiteStats,
    /// 要复制的图片清单。**恒为空**，理由见模块文档（清单由前端收集）。
    pub assets: Vec<String>,
}

/// 算出"这一趟要写哪些页面、每页有什么"（只读索引，零文件 IO）。
///
/// `vault_name` / `output_dir` / `previous` 由宿主用结构体更新语法填上（见模块文档）。
/// 索引为空（正在构建、Vault 里还没有笔记）时返回一个空计划而不是错误 ——
/// 前端按 `index_status` 决定要不要显示"索引构建中"；而宿主那条命令会在索引未就绪时
/// 直接返回 `INDEX_NOT_READY`（计划为空会让用户以为"导出成功但一篇都没有"）。
pub fn plan_site(index: &LinkIndex) -> SitePlan {
    let notes: Vec<String> = index
        .paths()
        .into_iter()
        .filter(|rel_path| is_markdown_note(rel_path))
        .collect();
    let note_count = notes.len();
    let (page_paths, renamed) = reserve_page_paths(&notes);

    // 笔记路径 → 页面路径：链接解析出来的目标是**笔记**，而 href 要指**页面**
    let mut page_of: HashMap<&str, &str> = HashMap::with_capacity(note_count);
    for (rel_path, page_path) in notes.iter().zip(page_paths.iter()) {
        if !page_path.is_empty() {
            page_of.insert(rel_path.as_str(), page_path.as_str());
        }
    }

    let mut links_total = 0usize;
    let mut dangling = 0usize;
    let mut link_lists: Vec<Vec<SiteLink>> = Vec::with_capacity(note_count);
    // 目标 → 来源集合。用 `BTreeSet` 而不是 `Vec`：同源多链只需要一行，
    // 而"按来源路径排序"是契约要求（前端不做二次排序）
    let mut backlinks: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();

    for (position, rel_path) in notes.iter().enumerate() {
        let page_path = page_paths[position].as_str();
        let outbound = index.outbound_of(rel_path);
        let mut links = Vec::with_capacity(outbound.len());

        for link in outbound {
            let href = link
                .resolved_rel_path
                .as_deref()
                .and_then(|target| page_of.get(target).copied())
                .map(|target_page| relative_href(page_path, target_page, link.anchor.as_deref()));
            if href.is_none() {
                dangling += 1;
            }
            if let Some(target) = link.resolved_rel_path.as_deref() {
                // 自引用不进反链：与 `LinkIndex::ensure_backlinks` 同一口径
                //（`[[#小节]]` 指向本页，列进反链就是版面噪音）。
                // 这一条必须与那份实现**一致**，否则导出页面的"反向链接"一栏会比应用里多几条。
                if target != rel_path {
                    backlinks
                        .entry(target.to_string())
                        .or_default()
                        .insert(rel_path.clone());
                }
            }
            links.push(SiteLink {
                target: link.raw_target,
                anchor: link.anchor,
                href,
                // 显示文本直接用索引算好的那一份：它已经是"别名 > 目标 > #锚点"的口径，
                // 在这里再写一次就是第二份实现（见模块文档：链接规则只有一份）
                display: link.display,
            });
        }

        links_total += links.len();
        link_lists.push(links);
    }

    let pages: Vec<SitePage> = notes
        .iter()
        .zip(page_paths.iter())
        .zip(link_lists)
        .map(|((rel_path, page_path), links)| SitePage {
            rel_path: rel_path.clone(),
            page_path: page_path.clone(),
            url_path: encode_url_path(page_path),
            title: title_of(index, rel_path),
            tags: tags_of(index, rel_path),
            links,
            backlinks: backlinks
                .get(rel_path)
                .map(|sources| sources.iter().cloned().collect())
                .unwrap_or_default(),
        })
        .collect();

    let stats = SiteStats {
        notes: note_count,
        pages: pages.len(),
        links: links_total,
        dangling,
        assets: 0,
        renamed,
    };

    SitePlan {
        // 这三个字段只有宿主知道（见模块文档），宿主用结构体更新语法填
        vault_name: String::new(),
        output_dir: None,
        previous: None,
        pages,
        stats,
        assets: Vec::new(),
    }
}

/// 一篇笔记的展示标题：frontmatter 的 `title` 优先，否则文件名主干。
///
/// 与 `GraphNode::title` 逐字同口径（同一份 `title_of` + 同一个主干规则）：
/// 图谱卡片上叫 `设计文档`、导出站点那一页的标题却是 `设计`，是用户一眼能看出、
/// 却很难解释来源的不一致。
fn title_of(index: &LinkIndex, rel_path: &str) -> String {
    index
        .title_of(rel_path)
        .map(str::to_string)
        .or_else(|| document_stem(rel_path))
        .unwrap_or_else(|| rel_path.to_string())
}

/// 一篇笔记的标签：按归一化键去重、按键字典序，值取**首次出现**的展示写法。
///
/// 为什么按键排序而不是按出现顺序：站点上的标签是一组可扫视的元信息（`#Rust` 与 `#rust`
/// 是同一个标签），而"首次出现的写法"保留的是用户自己的大小写 —— 两者都要，
/// 于是"排序看键、显示看原文"。
fn tags_of(index: &LinkIndex, rel_path: &str) -> Vec<String> {
    let mut by_key: BTreeMap<String, String> = BTreeMap::new();
    for tag in index.tags_of(rel_path) {
        let key = normalize_tag(&tag.tag);
        if key.is_empty() {
            continue;
        }
        // `or_insert` = 第一次出现的写法胜出（`tags_of` 已经按出现顺序给出）
        by_key.entry(key).or_insert(tag.tag);
    }
    by_key.into_values().collect()
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

    fn page<'a>(plan: &'a SitePlan, rel_path: &str) -> &'a SitePage {
        plan.pages
            .iter()
            .find(|page| page.rel_path == rel_path)
            .unwrap_or_else(|| {
                panic!(
                    "缺少页面 {rel_path}（实际：{:?}）",
                    plan.pages
                        .iter()
                        .map(|page| page.rel_path.as_str())
                        .collect::<Vec<_>>()
                )
            })
    }

    fn link<'a>(page: &'a SitePage, target: &str) -> &'a SiteLink {
        page.links
            .iter()
            .find(|link| link.target == target)
            .unwrap_or_else(|| panic!("页面 {} 缺少指向 {target:?} 的链接", page.rel_path))
    }

    fn targets(page: &SitePage) -> Vec<&str> {
        page.links.iter().map(|link| link.target.as_str()).collect()
    }

    /// 一个覆盖各种形态的小 Vault：frontmatter 标题、行内标签、裸名/相对/后缀/歧义/别名/锚点
    /// 六种链接写法、悬空链接、自引用锚点、以及一篇谁都不指向的孤立笔记。
    fn sample() -> SitePlan {
        plan_site(&index_of(&[
            (
                "项目/设计.md",
                "---\ntitle: 设计文档\ntags: [项目, 架构]\n---\n\n见 [[路线图]]，也见 [[路线图|路线图别名]]；\
                 \n跳到 [[#设计目标]]；\n指向 [[没有这篇]]；\n后缀写法 [说明](子目录/笔记.md)\n",
            ),
            (
                "项目/路线图.md",
                "---\ntitle: 路线图\n---\n\n[设计](设计.md) 与 #项目\n",
            ),
            (
                "深层/子目录/笔记.md",
                "正文 #其他\n\n回 [[项目/设计|设计文档]]\n",
            ),
            ("甲/同名.md", "重名一\n"),
            ("乙/同名.md", "重名二\n"),
            ("引用.md", "[[同名]] 与 [[设计#设计目标]]\n"),
            ("孤立.md", "没有链接也没有标签\n"),
        ]))
    }

    #[test]
    fn plan_site_lists_pages_in_path_order_with_frontmatter_titles() {
        let plan = sample();

        // 页面按 relPath 字节序（UTF-8 字节序，与 `paths()` 同一顺序；不是拼音/笔画）：
        // 乙 U+4E59 < 孤 U+5B64 < 引 U+5F15 < 深 U+6DF1 < 甲 U+7532 < 项 U+9879
        let order: Vec<&str> = plan
            .pages
            .iter()
            .map(|page| page.rel_path.as_str())
            .collect();
        assert_eq!(
            order,
            vec![
                "乙/同名.md",
                "孤立.md",
                "引用.md",
                "深层/子目录/笔记.md",
                "甲/同名.md",
                "项目/设计.md",
                "项目/路线图.md",
            ],
            "页面顺序必须与索引的 paths() 字节序一致（前端不做二次排序）"
        );

        assert_eq!(
            page(&plan, "项目/设计.md").title,
            "设计文档",
            "frontmatter 的 title 优先"
        );
        assert_eq!(page(&plan, "项目/路线图.md").title, "路线图");
        assert_eq!(
            page(&plan, "孤立.md").title,
            "孤立",
            "没有 title → 文件名主干"
        );
        assert_eq!(page(&plan, "项目/设计.md").page_path, "项目/设计.html");
        assert_eq!(
            page(&plan, "项目/设计.md").url_path,
            "%E9%A1%B9%E7%9B%AE/%E8%AE%BE%E8%AE%A1.html"
        );

        // 标签：归一化键去重 + 按键字典序 + 保留首次出现的写法
        assert_eq!(page(&plan, "项目/设计.md").tags, vec!["架构", "项目"]);
        assert_eq!(
            page(&plan, "项目/路线图.md").tags,
            vec!["项目"],
            "正文行内标签也进计划"
        );
        assert!(page(&plan, "孤立.md").tags.is_empty());

        // 概况口径
        assert_eq!(plan.stats.notes, 7);
        assert_eq!(plan.stats.pages, 7, "每篇笔记都有页面");
        assert_eq!(plan.stats.links, 9);
        assert_eq!(plan.stats.dangling, 1, "只有 [[没有这篇]] 悬空");
        assert_eq!(plan.stats.assets, 0, "图片清单由前端收集（见模块文档）");
        assert!(plan.assets.is_empty());
        assert!(plan.stats.renamed.is_empty(), "这个 Vault 没有重名");
        assert!(
            plan.vault_name.is_empty() && plan.output_dir.is_none() && plan.previous.is_none(),
            "这三个字段只有宿主知道，plan_site 一律留空"
        );
    }

    #[test]
    fn plan_site_resolves_wikilinks_with_the_index_rules() {
        let plan = sample();
        let design = page(&plan, "项目/设计.md");

        // 链接按正文出现顺序，原文写法一字不差（前端拿它当查表键）
        assert_eq!(
            targets(design),
            vec!["路线图", "路线图", "", "没有这篇", "子目录/笔记.md"]
        );

        // ① 裸名：同目录优先 → `[[路线图]]` 解析到 项目/路线图.md
        assert_eq!(
            link(design, "路线图").href.as_deref(),
            Some("%E8%B7%AF%E7%BA%BF%E5%9B%BE.html")
        );
        assert_eq!(link(design, "路线图").display, "路线图");

        // ② 别名：显示文本用别名，href 与不带别名的那条完全相同
        assert_eq!(design.links[1].target, "路线图");
        assert_eq!(design.links[1].display, "路线图别名");
        assert_eq!(design.links[1].href, design.links[0].href);

        // ③ 锚点（自引用 `[[#设计目标]]`）：target 是空串、href 是编码后的片段
        assert_eq!(link(design, "").target, "");
        assert_eq!(link(design, "").anchor.as_deref(), Some("设计目标"));
        assert_eq!(
            link(design, "").href.as_deref(),
            Some("#%E8%AE%BE%E8%AE%A1%E7%9B%AE%E6%A0%87")
        );

        // ④ 后缀匹配：`[说明](子目录/笔记.md)` 实际在更深一层（`by_suffix` 那条兜底）
        assert_eq!(
            link(design, "子目录/笔记.md").href.as_deref(),
            Some("../%E6%B7%B1%E5%B1%82/%E5%AD%90%E7%9B%AE%E5%BD%95/%E7%AC%94%E8%AE%B0.html")
        );

        // ⑤ 相对路径写法：`[设计](设计.md)` 相对当前笔记所在目录
        assert_eq!(
            link(page(&plan, "项目/路线图.md"), "设计.md")
                .href
                .as_deref(),
            Some("%E8%AE%BE%E8%AE%A1.html")
        );

        // ⑥ 歧义消解：同名两篇（甲/同名.md、乙/同名.md）路径等长 → 取字典序更小的那篇。
        //    选择可复现是重点（同样的 Vault 每次导出都要指向同一页）
        let quoted = page(&plan, "引用.md");
        assert_eq!(
            link(quoted, "同名").href.as_deref(),
            Some("%E4%B9%99/%E5%90%8C%E5%90%8D.html")
        );
        // ⑦ 带锚点的普通链接：片段编码后接在目标页面之后
        assert_eq!(
            link(quoted, "设计").href.as_deref(),
            Some("%E9%A1%B9%E7%9B%AE/%E8%AE%BE%E8%AE%A1.html#%E8%AE%BE%E8%AE%A1%E7%9B%AE%E6%A0%87")
        );
        assert_eq!(link(quoted, "设计").anchor.as_deref(), Some("设计目标"));
        assert_eq!(link(quoted, "设计").display, "设计");
    }

    #[test]
    fn plan_site_marks_dangling_links_as_null_href() {
        let plan = sample();

        let dangling = link(page(&plan, "项目/设计.md"), "没有这篇");
        assert_eq!(dangling.href, None, "解析不到 → href 为 null（悬空）");
        assert_eq!(dangling.display, "没有这篇", "悬空也要给出显示文本");
        assert_eq!(dangling.target, "没有这篇", "原文写法要一字不差地留着");
        assert!(dangling.anchor.is_none());

        // 悬空计数与 `href.is_none()` 的条数必须一致（前端按这个数报"有 N 条悬空链接"）
        let counted = plan
            .pages
            .iter()
            .flat_map(|page| page.links.iter())
            .filter(|link| link.href.is_none())
            .count();
        assert_eq!(counted, plan.stats.dangling);

        // 图片嵌入也在 links 里且通常悬空：前端渲染成 `<img>`、不查这张表，
        // 但**不能因此少一条** —— 少了就是一次查表落空（见 SiteLink::target 的文档）
        let with_image = plan_site(&index_of(&[("甲.md", "![[图.png]] 与 ![](图.png)\n")]));
        let links = &with_image.pages[0].links;
        assert_eq!(links.len(), 2, "两种图片写法都要抽出来：{links:?}");
        assert!(links.iter().all(|link| link.href.is_none()));
        assert_eq!(with_image.stats.dangling, 2);
        assert_eq!(
            with_image.pages[0].links[1].target, "图.png",
            "`![](图.png)` 的目标同样逐字保留"
        );
    }

    #[test]
    fn plan_site_emits_hrefs_relative_to_each_page() {
        let plan = sample();

        // 同目录 → 就是文件名
        assert_eq!(
            link(page(&plan, "项目/路线图.md"), "设计.md")
                .href
                .as_deref(),
            Some("%E8%AE%BE%E8%AE%A1.html")
        );
        // 根页面 → 子目录：往下走
        assert_eq!(
            link(page(&plan, "引用.md"), "设计").href.as_deref(),
            Some("%E9%A1%B9%E7%9B%AE/%E8%AE%BE%E8%AE%A1.html#%E8%AE%BE%E8%AE%A1%E7%9B%AE%E6%A0%87")
        );
        // 深层 → 别的子树：往上走两级（href 相对**本页**，不是相对站点根）
        let deep = page(&plan, "深层/子目录/笔记.md");
        assert_eq!(deep.page_path, "深层/子目录/笔记.html");
        assert_eq!(
            link(deep, "项目/设计").href.as_deref(),
            Some("../../%E9%A1%B9%E7%9B%AE/%E8%AE%BE%E8%AE%A1.html")
        );
        assert_eq!(link(deep, "项目/设计").display, "设计文档", "别名优先");

        // 同一个目标、不同的来源页 → href 各自相对自己（这是"相对链接"的全部含义）
        let from_project = link(page(&plan, "项目/设计.md"), "子目录/笔记.md")
            .href
            .clone()
            .unwrap();
        let from_root = link(page(&plan, "引用.md"), "设计").href.clone().unwrap();
        assert!(from_project.starts_with("../"), "实际：{from_project}");
        assert!(!from_root.starts_with("../"), "实际：{from_root}");
    }

    #[test]
    fn plan_site_uses_the_same_resolution_as_the_backlinks() {
        let mut index = index_of(&[
            ("项目/设计.md", "正文\n"),
            ("项目/路线图.md", "[[设计]] 与 [设计](设计.md)\n"),
            ("其他/笔记.md", "[[项目/设计|设计]]\n"),
            ("自引用.md", "[[#小节]] 与 [[自引用]]\n"),
        ]);
        let plan = plan_site(&index);

        // 交叉验证：导出的反链必须与**应用里那份反链**逐条相同（含"自引用不算反链"这一条）。
        // 两份规则一旦漂移，这里就是唯一能发现它的地方
        for page in &plan.pages {
            let mut expected: Vec<String> = index
                .backlinks_of(&page.rel_path)
                .into_iter()
                .map(|backlink| backlink.from_rel_path)
                .collect();
            expected.sort();
            expected.dedup();
            assert_eq!(
                page.backlinks, expected,
                "{} 的反链与 LinkIndex::backlinks_of 对不上",
                page.rel_path
            );
        }

        // 具体形状也要对：同目录的两条链接（wikilink + markdown）只算一个来源
        assert_eq!(
            page(&plan, "项目/设计.md").backlinks,
            vec!["其他/笔记.md".to_string(), "项目/路线图.md".to_string()]
        );
        assert!(
            page(&plan, "自引用.md").backlinks.is_empty(),
            "自引用（`[[#小节]]` / `[[自引用]]`）不算反链，与反链面板同一口径"
        );
        assert!(page(&plan, "项目/路线图.md").backlinks.is_empty());
    }

    #[test]
    fn plan_site_is_byte_identical_for_the_same_vault() {
        let index = index_of(&[
            (
                "项目/设计.md",
                "---\ntitle: 设计\ntags: [b, A, a]\n---\n\n[[路线图]] [[没有这篇]] [[#锚点]]\n",
            ),
            ("项目/设计.markdown", "同名主干，谁也不指向\n"),
            ("项目/路线图.md", "[[设计|别名]]\n"),
        ]);

        let first = plan_site(&index);
        let second = plan_site(&index);

        // Plan 的序列化是纯函数（字段顺序固定、没有 HashMap 参与输出），所以"两棵相等的树"
        // 就等价于"逐字节相同的 JSON"。本 crate 不依赖 serde_json（不许动 Cargo.toml），
        // 因此这里用 Debug 串做逐字节比对 —— 它覆盖每个字段与每个字符串
        assert_eq!(first, second, "同一个 Vault 连续 plan 两次必须完全相等");
        assert_eq!(
            format!("{first:?}"),
            format!("{second:?}"),
            "逐字节比对：任何一处顺序不稳定都会在这里现形"
        );

        // 重名改名同样是确定的：字节序更小的 `项目/设计.markdown` 保留原名
        assert_eq!(first.stats.renamed.len(), 1);
        assert_eq!(first.stats.renamed[0].rel_path, "项目/设计.md");
        assert_eq!(first.stats.renamed[0].page_path, "项目/设计-2.html");
        assert_eq!(
            page(&first, "项目/设计.markdown").page_path,
            "项目/设计.html"
        );
        assert_eq!(page(&first, "项目/设计.md").page_path, "项目/设计-2.html");

        // 标签的"键排序 + 首次写法"也是确定的：`A` 与 `a` 是同一个键，显示用先出现的那个
        assert_eq!(page(&first, "项目/设计.md").tags, vec!["A", "b"]);
    }
}
