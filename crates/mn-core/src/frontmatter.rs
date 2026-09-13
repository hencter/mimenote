//! Frontmatter 解析（极简 YAML 子集）与**保真改写**。
//!
//! 职责边界（刻意划得很窄，与 [`crate::links`] 同一风格）：
//!
//! * 只做两件事：**认出文件开头的 frontmatter 区块**、**在区块内按最小 diff 改写字段**；
//! * **手写解析**，不引入 `serde_yaml` / `yaml-rust` —— 见 `docs/dependencies.md` 的取舍原则
//!   （能用少量代码写对的就不引三方）；YAML 的锚点/别名、多文档、折叠标量、隐式类型转换
//!   在这个场景里全是负担与风险面，而我们需要的能力只有十来行；
//! * 不碰文件系统、不做 Markdown 结构解析、不解析 `[[链接]]`（那是 [`crate::links`] 的事）；
//! * **忠实优先**：字段顺序、未知键、注释、换行风格、BOM 在改写后都必须原样保留。
//!
//! # 识别边界（写死在这里，改行为必须改这段文档 + 测试）
//!
//! * 首行允许 UTF-8 BOM，但**不允许任何前导空白**；去掉行尾空白后必须正好是 `---`。
//!   `...`、`----`、` ---`、`--- x` 都**不算**开头分隔行。
//! * 区块结束于**另一行** `---`（同样允许行尾空白）。找不到结束行 → 返回 `None`，
//!   **这不是错误**：普通 Markdown 的首行 `---` 常常只是分隔线或 setext 标题下划线。
//! * YAML 的结束标记 `...` **不支持**：它会被当成普通内容行，区块仍必须由 `---` 收尾。
//! * 因此"文件以 `---` 开头，后面还有另一行 `---`"**必然**被识别为 frontmatter ——
//!   这是该语法固有的歧义（Obsidian 也如此）。
//! * 只认 LF / CRLF；老式 Mac 的孤立 `\r` 不当作换行（与 `str::lines` 一致）。
//!
//! # [`Frontmatter::raw`] 的定义
//!
//! **首尾分隔行之间的原始文本**：不含首行 `---`、不含结束行 `---`、不含 BOM，
//! 但**逐字节保留**每个内容行的换行符（CRLF 就是 `\r\n`）。空区块（`---\n---`）为 `""`。
//!
//! # 支持的 YAML 子集
//!
//! | 写法 | 结果 |
//! | --- | --- |
//! | `key: 文本` | [`FrontmatterValue::Scalar`]（**已去引号/转义**） |
//! | `key: "a: b # c"`、`key: 'it''s'` | [`FrontmatterValue::Scalar`] |
//! | `key: [a, "b, c"]` | [`FrontmatterValue::List`]（行内数组，支持引号内逗号） |
//! | `key:` + 若干 `- item` 行 | [`FrontmatterValue::List`]（缩进块数组，缩进不敏感） |
//! | `key: true` / `false` | [`FrontmatterValue::Bool`] |
//! | `key:` / `key: ~` / `key: null` | [`FrontmatterValue::Null`] |
//! | `key: 1.5e3`、`key: -12`、`key: 2025-01-01` | 前两者 [`FrontmatterValue::Number`]（**保留原始文本**），日期是标量 |
//! | `# 整行注释`、`key: v # 行尾注释` | 忽略 / 从值中剔除（**引号内的 `#` 不算注释**） |
//!
//! 块数组的边界（保守，避免把后面的内容吃进列表）：**紧跟字段行的连续 `- item` 行**才算这个
//! 字段的数组元素；空行、注释行、其他任何行都会结束该数组，之后孤立的 `- item` 行按"游离项"忽略。
//! 多个字段可以各自带块数组（`tags:` 与 `其他:` 的项不会互相串台）。
//!
//! 刻意**不支持**（遇到就忽略该行，不报错、不改写）：
//!
//! * 嵌套映射（`key:` 下的缩进 `子键: 值`）—— 所以缩进的 `tags:` 不会被误认成顶层字段；
//! * 折叠/字面标量（`key: |`、`key: >`）、锚点与别名、多文档 `---`；
//! * 带引号的键、含 `#`/引号的键；
//! * `yes`/`no`/`on`/`off` 之类的 YAML 1.1 布尔（只认 `true`/`false`，避免把国名 `NO` 当布尔）；
//! * 数字**不做类型推断**，只判断"像不像数字"，值原样保留（避免 `1.0` 变 `1`、大整数失真）。
//!
//! # 改写语义
//!
//! [`set_tags`] 只动 `tags`（或退而求其次：只存在 `tag` 时动 `tag`）这一处，其余字节**逐字不变**：
//!
//! * 没有 frontmatter → 返回 `None`（**不擅自插入**，由上层决定要不要给文件加 frontmatter）；
//! * 有 `tags` 字段 → 按它**原本的写法**就地改写（块数组仍是块数组、行内数组仍是行内数组、
//!   单个标签的标量仍是标量），改后仅该字段所占字节发生变化；
//! * 有 frontmatter 但既无 `tags` 也无 `tag` → 在结束分隔行**之前追加**一行 `tags: [...]`；
//! * 要设置空标签且原本没有 tags 字段 → 原样返回（不插入空字段）。
//!
//! 键名比较**大小写不敏感**（`Tags` 与 `tags` 等价），与 [`crate::tags`] 的抽取保持一致。

use std::collections::HashSet;

use serde::Serialize;

use crate::tags::normalize_tag;

/// 开头/结束分隔行。
const DELIMITER: &str = "---";

/// 一个 frontmatter 字段的值（极简 YAML 子集）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "lowercase")]
pub enum FrontmatterValue {
    /// 标量字符串；**已去掉外层引号并还原转义**（需要逐字原文请用 [`Frontmatter::raw`]）。
    Scalar(String),
    /// 数组：行内 `[a, b]` 或缩进块 `- a`；元素同样是去引号后的文本。
    List(Vec<String>),
    /// `true` / `false`。
    Bool(bool),
    /// `null` / `~` / 空值。
    Null,
    /// 数字：**保留原始文本**（`1.50` 仍是 `"1.50"`），不做类型推断。
    Number(String),
}

impl FrontmatterValue {
    /// 取文本表示（标量与数字；`Number` 返回原始文本）。
    pub fn as_str(&self) -> Option<&str> {
        match self {
            FrontmatterValue::Scalar(text) | FrontmatterValue::Number(text) => Some(text),
            _ => None,
        }
    }

    /// 取数组元素。
    pub fn as_list(&self) -> Option<&[String]> {
        match self {
            FrontmatterValue::List(items) => Some(items),
            _ => None,
        }
    }

    /// 是否为空值（`key:` / `key: null`）。
    pub fn is_null(&self) -> bool {
        matches!(self, FrontmatterValue::Null)
    }
}

/// 一个顶层字段。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontmatterField {
    /// 键名（原样，未做大小写转换）。
    pub key: String,
    /// 值。
    pub value: FrontmatterValue,
    /// 键所在行（**1 起，全文绝对行号**，首行分隔行是第 1 行）。
    ///
    /// 块数组的项另算：`tags` 的每个元素在 [`crate::tags::extract_tags`] 里会带上**项自己**的行号。
    pub line: u32,
}

/// 解析结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frontmatter {
    /// 首尾分隔行之间的原始文本（定义见模块文档）。
    pub raw: String,
    /// 顶层字段，**保持文档顺序**（重复键各占一条，不会合并）。
    pub fields: Vec<FrontmatterField>,
    /// 便于建索引的标签列表：`tags` 与 `tag` 字段合并、**已去重**（按 [`crate::tags::normalize_tag`]
    /// 判同，保留首次出现的写法与顺序）。需要逐字段原样信息请看 `fields`。
    pub tags: Vec<String>,
}

impl Frontmatter {
    /// 取第一个同名键的字段（键名**大小写不敏感**；重复键时取靠前的那条）。
    pub fn field(&self, key: &str) -> Option<&FrontmatterField> {
        self.fields
            .iter()
            .find(|field| field.key.eq_ignore_ascii_case(key))
    }

    /// 取第一个同名键的值。
    pub fn get(&self, key: &str) -> Option<&FrontmatterValue> {
        self.field(key).map(|field| &field.value)
    }
}

/// 解析文件开头的 frontmatter。
///
/// 返回 `None` 表示"这个文件没有 frontmatter"（包括**未闭合**的情况），**不是错误**。
pub fn parse(text: &str) -> Option<Frontmatter> {
    let located = parse_located(text)?;
    Some(Frontmatter {
        raw: located.raw,
        fields: located.fields.iter().map(LocatedField::to_field).collect(),
        tags: collect_tags(&located.fields)
            .into_iter()
            .map(|(tag, _line)| tag)
            .collect(),
    })
}

/// 返回 frontmatter **之后**的正文（没有 frontmatter 时返回整段文本）。
///
/// 给"预览/统计要不要算上 frontmatter"这类问题一个现成的切分点：本函数只切不改。
pub fn body(text: &str) -> &str {
    match region_end(text) {
        Some(start) => &text[start..],
        None => text,
    }
}

/// 按最小 diff 改写标签。
///
/// * `None`：**没有 frontmatter**（此函数绝不擅自插入 frontmatter）；
/// * `Some(new_text)`：改写后的全文。除被改的那几行外**逐字节不变**（含 CRLF、BOM、注释、
///   未知键与字段顺序）。传入的标签会先做清理：去首尾空白、去掉开头的 `#`、丢弃空串、
///   按 [`crate::tags::normalize_tag`] 去重（保留首次出现的写法）。
///
/// 具体落点（也见模块文档"改写语义"）：
///
/// | 原字段形态 | 改写方式 |
/// | --- | --- |
/// | 块数组 | 只替换 `- item` 那几行，缩进沿用原第一项，行尾风格沿用原项所在行 |
/// | 行内数组 `[a, b]` | 只替换 `[...]` 这一段（行尾注释保留） |
/// | 标量 | 1 个标签 → 仍是标量；0 或 ≥2 个 → 变成行内数组 `[...]` |
/// | 空值 `key:` | 新标签非空时在冒号后插入（1 个标签写成标量，否则写成 `[...]`）；新标签为空时**原样不动** |
/// | 没有 tags 字段 | 在结束分隔行之前**追加**一行 `tags: [...]`；要设置空标签时原样返回 |
pub fn set_tags(text: &str, tags: &[String]) -> Option<String> {
    let located = parse_located(text)?;
    let wanted = clean_tags(tags);

    let target = located
        .fields
        .iter()
        .find(|field| field.key.eq_ignore_ascii_case("tags"))
        .or_else(|| {
            located
                .fields
                .iter()
                .find(|field| field.key.eq_ignore_ascii_case("tag"))
        });

    let Some(field) = target else {
        if wanted.is_empty() {
            return Some(text.to_string());
        }
        // 追加：插在结束分隔行之前，这一行独立成行
        let eol = eol_ending_at(text, located.body_end);
        let mut out = String::with_capacity(text.len() + 32);
        out.push_str(&text[..located.body_end]);
        out.push_str("tags: ");
        out.push_str(&format_inline_list(&wanted));
        out.push_str(eol);
        out.push_str(&text[located.body_end..]);
        return Some(out);
    };

    let (start, end, replacement) = match field.style {
        ValueStyle::Block => {
            if wanted.is_empty() {
                // 把 `- item` 行连同最后一个换行一并删掉，避免留下空行
                (field.item_start, field.item_end_full, String::new())
            } else {
                let eol = eol_ending_at(text, field.item_end_full);
                let joined = wanted
                    .iter()
                    .map(|tag| format!("{}- {}", field.indent, format_scalar(tag)))
                    .collect::<Vec<String>>()
                    .join(eol);
                (field.item_start, field.item_end, joined)
            }
        }
        ValueStyle::Inline => (
            field.value_start,
            field.value_end,
            format_inline_list(&wanted),
        ),
        ValueStyle::Scalar => (
            field.value_start,
            field.value_end,
            if wanted.len() == 1 {
                format_scalar(&wanted[0])
            } else {
                format_inline_list(&wanted)
            },
        ),
        ValueStyle::Empty => {
            if wanted.is_empty() {
                return Some(text.to_string());
            }
            let value = if wanted.len() == 1 {
                format_scalar(&wanted[0])
            } else {
                format_inline_list(&wanted)
            };
            (field.insert_at, field.insert_at, format!(" {value}"))
        }
    };

    Some(splice(text, start, end, &replacement))
}

/// 结束分隔行之后的字节偏移（= Markdown 正文起点）。
///
/// `pub(crate)`：`crate::tags` 需要它来跳过 frontmatter 并换算绝对行号。
pub(crate) fn region_end(text: &str) -> Option<usize> {
    locate(text).map(|located| located.content_start)
}

/// frontmatter 里 `tags` / `tag` 字段贡献的标签（**去重后**，含各自行号）。
///
/// `pub(crate)`：`crate::tags::extract_tags` 用它拿到带行号的 frontmatter 标签，
/// 从而不必重复解析一遍区块。
pub(crate) fn tag_occurrences(text: &str) -> Vec<(String, u32)> {
    match parse_located(text) {
        Some(located) => collect_tags(&located.fields),
        None => Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// 内部：定位区块
// ---------------------------------------------------------------------------

/// 区块在原文中的位置。
#[derive(Debug, Clone, Copy)]
struct Location {
    /// 首行分隔行之后（区块正文起点）。
    body_start: usize,
    /// 结束分隔行之前（区块正文终点）。
    body_end: usize,
    /// 结束分隔行之后（Markdown 正文起点）。
    content_start: usize,
}

/// 定位文件开头的 frontmatter 区块；不是 frontmatter / 未闭合 → `None`。
fn locate(text: &str) -> Option<Location> {
    let bom = bom_len(text);
    let rest = &text[bom..];

    // 首行必须真的以换行结束，否则后面不可能再有"另一行 ---"
    let first_end = rest.find('\n')?;
    if !is_delimiter(strip_eol(&rest[..first_end])) {
        return None;
    }
    let body_start = bom + first_end + 1;

    let mut offset = body_start;
    for chunk in text[body_start..].split_inclusive('\n') {
        let start = offset;
        offset += chunk.len();
        if is_delimiter(strip_eol(chunk)) {
            return Some(Location {
                body_start,
                body_end: start,
                content_start: offset,
            });
        }
    }
    None
}

/// UTF-8 BOM 的字节长度（0 或 3）。
fn bom_len(text: &str) -> usize {
    if text.starts_with('\u{feff}') {
        '\u{feff}'.len_utf8()
    } else {
        0
    }
}

/// 去掉行尾的换行符（`\n` 或 `\r\n`）。
fn strip_eol(chunk: &str) -> &str {
    let without_nl = chunk.strip_suffix('\n').unwrap_or(chunk);
    without_nl.strip_suffix('\r').unwrap_or(without_nl)
}

/// 是否是分隔行（只容忍行尾空白）。
fn is_delimiter(line: &str) -> bool {
    line.trim_end_matches([' ', '\t']) == DELIMITER
}

/// `end` 之前那个换行符的风格（`end` 指向 `\n` 之后）。
fn eol_ending_at(text: &str, end: usize) -> &'static str {
    let bytes = text.as_bytes();
    if end >= 2 && bytes[end - 1] == b'\n' && bytes[end - 2] == b'\r' {
        "\r\n"
    } else {
        "\n"
    }
}

// ---------------------------------------------------------------------------
// 内部：区块内的字段（带字节区间，供改写使用）
// ---------------------------------------------------------------------------

/// 值的写法 —— 决定 [`set_tags`] 往哪儿写、写成什么样。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ValueStyle {
    /// `key:` 后面什么都没有（可能的下一个 `- item` 行会把它变成 `Block`）。
    Empty,
    /// `key: 标量`
    Scalar,
    /// `key: [a, b]`
    Inline,
    /// `key:` + 若干 `- item` 行
    Block,
}

/// 解析后的字段 + 字节区间。
#[derive(Debug, Clone)]
struct LocatedField {
    key: String,
    value: FrontmatterValue,
    line: u32,
    style: ValueStyle,
    /// 值在键行内的可替换区间（`Empty` 时是空区间）。
    value_start: usize,
    value_end: usize,
    /// 空值时的插入点（冒号之后）。
    insert_at: usize,
    /// `Block`：项行范围（`item_end` 不含末项的换行，`item_end_full` 含）。
    item_start: usize,
    item_end: usize,
    item_end_full: usize,
    /// `Block`：项的前导空白（原样沿用）。
    indent: String,
    /// `Block`：每项的行号（与 `value` 里的元素一一对应）。
    item_lines: Vec<u32>,
}

impl LocatedField {
    fn to_field(&self) -> FrontmatterField {
        FrontmatterField {
            key: self.key.clone(),
            value: self.value.clone(),
            line: self.line,
        }
    }
}

/// 整个区块的解析结果。
struct Located {
    raw: String,
    body_end: usize,
    fields: Vec<LocatedField>,
}

/// 解析区块内的所有顶层字段（解析不了的行直接忽略）。
fn parse_located(text: &str) -> Option<Located> {
    let located = locate(text)?;
    let raw = text[located.body_start..located.body_end].to_string();

    let mut fields: Vec<LocatedField> = Vec::new();
    // 正在收集块数组的字段下标；不是"等待 - item 的状态"时是 None
    let mut collecting: Option<usize> = None;
    let mut line_no: u32 = 1;
    let mut offset = located.body_start;

    for chunk in text[located.body_start..located.body_end].split_inclusive('\n') {
        let start = offset;
        offset += chunk.len();
        line_no += 1;
        let content = strip_eol(chunk);
        let trimmed = content.trim_start();

        // 空行与整行注释：结束块数组收集（保守，避免把后面的内容吃进标签列表）
        if trimmed.is_empty() || trimmed.starts_with('#') {
            collecting = None;
            continue;
        }

        if is_item_line(trimmed) {
            if let Some(index) = collecting {
                let indent_len = content.len() - trimmed.len();
                let item_text = trimmed[1..].trim();
                if !item_text.is_empty() && !is_nested_value(item_text) {
                    let item = unquote(item_text).unwrap_or_else(|| item_text.to_string());
                    let field = &mut fields[index];
                    field.style = ValueStyle::Block;
                    match &mut field.value {
                        FrontmatterValue::List(items) => items.push(item),
                        other => *other = FrontmatterValue::List(vec![item]),
                    }
                    field.item_end = start + content.len();
                    field.item_end_full = start + chunk.len();
                    if field.item_lines.is_empty() {
                        field.item_start = start;
                        field.indent = content[..indent_len].to_string();
                    }
                    field.item_lines.push(line_no);
                }
            }
            // 游离的 `- item`（没有归属字段）直接忽略
            continue;
        }

        // 缩进行（不是 `- item`）：嵌套映射/折叠标量不支持，忽略
        if content.len() != trimmed.len() {
            collecting = None;
            continue;
        }

        let Some((key, colon)) = split_key(content) else {
            collecting = None;
            continue;
        };

        let parts = parse_value(text, start + colon, start + content.len());
        collecting = if parts.style == ValueStyle::Empty {
            Some(fields.len())
        } else {
            None
        };
        fields.push(LocatedField {
            key: key.to_string(),
            value: parts.value,
            line: line_no,
            style: parts.style,
            value_start: parts.value_start,
            value_end: parts.value_end,
            insert_at: start + colon + 1,
            item_start: 0,
            item_end: 0,
            item_end_full: 0,
            indent: String::new(),
            item_lines: Vec::new(),
        });
    }

    Some(Located {
        raw,
        body_end: located.body_end,
        fields,
    })
}

/// `- item` / `-item` 之类的块数组项行（已 trim_start）。
fn is_item_line(trimmed: &str) -> bool {
    trimmed == "-"
        || trimmed
            .strip_prefix('-')
            .is_some_and(|rest| rest.starts_with([' ', '\t']))
}

/// 项本身是嵌套结构（`- a: b`、`- [a]`），本子集不支持 → 忽略该项。
fn is_nested_value(item: &str) -> bool {
    item.starts_with('[') || split_key(item).is_some()
}

/// 切出键与冒号的位置：**冒号后必须是空白或行尾**（所以 `key:value` 不是映射）。
fn split_key(content: &str) -> Option<(&str, usize)> {
    let bytes = content.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != b':' {
            continue;
        }
        let followed_by_space = matches!(bytes.get(index + 1), None | Some(b' ') | Some(b'\t'));
        if !followed_by_space {
            continue;
        }
        let key = content[..index].trim();
        if key.is_empty() || key.contains(['"', '\'', '#']) {
            return None;
        }
        return Some((key, index));
    }
    None
}

/// 值解析结果。
struct ValueParts {
    value: FrontmatterValue,
    style: ValueStyle,
    value_start: usize,
    value_end: usize,
}

/// 解析 `key:` 之后这一行剩下的部分（`colon` 是冒号的字节位置）。
fn parse_value(text: &str, colon: usize, line_end: usize) -> ValueParts {
    let after = colon + 1;
    let line = &text[after..line_end];
    let value_start = after + (line.len() - line.trim_start_matches([' ', '\t']).len());

    let empty = ValueParts {
        value: FrontmatterValue::Null,
        style: ValueStyle::Empty,
        value_start,
        value_end: value_start,
    };
    if value_start >= line_end {
        return empty;
    }

    // 行内数组：先找到配对的 `]`（引号内的 `]` 不算），这样 `#` 注释与数组互不干扰
    if text.as_bytes()[value_start] == b'[' {
        if let Some(close) = inline_list_end(text, value_start, line_end) {
            return ValueParts {
                value: FrontmatterValue::List(split_inline_list(&text[value_start + 1..close])),
                style: ValueStyle::Inline,
                value_start,
                value_end: close + 1,
            };
        }
    }

    let token_end = value_token_end(text, value_start, line_end);
    if token_end <= value_start {
        // 整个值都是注释（`key: # 注释`），按 YAML 语义视为空值
        return empty;
    }

    ValueParts {
        value: classify_scalar(text[value_start..token_end].trim_end()),
        style: ValueStyle::Scalar,
        value_start,
        value_end: token_end,
    }
}

/// 值 token 的结束偏移：去掉行尾空白与**引号外**的 `#` 注释。
fn value_token_end(text: &str, start: usize, end: usize) -> usize {
    let bytes = text.as_bytes();
    let mut index = start;
    let mut quote: Option<u8> = None;
    let mut last_content = start;

    while index < end {
        let byte = bytes[index];
        if let Some(open) = quote {
            index += 1;
            if byte == open {
                quote = None;
            }
            last_content = index;
            continue;
        }
        match byte {
            b'"' | b'\'' => {
                quote = Some(byte);
                index += 1;
                last_content = index;
            }
            // `#` 前必须是空白或值首，才算注释（与 YAML 一致）
            b'#' if index == start || bytes[index - 1].is_ascii_whitespace() => break,
            _ => {
                index += 1;
                if !byte.is_ascii_whitespace() {
                    last_content = index;
                }
            }
        }
    }

    last_content
}

/// 找行内数组的结束 `]`（跳过引号内的 `]`）。
fn inline_list_end(text: &str, open: usize, end: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut index = open + 1;
    let mut quote: Option<u8> = None;

    while index < end {
        let byte = bytes[index];
        match quote {
            Some(open_quote) => {
                if byte == open_quote {
                    quote = None;
                }
            }
            None => match byte {
                b'"' | b'\'' => quote = Some(byte),
                b']' => return Some(index),
                _ => {}
            },
        }
        index += 1;
    }
    None
}

/// 切分行内数组的元素（引号内的逗号不算分隔符；空元素丢弃）。
fn split_inline_list(inner: &str) -> Vec<String> {
    let mut items = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;

    for c in inner.chars() {
        match quote {
            Some(open) => {
                current.push(c);
                if c == open {
                    quote = None;
                }
            }
            None => match c {
                '"' | '\'' => {
                    quote = Some(c);
                    current.push(c);
                }
                ',' => items.push(std::mem::take(&mut current)),
                _ => current.push(c),
            },
        }
    }
    items.push(current);

    items
        .into_iter()
        .filter_map(|item| {
            let trimmed = item.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(unquote(trimmed).unwrap_or_else(|| trimmed.to_string()))
            }
        })
        .collect()
}

/// 标量分类：带引号的一律是字符串；否则只识别 true/false/数字/null，其余都当字符串。
fn classify_scalar(token: &str) -> FrontmatterValue {
    if let Some(text) = unquote(token) {
        return FrontmatterValue::Scalar(text);
    }
    match token {
        "true" | "True" | "TRUE" => FrontmatterValue::Bool(true),
        "false" | "False" | "FALSE" => FrontmatterValue::Bool(false),
        "null" | "Null" | "NULL" | "~" => FrontmatterValue::Null,
        _ if looks_like_number(token) => FrontmatterValue::Number(token.to_string()),
        _ => FrontmatterValue::Scalar(token.to_string()),
    }
}

/// 去掉外层的单/双引号并还原转义；不是完整引号包裹时返回 `None`。
///
/// 双引号只处理 `\\`、`\"`、`\n`、`\t`、`\r`（其余 `\x` 原样保留），
/// 单引号按 YAML 规则把 `''` 还原成一个 `'`。
fn unquote(token: &str) -> Option<String> {
    let bytes = token.as_bytes();
    if token.len() < 2 {
        return None;
    }
    let first = bytes[0];
    let last = bytes[token.len() - 1];
    if first == b'"' && last == b'"' {
        let mut out = String::with_capacity(token.len());
        let mut chars = token[1..token.len() - 1].chars();
        while let Some(c) = chars.next() {
            if c != '\\' {
                out.push(c);
                continue;
            }
            match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some('r') => out.push('\r'),
                Some('\\') => out.push('\\'),
                Some('"') => out.push('"'),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        }
        return Some(out);
    }
    if first == b'\'' && last == b'\'' {
        return Some(token[1..token.len() - 1].replace("''", "'"));
    }
    None
}

/// 是否"像数字"（只用于分类，值原样保留）。
fn looks_like_number(token: &str) -> bool {
    let bytes = token.as_bytes();
    let mut index = 0;
    if matches!(bytes.first(), Some(b'+') | Some(b'-')) {
        index += 1;
    }
    let mut digits = 0;
    while bytes.get(index).is_some_and(u8::is_ascii_digit) {
        index += 1;
        digits += 1;
    }
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
            digits += 1;
        }
    }
    if digits == 0 {
        return false;
    }
    if matches!(bytes.get(index), Some(b'e') | Some(b'E')) {
        index += 1;
        if matches!(bytes.get(index), Some(b'+') | Some(b'-')) {
            index += 1;
        }
        let mut exponent_digits = 0;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
            exponent_digits += 1;
        }
        if exponent_digits == 0 {
            return false;
        }
    }
    index == bytes.len()
}

/// 收集 `tags` / `tag` 字段贡献的标签（去重、保序、带行号）。
fn collect_tags(fields: &[LocatedField]) -> Vec<(String, u32)> {
    let mut out: Vec<(String, u32)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for field in fields {
        if !(field.key.eq_ignore_ascii_case("tags") || field.key.eq_ignore_ascii_case("tag")) {
            continue;
        }
        let mut push = |raw: &str, line: u32| {
            let tag = strip_hash(raw);
            if tag.is_empty() {
                return;
            }
            let key = normalize_tag(tag);
            if key.is_empty() || !seen.insert(key) {
                return;
            }
            out.push((tag.to_string(), line));
        };
        match &field.value {
            FrontmatterValue::List(items) => {
                for (index, item) in items.iter().enumerate() {
                    let line = field.item_lines.get(index).copied().unwrap_or(field.line);
                    push(item, line);
                }
            }
            // 标量：逗号分隔（只按逗号切，不按空白切，见模块文档）
            FrontmatterValue::Scalar(text) | FrontmatterValue::Number(text) => {
                for part in text.split(',') {
                    push(part, field.line);
                }
            }
            FrontmatterValue::Bool(_) | FrontmatterValue::Null => {}
        }
    }

    out
}

/// 去掉开头的 `#` 并 trim；返回用于**显示**的形式（保留原大小写）。
fn strip_hash(raw: &str) -> &str {
    raw.trim().trim_start_matches('#').trim()
}

/// 清理待写入的标签：trim、去开头 `#`、丢空串、按归一化键去重。
fn clean_tags(tags: &[String]) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for raw in tags {
        let tag = strip_hash(raw);
        if tag.is_empty() {
            continue;
        }
        let key = normalize_tag(tag);
        if key.is_empty() || !seen.insert(key) {
            continue;
        }
        out.push(tag.to_string());
    }
    out
}

/// 写成 YAML 标量：可能需要加引号（含 `#`、`,`、`:`、首尾空白、以 `-` 开头等）。
fn format_scalar(item: &str) -> String {
    if needs_quote(item) {
        format!("'{}'", item.replace('\'', "''"))
    } else {
        item.to_string()
    }
}

/// 是否必须加引号才能被本模块（以及常见 YAML 解析器）读回原样。
fn needs_quote(item: &str) -> bool {
    if item.is_empty() {
        return true;
    }
    if item.starts_with(['-', ' ']) || item.ends_with(' ') {
        return true;
    }
    item.chars()
        .any(|c| !(c.is_alphanumeric() || matches!(c, '_' | '-' | '/' | '.')))
}

/// 写成行内数组 `[a, b]`。
fn format_inline_list(items: &[String]) -> String {
    let joined = items
        .iter()
        .map(|item| format_scalar(item))
        .collect::<Vec<String>>()
        .join(", ");
    format!("[{joined}]")
}

/// 用 `replacement` 替换 `[start, end)`（越界时钳制，绝不 panic）。
fn splice(text: &str, start: usize, end: usize, replacement: &str) -> String {
    let end = end.min(text.len());
    let start = start.min(end);
    let mut out = String::with_capacity(text.len() + replacement.len());
    out.push_str(&text[..start]);
    out.push_str(replacement);
    out.push_str(&text[end..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tags_of(text: &str) -> Vec<String> {
        parse(text).map(|fm| fm.tags).unwrap_or_default()
    }

    #[test]
    fn parses_basic_block_with_lines_and_order() {
        let text = "---\ntitle: 我的笔记\ntags: [a, b]\ndraft: false\n---\n正文\n";
        let fm = parse(text).expect("应识别 frontmatter");
        assert_eq!(fm.raw, "title: 我的笔记\ntags: [a, b]\ndraft: false\n");
        assert_eq!(fm.fields.len(), 3);
        assert_eq!(fm.fields[0].key, "title");
        assert_eq!(fm.fields[0].line, 2);
        assert_eq!(
            fm.fields[0].value,
            FrontmatterValue::Scalar("我的笔记".into())
        );
        assert_eq!(fm.fields[1].line, 3);
        assert_eq!(
            fm.fields[1].value,
            FrontmatterValue::List(vec!["a".into(), "b".into()])
        );
        assert_eq!(fm.fields[2].value, FrontmatterValue::Bool(false));
        assert_eq!(fm.tags, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(
            fm.get("title").and_then(FrontmatterValue::as_str),
            Some("我的笔记")
        );
        // 键名大小写不敏感
        assert!(fm.get("TITLE").is_some());
        assert!(fm.get("missing").is_none());
    }

    #[test]
    fn raw_excludes_delimiters_and_keeps_original_eol() {
        let text = "---\r\na: 1\r\n---\r\nbody\r\n";
        let fm = parse(text).unwrap();
        assert_eq!(fm.raw, "a: 1\r\n");
        assert_eq!(fm.fields[0].value, FrontmatterValue::Number("1".into()));
    }

    #[test]
    fn empty_block_is_valid() {
        let fm = parse("---\n---\n正文").unwrap();
        assert_eq!(fm.raw, "");
        assert!(fm.fields.is_empty());
        assert!(fm.tags.is_empty());
        assert_eq!(body("---\n---\n正文"), "正文");
    }

    #[test]
    fn honours_bom() {
        let text = "\u{feff}---\ntags: [x]\n---\n正文";
        let fm = parse(text).unwrap();
        assert_eq!(fm.tags, vec!["x".to_string()]);
        assert_eq!(body(text), "正文");
    }

    #[test]
    fn rejects_non_frontmatter_openers() {
        // 未闭合：普通 Markdown 的分隔线 / setext 下划线
        assert!(parse("---\n只是正文\n还是正文\n").is_none());
        // 首行不是分隔行
        assert!(parse("...\na: 1\n---\n").is_none());
        assert!(parse("----\na: 1\n---\n").is_none());
        assert!(parse(" ---\na: 1\n---\n").is_none());
        assert!(parse("text\n---\na: 1\n---\n").is_none());
        // 只有一行 `---`（没有换行 → 不可能有结束行）
        assert!(parse("---").is_none());
        assert!(parse("").is_none());
        // 结束行必须自己成行
        assert!(parse("---\na: 1\n---x\n").is_none());
        // 正文里的 `---` 可以充当结束行（语法固有歧义）
        assert!(parse("---\n第一段\n---\n第二段\n").is_some());
    }

    #[test]
    fn eol_style_is_lf_only() {
        // 孤立 `\r` 不当作换行：这里首行没有 `\n` → 不识别为 frontmatter
        assert!(parse("---\ra: 1\r---\r").is_none());
    }

    #[test]
    fn parses_block_array_with_indent_and_column_zero() {
        let text = "---\ntags:\n  - 甲\n  - 乙\n其他: 值\n---\n";
        let fm = parse(text).unwrap();
        assert_eq!(
            fm.get("tags"),
            Some(&FrontmatterValue::List(vec!["甲".into(), "乙".into()]))
        );
        assert_eq!(fm.fields[1].key, "其他");
        assert_eq!(fm.fields[1].line, 5);

        let flush = parse("---\ntags:\n- a\n- b\n---\n").unwrap();
        assert_eq!(
            flush.get("tags"),
            Some(&FrontmatterValue::List(vec!["a".into(), "b".into()]))
        );
    }

    #[test]
    fn block_array_item_lines_are_individual() {
        let text = "---\ntags:\n  - 甲\n  - 乙\n---\n";
        let occurrences = tag_occurrences(text);
        assert_eq!(
            occurrences,
            vec![("甲".to_string(), 3), ("乙".to_string(), 4)]
        );
    }

    #[test]
    fn blank_or_comment_line_ends_block_array() {
        let text = "---\ntags:\n  - a\n\n  - b\n---\n";
        let fm = parse(text).unwrap();
        // 空行结束块数组：只认出 a（保守，避免把后面的内容吃进标签）
        assert_eq!(
            fm.get("tags"),
            Some(&FrontmatterValue::List(vec!["a".into()]))
        );
    }

    #[test]
    fn stray_items_without_field_are_ignored() {
        let fm = parse("---\n- orphan\nkey: v\n---\n").unwrap();
        assert_eq!(fm.fields.len(), 1);
        assert_eq!(fm.fields[0].key, "key");
    }

    #[test]
    fn nested_map_is_not_parsed() {
        let text = "---\ncover:\n  tags: [不该被认出]\n  image: x.png\ntags: [真标签]\n---\n";
        let fm = parse(text).unwrap();
        assert_eq!(fm.tags, vec!["真标签".to_string()]);
        assert_eq!(fm.get("cover"), Some(&FrontmatterValue::Null));
        assert!(fm.get("image").is_none());
    }

    #[test]
    fn parses_quotes_comments_and_escapes() {
        let text =
            "---\ntitle: \"带 # 井号的标题\" # 行尾注释\nnote: 'it''s ok'\npath: \"a\\nb\"\n---\n";
        let fm = parse(text).unwrap();
        assert_eq!(
            fm.get("title"),
            Some(&FrontmatterValue::Scalar("带 # 井号的标题".into()))
        );
        assert_eq!(
            fm.get("note"),
            Some(&FrontmatterValue::Scalar("it's ok".into()))
        );
        assert_eq!(
            fm.get("path"),
            Some(&FrontmatterValue::Scalar("a\nb".into()))
        );
    }

    #[test]
    fn handles_inline_comments_and_hash_only_values() {
        let fm = parse("---\na: 值 # 注释\nb: # 整行都算注释\nc: \"x#y\"\n---\n").unwrap();
        assert_eq!(fm.get("a"), Some(&FrontmatterValue::Scalar("值".into())));
        assert_eq!(fm.get("b"), Some(&FrontmatterValue::Null));
        assert_eq!(fm.get("c"), Some(&FrontmatterValue::Scalar("x#y".into())));
    }

    #[test]
    fn inline_array_with_quoted_commas() {
        let fm = parse("---\ntags: [\"a, b\", 'c', d]\nempty: []\n---\n").unwrap();
        assert_eq!(
            fm.get("tags"),
            Some(&FrontmatterValue::List(vec![
                "a, b".into(),
                "c".into(),
                "d".into()
            ]))
        );
        assert_eq!(
            fm.tags,
            vec!["a, b".to_string(), "c".to_string(), "d".to_string()]
        );
        assert_eq!(fm.get("empty"), Some(&FrontmatterValue::List(vec![])));
    }

    #[test]
    fn unclosed_inline_array_falls_back_to_scalar() {
        let fm = parse("---\ntags: [a, b\n---\n").unwrap();
        assert_eq!(
            fm.get("tags"),
            Some(&FrontmatterValue::Scalar("[a, b".into()))
        );
    }

    #[test]
    fn classifies_numbers_bools_null_and_dates() {
        let text = "---\nint: -12\nfloat: 1.50\nexp: 1.5e3\nzero: 1.\ndate: 2025-01-01\nver: 1.2.3\nnil: ~\nnil2:\nyes: yes\n---\n";
        let fm = parse(text).unwrap();
        assert_eq!(fm.get("int"), Some(&FrontmatterValue::Number("-12".into())));
        assert_eq!(
            fm.get("float"),
            Some(&FrontmatterValue::Number("1.50".into()))
        );
        assert_eq!(
            fm.get("exp"),
            Some(&FrontmatterValue::Number("1.5e3".into()))
        );
        assert_eq!(fm.get("zero"), Some(&FrontmatterValue::Number("1.".into())));
        assert_eq!(
            fm.get("date"),
            Some(&FrontmatterValue::Scalar("2025-01-01".into()))
        );
        assert_eq!(
            fm.get("ver"),
            Some(&FrontmatterValue::Scalar("1.2.3".into()))
        );
        assert_eq!(fm.get("nil"), Some(&FrontmatterValue::Null));
        assert_eq!(fm.get("nil2"), Some(&FrontmatterValue::Null));
        // YAML 1.1 的 yes/no 刻意不认（避免把国家代码 NO 当布尔）
        assert_eq!(fm.get("yes"), Some(&FrontmatterValue::Scalar("yes".into())));
    }

    #[test]
    fn colon_requires_space_after_key() {
        let fm = parse("---\nurl:https://example.com\nok: 值\n---\n").unwrap();
        assert_eq!(fm.fields.len(), 1);
        assert_eq!(fm.fields[0].key, "ok");
        // 值里的冒号不受影响
        let fm2 = parse("---\ntitle: 关于: 某事的说明\n---\n").unwrap();
        assert_eq!(
            fm2.get("title"),
            Some(&FrontmatterValue::Scalar("关于: 某事的说明".into()))
        );
    }

    #[test]
    fn quoted_keys_are_ignored() {
        let fm = parse("---\n\"a b\": 1\nok: 2\n---\n").unwrap();
        assert_eq!(fm.fields.len(), 1);
        assert_eq!(fm.fields[0].key, "ok");
    }

    #[test]
    fn tags_from_tag_and_tags_fields_with_dedup() {
        let text = "---\ntag: 单独标签\ntags: [重复, REPEAT]\n重复2: x\nTags: repeat\n---\n";
        let fm = parse(text).unwrap();
        // `tag` 与 `tags` 合并；`REPEAT` 与 `repeat` 视为同一个（归一化后去重，保留首次写法）
        assert_eq!(
            fm.tags,
            vec![
                "单独标签".to_string(),
                "重复".to_string(),
                "REPEAT".to_string()
            ]
        );
    }

    #[test]
    fn scalar_tags_are_comma_separated_only() {
        assert_eq!(
            tags_of("---\ntags: 甲, 乙 ,#丙\n---\n"),
            vec!["甲".to_string(), "乙".to_string(), "丙".to_string()]
        );
        // 不按空白切分
        assert_eq!(
            tags_of("---\ntags: 甲 乙\n---\n"),
            vec!["甲 乙".to_string()]
        );
    }

    #[test]
    fn duplicate_keys_keep_order_and_first_wins() {
        let fm = parse("---\na: 1\na: 2\n---\n").unwrap();
        assert_eq!(fm.fields.len(), 2);
        assert_eq!(fm.get("a"), Some(&FrontmatterValue::Number("1".into())));
    }

    #[test]
    fn body_helper() {
        assert_eq!(body("---\na: 1\n---\n正文\n"), "正文\n");
        assert_eq!(body("---\na: 1\n---"), "");
        assert_eq!(body("没有 frontmatter\n"), "没有 frontmatter\n");
        assert_eq!(body(""), "");
    }

    // -- set_tags ----------------------------------------------------------

    #[test]
    fn set_tags_returns_none_without_frontmatter() {
        let tags = vec!["a".to_string()];
        assert!(set_tags("正文\n", &tags).is_none());
        assert!(set_tags("---\n未闭合\n", &tags).is_none());
        assert!(set_tags("", &tags).is_none());
    }

    #[test]
    fn set_tags_rewrites_inline_array_only() {
        let text = "---\ntitle: 标题\ntags: [旧, 旧2]\n其他: 值 # 注释\n---\n正文\n";
        let out = set_tags(text, &["新".to_string(), "新2".to_string()]).unwrap();
        assert_eq!(
            out,
            "---\ntitle: 标题\ntags: [新, 新2]\n其他: 值 # 注释\n---\n正文\n"
        );
    }

    #[test]
    fn set_tags_rewrites_block_array_keeping_indent_and_eol() {
        let text = "---\r\ntags:\r\n  - 旧\r\n  - 旧2\r\n其他: 值\r\n---\r\n正文\r\n";
        let out = set_tags(text, &["新".to_string()]).unwrap();
        assert_eq!(out, "---\r\ntags:\r\n  - 新\r\n其他: 值\r\n---\r\n正文\r\n");
    }

    #[test]
    fn set_tags_appends_when_no_tags_field() {
        let text = "---\ntitle: 标题\n---\n正文\n";
        let out = set_tags(text, &["a".to_string(), "b".to_string()]).unwrap();
        assert_eq!(out, "---\ntitle: 标题\ntags: [a, b]\n---\n正文\n");
        // 空 frontmatter 也能追加
        let out2 = set_tags("---\n---\n正文", &["a".to_string()]).unwrap();
        assert_eq!(out2, "---\ntags: [a]\n---\n正文");
    }

    #[test]
    fn set_tags_keeps_scalar_style_for_single_tag() {
        let out = set_tags("---\ntags: 旧\n---\n", &["新".to_string()]).unwrap();
        assert_eq!(out, "---\ntags: 新\n---\n");
        let out2 = set_tags(
            "---\ntags: 旧\n---\n",
            &["甲".to_string(), "乙".to_string()],
        )
        .unwrap();
        assert_eq!(out2, "---\ntags: [甲, 乙]\n---\n");
    }

    #[test]
    fn set_tags_handles_empty_value_field() {
        // 空值：在冒号后插入；单个标签写成标量，行尾注释保留
        let out = set_tags("---\ntags: # 注释\n---\n", &["a".to_string()]).unwrap();
        assert_eq!(out, "---\ntags: a # 注释\n---\n");
        let two = set_tags(
            "---\ntags: # 注释\n---\n",
            &["a".to_string(), "b".to_string()],
        )
        .unwrap();
        assert_eq!(two, "---\ntags: [a, b] # 注释\n---\n");
        // 空标签 → 原样不动
        let same = set_tags("---\ntags:\n---\n", &[]).unwrap();
        assert_eq!(same, "---\ntags:\n---\n");
    }

    #[test]
    fn set_tags_removes_block_items_for_empty_list() {
        let text = "---\ntags:\n  - a\n  - b\nkey: v\n---\n";
        let out = set_tags(text, &[]).unwrap();
        assert_eq!(out, "---\ntags:\nkey: v\n---\n");
        // 行内数组 → `[]`
        let out2 = set_tags("---\ntags: [a]\n---\n", &[]).unwrap();
        assert_eq!(out2, "---\ntags: []\n---\n");
    }

    #[test]
    fn set_tags_cleans_and_dedups_input() {
        let out = set_tags(
            "---\ntags: [旧]\n---\n",
            &[
                " #甲 ".to_string(),
                "#甲".to_string(),
                "甲".to_string(),
                "".to_string(),
                "乙".to_string(),
            ],
        )
        .unwrap();
        assert_eq!(out, "---\ntags: [甲, 乙]\n---\n");
    }

    #[test]
    fn set_tags_prefers_tags_field_over_tag_field() {
        let text = "---\ntag: 旧单数\ntags: [旧]\n---\n";
        let out = set_tags(text, &["新".to_string()]).unwrap();
        assert_eq!(out, "---\ntag: 旧单数\ntags: [新]\n---\n");
        // 只有 `tag` 时改 `tag`
        let out2 = set_tags("---\ntag: 旧\n---\n", &["新".to_string()]).unwrap();
        assert_eq!(out2, "---\ntag: 新\n---\n");
    }

    #[test]
    fn set_tags_preserves_bom_and_quotes_unsafe_values() {
        let text = "\u{feff}---\ntags: [旧]\n---\n正文";
        // 开头的 `#` 会被清掉，剩下的 CJK 不需要引号
        let out = set_tags(text, &["#带井号".to_string()]).unwrap();
        assert!(out.starts_with('\u{feff}'));
        assert_eq!(out, "\u{feff}---\ntags: [带井号]\n---\n正文");
        assert_eq!(parse(&out).unwrap().tags, vec!["带井号".to_string()]);
        // 需要引号的标签（含逗号）会以单引号写出并被读回
        let quoted = set_tags(text, &["a, b".to_string()]).unwrap();
        assert_eq!(quoted, "\u{feff}---\ntags: ['a, b']\n---\n正文");
        assert_eq!(parse(&quoted).unwrap().tags, vec!["a, b".to_string()]);
    }

    #[test]
    fn set_tags_is_idempotent_and_round_trips() {
        let text = "---\ntitle: t\ntags: [a]\n---\n正文\n";
        let once = set_tags(text, &["x".to_string(), "y".to_string()]).unwrap();
        let twice = set_tags(&once, &["x".to_string(), "y".to_string()]).unwrap();
        assert_eq!(once, twice);
        assert_eq!(tags_of(&once), vec!["x".to_string(), "y".to_string()]);
    }

    #[test]
    fn set_tags_keeps_comments_around_the_block_items() {
        let text = "---\ntags:\n  - 旧\n# 列表后的注释必须保留\ntitle: t\n---\n";
        let out = set_tags(text, &["新".to_string()]).unwrap();
        assert_eq!(
            out,
            "---\ntags:\n  - 新\n# 列表后的注释必须保留\ntitle: t\n---\n"
        );
    }

    #[test]
    fn set_tags_does_not_touch_other_block_arrays() {
        let text = "---\ntags:\n  - 旧\n其他:\n  - 保留\n---\n";
        let fm = parse(text).unwrap();
        assert_eq!(
            fm.get("其他"),
            Some(&FrontmatterValue::List(vec!["保留".into()]))
        );
        let out = set_tags(text, &["新".to_string(), "再一个".to_string()]).unwrap();
        assert_eq!(
            out,
            "---\ntags:\n  - 新\n  - 再一个\n其他:\n  - 保留\n---\n"
        );
    }

    #[test]
    fn set_tags_only_touches_the_tags_bytes() {
        let text = "---\r\na: 1\r\ntags: [旧]\r\nb: \"保留 # 注释\"\r\n---\r\n正文\r\n";
        let out = set_tags(text, &["新".to_string()]).unwrap();
        let expected = "---\r\na: 1\r\ntags: [新]\r\nb: \"保留 # 注释\"\r\n---\r\n正文\r\n";
        assert_eq!(out, expected);
        // 逐字节：只有 tags 行不同
        let before: Vec<&str> = text.split("\r\n").collect();
        let after: Vec<&str> = out.split("\r\n").collect();
        assert_eq!(before.len(), after.len());
        for (index, (lhs, rhs)) in before.iter().zip(after.iter()).enumerate() {
            if index == 2 {
                assert_ne!(lhs, rhs);
            } else {
                assert_eq!(lhs, rhs, "第 {index} 行不应变化");
            }
        }
    }

    #[test]
    fn needs_quote_rules() {
        assert!(!needs_quote("普通标签"));
        assert!(!needs_quote("a-b_c/d.e"));
        assert!(needs_quote(""));
        assert!(needs_quote("带 空格 #"));
        assert!(needs_quote("-开头"));
        assert!(needs_quote("尾随 "));
        assert_eq!(format_scalar("有'引号"), "'有''引号'");
        assert_eq!(
            format_inline_list(&["a".into(), "b c".into()]),
            "[a, 'b c']"
        );
    }
}
