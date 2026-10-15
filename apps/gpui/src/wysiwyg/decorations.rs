//! 把 [`LiveSpan`](super::spans::LiveSpan) 编成 kit [`Editor`](gpui_kit::component::input::Editor) 的装饰集合。
//!
//! 样式来自 [`theme`](super::theme)；本文件只负责「何时露原文 / 何时软隐藏」。

use std::ops::Range;

use gpui_kit::component::input::{RangeDecoration, RangeDecorationStyle, TextDecoration};

use super::spans::{cursor_on_line, selection_touches, LiveSpan, SpanKind};
use super::theme::{
    list_mark, marker_hidden, marker_revealed, style_for, LivePreviewTokens, RoleStyle,
};

pub struct BuiltDecorations {
    pub text: Vec<TextDecoration>,
    pub ranges: Vec<RangeDecoration>,
}

/// 按块级/行内判据决定是否露原文，再套用 Live Preview 主题样式。
pub fn build_decorations(
    spans: &[LiveSpan],
    selection: Range<usize>,
    tokens: LivePreviewTokens,
) -> BuiltDecorations {
    let mut text = Vec::new();
    let mut ranges = Vec::new();

    for span in spans {
        let reveal = match span.kind {
            SpanKind::Heading { .. }
            | SpanKind::Blockquote
            | SpanKind::HorizontalRule
            | SpanKind::FenceLine
            | SpanKind::CodeBody
            |             SpanKind::Frontmatter
            | SpanKind::ListMark { .. }
            | SpanKind::CalloutMarker { .. }
            | SpanKind::CalloutBody { .. } => cursor_on_line(&selection, &span.reveal),
            SpanKind::Strong
            | SpanKind::Emphasis
            | SpanKind::Strikethrough
            | SpanKind::InlineCode
            | SpanKind::Link
            | SpanKind::Wikilink => selection_touches(&selection, &span.reveal),
        };

        match span.kind {
            SpanKind::ListMark { .. } => {
                for marker in &span.markers {
                    if marker.is_empty() {
                        continue;
                    }
                    text.push(TextDecoration::new(marker.clone(), list_mark(tokens)));
                }
            }
            SpanKind::Frontmatter | SpanKind::CodeBody => {}
            _ => {
                let style = if reveal {
                    marker_revealed(tokens)
                } else {
                    marker_hidden(tokens)
                };
                for marker in &span.markers {
                    if marker.is_empty() {
                        continue;
                    }
                    text.push(TextDecoration::new(marker.clone(), style));
                }
            }
        }

        if span.content.is_empty() && !matches!(span.kind, SpanKind::HorizontalRule) {
            continue;
        }

        // 围栏行：仅在露原文时给内容淡色，否则整行已被软隐藏。
        if matches!(span.kind, SpanKind::FenceLine) && !reveal {
            continue;
        }

        push_role(
            &mut text,
            &mut ranges,
            &span.content,
            &span.reveal,
            style_for(&span.kind, tokens),
        );
    }

    BuiltDecorations { text, ranges }
}

fn push_role(
    text: &mut Vec<TextDecoration>,
    ranges: &mut Vec<RangeDecoration>,
    content: &Range<usize>,
    reveal: &Range<usize>,
    role: RoleStyle,
) {
    if let Some(fill) = role.fill {
        ranges.push(
            RangeDecoration::new(reveal.clone())
                .with_style(RangeDecorationStyle::Fill)
                .with_color(fill),
        );
    }
    if let Some(style) = role.text {
        if !content.is_empty() {
            text.push(TextDecoration::new(content.clone(), style));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wysiwyg::spans::collect_spans;

    fn tokens() -> LivePreviewTokens {
        let clear = gpui_kit::hsla(0., 0., 0., 0.);
        LivePreviewTokens {
            foreground: clear,
            muted_foreground: clear,
            primary: clear,
            accent: clear,
            muted: clear,
            border: clear,
            warning: clear,
        }
    }

    #[test]
    fn hides_inline_markers_when_cursor_outside() {
        let text = "**粗体** 后";
        let spans = collect_spans(text);
        let built_away = build_decorations(&spans, text.len()..text.len(), tokens());
        assert!(built_away
            .text
            .iter()
            .any(|decoration| decoration.style.fade_out == Some(1.0)));
        let built_inside = build_decorations(&spans, 2..2, tokens());
        assert!(!built_inside
            .text
            .iter()
            .any(|decoration| decoration.style.fade_out == Some(1.0)));
    }

    #[test]
    fn heading_markers_follow_line_cursor() {
        let text = "# 标题\n正文";
        let spans = collect_spans(text);
        let off_line = build_decorations(&spans, text.len()..text.len(), tokens());
        assert!(off_line
            .text
            .iter()
            .any(|decoration| decoration.style.fade_out == Some(1.0)));
        let on_line = build_decorations(&spans, 3..3, tokens());
        assert!(!on_line
            .text
            .iter()
            .any(|decoration| decoration.style.fade_out == Some(1.0)));
    }

    #[test]
    fn list_marks_stay_visible() {
        let text = "- 一项";
        let spans = collect_spans(text);
        let built = build_decorations(&spans, text.len()..text.len(), tokens());
        assert!(!built
            .text
            .iter()
            .any(|decoration| decoration.style.fade_out == Some(1.0)));
    }

    #[test]
    fn fence_body_gets_range_fill() {
        let text = "```\ncode\n```\n";
        let spans = collect_spans(text);
        let built = build_decorations(&spans, 0..0, tokens());
        assert!(!built.ranges.is_empty());
    }

    #[test]
    fn callout_markers_hide_when_cursor_off_line() {
        let text = "> [!note] 标题\n> 正文\n";
        let spans = collect_spans(text);
        let away = build_decorations(&spans, text.len()..text.len(), tokens());
        assert!(away
            .text
            .iter()
            .any(|d| d.style.fade_out == Some(1.0) && text[d.range.clone()].contains('!')));
        let on_marker = build_decorations(&spans, 3..3, tokens());
        assert!(!on_marker
            .text
            .iter()
            .any(|d| d.style.fade_out == Some(1.0) && text[d.range.clone()].contains('!')));
    }

    #[test]
    fn callout_body_gets_range_fill() {
        let text = "> [!tip] 提示\n> 详情\n";
        let spans = collect_spans(text);
        let built = build_decorations(&spans, text.len()..text.len(), tokens());
        assert!(built.ranges.len() >= 2);
    }
}
