//! 笔记正文壳：kit [`Editor`] + Live Preview 装饰 + 阅读态 [`TextView`]。
//!
//! 不实现编辑器本体；实时预览只对 `EditorState` 的装饰集合 `set`。

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{
    Editor, EditorState, InputEvent, RangeDecorationCollection, TextDecorationCollection,
};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::text::{TextView, TextViewState};
use gpui_kit::component::{
    h_flex, v_flex, ActiveTheme as _, Disableable as _, IconName, Sizable as _, Theme,
};
use gpui_kit::prelude::*;
use gpui_kit::{
    actions, div, App, Context, Entity, EventEmitter, IntoElement, KeyBinding, Render,
    SharedString, Subscription, Window,
};

use super::decorations::build_decorations;
use super::format::{toggle_inline_mark, toggle_link, InlineMark};
use super::spans::collect_spans;
use super::theme::LivePreviewTokens;

actions!(
    wysiwyg,
    [
        ToggleBold,
        ToggleItalic,
        ToggleCode,
        ToggleStrike,
        ToggleLink,
        ToggleReadMode
    ]
);

const KEY_CONTEXT: &str = "WysiwygEditor";

/// 主区域模式：编辑（Live Preview）或只读阅读。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WysiwygMode {
    Edit,
    Read,
}

/// 正文壳对外事件（供预览标签在首次编辑时固定）。
#[derive(Clone, Debug)]
pub enum WysiwygEvent {
    Changed,
}

/// 笔记正文壳：托管 kit Editor 的装饰刷新与阅读态切换。
pub struct WysiwygEditor {
    editor: Entity<EditorState>,
    preview: Entity<TextViewState>,
    mode: WysiwygMode,
    text_decorations: TextDecorationCollection,
    range_decorations: RangeDecorationCollection,
    empty: bool,
    /// 避免装饰 `set` → Editor `notify` → observe → 再 `set` 的反馈环。
    last_decoration_key: (u64, usize, usize, bool),
    _subscriptions: Vec<Subscription>,
}

impl WysiwygEditor {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let editor = cx.new(|cx| {
            EditorState::new(window, cx)
                .language("markdown")
                .line_number(false)
                .folding(false)
                .placeholder("开始写笔记…")
        });
        let preview = cx.new(|cx| {
            TextViewState::markdown("", cx)
                .selectable(true)
                .scrollable(true)
        });

        let (text_decorations, range_decorations) = editor.update(cx, |state, cx| {
            (
                state.create_decorations_collection(Vec::new(), cx),
                state.create_range_decorations_collection(Vec::new(), cx),
            )
        });

        let editor_sub = cx.subscribe_in(&editor, window, |this, _, event, window, cx| {
            if matches!(
                event,
                InputEvent::Change | InputEvent::Focus | InputEvent::Blur
            ) {
                this.refresh_decorations(window, cx);
                if matches!(event, InputEvent::Change) {
                    this.sync_preview(cx);
                    cx.emit(WysiwygEvent::Changed);
                }
            }
        });
        let observe = cx.observe_in(&editor, window, |this, _, window, cx| {
            this.refresh_decorations(window, cx);
        });
        // 全局主题切换：只重算装饰，不重建 Editor。
        let theme_observe = cx.observe_global::<Theme>(|this, cx| {
            this.invalidate_decorations(cx);
        });

        Self {
            editor,
            preview,
            mode: WysiwygMode::Edit,
            text_decorations,
            range_decorations,
            empty: true,
            last_decoration_key: (0, 0, 0, false),
            _subscriptions: vec![editor_sub, observe, theme_observe],
        }
    }

    pub fn init(cx: &mut App) {
        cx.bind_keys([
            KeyBinding::new("ctrl-b", ToggleBold, Some(KEY_CONTEXT)),
            KeyBinding::new("cmd-b", ToggleBold, Some(KEY_CONTEXT)),
            KeyBinding::new("ctrl-i", ToggleItalic, Some(KEY_CONTEXT)),
            KeyBinding::new("cmd-i", ToggleItalic, Some(KEY_CONTEXT)),
            KeyBinding::new("ctrl-shift-k", ToggleCode, Some(KEY_CONTEXT)),
            KeyBinding::new("cmd-shift-k", ToggleCode, Some(KEY_CONTEXT)),
            KeyBinding::new("ctrl-shift-x", ToggleStrike, Some(KEY_CONTEXT)),
            KeyBinding::new("cmd-shift-x", ToggleStrike, Some(KEY_CONTEXT)),
            KeyBinding::new("ctrl-k", ToggleLink, Some(KEY_CONTEXT)),
            KeyBinding::new("cmd-k", ToggleLink, Some(KEY_CONTEXT)),
            KeyBinding::new("ctrl-e", ToggleReadMode, Some(KEY_CONTEXT)),
            KeyBinding::new("cmd-e", ToggleReadMode, Some(KEY_CONTEXT)),
        ]);
    }

    pub fn text(&self, cx: &App) -> String {
        self.editor.read(cx).value().to_string()
    }

    pub fn set_value(
        &mut self,
        text: impl Into<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let text = text.into();
        self.empty = text.is_empty();
        self.editor.update(cx, |state, cx| {
            state.set_value(text.clone(), window, cx);
        });
        self.preview.update(cx, |state, cx| {
            state.set_text(&text, cx);
        });
        self.refresh_decorations(window, cx);
        cx.notify();
    }

    pub fn editor_element_id(&self) -> gpui_kit::ElementId {
        ("input", self.editor.entity_id()).into()
    }

    pub fn mode(&self) -> WysiwygMode {
        self.mode
    }

    /// 测试用：当前装饰集合规模（证明样式已写入 kit Editor）。
    pub fn decoration_counts(&self, cx: &App) -> (usize, usize) {
        (
            self.text_decorations.get_ranges(cx).len(),
            self.range_decorations.get_ranges(cx).len(),
        )
    }

    /// 当前光标字节偏移（大纲高亮用）。
    pub fn caret_offset(&self, cx: &App) -> usize {
        self.editor.read(cx).selected_range().start
    }

    /// 测试与命令用：选中当前正文的全部字节。
    pub fn select_all(&mut self, cx: &mut Context<Self>) {
        let len = self.editor.read(cx).value().len();
        self.editor.update(cx, |state, cx| {
            state.set_selected_range(0..len, cx);
        });
    }

    /// 大纲跳转：把光标放到 `offset`（字节）。
    pub fn set_caret(&mut self, offset: usize, _window: &mut Window, cx: &mut Context<Self>) {
        let len = self.editor.read(cx).value().len();
        let offset = offset.min(len);
        self.editor.update(cx, |state, cx| {
            state.set_selected_range(offset..offset, cx);
        });
        self.refresh_decorations(_window, cx);
    }

    /// 编辑 / 阅读切换改用 Segmented Tabs。
    fn render_mode_tabs(&self, cx: &mut Context<Self>) -> impl IntoElement {
        use gpui_kit::component::tab::{Tab, TabBar};
        TabBar::new("wysiwyg-mode")
            .segmented()
            .xsmall()
            .selected_index(match self.mode {
                WysiwygMode::Edit => 0,
                WysiwygMode::Read => 1,
            })
            .on_click(cx.listener(|this, index, _, cx| {
                let mode = if *index == 0 {
                    WysiwygMode::Edit
                } else {
                    WysiwygMode::Read
                };
                this.set_mode(mode, cx);
            }))
            .child(Tab::new().label("编辑"))
            .child(Tab::new().label("阅读"))
    }

    fn set_mode(&mut self, mode: WysiwygMode, cx: &mut Context<Self>) {
        if self.mode == mode {
            return;
        }
        self.mode = mode;
        if mode == WysiwygMode::Read {
            self.sync_preview(cx);
        }
        cx.notify();
    }

    fn sync_preview(&mut self, cx: &mut Context<Self>) {
        let text = self.editor.read(cx).value().to_string();
        self.empty = text.is_empty();
        self.preview.update(cx, |state, cx| {
            state.set_text(&text, cx);
        });
    }

    fn invalidate_decorations(&mut self, cx: &mut Context<Self>) {
        self.last_decoration_key = (0, 0, 0, false);
        self.apply_decorations(cx);
    }

    fn refresh_decorations(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.apply_decorations(cx);
    }

    fn apply_decorations(&mut self, cx: &mut Context<Self>) {
        let (text, selection) = {
            let state = self.editor.read(cx);
            (state.value().to_string(), state.selected_range())
        };
        let dark = cx.theme().mode.is_dark();
        let key = (
            decoration_text_key(&text),
            selection.start,
            selection.end,
            dark,
        );
        if key == self.last_decoration_key {
            return;
        }
        self.last_decoration_key = key;
        self.empty = text.is_empty();
        let spans = collect_spans(&text);
        let tokens = LivePreviewTokens::from_theme(cx.theme());
        let built = build_decorations(&spans, selection, tokens);
        self.text_decorations.set(built.text, cx);
        self.range_decorations.set(built.ranges, cx);
    }

    fn apply_mark(&mut self, mark: InlineMark, window: &mut Window, cx: &mut Context<Self>) {
        if self.mode != WysiwygMode::Edit {
            return;
        }
        let (text, selection) = {
            let state = self.editor.read(cx);
            (state.value().to_string(), state.selected_range())
        };
        let edit = toggle_inline_mark(&text, selection, mark);
        self.editor.update(cx, |state, cx| {
            state.replace_all(edit.text, window, cx);
            state.set_selected_range(edit.selection, cx);
        });
        self.refresh_decorations(window, cx);
        self.sync_preview(cx);
    }

    fn apply_link(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.mode != WysiwygMode::Edit {
            return;
        }
        let (text, selection) = {
            let state = self.editor.read(cx);
            (state.value().to_string(), state.selected_range())
        };
        let edit = toggle_link(&text, selection);
        self.editor.update(cx, |state, cx| {
            state.replace_all(edit.text, window, cx);
            state.set_selected_range(edit.selection, cx);
        });
        self.refresh_decorations(window, cx);
        self.sync_preview(cx);
    }

    fn on_toggle_bold(&mut self, _: &ToggleBold, window: &mut Window, cx: &mut Context<Self>) {
        self.apply_mark(InlineMark::Bold, window, cx);
    }

    fn on_toggle_italic(&mut self, _: &ToggleItalic, window: &mut Window, cx: &mut Context<Self>) {
        self.apply_mark(InlineMark::Italic, window, cx);
    }

    fn on_toggle_code(&mut self, _: &ToggleCode, window: &mut Window, cx: &mut Context<Self>) {
        self.apply_mark(InlineMark::Code, window, cx);
    }

    fn on_toggle_strike(&mut self, _: &ToggleStrike, window: &mut Window, cx: &mut Context<Self>) {
        self.apply_mark(InlineMark::Strike, window, cx);
    }

    fn on_toggle_link(&mut self, _: &ToggleLink, window: &mut Window, cx: &mut Context<Self>) {
        self.apply_link(window, cx);
    }

    fn on_toggle_read_mode(&mut self, _: &ToggleReadMode, _: &mut Window, cx: &mut Context<Self>) {
        let next = match self.mode {
            WysiwygMode::Edit => WysiwygMode::Read,
            WysiwygMode::Read => WysiwygMode::Edit,
        };
        self.set_mode(next, cx);
    }

    fn render_format_toolbar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let editing = self.mode == WysiwygMode::Edit;
        h_flex()
            .gap_1()
            .items_center()
            .child(
                Button::new("fmt-bold")
                    .ghost()
                    .small()
                    .label("加粗")
                    .disabled(!editing)
                    .tooltip("加粗 (Ctrl+B)")
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.apply_mark(InlineMark::Bold, window, cx);
                    })),
            )
            .child(
                Button::new("fmt-italic")
                    .ghost()
                    .small()
                    .label("斜体")
                    .disabled(!editing)
                    .tooltip("斜体 (Ctrl+I)")
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.apply_mark(InlineMark::Italic, window, cx);
                    })),
            )
            .child(
                Button::new("fmt-code")
                    .ghost()
                    .small()
                    .label("代码")
                    .disabled(!editing)
                    .tooltip("行内代码 (Ctrl+Shift+K)")
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.apply_mark(InlineMark::Code, window, cx);
                    })),
            )
            .child(
                Button::new("fmt-strike")
                    .ghost()
                    .small()
                    .label("删除线")
                    .disabled(!editing)
                    .tooltip("删除线 (Ctrl+Shift+X)")
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.apply_mark(InlineMark::Strike, window, cx);
                    })),
            )
            .child(
                Button::new("fmt-link")
                    .ghost()
                    .small()
                    .icon(IconName::ExternalLink)
                    .label("链接…")
                    .disabled(!editing)
                    .tooltip("插入链接 (Ctrl+K)")
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.apply_link(window, cx);
                    })),
            )
    }
}

impl EventEmitter<WysiwygEvent> for WysiwygEditor {}

impl Render for WysiwygEditor {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let body = match self.mode {
            WysiwygMode::Edit => div()
                .id("wysiwyg-edit")
                .flex_1()
                .min_h_0()
                .w_full()
                .child(
                    Editor::new(&self.editor)
                        .aria_label("笔记正文")
                        .bordered(false)
                        .h_full(),
                )
                .into_any_element(),
            WysiwygMode::Read => {
                let content = if self.empty {
                    div()
                        .id("wysiwyg-empty")
                        .p_4()
                        .text_color(cx.theme().muted_foreground)
                        .child(SharedString::from("这篇笔记还没有内容"))
                        .into_any_element()
                } else {
                    TextView::new(&self.preview).p_4().into_any_element()
                };
                div()
                    .id("wysiwyg-read")
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .overflow_y_scrollbar()
                    .child(content)
                    .into_any_element()
            }
        };

        v_flex()
            .id("wysiwyg-editor")
            .key_context(KEY_CONTEXT)
            .size_full()
            .min_h_0()
            .on_action(cx.listener(Self::on_toggle_bold))
            .on_action(cx.listener(Self::on_toggle_italic))
            .on_action(cx.listener(Self::on_toggle_code))
            .on_action(cx.listener(Self::on_toggle_strike))
            .on_action(cx.listener(Self::on_toggle_link))
            .on_action(cx.listener(Self::on_toggle_read_mode))
            .child(
                h_flex()
                    .gap_2()
                    .px_3()
                    .py_1()
                    .items_center()
                    .justify_between()
                    .border_b_1()
                    .border_color(cx.theme().border)
                    .bg(cx.theme().background)
                    .child(self.render_format_toolbar(cx))
                    .child(self.render_mode_tabs(cx)),
            )
            .child(body)
    }
}

fn decoration_text_key(text: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish()
}
