/**
 * 知识图谱画布 —— **Markdown → 绘制块清单**（纯函数：不 import React、不碰 DOM、不 import 画笔）。
 *
 * 为什么需要这一层：图谱的每个节点要画成"完整的 Markdown 预览"（ADR-0021），而 **canvas 没有 HTML** ——
 * `renderMarkdown` 那条路（token → HTML 字符串 → DOMPurify → DOM）到这里就断了：
 * 画布既不能把 HTML 塞进去，也没有 `getBoundingClientRect` 去问"这段文字有多宽"。
 * 所以链路的形状是：
 *
 * ```
 * markdown ──parseMarkdownTokens──▶ token 流 ──toDrawBlocks──▶ 绘制块清单 ──layoutBlocks──▶ 行与高度
 *                                                                                      │
 *                                                                            canvas 画笔（另一个人写）
 * ```
 *
 * 本文件只管第一步：把 token 变成**一份能被测量的清单**。它不决定字号、不决定行高、不决定缩进多少像素 ——
 * 那些全在 `canvas/text-layout.ts` 的 `LayoutMetrics` 里（几何参数只有一份，画笔与排版共用）。
 * 这样切开的好处是"Markdown 的**语义**"与"像素几何"可以各自被钉死测试：
 * 本文件用 `tests/graph-blocks.test.ts` 断言"哪些字是粗体、列表从第几号开始"，
 * 而"多宽换行、多高"在 `tests/graph-text-layout.test.ts` 里断言，两边互不干扰。
 *
 * ## 为什么解析必须复用 `parseMarkdownTokens`
 *
 * `domain/markdown-core.ts` 里那份 `md` 实例上挂了我们自己的两条行内规则
 * （`[[wikilink]]` 与 `![[嵌入]]`）。**语法口径只能有一份**：自己再 `new MarkdownIt()` 的话，
 * 阅读视图认、画布不认（或反过来）的分歧会随着规则演进而累积，而这类分歧最难查 ——
 * 用户看到的只是"同一篇笔记在两处长得不一样"。所以这里一不新建实例、二不碰 HTML 字符串、
 * 三不自己写解析器，只读 token。
 *
 * ## 为什么读 token 而不是读渲染出来的 HTML
 *
 * 从 HTML 反推排版（`DOMParser` + 遍历元素）看起来更省事，但它要先把整篇渲染成字符串、
 * 再解析一次，而且会**绕过我们自己的 token 语**：`attrs` 里那些 `data-mn-*`、
 * `list_item_open` 的序号、`th` 的对齐，都是从 token 上一手可得的，绕一圈 HTML 只会多一层失真。
 *
 * ⚠️ 这里**不做净化**，也不需要：产出的是"文字 + 样式标志"，没有任何 HTML 字符串会流到画布上。
 *
 * ## callout（`> [!note] 标题`）为什么读"类名"而不是自己再判一次
 *
 * `domain/markdown-core.ts` 的 `mn_callout` 核心规则**已经**用 `domain/callouts.ts` 的
 * `parseCallout`（唯一一份判据）判过"这条引用是不是提示框"，并把结论写进了 token：
 * `blockquote_open` 带 `class="mn-callout mn-callout--<type>"`，标记那一段换成标题栏
 * （`html_block`，里边是图标 + 已经过 `calloutTitle` 的标签 + 折叠角标）。
 *
 * 于是画布这边**不重复判定**，只消费那份结论。这不是偷懒，而是唯一不漂移的做法：
 *
 * - 核心规则的判据比自己写的"首段是不是 `[!x]`"更细 —— 例如 `> # 标题` 之后才出现
 *   `> [!note] x` 时，它认这是提示框（标记段落不是第一个孩子），而朴素判据不认；
 * - 而且标记原文在这里**已经不存在了**：那一段的 `inline` 令牌被换成了标题栏 HTML，
 *   `parseCallout` 想再跑一次也没有输入（见 `readCalloutBar` 里的取舍说明）。
 */

import { CALLOUT_TYPES, FALLBACK_CALLOUT_TYPE, type CalloutType } from '@/domain/callouts'
import { numericAttr, parseMarkdownTokens, type MarkdownToken } from '@/domain/markdown-core'
import { TASK_CHECKED_ATTR, taskCheckedFromAttr } from '@/domain/task-list'

// ---------------------------------------------------------------------------
// 绘制块
// ---------------------------------------------------------------------------

/**
 * 一段**同样式**的行内文字。
 *
 * 为什么按"run"而不是按"字符/单词"切：画布上每一段文字的字体是 `fillText` 的一个参数，
 * 换字体就要重设一次状态。`**粗**体` 里的粗体部分必须与前后文分开量宽（见 text-layout 的换行），
 * 于是"同样式的最长片段"正好是排版与绘制都需要的粒度。
 *
 * ⚠️ 各标志的**优先级与互斥关系**由画笔落地，本层只保证"标志为真就是那个意思"：
 * - `code` 与 `bold`/`italic` 可以同时为真（阅读视图里 `<code>` 在 `<strong>` 内部确实两样都生效）；
 * - `wikilink` **一定**伴随 `link: true`（链接色/下划线是共有的），线型由 `wikilink` 决定（虚线）——
 *   与阅读视图逐项对应：`a.mn-wikilink { color: var(--mn-link); border-bottom: 1px dashed }`。
 *   画笔请**不要**为同一条 run 画两条下划线。
 */
export interface InlineRun {
  text: string
  bold?: boolean
  italic?: boolean
  /** 行内代码：等宽 + 背景色。 */
  code?: boolean
  strikethrough?: boolean
  /** 链接文字（画下划线 + 主题链接色）。 */
  link?: boolean
  /** `[[…]]`：按链接画，但用虚线下划线（与阅读视图的观感一致）。 */
  wikilink?: boolean
  /** 只作诊断用（canvas 不跳转）：行内链接取 `href` 属性，wikilink 取 `data-target`。 */
  href?: string
}

/** 对齐方式（GFM 表格的分隔行语法，如 `|:--|:-:|--:|`）。 */
export type TableAlign = 'left' | 'center' | 'right'

/**
 * 绘制块：画布上一块**独占纵向空间**的内容。
 *
 * 为什么是"块"而不是"元素树"：画布上的纵向位置是累加出来的（`y += height + gap`），
 * 所以清单必须是一维的、每项都知道自己占多高。行内元素（粗体、链接）不占独立纵空间，
 * 因此它们只能出现在 `runs` 里，不能成为块。
 *
 * 各块类型的字段都是**画笔真正需要**的那几个（多一个字段就要多一份测试去钉它）。
 */
export type DrawBlock =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; runs: InlineRun[] }
  | { kind: 'paragraph'; runs: InlineRun[] }
  | {
      kind: 'list-item'
      ordered: boolean
      /** 有序列表的**实际序号**（从 `start` 属性起算）；无序列表恒为 0。 */
      index: number
      /** 嵌套层级，0 = 最外层。 */
      depth: number
      runs: InlineRun[]
      /** 任务列表：`undefined` = 不是任务项。 */
      checked?: boolean
    }
  | { kind: 'quote'; depth: number; runs: InlineRun[] }
  | { kind: 'code'; language: string; lines: string[] }
  | {
      kind: 'image'
      alt: string
      src: string
      /** 来自我们自己的 `data-mn-width` / `data-mn-height`（`![[图.png|300x200]]`）；读不到就是 `null`。 */
      width: number | null
      height: number | null
    }
  | { kind: 'hr' }
  | {
      kind: 'table'
      /** 表头行（GFM 只有一行，但 token 流允许 thead 里出现多行，所以这里用二维）。 */
      header: string[][]
      rows: string[][]
      /** 每列对齐；长度 = 列数。 */
      aligns: TableAlign[]
    }
  | CalloutBlock

/**
 * 提示框（`> [!note] 标题`）：**唯一带子块的块**。
 *
 * 为什么它必须有子块，而不是像引用那样装一段 run：提示框内部可以是一整个子文档
 * （段落、列表、代码块、表格、嵌套提示框），而且**容器要画一个盒子** ——
 * 盒子的高度取决于内部所有块的高度之和。把内部当成 `InlineRun[]` 就得在画笔里
 * 重新实现一遍块级排版，那正是这一层存在的意义。
 */
export interface CalloutBlock {
  kind: 'callout'
  /** 规范化类型（未知类型已回落成 `note`，与 token 里那个 `mn-callout--<type>` 类名逐字一致）。 */
  type: CalloutType
  /**
   * 类型是否是系统认识的。
   *
   * ⚠️ **当前实现里恒为 `true`**，原因见 {@link readCalloutBar} 的取舍说明：核心规则把类型
   * **规范化**后写进类名，`[!摘录]` 与 `[!note]` 在 token 里完全一样，标记原文随之消失 ——
   * "用户当时写的是不是未知类型"已经无从得知。字段保留是为了与编辑器侧的 `LiveCallout`
   * 形状一致（画笔的接口不该因为某条管线拿不到信息而变形）；未知类型在画布上的表现
   * （退化的颜色/字形 + 用户写的名字当标题）与阅读视图**逐像素一致**，信息只丢在诊断字段上。
   */
  known: boolean
  /** 标记用的字形（来自 `CALLOUT_TYPES[type].glyph`；未知类型已回落成 `note` 的）。 */
  glyph: string
  /**
   * 强调色令牌（`CALLOUT_TYPES[type].token`，如 `--mn-callout-note`）。
   * 与 app.css 的 `.mn-callout--note` 同源：颜色表只有那一份，画布不抄第二遍。
   */
  accent: string
  /** 要显示的标题（核心规则已经用 `calloutTitle` 算过：标题为空时退化成类型标签/原始类型名）。 */
  title: string
  /** 折叠标记：`-`、`+`、没写是 `null`。静态渲染不真的收起，它只是标题行末尾的角标。 */
  fold: '-' | '+' | null
  /**
   * 引用栈深度（0 = 顶层）：`> [!x]` 是 0、`> > [!x]` 是 1、提示框里再套一层也是 1。
   *
   * 为什么要带上它：布局要按嵌套层级缩进，而"提示框套在普通引用里"这种情况在块清单上
   * 是**平级**的（`quote` 不装子块），只有令牌流知道它深了几层 —— 所以深度在这里定，
   * 布局只按 `min(depth, calloutMaxDepth)` 缩进（见 `text-layout.ts`）。
   */
  depth: number
  /** 提示框正文：段落 / 列表 / 代码 / 表格 / 嵌套提示框……都是同一套既有块。 */
  children: DrawBlock[]
}

/** 图片块（`DrawBlock` 的一支）。单独取名只是为了让行内切分少写一次 `Extract`。 */
export type ImageBlock = Extract<DrawBlock, { kind: 'image' }>

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * markdown 正文 → 绘制块清单（token 来源见 `domain/markdown-core` 的 `parseMarkdownTokens`）。
 *
 * ⚠️ 调用方应先过 `domain/frontmatter.ts` 的 `frontmatterBody`，否则 yaml 头会被当成正文画出来
 * （一条分隔线加几行 `key: value`）。
 * 这里**不**替调用方做这件事：本函数是"markdown → 块"的纯函数，不该知道笔记文件的格式约定。
 * 图谱这一侧的调用方是 `measure.ts` 的 `layoutCard`（"一篇笔记文件 → 一张卡片"的唯一入口），
 * 它已经在进来之前剥掉了 —— 与本函数保持"纯 markdown"的边界正是那样分工的理由。
 *
 * 不抛异常：任何 token（包括我们不认识的）都只会导致"少画一个块"，不会让整张卡片画不出来
 * （理由见文件末尾 `walkTokens` 的 default 分支）。
 */
export function toDrawBlocks(markdown: string): DrawBlock[] {
  const state: WalkState = { blocks: [], lists: [], quotes: [], item: null }
  walkTokens(parseMarkdownTokens(markdown), state)
  // token 流意外截断时也别把正在累积的列表项丢掉（正常流里它已经被 list_item_close 收走了）
  flushItem(state)
  return state.blocks
}

// ---------------------------------------------------------------------------
// 遍历状态
// ---------------------------------------------------------------------------

/** 一层列表（`*_list_open` … `*_list_close`）。 */
interface ListFrame {
  ordered: boolean
  /** 下一个要发出的序号（有序列表从 `start` 起算）。 */
  next: number
}

/** 正在累积的列表项。 */
interface ItemAccumulator {
  ordered: boolean
  index: number
  depth: number
  runs: InlineRun[]
  /** 已经有过内容：同一项里的第二段要用**强制换行**接上（而不是另起一条带符号的条目）。 */
  hasContent: boolean
  /**
   * 任务列表：`undefined` = 不是任务项。
   *
   * 值来自**上游的结论**（`list_item_open` 上的属性，见下面 `list_item_open` 分支），
   * 而不是在这里自己判一遍 —— 判据只有 `domain/task-list.ts` 那一份。
   */
  checked: boolean | undefined
}

/**
 * 一层引用。提示框**也是引用**（`[!x]` 寄生在引用块上），差别只在它的内容进哪儿：
 * 普通引用的段落各自成一个 `quote` 块，提示框的段落则进它自己的 `children`。
 */
type QuoteFrame =
  | { kind: 'quote' }
  | { kind: 'callout'; block: CalloutBlock }

interface WalkState {
  /** 顶层块清单（最外层那一份输出）。 */
  blocks: DrawBlock[]
  /** 列表栈；栈深 - 1 就是当前 `depth`。 */
  lists: ListFrame[]
  /** 引用栈；提示框的正文往栈里**最近的那个提示框**里收（见 `sinkOf`）。 */
  quotes: QuoteFrame[]
  item: ItemAccumulator | null
}

/** 行内切分的结果：同样的文字，加上"这里其实是一张图"的出口。 */
type InlinePart =
  | { kind: 'runs'; runs: InlineRun[] }
  | { kind: 'image'; block: ImageBlock }

/**
 * 新块该放进哪个容器：栈里最近的**提示框**的正文，没有就放顶层。
 *
 * 为什么要"跳过普通引用往栈里找"：普通引用不装子块，所以 `> [!note] A` 里再嵌一层
 * `> > 引用文字` 时，那段文字在块清单上仍然属于提示框的正文 —— 只按"栈顶"判断的话
 * 它会被扔到顶层，画到盒子外面去。
 */
function sinkOf(state: WalkState): DrawBlock[] {
  for (let index = state.quotes.length - 1; index >= 0; index -= 1) {
    const frame = state.quotes[index]
    if (frame !== undefined && frame.kind === 'callout') return frame.block.children
  }
  return state.blocks
}

/** 产出块（唯一的出口：所有块都经这里落到正确的容器里）。 */
function emit(state: WalkState, block: DrawBlock): void {
  sinkOf(state).push(block)
}

/** 当前还开着几层**普通**引用（`depth` 的口径：0 = 最外层）。 */
function plainQuoteDepth(state: WalkState): number {
  let count = -1
  for (const frame of state.quotes) {
    if (frame.kind === 'quote') count += 1
  }
  return Math.max(0, count)
}

// ---------------------------------------------------------------------------
// 主遍历：token 流是**扁平**的，靠 open/close 配对还原结构
// ---------------------------------------------------------------------------

/**
 * 遍历扁平 token 流，产出块清单。
 *
 * 为什么用"手动下标 + skipToClose"而不是通用递归：markdown-it 的 token 流是一个**带层次编号的一维数组**，
 * 块级 token 靠成对的 open/close 划定范围。我们只关心十来种块，给每种都写一个递归下降解析器
 * 会让"这个 token 归谁管"散落在很多地方；这里保留一个循环 + 两个显式跳转（标题、段落跳到自己的 close），
 * 任何时刻"我在哪一层列表、第几层引用"都在 `state` 里看得见。
 */
function walkTokens(tokens: readonly MarkdownToken[], state: WalkState): void {
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    if (token === undefined) {
      index += 1
      continue
    }

    switch (token.type) {
      case 'heading_open': {
        const level = headingLevel(token.tag)
        const inline = tokens[index + 1]
        if (level !== null && inline !== undefined && inline.type === 'inline') {
          // 标题里几乎不可能有图片；真有时那张图会被丢掉（块类型里没有"标题里的图"这种表达），
          // 这是刻意接受的损失：为它把标题拆成"标题 + 图片 + 标题"会让画布上出现两行同级标题。
          const runs = runsOf(inlineParts(inline.children ?? []))
          emit(state, { kind: 'heading', level, runs })
        }
        index = skipToClose(tokens, index + 1, 'heading_close')
        break
      }

      case 'paragraph_open': {
        // 提示框的标题栏：核心规则把标记那一段的 `inline` 换成了 `html_block`（图标 + 标签 + 角标）。
        // 认它靠的是**同级段落上的类名** `mn-callout__title`（核心规则自己打的），不是猜 HTML。
        const inline = tokens[index + 1]
        if (tokenAttr(token, 'class') === CALLOUT_TITLE_CLASS) {
          if (inline !== undefined) readCalloutBar(state, inline)
          index = skipToClose(tokens, index + 1, 'paragraph_close')
          break
        }
        if (inline !== undefined && inline.type === 'inline') {
          emitParts(state, inlineParts(inline.children ?? []))
        }
        // 这里刻意只认 `inline`：有的核心规则会把段落的 `inline` 换成别的 token
        // （就是上面那条标题栏）。认不出来的那种段落**不画** —— 想把 HTML 变回文字就得解析它，
        // 而"画布直接吃 HTML 字符串"正是这一层要避免的事；已知的唯一一类（提示框标题栏）
        // 就在上面被单独接走了，所以这条 default 不再吞掉可见内容。
        index = skipToClose(tokens, index + 1, 'paragraph_close')
        break
      }

      case 'inline': {
        // 正常流里 `inline` 一定被 `paragraph_open`/`heading_open` 包着（上面两处已消费）。
        // 保留这个兜底分支：万一 token 流的形状变了（比如 markdown-it 或我们的规则改了），
        // 落到这里的文字会被当成一段正文画出来，而不是**整段消失**。
        emitParts(state, inlineParts(token.children ?? []))
        index += 1
        break
      }

      case 'ordered_list_open': {
        const start = tokenAttr(token, 'start')
        const parsed = start === null ? Number.NaN : Number(start)
        state.lists.push({ ordered: true, next: Number.isFinite(parsed) ? parsed : 1 })
        index += 1
        break
      }

      case 'bullet_list_open': {
        state.lists.push({ ordered: false, next: 0 })
        index += 1
        break
      }

      case 'ordered_list_close':
      case 'bullet_list_close': {
        state.lists.pop()
        index += 1
        break
      }

      case 'list_item_open': {
        // ⚠️ 嵌套列表的 token 顺序是"先开内层、后关外层"：
        //     `li_open(外) … ul_open, li_open(内) … li_close(内), ul_close, li_close(外)`
        // 所以这一层开始累积之前，必须把外层正在累积的文字先落地 —— 否则内外层会抢同一个
        // 累积器，父条目的文字会被整个丢掉（表现为"嵌套列表一出现，父条目就消失了"）。
        // 代价是"嵌套列表**之后**又回到父条目的段落"会退化成顶层段落（那时累积器已经收走了），
        // 那种写法（`- a` / `  - b` / 空行 / 再缩进写一段）在真实笔记里极少，
        // 而"父条目整个消失"是绝对不能接受的。
        flushItem(state)
        const frame = state.lists[state.lists.length - 1]
        state.item = {
          ordered: frame?.ordered === true,
          index: frame?.ordered === true ? (frame?.next ?? 1) : 0,
          depth: Math.max(0, state.lists.length - 1),
          runs: [],
          hasContent: false,
          // 任务标记的判据**不在这一层**：`domain/markdown-core.ts` 的 `mn_task_list` 核心规则
          // 已经用 `domain/task-list.ts` 判过，并把结论写在 `list_item_open` 上、把标记从文字里删掉。
          // 这里只读结论 —— 画布这一侧原先自己写的那份判据已经删掉（理由见 `flushItem` 的说明）。
          checked: taskCheckedFromAttr(tokenAttr(token, TASK_CHECKED_ATTR)),
        }
        if (frame !== undefined) frame.next += 1
        index += 1
        break
      }

      case 'list_item_close': {
        flushItem(state)
        state.item = null
        index += 1
        break
      }

      case 'blockquote_open': {
        // 列表项里的提示框：先把条目收尾，否则提示框的盒子会插到项目符号**之前**
        if (state.item !== null) flushItem(state)
        const found = calloutOf(token)
        if (found === null) {
          state.quotes.push({ kind: 'quote' })
          index += 1
          break
        }
        const definition = CALLOUT_TYPES[found.type]
        const block: CalloutBlock = {
          kind: 'callout',
          type: found.type,
          // 用户在笔记里写的类型名系统认不认识，只有上游那个痕迹类名说得清（见 CALLOUT_UNKNOWN_CLASS）
          known: found.known,
          glyph: definition.glyph,
          accent: definition.token,
          // 标题与折叠角标由 `readCalloutBar` 在遇到标题栏时补上（它就在这个引用块里）
          title: '',
          fold: null,
          // 深度取**推入之前**的引用栈长度：`> [!x]` 是 0、`> > [!x]` 与提示框套提示框都是 1
          depth: state.quotes.length,
          children: [],
        }
        emit(state, block)
        state.quotes.push({ kind: 'callout', block })
        index += 1
        break
      }

      case 'blockquote_close': {
        state.quotes.pop()
        index += 1
        break
      }

      case 'fence': {
        emit(state, codeBlock(token.info ?? '', token.content ?? ''))
        index += 1
        break
      }

      case 'code_block': {
        // 缩进式代码块（四个空格）没有 info，但**内容一样要画**：跳过它就等于把用户的代码吞掉，
        // 而"语言标签为空"是画笔本来就支持的（围栏块没写语言时也是空串）。
        emit(state, codeBlock('', token.content ?? ''))
        index += 1
        break
      }

      case 'hr': {
        emit(state, { kind: 'hr' })
        index += 1
        break
      }

      case 'table_open': {
        index = readTable(tokens, index, state)
        break
      }

      default: {
        // 不认识的 token 一律跳过（不抛）。为什么这是安全的：
        // 1. token 流是扁平的，跳过某个 token 不会打乱其它 token 的相对顺序；
        // 2. 我们只对认识的块类型产出块，所以未知块最坏也就是"少画了它那层壳"
        //    （比如将来引入脚注容器），里面的文字仍会在遍历到 `inline`/`paragraph_open` 时被收走；
        // 3. 反过来（遇到未知就抛）的代价极端不成比例：一篇笔记里出现一句插件语法，
        //    整张卡片就画不出来 —— 画布是只读预览，"少画一点"永远好过"整块空白"。
        index += 1
        break
      }
    }
  }
}

/** 跳到某个关闭 token **之后**；找不到就返回流末尾（见下方注释里的取舍）。 */
function skipToClose(tokens: readonly MarkdownToken[], from: number, closeType: string): number {
  for (let index = from; index < tokens.length; index += 1) {
    if (tokens[index]?.type === closeType) return index + 1
  }
  // 成对的 open/close 是 markdown-it 的硬契约，走到这里说明 token 流本身已经坏了。
  // 这时**停止遍历**而不是继续扫描：继续扫会把标题/段落的 inline 再当成一段正文画一遍（重复），
  // 而"重复"比"少画"更难让人看出是解析器的问题。
  return tokens.length
}

// ---------------------------------------------------------------------------
// 块级产出
// ---------------------------------------------------------------------------

/** 把行内切分结果落地成块（区分"在列表项里 / 在引用里 / 在顶层"三种去处）。 */
function emitParts(state: WalkState, parts: readonly InlinePart[]): void {
  for (const part of parts) {
    if (part.kind === 'image') {
      // 图片自己就是一个盒子（画布上要按它的宽高比排放），所以它**断开了**所在的文字流：
      // `前面 ![](图.png) 后面` 会变成"段落 / 图片块 / 段落"三块。
      // 代价是图片前后多一次块间距，换来的是图片不必再发明一种"行内图"的表达 ——
      // 而 canvas 里行内图与块级图的绘制代码本来就不一样（前者要算基线对齐）。
      if (state.item !== null) flushItem(state)
      emit(state, part.block)
      continue
    }
    emitRuns(state, part.runs)
  }
}

/**
 * 一段行内文字的去处：列表项里追加、普通引用里出引用块、提示框正文与顶层出段落块。
 *
 * 判据是**栈顶那一层**，不是"有没有开着的引用"：
 * - 栈顶是提示框 ⇒ 这是提示框正文，出段落块（进它的 `children`）；
 * - 栈顶是普通引用 ⇒ 出引用块（缩进按"当前开了几层普通引用"）；
 * - 没有引用 ⇒ 顶层段落。
 */
function emitRuns(state: WalkState, runs: InlineRun[]): void {
  // 纯空白/空段落不产出块：markdown 里空行随处可见，产出空块就是画布上一道道莫名其妙的缝隙
  if (isBlankRuns(runs)) return

  const item = state.item
  if (item !== null) {
    if (item.hasContent) {
      // 同一列表项里的第二段：用强制换行接上，而不是另起一条带项目符号的条目 ——
      // 少一个符号的重复，缩进也就不用重算。
      item.runs.push({ text: '\n' })
    }
    item.runs.push(...runs)
    item.hasContent = true
    return
  }

  if (state.quotes[state.quotes.length - 1]?.kind === 'quote') {
    emit(state, { kind: 'quote', depth: plainQuoteDepth(state), runs })
    return
  }
  emit(state, { kind: 'paragraph', runs })
}

/**
 * 收尾当前列表项：落地成一个 `list-item` 块，并把它清空（同一个 `list_item_open` 可能对应多个块，
 * 见 `emitParts` 里图片切断条目的那条路径）。
 *
 * 空文字的普通条目**不产出块**（`-` 后面什么都没有的写法在 markdown 里合法但没意义）；
 * 任务项即使文字为空也保留 —— 画布上至少还有一个勾选框可画，扔掉它等于把用户写下的待办删了。
 *
 * ⚠️ `checked` 与 `runs` 一样是"**这一段**的状态"，收尾时必须一起清空：
 * 图片会把条目切断（`- [x] 看图 ![](图.png)` → 任务项 + 图片块），
 * 后一次 `flushItem`（`list_item_close` 触发）若还带着 `checked`，就会凭空多出一个只画勾选框的空条目。
 *
 * ## 这里**曾经**有一份自己的任务标记判据，已经删了
 *
 * 原先这里调 `stripTaskMarker(runs)`：一条 `/^\[([ xX])\](?:\s+|$)/` 加"只看第一个 run、
 * 且它不能是粗体/斜体/代码/链接"。删掉它正是因为被删的那段注释里自己写下的那句话 ——
 * "将来阅读视图接上插件时，两边的判据应当合并成一份"：那个将来到了。核心规则现在用唯一一份判据
 * （`domain/task-list.ts` 的 `parseTaskMarker`）判定任务项，把结论写在 `list_item_open` 的属性上，
 * 并把标记从文字里删掉。于是这一层**不可能**再自己判一次（文字里已经没有 `[ ]` 了，
 * 同一份正则再跑只会得出"这不是任务项"），只能读那份结论。
 *
 * 附带的好处是判据变准了：原先"第一个 run 不能是粗体"只是"标记必须出现在最前面"的近似写法，
 * 现在由上游一句"第一个行内 token 必须是普通文字"直接说清（`- **[x]** 手写` 不是任务项），
 * 靠的是 token 类型，而不是从 run 的样式反推。
 */
function flushItem(state: WalkState): void {
  const item = state.item
  if (item === null) return

  if (item.runs.length > 0 || item.checked !== undefined) {
    emit(state, {
      kind: 'list-item',
      ordered: item.ordered,
      index: item.index,
      depth: item.depth,
      runs: item.runs,
      checked: item.checked,
    })
  }
  item.runs = []
  item.hasContent = false
  item.checked = undefined
}

/** 围栏/缩进代码块。语言标签只取 info 的**第一个词**（` ```ts {1} ` 的语言是 `ts`）。 */
function codeBlock(info: string, content: string): DrawBlock {
  const trimmed = info.trim()
  const language = trimmed === '' ? '' : (trimmed.split(/\s+/)[0] ?? '')
  return { kind: 'code', language, lines: splitCodeLines(content) }
}

/**
 * 代码块内容 → 行数组。
 *
 * `fence` 的 content **总是以换行结尾**（markdown-it 把围栏内的原文原样给出），
 * 那个换行属于"块的结尾"而不是"最后一行是空的" —— 直接 split 会让每个代码块都多画一行空白。
 * 一个真正以空行结尾的代码块（内容里手动多敲一行）在 markdown 里本来就无从区分，取舍是"不少画空白行"。
 */
function splitCodeLines(content: string): string[] {
  const lines = content.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function isBlankRuns(runs: readonly InlineRun[]): boolean {
  let text = ''
  for (const run of runs) text += run.text
  return text.trim() === ''
}

function runsOf(parts: readonly InlinePart[]): InlineRun[] {
  const runs: InlineRun[] = []
  for (const part of parts) {
    if (part.kind === 'runs') runs.push(...part.runs)
  }
  return runs
}

function headingLevel(tag: string): 1 | 2 | 3 | 4 | 5 | 6 | null {
  switch (tag) {
    case 'h1':
      return 1
    case 'h2':
      return 2
    case 'h3':
      return 3
    case 'h4':
      return 4
    case 'h5':
      return 5
    case 'h6':
      return 6
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// 行内
// ---------------------------------------------------------------------------

/**
 * 行内 token 串 → 若干段同样式的 run（以及被切出来的图片块）。
 *
 * 关于**软换行**：`domain/markdown-core.ts` 的 `md` 是 `breaks: false`，也就是同一段里的换行
 * 在渲染时是**一个空格**而不是 `<br>`。画布必须同口径，否则"阅读视图里是一段、卡片上是两行"
 * 会让人以为是两个不同的解析器 —— 所以 `softbreak` 在这里变成一个空格。
 *
 * `hardbreak`（行尾两个空格或反斜杠）则**真的**换行，连阅读视图也是 `<br>`：
 * 这里把它写成 run 文本里的 `\n`，由 `canvas/text-layout.ts` 当成强制换行处理
 * （而不是在这里就切成两个块 —— 那样会多出一次块间距，观感就不"硬"了）。
 */
function inlineParts(children: readonly MarkdownToken[]): InlinePart[] {
  const parts: InlinePart[] = []
  let runs: InlineRun[] = []
  let bold = 0
  let italic = 0
  let strike = 0
  /** 当前所处的链接 `href`；`null` = 不在链接里。 */
  let href: string | null = null

  const flushRuns = (): void => {
    if (runs.length > 0) parts.push({ kind: 'runs', runs })
    runs = []
  }

  const flags = (): InlineRun => {
    const run: InlineRun = { text: '' }
    if (bold > 0) run.bold = true
    if (italic > 0) run.italic = true
    if (strike > 0) run.strikethrough = true
    if (href !== null) {
      run.link = true
      run.href = href
    }
    return run
  }

  const push = (text: string, extra?: Partial<InlineRun>): void => {
    if (text === '') return
    const run: InlineRun = { ...flags(), ...extra, text }
    const last = runs[runs.length - 1]
    // 相邻且同样式 → 合成一条 run：少一次画笔的状态切换，也让"这段是粗体"在清单里唯一
    if (last !== undefined && sameRunStyle(last, run)) {
      last.text += text
      return
    }
    runs.push(run)
  }

  for (const token of children) {
    switch (token.type) {
      case 'text': {
        push(token.content)
        break
      }
      case 'softbreak': {
        push(' ')
        break
      }
      case 'hardbreak': {
        push('\n')
        break
      }
      case 'code_inline': {
        // 行内代码的**内容**不需要反转义（markdown-it 已经给出原文）；
        // `code` 与继承来的 bold/italic 同时保留，与阅读视图里 `<strong><code>` 的嵌套一致
        push(token.content, { code: true })
        break
      }
      case 'strong_open': {
        bold += 1
        break
      }
      case 'strong_close': {
        bold = Math.max(0, bold - 1)
        break
      }
      case 'em_open': {
        italic += 1
        break
      }
      case 'em_close': {
        italic = Math.max(0, italic - 1)
        break
      }
      case 's_open': {
        strike += 1
        break
      }
      case 's_close': {
        strike = Math.max(0, strike - 1)
        break
      }
      case 'link_open': {
        href = tokenAttr(token, 'href') ?? ''
        break
      }
      case 'link_close': {
        href = null
        break
      }
      case 'image': {
        flushRuns()
        parts.push({ kind: 'image', block: imageBlock(token) })
        break
      }
      case 'html_inline': {
        // 只有我们自己加的行内规则会产出 `html_inline`（`html: false` 把关掉了原始 HTML），
        // 所以这里只认我们**自己产出的那两种 wikilink 形状**，认不出来就跳过：
        // 把一段 HTML 源码当文字画到卡片上，比少画一个链接难看得多。
        const wiki = parseWikilink(token.content)
        if (wiki !== null) {
          const flags: Partial<InlineRun> = { wikilink: true, link: true }
          if (wiki.target !== null) flags.href = wiki.target
          push(wiki.text, flags)
        }
        break
      }
      default: {
        // 其它行内 token（`linkify`、将来的插件等）跳过：它们没有可画的文字，
        // 而它们包裹的文字会以 `text` 子 token 的身份在别的分支里被收集。
        break
      }
    }
  }

  flushRuns()
  return parts
}

function imageBlock(token: MarkdownToken): ImageBlock {
  return {
    kind: 'image',
    // `content` 是 markdown-it 归一的 alt（`![[图.png|别名]]` 的别名、`![](…)` 的方括号文字都在这）
    alt: token.content,
    // `src` 原样取 token 上的值，**不做解码**：这与阅读视图的 `attrGet('src')` 是同一条路径
    // （markdown-it 会把 `![](图.png)` 里的非 ASCII 百分号编码成 `%E5%9B%BE.png`，
    // 而宿主的 `resolveVaultAssetRel` 本来就会先 `safeDecode` 再解析）。两边一旦各解一次码，
    // 卡片上的图片与正文里的图片就可能解析到不同文件。
    src: tokenAttr(token, 'src') ?? '',
    // 尺寸标记只来自我们自己的嵌入规则（`![[图.png|300x200]]`），`![](…)` 没有这两个属性；
    // 用 `numericAttr` 而不是 `Number()`：它和渲染层是同一份"正整数且 ≤4000"的口径
    width: numericAttr(tokenAttr(token, 'data-mn-width')),
    height: numericAttr(tokenAttr(token, 'data-mn-height')),
  }
}

/** 两条 run 的样式是否完全一致（决定能不能合并；`href` 不同就不是同一种链接）。 */
export function sameRunStyle(left: InlineRun, right: InlineRun): boolean {
  return (
    left.bold === right.bold &&
    left.italic === right.italic &&
    left.code === right.code &&
    left.strikethrough === right.strikethrough &&
    left.link === right.link &&
    left.wikilink === right.wikilink &&
    left.href === right.href
  )
}

// ---------------------------------------------------------------------------
// wikilink：与我们自己产出的 HTML 形状耦合的一小段解析
// ---------------------------------------------------------------------------

/**
 * 从 `html_inline` 的内容里取回 wikilink 的**显示文本**与目标。
 *
 * ⚠️ **这是一处刻意选择的字符串耦合**。`domain/markdown-core.ts` 的 `wikilinkAnchorHtml` 产出的是
 * HTML 字符串，而 canvas 要的是文字本身 —— 中间没有 DOM 可以借。可行的做法只有两种：
 * 1. 起一个 `DOMParser` 去解（昂贵、且在 Worker 里不可用，而这条链路将来可能搬进 Worker）；
 * 2. 针对**我们自己产出的那两种形状**做窄匹配（就是这里）。
 *
 * 选 2，并且把耦合写死在下面三条正则里。形状一共三种（都出自 `wikilinkAnchorHtml`）：
 *
 * ```
 * <a class="mn-wikilink" href="#mn-wikilink" data-target="…" data-anchor="…">文本</a>
 * <a class="mn-wikilink" …>…<span class="mn-wikilink__embed" title="…">文本</span></a>   ← ![[非图片]]
 * <span class="mn-wikilink mn-wikilink--dangling" …>文本</span>                      ← 悬空（仅整库导出）
 * ```
 *
 * 属性值里不可能出现裸 `>`：一切都过 `escapeHtml`（`>` → `&gt;`），所以 `[^>]*` 是安全的。
 * **将来那条规则改了形状，这里必须跟着改** —— `tests/graph-blocks.test.ts` 里钉着这三种形状，
 * 形状一变测试立刻红，而不是等用户发现"卡片上的双链少了一段字"。
 */
function parseWikilink(html: string): { text: string; target: string | null } | null {
  const element = WIKILINK_ELEMENT.exec(html)
  if (element === null) return null

  const inner = element[2] ?? ''
  const embed = EMBED_INNER.exec(inner)
  const text = unescapeHtml(embed === null ? inner : (embed[1] ?? ''))
  const href = HREF_ATTR.exec(element[0])
  // wikilink 的 `href` 恒为文内锚点 `#mn-wikilink`，对诊断毫无信息量；
  // 真正"指向哪"写在 `data-target` 上，所以 href 这一栏留给它（没有 `data-target` 时才退回 href）
  const target = DATA_TARGET_ATTR.exec(element[0])
  return { text, target: target?.[1] ?? href?.[1] ?? null }
}

/** 外层元素：`class` 里含 `mn-wikilink`（含 `--dangling`/`--unresolved` 这些修饰类）。 */
const WIKILINK_ELEMENT =
  /^<(a|span)\b[^>]*\bclass="[^"]*\bmn-wikilink\b[^"]*"[^>]*>([\s\S]*)<\/\1>$/

/** 嵌入非图片时包里那一层 `<span class="mn-wikilink__embed">`（`title` 是说明，不是文字）。 */
const EMBED_INNER =
  /^<span\b[^>]*\bclass="[^"]*\bmn-wikilink__embed\b[^"]*"[^>]*>([\s\S]*)<\/span>$/

const HREF_ATTR = /\bhref="([^"]*)"/
const DATA_TARGET_ATTR = /\bdata-target="([^"]*)"/

/** 反转义 `escapeHtml`（`domain/markdown-core.ts`）写进去的那五个实体。 */
function unescapeHtml(input: string): string {
  return input
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    // `&amp;` 必须**最后**替：先替它会把 `&amp;lt;` 变成 `<`
    .replaceAll('&amp;', '&')
}

// ---------------------------------------------------------------------------
// 提示框（callout）
// ---------------------------------------------------------------------------

/**
 * 核心规则写在 token 上的两个类名（见 `domain/markdown-core.ts` 的 `mn_callout`）：
 * 引用块上有 `mn-callout--<type>`，标题栏那一段的段落上有 `mn-callout__title`。
 *
 * ⚠️ 与渲染层 HTML 的**第二处刻意耦合**（第一处是 `parseWikilink`）。同一条纪律：
 * 形状变了测试立刻红（`tests/graph-blocks.test.ts` 的"提示框"一组），而不是等用户发现
 * "画布上的提示框没颜色/少一段字"。要改形状的人应当同时改这里。
 */
const CALLOUT_CLASS_PREFIX = 'mn-callout--'
const CALLOUT_TITLE_CLASS = 'mn-callout__title'

/**
 * "用户写的类型名系统不认识"的标记类名（核心规则在类型被规范化之后补上的痕迹）。
 *
 * 为什么需要它：`[!摘录]` 与 `[!note]` 在 token 里逐字相同（类名都是 `mn-callout--note`，
 * 标记原文已经被换成标题栏 HTML），所以"是不是未知类型"在渲染流里**不可判定**。
 * 与其用启发式去猜（"标题看起来像类型名"会把 `> [!note] 我的笔记` 误判成未知类型），
 * 不如让上游多写一个类名 —— 判据仍然只有 `parseCallout` 一份。
 */
const CALLOUT_UNKNOWN_CLASS = 'unknown'

/**
 * 类名里那个类型名是不是 `CALLOUT_TYPES` 里的一种。
 *
 * 为什么用 `hasOwnProperty` 而不是 `value in CALLOUT_TYPES`：`in` 会把 `constructor`、
 * `toString` 这类原型上的名字也判成真，而它们来自一个**用户写在笔记里**的类型名（类名是它派生的）。
 * 为什么不用 `as CalloutType`：那只是把校验藏起来 —— 真正的校验必须发生在运行时。
 */
function isCalloutType(value: string): value is CalloutType {
  return Object.prototype.hasOwnProperty.call(CALLOUT_TYPES, value)
}

/**
 * 这个引用块是不是提示框；是就给出**规范化后的类型**与"用户写的类型是不是系统认识的"。
 *
 * 判据就是核心规则写下的类名 —— 也就是说"哪种写法算提示框"依然只有 `parseCallout` 一份判据，
 * 画布只是读它的结论（理由见文件顶部）。
 */
function calloutOf(token: MarkdownToken): { type: CalloutType; known: boolean } | null {
  let type: CalloutType | null = null
  let known = true
  for (const name of (tokenAttr(token, 'class') ?? '').split(/\s+/)) {
    if (!name.startsWith(CALLOUT_CLASS_PREFIX)) continue
    const suffix = name.slice(CALLOUT_CLASS_PREFIX.length)
    // `mn-callout--unknown` 是"未知类型"的痕迹，不是一种类型：先记下它，继续找真正的类型名
    if (suffix === CALLOUT_UNKNOWN_CLASS) {
      known = false
      continue
    }
    if (type !== null) continue
    // 认不出来的类型名（比如将来类名格式换了）按回落类型渲染：颜色/字形差一点是小事，
    // 把提示框整块画成普通引用才是大事
    type = isCalloutType(suffix) ? suffix : FALLBACK_CALLOUT_TYPE
  }
  return type === null ? null : { type, known }
}

/**
 * 把标题栏里的两件事补回**正在打开的那个提示框**：显示标题、折叠角标。
 *
 * ## 能恢复什么、恢复不了什么（这是本层唯一一处信息损失，写清楚免得后人以为是 bug）
 *
 * 核心规则改写了标记那一段：`inline` 令牌被换成 `html_block`，内容是它用 `parseCallout`
 * 的结果现拼的标题栏：
 *
 * ```
 * <span class="mn-callout__icon" aria-hidden="true">★</span>
 * <span class="mn-callout__label">标题</span>
 * <span class="mn-callout__fold" aria-hidden="true">-</span>          ← 只有写了折叠符才有
 * ```
 *
 * 于是：
 * - **能恢复**：规范化类型（类名）、显示标题（`calloutTitle` 的输出，**标题为空时已经被它
 *   退化成了类型标签或用户写的原始类型名** —— 所以画出来的字与阅读视图逐字一致）、折叠角标；
 * - **恢复不了**：用户写的原始类型名与"它是不是未知类型"。类名里只有**规范化后**的类型
 *   （`[!摘录]` 与 `[!note]` 都是 `mn-callout--note`），标记原文已经不存在了 ——
 *   `parseCallout` 想再跑一次也没有输入。所以 `CalloutBlock.known` 只能是 `true`。
 *
 * 想补上这一条，正确做法是让核心规则顺手留一个痕迹（`open.attrSet('data-mn-callout-type', marker.rawType)`
 * 一行即可），画布这边跟着读；**不要**在这里用启发式去猜（"标题看起来像类型名"会把
 * `> [!note] 我的笔记` 误判成未知类型，那比少一个诊断字段糟得多）。
 */
function readCalloutBar(state: WalkState, bar: MarkdownToken): void {
  const frame = state.quotes[state.quotes.length - 1]
  if (frame === undefined || frame.kind !== 'callout') return

  const label = calloutLabelText(bar.content)
  // 认不出标签就退化成类型展示名：空的标题行会让整个容器看起来像画坏了
  frame.block.title = label === '' ? CALLOUT_TYPES[frame.block.type].label : label
  frame.block.fold = calloutFoldText(bar.content)
}

/** 标题栏里的显示文字（`calloutTitle` 已经算好的那串）。 */
function calloutLabelText(html: string): string {
  const match = CALLOUT_LABEL.exec(html)
  return match === null ? '' : unescapeHtml(match[1] ?? '')
}

/** 折叠角标：只有 `-` / `+` 才算数（别的字符一律当没写）。 */
function calloutFoldText(html: string): '-' | '+' | null {
  const value = CALLOUT_FOLD.exec(html)?.[1]
  return value === '-' || value === '+' ? value : null
}

/** 标题栏里的标签：`<span class="mn-callout__label">…</span>`（内容已过 `escapeHtml`）。 */
const CALLOUT_LABEL = /<span class="mn-callout__label">([\s\S]*?)<\/span>/

/** 折叠角标：`<span class="mn-callout__fold" aria-hidden="true">-</span>`。 */
const CALLOUT_FOLD = /<span class="mn-callout__fold"[^>]*>([\s\S]*?)<\/span>/

// ---------------------------------------------------------------------------
// 表格
// ---------------------------------------------------------------------------

/**
 * 读一张 GFM 表：表头行、数据行、每列对齐。
 *
 * 为什么单元格是**纯文本**（`string[][]`）而不是 run 数组：卡片上的表格本来就窄，
 * 每格再逐段排版内联样式收益极小，而真正要算的是"整表宽度预算"（列宽怎么分、每格折几行）。
 * 单元格里的行内样式会在这里被拍平（`**粗**` → `粗`），链接只留下文字 —— 表格里点不动的东西
 * 画成链接只会误导。这条降级写在类型里，画笔与测试都看得见，不存在"悄悄丢了什么"。
 */
function readTable(tokens: readonly MarkdownToken[], start: number, state: WalkState): number {
  const header: string[][] = []
  const rows: string[][] = []
  let aligns: TableAlign[] = []
  let inHead = false

  let index = start + 1
  while (index < tokens.length) {
    const token = tokens[index]
    if (token === undefined) break
    if (token.type === 'table_close') {
      index += 1
      break
    }
    if (token.type === 'thead_open') inHead = true
    if (token.type === 'thead_close') inHead = false

    if (token.type === 'tr_open') {
      const cells: string[] = []
      const rowAligns: TableAlign[] = []
      index += 1
      while (index < tokens.length) {
        const cell = tokens[index]
        if (cell === undefined || cell.type === 'tr_close') break
        if (cell.type === 'th_open' || cell.type === 'td_open') {
          const inline = tokens[index + 1]
          cells.push(inline !== undefined && inline.type === 'inline' ? cellText(inline) : '')
          rowAligns.push(cellAlign(cell))
          const closeType = cell.type === 'th_open' ? 'th_close' : 'td_close'
          index += 1
          while (index < tokens.length && tokens[index]?.type !== closeType) index += 1
          index += 1
          continue
        }
        index += 1
      }
      // `tr_close`（或流末尾）：这一行到此为止
      index += 1
      if (inHead) {
        header.push(cells)
        // 对齐只在表头行上标（GFM 的口径），后面的数据行沿用同一列的对齐
        if (aligns.length === 0) aligns = rowAligns
      } else {
        rows.push(cells)
      }
      continue
    }

    index += 1
  }

  emit(state, { kind: 'table', header, rows, aligns })
  return index
}
/** 单元格文本：只保留"读得出来"的部分，样式与链接丢掉（见 `readTable` 的取舍）。 */
function cellText(inline: MarkdownToken): string {
  let text = ''
  for (const child of inline.children ?? []) {
    switch (child.type) {
      case 'text':
      case 'code_inline': {
        text += child.content
        break
      }
      case 'softbreak':
      case 'hardbreak': {
        text += ' '
        break
      }
      case 'image': {
        // 图片在单元格里退化成它的 alt：画布上没法在格子里放图，但"这里本来有张图"要看得出来
        text += child.content
        break
      }
      case 'html_inline': {
        const wiki = parseWikilink(child.content)
        if (wiki !== null) text += wiki.text
        break
      }
      default:
        break
    }
  }
  return text.trim()
}

/** `style="text-align:center"` → `'center'`；没有对齐标记时 markdown-it 连 style 都不写 ⇒ 左对齐。 */
function cellAlign(token: MarkdownToken): TableAlign {
  const style = tokenAttr(token, 'style') ?? ''
  if (style.includes('center')) return 'center'
  if (style.includes('right')) return 'right'
  return 'left'
}

// ---------------------------------------------------------------------------
// 属性读取
// ---------------------------------------------------------------------------

/**
 * 读 token 上的属性。
 *
 * 为什么不直接用 `token.attrGet`：`domain/markdown-core.ts` 的 `MarkdownToken` 把 `attrGet` 声明成
 * `(name) => string | null`，但 markdown-it 对 `ordered_list_open` 的 `start` 返回的是**数字** `3`
 * （见它的 `attrGet` 实现），`th/td` 的 `style` 才是字符串。照着类型写会在运行时拿到 3，
 * 而 `String(3)` 与"真的字符串 '3'"在我们这里的用法一样 —— 但**类型在骗人**这件事必须留个记录：
 * 任何一次"照着类型写"的改动都可能在这里踩空，所以这里显式按 `unknown` 处理。
 */
function tokenAttr(token: MarkdownToken, name: string): string | null {
  for (const entry of token.attrs ?? []) {
    if (entry[0] !== name) continue
    const value: unknown = entry[1]
    return typeof value === 'string' ? value : String(value)
  }
  return null
}
