//! Markdown 链接抽取：`[[wikilink]]`、`![[嵌入]]`、普通 Markdown 链接。
//!
//! 职责边界（刻意划得很窄）：
//!
//! * 只做"从一段文本里找出链接"这件事 —— 不解析 Markdown 结构、不碰文件系统；
//! * 因此它可以被独立测试，并被索引层（反向链接、未来的全文搜索与图谱）复用；
//! * **忠实抽取**：`[[Note#小节|别名]]` 会拆成 target / anchor / alias 三段，
//!   但不判断 target 到底指向哪个文件（那是索引层的事）。
//!
//! 会跳过：围栏代码块、行内代码、反斜杠转义的 `\[[`、外部 URL（http/https/mailto/…）。
//! 不支持：引用式链接 `[text][ref]`（笔记场景罕见，M3 再评估）。

use serde::Serialize;

/// 链接类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkKind {
    /// `[[目标]]`
    Wiki,
    /// `![[目标]]` 或 `![说明](x.md)`
    Embed,
    /// `[说明](目标.md)`
    Markdown,
}

/// 抽取到的一条链接。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRef {
    /// 链接类型。
    pub kind: LinkKind,
    /// 原始目标（已剥离锚点），例如 `笔记/某篇`。
    pub raw_target: String,
    /// 显示文本：`[[目标|别名]]` 的别名、`[文本](目标)` 的文本。
    pub alias: Option<String>,
    /// 锚点：`#小节`、`^块引用`（没有则为 `null`）。
    pub anchor: Option<String>,
    /// 行号（1 起）。
    pub line: u32,
}

/// 抽取文本中的所有链接（按出现顺序，含行号）。
pub fn extract_links(text: &str) -> Vec<LinkRef> {
    let mut out = Vec::new();
    let mut fence: Option<String> = None;

    for (index, line) in text.lines().enumerate() {
        let line_no = (index + 1) as u32;
        let trimmed = line.trim_start();

        if let Some(marker) = fence.clone() {
            if trimmed.starts_with(&marker) {
                fence = None;
            }
            continue;
        }
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fence = Some(trimmed.chars().take(3).collect());
            continue;
        }

        scan_line(line, line_no, &mut out);
    }

    out
}

/// 归一化链接目标，得到**用于匹配的键**：小写、反斜杠转 `/`、去掉 `.md`/`.markdown`
/// 后缀、去掉首尾 `/` 与 `./`。
///
/// 注意：返回值是**键**，不是给人看的显示文本 —— 显示请用 `LinkRef::raw_target`。
/// 小写化是为了在 Windows/macOS 这类大小写不敏感的文件系统上正确匹配。
pub fn normalize_target(raw: &str) -> String {
    let normalized = raw.trim().replace('\\', "/").to_lowercase();
    let trimmed = normalized.trim_start_matches("./").trim_matches('/');
    let without_ext = trimmed
        .strip_suffix(".markdown")
        .or_else(|| trimmed.strip_suffix(".md"))
        .unwrap_or(trimmed);
    without_ext.trim().to_string()
}

/// 把链接目标按"相对某个目录"拼接并归一化（正确处理 `.` 与 `..`）。
///
/// 返回 `None` 表示路径越出了 Vault 根（例如 `../../外面`），调用方应视为无法解析。
pub fn join_relative(base_dir: &str, target: &str) -> Option<String> {
    let mut segments: Vec<&str> = Vec::new();
    for segment in base_dir.split('/').filter(|part| !part.is_empty()) {
        segments.push(segment);
    }
    for segment in target.split('/') {
        match segment {
            "" | "." => continue,
            // 越出 Vault 根（`../` 多于已有层级）→ 无法解析
            ".." => {
                segments.pop()?;
            }
            other => segments.push(other),
        }
    }
    Some(segments.join("/"))
}

/// 目标是否像 Markdown 笔记（用于索引层过滤附件）。
pub fn is_markdown_target(raw: &str) -> bool {
    let lowered = raw.trim().to_ascii_lowercase();
    lowered.ends_with(".md") || lowered.ends_with(".markdown") || !lowered.contains('.')
}

fn scan_line(line: &str, line_no: u32, out: &mut Vec<LinkRef>) {
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0usize;
    let mut in_code = false;

    while i < chars.len() {
        let current = chars[i];

        if current == '`' {
            in_code = !in_code;
            i += 1;
            continue;
        }
        if in_code {
            i += 1;
            continue;
        }
        // 反斜杠转义：跳过下一个字符（这样 `\[[x]]` 不会被当成链接）
        if current == '\\' {
            i += 2;
            continue;
        }

        if current == '!' && chars.get(i + 1) == Some(&'[') {
            if let Some((link, next)) = parse_wikilink(&chars, i + 1, line_no, LinkKind::Embed) {
                out.push(link);
                i = next;
                continue;
            }
            if let Some((link, next)) = parse_markdown_link(&chars, i, line_no) {
                out.push(link);
                i = next;
                continue;
            }
            i += 1;
            continue;
        }

        if current == '[' {
            if let Some((link, next)) = parse_wikilink(&chars, i, line_no, LinkKind::Wiki) {
                out.push(link);
                i = next;
                continue;
            }
            if let Some((link, next)) = parse_markdown_link(&chars, i, line_no) {
                out.push(link);
                i = next;
                continue;
            }
        }

        i += 1;
    }
}

/// 解析 `[[...]]`（`start` 指向第一个 `[`）。返回链接与下一个扫描位置。
fn parse_wikilink(
    chars: &[char],
    start: usize,
    line_no: u32,
    kind: LinkKind,
) -> Option<(LinkRef, usize)> {
    if chars.get(start) != Some(&'[') || chars.get(start + 1) != Some(&'[') {
        return None;
    }

    let mut cursor = start + 2;
    let mut inner = String::new();
    while cursor < chars.len() {
        if chars[cursor] == ']' && chars.get(cursor + 1) == Some(&']') {
            break;
        }
        inner.push(chars[cursor]);
        cursor += 1;
    }
    if cursor >= chars.len() {
        return None; // 未闭合：忽略，不算链接
    }
    let next = cursor + 2;

    let inner = inner.trim();
    if inner.is_empty() {
        return None;
    }

    let (target_part, alias) = match inner.split_once('|') {
        Some((target, alias)) => (target.trim(), Some(alias.trim().to_string())),
        None => (inner, None),
    };
    let (target, anchor) = split_anchor(target_part);
    if target.is_empty() && anchor.is_none() {
        return None;
    }

    Some((
        LinkRef {
            kind,
            raw_target: target,
            alias: alias.filter(|value| !value.is_empty()),
            anchor,
            line: line_no,
        },
        next,
    ))
}

/// 解析 `[文本](目标)` / `![说明](目标)`（`start` 指向 `[` 或图片的 `!`）。
fn parse_markdown_link(chars: &[char], start: usize, line_no: u32) -> Option<(LinkRef, usize)> {
    let is_embed = chars[start] == '!';
    let bracket = if is_embed { start + 1 } else { start };
    if chars.get(bracket) != Some(&'[') {
        return None;
    }

    let mut cursor = bracket + 1;
    let mut text = String::new();
    while cursor < chars.len() && chars[cursor] != ']' {
        if chars[cursor] == '[' {
            return None; // 不支持嵌套方括号
        }
        text.push(chars[cursor]);
        cursor += 1;
    }
    if cursor >= chars.len() || chars.get(cursor + 1) != Some(&'(') {
        return None;
    }

    cursor += 2;
    let angled = chars.get(cursor) == Some(&'<');
    if angled {
        cursor += 1;
    }

    let mut target = String::new();
    while cursor < chars.len() {
        let current = chars[cursor];
        if angled && current == '>' {
            break;
        }
        if !angled && (current == ')' || current == ' ' || current == '\t') {
            break;
        }
        target.push(current);
        cursor += 1;
    }

    // 跳到右括号（跳过 `"标题"` 之类的部分）
    while cursor < chars.len() && chars[cursor] != ')' {
        cursor += 1;
    }
    if cursor >= chars.len() {
        return None;
    }
    let next = cursor + 1;

    let target = target.trim();
    if target.is_empty() || is_external(target) {
        return None;
    }

    let (target, anchor) = split_anchor(target);
    let kind = if is_embed {
        LinkKind::Embed
    } else {
        LinkKind::Markdown
    };
    let alias = text.trim();

    Some((
        LinkRef {
            kind,
            raw_target: target,
            alias: if alias.is_empty() {
                None
            } else {
                Some(alias.to_string())
            },
            anchor,
            line: line_no,
        },
        next,
    ))
}

/// 拆出锚点：`目标#小节`、`目标^块`；纯 `#小节` 时 target 为空。
fn split_anchor(input: &str) -> (String, Option<String>) {
    let (target, anchor) = match input.split_once('#') {
        Some((target, anchor)) => (target, Some(anchor.to_string())),
        None => (input, None),
    };
    // `[[Note^blockid]]` 这种块引用写法
    match target.split_once('^') {
        Some((head, block)) => (
            head.to_string(),
            Some(match anchor {
                Some(existing) if !existing.is_empty() => existing,
                _ => block.to_string(),
            }),
        ),
        None => (target.to_string(), anchor),
    }
}

/// 是否外部链接（笔记链接图不关心）。
fn is_external(target: &str) -> bool {
    let lowered = target.trim().to_ascii_lowercase();
    const SCHEMES: [&str; 8] = [
        "http://", "https://", "mailto:", "tel:", "file:", "data:", "ftp://", "ssh://",
    ];
    SCHEMES.iter().any(|scheme| lowered.starts_with(scheme))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wiki(target: &str) -> LinkRef {
        LinkRef {
            kind: LinkKind::Wiki,
            raw_target: target.to_string(),
            alias: None,
            anchor: None,
            line: 1,
        }
    }

    #[test]
    fn extracts_plain_wikilink() {
        let links = extract_links("看这里 [[另一篇笔记]] 结束");
        assert_eq!(links, vec![wiki("另一篇笔记")]);
    }

    #[test]
    fn extracts_alias_and_path() {
        let links = extract_links("[[笔记/某篇|显示文本]]");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].raw_target, "笔记/某篇");
        assert_eq!(links[0].alias.as_deref(), Some("显示文本"));
        assert_eq!(links[0].kind, LinkKind::Wiki);
    }

    #[test]
    fn extracts_anchor_and_block_reference() {
        let links = extract_links("[[笔记#小节]] 与 [[笔记^块标识]] 与 [[#本文小节]]");
        assert_eq!(links[0].raw_target, "笔记");
        assert_eq!(links[0].anchor.as_deref(), Some("小节"));
        assert_eq!(links[1].raw_target, "笔记");
        assert_eq!(links[1].anchor.as_deref(), Some("块标识"));
        // 纯锚点：target 为空、anchor 有值 —— 指向文内
        assert_eq!(links[2].raw_target, "");
        assert_eq!(links[2].anchor.as_deref(), Some("本文小节"));
    }

    #[test]
    fn extracts_embeds() {
        let links = extract_links("![[另一篇]]");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].kind, LinkKind::Embed);
        assert_eq!(links[0].raw_target, "另一篇");
    }

    #[test]
    fn extracts_markdown_links_and_skips_external() {
        let links = extract_links(
            "[本地](子目录/目标.md) [带空格](<有 空格.md>) [外链](https://example.com) [锚点](#小节) [邮件](mailto:a@b.c)",
        );
        // 外链与 mailto 被跳过；纯锚点链接保留（它是"文内自引用"，由索引层决定要不要展示）
        assert_eq!(links.len(), 3, "实际：{links:?}");
        assert_eq!(links[0].raw_target, "子目录/目标.md");
        assert_eq!(links[0].alias.as_deref(), Some("本地"));
        assert_eq!(links[0].kind, LinkKind::Markdown);
        assert_eq!(links[1].raw_target, "有 空格.md");
        assert_eq!(links[2].raw_target, "");
        assert_eq!(links[2].anchor.as_deref(), Some("小节"));
    }

    #[test]
    fn extracts_markdown_image_as_embed() {
        let links = extract_links("![图示](图.md)");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].kind, LinkKind::Embed);
    }

    #[test]
    fn ignores_code_fences_and_inline_code() {
        let text = "# 标题\n\n```\n[[不该被抽取]]\n```\n\n正文 `[[也不算]]` 结束\n\n~~~\n[[同样不算]]\n~~~\n";
        assert_eq!(extract_links(text), Vec::new());
    }

    #[test]
    fn ignores_escaped_and_unclosed() {
        assert_eq!(extract_links("\\[[不是链接]]"), Vec::new());
        assert_eq!(extract_links("[[没有闭合"), Vec::new());
        assert_eq!(extract_links("[[ ]]"), Vec::new());
        assert_eq!(extract_links("[文本](未闭合"), Vec::new());
    }

    #[test]
    fn tracks_line_numbers() {
        let text = "第一行\n第二行 [[A]]\n第三行\n第四行 [[B]] 与 [[C]]\n";
        let links = extract_links(text);
        assert_eq!(links.len(), 3);
        assert_eq!(links[0].line, 2);
        assert_eq!(links[1].line, 4);
        assert_eq!(links[2].line, 4);
    }

    #[test]
    fn handles_unicode_and_bracket_edges() {
        let links = extract_links("[[中文 笔记-带空格]] 和 [[a[b]c]]");
        // `[[` 到最近的 `]]` 之间整体作为目标（与 Obsidian 一致）
        assert_eq!(links.len(), 2, "实际：{links:?}");
        assert_eq!(links[0].raw_target, "中文 笔记-带空格");
        assert_eq!(links[1].raw_target, "a[b]c");
    }

    #[test]
    fn join_relative_rules() {
        assert_eq!(
            join_relative("笔记", "../别的/丙").as_deref(),
            Some("别的/丙")
        );
        assert_eq!(join_relative("", "a/b").as_deref(), Some("a/b"));
        assert_eq!(
            join_relative("笔记/深层", "./丙").as_deref(),
            Some("笔记/深层/丙")
        );
        assert_eq!(join_relative("a", "b/../c").as_deref(), Some("a/c"));
        assert_eq!(
            join_relative("笔记", "../../逃逸"),
            None,
            "越出 Vault 根应被拒绝"
        );
        assert_eq!(join_relative("", "../x"), None);
    }

    #[test]
    fn normalize_target_rules() {
        assert_eq!(normalize_target("笔记/某篇.md"), "笔记/某篇");
        assert_eq!(normalize_target("笔记\\某篇.MD"), "笔记/某篇");
        assert_eq!(normalize_target("./某篇.markdown"), "某篇");
        assert_eq!(normalize_target("/前导斜杠/某篇"), "前导斜杠/某篇");
        assert_eq!(normalize_target("  Trim  "), "trim");
    }

    #[test]
    fn markdown_target_detection() {
        assert!(is_markdown_target("某篇"));
        assert!(is_markdown_target("dir/某篇.md"));
        assert!(is_markdown_target("某篇.MARKDOWN"));
        assert!(!is_markdown_target("图.png"));
        assert!(!is_markdown_target("附件.pdf"));
    }
}
