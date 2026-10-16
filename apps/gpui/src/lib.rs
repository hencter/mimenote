//! Mimenote 的 GPUI Kit 客户端。
//!
//! 笔记的读写和索引在 [`session`]，窗口只负责用 gpui-kit 的组件把会话画出来。

mod outline;
mod panels;
mod session;
mod settings;
mod workspace;
mod wysiwyg;

pub use session::{NoteDocument, VaultSession};
pub use workspace::Workspace;
pub use wysiwyg::{WysiwygEditor, WysiwygMode};

use std::path::PathBuf;

use gpui_kit::component::{Theme, ThemeMode};
use gpui_kit::AppContext as _;

/// 打开原生窗口。`vault` 为空时使用当前工作目录。
pub fn run(vault: Option<PathBuf>) {
    let vault =
        vault.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    gpui_kit::application()
        .with_assets(gpui_kit::assets::Assets)
        .run(move |cx| {
            gpui_kit::init(cx);
            wysiwyg::init(cx);
            // 默认深色：对齐参考图笔记软件观感；可在设置里切回浅色。
            Theme::change(ThemeMode::Dark, None, cx);
            let vault = vault.clone();
            gpui_kit::open_window(gpui_kit::WindowOptions::default(), cx, move |window, cx| {
                cx.new(|cx| Workspace::new(vault.clone(), window, cx))
            })
            .expect("打开窗口失败");
        });
}
