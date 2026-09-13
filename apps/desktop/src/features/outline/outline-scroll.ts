/**
 * 大纲在**阅读视图**里的跳转：滚到第 N 个标题并让它闪一下。
 *
 * 为什么按"序号"而不是按文本匹配：同一篇笔记里重复的标题很常见（"备注"、"示例"），
 * 按文本找第一个会在第二次点击时原地不动。序号来自同一个解析器（`parseOutline`），
 * 与预览里 `h1..h6` 的出现顺序天然一致 —— 预览关闭了 raw HTML（见 `domain/markdown.ts`），
 * 因此不存在"用户手写的 `<h2>` 混进来"这种偏差。
 *
 * 为什么不用 `id`/锚点：给标题加 id 就得改渲染层（纯函数），而且 id 还要处理重名与转义；
 * 这里只需要"滚动 + 高亮一下"，用 DOM 序号是最短路径。
 */

/** 高亮类名（样式在 `outline.css`；E2E 也用它断言）。 */
export const OUTLINE_FLASH_CLASS = 'mn-outline-flash'

/** 高亮持续时长（毫秒），与行定位的闪烁保持同一量级。 */
const FLASH_MS = 800

/** 预览正文里的标题元素（ATX 标题渲染出来的就是这几个标签）。 */
const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6'

/**
 * 滚到预览里的第 `ordinal` 个标题（0 起算）。
 *
 * @returns 是否找到了目标（阅读视图没挂载、序号超界时返回 `false`）
 */
export function scrollPreviewToHeading(ordinal: number): boolean {
  if (typeof document === 'undefined') return false
  const body = document.querySelector('.mn-preview__body')
  if (body === null) return false
  const headings = Array.from(body.querySelectorAll<HTMLElement>(HEADING_SELECTOR))
  const target = headings[ordinal]
  if (target === undefined) return false

  // `block: 'start'`：让标题贴在视口顶部（阅读时"从这一节开始读"才是直觉）
  target.scrollIntoView({ block: 'start' })

  // 先摘掉上一次的高亮：同一个元素连续点两次时，不摘会因类名没变化而不重放动画
  target.classList.remove(OUTLINE_FLASH_CLASS)
  // 强制回流一次，保证动画真的重放（否则浏览器会把两次改动合并成"没变"）
  void target.offsetWidth
  target.classList.add(OUTLINE_FLASH_CLASS)
  window.setTimeout(() => target.classList.remove(OUTLINE_FLASH_CLASS), FLASH_MS)
  return true
}
