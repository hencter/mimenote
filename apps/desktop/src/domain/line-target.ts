/**
 * "跳到第 N 行"的纯计算：行号夹取 + 行首偏移解析。
 *
 * 为什么单独一个模块：这段逻辑的失败模式全是**退化**（行号 0 / 负数 / 超出末行 / 空文档 /
 * 宿主给了脏值），而它们与 CodeMirror 完全无关 —— 抽成"行数 + 行首偏移查询函数"这样的
 * 纯函数之后，这些边界可以用表驱动逐条钉死（见 `tests/line-jump.test.tsx`），
 * 不必为了测一次夹取去挂一个编辑器实例。
 */

/** 定位目标：夹取后的行号 + 该行行首偏移。 */
export interface LineTarget {
  /** 夹取后的 1 起行号（一定落在 `[1, lineCount]`）。 */
  line: number
  /** 该行行首在文档里的字符偏移（空文档 = 0）。 */
  from: number
  /** 是否发生过夹取（请求的行号非法或越界）。 */
  clamped: boolean
}

/**
 * 行数下限。
 *
 * CodeMirror 的 `Text` **永远**至少有一行（空文档 = 一个空行），所以"行数 0"只可能来自
 * 调用方算错或脏数据 —— 统一按 1 行处理，退化路径就只剩一条（而不是"0 行"和"1 行"两条）。
 */
export function normalizeLineCount(lineCount: number): number {
  if (!Number.isFinite(lineCount)) return 1
  return Math.max(1, Math.trunc(lineCount))
}

/**
 * 把请求行号夹到 `[1, lineCount]`。
 *
 * 非有限值（`NaN` / `±Infinity`）与负数、0 一律退化为 1：跳转是"尽力而为"的体验，
 * 宁可停在文档开头，也不能抛错或算出负偏移（后者会让 `dispatch` 直接炸）。
 */
export function clampLineNumber(line: number, lineCount: number): number {
  const count = normalizeLineCount(lineCount)
  if (!Number.isFinite(line)) return 1
  return Math.min(count, Math.max(1, Math.trunc(line)))
}

/**
 * 解析定位目标。
 *
 * @param line 请求行号（1 起；来源是宿主返回的命中行号、反向链接的来源行号）
 * @param lineCount 文档行数（`EditorState.doc.lines`）
 * @param offsetOfLine 行号 → 行首偏移。真实调用方传 `(n) => doc.line(n).from`，
 *   测试可以直接传一张数组表 —— 这个参数就是"与编辑器解耦"的那条缝。
 */
export function resolveLineTarget(
  line: number,
  lineCount: number,
  offsetOfLine: (line: number) => number,
): LineTarget {
  const clamped = clampLineNumber(line, lineCount)
  return {
    line: clamped,
    from: offsetOfLine(clamped),
    // 与请求值逐字比较而不是看"夹取后的值有没有变"：小数会被 `trunc` 掉，
    // 那是"取整"不是"越界"，不该被当成退化报给调用方
    clamped: clamped !== Math.trunc(line),
  }
}
