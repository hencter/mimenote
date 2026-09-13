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
        for tag in scanner.scan(line) {
            push_tag(&mut out, &mut seen, tag, TagSource::Inline, line_no);
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

impl BodyScanner {
    /// 扫描一行，返回该行抽到的标签（原文写法，不含 `#`）。
    fn scan(&mut self, line: &str) -> Vec<String> {
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
                    out.push(raw);
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
}
