/**
 * 知识图谱画布 —— **测量与卡片排版**（"一篇笔记在卡片里排成什么样、多高"）。
 *
 * 这一层补上 `canvas/text-layout.ts` 与"真画布"之间的两块空缺：
 *
 * 1. **量宽**：`text-layout` 的换行算法只接受一个注入的 `MeasureText`，生产里那一个必须是
 *    真 canvas 的 `measureText`（浏览器里唯一的字体度量来源）。这里把它包出来，
 *    并加一层**按 (字体, 字符串) 的缓存** —— 换行算法对同一个原子会反复比较（见 text-layout 的 `Atom.width`），
 *    而 `measureText` 是同步的布局查询，在 1 万节点的图谱里是这一层最大的开销来源。
 * 2. **卡片**：`toDrawBlocks`（markdown → 块）与 `layoutBlocks`（块 → 行与高度）之间还差
 *    "卡片自己的壳"——标题行、内边距、以及"内容超出卡片高度时截到哪儿"。这一步必须在
 *    **同一处**算完，因为画笔要按同样的数字摆标题与正文（两处各算一遍必然错位）。
 *
 * ## 为什么测量要缓存在这一层，而不是在排版层
 *
 * 排版层按设计是纯函数（不持有画布、能在 Worker 里跑）。缓存是**副作用**，
 * 而且缓存键里含"字体字符串"，那需要知道 canvas 的 `font` 语法（`fontString`）——
 * 属于"浏览器怎么写字"的知识，不是"文字怎么折行"的知识。所以缓存落在这一层，
 * 排版层保持可测、可搬。
 *
 * ## 为什么卡片高度**含**标题行与内边距
 *
 * `CardLayout.width/height` 的口径是**卡片外框**，与 `layout-ego.ts` 的 `EgoCardBox.rect` 一致：
 * 调用方（图谱布局）正是用 `height` 当卡片尺寸传给 `layoutEgo` 的 `sizes`。
 * 若这里只报"正文的高度"，卡片就会比内容矮一个标题行，正文最后一行被自己裁掉 ——
 * 而"卡片尺寸从哪里来"这个问题有两个答案（内容算出来的 / 布局收到的）时，必然有一处算错。
 */

import { frontmatterBody } from '@/domain/frontmatter'

import { toDrawBlocks, type DrawBlock } from './blocks'
import {
  DEFAULT_METRICS,
  layoutBlocks,
  type FontSpec,
  type LaidOutBlock,
  type LayoutMetrics,
  type MeasureText as LayoutMeasureText,
} from './text-layout'

/**
 * 量宽函数。**形状**取自 `text-layout`（那一层是换行与量宽的唯一来源），
 * 在这里重新声明成一个名字只是为了让"画笔与卡片排版"不必各自去 import 排版层的内部类型。
 * 这是一个类型别名而不是新接口：任何一处改了签名，另一处立刻红。
 */
export type MeasureText = LayoutMeasureText

/**
 * 正文字族（`fontString` 的缺省值）。
 *
 * 为什么是 `system-ui` 而不是 `--mn-font-ui` 的完整清单：这里的默认值必须**只此一份** ——
 * `canvasMeasure`（量宽）与 `paint.ts`（画字）都用缺省值，两边才会逐字一致。
 * 自定义字族只能靠 `fontString(font, family)` 手工传，而那样做的人必须同时自己造
 * `MeasureText`（`canvasMeasure` 没有 family 参数），也就必然会看到这条约束。
 *
 * `system-ui` 在 Windows 上就是 Segoe UI、在 macOS 上是 SF、在 Linux 上由 fontconfig 定，
 * 与 `--mn-font-ui` 的第一顺位一致，观感不会差一个档次。
 */
export const DEFAULT_FONT_FAMILY = 'system-ui, sans-serif'

/**
 * 等宽族。
 *
 * 与 `--mn-font-mono` 同源（去掉末尾的 CJK 兜底字体：canvas 的字体串太长时，
 * 各个 WebView 对"找不到就继续往后找"的实现细节不一致，短清单更可预期）。
 */
const MONO_FONT_FAMILY = "'Cascadia Code', Consolas, ui-monospace, monospace"

/** 量宽缓存的容量上限（按插入序淘汰）。 */
const MEASURE_CACHE_LIMIT = 4096

/**
 * FontSpec → canvas 的 `font` 字符串（`'600 15px system-ui, sans-serif'` 形状）。
 *
 * 顺序是 CSS 的硬要求：`style` → `weight` → `size` → `family`，其中 **size 与 family 必须有**
 * （少了任何一个，整条 `font` 串都是非法的，浏览器会静默保留上一次的字体 ——
 * 表现为"所有文字都变成上一个字体"，极难归因）。
 *
 * ⚠️ 等宽（`font.code`）**不跟着 `family` 参数走**：调用方传进来的是 UI 正文字族
 * （`--mn-font-ui`），拿它去量/画代码会把等宽变成比例字体，而文本换行是按等宽宽度算的。
 *
 * ⚠️ 等宽**不缩字号**：`text-layout` 的 `fontFor`/`fontOfRun` 给行内代码的是与正文同一个字号
 * （CSS 里那个 `font-size: 0.9em` 是阅读视图的口径），量宽与画字必须用同一个字号，
 * 这里自己乘 0.9 就会让画出来的比量出来的窄，行尾的文字开始互相咬。
 */
export function fontString(font: FontSpec, family: string = DEFAULT_FONT_FAMILY): string {
  const parts: string[] = []
  if (font.italic === true) parts.push('italic')
  // 600 而不是 700：与 app.css 里标题/`strong` 的 `font-weight: 600` 接近，
  // 也让"粗体"在 canvas 上不至于糊成一团（多数 UI 字体的 700 在小字号下笔画粘连）
  if (font.bold === true) parts.push('600')
  parts.push(`${font.size}px`)
  parts.push(font.code === true ? MONO_FONT_FAMILY : family)
  return parts.join(' ')
}

/**
 * 用真 canvas 的 `measureText` 造一个量宽函数（带小缓存）。
 *
 * 参数刻意收窄到"需要一个可写 `font` 与一个 `measureText`"的结构类型，而不是
 * `CanvasRenderingContext2D`：这样测试可以喂一个记录用的假上下文（不需要 jsdom、不需要真画布），
 * 而真调用方直接传自己的 2D 上下文即可。
 *
 * ⚠️ 缓存是**同步写回上下文**的代价换来的：每次未命中都会改 `context.font`。
 * 画笔那边每个 `fillText` 之前都会重设 `font`（那是它的契约），所以不会互相干扰；
 * 但**不要**在别处假设 `context.font` 在调用 `measure` 之后还是你设的值。
 *
 * 容量上限的存在理由：一张卡片会量几百个原子，1 万节点的图谱不设上限就是几 MB 的字符串键常驻内存；
 * 满了按**插入序**（`Map` 的顺序）淘汰最早的，不用时间戳 —— 时间戳会让"淘汰谁"依赖真实时间，
 * 于是同一份输入在不同运行里可能得到不同的缓存命中，测不了也解释不清。
 */
export function canvasMeasure(context: {
  font: string
  measureText(text: string): { width: number }
}): MeasureText {
  const cache = new Map<string, number>()

  return (text, font) => {
    const fontSpec = fontString(font)
    const key = `${fontSpec}\u0000${text}`
    const hit = cache.get(key)
    if (hit !== undefined) return hit

    context.font = fontSpec
    const width = context.measureText(text).width
    cache.set(key, width)
    while (cache.size > MEASURE_CACHE_LIMIT) {
      const oldest = cache.keys().next()
      if (oldest.done === true) break
      cache.delete(oldest.value)
    }
    return width
  }
}

// ---------------------------------------------------------------------------
// 卡片的壳（标题行 + 内边距）
// ---------------------------------------------------------------------------

/** 卡片的四边内边距（px，世界坐标）。 */
export const CARD_PADDING = 10

/** 标题字号相对正文的倍率（标题比正文大一点，读者一眼能分出"卡片讲的是什么"）。 */
export const CARD_TITLE_SCALE = 1.25

/** 标题行与正文之间的细线两侧各留这么宽（线上下一共两笔）。 */
const CARD_SEPARATOR_GAP = 6

/**
 * 卡片的"壳"几何：内边距、标题行高、分隔线位置、正文起点。
 *
 * 为什么是一个函数而不是一串散在 `layoutCard` 与 `paint.ts` 里的算式：正文起点
 * （`bodyTop`）**同时**决定"卡片要多高"（本该层）与"正文从哪里开始画"（画笔）。
 * 两处各写一遍 `padding + lineHeight * 1.25 + 12`，改一个数就会让正文整体上移/下移一个固定量 ——
 * 表现为"卡片底部总有一块空白"或"最后一行被裁掉"，而这类错位在小卡片上很难一眼看出是哪一层的问题。
 *
 * 返回的是世界坐标下的数字（不含缩放）：缩放只在画笔里做一次。
 */
export function cardChrome(metrics: LayoutMetrics): {
  padding: number
  titleHeight: number
  separatorY: number
  bodyTop: number
} {
  const padding = CARD_PADDING
  const titleHeight = metrics.lineHeight * CARD_TITLE_SCALE
  const separatorY = padding + titleHeight + CARD_SEPARATOR_GAP
  return { padding, titleHeight, separatorY, bodyTop: separatorY + CARD_SEPARATOR_GAP }
}

/**
 * 「纯标题」卡片的外框高度：标题行 + 分隔细线 + 上下内边距，没有正文。
 *
 * 为什么不手写一个数：标题行高是 `metrics.lineHeight × CARD_TITLE_SCALE`，分隔线的位置由
 * `cardChrome` 定 —— 两处任何一个改了，手写的那份高度就会让卡片上下留白错位（这类错位正是
 * `cardChrome` 存在的原因）。所以纯标题卡片的高度也由同一份壳几何推出来：`bodyTop + padding`
 * 与 `layoutCard` 里"正文为空"时的高度是同一个算式。
 */
export function titleOnlyCardHeight(metrics: LayoutMetrics = DEFAULT_METRICS): number {
  return cardChrome(metrics).bodyTop + CARD_PADDING
}

// ---------------------------------------------------------------------------
// 卡片排版
// ---------------------------------------------------------------------------

/**
 * 一张卡片的排版结果。
 *
 * `blocks` 里**只有正文**，标题行不在其中：标题由画笔直接用 `PaintNode.title` 画成一行
 * （它不该折行、也不参与 markdown 解析），把它塞进 `blocks` 会让"标题被画两遍"或
 * "正文第一块被当成标题跳过"这类条件散进画笔。标题占的高度由 `cardChrome` 给出，
 * 已经算进 `height` 里了。
 */
export interface CardLayout {
  relPath: string
  title: string
  /** 卡片**外框**宽度（= 传入的 `width`）。 */
  width: number
  /** 卡片**外框**高度（标题行 + 内边距 + 正文），与 `EgoCardBox.rect` 同口径。 */
  height: number
  /** 正文块（已折行、已定高）。 */
  blocks: LaidOutBlock[]
  /** 内容被 `maxHeight` 截掉过（末尾补的那一行 `…` 就是它的标记）。 */
  truncated: boolean
}

/** 截断时补在最后的那一行：一个普通段落块，画笔照常按行画（不需要为它加分支）。 */
const ELLIPSIS = '…'

/**
 * 一篇笔记正文 → 卡片里的排版结果。
 *
 * 两条纪律：
 * 1. **markdown 只在这里解析一次**（`toDrawBlocks`），别处不要再解析一遍 ——
 *    `blocks.ts` 与阅读视图共用同一份语法口径，多一处解析就多一处"两处长得不一样"的机会；
 * 2. **换行只由 `layoutBlocks` 决定**（连同这里传进去的 `metrics`），
 *    本函数不自己切行，画笔也不许再切。
 *
 * `maxHeight` 的口径是**正文区**（不含标题行与内边距）的高度上限：
 * 调用方通常传 `卡片可用的总高 - cardChrome(metrics).bodyTop - CARD_PADDING`。
 * 取"正文区"而不是"整卡高度"，是因为卡片高度在 ego 布局里恰恰**由内容决定**
 * （`CardLayout.height` 就是喂给 `layoutEgo` 的 `sizes`）—— 拿它当输入会变成循环依赖。
 *
 * `width` 是卡片**外框**宽度，内容宽度由它减掉两边内边距算出；`metrics.width` 会被覆盖成
 * 这个内容宽度，因为"卡片多宽"与"文字折多宽"必须是同一个数，而后者只能有一个来源。
 */
export function layoutCard(input: {
  relPath: string
  title: string
  text: string
  width: number
  metrics?: Partial<LayoutMetrics>
  measure: MeasureText
  maxHeight?: number
}): CardLayout {
  const contentWidth = Math.max(1, input.width - CARD_PADDING * 2)
  // `width` 参数**覆盖** metrics.width（顺序在展开之后）：两者是同一个事实的两种写法，
  // 让 metrics 赢就会出现"卡片 300 宽、文字按 260 折"这种谁也说不清的组合
  const metrics: LayoutMetrics = { ...DEFAULT_METRICS, ...input.metrics, width: contentWidth }
  const chrome = cardChrome(metrics)

  /*
   * 正文先过 `frontmatterBody`：YAML 头是**元数据**，不是正文。
   *
   * 为什么剥在这一层（而不是 `toDrawBlocks` 里）：`blocks.ts` 是"markdown → 块"的纯函数、
   * 不该知道笔记文件的格式约定（它自己的注释也是这么写的）；而这里是"**一篇笔记文件** →
   * 一张卡片排版"的唯一入口 —— 阅读视图 / 浮窗 / 导出件各自都在自己的入口处做同一件事，
   * 判据（`domain/frontmatter.ts` 的 `frontmatterBody`）只有那一份。
   *
   * 不剥的后果是一眼可见的：卡片顶上多出一条分隔线加几行 `key: value`（`tags: [项目]` 之类），
   * 而它恰恰是用户这一轮点名要求去掉的东西。
   */
  const laidOut = layoutBlocks(
    toDrawBlocks(frontmatterBody(input.text)),
    metrics,
    input.measure,
  )
  // `maxHeight: undefined` = 不截断；`NaN` 也按不截断处理（它更可能是"算错了"，而不是"要截成 0"）
  const limit =
    input.maxHeight === undefined || !Number.isFinite(input.maxHeight)
      ? Number.POSITIVE_INFINITY
      : Math.max(0, input.maxHeight)

  const { blocks, truncated } = truncateBlocks(laidOut, limit, metrics)
  return {
    relPath: input.relPath,
    title: input.title,
    width: input.width,
    height: chrome.bodyTop + blocksHeight(blocks) + CARD_PADDING,
    blocks,
    truncated,
  }
}

/**
 * 按**块**截断（不是把块切一半），并在末尾补一行 `…`。
 *
 * 为什么不切块：块高度是"折了几行 × 行高"算出来的，切一半意味着要在画笔里再画半行文字 ——
 * 那会让"排版层是唯一的换行来源"这条纪律破一个口子（画笔得知道这一行被切到哪，`LaidOutLine`
 * 并没有表达"部分可见"）。
 *
 * 省略号那一行本身也要占地方，所以先把"能放下的整块"尽量放进去，发现放不下下一块时，
 * **回退**到"放得下省略号"为止 —— 回退而不是把省略号画在卡片外面：宁可少显示一块正文，
 * 也要让"这里被截断了"这件事看得见（读者至少知道有内容，而不是以为笔记就这么长）。
 *
 * 极端情况：上限连一行都放不下（卡片被压得极扁）时，返回空正文 + `truncated: true` 且**没有**省略号 ——
 * 画不下就是画不下，诚实地告诉调用方，而不是偷偷超出一个像素去挤那一行。
 */
function truncateBlocks(
  blocks: readonly LaidOutBlock[],
  limit: number,
  metrics: LayoutMetrics,
): { blocks: LaidOutBlock[]; truncated: boolean } {
  const kept: LaidOutBlock[] = []
  let used = 0
  for (const item of blocks) {
    // 块间距只在块与块之间数（与 `totalHeight` 的口径一致）：第一块之前没有间距
    const next = used + (kept.length === 0 ? 0 : item.gapAfter) + item.height
    if (next > limit) break
    kept.push(item)
    used = next
  }
  if (kept.length === blocks.length) return { blocks: kept, truncated: false }

  const ellipsis = ellipsisBlock(metrics)
  while (kept.length > 0 && blocksHeight([...kept, ellipsis]) > limit) kept.pop()
  if (blocksHeight([ellipsis]) <= limit) kept.push(ellipsis)
  return { blocks: kept, truncated: true }
}

/** 一批块的总高（含块间间距，最后一块之后不算间距）——与 `text-layout` 的 `totalHeight` 口径一致。 */
function blocksHeight(blocks: readonly LaidOutBlock[]): number {
  let total = 0
  blocks.forEach((item, index) => {
    total += item.height
    if (index < blocks.length - 1) total += item.gapAfter
  })
  return total
}

/**
 * 省略号那一行。
 *
 * 造一个真的 `LaidOutBlock`（而不是让画笔"在末尾额外画一行字"）：截断结果因此仍然是一份
 * 普通的块清单，画笔与未来任何读者（导出、打印、可访问性描述）都不需要知道"这一行有特殊来源"。
 * 这里不调 `measure` 量它的宽度：省略号只有一行、且永远左对齐，宽度唯一可能的用途是居中，
 * 而量一次要往 `measure` 的缓存里塞一条只有一处会用到的记录。
 */
function ellipsisBlock(metrics: LayoutMetrics): LaidOutBlock {
  const block: DrawBlock = { kind: 'paragraph', runs: [{ text: ELLIPSIS }] }
  return {
    block,
    lines: [{ runs: [{ text: ELLIPSIS }], width: 0 }],
    height: metrics.lineHeight,
    indent: 0,
    gapAfter: metrics.blockGap,
  }
}

// ---------------------------------------------------------------------------
// 排版缓存
// ---------------------------------------------------------------------------

/** 缓存默认容量。取 240 ≈ "一屏 + 前后各一屏"的卡片数，够挡住缩放/平移时的反复重排。 */
const DEFAULT_CARD_CACHE_ENTRIES = 240

export interface CardLayoutCache {
  get(
    key: { relPath: string; title: string; text: string; width: number; maxHeight?: number },
    build: () => CardLayout,
  ): CardLayout
  readonly size: number
  clear(): void
}

/**
 * 排版缓存：同一 (relPath, 宽度, 正文内容) 只排一次。
 *
 * 为什么需要：平移/缩放时每一帧都会重新问"这张卡片的正文是什么"，而排版要跑一遍 markdown 解析
 * 加换行 —— 那比画一遍贵一个数量级。缓存键里**必须**含 `width` 与 `maxHeight`：
 * 它们会改变换行与截断结果。
 *
 * 键里也含 `title`，虽然标题不参与正文排版：`CardLayout` 会把 `title` 带回给调用方，
 * 键里没有它，改名后的卡片就会拿到**上一个名字**（改名的笔记被缓存命中的那一次会显示旧标题）。
 * 这是按内容寻址的经典坑，多存一个字符串比让用户看到错的标题便宜得多。
 *
 * 淘汰按**插入顺序**（`Map` 的迭代顺序）删最早的，不用时间戳：
 * 时间戳会让命中/淘汰依赖真实时钟，于是"同一份输入"在不同运行里可能得到不同的结果 —— 没法测、
 * 也没法解释。调用方要"按访问新鲜度"淘汰的话该用 LRU，那是另一个策略，不该悄悄混进来。
 *
 * 存的是**引用**而不是副本：`CardLayout` 被视为只读（画笔只读它）。要改它请走 `clear()` ——
 * 深拷贝一整套排版结果比重新排一遍还贵，那这个缓存就没有意义了。
 */
export function createCardLayoutCache(options: { maxEntries?: number } = {}): CardLayoutCache {
  const limit = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_CARD_CACHE_ENTRIES))
  const entries = new Map<string, CardLayout>()

  return {
    get(key, build) {
      const cacheKey = `${key.relPath}\u0000${key.width}\u0000${key.maxHeight ?? ''}\u0000${key.title}\u0000${key.text}`
      const hit = entries.get(cacheKey)
      if (hit !== undefined) return hit

      const built = build()
      entries.set(cacheKey, built)
      while (entries.size > limit) {
        const oldest = entries.keys().next()
        if (oldest.done === true) break
        entries.delete(oldest.value)
      }
      return built
    },
    get size() {
      return entries.size
    },
    clear() {
      entries.clear()
    },
  }
}
