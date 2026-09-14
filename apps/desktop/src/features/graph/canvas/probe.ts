/**
 * 从真实 DOM 上读**主题令牌**（画笔需要的是"最终颜色"，不是令牌名）。
 *
 * 为什么单独一层：`--mn-*` 令牌由主题写到 `<html>` 上，`getComputedStyle` 一读就有；
 * 但 callout 的 13 种强调色是个例外 —— app.css 把它们写在 `var()` 的**兜底位置**上：
 *
 * ```css
 * .mn-callout--note { --mn-callout-accent: var(--mn-callout-note, #448aff); }
 * ```
 *
 * 于是 `getComputedStyle(html).getPropertyValue('--mn-callout-note')` 返回**空串**
 * （没有任何规则声明过这个名字），而 `--mn-callout-accent` 只在挂着
 * `mn-callout--<type>` 类的元素上才有值。想让画布上的提示框竖条与阅读视图同色，
 * 就得**按类型去问那个类**——这就是 {@link createTokenReader} 干的事。
 *
 * 为什么不把 13 种颜色抄进主题 JSON：那份色表本来就只有一处（app.css），
 * 抄进主题等于把它变成两处，而"阅读视图是蓝色、画布上是绿色"这类差异没有任何测试能提前发现。
 */

/** callout 类型令牌名 → app.css 里那个载体的类名（`--mn-callout-note` → `mn-callout--note`）。 */
export function calloutClassForToken(name: string): string | null {
  const prefix = '--mn-callout-'
  if (!name.startsWith(prefix)) return null
  const suffix = name.slice(prefix.length)
  // `--mn-callout-accent` 是**载体本身**，不是某一种类型的颜色（问它会绕回自己）
  if (suffix === '' || suffix === 'accent') return null
  return `mn-callout--${suffix}`
}

/**
 * 造一个"令牌名 → 颜色"的读取器。
 *
 * 读取顺序（每一步都可能拿到空串，所以逐级回落）：
 * 1. 直接问根元素（大多数令牌都在那里）；
 * 2. 失败且名字像 callout 的类型令牌时，用一次性的**探针元素**挂上对应的类再问
 *    `--mn-callout-accent`（app.css 的兜底值只有在这一步才会被解析成具体颜色）。
 *
 * 探针元素按类型缓存、`position: fixed; opacity: 0; pointer-events: none`：
 * 它只为"让浏览器算一次层叠"存在，不进可访问性树（`aria-hidden`），也不参与布局。
 */
export function createTokenReader(host: Element): (name: string) => string | null {
  const root = host.ownerDocument.documentElement
  const probes = new Map<string, HTMLElement>()

  const read = (element: Element, name: string): string | null => {
    const value = element.ownerDocument.defaultView?.getComputedStyle(element).getPropertyValue(name)
    const trimmed = value?.trim() ?? ''
    return trimmed === '' ? null : trimmed
  }

  return (name) => {
    const direct = read(root, name)
    if (direct !== null) return direct

    const className = calloutClassForToken(name)
    if (className === null) return null

    let probe = probes.get(className)
    if (probe === undefined) {
      probe = host.ownerDocument.createElement('span')
      probe.className = className
      probe.setAttribute('aria-hidden', 'true')
      probe.style.position = 'fixed'
      probe.style.opacity = '0'
      probe.style.pointerEvents = 'none'
      host.ownerDocument.body.appendChild(probe)
      probes.set(className, probe)
    }
    // 问的是载体本身：`--mn-callout-accent` 在 `.mn-callout--<type>` 上被声明过
    return read(probe, '--mn-callout-accent')
  }
}
