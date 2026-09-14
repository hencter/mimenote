//! 标签抽取：frontmatter 的 `tags`/`tag` 字段 + 正文行内 `#标签`。
//!
//! 职责边界（与 [`crate::links`] 同一风格）：
//!
//! * 只做"从一段文本里找出标签"这件事 —— 不解析 Markdown AST、不碰文件系统、不建索引；
//! * **忠实抽取**：返回原始写法（`TagRef::tag`，不含 `#`）与**行号**，判同/去重另走
//!   [`normalize_tag`]（那是给索引用的一致性键）；
//! * 不解析 `[[链接]]`（[`crate::links`] 的事）；`[[笔记#小节]]` 里的 `#` 因为前面不是空白，
//!   天然不会被误抽。
//!
//! # 行内 `#标签` 的判定规则
//!
//! 一个 `#` 要成为标签，必须同时满足：
//!
//! 1. **前面是行首或空白**（`a#b`、`https://x#y`、`[[笔记#小节]]` 都不会被误抽）；
//! 2. 后面至少跟一个标签字符，字符集为：Unicode 字母数字（**包含汉字、假名、谚文**）、
//!    `_`、`-`、`/`（`/` 用于 `#父/子` 层级，尾随的 `/` 会被去掉）；
//! 3. 整个标签**至少含一个非数字字符** —— 所以 `#123`（issue 号）不是标签，而
//!    `#2025回顾`、`#1-2-3` 是（判定口径就是"至少一个非数字字符"，不是"必须字母开头"）；
//! 4. 不在以下区域里：frontmatter 区块、围栏代码块（```/~~~）、行内代码（`` ` `` 与
//!    `` `` `` 都能配对）、HTML 注释（`<!-- -->`，可跨行）、Markdown 标题行。
//!
//! ## 标题 vs 标签（最容易踩的地方，这里把判定写死）
//!
//! 一行的第一个非空白字符是 `#` 时：
//!
//! | 写法 | 判定 | 理由 |
//! | --- | --- | --- |
//! | `# 标题` | **标题行**（整行不抽标签） | 标准 ATX 标题 |
//! | `##标题`、`### 标题` | **标题行** | `#` 连续 2 个以上一律按标题处理（"漏空格"的常见写法） |
//! | `#标签` | **标签** | 单个 `#` 后直接跟标签字符 —— 这是"一行一标签"的写法，Obsidian 也这样认 |
//!
//! 也就是说：`#` 一次性出现且后面直接是标签字符才算标签；出现 ≥2 个 `#` 时全行当标题。
//! 想换成"行首一律当标题"，只需要改 [`heading_line`] 一处。
//!
//! 标题行是**整行**跳过，所以 `# 标题里写 #标签` 不会抽出 `#标签`（标题里的 `#` 太小概率是标签，
//! 而误抽标题文本的代价更高）。
//!
//! ## 刻意不支持
//!
//! * **缩进代码块**（4 空格缩进）里的 `#标签` 仍会被抽出 —— 与 [`crate::links`] 对 `[[链接]]`
//!   的口径一致（只认围栏与行内代码）；
//! * 转义之外的 Markdown 语法（引用、列表、表格）不做特殊处理：`- #标签`、`> #标签` 照常算标签；
//! * 表格/链接里的 `#` 只有在"前面是空白"时才可能成为标签，`[x](y#z)`、`[[笔记#小节]]` 天然被规则 1 挡掉。
//!
//! # 去重
//!
//! 同一篇笔记里重复的标签只保留**首次出现**的那条（含 frontmatter 与正文之间的重复：
//! frontmatter 先输出，所以它的位置与写法胜出）。判同用 [`normalize_tag`] ——
//! 因此 `#Rust` 与 `#rust` 在索引里是同一个标签，但**返回的 `tag` 保留首次出现的写法**。
//!
//! # 重命名与合并（[`rename_tags`]）
//!
//! 本模块除了"抽取"还有一种**改写**：[`TagRename`] 描述"`甲` 改成 `乙`"（或"合并进 `乙`"），
//! [`rename_tags`] 把一篇文本里所有命中它的标签换掉，并如实返回改了几处、按纪律跳过了哪些地方。
//! 语义（层级、去重、跳过判据）全部写在 [`rename_tags`] 与 [`TagRename`] 的文档里，
//! 宿主只负责"读文件 → 调它 → 原子写 → 同步索引"。
//!
//! 一段历史值得写在这里：M2 起，正文行内 `#标签` 对写入路径是**只读**的
//! （删它等于改正文，那是编辑器的活）。本条边界只在**重命名/合并**上被打破，
//! 因为不改正文的重命名是假的（旧标签仍然挂在笔记上，索引与面板一起说谎）；
//! 打开它的代价是必须把"哪里不是标签"的判据原样复用（同一个 [`BodyScanner`]）。

use std::collections::HashSet;

use serde::Serialize;

use crate::frontmatter;

/// 标签来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TagSource {
    /// frontmatter 的 `tags` / `tag` 字段。
    Frontmatter,
    /// 正文行内 `#标签`。
    Inline,
}

/// 抽取到的一个标签。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagRef {
    /// 显示用写法：**不含开头的 `#`**（是否需要 `#` 前缀由 UI 决定），保留原有大小写与层级。
    pub tag: String,
    /// 来源。
    pub source: TagSource,
    /// 行号（**1 起**，与 [`crate::links::LinkRef::line`] 语义一致）。
    ///
    /// frontmatter 的块数组取"项自己"的行号，行内数组与标量取字段所在行。
    pub line: u32,
}

/// 抽取文本中的所有标签（frontmatter 在前、正文在后，各自按出现顺序，已去重）。
pub fn extract_tags(text: &str) -> Vec<TagRef> {
    let mut out: Vec<TagRef> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for (tag, line) in frontmatter::tag_occurrences(text) {
        push_tag(&mut out, &mut seen, tag, TagSource::Frontmatter, line);
    }

    // 正文起点：跳过 frontmatter 区块（否则区块里的 `# 注释` 行会被当成标签）
    let body_start = frontmatter::region_end(text).unwrap_or(0);
    let base_line = text[..body_start].matches('\n').count() as u32;
    let mut scanner = BodyScanner::default();

    for (index, raw_line) in text[body_start..].split('\n').enumerate() {
        let line_no = base_line + index as u32 + 1;
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        for span in scanner.scan_spans(line) {
            push_tag(&mut out, &mut seen, span.tag, TagSource::Inline, line_no);
        }
    }

    out
}

/// 归一化标签，得到**用于建索引的键**：
///
/// 1. 去首尾空白；
/// 2. 去掉开头的 `#`（`#标签` 与 `标签` 是同一个）；
/// 3. 连续的空白折叠成一个空格（中文标签通常没有空白，此步对 CJK 无影响）；
/// 4. 转小写（CJK 无大小写概念，转换是恒等；目的是让 `Rust`/`rust` 归到同一个键）；
/// 5. 连续的 `/` 折叠成一个，再去掉首尾的 `/`（`#父/子/` 与 `父/子` 等价）。
///
/// 注意：返回值是**键**，不是给人看的显示文本 —— 显示请用 [`TagRef::tag`]。
/// 空串（或只有空白/`#`/`/`）会归一化成空串，调用方应跳过。
pub fn normalize_tag(raw: &str) -> String {
    let without_hash = raw
        .trim()
        .trim_start_matches('#')
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ");

    let mut out = String::with_capacity(without_hash.len());
    let mut previous_slash = false;
    for c in without_hash.to_lowercase().chars() {
        if c == '/' {
            // 开头的 `/` 与连续的 `/` 都丢弃
            if out.is_empty() || previous_slash {
                continue;
            }
            previous_slash = true;
            out.push(c);
        } else {
            previous_slash = false;
            out.push(c);
        }
    }
    out.trim_end_matches('/').to_string()
}

/// 在一个**既有的标签列表**上做增删，返回新的列表（显示写法，保序、按 [`normalize_tag`] 去重）。
///
/// 为什么要单独一个纯函数：标签面板的"加标签/删标签"最终都归结为同一个问题 ——
/// "改完之后这篇的标签列表是什么"。把它做成纯函数，宿主就只需要
/// `parse(...).tags → 本函数 → frontmatter::set_tags_or_create`，没有一处自己拼列表，
/// 判同也只有 [`normalize_tag`] 一份（与索引、面板高亮、`set_tags` 的清理同源）。
///
/// 规则：
///
/// * `remove` **按归一化键匹配**：传 `#Rust` 也能删掉 `rust`（判同只有一份）；
///   既有标签的**写法与顺序原样保留**（不重排、不改大小写）；
/// * `add` 先清理：去首尾空白与开头的 `#`，并把中间的连续空白折叠成一个空格 ——
///   折叠口径与 [`normalize_tag`] 一致，而且带换行的标签会写出一个跨行的引号标量、
///   把整个区块切成两半（本模块与 `frontmatter` 都按行解析，读回来就散了）；
/// * 已经存在的（归一化键命中）**不重复加入**；`add` 里自己重复的只进第一个；
/// * 无法归一化的输入（`""`、`"#"`、纯空白）一律忽略；
/// * 结果顺序 = 既有顺序（去掉被删的） + 新标签按输入顺序追加。
pub fn apply_tag_edits(existing: &[String], add: &[String], remove: &[String]) -> Vec<String> {
    let removed: HashSet<String> = remove
        .iter()
        .map(|raw| normalize_tag(raw))
        .filter(|key| !key.is_empty())
        .collect();

    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for tag in existing {
        let key = normalize_tag(tag);
        if key.is_empty() || removed.contains(&key) || !seen.insert(key) {
            continue;
        }
        out.push(tag.clone());
    }

    for raw in add {
        let Some(tag) = clean_input(raw) else {
            continue;
        };
        let key = normalize_tag(&tag);
        if key.is_empty() || !seen.insert(key) {
            continue;
        }
        out.push(tag);
    }

    out
}

/// 把用户输入的一个标签清理成**能安全写进 YAML 一行**的形式；空输入返回 `None`。
fn clean_input(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_start_matches('#').trim();
    let collapsed = trimmed.split_whitespace().collect::<Vec<&str>>().join(" ");
    (!collapsed.is_empty()).then_some(collapsed)
}

// ---------------------------------------------------------------------------
// 标签的层级编辑（把 `甲` 挂到 `父` 下面 / 从 `父/甲` 提回顶层）
// ---------------------------------------------------------------------------

/// 「把标签移到某个父标签下」算出来的目标**键**；算不出来就是一次非法移动，附带原因。
///
/// 为什么做成纯函数而不是在命令里拼字符串：层级编辑只有两种形态（挂到某个父标签下、
/// 提回顶层），但**非法组合比合法组合多** —— 挂到自己下面、挂到自己的后代下面、已经在那里了、
/// 父标签里写了空段。这些判定必须在写盘**之前**就拦住，而且要能脱离文件系统单测。
///
/// 规则（三条，都只与层级有关）：
/// 1. **只换祖先，不动名字**：末段是这个标签自己的名字，始终保留 ——
///    `父/甲` 提回顶层是 `甲`（不是 `父/甲`），`甲` 挂到 `母` 下是 `母/甲`；
/// 2. `parent` 归一化后为空 = **提回顶层**；否则目标 = `父/末段`；
/// 3. 目标与源相同 → 明确说"已经在那个父标签下面了"，而不是当作无操作静默成功。
///
/// 注意：这里**不检查**"目标键是否已经被别的标签占用" —— 那是"移动"与"合并"的分界，
/// 只有拿着全库标签概览的调用方（宿主命令）才判得了，见 `commands.rs` 的 `tag_move`。
pub fn tag_move_target(key: &str, parent: &str) -> Result<String, &'static str> {
    let from_key = normalize_tag(key);
    if from_key.is_empty() {
        return Err("标签名称为空，无法调整层级");
    }
    let leaf = match from_key.rsplit_once('/') {
        Some((_, leaf)) => leaf.to_string(),
        None => from_key.clone(),
    };

    let cleaned_parent = clean_input(parent).unwrap_or_default();
    // 首尾的 `/` 容忍（常见的输入滑手），**全是 `/` 就等同于"提回顶层"**
    // （`#/甲` 这类写法在别处也是这个意思）；只有**中间的空段**才拒绝：
    // `父//子` 归一化之后会变成 `父/子`，与用户看到的东西不是一回事，宁可不猜。
    let trimmed_parent = cleaned_parent.trim_matches('/');
    if !trimmed_parent.is_empty() && trimmed_parent.split('/').any(|segment| segment.is_empty()) {
        return Err("父标签里不能有空的层级（`父//子`）");
    }

    let parent_key = normalize_tag(parent);
    if parent_key == from_key {
        return Err("不能把标签挂到它自己下面");
    }
    if parent_key
        .strip_prefix(&from_key)
        .is_some_and(|rest| rest.starts_with('/'))
    {
        return Err("不能把标签挂到它自己的子标签下面（会造出改不完的层级）");
    }

    let target = if parent_key.is_empty() {
        leaf
    } else {
        format!("{parent_key}/{leaf}")
    };
    if target == from_key {
        return Err("它已经在那个父标签下面了");
    }
    Ok(target)
}

// ---------------------------------------------------------------------------
// 标签的重命名 / 合并
// ---------------------------------------------------------------------------

/// 一次"标签改名（或合并）"的映射：`甲` → `乙`，可选地把层级子标签一起带走。
///
/// 为什么把映射做成一个**类型**而不是三个参数：判同、层级、新写法这三件事在
/// "改 frontmatter"与"改正文行内"两条路径上必须完全一致 —— 一个类型带着
/// [`TagRename::apply`]，两条路径就只有一份判定（见 `rename_tags`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagRename {
    /// 源标签的**归一化键**（与索引、面板高亮、`apply_tag_edits` 同一把尺子）。
    from_key: String,
    /// 新写法：已清理（去 `#`、折叠空白）、保留用户输入的大小写与层级。
    to_display: String,
    /// 是否连同层级子标签一起带走（`父` → `母` 时 `父/子` → `母/子`）。
    include_children: bool,
}

impl TagRename {
    /// 由用户输入构造映射；任一侧归一化后为空（`""`、`"#"`、只有空白/`/`）→ `None`。
    pub fn new(from: &str, to: &str, include_children: bool) -> Option<Self> {
        let from_key = normalize_tag(from);
        let to_display = clean_input(to)?;
        (!from_key.is_empty()).then_some(Self {
            from_key,
            to_display,
            include_children,
        })
    }

    /// 源键（归一化后）。
    pub fn from_key(&self) -> &str {
        &self.from_key
    }

    /// 新写法（显示用；不是键）。
    pub fn to_display(&self) -> &str {
        &self.to_display
    }

    /// 新写法的归一化键。与 [`TagRename::from_key`] 相等时，这次操作是**写法统一**
    /// （`rust` → `Rust`）而不是真正的"换成另一个标签"—— 两者的去重口径不同，见 [`rename_tags`]。
    pub fn to_key(&self) -> String {
        normalize_tag(&self.to_display)
    }

    /// 是否连同子标签一起改。
    pub fn include_children(&self) -> bool {
        self.include_children
    }

    /// 某个**归一化键**是否在这次改名的范围内（源键本身，或它的后代）。
    ///
    /// 给宿主筛候选集用：标签索引按"键 → 笔记"倒排，想知道"哪些笔记会被这次改名影响"，
    /// 就得先问出"哪些键在范围内"。判定与 [`TagRename::apply`] 共用同一段前缀逻辑。
    pub fn covers_key(&self, key: &str) -> bool {
        if key == self.from_key {
            return true;
        }
        self.include_children
            && key
                .strip_prefix(&self.from_key)
                .is_some_and(|rest| rest.starts_with('/'))
    }

    /// 单个标签（原始写法）在这个映射下应该变成什么；不受影响 → `None`。
    ///
    /// * 归一化键与源键相同 → 换成新写法（**大小写/层级写法也会被统一成新写法**，
    ///   因为"改整条"就是用户要的：`#RUST` 与 `#rust` 是同一个标签，改名之后不该一个变一个不变）；
    /// * 是源键的**后代**且 `include_children` → 换掉前缀那一段，后缀**逐字保留**
    ///   （`父/子` → `母/子`；后缀的大小写与写法是用户的，我们只动被改名的那一段）。
    pub fn apply(&self, tag: &str) -> Option<String> {
        let key = normalize_tag(tag);
        if key.is_empty() {
            return None;
        }
        if key == self.from_key {
            return Some(self.to_display.clone());
        }
        if !self.include_children {
            return None;
        }
        let suffix = descendant_suffix(tag, &self.from_key)?;
        Some(format!("{}/{suffix}", self.to_display))
    }
}

/// 取后代标签里**源标签那一段之后**的原文（含原有大小写）；不是后代 → `None`。
///
/// 按 `/` 切段、只比较前 `depth` 段（归一化后与源键相等），因此
/// `父/子` / `父//子` / ` 父 / 子 ` 都能认出前缀，而 `父老/子`（前缀只是"看起来像"）不会。
fn descendant_suffix(tag: &str, from_key: &str) -> Option<String> {
    let depth = from_key.split('/').count();
    let segments: Vec<&str> = tag
        .trim()
        .trim_start_matches('#')
        .trim()
        .split('/')
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .collect();
    if segments.len() <= depth {
        return None;
    }
    if normalize_tag(&segments[..depth].join("/")) != from_key {
        return None;
    }
    Some(segments[depth..].join("/"))
}

/// 一次标签改写在一篇文本上的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagRewrite {
    /// 改写后的整篇文本。
    pub text: String,
    /// frontmatter 里被改写的条数（含因合并被去掉的重复项）。
    pub frontmatter_edits: u32,
    /// 正文里被换成新写法的 `#标签` 个数。
    pub inline_edits: u32,
    /// 正文里因合并被**去掉**的重复提及数（见 [`rename_tags`] 的"合并"一节）。
    pub inline_removed: u32,
}

/// 把**一整篇文本**里的标签按 `mapping` 改写；一篇都不用改 → `None`。
///
/// 这是"标签重命名/合并"的纯函数核心：文件系统、写锁、索引同步全在宿主层，
/// 本函数只回答"这篇文本改完之后长什么样、改了几处"。宿主因此可以对每个文件
/// 复用同一份判定（并如实汇报改了几处、哪些地方按纪律没动）。
///
/// # 改哪些地方
///
/// 1. **frontmatter**：`tags` **与** `tag` 两个字段都改（[`crate::frontmatter::rename_tag_fields`]），
///    最小 diff、BOM/CRLF/注释/未知键保真；
/// 2. **正文行内 `#标签`** —— 这是本函数存在的理由，也是它与 `note_set_tags` 最大的区别。
///    `note_set_tags` 只改 frontmatter（正文里的行内标签是用户的文字，面板不该替他动），
///    但**重命名**不改正文就是假的：`#甲` 留在正文里，改名后的笔记仍然挂着旧标签，
///    索引、面板、图谱会一起说谎。所以打开这条边界的前提是**跳过判据必须与抽取器完全一致**：
///    围栏代码块、行内代码、HTML 注释、frontmatter 区块、Markdown 标题行里的 `#甲`
///    一个都不动（复用同一个 [`BodyScanner`]，判定只有一份）。
///
/// # 合并（目标标签已经存在）时为什么要去掉重复项
///
/// 把 `甲` 合并进 `乙` 时，一篇笔记里可能**两个都有**：`tags: [甲, 乙]`、正文 `#甲 #乙`。
/// 若只是逐处替换，结果会是 `tags: [乙, 乙]` 与 `#乙 #乙` —— 前者在索引里被去重后看不见，
/// 但用户在磁盘上看得见那行重复的 YAML，后者一眼就是机器写坏的样子。因此判定改成：
///
/// * 目标键**在原文里已经出现过**（frontmatter 或正文都算）→ 这一处正文提及是重复的，
///   连同它旁边的一段空白一起去掉；
/// * 目标键原本不在这一篇里（纯改名）→ 一处不动地逐处改写，`#甲 #甲` 仍然是 `#乙 #乙`
///   （改名不该顺手删用户的提及）。
///
/// 这个判据只用"原文里有没有目标标签"，与处理顺序无关，因此同一篇文本的结果是确定的。
///
/// 一处例外：新写法的**归一化键与源键相同**时（`rust` → `Rust` 这类写法统一），
/// 目标标签当然"已经在原文里出现过"（就是它自己），去重会让每一处提及都被删掉。
/// 因此这种情况只改写写法、不去重。
pub fn rename_tags(text: &str, mapping: &TagRename) -> Option<TagRewrite> {
    // 原文里出现过的**全部**标签键：合并时用它回答"目标标签是不是已经在别处出现"。
    // 先算出来（改完再算就被自己的改写污染了）
    let present: HashSet<String> = extract_tags(text)
        .into_iter()
        .map(|tag| normalize_tag(&tag.tag))
        .filter(|key| !key.is_empty())
        .collect();
    // 只有"换成另一个键"才需要去重（见函数文档的例外）
    let merging = mapping.to_key() != mapping.from_key();

    let (text, frontmatter_edits) =
        match crate::frontmatter::rename_tag_fields(text, |tag| mapping.apply(tag)) {
            Some(outcome) if outcome.edits > 0 => (outcome.text, outcome.edits),
            _ => (text.to_string(), 0),
        };

    let (text, inline_edits, inline_removed) = rename_inline(&text, mapping, &present, merging);

    if frontmatter_edits == 0 && inline_edits == 0 && inline_removed == 0 {
        return None;
    }
    Some(TagRewrite {
        text,
        frontmatter_edits,
        inline_edits,
        inline_removed,
    })
}

/// 改写正文（frontmatter 之后的部分）里命中映射的行内标签。
///
/// 返回 `(新文本, 换掉的处数, 去掉的处数)`。行尾（`\r\n` / `\n`）逐字保留：
/// 只在"确实有命中"的行上重建内容，且重建用的还是原来那一段换行。
fn rename_inline(
    text: &str,
    mapping: &TagRename,
    present: &HashSet<String>,
    merging: bool,
) -> (String, u32, u32) {
    let body_start = crate::frontmatter::region_end(text).unwrap_or(0);
    let mut out = String::with_capacity(text.len());
    out.push_str(&text[..body_start]);

    let mut scanner = BodyScanner::default();
    let mut edits = 0u32;
    let mut removed = 0u32;

    for chunk in text[body_start..].split_inclusive('\n') {
        let has_eol = chunk.ends_with('\n');
        let content = chunk.strip_suffix('\n').unwrap_or(chunk);
        let has_cr = content.ends_with('\r');
        let line = if has_cr {
            &content[..content.len() - 1]
        } else {
            content
        };

        let spans = scanner.scan_spans(line);
        let mut rewritten: Option<String> = None;

        if !spans.is_empty() {
            let chars: Vec<char> = line.chars().collect();
            let mut ranges: Vec<(usize, usize, String)> = Vec::new();

            for span in spans {
                let Some(mapped) = mapping.apply(&span.tag) else {
                    continue;
                };
                let replace_key = normalize_tag(&mapped);
                if merging && present.contains(&replace_key) {
                    // 合并：目标标签已经在别处出现 → 这一处提及是重复的，整条去掉
                    if let Some(range) = removal_range(&chars, span.start, span.end) {
                        ranges.push((range.0, range.1, String::new()));
                        removed += 1;
                    }
                    continue;
                }
                if mapped == span.tag {
                    // 映射结果与原文一字不差（例如把 `Rust` 改名成 `rust` 时遇到的那一条）
                    continue;
                }
                ranges.push((span.start, span.end, format!("#{mapped}")));
                edits += 1;
            }

            if !ranges.is_empty() {
                let mut rebuilt = String::with_capacity(line.len());
                let mut cursor = 0usize;
                for (start, end, replacement) in ranges {
                    rebuilt.extend(chars[cursor..start].iter());
                    rebuilt.push_str(&replacement);
                    cursor = end;
                }
                rebuilt.extend(chars[cursor..].iter());
                rewritten = Some(rebuilt);
            }
        }

        match rewritten {
            Some(new_line) => {
                out.push_str(&new_line);
                if has_cr {
                    out.push('\r');
                }
            }
            None => out.push_str(content),
        }
        if has_eol {
            out.push('\n');
        }
    }

    (out, edits, removed)
}

/// 去掉一处标签提及时要连带的空白：优先吃掉**标签之后**的空白串，
/// 标签正好在行尾时改吃**它之前**的空白串（否则行尾会留下一截尾巴空白）。
///
/// 只吃空白、绝不越界到别的字符上 —— `正文#甲` 这种不成立（`#` 前必须是空白），
/// 所以"前面那段空白"最多就是分隔用的那一小段。
fn removal_range(chars: &[char], start: usize, end: usize) -> Option<(usize, usize)> {
    if start >= end || end > chars.len() {
        return None;
    }
    let is_space = |c: char| c == ' ' || c == '\t';

    let mut after = end;
    while after < chars.len() && is_space(chars[after]) {
        after += 1;
    }
    if after > end {
        return Some((start, after));
    }

    let mut before = start;
    while before > 0 && is_space(chars[before - 1]) {
        before -= 1;
    }
    Some((before, end))
}

/// 是否是标签字符（字母数字含 Han/假名/谚文，另有 `_`、`-`、层级分隔符 `/`）。
fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '-' | '/')
}

/// 标签正文是否成立：非空且**至少一个非数字字符**（挡掉 `#123` 这类 issue 号）。
fn is_tag_body(raw: &str) -> bool {
    !raw.is_empty() && raw.chars().any(|c| !c.is_numeric())
}

/// 行首是否构成 Markdown 标题（判定表见模块文档）。
fn heading_line(trimmed: &str) -> bool {
    let run = trimmed.chars().take_while(|c| *c == '#').count();
    if run >= 2 {
        return true;
    }
    // 单个 `#`：后面是空白或行尾 → 标题；直接跟标签字符 → 交给标签判定
    run == 1 && matches!(trimmed.chars().nth(1), None | Some(' ' | '\t'))
}

/// 入栈（按归一化键去重）。
fn push_tag(
    out: &mut Vec<TagRef>,
    seen: &mut HashSet<String>,
    tag: String,
    source: TagSource,
    line: u32,
) {
    let key = normalize_tag(&tag);
    if key.is_empty() || !seen.insert(key) {
        return;
    }
    out.push(TagRef { tag, source, line });
}

/// 正文扫描器的跨行状态（围栏代码块、HTML 注释）。
#[derive(Default)]
struct BodyScanner {
    /// 围栏代码块：(围栏字符, 长度)。
    fence: Option<(char, usize)>,
    /// 是否在 `<!-- -->` 里（可跨行）。
    in_comment: bool,
}

/// 行内一个 `#标签` 的位置（**行内字符偏移**，不含换行符）。
///
/// 为什么抽取器要顺带给出位置：标签的**重命名/合并必须改正文**（否则"改过名"是假的），
/// 而改正文就得知道"改动落在哪几个字符上"。让重写路径复用**同一个**扫描器，
/// 而不是照着判定规则再写一份 —— 两份判定的漂移（例如代码块少跳一处）会表现为
/// "抽出来的标签改了，另一处没改"，是最难排查的一类不一致。
#[derive(Debug, Clone, PartialEq, Eq)]
struct TagSpan {
    /// 标签原文（**不含**开头的 `#`，保留大小写与层级）。
    tag: String,
    /// `#` 的下标。
    start: usize,
    /// 整条标签末尾的下标（开区间，指向最后一个标签字符之后）。
    end: usize,
}

impl BodyScanner {
    /// 扫描一行，返回该行抽到的标签及其行内位置。
    fn scan_spans(&mut self, line: &str) -> Vec<TagSpan> {
        let trimmed = line.trim_start();

        if let Some((marker, length)) = self.fence {
            if fence_close(trimmed, marker, length) {
                self.fence = None;
            }
            return Vec::new();
        }
        if !self.in_comment {
            if let Some(open) = fence_open(trimmed) {
                self.fence = Some(open);
                return Vec::new();
            }
            if heading_line(trimmed) {
                return Vec::new();
            }
        }
        // 已经在注释里时不能整行跳过：这一行可能带着 `-->` 把注释关掉

        let chars: Vec<char> = line.chars().collect();
        let mut out = Vec::new();
        let mut index = 0usize;
        // 行内代码围栏长度：`` ` `` 与 `` `` `` 必须各自配对
        let mut code_ticks: Option<usize> = None;

        while index < chars.len() {
            if self.in_comment {
                if starts_with(&chars, index, &['-', '-', '>']) {
                    self.in_comment = false;
                    index += 3;
                } else {
                    index += 1;
                }
                continue;
            }

            let current = chars[index];

            if let Some(ticks) = code_ticks {
                if current == '`' {
                    let run = run_length(&chars, index, '`');
                    if run >= ticks {
                        code_ticks = None;
                    }
                    index += run;
                } else {
                    index += 1;
                }
                continue;
            }

            if current == '`' {
                code_ticks = Some(run_length(&chars, index, '`'));
                index += code_ticks.unwrap_or(1);
                continue;
            }
            // 反斜杠转义：`\#标签` 不是标签（与 links.rs 对 `\[[` 的处理一致）
            if current == '\\' {
                index += 2;
                continue;
            }
            if current == '<' && starts_with(&chars, index + 1, &['!', '-', '-']) {
                self.in_comment = true;
                index += 4;
                continue;
            }
            if current != '#' {
                index += 1;
                continue;
            }

            // 规则 1：`#` 前必须是行首或空白
            let at_boundary = index == 0
                || chars
                    .get(index - 1)
                    .is_some_and(|previous| previous.is_whitespace());
            if !at_boundary {
                index += 1;
                continue;
            }

            let start = index + 1;
            let mut end = start;
            while end < chars.len() && is_tag_char(chars[end]) {
                end += 1;
            }
            // 尾随的 `/` 不算层级分隔符
            while end > start && chars[end - 1] == '/' {
                end -= 1;
            }
            if end > start {
                let raw: String = chars[start..end].iter().collect();
                if is_tag_body(&raw) {
                    out.push(TagSpan {
                        tag: raw,
                        start: index,
                        end,
                    });
                }
            }
            index = end.max(index + 1);
        }

        out
    }
}

/// 围栏代码块的开启标记（``` 或 ~~~，至少 3 个），返回字符与长度。
fn fence_open(trimmed: &str) -> Option<(char, usize)> {
    let mut chars = trimmed.chars();
    let marker = chars.next()?;
    if marker != '`' && marker != '~' {
        return None;
    }
    let length = 1 + chars.take_while(|c| *c == marker).count();
    (length >= 3).then_some((marker, length))
}

/// 是否是给定围栏的结束行（同字符、长度不短于开启、其余只有空白）。
fn fence_close(trimmed: &str, marker: char, length: usize) -> bool {
    let mut chars = trimmed.chars().peekable();
    let mut run = 0;
    while chars.peek() == Some(&marker) {
        chars.next();
        run += 1;
    }
    run >= length && chars.all(|c| c == ' ' || c == '\t')
}

/// 从 `at` 开始连续出现 `target` 的个数。
fn run_length(chars: &[char], at: usize, target: char) -> usize {
    chars[at..].iter().take_while(|c| **c == target).count()
}

/// `chars` 从 `at` 起是否正好是 `pattern`。
fn starts_with(chars: &[char], at: usize, pattern: &[char]) -> bool {
    pattern
        .iter()
        .enumerate()
        .all(|(offset, c)| chars.get(at + offset) == Some(c))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tags(text: &str) -> Vec<String> {
        extract_tags(text).into_iter().map(|t| t.tag).collect()
    }

    // -- 层级编辑（tag_move_target）---------------------------------------------

    #[test]
    fn move_target_nests_and_promotes_by_keeping_the_leaf() {
        // 挂到某个父标签下：名字（末段）保留，只换祖先
        assert_eq!(tag_move_target("甲", "父").unwrap(), "父/甲");
        assert_eq!(tag_move_target("甲", "#父").unwrap(), "父/甲");
        assert_eq!(tag_move_target("父/甲", "母").unwrap(), "母/甲");
        // 深层标签挂到另一支下面：只换**祖先**（末段还是它自己）
        assert_eq!(tag_move_target("父/甲/孙", "母").unwrap(), "母/孙");
        // 提回顶层：parent 为空（或只有 `#`、空白、`/`）
        assert_eq!(tag_move_target("父/甲", "").unwrap(), "甲");
        assert_eq!(tag_move_target("父/甲", "  #  ").unwrap(), "甲");
        assert_eq!(tag_move_target("父/甲/孙", "/").unwrap(), "孙");
        // 本来就在顶层、又提到顶层 → 不是一个合法变化
        assert_eq!(
            tag_move_target("甲", "").unwrap_err(),
            "它已经在那个父标签下面了"
        );
    }

    #[test]
    fn move_target_refuses_the_ways_that_would_break_the_hierarchy() {
        // 挂到自己下面
        assert_eq!(
            tag_move_target("甲", "甲").unwrap_err(),
            "不能把标签挂到它自己下面"
        );
        assert_eq!(
            tag_move_target("甲", "#甲").unwrap_err(),
            "不能把标签挂到它自己下面"
        );
        // 挂到自己的后代下面（会造出 `甲/…/甲` 这种改不完的层级）
        assert!(tag_move_target("甲", "甲/子")
            .unwrap_err()
            .starts_with("不能把标签挂到它自己的子标签下面"));
        assert!(tag_move_target("父/甲", "父/甲/孙").is_err());
        // 父标签里有空段：归一化会悄悄吃掉它，宁可拒绝也不猜
        assert_eq!(
            tag_move_target("甲", "父//子").unwrap_err(),
            "父标签里不能有空的层级（`父//子`）"
        );
        // 空的标签名没有层级可谈
        assert_eq!(
            tag_move_target("   ", "父").unwrap_err(),
            "标签名称为空，无法调整层级"
        );
        assert_eq!(
            tag_move_target("#", "父").unwrap_err(),
            "标签名称为空，无法调整层级"
        );
        // 已经就在那个父标签下面（`父/甲` 挂到 `父` 下 = 什么都没变）
        assert_eq!(
            tag_move_target("父/甲", "父").unwrap_err(),
            "它已经在那个父标签下面了"
        );
    }

    #[test]
    fn move_target_cleans_input_like_the_rename_path() {
        // 大小写与 `#` 都按同一把尺子清理；目标键始终是小写形态
        assert_eq!(tag_move_target("RUST", "工具链").unwrap(), "工具链/rust");
        assert_eq!(tag_move_target("父/甲", " 母 ").unwrap(), "母/甲");
        // 首尾的 `/` 容忍（常见输入滑手），中间的空段拒绝（见上一条测试）
        assert_eq!(tag_move_target("甲", "/父/").unwrap(), "父/甲");
    }

    #[test]
    fn extracts_frontmatter_and_inline_with_sources_and_lines() {
        let text = "---\ntitle: t\ntags: [笔记/甲, 乙]\n---\n\n正文 #丙 与 #丁\n";
        let found = extract_tags(text);
        assert_eq!(
            found,
            vec![
                TagRef {
                    tag: "笔记/甲".into(),
                    source: TagSource::Frontmatter,
                    line: 3
                },
                TagRef {
                    tag: "乙".into(),
                    source: TagSource::Frontmatter,
                    line: 3
                },
                TagRef {
                    tag: "丙".into(),
                    source: TagSource::Inline,
                    line: 6
                },
                TagRef {
                    tag: "丁".into(),
                    source: TagSource::Inline,
                    line: 6
                },
            ]
        );
    }

    #[test]
    fn block_array_tags_use_item_lines() {
        let text = "---\ntags:\n  - 甲\n  - 乙\n---\n正文 #甲\n";
        let found = extract_tags(text);
        assert_eq!(found.len(), 2, "frontmatter 先出现，正文的 #甲 视为重复");
        assert_eq!(found[0].line, 3);
        assert_eq!(found[0].source, TagSource::Frontmatter);
        assert_eq!(found[1].line, 4);
    }

    #[test]
    fn tag_field_is_also_a_source() {
        assert_eq!(tags("---\ntag: 单数\n---\n"), vec!["单数".to_string()]);
        // 逗号分隔的标量
        assert_eq!(
            tags("---\ntags: 甲, 乙\n---\n"),
            vec!["甲".to_string(), "乙".to_string()]
        );
    }

    #[test]
    fn frontmatter_region_is_not_scanned_as_inline() {
        let text = "---\n# 这是一行注释，不是标签\ntitle: t\n---\n正文 #真标签\n";
        assert_eq!(tags(text), vec!["真标签".to_string()]);
    }

    #[test]
    fn hash_must_follow_start_or_whitespace() {
        let text =
            "a#b 不是标签\nhttps://example.com/page#frag 不是\n[[笔记#小节]] 也不是\n但 #真 是\n";
        assert_eq!(tags(text), vec!["真".to_string()]);
    }

    #[test]
    fn numeric_only_tags_are_rejected() {
        let text = "#123 不是\nissue#456 也不是\n#2025回顾 是\n#1-2-3 是\n";
        assert_eq!(
            tags(text),
            vec!["2025回顾".to_string(), "1-2-3".to_string()]
        );
    }

    #[test]
    fn supports_cjk_kana_and_hierarchy() {
        let text = "#中文标签 #ひらがな #カタカナ #父/子/孙 #父/ #a_b-c #日本語123\n";
        assert_eq!(
            tags(text),
            vec![
                "中文标签".to_string(),
                "ひらがな".to_string(),
                "カタカナ".to_string(),
                "父/子/孙".to_string(),
                "父".to_string(),
                "a_b-c".to_string(),
                "日本語123".to_string(),
            ]
        );
    }

    #[test]
    fn stops_at_punctuation_and_whitespace() {
        let text = "#标签，中文逗号结束 #另一个。完成\n#标签(括号) #标签2\t制表符\n";
        assert_eq!(
            tags(text),
            vec![
                "标签".to_string(),
                "另一个".to_string(),
                "标签2".to_string()
            ]
        );
    }

    #[test]
    fn heading_rules_are_pinned() {
        // `# 标题` / `##标题` / `### 标题`：标题行，整行都不抽
        assert_eq!(tags("# 标题 #伪装标签\n"), Vec::<String>::new());
        assert_eq!(tags("##标题\n"), Vec::<String>::new());
        assert_eq!(tags("### 标题\n"), Vec::<String>::new());
        assert_eq!(tags("#\n"), Vec::<String>::new());
        assert_eq!(tags("  ##缩进标题\n"), Vec::<String>::new());
        // 单个 `#` 直接跟标签字符 → 标签（"一行一标签"写法）
        assert_eq!(tags("#标签\n"), vec!["标签".to_string()]);
        assert_eq!(tags("  #缩进的标签\n"), vec!["缩进的标签".to_string()]);
        // 正文中间的标题看起来的行不影响前面的标签
        assert_eq!(
            tags("正文 #甲\n\n# 标题\n\n更多 #乙\n"),
            vec!["甲".to_string(), "乙".to_string()]
        );
    }

    #[test]
    fn skips_fenced_code_blocks() {
        let text = "```\n#不该抽\n```\n正文 #该抽\n~~~text\n#也不该\n~~~\n";
        assert_eq!(tags(text), vec!["该抽".to_string()]);
        // 四个反引号的围栏
        let four = "````\n#不该抽\n```\n还在里面\n````\n#该抽\n";
        assert_eq!(tags(four), vec!["该抽".to_string()]);
    }

    #[test]
    fn skips_inline_code() {
        let text = "`#不该抽` 与 ``#也不该`` 与 #该抽\n";
        assert_eq!(tags(text), vec!["该抽".to_string()]);
    }

    #[test]
    fn skips_html_comments_including_multiline() {
        let text = "<!-- #不该抽 -->\n正文 #该抽\n<!--\n跨行注释 #也不该\n-->\n结尾 #另一个\n";
        assert_eq!(tags(text), vec!["该抽".to_string(), "另一个".to_string()]);
    }

    #[test]
    fn skips_escaped_hash() {
        assert_eq!(tags("\\#不是标签 但 #是标签\n"), vec!["是标签".to_string()]);
    }

    #[test]
    fn dedups_keeping_first_occurrence() {
        let text = "---\ntags: [Rust]\n---\n正文 #rust 与 #Rust 与 #RUST 与 #别\n";
        let found = extract_tags(text);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].tag, "Rust");
        assert_eq!(found[0].source, TagSource::Frontmatter);
        assert_eq!(found[1].tag, "别");
    }

    #[test]
    fn duplicate_inline_keeps_first_line() {
        let found = extract_tags("#甲\n\n\n#甲\n");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].line, 1);
    }

    #[test]
    fn lines_are_absolute_even_with_bom_and_crlf() {
        let text = "\u{feff}---\r\ntags: [甲]\r\n---\r\n\r\n正文 #乙\r\n";
        let found = extract_tags(text);
        assert_eq!(found[0].line, 2);
        assert_eq!(found[1].line, 5);
    }

    #[test]
    fn empty_input_and_no_tags() {
        assert!(extract_tags("").is_empty());
        assert!(extract_tags("纯正文，没有任何标签。\n").is_empty());
        assert!(extract_tags("#🎉 表情不是标签字符\n").is_empty());
        // 未闭合的 frontmatter → 整篇都按正文处理
        assert_eq!(tags("---\n标题\n\n正文 #甲\n"), vec!["甲".to_string()]);
    }

    #[test]
    fn normalize_tag_rules() {
        assert_eq!(normalize_tag("  Rust  "), "rust");
        assert_eq!(normalize_tag("#Rust"), "rust");
        assert_eq!(normalize_tag("##Rust"), "rust");
        assert_eq!(normalize_tag("# 中文标签"), "中文标签");
        assert_eq!(normalize_tag("中文 标签"), "中文 标签");
        assert_eq!(normalize_tag("父/子"), "父/子");
        assert_eq!(normalize_tag("/父/子/"), "父/子");
        assert_eq!(normalize_tag("父//子"), "父/子");
        assert_eq!(normalize_tag("  "), "");
        assert_eq!(normalize_tag("#"), "");
        assert_eq!(normalize_tag("/"), "");
        assert_eq!(normalize_tag("A/B"), "a/b");
        // CJK 不做大小写变换（恒等，钉住行为）
        assert_eq!(normalize_tag("日本語"), "日本語");
    }

    // -- apply_tag_edits（面板加/删标签的纯函数） ----------------------------

    fn owned(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_string()).collect()
    }

    #[test]
    fn apply_tag_edits_appends_keeping_existing_order_and_wording() {
        let existing = owned(&["Rust", "父/子"]);
        let out = apply_tag_edits(&existing, &owned(&["新标签"]), &[]);
        assert_eq!(out, owned(&["Rust", "父/子", "新标签"]));
    }

    #[test]
    fn apply_tag_edits_matches_removals_by_normalized_key_only() {
        // 显示写法是 `Rust`，用户删的是 `#rust` —— 归一化后是同一个标签
        let out = apply_tag_edits(&owned(&["Rust", "乙"]), &[], &owned(&["#RUST"]));
        assert_eq!(out, owned(&["乙"]));
        // 大小写/首尾 `/` 同样只影响判同，不影响剩下的写法
        let out2 = apply_tag_edits(&owned(&["父/子/", "Keep"]), &[], &owned(&["父/子"]));
        assert_eq!(out2, owned(&["Keep"]));
    }

    #[test]
    fn apply_tag_edits_is_idempotent_for_existing_and_duplicate_adds() {
        let existing = owned(&["Rust"]);
        // 加已存在的（写法不同）→ 一个字符都不多
        assert_eq!(apply_tag_edits(&existing, &owned(&["rust"]), &[]), existing);
        // 输入里自己重复 → 只进第一个
        assert_eq!(
            apply_tag_edits(&existing, &owned(&["甲", "#甲", "甲"]), &[]),
            owned(&["Rust", "甲"])
        );
        // 加完再加一次也不变
        let once = apply_tag_edits(&existing, &owned(&["甲"]), &[]);
        assert_eq!(apply_tag_edits(&once, &owned(&["甲"]), &[]), once);
    }

    #[test]
    fn apply_tag_edits_cleans_inputs_but_keeps_existing_wording() {
        let out = apply_tag_edits(
            &owned(&["原样  保留"]),
            &owned(&["  #带井号  ", "多  空白", "", "#", "  "]),
            &[],
        );
        // 既有项一字不改（不能因为我们折叠空白就顺手美化用户磁盘上的写法）
        assert_eq!(
            out,
            owned(&["原样  保留", "带井号", "多 空白"]),
            "换行/连续空白必须折叠成一个空格"
        );
    }

    #[test]
    fn apply_tag_edits_survives_newlines_in_input() {
        // 单行输入框进不来换行，但 IPC 与未来的插件能：带换行的标签会写出跨行标量
        let out = apply_tag_edits(&[], &owned(&["a\nb", "c\td"]), &[]);
        assert_eq!(out, owned(&["a b", "c d"]));
        assert!(!out.iter().any(|tag| tag.contains('\n')));
    }

    #[test]
    fn apply_tag_edits_remove_wins_over_add_in_the_same_call() {
        // 同一次调用里既删又加同一个标签：`remove` 作用于**既有**项，`add` 再追加输入写法
        let out = apply_tag_edits(&owned(&["Rust"]), &owned(&["RUST"]), &owned(&["rust"]));
        assert_eq!(out, owned(&["RUST"]));
    }

    #[test]
    fn apply_tag_edits_does_not_touch_inline_tags() {
        // 行内标签根本不在 frontmatter 列表里：把 frontmatter 的删光，正文的 `#甲` 依旧在
        let text = "---\ntags: [甲]\n---\n\n正文 #甲 与 #乙\n";
        let fm_tags = extract_tags(text)
            .into_iter()
            .filter(|tag| tag.source == TagSource::Frontmatter)
            .map(|tag| tag.tag)
            .collect::<Vec<String>>();
        assert_eq!(fm_tags, owned(&["甲"]));
        assert_eq!(
            apply_tag_edits(&fm_tags, &[], &owned(&["甲"])),
            Vec::<String>::new()
        );
        // 正文里的两个标签仍然抽得到（删 frontmatter 不代表删正文）
        let inline = extract_tags("---\ntags: []\n---\n\n正文 #甲 与 #乙\n")
            .into_iter()
            .filter(|tag| tag.source == TagSource::Inline)
            .map(|tag| tag.tag)
            .collect::<Vec<String>>();
        assert_eq!(inline, owned(&["甲", "乙"]));
    }

    #[test]
    fn is_tag_char_rules() {
        assert!(is_tag_char('a'));
        assert!(is_tag_char('1'));
        assert!(is_tag_char('汉'));
        assert!(is_tag_char('あ'));
        assert!(is_tag_char('ア'));
        assert!(is_tag_char('한'));
        assert!(is_tag_char('_'));
        assert!(is_tag_char('-'));
        assert!(is_tag_char('/'));
        assert!(!is_tag_char('.'));
        assert!(!is_tag_char('#'));
        assert!(!is_tag_char(' '));
        assert!(!is_tag_char('，'));
    }

    // -- TagRename：映射本身（判同、层级、后代后缀） -------------------------

    fn mapping(from: &str, to: &str, children: bool) -> TagRename {
        TagRename::new(from, to, children).expect("这两个输入应当构成一次有效的改名")
    }

    #[test]
    fn tag_rename_rejects_empty_sides() {
        assert!(TagRename::new("", "乙", true).is_none());
        assert!(TagRename::new("   ", "乙", true).is_none());
        assert!(TagRename::new("#", "乙", true).is_none());
        assert!(TagRename::new("/", "乙", true).is_none());
        assert!(TagRename::new("甲", "", true).is_none());
        assert!(TagRename::new("甲", " # ", true).is_none());
        // 开头的 `#` 与多余空白进不来（清理口径与 `apply_tag_edits` 的 add 一致）
        let cleaned = TagRename::new("#甲", "  #乙  丙  ", true).unwrap();
        assert_eq!(cleaned.from_key(), "甲");
        assert_eq!(cleaned.to_display(), "乙 丙");
    }

    #[test]
    fn tag_rename_matches_by_normalized_key_and_rewords_every_writing() {
        let map = mapping("rust", "Rust 语言", false);
        // 大小写、`#` 前缀、首尾 `/` 都不影响判同（判同只有 normalize_tag 一份）
        assert_eq!(map.apply("rust").as_deref(), Some("Rust 语言"));
        assert_eq!(map.apply("RUST").as_deref(), Some("Rust 语言"));
        assert_eq!(map.apply("#Rust").as_deref(), Some("Rust 语言"));
        // 不相关的不动
        assert_eq!(map.apply("其他的"), None);
        assert_eq!(map.apply(""), None);
    }

    #[test]
    fn tag_rename_carries_children_only_when_asked() {
        let with = mapping("父", "母", true);
        assert_eq!(with.apply("父/子").as_deref(), Some("母/子"));
        assert_eq!(with.apply("父/子/孙").as_deref(), Some("母/子/孙"));
        // 后缀逐字保留（大小写是用户写的，只动被改名的那一段）
        assert_eq!(with.apply("父/Sub").as_deref(), Some("母/Sub"));
        // 前缀只是"看起来像"的不算后代
        assert_eq!(with.apply("父老/子"), None);
        assert_eq!(with.apply("父辈"), None);

        let without = mapping("父", "母", false);
        assert_eq!(without.apply("父/子"), None);
        assert_eq!(without.apply("父").as_deref(), Some("母"));
    }

    #[test]
    fn tag_rename_whole_path_and_slash_edge_cases() {
        // "改整条"：源键本身就是一条层级标签
        let map = mapping("父/子", "父/新", true);
        assert_eq!(map.apply("父/子").as_deref(), Some("父/新"));
        assert_eq!(map.apply("父/子/孙").as_deref(), Some("父/新/孙"));
        assert_eq!(map.apply("父"), None, "父不是 父/子 的后代");

        // 目标可以落在别的层级下（改名成一条更深/更浅的路径）
        let moved = mapping("父/子", "笔记/新", false);
        assert_eq!(moved.apply("#父/子/").as_deref(), Some("笔记/新"));

        // 连写的 `/` 与空白不会骗过前缀判定，且后缀取的是**原本的写法**
        let messy = mapping("父", "母", true);
        assert_eq!(messy.apply("父//子").as_deref(), Some("母/子"));
        assert_eq!(messy.apply(" 父 / 子 ").as_deref(), Some("母/子"));
    }

    #[test]
    fn tag_rename_covers_key_filters_the_candidate_set() {
        let map = mapping("父", "母", true);
        assert!(map.covers_key("父"));
        assert!(map.covers_key("父/子"));
        assert!(map.covers_key("父/子/孙"));
        assert!(!map.covers_key("父老"));
        assert!(!map.covers_key("父亲"));
        assert!(!map.covers_key("母"));
        assert!(!map.covers_key(""));

        // 不带子标签时只覆盖源键本身
        let only = mapping("父", "母", false);
        assert!(only.covers_key("父"));
        assert!(!only.covers_key("父/子"));
    }

    #[test]
    fn tag_rename_treats_case_only_change_as_a_reword() {
        let map = mapping("rust", "Rust", false);
        assert_eq!(map.from_key(), "rust");
        assert_eq!(map.to_key(), "rust");
        assert!(map.apply("rust").is_some());
    }

    // -- rename_tags：一整篇文本的改写 ---------------------------------------

    /// 一次改名的断言小工具：`None`（一个字都不用改）时返回原文，
    /// 于是每个用例都能写成"输入 → 输出"的对照。
    fn rewritten(text: &str, map: &TagRename) -> String {
        rename_tags(text, map)
            .map(|out| out.text)
            .unwrap_or_else(|| text.to_string())
    }

    #[test]
    fn rename_touches_frontmatter_lists_scalars_and_blocks() {
        let map = mapping("旧", "新", false);
        assert_eq!(
            rewritten("---\ntags: [旧, 别的]\n---\n正文\n", &map),
            "---\ntags: [新, 别的]\n---\n正文\n"
        );
        // 标量（1 个标签仍是标量）
        assert_eq!(
            rewritten("---\ntags: 旧\n---\n", &map),
            "---\ntags: 新\n---\n"
        );
        // 块数组
        assert_eq!(
            rewritten("---\ntags:\n  - 旧\n  - 别的\n---\n", &map),
            "---\ntags:\n  - 新\n  - 别的\n---\n"
        );
        // 逗号分隔的标量
        assert_eq!(
            rewritten("---\ntags: 旧, 别的\n---\n", &map),
            "---\ntags: [新, 别的]\n---\n"
        );
    }

    #[test]
    fn rename_touches_both_tags_and_tag_fields() {
        // 只改一个字段会让旧写法留在磁盘上（="改了但没改干净"），所以两个都改
        let map = mapping("旧", "新", false);
        assert_eq!(
            rewritten("---\ntags: [旧, 别的]\ntag: 旧\n---\n正文\n", &map),
            "---\ntags: [新, 别的]\ntag: 新\n---\n正文\n"
        );
        // 只有一个 `tag:` 字段时也改它
        assert_eq!(
            rewritten("---\ntag: 旧\n---\n", &map),
            "---\ntag: 新\n---\n"
        );
    }

    #[test]
    fn rename_keeps_bytes_it_does_not_own() {
        let map = mapping("旧", "新", false);
        let text = "\u{feff}---\r\ntitle: 标题 # 行尾注释\r\ntags: [旧] # 也是注释\r\n未知键: 值\r\n---\r\n正文\r\n";
        let out = rewritten(text, &map);
        assert_eq!(
            out,
            "\u{feff}---\r\ntitle: 标题 # 行尾注释\r\ntags: [新] # 也是注释\r\n未知键: 值\r\n---\r\n正文\r\n"
        );
    }

    #[test]
    fn rename_rewrites_inline_occurrences_but_not_code_or_comments() {
        let map = mapping("甲", "乙", false);
        assert_eq!(
            rewritten("正文 #甲 与 #别的\n", &map),
            "正文 #乙 与 #别的\n"
        );
        // 行首单独一行、缩进的标签
        assert_eq!(rewritten("#甲\n", &map), "#乙\n");
        assert_eq!(rewritten("   #甲 尾巴\n", &map), "   #乙 尾巴\n");

        // 围栏代码块里的不动
        let fenced = "```\n#甲\n```\n正文 #甲\n~~~text\n#甲\n~~~\n";
        assert_eq!(
            rewritten(fenced, &map),
            "```\n#甲\n```\n正文 #乙\n~~~text\n#甲\n~~~\n"
        );
        // 行内代码里的不动
        assert_eq!(
            rewritten("`#甲` 与 ``#甲`` 与 #甲\n", &map),
            "`#甲` 与 ``#甲`` 与 #乙\n"
        );
        // HTML 注释（含跨行）里的不动
        assert_eq!(
            rewritten("<!-- #甲 -->\n正文 #甲\n<!--\n跨行 #甲\n-->\n#甲\n", &map),
            "<!-- #甲 -->\n正文 #乙\n<!--\n跨行 #甲\n-->\n#乙\n"
        );
        // frontmatter 区块里的 `#甲` 是注释，不是标签
        assert_eq!(
            rewritten("---\n# 这里写着 #甲 也不算\ntitle: t\n---\n#甲\n", &map),
            "---\n# 这里写着 #甲 也不算\ntitle: t\n---\n#乙\n"
        );
        // 标题行整行跳过
        assert_eq!(rewritten("# 标题里的 #甲\n", &map), "# 标题里的 #甲\n");
        // 转义与"前面不是空白"的 `#` 不动
        assert_eq!(
            rewritten("\\#甲 与 a#甲 与 #甲\n", &map),
            "\\#甲 与 a#甲 与 #乙\n"
        );
        // 纯数字不是标签
        assert_eq!(rewritten("#123 与 #甲2\n", &map), "#123 与 #甲2\n");
    }

    #[test]
    fn rename_reports_counts_and_returns_none_when_nothing_changes() {
        let map = mapping("甲", "乙", false);
        assert!(rename_tags("与标签无关的一篇\n", &map).is_none());
        assert!(rename_tags("---\ntags: [别的]\n---\n#别的\n", &map).is_none());
        assert!(rename_tags("", &map).is_none());

        let out = rename_tags("---\ntags: [甲, 别的]\n---\n\n正文 #甲 与 #甲。\n", &map).unwrap();
        assert_eq!(out.frontmatter_edits, 1);
        assert_eq!(out.inline_edits, 2);
        assert_eq!(out.inline_removed, 0);
        assert_eq!(
            out.text,
            "---\ntags: [乙, 别的]\n---\n\n正文 #乙 与 #乙。\n"
        );
    }

    #[test]
    fn renaming_preserves_the_number_of_inline_mentions() {
        let map = mapping("甲", "乙", false);
        // 纯改名：一处不动地逐处改写（顺手删掉重复提及是另一件事）
        let out = rename_tags("正文 #甲 #甲 再说\n", &map).unwrap();
        assert_eq!(out.inline_edits, 2);
        assert_eq!(out.inline_removed, 0);
        assert_eq!(out.text, "正文 #乙 #乙 再说\n");
    }

    #[test]
    fn merging_dedupes_frontmatter_and_inline_mentions() {
        let merge = mapping("甲", "乙", false);
        // frontmatter 里两个都有 → 结果只有一个（否则磁盘上就是 `[乙, 乙]`）
        assert_eq!(
            rewritten("---\ntags: [甲, 乙]\n---\n正文\n", &merge),
            "---\ntags: [乙]\n---\n正文\n"
        );
        // 正文里两个都有 → 被合并掉的那一处去掉，连带它旁边的一段空白
        assert_eq!(
            rewritten("正文 #甲 #乙 与 #别的\n", &merge),
            "正文 #乙 与 #别的\n"
        );
        // 反过来写也一样（判据只看"原文里有没有目标标签"，与顺序无关）
        assert_eq!(
            rewritten("正文 #乙 #甲 与 #别的\n", &merge),
            "正文 #乙 与 #别的\n"
        );
        // 目标只在 frontmatter 里：正文那处也是重复的
        assert_eq!(
            rewritten("---\ntags: [乙]\n---\n\n正文 #甲 收尾\n", &merge),
            "---\ntags: [乙]\n---\n\n正文 收尾\n"
        );
        // 一行只有这一个标签 → 整行变空（行本身保留，不顺手删用户的行）
        assert_eq!(
            rewritten("---\ntags: [乙]\n---\n\n#甲\n后面还有\n", &merge),
            "---\ntags: [乙]\n---\n\n\n后面还有\n"
        );
        // 行尾那一处：吃掉它前面的空白
        assert_eq!(
            rewritten("---\ntags: [乙]\n---\n\n正文 #甲\n", &merge),
            "---\ntags: [乙]\n---\n\n正文\n"
        );
    }

    #[test]
    fn merge_into_a_tag_that_is_not_there_yet_is_a_plain_rename() {
        let merge = mapping("甲", "乙", false);
        let out = rename_tags("---\ntags: [甲, 甲]\n---\n\n#甲\n", &merge).unwrap();
        assert_eq!(out.text, "---\ntags: [乙]\n---\n\n#乙\n");
        // 同一个字段里的重复项本来就是重复的，顺手合并不算"多删了东西"
        assert_eq!(out.frontmatter_edits, 2);
    }

    #[test]
    fn case_only_rewording_never_deletes_the_mentions() {
        // `rust` → `Rust`：目标键与源键相同，"目标已经在原文里出现过"永远成立 ——
        // 若按合并口径去重，每一处 `#rust` 都会被删掉（这正是本用例钉住的坑）
        let map = mapping("rust", "Rust", false);
        let out = rename_tags("---\ntags: [rust]\n---\n\n正文 #rust 与 #RUST\n", &map).unwrap();
        assert_eq!(out.inline_removed, 0);
        assert_eq!(out.inline_edits, 2);
        assert_eq!(out.text, "---\ntags: [Rust]\n---\n\n正文 #Rust 与 #Rust\n");
    }

    #[test]
    fn rename_carries_children_in_both_frontmatter_and_body() {
        let map = mapping("父", "母", true);
        let text = "---\ntags: [父, 父/子]\n---\n\n#父 与 #父/子/孙 与 #别的\n";
        let out = rename_tags(text, &map).unwrap();
        assert_eq!(
            out.text,
            "---\ntags: [母, 母/子]\n---\n\n#母 与 #母/子/孙 与 #别的\n"
        );
        // 子标签的写法与顺序原样保留，只换掉被改名的那一段
        assert_eq!(out.frontmatter_edits, 2);
        assert_eq!(out.inline_edits, 2);
    }

    #[test]
    fn child_only_tag_rename_reports_nothing_for_the_parent_itself() {
        let map = mapping("父/子", "父/新", true);
        let out = rename_tags("---\ntags: [父/子/孙]\n---\n\n#父 不动\n", &map).unwrap();
        assert_eq!(out.text, "---\ntags: [父/新/孙]\n---\n\n#父 不动\n");
        assert_eq!(out.frontmatter_edits, 1);
        assert_eq!(out.inline_edits, 0);
    }

    #[test]
    fn rename_is_idempotent_on_its_own_result() {
        let map = mapping("甲", "乙", false);
        let once = rename_tags("---\ntags: [甲, 乙]\n---\n\n#甲 #乙\n", &map).unwrap();
        // 第二次跑：旧写法已经不存在 → 一个字都不用改（重试幂等的根据）
        assert!(rename_tags(&once.text, &map).is_none());
    }

    #[test]
    fn rename_never_touches_frontmatter_it_cannot_parse() {
        let map = mapping("甲", "乙", false);
        // 未闭合的 `---` 不算 frontmatter：整篇按正文处理，那一行照旧能被当行内标签改
        assert_eq!(
            rewritten("---\ntags: [甲]\n\n#甲\n", &map),
            "---\ntags: [甲]\n\n#乙\n"
        );
        // 嵌套映射不支持 → 缩进的 `tags:` 不认识，正文里的照改
        assert_eq!(
            rewritten("---\ncover:\n  tags: [甲]\n---\n#甲\n", &map),
            "---\ncover:\n  tags: [甲]\n---\n#乙\n"
        );
    }

    #[test]
    fn rename_keeps_line_endings_and_lines_untouched_byte_for_byte() {
        let map = mapping("甲", "乙", false);
        let out = rename_tags(
            "---\r\ntags: [甲]\r\n---\r\n\r\n第一行 #甲\r\n第二行不动\r\n",
            &map,
        )
        .unwrap()
        .text;
        assert_eq!(
            out,
            "---\r\ntags: [乙]\r\n---\r\n\r\n第一行 #乙\r\n第二行不动\r\n"
        );
    }

    #[test]
    fn removal_range_eats_exactly_one_side_of_whitespace() {
        let chars: Vec<char> = "正文 #甲 后面".chars().collect();
        // `#` 在 3，标签正文到 5 → 吃掉后面的空白（直到下一个非空白）
        assert_eq!(removal_range(&chars, 3, 5), Some((3, 6)));
        // 行尾：吃掉前面的空白
        let tail: Vec<char> = "正文 #甲".chars().collect();
        assert_eq!(removal_range(&tail, 3, 5), Some((2, 5)));
        // 只有标签：什么都不剩
        let only: Vec<char> = "#甲".chars().collect();
        assert_eq!(removal_range(&only, 0, 2), Some((0, 2)));
        // 非法区间不 panic
        assert_eq!(removal_range(&only, 3, 5), None);
    }
}
