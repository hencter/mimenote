use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{px, size, AppContext as _, Bounds, TestAppContext, WindowBounds, WindowOptions};

/// 真实根视图加载夹具库：树里有笔记名，编辑器正文等于文件内容。
#[gpui_kit::test]
fn root_view_shows_fixture_note(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().expect("临时库");
    let body = "正文标记-gpui-kit\n";
    std::fs::write(dir.path().join("笔记.md"), body).expect("写入笔记");
    let vault = dir.path().to_path_buf();

    cx.update(|cx| {
        gpui_kit::init(cx);
        mimenote_gpui::WysiwygEditor::init(cx);
    });
    let (window, workspace) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(960.), px(640.)),
                ))),
                ..Default::default()
            },
            cx,
            |window, cx| cx.new(|cx| mimenote_gpui::Workspace::new(vault, window, cx)),
        )
        .expect("打开测试窗口")
    });

    cx.update_window(window.into(), |_, window, cx| {
        window.render_frame(cx);
        let row = window.within("entries").find(0usize);
        let note = window.find("笔记.md");
        let editor = window.find(workspace.read(cx).editor_element_id(cx));
        println!(
            "tree-label={:?} editor-label={:?} editor-body={:?}",
            row.label(),
            editor.label(),
            editor.value()
        );
        assert_eq!(row.label(), Some("笔记"), "文件树里应该显示不带扩展名的笔记名");
        assert!(note.visible(), "笔记.md 应该出现在文件树里");
        assert_eq!(editor.label(), Some("笔记正文"));
        assert_eq!(editor.value(), Some(body));
        assert!(window.find("fmt-bold").visible(), "应有加粗工具");
        assert!(window.find("fmt-link").visible(), "链接按钮应带 kit Icon");
        assert!(window.find("toggle-left-dock").visible(), "状态栏应有 PanelLeft 切换");
        assert!(window.find("settings").visible(), "工具栏应有 Settings 图标入口");
        assert!(
            window.find(("close-note-tab", 0u64)).visible(),
            "笔记 Dynamic Tab 应有关闭按钮",
        );
    })
    .expect("读取窗口");

    cx.update(|cx| {
        assert_eq!(workspace.read(cx).editor_text(cx), body);
    });
}

/// 带 frontmatter 的笔记：中央应出现「笔记属性」块（对齐参考图）。
#[gpui_kit::test]
fn center_shows_note_properties_block(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().expect("临时库");
    let body = "---\ntitle: 示例\ntags: [工作]\n---\n\n# 标题\n正文\n";
    std::fs::write(dir.path().join("属性.md"), body).expect("写入");
    let vault = dir.path().to_path_buf();

    cx.update(|cx| {
        gpui_kit::init(cx);
        mimenote_gpui::WysiwygEditor::init(cx);
    });
    let (window, workspace) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(960.), px(640.)),
                ))),
                ..Default::default()
            },
            cx,
            |window, cx| cx.new(|cx| mimenote_gpui::Workspace::new(vault, window, cx)),
        )
        .expect("打开测试窗口")
    });

    cx.update_window(window.into(), |_, window, cx| {
        window.render_frame(cx);
        let panel = workspace.read(cx).panel_data().clone();
        assert!(
            !panel.properties.is_empty() || !panel.tags.is_empty(),
            "应解析出 frontmatter：props={:?} tags={:?}",
            panel.properties,
            panel.tags
        );
        assert!(panel.chars > 0, "状态栏字符数应有值");
        assert!(
            window.find("note-properties-label").visible(),
            "中央应渲染笔记属性块 props={:?} tags={:?}",
            panel.properties,
            panel.tags
        );
    })
    .expect("读取窗口");
}

/// 属性可写：改写 frontmatter 后正文与 panel 同步。
#[gpui_kit::test]
fn edit_property_updates_frontmatter(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().expect("临时库");
    let body = "---\ntitle: 旧标题\n---\n\n正文\n";
    std::fs::write(dir.path().join("笔记.md"), body).expect("写入");
    let vault = dir.path().to_path_buf();

    cx.update(|cx| {
        gpui_kit::init(cx);
        mimenote_gpui::WysiwygEditor::init(cx);
    });
    let (window, workspace) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(960.), px(640.)),
                ))),
                ..Default::default()
            },
            cx,
            |window, cx| cx.new(|cx| mimenote_gpui::Workspace::new(vault, window, cx)),
        )
        .expect("打开测试窗口")
    });

    cx.update_window(window.into(), |_, window, cx| {
        window.render_frame(cx);
        workspace.update(cx, |this, cx| {
            this.set_active_property("title", "新标题", window, cx);
        });
        window.render_frame(cx);
        let text = workspace.read(cx).editor_text(cx);
        assert!(text.contains("title: 新标题"), "正文应含新属性：{text}");
        let panel = workspace.read(cx).panel_data();
        assert!(
            panel
                .properties
                .iter()
                .any(|(k, v)| k == "title" && v.contains("新标题")),
            "panel 应反映新属性：{:?}",
            panel.properties
        );
    })
    .expect("读取窗口");
}

/// 切换打开第二篇笔记：不应 panic，正文与活动路径同步。
#[gpui_kit::test]
fn open_second_note_switches_editor(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().expect("临时库");
    std::fs::write(dir.path().join("甲.md"), "甲正文\n").expect("写甲");
    std::fs::write(dir.path().join("乙.md"), "乙正文\n").expect("写乙");
    let vault = dir.path().to_path_buf();

    cx.update(|cx| {
        gpui_kit::init(cx);
        mimenote_gpui::WysiwygEditor::init(cx);
    });
    let (window, workspace) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(960.), px(640.)),
                ))),
                ..Default::default()
            },
            cx,
            |window, cx| cx.new(|cx| mimenote_gpui::Workspace::new(vault, window, cx)),
        )
        .expect("打开测试窗口")
    });

    cx.update_window(window.into(), |_, window, cx| {
        window.render_frame(cx);
        workspace.update(cx, |this, cx| {
            this.open_note("乙.md", window, cx);
        });
    })
    .expect("打开乙");
    cx.run_until_parked();

    cx.update_window(window.into(), |_, window, cx| {
        window.render_frame(cx);
        assert_eq!(workspace.read(cx).editor_text(cx), "乙正文\n");
        assert!(workspace.read(cx).is_active_note("乙.md"));
        workspace.update(cx, |this, cx| {
            this.open_note("甲.md", window, cx);
        });
    })
    .expect("打开甲");
    cx.run_until_parked();

    cx.update_window(window.into(), |_, window, cx| {
        window.render_frame(cx);
        assert_eq!(workspace.read(cx).editor_text(cx), "甲正文\n");
        assert!(workspace.read(cx).is_active_note("甲.md"));
    })
    .expect("校验甲");
}
