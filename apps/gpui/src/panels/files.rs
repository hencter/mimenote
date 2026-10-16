//! 左侧文件树面板（Dock 左栏 Tab）。

use gpui_kit::component::dock::{BasePanel, Panel, PanelEvent};
use gpui_kit::component::list::ListItem;
use gpui_kit::component::tree::{tree, TreeItem, TreeState};
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _, IconName};
use gpui_kit::prelude::*;
use gpui_kit::{
    App, Context, Entity, EventEmitter, FocusHandle, Focusable, IntoElement, Render, SharedString,
    Subscription, WeakEntity, Window,
};

use crate::workspace::Workspace;

pub struct FilesPanel {
    tree: Entity<TreeState>,
    focus: FocusHandle,
    /// 程序化选中时跳过 observe→open_note，避免与 Workspace 回环。
    suppress_open: bool,
    _subscriptions: Vec<Subscription>,
}

impl FilesPanel {
    pub fn new(
        items: Vec<TreeItem>,
        workspace: WeakEntity<Workspace>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let tree = cx.new(|cx| TreeState::new(cx).items(items));

        let workspace_for_tree = workspace.clone();
        let tree_sub = cx.observe_in(&tree, window, move |this, tree, window, cx| {
            if this.suppress_open {
                this.suppress_open = false;
                return;
            }
            let selected = tree
                .read(cx)
                .selected_item()
                .map(|item| (item.id.to_string(), item.is_folder()));
            let Some((rel, is_folder)) = selected else {
                return;
            };
            if is_folder {
                return;
            }
            // 不能在 FilesPanel observe（正持有本实体 lease）里同步 open_note→files.select。
            // 把打开延后到 Workspace 自己的 turn。
            let workspace = workspace_for_tree.clone();
            let _ = workspace.update(cx, |workspace, cx| {
                if workspace.is_active_note(&rel) {
                    return;
                }
                let rel = rel.clone();
                cx.defer_in(window, move |workspace, window, cx| {
                    if workspace.is_active_note(&rel) {
                        return;
                    }
                    workspace.open_note(&rel, window, cx);
                });
            });
        });

        Self {
            tree,
            focus: cx.focus_handle(),
            suppress_open: false,
            _subscriptions: vec![tree_sub],
        }
    }

    pub fn set_items(&mut self, items: Vec<TreeItem>, cx: &mut Context<Self>) {
        self.suppress_open = true;
        self.tree.update(cx, |state, cx| {
            state.set_items(items, cx);
        });
    }

    pub fn select(&mut self, rel: &str, cx: &mut Context<Self>) {
        let id = SharedString::from(rel);
        self.suppress_open = true;
        self.tree.update(cx, |state, cx| {
            if let Some(index) = state.index_of(&id) {
                state.set_selected_index(Some(index), cx);
            }
        });
    }
}

impl BasePanel for FilesPanel {
    fn panel_name(&self) -> &'static str {
        "FilesPanel"
    }

    fn closable(&self, _: &App) -> bool {
        false
    }

    fn zoomable(&self, _: &App) -> bool {
        false
    }
}

impl Panel for FilesPanel {
    fn tab_name(&self, _: &App) -> Option<SharedString> {
        Some("文件".into())
    }

    fn title(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        IconName::File
    }

    fn title_bar(&self, _: &App) -> bool {
        false
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
    }
}

impl EventEmitter<PanelEvent> for FilesPanel {}

impl Focusable for FilesPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for FilesPanel {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        v_flex().id("files-panel").size_full().min_h_0().child(
            tree(&self.tree, |_, entry, _, _, cx| {
                let icon = if !entry.is_folder() {
                    IconName::File
                } else if entry.is_expanded() {
                    IconName::FolderOpen
                } else {
                    IconName::Folder
                };
                ListItem::new(entry.item().id.clone())
                    .w_full()
                    .rounded(cx.theme().radius)
                    .px_3()
                    .pl(gpui_kit::rems(0.75 + entry.depth() as f32))
                    .child(
                        h_flex()
                            .gap_2()
                            .child(icon)
                            .child(entry.item().label.clone()),
                    )
            })
            .size_full()
            .flex_1()
            .min_h_0(),
        )
    }
}
