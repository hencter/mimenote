/**
 * 文本统计（CJK 感知）—— 前端即时版本。
 *
 * 为什么前端也要有一份：状态栏的字数**每次按键都要刷新**，
 * 走 IPC 往返（哪怕 1ms）也会把输入路径变成异步依赖。
 * 磁盘真实值由宿主 `note_stats` 提供（`mn_core::text_stats`），两者互为校验。
 * 规则必须与 Rust 实现保持一致，`tests/stats.test.ts` 锁定行为。
 */

export interface TextStats {
  chars: number
  charsNoWhitespace: number
  words: number
  cjkChars: number
  lines: number
  readingMinutes: number
}

/** 是否 CJK（含汉字、假名、谚文、兼容区）。 */
export function isCjk(char: string): boolean {
  const code = char.codePointAt(0)
  if (code === undefined) return false
  return (
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x20000 && code <= 0x2fa1f)
  )
}

const ALNUM = /[\p{L}\p{N}]/u

export function computeStats(text: string): TextStats {
  let chars = 0
  let charsNoWhitespace = 0
  let words = 0
  let cjkChars = 0
  let inLatinRun = false

  for (const char of text) {
    chars += 1
    if (!/\s/.test(char)) charsNoWhitespace += 1

    if (isCjk(char)) {
      inLatinRun = false
      cjkChars += 1
      words += 1
    } else if (ALNUM.test(char)) {
      if (!inLatinRun) {
        inLatinRun = true
        words += 1
      }
    } else {
      inLatinRun = false
    }
  }

  // 与 Rust 侧 `str::lines().count()` 对齐：末尾换行不额外产生一行
  let newlines = 0
  for (const char of text) {
    if (char === '\n') newlines += 1
  }
  const lines = text === '' ? 0 : text.endsWith('\n') ? newlines : newlines + 1

  const readingMinutes =
    text === ''
      ? 0
      : Math.max(
          1,
          Math.ceil((words - cjkChars) / 200 + cjkChars / 400),
        )

  return { chars, charsNoWhitespace, words, cjkChars, lines, readingMinutes }
}

/** 从原始 Markdown 文本生成统计（不剥离语法，保持与磁盘一致的口径）。 */
export function statsOf(text: string): TextStats {
  return computeStats(text)
}
