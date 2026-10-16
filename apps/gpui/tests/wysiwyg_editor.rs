use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{px, size, AppContext as _, Bounds, TestAppContext, WindowBounds, WindowOptions};

use mimenote_gpui::{WysiwygEditor, WysiwygMode};

/// 加粗命令改写 Markdown 源码，文档仍是纯文本。
#[gpui_kit::test]
fn bold_wraps_selection_as_markdown(cx: &mut TestAppContext) {
    cx.update(|cx| {
        gpui_kit::init(cx);
        WysiwygEditor::init(cx);
    });
    let (window, editor) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(720.), px(480.)),
                ))),
                ..Default::default()
            },
            cx,
            |window, cx| cx.new(|cx| WysiwygEditor::new(window, cx)),
        )
        .expect("打开测试窗口")
    });

    cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        editor.update(cx, |this, cx| {
            this.set_value("重点", window, cx);
            this.select_all(cx);
        });
        window.render_frame(cx);
        window.click("fmt-bold", cx);
        window.render_frame(cx);
        assert_eq!(editor.read(cx).text(cx), "**重点**");
        assert_eq!(editor.read(cx).mode(), WysiwygMode::Edit);
    })
    .expect("读取窗口");
}

/// Live Preview 装饰必须真正写入 kit Editor 的 decoration collection。
#[gpui_kit::test]
fn live_preview_writes_decorations_into_editor(cx: &mut TestAppContext) {
    cx.update(|cx| {
        gpui_kit::init(cx);
        WysiwygEditor::init(cx);
    });
    let (window, editor) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(720.), px(480.)),
                ))),
                ..Default::default()
            },
            cx,
            |window, cx| cx.new(|cx| WysiwygEditor::new(window, cx)),
        )
        .expect("打开测试窗口")
    });

    cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        editor.update(cx, |this, cx| {
            this.set_value("# 标题\n**粗体** 与 `代码`\n", window, cx);
        });
        window.render_frame(cx);
        let (text_n, range_n) = editor.read(cx).decoration_counts(cx);
        assert!(
            text_n > 0,
            "标题/粗体/代码应产生 text decorations，实际 text={text_n} range={range_n}"
        );
    })
    .expect("读取窗口");
}

#[gpui_kit::test]
fn read_mode_toggle_switches_surface(cx: &mut TestAppContext) {
    cx.update(|cx| {
        gpui_kit::init(cx);
        WysiwygEditor::init(cx);
    });
    let (window, editor) = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(720.), px(480.)),
                ))),
                ..Default::default()
            },
            cx,
            |window, cx| cx.new(|cx| WysiwygEditor::new(window, cx)),
        )
        .expect("打开测试窗口")
    });

    cx.update_window(window, |_, window, cx| {
        window.render_frame(cx);
        assert_eq!(editor.read(cx).mode(), WysiwygMode::Edit);
        // Segmented Tabs 的项 id 是 Integer(0/1)；TabBar 容器 id 对 find 不是叶子节点。
        window.within("tabs-inner").click(1usize, cx);
        window.render_frame(cx);
        assert_eq!(editor.read(cx).mode(), WysiwygMode::Read);
        window.within("tabs-inner").click(0usize, cx);
        window.render_frame(cx);
        assert_eq!(editor.read(cx).mode(), WysiwygMode::Edit);
        assert!(window.find("fmt-bold").visible());
    })
    .expect("读取窗口");
}
