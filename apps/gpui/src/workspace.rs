//! 笔记窗口：Dock 壳 + 中央 Segmented Dynamic Tabs 编辑区。
//!
//! - 左右栏：kit Dock（可折叠 / 拖拽拓展），见 [dock 示例](https://github.com/longbridge/gpui-kit/blob/main/examples/dock/src/main.rs)
//! - 中央：[`EditorTabs`] 用 `TabBar::segmented()` 管理打开的笔记
//! - 图标：[`IconName`](https://gpui-kit.com/zh-CN/component/icon/)

use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;

use gpui_kit::prelude::*;
use gpui_kit::{
    div, App, Context, Entity, IntoElement, Render, SharedString, Subscription, Window,
};

use gpui_kit::component::button::{Button, ButtonVariant, ButtonVariants as _};
use gpui_kit::component::command::{Command, CommandItem, CommandState};
use gpui_kit::component::dialog::{DialogAction, DialogClose, DialogFooter};
use gpui_kit::component::dock::{
    DockArea, DockLayout, DockPlacement, DockSkin, PanelId, PanelStyle, panel_handle,
};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::status_bar::StatusBar;
use gpui_kit::component::tree::TreeItem;
use gpui_kit::component::{
    h_flex, v_flex, ActiveTheme as _, IconName, Sizable as _, WindowExt as _,
};
use gpui_kit::px;
use mn_index::search::SearchHit;

use crate::panels::{EditorTabs, FilesPanel, InspectorPanel, OutlinePanel, SearchPanel};
use crate::session::{display_name, is_markdown, NotePanelData, VaultSession};
use crate::settings;

/// 笔记软件的根视图。
pub struct Workspace {
    session: Option<VaultSession>,
    dock_area: Entity<DockArea>,
    #[allow(dead_code)]
    dock_skin: Rc<DockSkin>,
    files: Entity<FilesPanel>,
    search: Entity<SearchPanel>,
    inspector: Entity<InspectorPanel>,
    outline: Entity<OutlinePanel>,
    editor_tabs: Entity<EditorTabs>,
    active_note: Option<String>,
    command: Entity<CommandState>,
    drafts: HashMap<String, String>,
    status: SharedString,
    vault_label: SharedString,
    panel: NotePanelData,
    zoom_percent: f32,
    _subscriptions: Vec<Subscription>,
}

impl Workspace {
    pub fn new(vault: PathBuf, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let command = cx.new(|cx| CommandState::new(window, cx));
        let (dock_area, dock_skin) = DockSkin::dock_area("main-dock", Some(1), window, cx);
        // Auto：单面板且 title_bar=false 时不画 Dock 标题条（中央留给 EditorTabs 自己的 TabBar）。
        // 切勿用 TabBar 全局强制——否则中央会多出一层「编辑」标签，且与 ensure 重复 add 叠成崩溃。
        dock_skin.set_panel_style(PanelStyle::Auto, cx);
        dock_skin.set_close_button_visible(true, cx);
        dock_skin.set_toggle_button_visible(true, cx);

        let opened = VaultSession::open(&vault);
        let (session, items, first, open_error) = match opened {
            Ok(session) => {
                let items = note_tree(session.entries());
                let first = session.notes().first().map(|entry| entry.rel_path.clone());
                (Some(session), items, first, None)
            }
            Err(error) => (None, Vec::new(), None, Some(error.to_string())),
        };
        let vault_label = session
            .as_ref()
            .map(|session| SharedString::from(session.vault_name()))
            .unwrap_or_else(|| "未打开库".into());
        let status = if let Some(error) = open_error {
            SharedString::from(error)
        } else if first.is_none() {
            "这个库里还没有 Markdown 笔记".into()
        } else {
            "就绪".into()
        };

        let workspace = cx.weak_entity();
        let files = cx.new(|cx| FilesPanel::new(items, workspace.clone(), window, cx));
        let search = cx.new(|cx| SearchPanel::new(workspace.clone(), window, cx));
        let inspector = cx.new(|cx| InspectorPanel::new(workspace.clone(), cx));
        let outline = cx.new(|cx| OutlinePanel::new(workspace.clone(), cx));
        let editor_tabs = cx.new(|cx| EditorTabs::new(workspace, cx));

        dock_area.update(cx, |area, cx| {
            // 左侧对齐右侧：文件优先，搜索其次（Dock 图标标签可切换）。
            area.set_dock(
                DockPlacement::Left,
                DockLayout::tabs()
                    .panel_view(panel_handle(files.clone()), cx)
                    .panel_view(panel_handle(search.clone()), cx),
                window,
                cx,
            );
            area.set_dock_size(DockPlacement::Left, px(240.), window, cx);
            area.set_dock_collapsible(DockPlacement::Left, true, window, cx);

            // 右侧：大纲优先，属性其次（Dock 标签可切换）。
            area.set_dock(
                DockPlacement::Right,
                DockLayout::tabs()
                    .panel_view(panel_handle(outline.clone()), cx)
                    .panel_view(panel_handle(inspector.clone()), cx),
                window,
                cx,
            );
            area.set_dock_size(DockPlacement::Right, px(280.), window, cx);
            area.set_dock_collapsible(DockPlacement::Right, true, window, cx);

            area.set_center(
                DockLayout::tabs().panel_view(panel_handle(editor_tabs.clone()), cx),
                window,
                cx,
            );
        });

        let mut workspace = Self {
            session,
            dock_area,
            dock_skin,
            files,
            search,
            inspector,
            outline,
            editor_tabs,
            active_note: None,
            command,
            drafts: HashMap::new(),
            status,
            vault_label,
            panel: NotePanelData::default(),
            zoom_percent: 100.0,
            _subscriptions: Vec::new(),
        };
        if let Some(rel) = first {
            // 启动首篇固定打开（对齐 Rísta 会话恢复，而非预览标签）。
            workspace.open_note_keep(&rel, window, cx);
        }
        workspace
    }

    pub fn panel_data(&self) -> &NotePanelData {
        &self.panel
    }

    pub fn zoom_percent(&self) -> f32 {
        self.zoom_percent
    }

    pub fn set_zoom_percent(&mut self, percent: f32, _window: &mut Window, cx: &mut Context<Self>) {
        self.zoom_percent = percent.clamp(80.0, 150.0);
        settings::apply_zoom(self.zoom_percent, cx);
        cx.notify();
    }

    pub fn is_active_note(&self, rel: &str) -> bool {
        self.active_note.as_deref() == Some(rel)
    }

    pub fn caret_offset(&self, cx: &App) -> usize {
        self.editor_tabs.read(cx).caret_offset(cx)
    }

    pub fn editor_text(&self, cx: &App) -> String {
        self.editor_tabs.read(cx).text(cx)
    }

    pub fn editor_element_id(&self, cx: &App) -> gpui_kit::ElementId {
        self.editor_tabs.read(cx).editor_element_id(cx)
    }

    pub(crate) fn jump_to_offset(&mut self, offset: usize, window: &mut Window, cx: &mut Context<Self>) {
        self.editor_tabs.update(cx, |tabs, cx| {
            tabs.jump_to_offset(offset, window, cx);
        });
    }

    fn active_rel(&self) -> Option<&str> {
        self.active_note.as_deref()
    }

    /// Tab 切换回调。`text` 必须由调用方传入：点击时 EditorTabs 仍持有自身 lease，
    /// 不能在这里再 `editor_tabs.read`。
    pub(crate) fn on_note_activated(&mut self, rel: &str, text: &str, cx: &mut Context<Self>) {
        if self.active_note.as_deref() == Some(rel) {
            return;
        }
        self.mark_note_active(rel, text, cx);
    }

    /// 关闭标签。`next` 为关闭后应激活的笔记（rel + 正文）；同样禁止回读 EditorTabs。
    pub(crate) fn on_note_closed(
        &mut self,
        rel: &str,
        text: String,
        next: Option<(String, String)>,
        cx: &mut Context<Self>,
    ) {
        self.drafts.insert(rel.to_string(), text);
        if self.active_note.as_deref() == Some(rel) {
            if let Some((next_rel, next_text)) = next {
                self.mark_note_active(&next_rel, &next_text, cx);
                return;
            }
            self.active_note = None;
            self.panel = NotePanelData::default();
            self.status = "就绪".into();
        }
        self.inspector.update(cx, |_, cx| cx.notify());
        self.outline.update(cx, |_, cx| cx.notify());
        cx.notify();
    }

    /// 文件树单击：预览标签（可被下一篇替换）。对齐 Rísta `preview_document`。
    pub fn open_note(&mut self, rel: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.open_note_with(rel, false, window, cx);
    }

    /// 搜索 / 新建 / 反链等：固定标签。对齐 Rísta `open_document`。
    pub fn open_note_keep(&mut self, rel: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.open_note_with(rel, true, window, cx);
    }

    fn open_note_with(
        &mut self,
        rel: &str,
        keep: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.active_rel() == Some(rel) {
            if keep {
                self.editor_tabs
                    .update(cx, |tabs, cx| {
                        let _ = tabs.pin_rel(rel, cx);
                    });
            }
            return;
        }

        // 已打开：只切换 Segmented Tab（keep 时顺带固定）。
        let already_open = {
            let mut activated = false;
            self.editor_tabs.update(cx, |tabs, cx| {
                activated = tabs.activate_rel(rel, cx);
                if activated && keep {
                    let _ = tabs.pin_rel(rel, cx);
                }
            });
            activated
        };
        if already_open {
            let text = self.editor_tabs.read(cx).text(cx);
            self.mark_note_active(rel, &text, cx);
            return;
        }

        let Some(session) = self.session.as_ref() else {
            return;
        };
        let document = match session.read(rel) {
            Ok(document) => document,
            Err(error) => {
                self.status = error.to_string().into();
                cx.notify();
                return;
            }
        };
        let text = self
            .drafts
            .get(rel)
            .cloned()
            .unwrap_or_else(|| document.text.clone());
        let title = SharedString::from(file_title(rel));
        let mtime = document.mtime_ms;
        self.editor_tabs.update(cx, |tabs, cx| {
            tabs.open(rel, title, text.clone(), mtime, keep, window, cx);
        });
        self.mark_note_active(rel, &text, cx);
    }

    fn mark_note_active(&mut self, rel: &str, text: &str, cx: &mut Context<Self>) {
        self.active_note = Some(rel.to_string());
        self.panel = self
            .session
            .as_mut()
            .map(|session| session.panel(rel, text))
            .unwrap_or_default();
        self.status = format!("已打开 {rel}").into();
        // 文件树 observe 可能仍持有 FilesPanel lease；延后选中避免 double-lease。
        let files = self.files.clone();
        let sync_rel = rel.to_string();
        cx.defer(move |cx| {
            files.update(cx, |files, cx| files.select(&sync_rel, cx));
        });
        self.inspector.update(cx, |_, cx| cx.notify());
        self.outline.update(cx, |_, cx| cx.notify());
        cx.notify();
    }

    /// 编辑当前笔记的 frontmatter 标量字段（内存草稿；保存后落盘）。
    pub fn set_active_property(
        &mut self,
        key: &str,
        value: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let key = key.trim();
        if key.is_empty() {
            self.status = "属性名不能为空".into();
            cx.notify();
            return;
        }
        let Some(rel) = self.active_rel().map(str::to_string) else {
            self.status = "没有打开的笔记".into();
            cx.notify();
            return;
        };
        let text = self.editor_tabs.read(cx).text(cx);
        let Some(next) = mn_core::frontmatter::set_scalar_field(&text, key, value) else {
            self.status = format!("无法写入属性 {key}").into();
            cx.notify();
            return;
        };
        self.editor_tabs
            .update(cx, |tabs, cx| tabs.set_text(next.clone(), window, cx));
        self.drafts.insert(rel.clone(), next.clone());
        self.panel = self
            .session
            .as_mut()
            .map(|session| session.panel(&rel, &next))
            .unwrap_or_default();
        self.status = format!("已更新属性 {key}").into();
        self.inspector.update(cx, |_, cx| cx.notify());
        cx.notify();
    }

    pub(crate) fn prompt_edit_property(
        &mut self,
        key: &str,
        current: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let key = key.to_string();
        let value_input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("属性值")
                .default_value(current.to_string())
        });
        let view = cx.entity().clone();
        window.open_dialog(cx, move |dialog, _, _| {
            let value_input = value_input.clone();
            let view = view.clone();
            let key_for_save = key.clone();
            dialog
                .title(format!("编辑属性 · {key}"))
                .child(Input::new(&value_input).id("edit-property-value"))
                .footer(
                    DialogFooter::new()
                        .gap_2()
                        .child(
                            DialogClose::new()
                                .child(Button::new("cancel-edit-prop").label("取消").outline()),
                        )
                        .child(
                            DialogAction::new().child(
                                Button::new("confirm-edit-prop")
                                    .primary()
                                    .label("应用")
                                    .on_click(move |_, window, cx| {
                                        let value = value_input.read(cx).value().to_string();
                                        view.update(cx, |this, cx| {
                                            this.set_active_property(
                                                &key_for_save,
                                                &value,
                                                window,
                                                cx,
                                            );
                                        });
                                        window.close_dialog(cx);
                                    }),
                            ),
                        ),
                )
        });
    }

    pub(crate) fn prompt_add_property(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.active_rel().is_none() {
            self.status = "没有打开的笔记".into();
            cx.notify();
            return;
        }
        let key_input = cx.new(|cx| InputState::new(window, cx).placeholder("属性名，如 title"));
        let value_input = cx.new(|cx| InputState::new(window, cx).placeholder("属性值"));
        let view = cx.entity().clone();
        window.open_dialog(cx, move |dialog, _, _| {
            let key_input = key_input.clone();
            let value_input = value_input.clone();
            let view = view.clone();
            dialog
                .title("添加笔记属性")
                .child(
                    v_flex()
                        .gap_2()
                        .child(Input::new(&key_input).id("add-property-key"))
                        .child(Input::new(&value_input).id("add-property-value")),
                )
                .footer(
                    DialogFooter::new()
                        .gap_2()
                        .child(
                            DialogClose::new()
                                .child(Button::new("cancel-add-prop").label("取消").outline()),
                        )
                        .child(
                            DialogAction::new().child(
                                Button::new("confirm-add-prop")
                                    .primary()
                                    .label("添加")
                                    .on_click(move |_, window, cx| {
                                        let key = key_input.read(cx).value().to_string();
                                        let value = value_input.read(cx).value().to_string();
                                        view.update(cx, |this, cx| {
                                            this.set_active_property(&key, &value, window, cx);
                                        });
                                        window.close_dialog(cx);
                                    }),
                            ),
                        ),
                )
        });
    }

    fn save_active(&mut self, force: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(rel) = self.active_rel().map(str::to_string) else {
            self.status = "没有打开的笔记".into();
            cx.notify();
            return;
        };
        let base = if force {
            None
        } else {
            self.editor_tabs.read(cx).base_mtime_ms()
        };
        let text = self.editor_tabs.read(cx).text(cx);
        let Some(session) = self.session.as_mut() else {
            self.status = "还没有打开库".into();
            cx.notify();
            return;
        };
        match session.save(&rel, &text, base) {
            Ok(saved) => {
                self.editor_tabs.update(cx, |tabs, cx| {
                    tabs.set_base_mtime_ms(saved.mtime_ms, cx);
                });
                self.drafts.insert(rel.clone(), text.clone());
                self.panel = session.panel(&rel, &text);
                self.status = format!("已保存 {rel}").into();
                self.inspector.update(cx, |_, cx| cx.notify());
                self.outline.update(cx, |_, cx| cx.notify());
                cx.notify();
            }
            Err(error) if error.code() == mn_core::ErrorCode::Conflict => {
                self.status = "笔记已在外部被修改".into();
                cx.notify();
                self.confirm_overwrite(window, cx);
            }
            Err(error) => {
                self.status = error.to_string().into();
                cx.notify();
            }
        }
    }

    fn confirm_overwrite(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let view = cx.entity().clone();
        window.open_alert_dialog(cx, move |alert, _, _| {
            let view = view.clone();
            alert
                .title("笔记已被其他程序修改")
                .description("覆盖保存会替换磁盘上的内容。")
                .confirm()
                .ok_text("覆盖保存")
                .ok_variant(ButtonVariant::Danger)
                .on_ok(move |_, window, cx| {
                    view.update(cx, |this, cx| this.save_active(true, window, cx));
                    true
                })
        });
    }

    pub(crate) fn search_notes(&self, query: &str) -> Vec<SearchHit> {
        self.session
            .as_ref()
            .and_then(|session| session.search(query).ok())
            .map(|outcome| outcome.hits)
            .unwrap_or_default()
    }

    pub(crate) fn set_status(&mut self, status: impl Into<SharedString>, cx: &mut Context<Self>) {
        self.status = status.into();
        cx.notify();
    }

    /// 切到左侧「搜索」Dock Tab，并把焦点放进搜索框。
    fn focus_search_panel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let panel = PanelId::from(self.search.entity_id());
        self.dock_area.update(cx, |area, cx| {
            area.select_panel(panel, window, cx);
        });
        if !self.dock_area.read(cx).is_dock_open(DockPlacement::Left) {
            self.dock_area.update(cx, |area, cx| {
                area.toggle_dock(DockPlacement::Left, window, cx);
            });
        }
        self.search.update(cx, |search, cx| {
            search.focus_query(window, cx);
        });
    }

    fn show_commands(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let command = self.command.clone();
        let view = cx.entity().clone();
        window.open_dialog(cx, move |dialog, _, _| {
            let view = view.clone();
            dialog.title("命令").child(
                Command::new(&command)
                    .bordered(false)
                    .placeholder("输入命令")
                    .items([
                        CommandItem::new().label("保存"),
                        CommandItem::new().label("新建笔记…"),
                        CommandItem::new().label("重命名…"),
                        CommandItem::new().label("移到回收站…"),
                        CommandItem::new().label("搜索…"),
                        CommandItem::new().label("打开库…"),
                        CommandItem::new().label("回收站…"),
                        CommandItem::new().label("设置…"),
                    ])
                    .on_confirm(move |path, window, cx| {
                        view.update(cx, |this, cx| match path.row {
                            0 => this.save_active(false, window, cx),
                            1 => this.prompt_create(window, cx),
                            2 => this.prompt_rename(window, cx),
                            3 => this.confirm_trash(window, cx),
                            4 => this.focus_search_panel(window, cx),
                            5 => this.prompt_open_vault(window, cx),
                            6 => this.show_trash(window, cx),
                            7 => this.open_settings(window, cx),
                            _ => {}
                        });
                    }),
            )
        });
    }

    fn open_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // 点击 / defer_in 仍可能持有 Workspace lease，故把 zoom 传进去，禁止内部再 read。
        let workspace = cx.entity().clone();
        let zoom = self.zoom_percent;
        settings::open_settings(workspace, zoom, window, cx);
    }

    fn prompt_open_vault(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let path_input = cx.new(|cx| InputState::new(window, cx).placeholder("库文件夹的路径"));
        let view = cx.entity().clone();
        window.open_dialog(cx, move |dialog, _, _| {
            let path_input = path_input.clone();
            let view = view.clone();
            dialog.title("打开库").child(Input::new(&path_input)).footer(
                DialogFooter::new()
                    .gap_2()
                    .child(
                        DialogClose::new()
                            .child(Button::new("cancel-open").label("取消").outline()),
                    )
                    .child(
                        DialogAction::new().child(
                            Button::new("confirm-open")
                                .primary()
                                .label("打开")
                                .on_click(move |_, window, cx| {
                                    let path = path_input.read(cx).value().to_string();
                                    view.update(cx, |this, cx| {
                                        this.reopen(PathBuf::from(path), window, cx);
                                    });
                                    window.close_dialog(cx);
                                }),
                        ),
                    ),
            )
        });
    }

    fn clear_editor_tabs(&mut self, cx: &mut Context<Self>) {
        let drafts = self.editor_tabs.update(cx, |tabs, cx| tabs.clear(cx));
        for (rel, text) in drafts {
            self.drafts.insert(rel, text);
        }
        self.active_note = None;
    }

    fn reopen(&mut self, path: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        match VaultSession::open(&path) {
            Ok(session) => {
                let items = note_tree(session.entries());
                let first = session.notes().first().map(|entry| entry.rel_path.clone());
                self.vault_label = session.vault_name().into();
                self.session = Some(session);
                self.drafts.clear();
                self.clear_editor_tabs(cx);
                self.files.update(cx, |files, cx| files.set_items(items, cx));
                if let Some(rel) = first {
                    self.open_note_keep(&rel, window, cx);
                } else {
                    self.panel = NotePanelData::default();
                    self.status = "这个库里还没有 Markdown 笔记".into();
                    cx.notify();
                }
            }
            Err(error) => {
                self.status = error.to_string().into();
                cx.notify();
            }
        }
    }

    fn prompt_create(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let name_input = cx.new(|cx| InputState::new(window, cx).placeholder("笔记名"));
        let view = cx.entity().clone();
        window.open_dialog(cx, move |dialog, _, _| {
            let name_input = name_input.clone();
            let view = view.clone();
            dialog
                .title("新建笔记")
                .child(Input::new(&name_input))
                .footer(
                    DialogFooter::new()
                        .gap_2()
                        .child(
                            DialogClose::new()
                                .child(Button::new("cancel-create").label("取消").outline()),
                        )
                        .child(
                            DialogAction::new().child(
                                Button::new("confirm-create")
                                    .primary()
                                    .label("创建")
                                    .on_click(move |_, window, cx| {
                                        let title = name_input.read(cx).value().to_string();
                                        view.update(cx, |this, cx| {
                                            this.create_note(&title, window, cx)
                                        });
                                        window.close_dialog(cx);
                                    }),
                            ),
                        ),
                )
        });
    }

    fn create_note(&mut self, title: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(session) = self.session.as_mut() else {
            self.status = "还没有打开库".into();
            cx.notify();
            return;
        };
        match session.create_note(title) {
            Ok(document) => {
                let rel = document.rel_path.clone();
                self.reload_tree(cx);
                self.open_note_keep(&rel, window, cx);
                self.status = format!("已创建 {rel}").into();
                cx.notify();
            }
            Err(error) => {
                self.status = error.to_string().into();
                cx.notify();
            }
        }
    }

    fn prompt_rename(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(current) = self.active_rel().map(str::to_string) else {
            self.status = "没有打开的笔记".into();
            cx.notify();
            return;
        };
        let current_name = file_title(&current);
        let name_input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("新名字")
                .default_value(current_name)
        });
        let view = cx.entity().clone();
        window.open_dialog(cx, move |dialog, _, _| {
            let name_input = name_input.clone();
            let view = view.clone();
            dialog.title("重命名").child(Input::new(&name_input)).footer(
                DialogFooter::new()
                    .gap_2()
                    .child(
                        DialogClose::new()
                            .child(Button::new("cancel-rename").label("取消").outline()),
                    )
                    .child(
                        DialogAction::new().child(
                            Button::new("confirm-rename")
                                .primary()
                                .label("重命名")
                                .on_click(move |_, window, cx| {
                                    let title = name_input.read(cx).value().to_string();
                                    view.update(cx, |this, cx| {
                                        this.rename_active(&title, window, cx)
                                    });
                                    window.close_dialog(cx);
                                }),
                        ),
                    ),
            )
        });
    }

    fn rename_active(&mut self, title: &str, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(old) = self.active_rel().map(str::to_string) else {
            return;
        };
        let Some(session) = self.session.as_mut() else {
            return;
        };
        match session.rename_note(&old, title) {
            Ok(report) => {
                let new_rel = report.new_rel_path.clone();
                if let Some(text) = self.drafts.remove(&old) {
                    self.drafts.insert(new_rel.clone(), text);
                }
                let title = SharedString::from(file_title(&new_rel));
                let mtime = report.mtime_ms;
                self.editor_tabs.update(cx, |tabs, cx| {
                    tabs.rename_active(new_rel.clone(), title, mtime, cx);
                });
                self.active_note = Some(new_rel.clone());
                self.reload_tree(cx);
                self.files
                    .update(cx, |files, cx| files.select(&new_rel, cx));
                self.status = format!("已重命名为 {new_rel}").into();
                cx.notify();
            }
            Err(error) => {
                self.status = error.to_string().into();
                cx.notify();
            }
        }
    }

    fn confirm_trash(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(rel) = self.active_rel().map(str::to_string) else {
            self.status = "没有打开的笔记".into();
            cx.notify();
            return;
        };
        let name = file_title(&rel);
        let view = cx.entity().clone();
        window.open_alert_dialog(cx, move |alert, _, _| {
            let view = view.clone();
            let rel = rel.clone();
            alert
                .title(format!("把「{name}」移到回收站？"))
                .description("笔记会留在回收站，可以恢复。")
                .confirm()
                .ok_text("移到回收站")
                .ok_variant(ButtonVariant::Danger)
                .on_ok(move |_, window, cx| {
                    let rel = rel.clone();
                    view.update(cx, |this, cx| this.trash_active(&rel, window, cx));
                    true
                })
        });
    }

    fn trash_active(&mut self, rel: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(session) = self.session.as_mut() else {
            return;
        };
        match session.trash_note(rel) {
            Ok(_) => {
                let rel = rel.to_string();
                self.drafts.remove(&rel);
                let closed = self
                    .editor_tabs
                    .update(cx, |tabs, cx| tabs.close_rel(&rel, cx));
                if let Some((_, text)) = closed {
                    self.drafts.insert(rel.clone(), text);
                }
                self.active_note = self.editor_tabs.read(cx).active_rel().map(str::to_string);
                self.reload_tree(cx);
                if let Some(next) = self.active_note.clone() {
                    let text = self.editor_tabs.read(cx).text(cx);
                    self.mark_note_active(&next, &text, cx);
                } else {
                    self.panel = NotePanelData::default();
                    self.status = "已移到回收站".into();
                    self.inspector.update(cx, |_, cx| cx.notify());
                    self.outline.update(cx, |_, cx| cx.notify());
                    cx.notify();
                }
                let _ = window;
            }
            Err(error) => {
                self.status = error.to_string().into();
                cx.notify();
            }
        }
    }

    fn show_trash(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let records = self
            .session
            .as_ref()
            .and_then(|session| session.trash().ok())
            .unwrap_or_default();
        let view = cx.entity().clone();
        window.open_dialog(cx, move |dialog, _, _| {
            let mut body = v_flex().gap_2().p_2();
            if records.is_empty() {
                body = body.child("回收站是空的");
            }
            for record in &records {
                let id = record.id.clone();
                let label = format!("恢复 {}", file_title(&record.original_rel_path));
                let view = view.clone();
                body = body.child(
                    Button::new(format!("restore-{id}"))
                        .outline()
                        .icon(IconName::Inbox)
                        .label(label)
                        .on_click(move |_, window, cx| {
                            let id = id.clone();
                            view.update(cx, |this, cx| this.restore_record(&id, window, cx));
                            window.close_dialog(cx);
                        }),
                );
            }
            dialog.title("回收站").child(body).footer(
                DialogFooter::new().child(
                    DialogClose::new().child(Button::new("close-trash").label("关闭").outline()),
                ),
            )
        });
    }

    fn restore_record(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(session) = self.session.as_mut() else {
            return;
        };
        match session.restore_note(id) {
            Ok(rel) => {
                self.reload_tree(cx);
                self.open_note_keep(&rel, window, cx);
                self.status = format!("已恢复 {rel}").into();
                cx.notify();
            }
            Err(error) => {
                self.status = error.to_string().into();
                cx.notify();
            }
        }
    }

    fn reload_tree(&mut self, cx: &mut Context<Self>) {
        let items = self
            .session
            .as_ref()
            .map(|session| note_tree(session.entries()))
            .unwrap_or_default();
        self.files.update(cx, |files, cx| files.set_items(items, cx));
    }
}

impl Render for Workspace {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .id("workspace")
            .size_full()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .child(self.render_toolbar(cx))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .child(self.dock_area.clone()),
            )
            .child(self.render_status_bar(cx))
    }
}

impl Workspace {
    fn render_toolbar(&self, cx: &mut Context<Self>) -> gpui_kit::Div {
        let view = cx.entity().clone();
        h_flex()
            .gap_2()
            .px_3()
            .py_2()
            .border_b_1()
            .border_color(cx.theme().border)
            .child(
                Button::new("open-vault")
                    .ghost()
                    .icon(IconName::FolderOpen)
                    .label("打开库…")
                    .on_click(cx.listener(|this, _, window, cx| this.prompt_open_vault(window, cx))),
            )
            .child(
                Button::new("save-note")
                    .primary()
                    .icon(IconName::Check)
                    .label("保存")
                    .on_click(cx.listener(|this, _, window, cx| this.save_active(false, window, cx))),
            )
            .child(
                Button::new("note-actions")
                    .ghost()
                    .icon(IconName::File)
                    .label("笔记")
                    .dropdown_menu(move |menu, _, _| {
                        let view = view.clone();
                        menu.item(PopupMenuItem::new("新建笔记…").icon(IconName::Plus).on_click({
                            let view = view.clone();
                            move |_, window, cx| {
                                view.update(cx, |this, cx| this.prompt_create(window, cx));
                            }
                        }))
                        .item(PopupMenuItem::new("重命名…").on_click({
                            let view = view.clone();
                            move |_, window, cx| {
                                view.update(cx, |this, cx| this.prompt_rename(window, cx));
                            }
                        }))
                        .separator()
                        .item(
                            PopupMenuItem::new("移到回收站…")
                                .icon(IconName::Delete)
                                .on_click({
                                    let view = view.clone();
                                    move |_, window, cx| {
                                        view.update(cx, |this, cx| this.confirm_trash(window, cx));
                                    }
                                }),
                        )
                        .item(
                            PopupMenuItem::new("回收站…")
                                .icon(IconName::Inbox)
                                .on_click({
                                    let view = view.clone();
                                    move |_, window, cx| {
                                        view.update(cx, |this, cx| this.show_trash(window, cx));
                                    }
                                }),
                        )
                    }),
            )
            .child(
                Button::new("search-notes")
                    .ghost()
                    .icon(IconName::Search)
                    .label("搜索…")
                    .on_click(
                        cx.listener(|this, _, window, cx| this.focus_search_panel(window, cx)),
                    ),
            )
            .child(
                Button::new("commands")
                    .ghost()
                    .icon(IconName::Menu)
                    .label("命令…")
                    .on_click(cx.listener(|this, _, window, cx| this.show_commands(window, cx))),
            )
            .child(
                Button::new("settings")
                    .ghost()
                    .icon(IconName::Settings)
                    .tooltip("设置")
                    .on_click(cx.listener(|this, _, window, cx| this.open_settings(window, cx))),
            )
    }

    fn render_status_bar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        // 对齐参考图：反链 / 属性条数 / 词与字符。
        let meta = format!(
            "{} 条反向链接 · {} 个笔记属性 · {} 个词 · {} 个字符",
            self.panel.backlinks.len(),
            self.panel.properties.len(),
            self.panel.words,
            self.panel.chars,
        );
        StatusBar::new()
            .left(
                Button::new("toggle-left-dock")
                    .ghost()
                    .xsmall()
                    .icon(IconName::PanelLeft)
                    .tooltip("切换左侧栏")
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.dock_area.update(cx, |area, cx| {
                            area.toggle_dock(DockPlacement::Left, window, cx);
                        });
                    })),
            )
            .left(self.vault_label.clone())
            .left(meta)
            .child(self.status.clone())
            .child(
                Button::new("toggle-right-dock")
                    .ghost()
                    .xsmall()
                    .icon(IconName::PanelRight)
                    .tooltip("切换右侧栏")
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.dock_area.update(cx, |area, cx| {
                            area.toggle_dock(DockPlacement::Right, window, cx);
                        });
                    })),
            )
    }
}

fn note_tree(entries: &[mn_core::scanner::EntryMeta]) -> Vec<TreeItem> {
    fn build(entries: &[mn_core::scanner::EntryMeta], parent: &str) -> Vec<TreeItem> {
        let mut folders = Vec::new();
        let mut notes = Vec::new();
        for entry in entries {
            if parent_of(&entry.rel_path) != parent {
                continue;
            }
            if entry.is_dir {
                let children = build(entries, &entry.rel_path);
                if !children.is_empty() {
                    folders.push(
                        TreeItem::new(entry.rel_path.clone(), entry.name.clone())
                            .expanded(true)
                            .children(children),
                    );
                }
            } else if is_markdown(entry) {
                notes.push(TreeItem::new(
                    entry.rel_path.clone(),
                    display_name(&entry.name),
                ));
            }
        }
        folders.sort_by(|left, right| left.label.cmp(&right.label));
        notes.sort_by(|left, right| left.label.cmp(&right.label));
        folders.extend(notes);
        folders
    }
    build(entries, "")
}

fn parent_of(rel: &str) -> String {
    match rel.rfind('/') {
        Some(index) => rel[..index].to_string(),
        None => String::new(),
    }
}

fn file_title(rel: &str) -> String {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    display_name(name)
}
