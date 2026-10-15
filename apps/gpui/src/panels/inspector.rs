//! 右侧属性 / 标签 / 反链面板。

use gpui_kit::component::badge::Badge;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::description_list::{DescriptionItem, DescriptionList};
use gpui_kit::component::dock::{BasePanel, Panel, PanelEvent};
use gpui_kit::component::group_box::GroupBox;
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::tag::Tag;
use gpui_kit::component::{h_flex, v_flex, IconName, Sizable as _};
use gpui_kit::prelude::*;
use gpui_kit::{
    App, Context, EventEmitter, FocusHandle, Focusable, IntoElement, Render, SharedString,
    Subscription, WeakEntity, Window,
};

use crate::session::{display_name, NotePanelData};
use crate::workspace::Workspace;

pub struct InspectorPanel {
    focus: FocusHandle,
    workspace: WeakEntity<Workspace>,
    /// render 可能嵌在 Workspace lease 内，不能现场 `workspace.read`。
    cached_panel: NotePanelData,
    _workspace_sub: Option<Subscription>,
}

impl InspectorPanel {
    pub fn new(workspace: WeakEntity<Workspace>, cx: &mut Context<Self>) -> Self {
        // 构造时 Workspace 往往还在 `cx.new` lease 里，不能 read。
        let workspace_sub = workspace.upgrade().map(|entity| {
            cx.observe(&entity, |this, observed, cx| {
                this.cached_panel = observed.read(cx).panel_data().clone();
                cx.notify();
            })
        });
        Self {
            focus: cx.focus_handle(),
            workspace,
            cached_panel: NotePanelData::default(),
            _workspace_sub: workspace_sub,
        }
    }
}

impl BasePanel for InspectorPanel {
    fn panel_name(&self) -> &'static str {
        "InspectorPanel"
    }

    fn closable(&self, _: &App) -> bool {
        false
    }

    fn zoomable(&self, _: &App) -> bool {
        false
    }
}

impl Panel for InspectorPanel {
    fn title(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        "属性"
    }

    fn title_bar(&self, _: &App) -> bool {
        false
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
    }
}

impl EventEmitter<PanelEvent> for InspectorPanel {}

impl Focusable for InspectorPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for InspectorPanel {
    fn render(&mut self, _: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let Some(view) = self.workspace.upgrade() else {
            return v_flex().id("inspector-panel").size_full().into_any_element();
        };
        let panel = self.cached_panel.clone();

        let mut properties = DescriptionList::vertical().columns(1);
        if panel.properties.is_empty() {
            properties = properties.child(DescriptionItem::new("属性").value("这篇笔记没有属性"));
        } else {
            for (key, value) in &panel.properties {
                properties =
                    properties.child(DescriptionItem::new(key.clone()).value(value.clone()));
            }
        }

        let mut edit_rows = v_flex().gap_1();
        for (index, (key, value)) in panel.properties.iter().enumerate() {
            let key = key.clone();
            let value = value.clone();
            let view = view.clone();
            edit_rows = edit_rows.child(
                Button::new(("edit-prop", index as u64))
                    .ghost()
                    .small()
                    .label(format!("编辑 {key}"))
                    .on_click(move |_, window, cx| {
                        let key = key.clone();
                        let value = value.clone();
                        view.update(cx, |this, cx| {
                            this.prompt_edit_property(&key, &value, window, cx);
                        });
                    }),
            );
        }

        let mut tags = h_flex().gap_2().flex_wrap();
        if panel.tags.is_empty() {
            tags = tags.child("没有标签");
        } else {
            for tag in &panel.tags {
                tags = tags.child(Tag::secondary().small().child(tag.clone()));
            }
        }

        let mut links = v_flex().gap_1();
        if panel.backlinks.is_empty() {
            links = links.child("没有反链");
        } else {
            for rel in &panel.backlinks {
                let rel = rel.clone();
                let view = view.clone();
                let label = display_name(file_title(&rel).as_str());
                links = links.child(
                    Button::new(format!("backlink-{rel}"))
                        .ghost()
                        .label(label)
                        .on_click(move |_, window, cx| {
                            let rel = rel.clone();
                            view.update(cx, |this, cx| this.open_note_keep(&rel, window, cx));
                        }),
                );
            }
        }

        let add_view = view.clone();
        v_flex()
            .id("inspector-panel")
            .size_full()
            .min_h_0()
            .p_3()
            .gap_3()
            .overflow_y_scrollbar()
            .child(GroupBox::new().title("属性").child(properties))
            .child(edit_rows)
            .child(
                Button::new("add-note-property")
                    .outline()
                    .small()
                    .icon(IconName::Plus)
                    .label("添加笔记属性")
                    .on_click(move |_, window, cx| {
                        add_view.update(cx, |this, cx| this.prompt_add_property(window, cx));
                    }),
            )
            .child(GroupBox::new().title("标签").child(tags))
            .child(
                GroupBox::new()
                    .title(
                        h_flex()
                            .gap_2()
                            .child("反链")
                            .child(Badge::new().count(panel.backlinks.len())),
                    )
                    .child(links),
            )
            .into_any_element()
    }
}

fn file_title(rel: &str) -> SharedString {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    SharedString::from(display_name(name))
}
