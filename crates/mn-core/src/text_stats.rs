//! 文本统计：字数、行数、阅读时长（**CJK 感知**）。
//!
//! 为什么不用"按空格切分"：中文没有词间空格，按空格算会把整段算成 1 个词。
//! 这里把每个 CJK 字符计为 1 个"词"，连续的非 CJK 字母数字串计为 1 个词。

use serde::Serialize;

/// 统计结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextStats {
    /// 字符总数。
    pub chars: usize,
    /// 去掉空白后的字符数。
    pub chars_no_whitespace: usize,
    /// 词数（CJK 逐字计）。
    pub words: usize,
    /// CJK 字符数。
    pub cjk_chars: usize,
    /// 行数。
    pub lines: usize,
    /// 预计阅读时长（分钟，向上取整，非空文本至少 1）。
    pub reading_minutes: u32,
}

/// 是否 CJK（含汉字、假名、谚文、兼容区）。
pub fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x30FF      // 平假名/片假名
        | 0x3400..=0x4DBF    // 汉字扩展 A
        | 0x4E00..=0x9FFF    // 汉字基本区
        | 0xAC00..=0xD7AF    // 谚文音节
        | 0xF900..=0xFAFF    // 兼容汉字
        | 0x20000..=0x2FA1F  // 扩展 B~F
    )
}

/// 统计文本。
pub fn stats(text: &str) -> TextStats {
    let mut chars = 0usize;
    let mut chars_no_whitespace = 0usize;
    let mut words = 0usize;
    let mut cjk_chars = 0usize;
    let mut in_latin_run = false;

    for c in text.chars() {
        chars += 1;
        if !c.is_whitespace() {
            chars_no_whitespace += 1;
        }
        if is_cjk(c) {
            if in_latin_run {
                in_latin_run = false;
            }
            cjk_chars += 1;
            words += 1;
        } else if c.is_alphanumeric() {
            if !in_latin_run {
                in_latin_run = true;
                words += 1;
            }
        } else {
            in_latin_run = false;
        }
    }

    let lines = if text.is_empty() {
        0
    } else {
        text.lines().count().max(1)
    };

    let reading_minutes = if text.is_empty() {
        0
    } else {
        // 中文约 400 字/分钟，英文约 200 词/分钟。
        let latin_words = words.saturating_sub(cjk_chars);
        let minutes = (latin_words as f64 / 200.0) + (cjk_chars as f64 / 400.0);
        minutes.ceil().max(1.0) as u32
    };

    TextStats {
        chars,
        chars_no_whitespace,
        words,
        cjk_chars,
        lines,
        reading_minutes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_cjk_per_character() {
        let s = stats("中文笔记");
        assert_eq!(s.cjk_chars, 4);
        assert_eq!(s.words, 4);
        assert_eq!(s.chars, 4);
        assert_eq!(s.lines, 1);
    }

    #[test]
    fn counts_latin_runs_as_words() {
        let s = stats("hello world, markdown!");
        assert_eq!(s.words, 3);
        assert_eq!(s.cjk_chars, 0);
        assert_eq!(
            s.chars_no_whitespace,
            "helloworld,markdown!".chars().count()
        );
    }

    #[test]
    fn mixes_cjk_and_latin() {
        let s = stats("使用 Tauri 2 构建桌面应用");
        // 词：使用(2) + Tauri(1) + 2(1) + 构建桌面应用(6)
        assert_eq!(s.words, 10);
        assert_eq!(s.cjk_chars, 8);
    }

    #[test]
    fn handles_empty_and_multiline() {
        let empty = stats("");
        assert_eq!(empty.lines, 0);
        assert_eq!(empty.reading_minutes, 0);

        let multi = stats("a\nb\n");
        assert_eq!(multi.lines, 2);

        let blank = stats("\n\n\n");
        assert_eq!(blank.lines, 3);
        assert_eq!(blank.words, 0);
        assert_eq!(
            blank.reading_minutes, 1,
            "非空白与否：纯空白文本仍算 1 分钟"
        );
    }

    #[test]
    fn reading_time_scales() {
        let short = stats("hello");
        assert_eq!(short.reading_minutes, 1);
        let long_cn = stats(&"字".repeat(4000));
        assert_eq!(long_cn.reading_minutes, 10);
        let long_en = stats(&"word ".repeat(2000));
        assert_eq!(long_en.reading_minutes, 10);
    }

    #[test]
    fn counts_cjk_extensions() {
        assert!(is_cjk('漢'));
        assert!(is_cjk('あ'));
        assert!(is_cjk('한'));
        assert!(!is_cjk('a'));
        assert!(!is_cjk('1'));
        assert!(!is_cjk('，'));
    }
}
