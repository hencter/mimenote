//! 设置 Sheet：主题模式与编辑器缩放。

use gpui_kit::component::label::Label;
use gpui_kit::component::sheet::Sheet;
use gpui_kit::component::slider::{Slider, SliderEvent, SliderState};
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{v_flex, ActiveTheme as _, Theme, ThemeMode, WindowExt as _};
use gpui_kit::prelude::*;
use gpui_kit::{px, App, Entity, Window};

use crate::workspace::Workspace;

const BASE_FONT_PX: f32 = 16.0;

/// 打开设置 Sheet（右侧滑入）。
///
/// `zoom` 必须由调用方传入：若从 `Workspace` 的 `defer_in` / click listener 进入，
/// 此时仍持有 Workspace lease，不能再 `workspace.read`。
pub fn open_settings(
    workspace: Entity<Workspace>,
    zoom: f32,
    window: &mut Window,
    cx: &mut App,
) {
    let dark = cx.theme().mode.is_dark();
    let zoom_state = cx.new(|_| {
        SliderState::new()
            .min(80.)
            .max(150.)
            .step(5.)
            .default_value(zoom)
    });

    let zoom_for_sub = zoom_state.clone();
    let workspace_for_sub = workspace.clone();
    window
        .subscribe(&zoom_for_sub, cx, move |_, event: &SliderEvent, window, cx| {
            let percent = match event {
                SliderEvent::Change(value) | SliderEvent::Release(value) => value.start(),
            };
            let _ = workspace_for_sub.update(cx, |this, cx| {
                this.set_zoom_percent(percent, window, cx);
            });
        })
        .detach();

    let zoom_label = format!("{}%", zoom as i32);
    window.open_sheet(cx, move |sheet, _, _cx| {
        let zoom_state = zoom_state.clone();
        sheet
            .title("设置")
            .size(px(360.))
            .child(
                v_flex()
                    .gap_4()
                    .p_1()
                    .child(
                        v_flex()
                            .gap_2()
                            .child(Label::new("外观"))
                            .child(
                                Switch::new("theme-dark")
                                    .label("深色模式")
                                    .checked(dark)
                                    .on_change(move |checked, _, cx| {
                                        let mode = if *checked {
                                            ThemeMode::Dark
                                        } else {
                                            ThemeMode::Light
                                        };
                                        Theme::change(mode, None, cx);
                                    }),
                            ),
                    )
                    .child(
                        v_flex()
                            .gap_2()
                            .child(Label::new(format!("编辑器缩放（{zoom_label}）")))
                            .child(Slider::new(&zoom_state).w_full()),
                    ),
            )
    });
}

/// 按百分比调整全局字号（Live Preview 装饰随主题字号走）。
pub fn apply_zoom(percent: f32, cx: &mut App) {
    let size = BASE_FONT_PX * (percent / 100.0);
    Theme::update(cx, |theme| {
        theme.font_size = px(size);
    });
}

/// 供类型检查：Sheet 构造签名在 kit 里需要 Window。
#[allow(dead_code)]
fn _sheet_new(window: &mut Window, cx: &mut App) -> Sheet {
    Sheet::new(window, cx)
}
