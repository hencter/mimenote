//! # 时间戳（M5 之外的另一块"元数据保真"：frontmatter 时间挂钩）
//!
//! 同步盘/拷贝/压缩包传递文件时，文件系统的 `mtime`/`birthtime` 经常被改写或丢掉
//! （同步客户端重建文件、解压不保留时间、跨文件系统复制只留"复制的那一刻"）。
//! 而 frontmatter 跟着**正文**走 —— 只要内容到了，时间就到了。
//!
//! 本模块只做两件事（都不碰文件，只做纯计算）：
//!
//! * [`unix_secs_to_rfc3339_utc`]：Unix 秒 → `2026-09-27T15:45:20Z`（UTC，`Z` 后缀）。
//!   用 UTC 而不用本地时区：同步的意义就是"与机器位置无关"，`+08:00` 在夏令时/跨时区
//!   机器之间互传时会引入本不存在的歧义；解析侧（`FrontmatterValue::Scalar`）本来就是字符串，
//!   不需要调时区库。日期换算用 Howard Hinnant 的 days-to-civil 算法，零依赖
//!   （workspace 里没有 chrono，加一个只为格式化两个字段不值）；
//! * 字段名常量（[`CREATED_KEY`] / [`UPDATED_KEY`]）：Obsidian 风格的小写名，
//!   与用户已有的 `date`/`datetime` 业务字段不重名、不抢占。
//!
//! 落盘语义（谁在什么时候写，见 `commands::notes` 的 `stamp_times`）：
//!
//! * `created`：新建时写一次，此后**永不覆盖**（文件"出生"那一刻只有一个真相）；
//! * `updated`：每次保存刷新（保存本身就是一次修改，写 `now` 永远是真话 ——
//!   即使用户手改了这一行，本次保存也确实发生过）；
//! * 没有 frontmatter 的旧笔记**不擅自建块**（保存时只改已有的块；新文件才带块）。

use std::time::SystemTime;

/// 创建时间字段名（写一次，永不覆盖）。
pub const CREATED_KEY: &str = "created";
/// 修改时间字段名（每次保存刷新）。
pub const UPDATED_KEY: &str = "updated";

/// Unix 秒 → UTC 的 RFC 3339（`2017-07-16T19:20:30Z` 这种形状）。
///
/// 1970 年之前的输入按 0 处理（`SystemTime` 早于纪元的错误值不该变成一个负日期字符串）。
pub fn unix_secs_to_rfc3339_utc(secs: u64) -> String {
    let (year, month, day) = civil_from_days((secs / 86_400) as i64);
    let of_day = secs % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}Z",
        hour = of_day / 3_600,
        min = (of_day % 3_600) / 60,
        sec = of_day % 60,
    )
}

/// `SystemTime` → UTC 的 RFC 3339（早于纪元按纪元算，见 [`unix_secs_to_rfc3339_utc`]）。
pub fn system_time_to_rfc3339_utc(time: SystemTime) -> String {
    let secs = time
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    unix_secs_to_rfc3339_utc(secs)
}

/// 天数（1970-01-01 起）→ `(年, 月, 日)`（Howard Hinnant 算法， proleptic Gregorian）。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_pair = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_pair + 2) / 5 + 1) as u32;
    let month = if month_pair < 10 {
        (month_pair + 3) as u32
    } else {
        (month_pair - 9) as u32
    };
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_is_all_zeros() {
        assert_eq!(unix_secs_to_rfc3339_utc(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn day_boundaries_roll_over() {
        assert_eq!(unix_secs_to_rfc3339_utc(86_399), "1970-01-01T23:59:59Z");
        assert_eq!(unix_secs_to_rfc3339_utc(86_400), "1970-01-02T00:00:00Z");
    }

    #[test]
    fn leap_day_2024() {
        // 2024-02-29T00:00:00Z（闰日是 days-to-civil 最容易错的地方，单独钉）
        assert_eq!(
            unix_secs_to_rfc3339_utc(1_709_164_800),
            "2024-02-29T00:00:00Z"
        );
    }

    #[test]
    fn user_vault_convention_spot_check() {
        // 用户库里真实出现过的形状：`2026-09-27T23:45:20+08:00` = UTC 15:45:20
        assert_eq!(
            unix_secs_to_rfc3339_utc(1_790_523_920),
            "2026-09-27T15:45:20Z"
        );
    }

    #[test]
    fn system_time_before_epoch_clamps_to_epoch() {
        let before = std::time::UNIX_EPOCH - std::time::Duration::from_secs(1);
        assert_eq!(system_time_to_rfc3339_utc(before), "1970-01-01T00:00:00Z");
    }
}
