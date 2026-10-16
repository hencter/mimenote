//! 中央编辑区：kit Dynamic Tabs（Segmented）托管多篇笔记。
//!
//! 自身是 Dock 面板，可随 Dock 拆分 / 缩放 / 拖到左右栏；
//! 笔记切换与关闭走 [`TabBar`]，不走 Dock 默认标签条。
//!
//! 标签模型对齐 [Rísta](https://github.com/henrikogaard/rista)：
//! 树单击打开可替换的预览标签（斜体）；开始编辑或显式 keep 后固定。

use gpui_kit::component::breadcrumb::{Breadcrumb, BreadcrumbItem};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::description_list::{DescriptionItem, DescriptionList};
use gpui_kit::component::dock::{BasePanel, Panel, PanelControl, PanelEvent};
use gpui_kit::component::group_box::GroupBox;
use gpui_kit::component::tab::{Tab, TabBar};
use gpui_kit::component::tag::Tag;
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _, IconName, Sizable as _};
use gpui_kit::prelude::*;
use gpui_kit::{
    div, App, Context, Entity, EventEmitter, FocusHandle, Focusable, IntoElement, Render,
    SharedString, Subscription, WeakEntity, Window,
};

use crate::session::NotePanelData;
use crate::workspace::Workspace;
use crate::wysiwyg::{WysiwygEditor, WysiwygEvent};

struct OpenTab {
    rel_path: String,
    title: SharedString,
    base_mtime_ms: u64,
    editor: Entity<WysiwygEditor>,
    /// `true`：可被下一次预览打开替换（未脏且未固定）。
    preview: bool,
    _edit_sub: Subscription,
}

/// 编辑区面板：Segmented Dynamic Tabs + 当前笔记正文。
pub struct EditorTabs {
    tabs: Vec<OpenTab>,
    active_tab: usize,
    focus: FocusHandle,
    workspace: WeakEntity<Workspace>,
    /// 属性块缓存：render 在 Dock 子树里可能仍处在 Workspace lease 中，不能 `workspace.read`。
    cached_panel: NotePanelData,
    _workspace_sub: Option<Subscription>,
}

impl EditorTabs {
    pub fn new(workspace: WeakEntity<Workspace>, cx: &mut Context<Self>) -> Self {
        // 构造时 Workspace 往往还在 `cx.new` lease 里，不能 read；等 observe / notify。
        let workspace_sub = workspace.upgrade().map(|entity| {
            cx.observe(&entity, |this, observed, cx| {
                this.cached_panel = observed.read(cx).panel_data().clone();
                cx.notify();
            })
        });
        Self {
            tabs: Vec::new(),
            active_tab: 0,
            focus: cx.focus_handle(),
            workspace,
            cached_panel: NotePanelData::default(),
            _workspace_sub: workspace_sub,
        }
    }

    pub fn caret_offset(&self, cx: &App) -> usize {
        self.tabs
            .get(self.active_tab)
            .map(|tab| tab.editor.read(cx).caret_offset(cx))
            .unwrap_or(0)
    }

    pub fn active_rel(&self) -> Option<&str> {
        self.tabs.get(self.active_tab).map(|tab| tab.rel_path.as_str())
    }

    /// 打开笔记。`keep == false` 时走预览标签（替换已有预览）；`keep` 或编辑后固定。
    pub fn open(
        &mut self,
        rel: &str,
        title: SharedString,
        text: String,
        base_mtime_ms: u64,
        keep: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(index) = self.tabs.iter().position(|tab| tab.rel_path == rel) {
            self.active_tab = index;
            if keep {
                self.tabs[index].preview = false;
            }
            cx.notify();
            return;
        }

        let tab = self.make_tab(rel, title, text, base_mtime_ms, !keep, window, cx);
        if !keep {
            if let Some(ix) = self.tabs.iter().position(|t| t.preview) {
                self.tabs[ix] = tab;
                self.active_tab = ix;
                cx.notify();
                return;
            }
        }
        self.tabs.push(tab);
        self.active_tab = self.tabs.len() - 1;
        cx.notify();
    }

    fn make_tab(
        &mut self,
        rel: &str,
        title: SharedString,
        text: String,
        base_mtime_ms: u64,
        preview: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> OpenTab {
        let editor = cx.new(|cx| WysiwygEditor::new(window, cx));
        editor.update(cx, |state, cx| {
            state.set_value(text, window, cx);
        });
        let editor_id = editor.entity_id();
        let edit_sub = cx.subscribe(&editor, move |this, _, event: &WysiwygEvent, cx| {
            if !matches!(event, WysiwygEvent::Changed) {
                return;
            }
            if let Some(tab) = this
                .tabs
                .iter_mut()
                .find(|tab| tab.editor.entity_id() == editor_id)
            {
                if tab.preview {
                    tab.preview = false;
                    cx.notify();
                }
            }
        });
        OpenTab {
            rel_path: rel.to_string(),
            title,
            base_mtime_ms,
            editor,
            preview,
            _edit_sub: edit_sub,
        }
    }

    pub fn close_at(&mut self, index: usize, cx: &mut Context<Self>) -> Option<(String, String)> {
        if index >= self.tabs.len() {
            return None;
        }
        let tab = self.tabs.remove(index);
        let text = tab.editor.read(cx).text(cx);
        if self.tabs.is_empty() {
            self.active_tab = 0;
        } else if self.active_tab >= self.tabs.len() {
            self.active_tab = self.tabs.len() - 1;
        } else if index < self.active_tab {
            self.active_tab -= 1;
        }
        cx.notify();
        Some((tab.rel_path, text))
    }

    pub fn close_rel(&mut self, rel: &str, cx: &mut Context<Self>) -> Option<(String, String)> {
        let index = self.tabs.iter().position(|tab| tab.rel_path == rel)?;
        self.close_at(index, cx)
    }

    pub fn clear(&mut self, cx: &mut Context<Self>) -> Vec<(String, String)> {
        let drafts: Vec<_> = self
            .tabs
            .drain(..)
            .map(|tab| {
                let text = tab.editor.read(cx).text(cx);
                (tab.rel_path, text)
            })
            .collect();
        self.active_tab = 0;
        cx.notify();
        drafts
    }

    pub fn set_active(&mut self, index: usize, cx: &mut Context<Self>) {
        if index < self.tabs.len() && index != self.active_tab {
            self.active_tab = index;
            cx.notify();
        }
    }

    pub fn activate_rel(&mut self, rel: &str, cx: &mut Context<Self>) -> bool {
        if let Some(index) = self.tabs.iter().position(|tab| tab.rel_path == rel) {
            self.set_active(index, cx);
            true
        } else {
            false
        }
    }

    /// 把已打开的标签固定（取消预览态）。
    pub fn pin_rel(&mut self, rel: &str, cx: &mut Context<Self>) -> bool {
        if let Some(tab) = self.tabs.iter_mut().find(|tab| tab.rel_path == rel) {
            if tab.preview {
                tab.preview = false;
                cx.notify();
            }
            true
        } else {
            false
        }
    }

    pub fn text(&self, cx: &App) -> String {
        self.tabs
            .get(self.active_tab)
            .map(|tab| tab.editor.read(cx).text(cx))
            .unwrap_or_default()
    }

    pub fn set_text(&mut self, text: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(tab) = self.tabs.get(self.active_tab) else {
            return;
        };
        tab.editor.update(cx, |editor, cx| {
            editor.set_value(text, window, cx);
        });
        if tab.preview {
            // 改属性也算开始编辑：预览标签固定。
            if let Some(tab) = self.tabs.get_mut(self.active_tab) {
                tab.preview = false;
            }
        }
        cx.notify();
    }

    pub fn editor_element_id(&self, cx: &App) -> gpui_kit::ElementId {
        self.tabs
            .get(self.active_tab)
            .map(|tab| tab.editor.read(cx).editor_element_id())
            .unwrap_or_else(|| ("input", 0u64).into())
    }

    pub fn base_mtime_ms(&self) -> Option<u64> {
        self.tabs.get(self.active_tab).map(|tab| tab.base_mtime_ms)
    }

    pub fn set_base_mtime_ms(&mut self, mtime: u64, cx: &mut Context<Self>) {
        if let Some(tab) = self.tabs.get_mut(self.active_tab) {
            tab.base_mtime_ms = mtime;
            cx.notify();
        }
    }

    pub fn rename_active(&mut self, new_rel: String, title: SharedString, mtime: u64, cx: &mut Context<Self>) {
        if let Some(tab) = self.tabs.get_mut(self.active_tab) {
            tab.rel_path = new_rel;
            tab.title = title;
            tab.base_mtime_ms = mtime;
            cx.notify();
        }
    }

    pub fn jump_to_offset(&mut self, offset: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(tab) = self.tabs.get(self.active_tab) else {
            return;
        };
        tab.editor.update(cx, |editor, cx| {
            editor.set_caret(offset, window, cx);
        });
    }

    fn breadcrumb_for(&self, rel: &str) -> impl IntoElement {
        let mut bar = Breadcrumb::new();
        let parts: Vec<&str> = rel.split('/').collect();
        for (ix, part) in parts.iter().enumerate() {
            let label = if ix + 1 == parts.len() {
                crate::session::display_name(part)
            } else {
                (*part).to_string()
            };
            bar = bar.child(BreadcrumbItem::new(label));
        }
        bar
    }

    /// 参考图：中央「笔记属性」块（键值 + 标签），右侧面板保留反链等详情。
    fn note_properties_block(&self, cx: &App) -> impl IntoElement {
        let panel = &self.cached_panel;

        let mut list = DescriptionList::vertical().columns(1);
        if panel.properties.is_empty() {
            list = list.child(DescriptionItem::new("属性").value("这篇笔记没有属性"));
        } else {
            for (key, value) in panel.properties.iter().take(12) {
                list = list.child(DescriptionItem::new(key.clone()).value(value.clone()));
            }
            if panel.properties.len() > 12 {
                list = list.child(
                    DescriptionItem::new("…")
                        .value(format!("另有 {} 项", panel.properties.len() - 12)),
                );
            }
        }

        let mut tags = h_flex().id("note-property-tags").gap_1().flex_wrap();
        if panel.tags.is_empty() {
            tags = tags.child(
                div()
                    .text_sm()
                    .text_color(cx.theme().muted_foreground)
                    .child("没有标签"),
            );
        } else {
            for tag in &panel.tags {
                tags = tags.child(Tag::secondary().small().child(tag.clone()));
            }
        }

        v_flex()
            .id("note-properties")
            .w_full()
            .px_3()
            .py_2()
            .gap_2()
            .border_b_1()
            .border_color(cx.theme().border)
            // 可探测锚点：纯 Div 有时不会进测试 Element 树；Button 会。
            .child(
                h_flex()
                    .w_full()
                    .items_center()
                    .justify_between()
                    .child(
                        Button::new("note-properties-label")
                            .ghost()
                            .xsmall()
                            .label("笔记属性"),
                    )
                    .children(self.workspace.upgrade().map(|view| {
                        Button::new("add-note-property-center")
                            .ghost()
                            .xsmall()
                            .icon(IconName::Plus)
                            .label("添加")
                            .on_click(move |_, window, cx| {
                                view.update(cx, |this, cx| this.prompt_add_property(window, cx));
                            })
                    })),
            )
            .child(GroupBox::new().child(v_flex().gap_2().child(list).child(tags)))
    }
}

impl BasePanel for EditorTabs {
    fn panel_name(&self) -> &'static str {
        "EditorTabs"
    }

    fn closable(&self, _: &App) -> bool {
        false
    }

    // Dock 激活时不要回写 Workspace：打开笔记由文件树 / TabBar 驱动。
    // 在这里再调 on_note_activated 容易与 files.select→open_note 形成重入。
}

impl Panel for EditorTabs {
    fn title(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        "编辑"
    }

    fn title_bar(&self, _: &App) -> bool {
        false
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
    }

    fn zoom_control(&self, _: &App) -> Option<PanelControl> {
        Some(PanelControl::Toolbar)
    }
}

impl EventEmitter<PanelEvent> for EditorTabs {}

impl Focusable for EditorTabs {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for EditorTabs {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.tabs.is_empty() {
            return v_flex()
                .id("editor-tabs-empty")
                .size_full()
                .items_center()
                .justify_center()
                .text_color(cx.theme().muted_foreground)
                .child("打开一篇笔记开始编辑")
                .into_any_element();
        }

        let active = self.active_tab.min(self.tabs.len() - 1);
        let active_rel = self.tabs[active].rel_path.clone();
        let editor = self.tabs[active].editor.clone();

        let tab_bar = TabBar::new("note-tabs")
            .segmented()
            .small()
            .selected_index(active)
            .on_click(cx.listener(|this, index, _, cx| {
                this.set_active(*index, cx);
                let Some(rel) = this.active_rel().map(str::to_string) else {
                    return;
                };
                let text = this.text(cx);
                // 当前仍持有 EditorTabs lease；延后通知 Workspace，避免其回读/observe 重入。
                let workspace = this.workspace.clone();
                cx.defer(move |cx| {
                    let _ = workspace.update(cx, |workspace, cx| {
                        workspace.on_note_activated(&rel, &text, cx);
                    });
                });
            }))
            .children(self.tabs.iter().enumerate().map(|(index, tab)| {
                let title = tab.title.clone();
                let rel = tab.rel_path.clone();
                let preview = tab.preview;
                let muted = cx.theme().muted_foreground;
                Tab::new()
                    .child(
                        div()
                            .when(preview, |el| el.italic().text_color(muted))
                            .child(title),
                    )
                    .suffix(
                        Button::new(("close-note-tab", index as u64))
                            .ghost()
                            .xsmall()
                            .icon(IconName::Close)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                let Some(ix) =
                                    this.tabs.iter().position(|tab| tab.rel_path == rel)
                                else {
                                    return;
                                };
                                let Some((closed_rel, text)) = this.close_at(ix, cx) else {
                                    return;
                                };
                                let next = this.active_rel().map(|next_rel| {
                                    (next_rel.to_string(), this.text(cx))
                                });
                                let workspace = this.workspace.clone();
                                cx.defer(move |cx| {
                                    let _ = workspace.update(cx, |workspace, cx| {
                                        workspace.on_note_closed(&closed_rel, text, next, cx);
                                    });
                                });
                            })),
                    )
            }));

        v_flex()
            .id("editor-tabs")
            .size_full()
            .min_h_0()
            .child(
                h_flex()
                    .w_full()
                    .px_2()
                    .py_1()
                    .gap_2()
                    .border_b_1()
                    .border_color(cx.theme().border)
                    .child(tab_bar.flex_1().min_w_0()),
            )
            .child(
                div()
                    .id("note-breadcrumb")
                    .px_3()
                    .py_1()
                    .border_b_1()
                    .border_color(cx.theme().border)
                    .child(self.breadcrumb_for(&active_rel)),
            )
            .child(self.note_properties_block(cx))
            .child(div().id("editor-body").flex_1().min_h_0().child(editor))
            .into_any_element()
    }
}
