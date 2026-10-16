//! 所见即所得（Live Preview）。
//!
//! 写作面是 kit 的 [`Editor`](gpui_kit::component::input::Editor)，文档始终是
//! Markdown 源码；本模块只扫描区间并挂装饰（见 ADR-0009）。不自造 Editor。

mod decorations;
mod editor;
mod format;
mod spans;
mod theme;

pub use editor::{WysiwygEditor, WysiwygEvent, WysiwygMode};

pub(crate) fn init(cx: &mut gpui_kit::App) {
    WysiwygEditor::init(cx);
}
