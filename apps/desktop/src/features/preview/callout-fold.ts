/**
 * 阅读视图 callout 的手动折叠（点标题收起/展开）。
 *
 * 编辑器里折叠是"真"的（`[!note]-` 进连装饰带零高行，见 live-preview）；阅读视图的
 * `mn_callout` 只产出静态 HTML（导出件与静态站点本来就没有 JS），所以这里的折叠是
 * **呈现层**的：`data-mn-collapsed` 一挂，正文就不渲染 —— 与灯箱的 `data-mn-clipped`
 * 标记同一手法（丢了也只是"全展开"，内容一个字不少）。
 *
 * 为什么标题要是可聚焦的按钮语义：标题里只有图标 + 转义后的文本（没有链接），
 * 点它不会误触任何东西；键盘用户按 Tab 能停、按 Enter 能折 —— 与编辑器里
 * "点标记行折叠"同一条肌肉记忆。`role/tabindex/aria-expanded` 由
 * `enhanceCalloutTitles` 在每次 HTML 重建后补上（与代码复制按钮同一条"渲染完再挂"链路）。
 */

/** 收起标记（`data-mn-collapsed` 挂在 `.mn-callout` 上）。 */
export const CALLOUT_COLLAPSED_ATTR = 'data-mn-collapsed'

/**
 * 给正文里的每个 callout 标题补按钮语义（HTML 每次重建后调用一次）。
 *
 * 幂等：属性写上去就是最终值，重复调用不会叠加；卸载不需要清理 ——
 * 属性长在 innerHTML 子树里，重渲染/卸载时跟着整个消失。
 */
export function enhanceCalloutTitles(root: ParentNode | null): void {
  if (root === null) return
  for (const title of Array.from(root.querySelectorAll<HTMLElement>('.mn-callout__title'))) {
    title.setAttribute('role', 'button')
    title.setAttribute('tabindex', '0')
    const collapsed = title.closest('.mn-callout')?.hasAttribute(CALLOUT_COLLAPSED_ATTR) ?? false
    title.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
  }
}

/**
 * 切换一个 callout 的收起状态（点击 / Enter / Space 走这里）。
 *
 * 返回切换后的状态（`true` = 收起了）。传进来的不是标题时什么都不做、
 * 返回 `null`（调用方据此决定要不要 `preventDefault` / 吞掉事件）。
 */
export function toggleCalloutTitle(target: Element | null): boolean | null {
  const title = target?.closest('.mn-callout__title') ?? null
  if (!(title instanceof HTMLElement)) return null
  const holder = title.closest('.mn-callout')
  if (!(holder instanceof HTMLElement)) return null
  const collapsed = holder.hasAttribute(CALLOUT_COLLAPSED_ATTR)
  if (collapsed) {
    holder.removeAttribute(CALLOUT_COLLAPSED_ATTR)
    title.setAttribute('aria-expanded', 'true')
  } else {
    holder.setAttribute(CALLOUT_COLLAPSED_ATTR, '')
    title.setAttribute('aria-expanded', 'false')
  }
  return !collapsed
}
