//! Dock 面板：文件树 / 搜索、编辑区 Dynamic Tabs、属性 / 大纲。
//!
//! 左右栏由 kit [`DockArea`](gpui_kit::component::dock::DockArea) 托管；
//! 左侧「文件 / 搜索」与右侧「大纲 / 属性」同为 Dock Tab；
//! 中央笔记切换用 [`TabBar::segmented`](gpui_kit::component::tab::TabBar) Dynamic Tabs，
//! 编辑区本身仍是可 Dock 的面板（可缩放 / 拖到侧栏）。

mod editor_tabs;
mod files;
mod inspector;
mod outline;
mod search;

pub use editor_tabs::EditorTabs;
pub use files::FilesPanel;
pub use inspector::InspectorPanel;
pub use outline::OutlinePanel;
pub use search::SearchPanel;
