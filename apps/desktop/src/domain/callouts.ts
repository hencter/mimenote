/**
 * Obsidian 风格的 **callout**（`> [!note] 标题`）——**唯一的一份解析**。
 *
 * 历史背景：Obsidian 从 1.0 起把它从第三方插件收进核心语法，写法是在引用块的第一行放一个
 * `[!type]` 标记：
 *
 * ```
 * > [!note] 标题（可省略）
 * > 正文，**行内语法照常**。
 * > > 嵌套引用
 * ```
 *
 * 折叠标记跟在类型后面：`[!note]-` 默认收起、`[!note]+` 默认展开（与"可折叠 callout"的
 * 直觉一致：`-` 是折叠、`+` 是展开）。类型**大小写不敏感**，别名表见下。
 *
 * ## 为什么解析只做"一行"，不在这里判整个引用块
 *
 * 这条语法**寄生在引用块上**：`[!note]` 只在"引用块的第一行、且该行以它开头"时才是 callout，
 * 正文里随便一句 `> 我觉得 [!note] 挺好` 不是。判断"是不是第一行"需要知道块的边界 ——
 * 那是 markdown-it 的 blockquote 令牌已经算好的东西。所以这里只回答一个纯问题：
 * **"给定引用块首行的内容，它是不是 callout 起始行？是哪种、标题是什么？"**
 * 三个渲染管线（HTML 阅读视图 / 所见即所得装饰 / canvas 绘制清单）各自用自己手上的令牌
 * 问同一个函数，于是"哪种写法算 callout"只有一份判据。
 *
 * ## 为什么用图标名而不是 emoji
 *
 * 图标走本应用既有的 `Icon` 组件（24 个内联 SVG），好处是**跟随主题色**、在导出件里也不用带
 * 字体；emoji 在 Windows/导出件的字体里表现不一，而且会在纯文本里被当成内容。
 * canvas 那边只需要拿到一个"字形 + 颜色"（见 {@link CALLOUT_TYPES} 的 `glyph`）。
 */

/** 已知的 callout 类型（Obsidian 的名字 + 常见别名）。 */
export type CalloutType =
  | 'note'
  | 'abstract'
  | 'info'
  | 'todo'
  | 'tip'
  | 'success'
  | 'question'
  | 'warning'
  | 'failure'
  | 'danger'
  | 'bug'
  | 'example'
  | 'quote'

export interface CalloutDefinition {
  /** 展示名（标题为空时用）。 */
  label: string
  /** `Icon` 组件里的名字（阅读视图用）。 */
  icon: string
  /**
   * canvas 上用的字形（一条绘制路径画不出来时用字；都在常见字体里有，且不依赖 emoji 字体）。
   */
  glyph: string
  /** 强调色：走主题令牌，缺失时由 CSS 里的回落值兜底（导出件与 canvas 各自读一次）。 */
  token: string
  /** 别名（小写）：`[!hint]` 与 `[!tip]` 是同一种。 */
  aliases: readonly string[]
}

/**
 * 类型表。
 *
 * 覆盖 Obsidian 核心的那 13 种（含 `hint`/`important`/`caution`/`error`/`fail`/`done`/`faq` 等常用别名）。
 * **未知类型不当错误**：Obsidian 的插件生态会带来任意类型名，用户也可能手写 `[!摘录]` ——
 * 那种情况按 `note` 的样式渲染、但**保留用户写的类型名作为默认标题**，这样他至少能看出
 * "系统不认识这个词"，而不是被静默改成 `note`。
 */
export const CALLOUT_TYPES: Readonly<Record<CalloutType, CalloutDefinition>> = {
  note: {
    label: '笔记',
    icon: 'file',
    glyph: '✎',
    token: '--mn-callout-note',
    aliases: ['note'],
  },
  abstract: {
    label: '摘要',
    icon: 'outline',
    glyph: '≡',
    token: '--mn-callout-abstract',
    aliases: ['abstract', 'summary', 'tldr'],
  },
  info: {
    label: '信息',
    icon: 'info',
    glyph: 'i',
    token: '--mn-callout-info',
    aliases: ['info'],
  },
  todo: {
    label: '待办',
    icon: 'check',
    glyph: '☑',
    token: '--mn-callout-todo',
    aliases: ['todo'],
  },
  tip: {
    label: '提示',
    icon: 'sparkle',
    glyph: '★',
    token: '--mn-callout-tip',
    aliases: ['tip', 'hint', 'important'],
  },
  success: {
    label: '成功',
    icon: 'check',
    glyph: '✓',
    token: '--mn-callout-success',
    aliases: ['success', 'check', 'done'],
  },
  question: {
    label: '问题',
    icon: 'info',
    glyph: '?',
    token: '--mn-callout-question',
    aliases: ['question', 'help', 'faq'],
  },
  warning: {
    label: '警告',
    icon: 'alert',
    glyph: '!',
    token: '--mn-callout-warning',
    aliases: ['warning', 'caution', 'attention'],
  },
  failure: {
    label: '失败',
    icon: 'x',
    glyph: '✗',
    token: '--mn-callout-failure',
    aliases: ['failure', 'fail', 'missing'],
  },
  danger: {
    label: '危险',
    icon: 'alert',
    glyph: '‼',
    token: '--mn-callout-danger',
    aliases: ['danger', 'error'],
  },
  bug: {
    label: '缺陷',
    icon: 'alert',
    glyph: '⌘',
    token: '--mn-callout-bug',
    aliases: ['bug'],
  },
  example: {
    label: '示例',
    icon: 'type',
    glyph: '❯',
    token: '--mn-callout-example',
    aliases: ['example'],
  },
  quote: {
    label: '引用',
    icon: 'links',
    glyph: '❝',
    token: '--mn-callout-quote',
    aliases: ['quote', 'cite'],
  },
}

/** 别名 → 类型 的查表（小写键）。未知类型返回 `null`。 */
const BY_ALIAS: ReadonlyMap<string, CalloutType> = new Map(
  (Object.keys(CALLOUT_TYPES) as CalloutType[]).flatMap((type) =>
    CALLOUT_TYPES[type].aliases.map((alias) => [alias.toLowerCase(), type] as const),
  ),
)

/** 未知类型回落用的样式类型。 */
export const FALLBACK_CALLOUT_TYPE: CalloutType = 'note'

export interface Callout {
  /** 规范化后的类型（未知类型回落成 `note`，但 `rawType` 保留用户写的那一个）。 */
  type: CalloutType
  /** 用户写的类型名（原样，小写化之前的值）。 */
  rawType: string
  /** 类型是否是系统认识的（未知类型仍然渲染，但标题默认用 `rawType`）。 */
  known: boolean
  /** 标题（`[!note] 标题` 里那一段，去掉了标记与折叠符号；没有则空串）。 */
  title: string
  /**
   * 标记行**之后**的内容（可能多行），还没有渲染。
   *
   * 为什么需要它：CommonMark 里 `> [!note] 标题` 与 `> 正文` 是**同一个段落** ——
   * 两行之间只有软换行（不是新段落），所以 markdown-it 交给我们的是一个 inline 令牌，
   * 内容是 `"[!note] 标题\n正文"`。标题与正文的分界线因此只能在这里切：
   * 第一行是标记 + 标题，其余是正文（Obsidian 的行为也是这样）。
   */
  body: string
  /** 折叠标记：`-` 收起、`+` 展开、`null` 没写。 */
  fold: '-' | '+' | null
}

/**
 * 引用块首段的内容（**可能含换行**）是不是 callout 起始行。
 *
 * 判据刻意"窄"：必须是 `[!` 开头、`]` 结束标记紧跟其一 —— 否则 `> [note] 不是 callout`
 * 这类写法会被误判，而用户写方括号在引用里是很常见的。
 *
 * 关于换行：调用方传进来的通常是**整段**（`"[!note] 标题\n正文"`），因为 CommonMark 里
 * 相邻两行引用属于同一个段落。这里按**第一个换行**切成"标记行"与"正文"，
 * 只有第一行参与类型与标题的解析 —— 正文里再出现 `[!…]` 不算标记。
 */
export function parseCallout(text: string): Callout | null {
  const newline = text.indexOf('\n')
  const firstLine = (newline < 0 ? text : text.slice(0, newline)).trim()
  const body = newline < 0 ? '' : text.slice(newline + 1).trim()

  if (!firstLine.startsWith('[!')) return null
  const close = firstLine.indexOf(']')
  if (close < 0) return null
  const rawType = firstLine.slice(2, close).trim()
  if (rawType === '' || rawType.includes('[')) return null

  let rest = firstLine.slice(close + 1)
  let fold: '-' | '+' | null = null
  if (rest.startsWith('-') || rest.startsWith('+')) {
    fold = rest.startsWith('-') ? '-' : '+'
    rest = rest.slice(1)
  }

  const type = BY_ALIAS.get(rawType.toLowerCase()) ?? null
  return {
    type: type ?? FALLBACK_CALLOUT_TYPE,
    rawType,
    known: type !== null,
    // 整行都算标题（不切出"正文"）：Obsidian 就是这个行为 —— 要写正文就换行。
    // 少一个"哪里算标题结束"的猜测，用户也就少一次意外。
    title: rest.trim(),
    body,
    fold,
  }
}

/** 标题为空时显示什么：已知类型用展示名，未知类型用**用户写的类型名**（让他看出系统不认识它）。 */
export function calloutTitle(callout: Callout): string {
  if (callout.title !== '') return callout.title
  return callout.known ? CALLOUT_TYPES[callout.type].label : callout.rawType
}
