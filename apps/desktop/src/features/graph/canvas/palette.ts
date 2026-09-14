/**
 * 知识图谱画布 —— **调色板**（主题令牌 `--mn-*` → 具体颜色）。
 *
 * 这一层只做一件事：把"颜色在哪儿"与"颜色是什么"分开。canvas 不认识 CSS 变量，
 * `fillStyle = 'var(--mn-fg)'` 是**非法值**（浏览器直接忽略这次赋值，于是画出来的是一片黑/什么都没有，
 * 而且不报错），所以画笔必须拿到**已经解析成颜色**的字符串。解析这一步（`getComputedStyle`）就落在这里。
 *
 * ## 为什么是"读令牌"而不是"再写一份色表"
 *
 * 主题、阅读视图、导出件都以 `styles/app.css` 与 `theme/themes/*.json` 为唯一真源
 * （`theme/tokens.ts` 的 `REQUIRED_TOKENS` 就是那份契约）。画布这边再抄一份十六进制值，
 * 迟早出现"阅读视图是蓝色、卡片上是绿色"这种没人能解释的差异 —— 而且换主题时它**不会**报错，
 * 只会看起来怪。所以本文件里一个具体颜色都不写死（唯一允许的是"令牌读不到"时的兜底常量，
 * 见下），全部经由 `token(name)` 问出来。
 *
 * ## 为什么兜底值是"深色主题的那一份"
 *
 * 读不到令牌是**正常**会发生的事，不是异常：
 * - 主题 JSON 还没被应用（`<html data-theme>` 还没设）时的首帧；
 * - 元素还没挂进文档 / 样式表还没加载完（`getComputedStyle` 一律返回空串）；
 * - 某个令牌被主题作者漏掉（`REQUIRED_TOKENS` 里那些有单测兜着，可 callout 那 13 个不在其中）。
 *
 * 这三种情况下如果返回空串，`fillStyle = ''` 会被静默忽略、画笔继续用**上一次**的颜色 ——
 * 表现为"整幅图颜色错乱"或"卡片是黑的"，而且第一眼看上去像是绘制逻辑坏了。
 * 所以兜底是**可读的深色主题颜色**（本应用默认深色）：宁可颜色不完全对，
 * 也要保证"画得出来、看得清"。
 *
 * ## callout 强调色：一处必须知道的落差（不是 bug，见 {@link calloutAccent}）
 *
 * app.css 里 13 种 callout 的写法是 `--mn-callout-accent: var(--mn-callout-note, #448aff)` ——
 * 具体颜色写在 `var()` 的**兜底位置**上，而 `--mn-callout-note` 这个变量**没有任何主题真的定义过**。
 * JS 的 `getComputedStyle` 读不到 `var()` 里的兜底值，所以 `token('--mn-callout-note')` 得到空串。
 * 本文件不去"补一份 13 色的表"（那正是要避免的第二份真源），而是按下面的链条降级 ——
 * 完整的取舍与两条修法写在 {@link calloutAccent} 上。
 */

import {
  CALLOUT_TYPES,
  FALLBACK_CALLOUT_TYPE,
  type CalloutDefinition,
  type CalloutType,
} from '@/domain/callouts'

/** 画布上要用到的全部颜色。字段名本身就是"用途"，而不是"令牌名"或"色值"。 */
export interface GraphPalette {
  background: string
  cardBg: string
  cardBorder: string
  cardBorderFocus: string
  title: string
  text: string
  muted: string
  link: string
  codeBg: string
  codeText: string
  quoteBorder: string
  edge: string
  edgeActive: string
  imageBox: string
}

/**
 * 令牌名 → 用途的映射。放在一处而不是散在 `paletteFrom` 里，是因为"哪个令牌管哪一笔"
 * 本身就是要被审的东西（改一个字段时能一眼看到它问的是哪个令牌）。
 *
 * `codeText` 问的是 `--mn-fg`：app.css 里 `code` / `pre` 只设了背景与等宽字体，
 * **没有**单独的前景色令牌（文字沿用正文色）。这里如实跟着走，不自己发明一个
 * `--mn-code-fg`（发明出来的令牌没有任何主题会填，等于把兜底常量伪装成令牌）。
 *
 * `edge` 取 `--mn-fg-subtle`、`edgeActive` 取 `--mn-accent`：与 `graph.css` 里
 * `.mn-graph__edge { stroke: var(--mn-fg-subtle) }` / `--active { stroke: var(--mn-accent) }` 同一份。
 *
 * `imageBox` 取 `--mn-bg-elevated`：与 `.mn-image-placeholder { background: var(--mn-bg-elevated) }` 一致
 * （占位框的颜色本来就是"和卡片底一样、靠虚线边框看出来"）。
 */
const TOKENS: Readonly<Record<keyof GraphPalette, string>> = {
  background: '--mn-bg',
  cardBg: '--mn-bg-elevated',
  cardBorder: '--mn-border',
  cardBorderFocus: '--mn-accent',
  title: '--mn-heading',
  text: '--mn-fg',
  muted: '--mn-fg-muted',
  link: '--mn-link',
  codeBg: '--mn-code-bg',
  codeText: '--mn-fg',
  quoteBorder: '--mn-quote-border',
  edge: '--mn-fg-subtle',
  edgeActive: '--mn-accent',
  imageBox: '--mn-bg-elevated',
}

/**
 * 读不到令牌时用的兜底（就是内置深色主题 `mimenote-dark.json` 的那一组值，逐字抄来）。
 *
 * 为什么逐字抄而不是"随便给个灰"：首帧读不到令牌时画出来的应当**正好是用户马上要看到的那个主题**，
 * 否则打开图谱会先闪一下另一套配色。抄的是主题 JSON 的公开事实，不是又一份色表 ——
 * 主题一改这里就有个"可见的差异"要跟（而不是悄悄地不一致）。
 */
const FALLBACK: GraphPalette = {
  background: '#14161a',
  cardBg: '#1b1e24',
  cardBorder: '#272b33',
  cardBorderFocus: '#7aa2f7',
  title: '#7aa2f7',
  text: '#d7dce5',
  muted: '#98a2b3',
  link: '#7dcfff',
  codeBg: '#1b1f27',
  codeText: '#d7dce5',
  quoteBorder: '#3a4358',
  edge: '#6b7480',
  edgeActive: '#7aa2f7',
  imageBox: '#1b1e24',
}

/**
 * app.css 里那条"只声明 `--mn-callout-accent`"的规则所赋值的变量名。
 *
 * 单独列出来是因为它是**唯一**真的能被读到的 callout 变量：类型类名挂在元素上时
 * （`.mn-callout--note`）`--mn-callout-accent` 才有值，而 `CALLOUT_TYPES[type].token`
 * 给出的 `--mn-callout-note` 谁也读不到（理由见文件顶部）。
 */
const CALLOUT_ACCENT_VAR = '--mn-callout-accent'

/**
 * callout 强调色全部读不到时的兜底：**引用竖线色**。
 *
 * 这个选择不是随手取的，而是与 app.css 的兜底链逐字一致：
 * `border-left: 3px solid var(--mn-callout-accent, var(--mn-quote-border))` ——
 * 阅读视图在"强调色缺失"时画的也是这一条灰蓝色的竖线。两边同时降级到同一个颜色，
 * 才不会出现"阅读视图是灰的、画布是蓝的"这种只有一处坏掉才会有的分歧。
 */
const FALLBACK_CALLOUT_ACCENT = FALLBACK.quoteBorder

/**
 * 纯函数：给定"取令牌"的函数，产出调色板。
 *
 * 对 `null` / 空串 / 纯空白一律走兜底（`getComputedStyle` 对未声明的令牌返回空串，
 * 手写的假实现常常返回 `null`，两种都算"没有这个令牌"）。
 *
 * ⚠️ 只 `trim()` 判空、**不** trim 返回值：令牌值可能带前后空白，而 canvas 的 `fillStyle`
 * 接受带空白的颜色串；替调用方揉一遍字符串只会让"我到底读到了什么"变得不可见。
 */
export function paletteFrom(token: (name: string) => string | null): GraphPalette {
  const read = (name: keyof GraphPalette): string => {
    const value = usable(token(TOKENS[name]))
    return value === null ? FALLBACK[name] : value
  }
  return {
    background: read('background'),
    cardBg: read('cardBg'),
    cardBorder: read('cardBorder'),
    cardBorderFocus: read('cardBorderFocus'),
    title: read('title'),
    text: read('text'),
    muted: read('muted'),
    link: read('link'),
    codeBg: read('codeBg'),
    codeText: read('codeText'),
    quoteBorder: read('quoteBorder'),
    edge: read('edge'),
    edgeActive: read('edgeActive'),
    imageBox: read('imageBox'),
  }
}

/**
 * 真实现：从某个元素上读 `--mn-*` 的计算值。
 *
 * 读的是**元素**而不是 `document.documentElement`：画布可能被挂在一个局部主题作用域里
 * （导出件、嵌入预览、将来的分屏对比），那时根元素上的值不是这一块该用的值。
 *
 * 三层防御（每一层都对应一种真实发生过的"整幅图没颜色"）：
 * 1. `getComputedStyle` 在非 DOM 环境（Worker、node 测试）根本不存在 —— 直接退兜底；
 * 2. 它对**不是 Element 的东西**（或已经脱离文档、甚至已销毁的节点）会抛异常 —— 捕获后退兜底；
 * 3. 元素在文档里但样式表没算完时返回空串 —— 由 `paletteFrom` 的空串判据接住。
 *
 * **不**在这里做任何解析/转色：`fillStyle` 接受的就是 CSS 颜色串（`#rrggbb`、`rgb(...)`、
 * 甚至 `var()` 解析后的结果都是串），提前转成 RGB 数组只会多一层可能出错的代码。
 */
export function readPalette(element: Element): GraphPalette {
  if (typeof getComputedStyle !== 'function') return paletteFrom(() => null)

  let computed: CSSStyleDeclaration | null = null
  try {
    computed = getComputedStyle(element)
  } catch {
    // 元素不可测量（已销毁 / 不是真的 Element）：退兜底，而不是把异常抛给绘制循环 ——
    // 绘制失败会让整个图谱空白，而"颜色不太对"只是观感问题。
    computed = null
  }
  if (computed === null) return paletteFrom(() => null)

  const style = computed
  return paletteFrom((name) => style.getPropertyValue(name))
}

/**
 * callout 的强调色：`CALLOUT_TYPES[type].token`（如 `--mn-callout-note`）→ 具体颜色。
 *
 * 降级链（每一档都有理由，别把它简化成一句 `token(...) ?? 常量`）：
 *
 * 1. **类型自己的令牌**（`--mn-callout-note`）：主题若真的定义了它，这是最准的来源；
 * 2. **`--mn-callout-accent`**：app.css 里那条"只声明 `--mn-callout-accent`"的规则。
 *    调用方完全可以把 `token` 的实现换成"在挂了 `mn-callout--<type>` 类的探针元素上读这个变量"
 *    （所见即所得编辑器 `live-preview/callout.ts` 用的就是这条路，连颜色表都不用抄），
 *    那一档就能拿到真正的 13 种颜色；
 * 3. **引用竖线色**：与 app.css 的 `var(--mn-callout-accent, var(--mn-quote-border))` 逐字一致。
 *
 * ⚠️ 已知落差（写清楚免得后人来查）：用 `readPalette` 直接产出的 `token` 只能走到第 3 档 ——
 * 内置主题既不定义 `--mn-callout-note`，元素上也没有 callout 类名。
 * 想让画布真的上色，二选一（都不需要改本文件）：
 * - 在主题 JSON 里把 13 个 `--mn-callout-*` 真的定义出来（最干净：颜色仍然只有一份）；
 * - 给画笔传一个 `token`（见 `paint.ts` 的 `PaintInput.token`），它内部走上面第 2 档。
 *
 * 未知类型（用户手写 `[!摘录]`，或插件带来任意类型名）回落 `FALLBACK_CALLOUT_TYPE`：
 * 与 `blocks.ts` 的口径一致 —— 那时块上的 `type` 本来就已经是规范化后的类型了，
 * 这里再判一次只是为了让本函数**单独**用也不会炸（它是个公开导出）。
 */
export function calloutAccent(token: (name: string) => string | null, type: string): string {
  const definition = definitionOf(type)

  const own = usable(token(definition.token))
  if (own !== null) return own

  const shared = usable(token(CALLOUT_ACCENT_VAR))
  if (shared !== null) return shared

  return FALLBACK_CALLOUT_ACCENT
}

/**
 * 类型名 → 定义。
 *
 * 用 `isCalloutType`（`hasOwnProperty`）而不是 `value in CALLOUT_TYPES`：
 * 类型名最终来自用户写在笔记里的 `[!x]`，而 `in` 会把原型上的 `constructor`、`toString`
 * 也判成"认识这种 callout"。同一口径在 `blocks.ts` 里也有一份（那边是私有的）——
 * 判据本身很短，重复它比导出一个只为一处服务的内部函数更划算。
 */
function definitionOf(type: string): CalloutDefinition {
  return isCalloutType(type) ? CALLOUT_TYPES[type] : CALLOUT_TYPES[FALLBACK_CALLOUT_TYPE]
}

/** 运行时校验（`type` 是 `string`，不能靠断言把它变成 `CalloutType`）。 */
function isCalloutType(value: string): value is CalloutType {
  return Object.prototype.hasOwnProperty.call(CALLOUT_TYPES, value)
}

/** "这个令牌有值吗"：`null`、空串、纯空白都算没有。 */
function usable(value: string | null): string | null {
  if (value === null || value.trim() === '') return null
  return value
}
