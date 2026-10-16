//! 右侧大纲面板：当前笔记的 ATX 标题树。

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::dock::{BasePanel, Panel, PanelEvent};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::{v_flex, ActiveTheme as _, Selectable as _};
use gpui_kit::prelude::*;
use gpui_kit::{
    div, App, Context, EventEmitter, FocusHandle, Focusable, IntoElement, Render, SharedString,
    Subscription, WeakEntity, Window,
};

use crate::outline::{parse_outline, OutlineHeading};
use crate::workspace::Workspace;

pub struct OutlinePanel {
    focus: FocusHandle,
    workspace: WeakEntity<Workspace>,
    /// render 可能嵌在 Workspace lease 内；正文 / 光标在 observe 里刷新。
    cached_text: String,
    cached_caret: usize,
    _subscription: Option<Subscription>,
}

impl OutlinePanel {
    pub fn new(workspace: WeakEntity<Workspace>, cx: &mut Context<Self>) -> Self {
        // 构造时 Workspace 往往还在 `cx.new` lease 里，不能 read。
        let subscription = workspace.upgrade().map(|entity| {
            cx.observe(&entity, |this, observed, cx| {
                this.cached_text = observed.read(cx).editor_text(cx);
                this.cached_caret = observed.read(cx).caret_offset(cx);
                cx.notify();
            })
        });
        Self {
            focus: cx.focus_handle(),
            workspace,
            cached_text: String::new(),
            cached_caret: 0,
            _subscription: subscription,
        }
    }
}

impl BasePanel for OutlinePanel {
    fn panel_name(&self) -> &'static str {
        "OutlinePanel"
    }

    fn closable(&self, _: &App) -> bool {
        false
    }

    fn zoomable(&self, _: &App) -> bool {
        false
    }
}

impl Panel for OutlinePanel {
    fn title(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        "大纲"
    }

    fn title_bar(&self, _: &App) -> bool {
        false
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
    }
}

impl EventEmitter<PanelEvent> for OutlinePanel {}

impl Focusable for OutlinePanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for OutlinePanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(view) = self.workspace.upgrade() else {
            return v_flex().id("outline-panel").size_full().into_any_element();
        };
        let headings = parse_outline(&self.cached_text);
        let active_line = active_heading_line(&headings, self.cached_caret);

        let mut body = v_flex().gap_0().p_2();
        if headings.is_empty() {
            body = body.child(
                div()
                    .px_2()
                    .py_3()
                    .text_color(cx.theme().muted_foreground)
                    .child("没有标题"),
            );
        } else {
            for heading in &headings {
                let active = Some(heading.line) == active_line;
                body = body.child(heading_row(heading, active, view.clone(), cx));
            }
        }

        v_flex()
            .id("outline-panel")
            .size_full()
            .min_h_0()
            .overflow_y_scrollbar()
            .child(body)
            .into_any_element()
    }
}

fn active_heading_line(headings: &[OutlineHeading], caret: usize) -> Option<usize> {
    headings
        .iter()
        .rev()
        .find(|heading| heading.byte_offset <= caret)
        .map(|heading| heading.line)
}

fn heading_row(
    heading: &OutlineHeading,
    active: bool,
    view: gpui_kit::Entity<Workspace>,
    _cx: &App,
) -> impl IntoElement {
    let offset = heading.byte_offset;
    let indent = gpui_kit::rems(0.5 + (heading.level.saturating_sub(1) as f32) * 0.75);
    let label: SharedString = heading.text.clone().into();
    Button::new(format!("outline-{}", heading.line))
        .ghost()
        .w_full()
        .pl(indent)
        .label(label)
        .selected(active)
        .on_click(move |_, window, cx| {
            view.update(cx, |this, cx| this.jump_to_offset(offset, window, cx));
        })
}
