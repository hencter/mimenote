//! 左侧搜索面板（Dock 左栏 Tab，与文件树并列）。

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::dock::{BasePanel, Panel, PanelEvent};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::{v_flex, ActiveTheme as _, IconName};
use gpui_kit::prelude::*;
use gpui_kit::{
    div, App, Context, Entity, EventEmitter, FocusHandle, Focusable, IntoElement, Render,
    SharedString, Subscription, WeakEntity, Window,
};
use mn_index::search::SearchHit;

use crate::workspace::Workspace;

pub struct SearchPanel {
    query: Entity<InputState>,
    hits: Vec<SearchHit>,
    message: SharedString,
    focus: FocusHandle,
    workspace: WeakEntity<Workspace>,
    _subscriptions: Vec<Subscription>,
}

impl SearchPanel {
    pub fn new(
        workspace: WeakEntity<Workspace>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let query = cx.new(|cx| InputState::new(window, cx).placeholder("搜索笔记"));
        let query_sub = cx.subscribe_in(&query, window, |this, input, event, _, cx| match event {
            InputEvent::Change | InputEvent::PressEnter { .. } => {
                let value = input.read(cx).value().to_string();
                this.run_search(&value, cx);
            }
            _ => {}
        });

        Self {
            query,
            hits: Vec::new(),
            message: "输入关键词搜索笔记".into(),
            focus: cx.focus_handle(),
            workspace,
            _subscriptions: vec![query_sub],
        }
    }

    pub fn focus_query(&self, window: &mut Window, cx: &mut App) {
        self.query.read(cx).focus_handle(cx).focus(window, cx);
    }

    fn run_search(&mut self, query: &str, cx: &mut Context<Self>) {
        let trimmed = query.trim();
        let (hits, message, status) = if trimmed.is_empty() {
            (
                Vec::new(),
                "输入关键词搜索笔记".into(),
                "请输入要搜索的文字".into(),
            )
        } else if let Some(workspace) = self.workspace.upgrade() {
            let result = workspace.update(cx, |workspace, _| workspace.search_notes(trimmed));
            if result.is_empty() {
                (
                    Vec::new(),
                    format!("没有找到“{trimmed}”").into(),
                    format!("没有找到“{trimmed}”").into(),
                )
            } else {
                let status: SharedString = format!("找到 {} 条", result.len()).into();
                (result, status.clone(), status)
            }
        } else {
            (Vec::new(), "库未打开".into(), "库未打开".into())
        };

        self.hits = hits;
        self.message = message;
        if let Some(workspace) = self.workspace.upgrade() {
            workspace.update(cx, |workspace, cx| {
                workspace.set_status(status, cx);
            });
        }
        cx.notify();
    }
}

impl BasePanel for SearchPanel {
    fn panel_name(&self) -> &'static str {
        "SearchPanel"
    }

    fn closable(&self, _: &App) -> bool {
        false
    }

    fn zoomable(&self, _: &App) -> bool {
        false
    }

    fn set_active(&mut self, active: bool, window: &mut Window, cx: &mut Context<Self>) {
        if active {
            self.focus_query(window, cx);
        }
    }
}

impl Panel for SearchPanel {
    fn tab_name(&self, _: &App) -> Option<SharedString> {
        Some("搜索".into())
    }

    fn title(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        IconName::Search
    }

    fn title_bar(&self, _: &App) -> bool {
        false
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
    }
}

impl EventEmitter<PanelEvent> for SearchPanel {}

impl Focusable for SearchPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for SearchPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let workspace = self.workspace.clone();
        let mut body = v_flex().gap_1().p_2();
        if self.hits.is_empty() {
            body = body.child(
                div()
                    .px_2()
                    .py_3()
                    .text_color(cx.theme().muted_foreground)
                    .child(self.message.clone()),
            );
        } else {
            for (index, hit) in self.hits.iter().enumerate() {
                let rel = hit.rel_path.clone();
                let label = format!("{}：{}", hit.rel_path, hit.snippet);
                let view = workspace.clone();
                body = body.child(
                    Button::new(("search-hit", index as u64))
                        .ghost()
                        .w_full()
                        .icon(IconName::File)
                        .label(label)
                        .on_click(move |_, window, cx| {
                            if let Some(workspace) = view.upgrade() {
                                workspace.update(cx, |this, cx| {
                                    this.open_note_keep(&rel, window, cx);
                                });
                            }
                        }),
                );
            }
        }

        v_flex()
            .id("search-panel")
            .size_full()
            .min_h_0()
            .child(
                div()
                    .px_2()
                    .py_2()
                    .border_b_1()
                    .border_color(cx.theme().border)
                    .child(Input::new(&self.query).id("search-query").w_full()),
            )
            .child(
                v_flex()
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scrollbar()
                    .child(body),
            )
    }
}
