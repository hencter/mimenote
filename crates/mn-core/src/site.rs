//! 整库导出为静态站点：**与文件系统无关的那一半规则**。
//!
//! 产物是"每篇笔记一个 HTML、双链变成可点的相对链接、零 JavaScript"的纯静态站点。
//! 这件事被切成三层，本模块是最下面那一层：**纯函数**。
//!
//! * 本层只回答三个问题 —— 哪些文件算笔记（[`is_markdown_note`]）、每篇的站内页面叫什么
//!   （[`page_rel_path_for`] / [`reserve_page_paths`]）、从这一页到那一页的相对链接长什么样
//!   （[`relative_href`]）。它不碰文件系统、不认识索引、不知道 Vault 在哪里，因此可以
//!   脱离一切环境单测；
//! * 索引层（`mn_index::site`）拿这些规则 + 链接索引算出"这一趟要写哪些页面、每页的链接
//!   与标签、有哪些悬空链接"；
//! * 宿主层（`apps/desktop/src-tauri/src/site_export.rs`）负责路径校验与落盘。
//!
//! # 为什么渲染不在 Rust 侧
//!
//! Markdown → HTML 的**唯一**管线在前端（`apps/desktop/src/domain/markdown.ts` 的
//! `renderMarkdown` + DOMPurify）。在 Rust 侧引入第二个渲染器会让语法口径与 XSS 防线
//! **同时分叉**：同一篇笔记在预览里和在导出站点里渲染成不同的东西，而"哪一处该消毒"
//! 也随即变成两个答案（一份要长期维护的方言，代价远超它省下的那一次 IPC）。
//! 所以宿主只出**计划**（页面路径、链接解析、URL 分配），正文由前端渲染后回传落盘。
//!
//! # 为什么百分号编码自己写
//!
//! 规则只有一条："放行 `A-Za-z0-9-._~`（RFC 3986 的 unreserved 集合），其余按 UTF-8
//! **逐字节**转义成 `%XX`，十六进制**大写**"，三十行以内就能写完。为它引一个依赖，
//! 代价是**编码口径的最终解释权在别人手里**，而中文文件名、空格、`#` 恰好是这个功能的
//! 核心场景：`C# 笔记.md` 里的 `#` 不转义就会被当成 URL 片段分隔符，链接直接断在 `#` 上。
//! 大写十六进制也是刻意的 —— 同一个 Vault 连导两次必须逐字节相同，
//! 大小写等价只是浏览器的宽容度，不是我们能依赖的产物性质。
//!
//! # 站点布局
//!
//! ```text
//! <输出目录>/
//!   index.html                  索引页（前端生成，SITE_INDEX_FILE）
//!   assets/site.css             样式（前端生成，SITE_CSS_FILE）
//!   assets/附件/图.png          图片（原 Vault 相对路径照搬，SITE_ASSET_DIR）
//!   项目/设计.html              每篇笔记一个页面
//!   mimenote-export.json        标记文件（SITE_MARKER_FILE：这个目录是我们写的唯一凭证）
//! ```
//!
//! 页面路径与笔记路径**同构**（各级目录与文件名主干逐字保留，只换扩展名），所以站内链接
//! 与 Vault 里的双链一样"看着就能猜出来"：`项目/设计.md` ↔ `项目/设计.html`。

use std::collections::HashSet;

use serde::Serialize;

/// 站内索引页的固定文件名（前端生成，**最后一批**写出）。
pub const SITE_INDEX_FILE: &str = "index.html";

/// 站内样式表的固定位置（前端生成，`assets/` 之下）。
pub const SITE_CSS_FILE: &str = "assets/site.css";

/// 图片落点的固定前缀：`附件/图.png` → `assets/附件/图.png`。
///
/// 为什么把图片集中到 `assets/` 而不是原地照搬：站点的顶层要能一眼看出"哪些是我的内容"。
/// 集中之后"删掉整个 `assets/`"就是一个自洽的操作，而散落的图片做不到这一点。
/// 前缀之下的相对结构照搬 Vault，是为了保留"图在哪一类笔记旁边"这个信息。
pub const SITE_ASSET_DIR: &str = "assets";

/// 标记文件名：证明"这个目录是我们上次写的"。
///
/// 覆盖策略完全建立在它之上（见宿主层 `site_export.rs`）：目录非空但没有这个标记，
/// 就一律当成"别人的目录"拒绝写入 —— 用户很可能选了一个装满自己东西的目录。
pub const SITE_MARKER_FILE: &str = "mimenote-export.json";

/// 是不是一篇 Markdown 笔记（`.md` / `.markdown`，大小写不敏感）。
pub fn is_markdown_note(rel_path: &str) -> bool {
    note_extension(rel_path).is_some()
}

/// 笔记扩展名（不含点，固定小写）；不是笔记 → `None`。
///
/// 为什么要有一个私有的**唯一**判定入口：`is_markdown_note` 与 `page_rel_path_for` 必须对
/// "什么算笔记"给出同一个答案。两处各写一份的后果是"索引收进来了、导出却不给它页面"，
/// 而这种偏差只会在少数文件名上出现（`.MD`、`.markdown`、`a.md.txt`），最难被发现。
fn note_extension(rel_path: &str) -> Option<&'static str> {
    let name = rel_path.rsplit(['/', '\\']).next()?;
    let (_, extension) = name.rsplit_once('.')?;
    if extension.eq_ignore_ascii_case("md") {
        Some("md")
    } else if extension.eq_ignore_ascii_case("markdown") {
        Some("markdown")
    } else {
        None
    }
}

/// 文件名主干（不含目录与扩展名）：`a/b/Note.md` → `Note`。
///
/// 这条规则原本是 `mn-index` 里私有的 `stem_of`，图谱的"没有 frontmatter title 就用文件名主干"
/// 与导出的"页面标题"必须是**同一把尺子** —— 两处各写一份，就会出现"图谱里的卡片叫 `Note`、
/// 导出站点里那一页叫 `Note.md`"这种只在没写 title 的笔记上出现的偏差。
///
/// 为什么它落在 `site` 而不是更中性的 `mn-core::links`：本模块拿到的只是"文件名主干"，
/// 而它最重要的用途就是"页面标题与页面路径都从这里派生"。真正需要它的是索引层，
/// 索引层已经改为调用这里（`mn-index` 的 `stem_of` 现在只是一层转发），规则因此只有一份。
///
/// 边界（与既有实现逐字一致，**不要**顺手"修好"）：`rfind('.')` 落在位置 0 时
/// （`.gitignore`）返回整个名字，而不是空串 —— 索引里的 `by_stem` 键就是这么建的。
pub fn document_stem(rel_path: &str) -> Option<String> {
    let name = rel_path.rsplit(['/', '\\']).next()?;
    match name.rfind('.') {
        Some(0) | None => Some(name.to_string()),
        Some(index) => Some(name[..index].to_string()),
    }
}

/// 一篇笔记在站点里的页面路径：`项目/设计.md` → `项目/设计.html`；非笔记 → `None`。
///
/// 只换最后一段的扩展名，目录结构逐字保留（中文、空格、`#`、`.` 都原样带着 ——
/// 它们能不能进 URL 由 [`encode_url_path`] 处理，不该在这里被"清洗"掉：
/// 站内路径是**给人看的**，被清洗过的路径会与 Vault 里的名字对不上，用户找不到那一页）。
///
/// 反斜杠会先归一成 `/`：索引里的路径已经是 POSIX，但这条规则也可能被别的调用方
/// 拿 `Path::to_string_lossy` 的结果喂进来，静默产出一个 `项目\设计.html` 比报错更难查。
pub fn page_rel_path_for(rel_path: &str) -> Option<String> {
    let extension = note_extension(rel_path)?;
    let name = rel_path.rsplit(['/', '\\']).next()?;
    let stem = name.get(..name.len() - extension.len() - 1)?;
    // 只剩扩展名的文件（`.md`）没有名字可以给页面：扫描器一般不会收录它，
    // 但这里不能凭"一般不会"就产出一个叫 `.html` 的隐藏文件
    if stem.is_empty() {
        return None;
    }
    let dir = site_rel_dir(rel_path);
    Some(if dir.is_empty() {
        format!("{stem}.html")
    } else {
        format!("{dir}/{stem}.html")
    })
}

/// 页面所在的目录（站内相对、POSIX；根目录 = `""`）。
pub fn site_rel_dir(page_rel_path: &str) -> String {
    match page_rel_path.rfind(['/', '\\']) {
        Some(index) => page_rel_path[..index].replace('\\', "/"),
        None => String::new(),
    }
}

/// 一次"因为重名被改了名"的记录。
///
/// 字段名是 IPC 契约的一部分（前端的 `SiteRename`），一律 camelCase。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRename {
    /// 源笔记的 Vault 相对路径（POSIX）。
    pub rel_path: String,
    /// 它实际得到的站内页面路径（与自然结果不同，例如 `设计-2.html`）。
    pub page_path: String,
}

/// 给一批笔记分配站内页面路径，返回**与入参一一对应**的页面路径 + 被改名清单。
///
/// 入参是笔记的 Vault 相对路径（`plan_site` 传的是索引里排好序的 `paths()`）。
/// 非笔记（[`page_rel_path_for`] 返回 `None`）在对应位置得到空串、也不参与占位与改名 ——
/// 调用方应当先用 [`is_markdown_note`] 过滤；`plan_site` 拿到的本来就是索引里的笔记。
///
/// # 冲突从哪来
///
/// 同一个目录下的 `设计.md` 与 `设计.markdown` 都映射到 `设计.html`。Windows/macOS 的
/// 文件系统不区分大小写，所以冲突判定也按**小写**做（`A.md` 与 `a.md` 在同一个目录里
/// 本来也存不下两份）；站内页面的名字必须与所在文件系统的规则一致，否则第二个文件会
/// **静默覆盖**第一个 —— 那是导出里最糟的一类失败：站点能打开，内容却少了几篇。
///
/// # 谁保留原名（这条规则与"入参顺序"无关）
///
/// 组内平局按**源笔记路径的字节序**决定，而不是入参顺序：入参顺序由调用方决定，
/// 如果它能改变结果，"同一个 Vault 得到同一个站"就变成"调用方每次都按同一个顺序传"。
/// `plan_site` 传的是 `paths()`（已排序），所以生产路径上两条规则重合；
/// 一旦将来有人从别处喂进一个未排序的列表，确定性也不会因此丢掉。
///
/// 后缀是 `-2`、`-3`……并且会**避开已被别的笔记占用的名字**：
/// 目录里真的有 `设计-2.md` 时，被改名的那一篇会落到 `设计-3.html`，
/// 而不是覆盖真名就叫 `设计-2` 的那一篇。分配顺序因此也必须是全局确定的
/// （按"自然页面路径 → 源路径 → 入参下标"排序后依次认领）。
pub fn reserve_page_paths(notes: &[String]) -> (Vec<String>, Vec<PageRename>) {
    let natural: Vec<Option<String>> = notes.iter().map(|rel| page_rel_path_for(rel)).collect();

    // 认领顺序：先按自然页面路径（小写，与文件系统的判定一致），再按源路径，最后按下标 ——
    // 三级都相等的两篇只可能是入参里的重复项，此时谁先谁后无关紧要，但顺序必须固定
    let mut order: Vec<usize> = (0..notes.len()).collect();
    order.sort_by(|&left, &right| {
        let left_key = natural[left].as_deref().unwrap_or("").to_lowercase();
        let right_key = natural[right].as_deref().unwrap_or("").to_lowercase();
        left_key
            .cmp(&right_key)
            .then_with(|| notes[left].cmp(&notes[right]))
            .then_with(|| left.cmp(&right))
    });

    let mut pages: Vec<String> = vec![String::new(); notes.len()];
    let mut taken: HashSet<String> = HashSet::new();
    let mut renamed: Vec<PageRename> = Vec::new();

    for index in order {
        let Some(base) = natural[index].as_deref() else {
            continue;
        };
        let page_path = claim_page_path(base, &mut taken);
        if page_path != base {
            renamed.push(PageRename {
                rel_path: notes[index].clone(),
                page_path: page_path.clone(),
            });
        }
        pages[index] = page_path;
    }

    // 改名清单按源路径排序：结果不能依赖认领顺序（那是实现细节），前端要的是一个稳定清单
    renamed.sort_by(|left, right| left.rel_path.cmp(&right.rel_path));
    (pages, renamed)
}

/// 从 `base` 出发认领一个还没被占用的页面路径（`设计.html` → `设计-2.html` → `设计-3.html`…）。
///
/// `taken` 里存的是**小写**的已占用路径（文件系统口径）。理论上这个名字空间是无限的，
/// 实践上循环次数不会超过笔记数：每次迭代要么成功、要么说明这个名字已被别人占用。
fn claim_page_path(base: &str, taken: &mut HashSet<String>) -> String {
    let (stem, extension) = match base.rfind('.') {
        Some(index) => (&base[..index], &base[index..]),
        None => (base, ""),
    };
    let mut counter = 1u32;
    loop {
        let candidate = if counter == 1 {
            base.to_string()
        } else {
            format!("{stem}-{counter}{extension}")
        };
        if taken.insert(candidate.to_lowercase()) {
            return candidate;
        }
        counter += 1;
    }
}

/// 一个路径段的百分号编码（放行 `A-Za-z0-9-._~`，其余按 UTF-8 逐字节转义，十六进制大写）。
///
/// 不区分"路径段"与"片段"之外的任何语义：`/` 会被编码成 `%2F`，因此**调用方必须先按 `/`
/// 切段**（用 [`encode_url_path`]），否则整条路径会被编成一个段。
pub fn encode_url_segment(segment: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";

    let mut out = String::with_capacity(segment.len());
    for byte in segment.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(*byte as char);
            continue;
        }
        out.push('%');
        out.push(HEX[usize::from(byte >> 4)] as char);
        out.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    out
}

/// 站内相对路径的百分号编码：逐段编码、`/` 原样保留。
pub fn encode_url_path(page_rel_path: &str) -> String {
    page_rel_path
        .split('/')
        .map(encode_url_segment)
        .collect::<Vec<_>>()
        .join("/")
}

/// 片段（`#锚点`）的百分号编码。
///
/// 与路径段同一套放行集合，`/` 也照常编码成 `%2F`：片段里的 `/` 没有任何结构含义，
/// 编掉它才能保证"同一个锚点只有一种写法"，也让"路径段"与"片段"不会因为同一条规则
/// 产生两种理解（这正是最容易在后续改动里被写歪的地方）。
pub fn encode_anchor(anchor: &str) -> String {
    encode_url_segment(anchor)
}

/// 从 `from_page` 指向 `to_page` 的相对链接（逐段编码 + 可选 `#片段`）。
///
/// 参数都是**页面路径**（站内相对、POSIX），不是笔记路径 —— 笔记路径要先过
/// [`page_rel_path_for`]。悬空链接没有目标页面，调用方应当直接给 `null`，不要调这里。
///
/// # 同页链接为什么返回"文件名本身"而不是空串或 `#`
///
/// `from == to` 且没有片段时，最省事的写法是空串或 `#`，两者都被否掉了：
///
/// * 空串的 `href=""` 在 HTML 里表示"当前文档"，但它是**唯一**一个会被 `<base>`、
///   `<a>` 的解析基准、以及部分历史渲染怪癖影响的写法，而相对路径在所有浏览器里
///   都是同一件事；
/// * `#` 会让浏览器跳到页首 —— 用户在文末点一个"指向本页"的链接，页面滚回顶部，
///   这不是"什么都没发生"，而是一次看得见的错位。
///
/// 有片段时（`[[#小节]]` 这类自引用）返回 `#片段`：它同样不依赖文件名，
/// 页面被改名也不会失效。这是**刻意的**，测试钉住了它。
pub fn relative_href(from_page: &str, to_page: &str, anchor: Option<&str>) -> String {
    let fragment = match anchor.filter(|fragment| !fragment.is_empty()) {
        Some(fragment) => format!("#{}", encode_anchor(fragment)),
        None => String::new(),
    };

    if from_page == to_page {
        if !fragment.is_empty() {
            return fragment;
        }
        return to_page
            .rsplit(['/', '\\'])
            .next()
            .map(encode_url_segment)
            .unwrap_or_default();
    }

    let from_dir = site_rel_dir(from_page);
    let from_segments: Vec<&str> = from_dir
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    let mut to_segments: Vec<&str> = to_page
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    let to_name = to_segments.pop();

    // 公共前缀之外，从当前页往上走几层就补几个 `..`（`..` 的两个点都是 unreserved，
    // 会被原样保留 —— 它们必须保持字面量，浏览器才会按"上一级"解释）
    let common = from_segments
        .iter()
        .zip(&to_segments)
        .take_while(|(left, right)| left == right)
        .count();

    let mut parts: Vec<String> = Vec::with_capacity(from_segments.len() + to_segments.len());
    for _ in common..from_segments.len() {
        parts.push("..".to_string());
    }
    for segment in &to_segments[common..] {
        parts.push(encode_url_segment(segment));
    }
    if let Some(name) = to_name {
        parts.push(encode_url_segment(name));
    }

    let mut href = parts.join("/");
    href.push_str(&fragment);
    href
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notes(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_string()).collect()
    }

    #[test]
    fn page_path_maps_markdown_notes_to_sibling_html() {
        assert_eq!(
            page_rel_path_for("项目/设计.md").as_deref(),
            Some("项目/设计.html")
        );
        assert_eq!(
            page_rel_path_for("深层/更深/甲.markdown").as_deref(),
            Some("深层/更深/甲.html")
        );
        // 大小写不敏感：扩展名换成大写照样是笔记，页面扩展名一律小写
        assert_eq!(page_rel_path_for("甲.MD").as_deref(), Some("甲.html"));
        assert_eq!(page_rel_path_for("甲.Markdown").as_deref(), Some("甲.html"));
        // 反斜杠先归一成 `/`（站内路径一律 POSIX）
        assert_eq!(
            page_rel_path_for(r"项目\设计.md").as_deref(),
            Some("项目/设计.html")
        );
        // 主干里的点不参与判断（只有最后一段扩展名算数）
        assert_eq!(
            page_rel_path_for("v1.2/发布说明.md").as_deref(),
            Some("v1.2/发布说明.html")
        );
        assert!(is_markdown_note("项目/设计.md"));
        assert!(is_markdown_note("项目/设计.MARKDOWN"));
    }

    #[test]
    fn page_path_rejects_non_notes() {
        for not_a_note in [
            "附件/图.png",
            "导出/站点.html",
            "a.md.txt",
            "没有扩展名",
            "a.markdown.bak",
        ] {
            assert_eq!(
                page_rel_path_for(not_a_note),
                None,
                "{not_a_note} 不该有页面"
            );
            assert!(!is_markdown_note(not_a_note), "{not_a_note} 不该算笔记");
        }

        // 只剩扩展名：按扩展名它确实是 `.md`，但**没有名字可以给页面** ——
        // 硬造一个 `.html`（隐藏文件）比不给页面更糟，所以这里只拒页面、不拒笔记
        assert!(is_markdown_note(".md"));
        assert_eq!(page_rel_path_for(".md"), None);
        assert_eq!(page_rel_path_for("深层/.markdown"), None);
    }

    #[test]
    fn page_path_keeps_cjk_and_spaces() {
        // 站内路径是给人看的：中文、空格、`#`、`&` 都原样保留，编码是 URL 那一层的事
        assert_eq!(
            page_rel_path_for("读书笔记/《代码大全》 第 1 章.md").as_deref(),
            Some("读书笔记/《代码大全》 第 1 章.html")
        );
        assert_eq!(
            page_rel_path_for("C# 笔记.md").as_deref(),
            Some("C# 笔记.html")
        );
        assert_eq!(
            page_rel_path_for("A&B/甲.md").as_deref(),
            Some("A&B/甲.html")
        );
        assert_eq!(site_rel_dir("根页面.html"), "", "根目录是空串");
        assert_eq!(site_rel_dir("a/b/c.html"), "a/b");
    }

    #[test]
    fn reserve_page_paths_appends_a_deterministic_suffix() {
        // 同一目录、同一主干：只换扩展名的那两个撞在一起
        let (pages, renamed) = reserve_page_paths(&notes(&["设计.md", "设计.markdown", "别的.md"]));
        assert_eq!(pages.len(), 3, "出参与入参一一对应");
        assert_eq!(pages[2], "别的.html", "没冲突的原样保留");
        assert_eq!(
            renamed.len(),
            1,
            "只有真正被改名的那一篇进清单：{renamed:?}"
        );
        assert_eq!(renamed[0].page_path, "设计-2.html");
        // 组内平局按源路径字节序（`设计.markdown` 的 'a' < `设计.md` 的 'd'）
        assert_eq!(renamed[0].rel_path, "设计.md");
        assert_eq!(pages[1], "设计.html");
        assert_eq!(pages[0], "设计-2.html");

        // 入参换序后**映射**不变（不是"集合不变"）：结果不能依赖调用方给的顺序
        let (reordered, renamed_again) =
            reserve_page_paths(&notes(&["别的.md", "设计.markdown", "设计.md"]));
        assert_eq!(reordered[2], "设计-2.html");
        assert_eq!(reordered[1], "设计.html");
        assert_eq!(reordered[0], "别的.html");
        assert_eq!(renamed_again, renamed, "改名清单也要一字不差");

        // 目录不同就不冲突（同名不同目录是两篇不同的笔记）
        let (same_stem, none_renamed) = reserve_page_paths(&notes(&["甲/设计.md", "乙/设计.md"]));
        assert_eq!(same_stem, notes(&["甲/设计.html", "乙/设计.html"]));
        assert!(none_renamed.is_empty());
    }

    #[test]
    fn reserve_page_paths_avoids_names_that_already_exist() {
        // `设计-2.html` 是真实存在的页面：被改名的那一篇必须继续往后退，而不是覆盖它
        let (pages, renamed) =
            reserve_page_paths(&notes(&["设计-2.md", "设计.md", "设计.markdown"]));
        assert_eq!(pages[0], "设计-2.html", "真名就叫设计-2 的那篇保留原样");
        assert_eq!(pages[1], "设计-3.html");
        assert_eq!(pages[2], "设计.html");
        assert_eq!(renamed.len(), 1);
        assert_eq!(renamed[0].rel_path, "设计.md");
        assert_eq!(renamed[0].page_path, "设计-3.html");

        // 大小写不同的同名（同一目录里存不下两份，站内也不能让它们互相覆盖）
        let (cased, cased_renamed) = reserve_page_paths(&notes(&["Report.md", "report.markdown"]));
        assert_eq!(cased.len(), 2);
        assert_ne!(
            cased[0].to_lowercase(),
            cased[1].to_lowercase(),
            "小写形式也必须不同：{cased:?}"
        );
        assert_eq!(cased_renamed.len(), 1);

        // 非笔记不占位、也不改名（对应位置是空串，调用方要先过滤）
        let (mixed, mixed_renamed) = reserve_page_paths(&notes(&["图.png", "设计.md"]));
        assert_eq!(mixed[0], "");
        assert_eq!(mixed[1], "设计.html");
        assert!(mixed_renamed.is_empty());
    }

    #[test]
    fn url_encoding_escapes_hash_space_percent_and_cjk() {
        assert_eq!(
            encode_url_path("C# 笔记.html"),
            "C%23%20%E7%AC%94%E8%AE%B0.html"
        );
        // `%` 自己也要转义，否则 `%41` 会被解码回 `A`（往返不成立）
        assert_eq!(encode_url_segment("100%"), "100%25");
        assert_eq!(encode_url_segment("%41"), "%2541");
        // 逐段编码：`/` 是结构，不是内容
        assert_eq!(
            encode_url_path("项目/设计.html"),
            "%E9%A1%B9%E7%9B%AE/%E8%AE%BE%E8%AE%A1.html"
        );
        assert_eq!(
            encode_url_segment("项目/设计.html"),
            "%E9%A1%B9%E7%9B%AE%2F%E8%AE%BE%E8%AE%A1.html"
        );
        // 十六进制大写（同一份 Vault 逐字节可复现的前提之一）
        assert_eq!(encode_url_segment("中"), "%E4%B8%AD");
        assert_eq!(encode_url_segment("\u{feff}"), "%EF%BB%BF");
        // 锚点走同一套规则
        assert_eq!(encode_anchor("小节 一"), "%E5%B0%8F%E8%8A%82%20%E4%B8%80");
        assert_eq!(encode_anchor("a/b"), "a%2Fb");
    }

    #[test]
    fn url_encoding_leaves_unreserved_characters_alone() {
        for segment in [
            "abc",
            "ABC",
            "0123456789",
            "a-b",
            "a_b",
            "a.b",
            "a~b",
            "-._~",
            "aG9vZA",
        ] {
            assert_eq!(encode_url_segment(segment), segment, "{segment} 不该被编码");
        }
        // 保留字符一律编码（RFC 3986 的 reserved 集合里挑几个常见的）
        assert_eq!(encode_url_segment("a b"), "a%20b");
        assert_eq!(encode_url_segment("a?b"), "a%3Fb");
        assert_eq!(encode_url_segment("a&b"), "a%26b");
        assert_eq!(encode_url_segment("a=b"), "a%3Db");
        assert_eq!(encode_url_segment("a[b]"), "a%5Bb%5D");
        assert_eq!(encode_url_segment("a+b"), "a%2Bb");
        // 空段编码成空串（路径里的空段由调用方负责，编码器不改结构）
        assert_eq!(encode_url_segment(""), "");
    }

    #[test]
    fn relative_href_walks_up_and_down_the_tree() {
        // 同目录（中文段一律编码：href 是要交给浏览器的，不是给人看的）
        assert_eq!(
            relative_href("项目/设计.html", "项目/路线图.html", None),
            "%E8%B7%AF%E7%BA%BF%E5%9B%BE.html"
        );
        // 根页面 → 子目录
        assert_eq!(
            relative_href(SITE_INDEX_FILE, "项目/设计.html", None),
            "%E9%A1%B9%E7%9B%AE/%E8%AE%BE%E8%AE%A1.html"
        );
        // 子目录 → 根
        assert_eq!(
            relative_href("项目/设计.html", SITE_INDEX_FILE, None),
            "../index.html"
        );
        // 兄弟目录：先上一级再下一级
        assert_eq!(
            relative_href("项目/设计.html", "其他/笔记.html", None),
            "../%E5%85%B6%E4%BB%96/%E7%AC%94%E8%AE%B0.html"
        );
        // 深层 → 浅层
        assert_eq!(relative_href("a/b/c.html", "a/x.html", None), "../x.html");
        assert_eq!(relative_href("a/b/c.html", "y.html", None), "../../y.html");
        // 公共前缀之外的层级差决定 `..` 的个数（`a` 与 `ab` 不是同一级）
        assert_eq!(relative_href("a/b.html", "ab/c.html", None), "../ab/c.html");
        // 每一段都要编码（含 `..` 之外的中文与空格）
        assert_eq!(
            relative_href("根.html", "项目/设计 稿.html", None),
            "%E9%A1%B9%E7%9B%AE/%E8%AE%BE%E8%AE%A1%20%E7%A8%BF.html"
        );
        assert_eq!(
            relative_href("项目/设计.html", "项目/C# 笔记.html", None),
            "C%23%20%E7%AC%94%E8%AE%B0.html"
        );
        // `..` 必须保持字面量（两个点都是 unreserved，编码之后浏览器就不认了）
        assert!(relative_href("a/b/c.html", "y.html", None).starts_with("../../"));
    }

    #[test]
    fn relative_href_keeps_the_encoded_anchor() {
        assert_eq!(
            relative_href("项目/设计.html", "项目/路线图.html", Some("小节一")),
            "%E8%B7%AF%E7%BA%BF%E5%9B%BE.html#%E5%B0%8F%E8%8A%82%E4%B8%80"
        );
        assert_eq!(
            relative_href(SITE_INDEX_FILE, "项目/设计.html", Some("设计 目标")),
            "%E9%A1%B9%E7%9B%AE/%E8%AE%BE%E8%AE%A1.html#%E8%AE%BE%E8%AE%A1%20%E7%9B%AE%E6%A0%87"
        );
        // 空片段等同于没有片段（`[[笔记#]]` 会被抽取成 `Some("")`）
        assert_eq!(
            relative_href("a.html", "b.html", Some("")),
            "b.html",
            "空片段不能产出一个孤零零的 `#`"
        );
        // 纯锚点自引用（`[[#小节]]`）：目标就是本页，链接不依赖文件名
        assert_eq!(
            relative_href("项目/设计.html", "项目/设计.html", Some("小节")),
            "#%E5%B0%8F%E8%8A%82"
        );
    }

    #[test]
    fn relative_href_into_the_same_page_is_still_usable() {
        // 同页、没有片段：返回**文件名本身**（不是空串、不是 `#`）—— 见函数文档里的取舍
        assert_eq!(
            relative_href("项目/设计.html", "项目/设计.html", None),
            "%E8%AE%BE%E8%AE%A1.html"
        );
        assert_eq!(
            relative_href(SITE_INDEX_FILE, SITE_INDEX_FILE, None),
            "index.html"
        );
        assert_eq!(
            relative_href("C# 笔记.html", "C# 笔记.html", None),
            "C%23%20%E7%AC%94%E8%AE%B0.html"
        );
        // 没有片段时绝不能是 `#`（会让浏览器跳到页首）
        for same in ["a.html", "项目/设计.html"] {
            let href = relative_href(same, same, None);
            assert!(
                !href.is_empty() && href != "#",
                "同页无片段必须是文件名：{href}"
            );
        }
    }

    #[test]
    fn document_stem_rules_match_the_index() {
        assert_eq!(document_stem("a/b/Note.md").as_deref(), Some("Note"));
        assert_eq!(document_stem("甲").as_deref(), Some("甲"));
        assert_eq!(document_stem("a/b.c/d.md").as_deref(), Some("d"));
        // 位置 0 上的点：返回整个名字（与索引里 `by_stem` 的建键口径逐字一致）
        assert_eq!(document_stem(".gitignore").as_deref(), Some(".gitignore"));
        assert_eq!(document_stem("").as_deref(), Some(""));
    }
}
