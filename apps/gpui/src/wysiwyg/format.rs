//! 行内格式开关：包裹 / 摘除 Markdown 标记（与桌面端 `format.ts` 同语义）。

use std::ops::Range;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InlineMark {
    Bold,
    Italic,
    Code,
    Strike,
}

impl InlineMark {
    pub fn marker(self) -> &'static str {
        match self {
            Self::Bold => "**",
            Self::Italic => "*",
            Self::Code => "`",
            Self::Strike => "~~",
        }
    }

}

/// 对选区切换行内标记后的文档与新选区。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FormatEdit {
    pub text: String,
    pub selection: Range<usize>,
}

pub fn toggle_inline_mark(text: &str, selection: Range<usize>, mark: InlineMark) -> FormatEdit {
    let marker = mark.marker();
    let len = marker.len();
    let start = selection.start.min(text.len());
    let end = selection.end.min(text.len()).max(start);
    let before = if start >= len {
        &text[start - len..start]
    } else {
        ""
    };
    let after = if end + len <= text.len() {
        &text[end..end + len]
    } else {
        ""
    };
    let selected = &text[start..end];

    if selected.len() >= len * 2 && selected.starts_with(marker) && selected.ends_with(marker) {
        let inner = &selected[len..selected.len() - len];
        let mut next = String::with_capacity(text.len() - len * 2);
        next.push_str(&text[..start]);
        next.push_str(inner);
        next.push_str(&text[end..]);
        return FormatEdit {
            text: next,
            selection: start..start + inner.len(),
        };
    }

    if before == marker && after == marker {
        let mut next = String::with_capacity(text.len() - len * 2);
        next.push_str(&text[..start - len]);
        next.push_str(selected);
        next.push_str(&text[end + len..]);
        return FormatEdit {
            text: next,
            selection: start - len..end - len,
        };
    }

    let mut next = String::with_capacity(text.len() + len * 2);
    next.push_str(&text[..start]);
    next.push_str(marker);
    next.push_str(selected);
    next.push_str(marker);
    next.push_str(&text[end..]);
    FormatEdit {
        text: next,
        selection: start + len..end + len,
    }
}

/// 插入或摘除 Markdown 链接。
pub fn toggle_link(text: &str, selection: Range<usize>) -> FormatEdit {
    let start = selection.start.min(text.len());
    let end = selection.end.min(text.len()).max(start);
    let selected = &text[start..end];

    if let Some(inner) = strip_md_link(selected) {
        let mut next = String::with_capacity(text.len());
        next.push_str(&text[..start]);
        next.push_str(inner);
        next.push_str(&text[end..]);
        return FormatEdit {
            text: next,
            selection: start..start + inner.len(),
        };
    }

    if start == end {
        let mut next = String::with_capacity(text.len() + 4);
        next.push_str(&text[..start]);
        next.push_str("[]()");
        next.push_str(&text[end..]);
        // 光标落在方括号内
        return FormatEdit {
            text: next,
            selection: start + 1..start + 1,
        };
    }

    let mut next = String::with_capacity(text.len() + 4);
    next.push_str(&text[..start]);
    next.push('[');
    next.push_str(selected);
    next.push_str("]()");
    next.push_str(&text[end..]);
    let caret = start + 1 + selected.len() + 2;
    FormatEdit {
        text: next,
        selection: caret..caret,
    }
}

fn strip_md_link(selected: &str) -> Option<&str> {
    if !selected.starts_with('[') || !selected.ends_with(')') {
        return None;
    }
    let close = selected.find("](")?;
    if close == 0 {
        return None;
    }
    Some(&selected[1..close])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_and_unwraps_bold() {
        let wrapped = toggle_inline_mark("重点", 0..6, InlineMark::Bold);
        assert_eq!(wrapped.text, "**重点**");
        assert_eq!(wrapped.selection, 2..8);
        let unwrapped = toggle_inline_mark(&wrapped.text, 0..wrapped.text.len(), InlineMark::Bold);
        assert_eq!(unwrapped.text, "重点");
    }

    #[test]
    fn unwraps_markers_outside_selection() {
        let edit = toggle_inline_mark("**重点**", 2..8, InlineMark::Bold);
        assert_eq!(edit.text, "重点");
        assert_eq!(edit.selection, 0..6);
    }

    #[test]
    fn inserts_link_around_selection() {
        let edit = toggle_link("文字", 0..6);
        assert_eq!(edit.text, "[文字]()");
        // 光标落在 `](` 之后、`)` 之前，方便粘地址
        assert_eq!(edit.selection, 9..9);
    }
}
