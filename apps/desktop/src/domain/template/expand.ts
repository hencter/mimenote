/**
 * 模板展开：把一段模板原文变成**纯文本**（设计 02 §3/§4，ADR-0056）。
 *
 * ## 三条纪律
 * 1. **一律纯文本替换**：展开结果里不留任何标记（§2 末），源码里看到的就是最终值；
 * 2. **不认识的东西原样保留，绝不阻断**（§6）：未知记号、多余的 `@cursor`、拿不到的剪贴板
 *    都只写一条 {@link TemplateNote}，交给界面如实说出来；
 * 3. **同步纯函数**：`@prompt` 的答案与剪贴板内容都由调用方在展开**之前**备好
 *    （见 `builtins.ts` 的 {@link TemplateValues}）—— 展开到一半弹个输入框会让"创建笔记"
 *    这条链路出现能被打断的分支，而这里应当是一段可单测的字符串变换。
 *
 * ## 为什么不用 strftime / 日期库
 * 设计 02 §4 只保留 11 个模式串记号（`YYYY` / `YY` / `MM` / `M` / `DD` / `D` / `HH` / `mm` /
 * `ss` / `dddd` / `ddd`），一次正则替换搞定：`%Y` 要按 `Shift+5` 且对非程序员不直观，
 * Go 的 `2006-01-02`（拿一个具体日期当格式）反直觉且容易写错 —— 两条都被否决过。
 * 星期几直接用中文常量表而不是 `Intl`：`Intl` 的结果依赖运行时 ICU 数据，
 * 同一个模板在不同机器上可能给出不同语言，而这是个中文单语产品（确定性更重要）。
 */

import { templateBuiltin, type TemplateSnapshot, type TemplateValues } from './builtins'
import { scanTemplate } from './scan'

/** 非阻断提示的种类（稳定枚举；文案由界面给，见 `features/template/`）。 */
export type TemplateNoteKind =
  /** 名字不在内建表里的 `@xxx`（原样保留）。 */
  | 'unknown'
  /** 第 2 个及以后的 `@cursor`（第一个生效，其余原样保留）。 */
  | 'extra-cursor'
  /** 剪贴板拿不到内容（空串 + 提示）。 */
  | 'clipboard-missing'

/** 一条非阻断提示。 */
export interface TemplateNote {
  kind: TemplateNoteKind
  /** 出问题的那段原文（`@foo` / `@cursor`），供界面点名。 */
  raw: string
}

/** 一次展开的结果。 */
export interface TemplateExpansion {
  /** 展开后的全文（`@cursor` 已移除、`@@` 已还原成 `@`）。 */
  text: string
  /**
   * `@cursor` 在 {@link text} 里的偏移；模板里没有它时为 `null`。
   *
   * `null` 的语义是"光标落在**文档末尾**"（设计 02 §6）—— 不是"落在 0"，
   * 所以调用方必须区分这两者。
   */
  cursor: number | null
  /** 非阻断提示（同类同原文只留一条），按出现顺序。 */
  notes: TemplateNote[]
}

// ---------------------------------------------------------------------------
// 模式串
// ---------------------------------------------------------------------------

/**
 * 模式串记号。
 *
 * 备选顺序就是优先级：`YYYY` 必须排在 `YY` 前、`dddd` 排在 `ddd` 前，否则
 * `YYYY` 会被拆成 `YY`+`YY`（`20262026`）、`dddd` 只剩 `ddd`+`d`。
 */
const PATTERN_TOKENS = /YYYY|YY|MM|M|DD|D|HH|mm|ss|dddd|ddd/gu

/** 星期几（`dddd`）——`Date.getDay()` 的 0 是周日。 */
const WEEKDAY_LONG: readonly string[] = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

/** 星期几简写（`ddd`）。中文的"简写"就是去掉"期"字，与 `dddd` 一眼能对上。 */
const WEEKDAY_SHORT: readonly string[] = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * 按模式串格式化一个时刻（**本地时区**，设计 02 §9 第 1 条）。
 *
 * 刻意用 `getFullYear` / `getHours` 这一组**本地**取值，而不是 `toISOString`：
 * 后者是 UTC，东八区的用户在 08:00 前会看到昨天的日期 —— 那是这个功能最容易被投诉的错。
 *
 * 模式串里不认识的字符（`年`/`月`/`日`/`-`）原样留下，因此
 * `@today=YYYY年M月D日` → `2026年10月12日`。
 */
export function formatTemplatePattern(date: Date, pattern: string): string {
  return pattern.replace(PATTERN_TOKENS, (token) => {
    switch (token) {
      case 'YYYY':
        return String(date.getFullYear())
      case 'YY':
        return pad2(date.getFullYear() % 100)
      case 'MM':
        return pad2(date.getMonth() + 1)
      case 'M':
        return String(date.getMonth() + 1)
      case 'DD':
        return pad2(date.getDate())
      case 'D':
        return String(date.getDate())
      case 'HH':
        return pad2(date.getHours())
      case 'mm':
        return pad2(date.getMinutes())
      case 'ss':
        return pad2(date.getSeconds())
      case 'dddd':
        return WEEKDAY_LONG[date.getDay()] ?? ''
      case 'ddd':
        return WEEKDAY_SHORT[date.getDay()] ?? ''
      default:
        return token
    }
  })
}

// ---------------------------------------------------------------------------
// UUID
// ---------------------------------------------------------------------------

/**
 * 生成一个 v4 UUID（`@uuid`）。
 *
 * 优先 `crypto.randomUUID`（WebView2 / WKWebView / WebKitGTK 均可用）。兜底路径存在，
 * 但**不承担安全职责**：`@uuid` 的用途是"给文件名/附件名拼一个不重名的串"，
 * 不是密钥。形状必须合法（8-4-4-4-12、版本位 4、变体位 10xx），否则用户拿它当文件名
 * 或提交给外部系统时会出问题。
 */
export function randomUuidV4(): string {
  const source = typeof crypto === 'undefined' ? null : crypto
  if (source !== null && typeof source.randomUUID === 'function') return source.randomUUID()
  const bytes = new Uint8Array(16)
  if (source !== null && typeof source.getRandomValues === 'function') {
    source.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// ---------------------------------------------------------------------------
// 展开
// ---------------------------------------------------------------------------

/**
 * 模板里所有 `@prompt` 的标签（按出现顺序，同标签只问一次）。
 *
 * 为什么要在展开**之前**单独收集：`@prompt` 的答案来自用户输入，而展开是同步的。
 * 于是流程固定成"扫一遍拿全部问题 → 一次问完 → 展开"，用户也就不会在"点了创建之后
 * 再被弹第二个框"这种半途状态里。
 *
 * 同标签去重：标签**就是**那个问题（`@prompt=标题` 的问题叫"标题"），同一个问题问两遍
 * 只会让用户以为程序坏了。
 */
export function collectTemplatePrompts(text: string): string[] {
  const labels: string[] = []
  const seen = new Set<string>()
  for (const token of scanTemplate(text).tokens) {
    if (token.name !== 'prompt') continue
    const label = token.argument ?? ''
    if (seen.has(label)) continue
    seen.add(label)
    labels.push(label)
  }
  return labels
}

/** 内部：一次替换。`cursor` = 这一处就是光标落点。 */
interface TemplateEdit {
  start: number
  end: number
  insert: string
  cursor: boolean
}

/**
 * 展开模板。
 *
 * 做法是"扫描 → 替换表 → 一次重建"，而不是逐个 `String.replace`：
 * 逐个替换时每一轮都会看到**上一轮的结果**（`@today` 展开出的内容里若恰好含 `@`，
 * 就会被下一轮再展开一次），而且无法把光标落点算准。
 */
export function expandTemplate(text: string, values: TemplateValues): TemplateExpansion {
  const scan = scanTemplate(text)
  const uuid = values.uuid ?? randomUuidV4
  const notes: TemplateNote[] = []
  const noteKeys = new Set<string>()
  const addNote = (kind: TemplateNoteKind, raw: string): void => {
    const key = `${kind}\u0000${raw}`
    if (noteKeys.has(key)) return
    noteKeys.add(key)
    notes.push({ kind, raw })
  }

  const edits: TemplateEdit[] = scan.escapes.map((escape) => ({
    start: escape.start,
    end: escape.end,
    insert: '@',
    cursor: false,
  }))

  let cursor: number | null = null
  // "第一个 `@cursor` 生效"必须在这里记账，而不是复用下面的 `cursor`：
  // 那是**输出阶段**才算出来的偏移，在替换表还没建好时它一直是 null
  let cursorPlaced = false
  for (const token of scan.tokens) {
    // `@cursor`：一篇模板里最多一个（§6）。第一个去掉并记下落点，其余原样保留
    if (token.name === 'cursor') {
      if (!cursorPlaced) {
        cursorPlaced = true
        edits.push({ start: token.start, end: token.end, insert: '', cursor: true })
      } else {
        addNote('extra-cursor', token.raw)
      }
      continue
    }

    const insert = expandTokenText(token.name, token.argument, values, uuid, addNote)
    edits.push({ start: token.start, end: token.end, insert, cursor: false })
  }

  // 未识别的记号原样保留，但要列出来（§6）
  for (const unknown of scan.unknown) addNote('unknown', unknown.raw)

  edits.sort((a, b) => a.start - b.start)
  let out = ''
  let last = 0
  for (const edit of edits) {
    out += text.slice(last, edit.start)
    if (edit.cursor) cursor = out.length
    out += edit.insert
    last = edit.end
  }
  out += text.slice(last)

  return { text: out, cursor, notes }
}

/** 求一个记号的值；`clipboard` 的缺失提示在这里落账。 */
function expandTokenText(
  name: string,
  argument: string | null,
  values: TemplateValues,
  uuid: () => string,
  addNote: (kind: TemplateNoteKind, raw: string) => void,
): string {
  const builtin = templateBuiltin(name)
  const pattern = argument ?? builtin?.defaultPattern ?? ''
  switch (name) {
    case 'today':
    case 'date':
    case 'now':
    case 'time':
      return formatTemplatePattern(values.now, pattern)
    case 'title':
      return values.title
    case 'filename':
      return values.filename
    case 'path':
      return values.path
    case 'vault':
      return values.vault
    case 'uuid':
      return uuid()
    case 'prompt':
      return values.prompt(argument ?? '')
    case 'clipboard': {
      // 空串与"拿不到"在用户眼里是同一件事：留空 + 一条非阻断提示
      if (values.clipboard === null || values.clipboard === '') {
        addNote('clipboard-missing', '@clipboard')
        return ''
      }
      return values.clipboard
    }
    default:
      // 只有内建名字才会走到这里（`scanTemplate` 已经筛过）：留着分支是为了让
      // "表里加了名字、展开器忘了加分支"变成空串而不是静默保留原文
      return ''
  }
}

// ---------------------------------------------------------------------------
// 候选预览
// ---------------------------------------------------------------------------

/**
 * 候选列表右侧显示的"展开后的真实值"（设计 02 §5.2）。
 *
 * 只有三个记号给不出真实值，各自的理由不同：
 * - `@clipboard`：读剪贴板是异步的、还可能被权限拒绝 —— 不可能每按一个键读一次；
 * - `@prompt`：值要等用户回答；
 * - `@uuid`：每次生成都不一样，逐帧预览只会看到一串乱跳的字符；
 * 其余（含全部模式串）都是真值，用户因此不必背名字。
 *
 * 刻意不叫 `expand`：它**不**做替换，只是把同一个求值口径用在"显示这一格"上。
 */
export function previewTemplateValue(
  name: string,
  argument: string | null,
  snapshot: TemplateSnapshot,
): string {
  const builtin = templateBuiltin(name)
  switch (name) {
    case 'today':
    case 'date':
    case 'now':
    case 'time':
      return formatTemplatePattern(snapshot.now, argument ?? builtin?.defaultPattern ?? '')
    case 'title':
      return snapshot.title
    case 'filename':
      return snapshot.filename
    case 'path':
      return snapshot.path
    case 'vault':
      return snapshot.vault
    case 'uuid':
      return '（每次生成新的 v4）'
    case 'clipboard':
      return '（读取剪贴板）'
    case 'prompt':
      return '（创建时询问）'
    case 'cursor':
      return '（光标落点）'
    default:
      return ''
  }
}
