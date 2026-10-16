//! Live Preview 区间判据（对齐桌面 `live-preview/build.ts` 的核心子集）。
//!
//! 文档始终是 Markdown 源码。块级用「光标是否在该行」决定露原文；
//! 行内用「选区是否与整段相交」。围栏代码块 / frontmatter 内不解析行内语法。

use std::ops::Range;

/// 一段需要样式或软隐藏的区间。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveSpan {
    pub kind: SpanKind,
    /// 用于「是否露原文」的触碰范围（行内=整段；块级=所在行）。
    pub reveal: Range<usize>,
    /// 需要样式的内容（不含标记）。
    pub content: Range<usize>,
    /// 应软隐藏的标记片段。
    pub markers: Vec<Range<usize>>,
}

/// 只放一段标记时用这个包一层。
///
/// 直接写 `vec![a..b]` 会被 clippy 的 `single_range_in_vec_init` 判成
/// 「本该是 `(a..b).collect()`」的笔误 —— 而这里向量里的元素**就是**区间
/// （同一个字段也有两段的用法，见 `marker_pair`），所以给它一个名字挡住那句误报。
fn single_marker(range: Range<usize>) -> Vec<Range<usize>> {
    vec![range]
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SpanKind {
    Strong,
    Emphasis,
    Strikethrough,
    InlineCode,
    Link,
    Wikilink,
    Heading {
        level: u8,
    },
    Blockquote,
    HorizontalRule,
    /// 列表标记保留可见（GPUI 尚无 widget 替换成 `•`/`1.`），只做淡色。
    ListMark {
        ordered: bool,
    },
    /// 围栏 ``` 行：光标不在时整行软隐藏。
    FenceLine,
    /// 围栏内部行：等宽底色。
    CodeBody,
    /// frontmatter：淡色等宽，不做语法渲染。
    Frontmatter,
    /// callout 标记行（`> [!note] 标题`）：软隐藏 `>` 与 `[!type]`，标题保留真文字。
    CalloutMarker {
        callout_type: CalloutType,
    },
    /// callout 正文行（引用续行）：染色块 + 软隐藏行首 `>`。
    CalloutBody {
        callout_type: CalloutType,
    },
}

/// Obsidian 核心 callout 类型（与 `domain/callouts.ts` 对齐）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CalloutType {
    Note,
    Abstract,
    Info,
    Todo,
    Tip,
    Success,
    Question,
    Warning,
    Failure,
    Danger,
    Bug,
    Example,
    Quote,
}

impl CalloutType {
    fn from_alias(raw: &str) -> Option<Self> {
        match raw.to_ascii_lowercase().as_str() {
            "note" => Some(Self::Note),
            "abstract" | "summary" | "tldr" => Some(Self::Abstract),
            "info" => Some(Self::Info),
            "todo" => Some(Self::Todo),
            "tip" | "hint" | "important" => Some(Self::Tip),
            "success" | "check" | "done" => Some(Self::Success),
            "question" | "help" | "faq" => Some(Self::Question),
            "warning" | "caution" | "attention" => Some(Self::Warning),
            "failure" | "fail" | "missing" => Some(Self::Failure),
            "danger" | "error" => Some(Self::Danger),
            "bug" => Some(Self::Bug),
            "example" => Some(Self::Example),
            "quote" | "cite" => Some(Self::Quote),
            _ => None,
        }
    }

    /// 未知类型回落为 `note`（样式），判据仍可通过 `parse_callout` 的 `known` 字段区分。
    fn normalize(raw: &str) -> Self {
        Self::from_alias(raw).unwrap_or(Self::Note)
    }
}

/// 引用块首行 callout 判据（对齐 `domain/callouts.ts` 的 `parseCallout`）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedCallout {
    pub callout_type: CalloutType,
    pub raw_type: String,
    pub known: bool,
    pub title: String,
    pub fold: Option<char>,
}

pub fn parse_callout(text: &str) -> Option<ParsedCallout> {
    let newline = text.find('\n');
    let first_line = match newline {
        None => text.trim(),
        Some(idx) => text[..idx].trim(),
    };
    if !first_line.starts_with("[!") {
        return None;
    }
    let close = first_line.find(']')?;
    let raw_type = first_line[2..close].trim();
    if raw_type.is_empty() || raw_type.contains('[') {
        return None;
    }

    let mut rest = first_line[close + 1..].to_string();
    let mut fold = None;
    if rest.starts_with('-') {
        fold = Some('-');
        rest = rest[1..].to_string();
    } else if rest.starts_with('+') {
        fold = Some('+');
        rest = rest[1..].to_string();
    }

    let known = CalloutType::from_alias(raw_type).is_some();
    Some(ParsedCallout {
        callout_type: CalloutType::normalize(raw_type),
        raw_type: raw_type.to_string(),
        known,
        title: rest.trim().to_string(),
        fold,
    })
}

/// 扫描 `text`，产出 Live Preview 区间。
pub fn collect_spans(text: &str) -> Vec<LiveSpan> {
    let mut spans = Vec::new();
    let fences = fence_regions(text);
    let frontmatter = frontmatter_region(text);

    let mut offset = 0;
    let mut lines: Vec<(usize, usize, &str)> = Vec::new();
    for line in text.split_inclusive('\n') {
        let start = offset;
        let end = offset + line.len();
        offset = end;
        let content = line.trim_end_matches(['\r', '\n']);
        lines.push((start, end, content));
    }

    let mut open_callout: Option<CalloutType> = None;

    for (line_start, line_end, content) in &lines {
        let line_range = *line_start..*line_end;
        if let Some(fm) = &frontmatter {
            if line_range.start < fm.end && line_range.end > fm.start {
                spans.push(LiveSpan {
                    kind: SpanKind::Frontmatter,
                    reveal: line_range.clone(),
                    content: *line_start..*line_start + content.len(),
                    markers: Vec::new(),
                });
                continue;
            }
        }

        if let Some(role) = fence_line_role(*line_start, *line_end, &fences) {
            match role {
                FenceRole::Fence => {
                    spans.push(LiveSpan {
                        kind: SpanKind::FenceLine,
                        reveal: line_range.clone(),
                        content: *line_start..*line_start + content.len(),
                        markers: single_marker(*line_start..*line_start + content.len()),
                    });
                }
                FenceRole::Body => {
                    spans.push(LiveSpan {
                        kind: SpanKind::CodeBody,
                        reveal: line_range.clone(),
                        content: *line_start..*line_start + content.len(),
                        markers: Vec::new(),
                    });
                }
            }
            continue;
        }

        if quote_prefix_len(content).is_none() {
            open_callout = None;
        }

        if let Some(span) = heading_span(content, *line_start, line_range.clone()) {
            spans.push(span);
        } else if let Some(span) = hr_span(content, *line_start, line_range.clone()) {
            spans.push(span);
        } else if let Some(span) =
            blockquote_or_callout_span(content, *line_start, line_range.clone(), &mut open_callout)
        {
            spans.push(span);
        } else if let Some(span) = list_mark_span(content, *line_start, line_range.clone()) {
            spans.push(span);
        }

        spans.extend(inline_spans(content, *line_start));
    }

    spans
}

#[derive(Clone, Copy)]
enum FenceRole {
    Fence,
    Body,
}

struct FenceRegion {
    open: Range<usize>,
    body: Range<usize>,
    close: Option<Range<usize>>,
}

fn fence_regions(text: &str) -> Vec<FenceRegion> {
    let mut regions = Vec::new();
    let mut offset = 0;
    let mut open_line: Option<(usize, usize)> = None; // start..end of open fence line
    for line in text.split_inclusive('\n') {
        let start = offset;
        let end = offset + line.len();
        offset = end;
        let trimmed = line.trim_end_matches(['\r', '\n']).trim_start();
        if !(trimmed.starts_with("```") || trimmed.starts_with("~~~")) {
            continue;
        }
        if let Some((open_start, open_end)) = open_line.take() {
            regions.push(FenceRegion {
                open: open_start..open_end,
                body: open_end..start,
                close: Some(start..end),
            });
        } else {
            open_line = Some((start, end));
        }
    }
    if let Some((open_start, open_end)) = open_line {
        regions.push(FenceRegion {
            open: open_start..open_end,
            body: open_end..text.len(),
            close: None,
        });
    }
    regions
}

fn fence_line_role(start: usize, end: usize, fences: &[FenceRegion]) -> Option<FenceRole> {
    for fence in fences {
        if ranges_overlap(&(start..end), &fence.open)
            || fence
                .close
                .as_ref()
                .is_some_and(|close| ranges_overlap(&(start..end), close))
        {
            return Some(FenceRole::Fence);
        }
        if start >= fence.body.start && start < fence.body.end {
            return Some(FenceRole::Body);
        }
    }
    None
}

fn frontmatter_region(text: &str) -> Option<Range<usize>> {
    let mut lines = text.split_inclusive('\n');
    let first = lines.next()?;
    let head = first
        .trim_end_matches(['\r', '\n'])
        .trim_start_matches('\u{feff}');
    if !matches!(head, "---" | "+++" | ";;;") {
        return None;
    }
    let fence = head;
    let mut offset = first.len();
    for line in lines {
        let body = line.trim_end_matches(['\r', '\n']);
        let next = offset + line.len();
        if body == fence {
            return Some(0..next);
        }
        offset = next;
        if offset > 64 * 1024 {
            break;
        }
    }
    None
}

fn heading_span(line: &str, base: usize, reveal: Range<usize>) -> Option<LiveSpan> {
    let bytes = line.as_bytes();
    let mut level = 0usize;
    while level < bytes.len() && bytes[level] == b'#' && level < 6 {
        level += 1;
    }
    if level == 0 || level >= bytes.len() || bytes[level] != b' ' {
        return None;
    }
    let marker_end = level + 1;
    Some(LiveSpan {
        kind: SpanKind::Heading { level: level as u8 },
        reveal,
        content: base + marker_end..base + line.len(),
        markers: single_marker(base..base + marker_end),
    })
}

fn hr_span(line: &str, base: usize, reveal: Range<usize>) -> Option<LiveSpan> {
    let trimmed = line.trim();
    if trimmed.len() < 3 {
        return None;
    }
    if trimmed.chars().all(|c| c == '-') || trimmed.chars().all(|c| c == '*') {
        Some(LiveSpan {
            kind: SpanKind::HorizontalRule,
            reveal,
            content: base..base + line.len(),
            markers: single_marker(base..base + line.len()),
        })
    } else {
        None
    }
}

/// 引用前缀长度：`> `、`> > ` 等与桌面 `QUOTE_PREFIX` 同口径。
fn quote_prefix_len(line: &str) -> Option<usize> {
    let bytes = line.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() && matches!(bytes[i], b' ' | b'\t') {
        i += 1;
    }
    let mut saw_gt = false;
    loop {
        while i < bytes.len() && matches!(bytes[i], b' ' | b'\t') {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] != b'>' {
            break;
        }
        saw_gt = true;
        i += 1;
    }
    if saw_gt {
        Some(i)
    } else {
        None
    }
}

fn blockquote_or_callout_span(
    line: &str,
    base: usize,
    reveal: Range<usize>,
    open_callout: &mut Option<CalloutType>,
) -> Option<LiveSpan> {
    let prefix_end = quote_prefix_len(line)?;
    let prefix_range = base..base + prefix_end;
    let content = &line[prefix_end..];
    let content_base = base + prefix_end;

    if let Some(callout) = read_callout_marker(content) {
        *open_callout = Some(callout.callout_type);
        let marker_range = content_base..content_base + callout.marker_len;
        let title_start = content_base + callout.marker_len;
        return Some(LiveSpan {
            kind: SpanKind::CalloutMarker {
                callout_type: callout.callout_type,
            },
            reveal,
            content: title_start..base + line.len(),
            markers: vec![prefix_range, marker_range],
        });
    }

    if let Some(callout_type) = *open_callout {
        let body_start = content_base;
        return Some(LiveSpan {
            kind: SpanKind::CalloutBody { callout_type },
            reveal,
            content: body_start..base + line.len(),
            markers: vec![prefix_range],
        });
    }

    Some(LiveSpan {
        kind: SpanKind::Blockquote,
        reveal,
        content: content_base..base + line.len(),
        markers: vec![prefix_range],
    })
}

struct CalloutMarkerInfo {
    callout_type: CalloutType,
    marker_len: usize,
}

/// 一行引用内容里切出 callout 标记（对齐桌面 `readCallout` 的位置算术）。
fn read_callout_marker(content: &str) -> Option<CalloutMarkerInfo> {
    parse_callout(content)?;
    let close = content.find(']')?;
    let mut marker_len = close + 1;
    if marker_len < content.len()
        && (content[marker_len..].starts_with('-') || content[marker_len..].starts_with('+'))
    {
        marker_len += 1;
    }
    let raw_type = {
        let first = content.trim();
        let close = first.find(']')?;
        first[2..close].trim()
    };
    Some(CalloutMarkerInfo {
        callout_type: CalloutType::normalize(raw_type),
        marker_len,
    })
}

fn list_mark_span(line: &str, base: usize, reveal: Range<usize>) -> Option<LiveSpan> {
    let trimmed = line.trim_start();
    let indent = line.len() - trimmed.len();
    let bytes = trimmed.as_bytes();
    if bytes.is_empty() {
        return None;
    }

    // 无序：`- ` / `* ` / `+ `
    if matches!(bytes[0], b'-' | b'*' | b'+') && bytes.get(1) == Some(&b' ') {
        let mark_end = indent + 2;
        return Some(LiveSpan {
            kind: SpanKind::ListMark { ordered: false },
            reveal,
            content: base + mark_end..base + line.len(),
            markers: single_marker(base + indent..base + mark_end),
        });
    }

    // 有序：`1. ` / `12. `
    let mut digits = 0usize;
    while digits < bytes.len() && bytes[digits].is_ascii_digit() && digits < 9 {
        digits += 1;
    }
    if digits > 0 && bytes.get(digits) == Some(&b'.') && bytes.get(digits + 1) == Some(&b' ') {
        let mark_end = indent + digits + 2;
        return Some(LiveSpan {
            kind: SpanKind::ListMark { ordered: true },
            reveal,
            content: base + mark_end..base + line.len(),
            markers: single_marker(base + indent..base + mark_end),
        });
    }

    None
}

fn inline_spans(line: &str, base: usize) -> Vec<LiveSpan> {
    let mut spans = Vec::new();
    let mut protected = Vec::new();

    for (range, inner) in find_delimited(line, "`", "`") {
        let full = shift(range.clone(), base);
        protected.push(range.clone());
        spans.push(LiveSpan {
            kind: SpanKind::InlineCode,
            reveal: full.clone(),
            content: shift(inner, base),
            markers: marker_pair(full, 1),
        });
    }

    for (range, inner) in find_delimited(line, "**", "**") {
        if nested_in(&range, &protected) {
            continue;
        }
        let full = shift(range.clone(), base);
        protected.push(range);
        spans.push(LiveSpan {
            kind: SpanKind::Strong,
            reveal: full.clone(),
            content: shift(inner, base),
            markers: marker_pair(full, 2),
        });
    }

    for (range, inner) in find_delimited(line, "~~", "~~") {
        if nested_in(&range, &protected) {
            continue;
        }
        let full = shift(range.clone(), base);
        protected.push(range);
        spans.push(LiveSpan {
            kind: SpanKind::Strikethrough,
            reveal: full.clone(),
            content: shift(inner, base),
            markers: marker_pair(full, 2),
        });
    }

    for (range, inner) in find_emphasis(line) {
        if nested_in(&range, &protected) {
            continue;
        }
        let full = shift(range.clone(), base);
        protected.push(range);
        spans.push(LiveSpan {
            kind: SpanKind::Emphasis,
            reveal: full.clone(),
            content: shift(inner, base),
            markers: marker_pair(full, 1),
        });
    }

    for (range, label) in find_md_links(line) {
        if nested_in(&range, &protected) {
            continue;
        }
        let full = shift(range.clone(), base);
        let open = full.start;
        let label_start = open + 1;
        let label_end = label_start + label.len();
        spans.push(LiveSpan {
            kind: SpanKind::Link,
            reveal: full.clone(),
            content: label_start..label_end,
            markers: vec![open..label_start, label_end..full.end],
        });
        protected.push(range);
    }

    for (range, inner) in find_wikilinks(line) {
        if nested_in(&range, &protected) {
            continue;
        }
        let full = shift(range, base);
        spans.push(LiveSpan {
            kind: SpanKind::Wikilink,
            reveal: full.clone(),
            content: shift(inner, base),
            markers: marker_pair(full, 2),
        });
    }

    spans
}

fn marker_pair(full: Range<usize>, mark_len: usize) -> Vec<Range<usize>> {
    vec![
        full.start..full.start + mark_len,
        full.end.saturating_sub(mark_len)..full.end,
    ]
}

fn shift(range: Range<usize>, base: usize) -> Range<usize> {
    base + range.start..base + range.end
}

fn nested_in(range: &Range<usize>, haystack: &[Range<usize>]) -> bool {
    haystack
        .iter()
        .any(|other| range.start >= other.start && range.end <= other.end)
}

fn ranges_overlap(a: &Range<usize>, b: &Range<usize>) -> bool {
    a.start < b.end && a.end > b.start
}

fn find_delimited(line: &str, open: &str, close: &str) -> Vec<(Range<usize>, Range<usize>)> {
    let mut out = Vec::new();
    let bytes = line.as_bytes();
    let open_b = open.as_bytes();
    let close_b = close.as_bytes();
    let mut i = 0;
    while i + open_b.len() + close_b.len() <= bytes.len() {
        if &bytes[i..i + open_b.len()] != open_b {
            i += 1;
            continue;
        }
        let content_start = i + open_b.len();
        let mut j = content_start;
        while j + close_b.len() <= bytes.len() {
            if &bytes[j..j + close_b.len()] == close_b && j > content_start {
                let full = i..j + close_b.len();
                let inner = content_start..j;
                if !line[inner.clone()].contains('\n') {
                    out.push((full, inner));
                    i = j + close_b.len();
                    break;
                }
            }
            j += 1;
        }
        if j + close_b.len() > bytes.len() {
            i += 1;
        }
    }
    out
}

fn find_emphasis(line: &str) -> Vec<(Range<usize>, Range<usize>)> {
    let mut out = Vec::new();
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'*' {
            i += 1;
            continue;
        }
        if i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            i += 2;
            continue;
        }
        let content_start = i + 1;
        let mut j = content_start;
        while j < bytes.len() {
            if bytes[j] == b'*'
                && (j + 1 >= bytes.len() || bytes[j + 1] != b'*')
                && j > content_start
            {
                out.push((i..j + 1, content_start..j));
                i = j + 1;
                break;
            }
            if bytes[j] == b'*' && j + 1 < bytes.len() && bytes[j + 1] == b'*' {
                j += 2;
                continue;
            }
            j += 1;
        }
        if j >= bytes.len() {
            i += 1;
        }
    }
    out
}

fn find_md_links(line: &str) -> Vec<(Range<usize>, &str)> {
    let mut out = Vec::new();
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'[' {
            i += 1;
            continue;
        }
        if i + 1 < bytes.len() && bytes[i + 1] == b'[' {
            i += 1;
            continue;
        }
        let label_start = i + 1;
        let Some(label_end) = line[label_start..].find(']') else {
            i += 1;
            continue;
        };
        let label_end = label_start + label_end;
        if label_end + 1 >= bytes.len() || bytes[label_end + 1] != b'(' {
            i += 1;
            continue;
        }
        let url_start = label_end + 2;
        let Some(url_rel) = line[url_start..].find(')') else {
            i += 1;
            continue;
        };
        let end = url_start + url_rel + 1;
        let label = &line[label_start..label_end];
        if !label.contains('\n') {
            out.push((i..end, label));
        }
        i = end;
    }
    out
}

fn find_wikilinks(line: &str) -> Vec<(Range<usize>, Range<usize>)> {
    let mut out = Vec::new();
    let bytes = line.as_bytes();
    let mut i = 0;
    while i + 4 <= bytes.len() {
        if &bytes[i..i + 2] != b"[[" {
            i += 1;
            continue;
        }
        let content_start = i + 2;
        let Some(rel) = line[content_start..].find("]]") else {
            break;
        };
        let content_end = content_start + rel;
        if content_end > content_start {
            out.push((i..content_end + 2, content_start..content_end));
        }
        i = content_end + 2;
    }
    out
}

/// 行内：选区与 `reveal` 相交则露原文（空光标落在区间内也算）。
pub fn selection_touches(selection: &Range<usize>, reveal: &Range<usize>) -> bool {
    if selection.start == selection.end {
        let caret = selection.start;
        caret >= reveal.start && caret < reveal.end || (!reveal.is_empty() && caret == reveal.end)
    } else {
        selection.start < reveal.end && selection.end > reveal.start
    }
}

/// 块级：光标/选区落在该行任意位置（含行末）则露原文。
pub fn cursor_on_line(selection: &Range<usize>, reveal: &Range<usize>) -> bool {
    let lo = selection.start.min(selection.end);
    let hi = selection.start.max(selection.end);
    if lo == hi {
        lo >= reveal.start && lo <= reveal.end
    } else {
        lo < reveal.end && hi > reveal.start
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collects_strong_emphasis_and_code() {
        let spans = collect_spans("见 **粗体** 与 *斜体* 和 `码`");
        assert!(spans.iter().any(|s| s.kind == SpanKind::Strong));
        assert!(spans.iter().any(|s| s.kind == SpanKind::Emphasis));
        assert!(spans.iter().any(|s| s.kind == SpanKind::InlineCode));
    }

    #[test]
    fn heading_blockquote_and_list_marks() {
        let text = "# 标题\n> 引用\n- 一项\n1. 二项\n";
        let spans = collect_spans(text);
        let heading = spans
            .iter()
            .find(|s| matches!(s.kind, SpanKind::Heading { level: 1 }))
            .expect("heading");
        assert_eq!(&text[heading.markers[0].clone()], "# ");
        assert!(spans.iter().any(|s| s.kind == SpanKind::Blockquote));
        assert!(spans
            .iter()
            .any(|s| matches!(s.kind, SpanKind::ListMark { ordered: false })));
        assert!(spans
            .iter()
            .any(|s| matches!(s.kind, SpanKind::ListMark { ordered: true })));
    }

    #[test]
    fn fence_body_skips_inline_and_marks_fence_lines() {
        let text = "外 **粗**\n```rust\n内 **不粗**\n```\n后 **粗**\n";
        let spans = collect_spans(text);
        let strongs: Vec<_> = spans
            .iter()
            .filter(|s| s.kind == SpanKind::Strong)
            .collect();
        assert_eq!(strongs.len(), 2);
        assert!(spans.iter().any(|s| s.kind == SpanKind::FenceLine));
        assert!(spans.iter().any(|s| s.kind == SpanKind::CodeBody));
        assert!(!text[strongs[0].content.clone()].contains("不粗"));
    }

    #[test]
    fn frontmatter_is_plain_and_skips_inline() {
        let text = "---\ntags: [a]\n---\n**粗**\n";
        let spans = collect_spans(text);
        assert!(spans.iter().any(|s| s.kind == SpanKind::Frontmatter));
        let strongs: Vec<_> = spans
            .iter()
            .filter(|s| s.kind == SpanKind::Strong)
            .collect();
        assert_eq!(strongs.len(), 1);
        assert_eq!(&text[strongs[0].content.clone()], "粗");
    }

    #[test]
    fn wikilink_and_markdown_link() {
        let spans = collect_spans("见 [[笔记]] 与 [文字](https://a.test)");
        assert!(spans.iter().any(|s| s.kind == SpanKind::Wikilink));
        let link = spans
            .iter()
            .find(|s| s.kind == SpanKind::Link)
            .expect("link");
        assert_eq!(
            &"见 [[笔记]] 与 [文字](https://a.test)"[link.content.clone()],
            "文字"
        );
    }

    #[test]
    fn cursor_on_line_includes_line_end() {
        let reveal = 0..5;
        assert!(cursor_on_line(&(0..0), &reveal));
        assert!(cursor_on_line(&(5..5), &reveal));
        assert!(!cursor_on_line(&(6..6), &reveal));
    }

    #[test]
    fn parse_callout_matches_obsidian_markers() {
        let parsed = parse_callout("[!note] 标题").expect("callout");
        assert_eq!(parsed.callout_type, CalloutType::Note);
        assert!(parsed.known);
        assert_eq!(parsed.title, "标题");
        assert_eq!(parsed.fold, None);

        let folded = parse_callout("[!warning]- 注意").expect("fold");
        assert_eq!(folded.callout_type, CalloutType::Warning);
        assert_eq!(folded.fold, Some('-'));

        assert!(parse_callout("[note] 不是").is_none());
        let unknown = parse_callout("[!摘录]").expect("unknown");
        assert!(!unknown.known);
        assert_eq!(unknown.callout_type, CalloutType::Note);
    }

    #[test]
    fn callout_marker_and_body_spans() {
        let text = "> [!note] 标题\n> 正文\n";
        let spans = collect_spans(text);
        let marker = spans
            .iter()
            .find(|s| matches!(s.kind, SpanKind::CalloutMarker { .. }))
            .expect("marker");
        assert!(matches!(
            marker.kind,
            SpanKind::CalloutMarker {
                callout_type: CalloutType::Note
            }
        ));
        assert_eq!(&text[marker.markers[1].clone()], "[!note]");
        assert_eq!(text[marker.content.clone()].trim(), "标题");

        let body = spans
            .iter()
            .find(|s| matches!(s.kind, SpanKind::CalloutBody { .. }))
            .expect("body");
        assert_eq!(&text[body.content.clone()], "正文");
    }
}
