//! ATX 标题大纲（对齐桌面 `domain/outline.ts`）。
//!
//! 只认 `# 标题`；跳过 frontmatter 与围栏代码块。行号从 1 起算。

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutlineHeading {
    pub level: u8,
    pub text: String,
    /// 1 起算的行号。
    pub line: usize,
    /// 该行在全文中的字节起点（跳转用）。
    pub byte_offset: usize,
}

/// 从 Markdown 源码抽出大纲。
pub fn parse_outline(text: &str) -> Vec<OutlineHeading> {
    if text.is_empty() {
        return Vec::new();
    }

    let mut headings = Vec::new();
    let mut offset = 0usize;
    let mut line_no = 0usize;
    let mut in_frontmatter = false;
    let mut fence: Option<(u8, usize)> = None; // (char, len)

    for line in text.split_inclusive('\n') {
        line_no += 1;
        let line_start = offset;
        offset += line.len();
        let content = line.trim_end_matches(['\r', '\n']);
        let trimmed = content.trim_start_matches([' ', '\t']);

        if line_no == 1 && matches!(trimmed, "---" | "+++" | ";;;") {
            in_frontmatter = true;
            continue;
        }
        if in_frontmatter {
            if trimmed == "---" || trimmed == "+++" || trimmed == ";;;" {
                in_frontmatter = false;
            }
            continue;
        }

        if let Some((ch, open_len)) = fence {
            if let Some((close_ch, close_len)) = fence_marker(trimmed) {
                if close_ch == ch && close_len >= open_len {
                    fence = None;
                }
            }
            continue;
        }
        if let Some((ch, len)) = fence_marker(trimmed) {
            fence = Some((ch, len));
            continue;
        }

        if let Some((level, raw)) = atx_heading(trimmed) {
            let text = display_text(raw);
            if text.is_empty() {
                continue;
            }
            headings.push(OutlineHeading {
                level,
                text,
                line: line_no,
                byte_offset: line_start,
            });
        }
    }

    headings
}

fn fence_marker(trimmed: &str) -> Option<(u8, usize)> {
    let bytes = trimmed.as_bytes();
    if bytes.len() < 3 {
        return None;
    }
    let ch = bytes[0];
    if ch != b'`' && ch != b'~' {
        return None;
    }
    let mut len = 0usize;
    while len < bytes.len() && bytes[len] == ch {
        len += 1;
    }
    if len >= 3 {
        Some((ch, len))
    } else {
        None
    }
}

fn atx_heading(trimmed: &str) -> Option<(u8, &str)> {
    let bytes = trimmed.as_bytes();
    let mut level = 0usize;
    while level < bytes.len() && bytes[level] == b'#' && level < 6 {
        level += 1;
    }
    if level == 0 {
        return None;
    }
    if level < bytes.len() {
        if bytes[level] != b' ' && bytes[level] != b'\t' {
            return None;
        }
        Some((level as u8, trimmed[level..].trim()))
    } else {
        Some((level as u8, ""))
    }
}

fn display_text(raw: &str) -> String {
    let mut s = raw.trim_end_matches(['#', ' ', '\t']).to_string();
    // 粗略剥行内标记，只服务大纲显示。
    for _ in 0..4 {
        let next = s
            .replace("**", "")
            .replace("__", "")
            .replace(['*', '_', '`'], "")
            .replace("~~", "");
        if next == s {
            break;
        }
        s = next;
    }
    // `[[target|alias]]` / `[[target]]`
    while let Some(start) = s.find("[[") {
        let Some(end_rel) = s[start + 2..].find("]]") else {
            break;
        };
        let inner = &s[start + 2..start + 2 + end_rel];
        let label = inner.split('|').next_back().unwrap_or(inner);
        s = format!("{}{}{}", &s[..start], label, &s[start + 2 + end_rel + 2..]);
    }
    s.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_atx_and_skips_fence_and_frontmatter() {
        let text = "---\ntitle: t\n---\n# 一\n```\n# 不是\n```\n## 二 **粗**\n";
        let items = parse_outline(text);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].level, 1);
        assert_eq!(items[0].text, "一");
        assert_eq!(items[0].line, 4);
        assert_eq!(items[1].text, "二 粗");
        assert_eq!(items[1].line, 8);
    }
}
