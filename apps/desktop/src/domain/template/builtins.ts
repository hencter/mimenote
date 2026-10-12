/**
 * `@` 记号的**内建变量表**与求值上下文类型（设计 02 §2/§3，ADR-0056）。
 *
 * ## 为什么表在 domain、而不是散在界面里
 * "有哪些记号、各自要不要参数、不带参数时展开成什么"这三件事同时被**四个**消费者需要：
 * 扫描器（判"这个名字算不算记号"）、展开器（求值）、编辑器补全（列候选）、模板对话框
 * （提示怎么用）。任何一处自己写一份，就会出现"补全列表里有 `@date`、展开器却不认识它"
 * 这类两个真相的错位 —— 所以表只有这一份，其余全是它的视图。
 *
 * ## 参数为什么分三种
 * 设计 02 §2 的 BNF 允许所有记号带 `=参数`，但参数的**语义**按记号分三类：
 *
 * | 种类 | 记号 | 参数是什么 |
 * | --- | --- | --- |
 * | `pattern` | `today` / `now` / `date` / `time` | 模式串（§4 的 11 个记号） |
 * | `label` | `prompt` | 输入框的标题（`@prompt=标题` → 对话框叫"标题"） |
 * | `none` | 其余 | 无参数。带上了也不报错 —— **一律忽略**，见下 |
 *
 * 为什么 `none` 类带了参数不报错、也不原样保留：§1 第 2 条"绝不静默吞掉用户输入"
 * 说的是**名字**（未知名字原样保留，因为它可能只是邮箱/用户名）。`@title=甲` 里的
 * `=甲` 只有一种解释（用户以为 title 能带参数），此时"展开成标题、顺手把参数丢掉"
 * 比"整条原样保留"更接近用户意图，也不会在正文里留下一段看起来像语法垃圾的东西。
 */

/** 内建记号名（**小写**，唯一键；匹配一律大小写不敏感）。 */
export type TemplateBuiltinName =
  | 'today'
  | 'now'
  | 'date'
  | 'time'
  | 'title'
  | 'filename'
  | 'path'
  | 'vault'
  | 'cursor'
  | 'uuid'
  | 'clipboard'
  | 'prompt'

/** 参数的种类（见文件头那张表）。 */
export type TemplateArgumentKind = 'pattern' | 'label' | 'none'

/** 内建变量表里的一项。 */
export interface TemplateBuiltin {
  /** 规范名（小写）。 */
  name: TemplateBuiltinName
  argument: TemplateArgumentKind
  /**
   * 不带参数时的模式串（仅 `pattern` 类有；其余为 `null`）。
   *
   * 默认值写在表里而不是展开器的 `switch` 里：设计 02 §4 末尾那句"默认 `@today` =
   * `YYYY-MM-DD`"是**表的属性**，写在求值分支里就成了第二个真相源。
   */
  defaultPattern: string | null
  /**
   * 候选列表/设置页里的一句话说明。
   *
   * 为什么说明与表同源：用户不必记名字，靠的就是这一句话；把它放进界面模块，
   * 就又出现"表里加了记号、补全列表里没有说明"的空档。
   */
  summary: string
}

/**
 * v1 的内建变量全集（设计 02 §3 的表格，顺序即候选列表顺序）。
 *
 * 顺序刻意是"最常用 → 最少用"：`today` / `now` 是模板里出现频率压倒性最高的两个，
 * 它们排在最前面，用户敲下 `@` 再按回车就能拿到。
 */
export const TEMPLATE_BUILTINS: readonly TemplateBuiltin[] = [
  { name: 'today', argument: 'pattern', defaultPattern: 'YYYY-MM-DD', summary: '今天的日期' },
  {
    name: 'now',
    argument: 'pattern',
    defaultPattern: 'YYYY-MM-DD HH:mm',
    summary: '当前日期与时间',
  },
  { name: 'date', argument: 'pattern', defaultPattern: 'YYYY-MM-DD', summary: '同 today（更好读的别名）' },
  { name: 'time', argument: 'pattern', defaultPattern: 'HH:mm', summary: '当前时间' },
  { name: 'title', argument: 'none', defaultPattern: null, summary: '这篇笔记的标题（不含扩展名）' },
  { name: 'filename', argument: 'none', defaultPattern: null, summary: '这篇笔记的真实文件名（含扩展名）' },
  { name: 'path', argument: 'none', defaultPattern: null, summary: '这篇笔记在 Vault 里的相对路径' },
  { name: 'vault', argument: 'none', defaultPattern: null, summary: 'Vault 目录名' },
  { name: 'cursor', argument: 'none', defaultPattern: null, summary: '光标落点（模板里最多一个）' },
  { name: 'uuid', argument: 'none', defaultPattern: null, summary: '随机 UUID（v4）' },
  { name: 'clipboard', argument: 'none', defaultPattern: null, summary: '当前剪贴板里的纯文本' },
  { name: 'prompt', argument: 'label', defaultPattern: null, summary: '创建时弹一次输入框' },
]

/** 按规范名建的表（`TEMPLATE_BUILTINS` 的派生视图，避免每次查表都线性扫描）。 */
const BY_NAME: ReadonlyMap<string, TemplateBuiltin> = new Map(
  TEMPLATE_BUILTINS.map((builtin) => [builtin.name, builtin]),
)

/**
 * 查一个名字对应的内建变量（**大小写不敏感**，设计 02 §2）。
 *
 * 未知名字返回 `undefined` —— 调用方据此把 `@foo` 原样保留（§6），而不是报错：
 * 它很可能只是一个邮箱或用户名。
 */
export function templateBuiltin(name: string): TemplateBuiltin | undefined {
  return BY_NAME.get(name.toLowerCase())
}

/** 名字是不是内建变量（判据只有 {@link templateBuiltin} 这一处）。 */
export function isTemplateBuiltin(name: string): boolean {
  return templateBuiltin(name) !== undefined
}

/**
 * 求值**快照**：一次展开里所有"已经同步知道"的值。
 *
 * 为什么把时间做成快照里的字段，而不是在求值时现调 `new Date()`：一篇模板里可以出现
 * 好几个 `@today` / `@now`，逐个现取会在跨秒（甚至跨日）的那一刻让同一篇笔记里的两个
 * `@now` 不一致 —— 那种"同一篇笔记里时间对不上"的 bug 极难复现也极难解释。
 * 快照在创建笔记的**那一刻**取一次，之后整篇共用。
 */
export interface TemplateSnapshot {
  now: Date
  /**
   * 这篇笔记的标题（不含扩展名）。
   *
   * ⚠️ 必须由调用方按 `domain/paths.displayName`（ADR-0030）的口径算好再传进来 ——
   * 展开器不碰路径字符串，否则"显示名怎么算"就会有第二份实现（`displayName` 的注释里
   * 明确说了调用方不要自己 `replace(/\.md$/)`）。
   */
  title: string
  /** 真实文件名（**含**扩展名）。 */
  filename: string
  /** Vault 内相对路径（POSIX `/`）。 */
  path: string
  /** Vault 目录名。 */
  vault: string
}

/**
 * 完整求值上下文 = 快照 + 两个"问出来才有的值"。
 *
 * `clipboard` 与 `prompt` 的结果都由调用方在展开**之前**备好：
 *
 * - `@prompt` 的答案必须先收集齐（设计 02 §3"创建时弹一次输入框"，Lead 定的接线纪律：
 *   先收集全部 prompt、再一次性展开）—— 于是展开是**同步纯函数**，没有"展开到一半弹个框"
 *   这种能打断流程的分支；
 * - 剪贴板同理：读一次、整篇共用，拿不到就是 `null`（§6：空串 + 非阻断提示）。
 */
export interface TemplateValues extends TemplateSnapshot {
  /** 剪贴板纯文本；拿不到（权限被拒/非安全上下文/本来就是空）时为 `null`。 */
  clipboard: string | null
  /** `@prompt` 的答案（键是参数里的标签；缺省 = 用户没填，展开成空串）。 */
  prompt: (label: string) => string
  /**
   * v4 UUID 生成器。
   *
   * 可注入是**为测试**：`@uuid` 的值每次都不同，没有注入就只能断言"是 36 位"。
   * 生产路径不传，展开器用 `crypto.randomUUID`（见 `expand.ts` 的 `randomUuidV4`）。
   */
  uuid?: () => string
}
