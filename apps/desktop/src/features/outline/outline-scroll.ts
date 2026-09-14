/**
 * 大纲在**阅读视图**里的两件事：跳到第 N 个标题，以及回报"当前读到哪一节"。
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
 * 判定"当前读到哪一节"时，把容器顶边**往下偏一点**。
 *
 * 为什么不是 `top <= 容器顶边`：刚滚过一个标题时那个标题正好贴在顶边（`top ≈ 0`），
 * 严格的 `<= 0` 会因为亚像素误差在"上一节 / 这一节"之间抖。留几像素余量，
 * 视觉上仍然是"标题贴到顶边就算进入这一节"。
 */
const ACTIVE_HEADING_SLACK = 8

/**
 * 阅读视图里"当前读到哪一节"：视口顶部**最后一个**标题的序号（0 起算）。
 *
 * 与编辑视图的 `<=` 语义一致（光标落在正文里时属于上面那一节），只不过这里的"位置"
 * 是滚动容器顶端。还没滚到第一个标题时返回 `-1`（例如正文以引言段落开头）。
 */
export function visibleHeadingOrdinal(container: HTMLElement | null): number {
  if (container === null) return -1
  const body = container.querySelector('.mn-preview__body')
  if (body === null) return -1

  const headings = Array.from(body.querySelectorAll<HTMLElement>(HEADING_SELECTOR))
  const limit = container.getBoundingClientRect().top + ACTIVE_HEADING_SLACK
  let ordinal = -1
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]
    if (heading === undefined) break
    if (heading.getBoundingClientRect().top > limit) break
    ordinal = index
  }
  return ordinal
}

/**
 * 订阅阅读视图的滚动，回报"当前章节"的序号；返回取消函数（**调用方必须在卸载时调用**）。
 *
 * 监听装在 **document 的捕获阶段**（而不是某个具体容器元素上）：
 * 1. 预览的滚动容器可能因为视图切换/重新渲染而换成另一个元素，装在元素上的监听会静默失效
 *    （表现就是"滚动了但大纲不动"）——捕获阶段能收到页面上**任何**滚动容器的滚动事件；
 * 2. 因此每次计算时**重新查**容器与标题，不缓存元素引用；
 * 3. 计算放在 `requestAnimationFrame` 里（一帧最多一次）、序号没变就不回调
 *    （同一节里连续滚动能省掉大量重复渲染）。
 */
export function subscribeVisibleHeading(onOrdinal: (ordinal: number) => void): () => void {
  if (typeof document === 'undefined') return () => undefined

  let frame: number | null = null
  let last = -2

  const compute = (): void => {
    frame = null
    const ordinal = visibleHeadingOrdinal(
      document.querySelector<HTMLElement>('.mn-preview__scroller'),
    )
    if (ordinal === last) return
    last = ordinal
    onOrdinal(ordinal)
  }

  const schedule = (): void => {
    if (frame !== null) return
    frame =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(compute)
        : (setTimeout(compute, 16) as unknown as number)
  }

  document.addEventListener('scroll', schedule, { passive: true, capture: true })
  // 挂载时先算一次：切到阅读视图时视口可能已经停在某一节上
  schedule()
  return () => {
    document.removeEventListener('scroll', schedule, { capture: true })
    if (frame !== null) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
      else clearTimeout(frame)
      frame = null
    }
  }
}

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
