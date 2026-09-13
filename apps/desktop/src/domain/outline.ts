/**
 * 大纲（标题树）的解析：从 Markdown 原文里抽出可跳转的标题列表。
 *
 * 为什么只认 **ATX 标题**（`# 标题`）而不认 Setext（下划线式）：
 * 后者要把"下一行的 `===`/`---`"算进来，而 `---` 同时还是 frontmatter 与分隔线 ——
 * 一旦判错，大纲里就会冒出几个不存在的条目，还会把行号带偏（跳转到错误的位置比没有条目更糟）。
 * Obsidian 的默认大纲同样只认 ATX。
 *
 * 为什么这里**不**复用 `mn-core` 的解析：宿主侧没有"大纲"这项能力，而大纲要跟着
 * 编辑器的每次输入实时更新（每个按键一次），走 IPC 是荒唐的。Markdown 是纯文本，
 * 前端的纯函数解析放在 `domain/` 正是这个仓库既有的分层方式（见 architecture §2）。
 */

/** 大纲里的一个标题。 */
export interface OutlineHeading {
  /** 级别：1–6（`#` 的数量）。 */
  level: number
  /** 显示文本（已剥掉行内标记，可直接渲染）。 */
  text: string
  /** **1 起算**的行号（与编辑器/搜索命中一致的口径）。 */
  line: number
}

/** ATX 标题：最多三个前导空格 + 1–6 个 `#`，`#` 与文本之间要有空白（纯 `#` 也可以）。 */
const ATX_PATTERN = /^[ \t]{0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/u

/** 围栏代码块的开头/结尾（` ``` ` / `~~~`，可带语言）。 */
const FENCE_PATTERN = /^[ \t]{0,3}(`{3,}|~{3,})/u

/** 行内标记 → 纯文本（用于大纲显示，不改动原文）。 */
function displayText(raw: string): string {
  return (
    raw
      // 闭尾的 `###`（`# 标题 ###`）
      .replace(/[ \t]+#+[ \t]*$/u, '')
      // 图片与链接：留 alt / 文字
      .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
      // wikilink：`[[目标|别名]]` 取别名，`[[目标]]` 取目标
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/gu, '$2')
      .replace(/\[\[([^\]]+)\]\]/gu, '$1')
      // 强调与行内代码
      .replace(/(\*\*|__)(.*?)\1/gu, '$2')
      .replace(/(\*|_)(.*?)\1/gu, '$2')
      .replace(/~~(.*?)~~/gu, '$1')
      .replace(/`([^`]*)`/gu, '$1')
      .trim()
  )
}

/**
 * 解析大纲。空文档返回空数组。
 *
 * 跳过的内容（这些地方出现 `#` 都不是标题）：
 * - 文首的 frontmatter（`---` 到下一个 `---`）；
 * - 围栏代码块内部（含嵌套的 ``` 与 ~~~ 两种围栏，且"同种字符、长度不短于开始"才算结束）。
 */
export function parseOutline(text: string): OutlineHeading[] {
  if (text === '') return []

  const lines = text.split('\n')
  const headings: OutlineHeading[] = []
  let fence: string | null = null
  let inFrontmatter = false

  for (let index = 0; index < lines.length; index += 1) {
    // 每行末尾可能有 `\r`（CRLF 原文）：先剥掉，否则标题的正则会把它当成文本的一部分
    const line = (lines[index] ?? '').replace(/\r$/u, '')
    const lineNumber = index + 1

    // frontmatter：只在**第一行**才可能开始（文档中部的 `---` 是分隔线，不是元数据）
    if (lineNumber === 1 && line.trim() === '---') {
      inFrontmatter = true
      continue
    }
    if (inFrontmatter) {
      if (line.trim() === '---') inFrontmatter = false
      continue
    }

    const fenceMatch = FENCE_PATTERN.exec(line)
    if (fence !== null) {
      // 结束围栏：同种字符、长度不短于开始的那一串
      if (
        fenceMatch !== null &&
        fenceMatch[1] !== undefined &&
        fenceMatch[1][0] === fence[0] &&
        fenceMatch[1].length >= fence.length
      ) {
        fence = null
      }
      continue
    }
    if (fenceMatch !== null && fenceMatch[1] !== undefined) {
      fence = fenceMatch[1]
      continue
    }

    const match = ATX_PATTERN.exec(line)
    if (match === null) continue
    const level = match[1]?.length ?? 0
    if (level === 0) continue
    headings.push({ level, text: displayText(match[2] ?? ''), line: lineNumber })
  }

  return headings
}

/**
 * 把标题列表压成"缩进用"的层级序列。
 *
 * 为什么不直接在渲染时按 `level` 乘缩进：`#` 与 `###` 混用时（缺少中间层级）
 * 缩进会跳得很突然，而写作里这非常常见。这里给每个标题算一个**归一化的深度**
 * （只在自己比前一个深时才 +1），于是渲染层只需要 `depth * 步长`。
 */
export function outlineDepths(headings: readonly OutlineHeading[]): number[] {
  const depths: number[] = []
  let previousLevel = 0
  let currentDepth = -1
  for (const heading of headings) {
    if (heading.level > previousLevel) currentDepth += 1
    else currentDepth = Math.max(0, currentDepth - (previousLevel - heading.level))
    previousLevel = heading.level
    depths.push(currentDepth)
  }
  return depths
}
