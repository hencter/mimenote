/**
 * 收件箱（Inbox）的**判定与捕获规则**（纯函数，无 React / 无 IPC / 不碰文件系统）。
 *
 * 为什么单独成模块：收件箱的每一条规则都同时在四个地方成立 —— 视图列表、未整理计数、
 * 捕获时选目标文件、将来文件树的"收件箱置顶"。这四处各写一遍字符串比较，迟早出现
 * "视图里有、计数里没有"这种自相矛盾（这正是 ADR-0057 决策 1 要挡住的东西）。
 * 判据只有这一份（{@link isInboxEntry}），改动只改这里。
 *
 * 权威判定仍然在宿主：这里只保证"送过去的东西是合理的"，越界、符号链接、Windows 保留名
 * 由 `mn_core::path_guard` 最终裁决（与 `domain/attachments.ts` 同一个姿态）。
 *
 * 完整规格与理由见 `docs/design/03-inbox.md`；决定见 ADR-0057。
 */

import type { EntryMeta } from '@/ipc/types'

import { hasIllegalChars, isReservedName } from './assets'
import { sanitizeAttachmentStem } from './attachments'
import { frontmatterRegion } from './frontmatter'
import { isMarkdown, joinRel } from './paths'
import type { EntryComparator } from './tree'

/**
 * 默认收件箱目录（Vault 相对路径）。
 *
 * 与配置键 `inbox.dir` 的默认值同源（设计 01 的 `[inbox] dir = "Inbox"`）：
 * 设置层与领域层各写一个 `'Inbox'` 字面量，就会出现"改了配置、判据没改"。
 */
export const DEFAULT_INBOX_DIR = 'Inbox'

/**
 * 标题里首行摘要的**字符**上限（按码点截，不留半个代理对）。
 *
 * 为什么截断而不是整句进文件名：标题是收件箱列表里的**一行**，长句会把时间戳挤到看不见，
 * 而时间戳正是这个视图的排序依据的来源之一。24 个字符够认出"这是什么"。
 */
export const INBOX_TITLE_SUMMARY_CHARS = 24

/** Vault 相对路径的宽松归一化：反斜杠 → `/`、去掉首尾 `/` 与两侧空白。 */
function coerceRelPath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '')
}

/**
 * 归一化收件箱目录；非法值（含空串）**回退默认目录**。
 *
 * 与 `normalizeAttachmentDir` 只差一条：附件目录里空串表示"Vault 根"，是合法值；
 * 而收件箱是"一个独立目录"（设计 01 §2 的 `[inbox] dir = "Inbox"`），空串等于"整个 Vault
 * 都是收件箱"——没有意义，因此与非法值同等回退。校验口径（非法字符、`.`/`..`、首尾空白、
 * 尾随点、保留名）与附件目录一字不差，别在这里发明第二套。
 */
export function normalizeInboxDir(value: string): string {
  const normalized = coerceRelPath(value)
  if (normalized === '') return DEFAULT_INBOX_DIR
  const segments = normalized.split('/')
  const invalid = segments.some(
    (segment) =>
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      segment.trim() !== segment ||
      segment.endsWith('.') ||
      hasIllegalChars(segment) ||
      isReservedName(segment),
  )
  return invalid ? DEFAULT_INBOX_DIR : normalized
}

/**
 * `relPath` 是否落在收件箱目录**之内**（含子目录，也含目录自身）。
 *
 * 大小写**按段不敏感**：Windows / macOS 上 `Inbox` 与 `inbox` 是同一个目录，用户把配置
 * 写成小写不该让收件箱变成空的；比较用 `toLowerCase()` 而不是 locale 相关的大小写折叠
 * ——判据要可预期，不该随 ICU 版本变。
 *
 * `dir` 非法/为空时按 {@link normalizeInboxDir} 的默认目录判定：与 store 归一化后的行为
 * 一致，调用方不需要先归一化（多一层"先归一化再判断"就是多一处能忘）。
 */
export function isInboxPath(relPath: string, dir: string = DEFAULT_INBOX_DIR): boolean {
  const target = normalizeInboxDir(dir).toLowerCase()
  const path = coerceRelPath(relPath).toLowerCase()
  if (path === '') return false
  return path === target || path.startsWith(`${target}/`)
}

/**
 * `relPath` 是否是一个**收件箱条目** —— 判定"哪些文件算收件箱条目"的唯一判据。
 *
 * 规则只有两条：在收件箱目录之内（{@link isInboxPath}）+ 是 Markdown。
 * - **子目录算**：位置的语义是"还没归档"，而不是"恰好在这一层"；
 * - **非 md 附件不算**：视图的动作（打开 / 归档）都是笔记语义，附件混进计数会让
 *   "还剩 N 条"永远清不掉（它不会因为被处理而离开这个目录）。
 *
 * 目录自身天然不算（`isMarkdown` 对无扩展名的目录返回 false）。
 */
export function isInboxEntry(relPath: string, dir: string = DEFAULT_INBOX_DIR): boolean {
  return isInboxPath(relPath, dir) && isMarkdown(relPath)
}

/**
 * 把一个条目比较器包成"收件箱目录**永远排在最前**"的版本（文件树置顶用，ADR-0057 决策 8）。
 *
 * 只动"是不是收件箱"这一个键，其余排序语义原样交给 `base`（目录/文件分层、名称、大小……）。
 * 顶层只有 `Inbox` 这一行落在判据里，子树内部两两相比结果相同，因此不会打乱收件箱内部排序。
 * 树侧要置顶就包这一层，**不要**在树里写 `relPath === 'Inbox'`（配置可以改目录名）。
 */
export function withInboxFirst(
  base: EntryComparator,
  dir: string = DEFAULT_INBOX_DIR,
): EntryComparator {
  return (a, b) => {
    const left = isInboxPath(a.relPath, dir)
    const right = isInboxPath(b.relPath, dir)
    if (left !== right) return left ? -1 : 1
    return base(a, b)
  }
}

/**
 * 收件箱条目的比较器：**最后修改时间倒序**。
 *
 * 与 `domain/tree.makeEntryComparator` 的规则 1 同一条：`mtimeMs === null` 的含义是
 * "没有这个时间"（例如刚被扫到、拿不到元数据），**恒排最后**且不随方向翻转 ——
 * 把它翻到最前等于把"未知"显示成"最新"。
 *
 * 为什么不用文件名排序：当日模式的 `2026-10-12.md` 会被字典序排到所有单篇之后；
 * 而"最后一次动它"才是用户在这个列表里想看的顺序。
 * 兜底用**逐字符**的 `relPath` 升序（不用 locale collator：这里只需要"结果与输入顺序无关"，
 * 而 collator 的次序会随 ICU 数据变）。
 */
export function compareInboxEntries(a: EntryMeta, b: EntryMeta): number {
  if (a.mtimeMs === null || b.mtimeMs === null) {
    if (a.mtimeMs === null && b.mtimeMs === null) return compareRelPath(a, b)
    return a.mtimeMs === null ? 1 : -1
  }
  if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs
  return compareRelPath(a, b)
}

function compareRelPath(a: EntryMeta, b: EntryMeta): number {
  if (a.relPath === b.relPath) return 0
  return a.relPath < b.relPath ? -1 : 1
}

/** 条目表 → 收件箱条目（已按 {@link compareInboxEntries} 排序；**不修改入参**）。 */
export function inboxEntries(
  entries: readonly EntryMeta[],
  dir: string = DEFAULT_INBOX_DIR,
): EntryMeta[] {
  return entries.filter((entry) => isInboxEntry(entry.relPath, dir)).sort(compareInboxEntries)
}

/** 两位补零：时间戳的每一段都要固定宽度，字典序才等于时间序（`2026-01-02 0304`）。 */
function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 本地日期 `YYYY-MM-DD`（文件名可用的写法；`:` 在 Windows 上非法，所以时刻连写）。 */
function localDate(at: Date): string {
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`
}

/** 当日模式的当日笔记标题：`2026-10-12`。 */
export function inboxDailyTitle(at: Date): string {
  return localDate(at)
}

/** 单篇模式的时间戳前缀：`2026-10-12 2054`（精确到分钟）。 */
export function inboxTimestamp(at: Date): string {
  return `${localDate(at)} ${pad2(at.getHours())}${pad2(at.getMinutes())}`
}

/**
 * 首行摘要：取第一个非空行的压空白结果，按码点截到 {@link INBOX_TITLE_SUMMARY_CHARS}。
 *
 * 取"第一个非空行"而不是"第一行"：粘贴进来的文本常常以空行开头，取第一行会得到空摘要。
 */
export function inboxTitleSummary(text: string): string {
  const firstLine = text.split('\n').find((line) => line.trim() !== '') ?? ''
  const collapsed = firstLine
    .trim()
    .split(/\s+/u)
    .filter((part) => part !== '')
    .join(' ')
  return [...collapsed].slice(0, INBOX_TITLE_SUMMARY_CHARS).join('')
}

/**
 * 单篇捕获的标题：`<时间戳> <首行摘要>`（摘要是空的时候只留时间戳）。
 *
 * 摘要经 `sanitizeAttachmentStem` 过一道 —— 它与宿主 `sanitize_file_stem` 是同一套口径
 * （非法字符换 `-`、Windows 保留名拒绝、按 UTF-8 字节截断）。**不在这里另写一份**：
 * 两套安全化口径漂移的后果是"前端以为会落成 A、磁盘上是 B"。
 */
export function inboxNoteTitle(text: string, at: Date): string {
  const stamp = inboxTimestamp(at)
  const safe = sanitizeAttachmentStem(inboxTitleSummary(text))
  return safe === '' ? stamp : `${stamp} ${safe}`
}

/** 当日模式的目标路径：`<dir>/YYYY-MM-DD.md`。 */
export function inboxDailyPath(dir: string, at: Date): string {
  return joinRel(normalizeInboxDir(dir), `${inboxDailyTitle(at)}.md`)
}

function ensureTrailingNewline(text: string): string {
  if (text === '') return ''
  return text.endsWith('\n') ? text : `${text}\n`
}

/**
 * 把"刚建的文件初始内容"与用户正文合成最终内容（单篇模式）。
 *
 * 宿主 `note_create` 一定会先写点东西：开时间挂钩时是 `created`/`updated` frontmatter 块，
 * 否则是一行 `# 标题` 占位。因此第二次 `note_write` 不能直接把正文写下去 ——
 * 那会把刚写下的时间挂钩**整篇覆盖掉**（表现是"别的笔记都有 `created`，唯独收件箱里没有"）。
 *
 * 规则：
 * - 初始内容里有合法 frontmatter 区块（`domain/frontmatter.frontmatterRegion` 判，三格式一致）
 *   → 原样保留该块 + 一个空行 + 正文；
 * - 否则（只有 `# 标题` 占位或空文件）→ 只留正文：标题是我们刚生成的时间戳摘要，
 *   与文件名重复，留在正文里只是噪声，而"文件即真相"要的是"磁盘上就是用户写的那句话"。
 */
export function mergeCapturedBody(initialText: string, captured: string): string {
  const body = captured.trim()
  if (body === '') return initialText
  const region = frontmatterRegion(initialText)
  if (region === null) return ensureTrailingNewline(body)
  const lines = initialText.split('\n')
  const block = lines.slice(0, region.endLine + 1).join('\n')
  return `${block}\n\n${ensureTrailingNewline(body)}`
}

/**
 * 当日模式：把一条捕获追加到当日笔记的末尾，返回新文本。
 *
 * 入参 `existing` 必须是**编辑器态**文本（`\n` 换行、无 BOM），调用方负责用
 * `domain/eol.ts` 的 `toEditorText` / `fromEditorText` 在这条边界上还原磁盘风格 ——
 * 一个 CRLF 笔记不会因为捕获一条就被 Git 看成"整个文件都改了"。
 *
 * 形状是 `- HH:mm 正文`（多行时续行缩进两格，段内空行写成两个空格以留在同一个列表项里）：
 * 当日笔记是一个**共享容器**，只有这个由我们写下的记号才能把"这条是我 20:54 捕获的"
 * 从"这是我手写的一段"里分出来。单篇模式相反，正文里一个字符都不加。
 *
 * 分隔：上一条也是列表项就接在下一行（当日笔记是一串捕获，条目之间不空行），
 * 否则补一个空行（散文后面紧跟项目符号会被某些渲染器当成延续），已有空行则不补。
 * 两种情况在 diff 里都只有新增行。
 * 空正文原样返回（不写、不补空行）。
 */
export function appendCaptureEntry(existing: string, captured: string, at: Date): string {
  const body = captured.trim()
  if (body === '') return existing
  const [first, ...rest] = body.split('\n')
  const block = [
    `- ${pad2(at.getHours())}:${pad2(at.getMinutes())} ${(first ?? '').trimEnd()}`,
    ...rest.map((line) => (line.trim() === '' ? '  ' : `  ${line.trimEnd()}`)),
  ].join('\n')
  return `${existing}${separator(existing)}${block}\n`
}

/**
 * 追加前要补的分隔（见 {@link appendCaptureEntry}）。
 *
 * 三种情况，顺序即优先级：
 * 1. 末尾已经有空行 → 一个都不补（否则每捕获一条就多空一行）；
 * 2. 上一条**也是列表项** → 直接接在下一行：当日笔记就是一串捕获，
 *    条目之间空一行会把它变成 Markdown 的"松散列表"（每条之间多一个空行，观感是坏掉的）；
 * 3. 其余（正文、标题、`- ` 这种没有内容的行）→ 补一个空行：紧贴着一行散文追加项目符号，
 *    有些渲染器会把符号当成上一段的延续。
 */
function separator(existing: string): string {
  if (existing === '') return ''
  if (/\n[ \t]*\n$/u.test(existing)) return ''
  const lastLine = existing.replace(/\n$/u, '').split('\n').pop() ?? ''
  const continuesList = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\S/u.test(lastLine)
  const endsWithNewline = existing.endsWith('\n')
  if (continuesList) return endsWithNewline ? '' : '\n'
  return endsWithNewline ? '\n' : '\n\n'
}
