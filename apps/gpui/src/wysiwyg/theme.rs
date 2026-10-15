//! Live Preview 装饰主题（对齐桌面 `live-preview/theme.ts`）。
//!
//! 约定：
//! 1. **不实现 Editor**——写作面永远是 `gpui_kit::component::input::Editor`；
//! 2. 本模块只定义「语法角色 → 装饰样式」；颜色一律读 `cx.theme()` 语义令牌，
//!    切换全局主题时重算装饰即可，不必重建编辑器。

use gpui_kit::component::Theme;
use gpui_kit::{FontStyle, FontWeight, HighlightStyle, Hsla, StrikethroughStyle, UnderlineStyle};

use super::spans::{CalloutType, SpanKind};

/// 从全局主题投影出的 Live Preview 色板（对应桌面 `--mn-*` 角色）。
#[derive(Clone, Copy, Debug)]
pub struct LivePreviewTokens {
    pub foreground: Hsla,
    pub muted_foreground: Hsla,
    pub primary: Hsla,
    pub accent: Hsla,
    pub muted: Hsla,
    pub border: Hsla,
    pub warning: Hsla,
}

impl LivePreviewTokens {
    pub fn from_theme(theme: &Theme) -> Self {
        Self {
            foreground: theme.foreground,
            muted_foreground: theme.muted_foreground,
            primary: theme.primary,
            accent: theme.accent,
            muted: theme.muted,
            border: theme.border,
            warning: theme.warning,
        }
    }
}

/// callout 强调色：走主题语义令牌，不在 GPUI 侧抄 13 色表。
pub fn callout_accent(callout_type: CalloutType, tokens: LivePreviewTokens) -> Hsla {
    match callout_type {
        CalloutType::Warning | CalloutType::Failure | CalloutType::Danger => tokens.warning,
        CalloutType::Tip | CalloutType::Success => tokens.accent,
        CalloutType::Todo | CalloutType::Question | CalloutType::Bug => tokens.muted_foreground,
        CalloutType::Note
        | CalloutType::Abstract
        | CalloutType::Info
        | CalloutType::Example
        | CalloutType::Quote => tokens.primary,
    }
}

/// 阅读/编辑器统一的 12% 染色（Editor 只有单色 fill，用低 alpha 近似 color-mix）。
fn callout_fill(accent: Hsla) -> Hsla {
    Hsla {
        h: accent.h,
        s: accent.s,
        l: accent.l,
        a: 0.12,
    }
}

/// 某一语法角色的装饰产出。
#[derive(Clone, Debug, Default)]
pub struct RoleStyle {
    pub text: Option<HighlightStyle>,
    pub fill: Option<Hsla>,
}

/// 软隐藏标记（光标不在触碰范围时）。
pub fn marker_hidden(tokens: LivePreviewTokens) -> HighlightStyle {
    HighlightStyle {
        fade_out: Some(1.0),
        color: Some(tokens.muted_foreground),
        ..Default::default()
    }
}

/// 露出标记时的淡色（仍可见，但不抢正文）。
pub fn marker_revealed(tokens: LivePreviewTokens) -> HighlightStyle {
    HighlightStyle {
        color: Some(tokens.muted_foreground),
        ..Default::default()
    }
}

/// 列表标记：始终淡色可见（GPUI Editor 尚无 replace widget）。
pub fn list_mark(tokens: LivePreviewTokens) -> HighlightStyle {
    HighlightStyle {
        color: Some(tokens.muted_foreground),
        ..Default::default()
    }
}

/// 按角色给出内容样式（不含软隐藏标记）。
pub fn style_for(kind: &SpanKind, tokens: LivePreviewTokens) -> RoleStyle {
    match kind {
        SpanKind::Strong => RoleStyle {
            text: Some(HighlightStyle {
                font_weight: Some(FontWeight::BOLD),
                ..Default::default()
            }),
            fill: None,
        },
        SpanKind::Heading { level } => RoleStyle {
            text: Some(HighlightStyle {
                font_weight: Some(if *level <= 2 {
                    FontWeight::BOLD
                } else {
                    FontWeight::SEMIBOLD
                }),
                color: Some(if *level >= 6 {
                    tokens.muted_foreground
                } else {
                    tokens.foreground
                }),
                ..Default::default()
            }),
            fill: None,
        },
        SpanKind::Emphasis => RoleStyle {
            text: Some(HighlightStyle {
                font_style: Some(FontStyle::Italic),
                ..Default::default()
            }),
            fill: None,
        },
        SpanKind::Strikethrough => RoleStyle {
            text: Some(HighlightStyle {
                strikethrough: Some(StrikethroughStyle {
                    thickness: gpui_kit::px(1.),
                    color: Some(tokens.muted_foreground),
                }),
                color: Some(tokens.muted_foreground),
                ..Default::default()
            }),
            fill: None,
        },
        SpanKind::InlineCode => RoleStyle {
            text: Some(HighlightStyle {
                background_color: Some(tokens.muted),
                color: Some(tokens.accent),
                ..Default::default()
            }),
            fill: None,
        },
        SpanKind::Link => RoleStyle {
            text: Some(HighlightStyle {
                color: Some(tokens.primary),
                underline: Some(UnderlineStyle {
                    thickness: gpui_kit::px(1.),
                    color: Some(tokens.primary),
                    wavy: false,
                }),
                ..Default::default()
            }),
            fill: None,
        },
        // wikilink：虚线下划线观感用实线下划线近似（Editor 无 border-bottom 装饰）。
        SpanKind::Wikilink => RoleStyle {
            text: Some(HighlightStyle {
                color: Some(tokens.primary),
                underline: Some(UnderlineStyle {
                    thickness: gpui_kit::px(1.),
                    color: Some(tokens.primary),
                    wavy: true,
                }),
                ..Default::default()
            }),
            fill: None,
        },
        SpanKind::Blockquote => RoleStyle {
            text: Some(HighlightStyle {
                color: Some(tokens.muted_foreground),
                font_style: Some(FontStyle::Italic),
                ..Default::default()
            }),
            fill: Some(tokens.muted),
        },
        SpanKind::HorizontalRule => RoleStyle {
            text: None,
            fill: Some(tokens.border),
        },
        SpanKind::ListMark { .. } => RoleStyle::default(),
        SpanKind::FenceLine => RoleStyle {
            text: Some(HighlightStyle {
                color: Some(tokens.muted_foreground),
                ..Default::default()
            }),
            fill: None,
        },
        SpanKind::CodeBody => RoleStyle {
            text: Some(HighlightStyle {
                color: Some(tokens.accent),
                ..Default::default()
            }),
            fill: Some(tokens.muted),
        },
        SpanKind::Frontmatter => RoleStyle {
            text: Some(HighlightStyle {
                color: Some(tokens.muted_foreground),
                ..Default::default()
            }),
            fill: None,
        },
        SpanKind::CalloutMarker { callout_type } => {
            let accent = callout_accent(*callout_type, tokens);
            RoleStyle {
                text: Some(HighlightStyle {
                    font_weight: Some(FontWeight::SEMIBOLD),
                    color: Some(accent),
                    ..Default::default()
                }),
                fill: Some(callout_fill(accent)),
            }
        }
        SpanKind::CalloutBody { callout_type } => {
            let accent = callout_accent(*callout_type, tokens);
            RoleStyle {
                text: Some(HighlightStyle {
                    color: Some(tokens.foreground),
                    ..Default::default()
                }),
                fill: Some(callout_fill(accent)),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strong_is_bold_only() {
        let tokens = LivePreviewTokens {
            foreground: gpui_kit::hsla(0., 0., 0., 1.),
            muted_foreground: gpui_kit::hsla(0., 0., 0.5, 1.),
            primary: gpui_kit::hsla(0.6, 0.5, 0.5, 1.),
            accent: gpui_kit::hsla(0.1, 0.5, 0.5, 1.),
            muted: gpui_kit::hsla(0., 0., 0.9, 1.),
            border: gpui_kit::hsla(0., 0., 0.8, 1.),
            warning: gpui_kit::hsla(0.08, 0.7, 0.55, 1.),
        };
        let style = style_for(&SpanKind::Strong, tokens);
        assert_eq!(style.text.unwrap().font_weight, Some(FontWeight::BOLD));
        assert!(style.fill.is_none());
    }
}
