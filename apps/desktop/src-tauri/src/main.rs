// 生产构建下不显示控制台窗口（Windows）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    mimenote_lib::run()
}
