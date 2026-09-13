/**
 * 内存 Vault 适配器。
 *
 * 双重用途：
 * 1. **测试替身**：让 store / 领域层可以在 vitest 里跑完整 M1 闭环，无需 Tauri；
 * 2. **浏览器预览**：`pnpm dev` 时若不在 Tauri 内，UI 依然可用（便于调样式）。
 *
 * 行为刻意与 Rust 侧对齐：删除进回收站、mtime 作为版本令牌、路径校验。
 */

import type {
  AssetGrant,
  BacklinkRef,
  EntryMeta,
  FrontmatterField,
  FrontmatterValue,
  IndexStatus,
  LinkKind,
  NoteContent,
  NoteLinks,
  NoteTags,
  RenameLinkUpdate,
  RenameOutcome,
  ResolvedLink,
  SearchHit,
  SearchResult,
  TagNotes,
  TagRef,
  TagSource,
  TagSummary,
  TrashRecord,
  VaultInfo,
  VaultSnapshot,
  WriteOutcome,
} from './types'
import { MimenoteError, type ErrorCode } from './types'
import type { IpcAdapter } from './client'
import { normalizeLinkTarget, splitWikilink, wikilinkDisplayText } from '@/domain/links'
import { extensionOf, joinRel, parentOf } from '@/domain/paths'

interface MockNote {
  relPath: string
  text: string
}

/** 内存示例 Vault 的根路径（浏览器预览模式下"打开 Vault"打开的就是它）。 */
export const MOCK_VAULT_PATH = 'C:\\MockVault'

const DEFAULT_NOTES: MockNote[] = [
  { relPath: 'README.md', text: '# 示例 Vault\n\n这是**内存 Mock Vault**，用于浏览器预览与自动化测试。\n' },
  {
    relPath: '日记/2025-01-01.md',
    text: '# 一月一日\n\n- [x] 起床\n- [ ] 写笔记\n\n> 引用：本地优先。\n',
  },
  { relPath: '日记/2025-01-02.md', text: '# 一月二日\n\n今天研究了 CodeMirror 6 的扩展机制。\n' },
  { relPath: '项目/设计.md', text: '# 设计\n\n参考 [[路线图]] 与 [[细节]]。\n\n| 层 | 职责 |\n| --- | --- |\n| 文件层 | 原子写 |\n| 索引层 | FTS5 |\n\n#项目\n' },
  { relPath: '项目/路线图.md', text: '# 路线图\n\n1. M1 闭环\n2. M2 搜索\n3. M3 图谱\n\n设计细节见 [[设计]]。\n' },
  { relPath: '项目/子项目/细节.md', text: '# 细节\n\n```ts\nexport const answer = 42\n```\n\n还有一个还没写的笔记：[[还不存在的笔记]]。\n' },
  { relPath: '随手记.md', text: '字数统计测试：hello world 与中文混排。\n' },
  // 专门用来演示「标签与属性面板」与「全文搜索」的笔记：
  // 其它用例请勿依赖它的内容（改了会影响 UI 层 E2E 里的标签/搜索断言）。
  {
    relPath: '项目/标签示例.md',
    text: '---\ntitle: 标签示例\ntags: [项目, 进行中]\n---\n\n这一段用来演示 #架构 与 #项目 标签的抽取。\n',
  },
  { relPath: '附件/说明.txt', text: '非 Markdown 附件，M1 不可编辑。\n' },
]

export interface MockAdapterOptions {
  notes?: MockNote[]
  rootPath?: string
  /** 模拟命令行指定的 Vault（`startup_vault` 命令）。 */
  startupVaultPath?: string
  /** 模拟写入延迟（毫秒），用于验证 UI 的"保存中"状态。 */
  writeLatencyMs?: number
}

// ---------------------------------------------------------------------------
// Mock 的链接解析
//
// ⚠️ 这里只是为了"浏览器预览 + UI 层测试"能跑通，规则是 Rust 实现
// （`mn-core::links` + `mn-index`）的**简化镜像**。权威实现永远在 Rust 侧，
// 真实行为由应用层 E2E 与 Rust 单测覆盖。
// ---------------------------------------------------------------------------

interface MockRawLink {
  kind: LinkKind
  rawTarget: string
  alias: string | null
  anchor: string | null
  line: number
}

function mockExtractLinks(text: string): MockRawLink[] {
  const out: MockRawLink[] = []
  let inFence = false

  text.split('\n').forEach((line, index) => {
    const trimmed = line.trimStart()
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence
      return
    }
    if (inFence) return

    // 行内代码与转义的 `[[` 不算链接
    const cleaned = line.replace(/`[^`]*`/g, ' ').replaceAll('\\[', '  ')

    const wiki = /\[\[([^\]\n]+)\]\]/g
    let match = wiki.exec(cleaned)
    while (match !== null) {
      const parts = splitWikilink(match[1] ?? '')
      out.push({
        kind: 'wiki',
        rawTarget: parts.target,
        alias: parts.alias,
        anchor: parts.anchor,
        line: index + 1,
      })
      match = wiki.exec(cleaned)
    }

    const markdown = /\[([^\]\n]*)\]\(([^)\s]+)[^)]*\)/g
    match = markdown.exec(cleaned)
    while (match !== null) {
      const target = match[2] ?? ''
      if (!/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('#')) {
        const parts = splitWikilink(target)
        out.push({
          kind: 'markdown',
          rawTarget: parts.target,
          alias: match[1] || null,
          anchor: parts.anchor,
          line: index + 1,
        })
      }
      match = markdown.exec(cleaned)
    }
  })

  return out
}

function pickMockCandidate(matches: string[]): { path: string | null; ambiguous: boolean } {
  const unique = [...new Set(matches)].sort()
  if (unique.length === 0) return { path: null, ambiguous: false }
  if (unique.length === 1) return { path: unique[0] ?? null, ambiguous: false }
  const best = [...unique].sort(
    (a, b) => a.length - b.length || a.localeCompare(b),
  )[0]
  return { path: best ?? null, ambiguous: true }
}

/** 链接解析器：`(来源文件, 原始目标)` → 命中的笔记。 */
type MockResolver = (from: string, raw: string) => { path: string | null; ambiguous: boolean }

/**
 * 构建解析器（一次遍历建立 stem 索引，避免在批量改写时反复重建）。
 *
 * 规则与 `mn-index` 对齐：裸名走 stem 索引 + 消歧，带路径的走前缀匹配。
 */
function createMockResolver(files: Map<string, MockNote>): MockResolver {
  const all = [...files.keys()]
  const byStem = new Map<string, string[]>()
  for (const path of all) {
    const name = path.split('/').pop() ?? path
    const stem = name.replace(/\.(md|markdown)$/i, '').toLowerCase()
    byStem.set(stem, [...(byStem.get(stem) ?? []), path])
  }

  return (from, raw) => {
    const key = normalizeLinkTarget(raw)
    if (key === '') return { path: from, ambiguous: false }
    if (key.includes('/')) {
      const direct = all.find((candidate) => normalizeLinkTarget(candidate) === key)
      if (direct !== undefined) return { path: direct, ambiguous: false }
      const suffix = `/${key}`
      return pickMockCandidate(
        all.filter((candidate) => normalizeLinkTarget(candidate).endsWith(suffix)),
      )
    }
    return pickMockCandidate(byStem.get(key) ?? [])
  }
}

function buildMockNoteLinks(
  files: Map<string, MockNote>,
  relPath: string,
  resolver: MockResolver = createMockResolver(files),
): NoteLinks {
  const resolve = resolver
  const note = files.get(relPath)
  const outbound: ResolvedLink[] = (note === undefined ? [] : mockExtractLinks(note.text)).map(
    (link) => {
      const resolved = resolve(relPath, link.rawTarget)
      return {
        kind: link.kind,
        rawTarget: link.rawTarget,
        display: wikilinkDisplayText({
          target: link.rawTarget,
          alias: link.alias,
          anchor: link.anchor,
        }),
        alias: link.alias,
        anchor: link.anchor,
        line: link.line,
        resolvedRelPath: resolved.path,
        ambiguous: resolved.ambiguous,
      }
    },
  )

  const backlinks: BacklinkRef[] = []
  for (const [from, other] of files) {
    if (from === relPath) continue
    for (const link of mockExtractLinks(other.text)) {
      const resolved = resolve(from, link.rawTarget)
      if (resolved.path !== relPath) continue
      backlinks.push({
        fromRelPath: from,
        display: wikilinkDisplayText({
          target: link.rawTarget,
          alias: link.alias,
          anchor: link.anchor,
        }),
        anchor: link.anchor,
        line: link.line,
        kind: link.kind,
      })
    }
  }
  backlinks.sort((a, b) => a.fromRelPath.localeCompare(b.fromRelPath) || a.line - b.line)

  return {
    relPath,
    outbound,
    backlinks,
    unresolvedCount: outbound.filter((link) => link.resolvedRelPath === null).length,
  }
}

// ---------------------------------------------------------------------------
// Mock 的链接改写（重命名用）
//
// 同样是 Rust 实现（`mn-core::links` + `mn-index`）的**简化镜像**：
// Rust 用精确的字符 span 改写，这里用"扫描 → 重建链接文本"的方式，
// 结果在语义上一致（目标更新、别名与锚点保留、代码块内不动）。
// ---------------------------------------------------------------------------

/** 一行里扫描到的一条链接。 */
interface ScannedLink {
  form: 'wiki' | 'markdown'
  /** 链接目标（已剥离锚点与 `<>` 包裹）。 */
  raw: string
  alias: string | null
  anchor: string | null
  /** 在**原文**行内的字符偏移（与 Rust 侧 `LinkSpan` 语义一致）。 */
  start: number
  end: number
}

/** 用等长空格遮蔽行内代码与转义的 `\[`，**保持字符偏移不变**。 */
function maskInlineCode(line: string): string {
  let out = ''
  let index = 0
  while (index < line.length) {
    const char = line[index] ?? ''
    if (char === '`') {
      const end = line.indexOf('`', index + 1)
      if (end !== -1) {
        out += ' '.repeat(end - index + 1)
        index = end + 1
        continue
      }
    }
    if (char === '\\' && line[index + 1] === '[') {
      out += '  '
      index += 2
      continue
    }
    out += char
    index += 1
  }
  return out
}

/** 剥离 Markdown 链接目标的 `<...>` 与可选标题。 */
function cleanMarkdownTarget(raw: string): string {
  const trimmed = raw.trim()
  const withoutTitle = trimmed.split(/\s+"/)[0] ?? trimmed
  if (withoutTitle.startsWith('<') && withoutTitle.endsWith('>')) {
    return withoutTitle.slice(1, -1).trim()
  }
  return withoutTitle.trim()
}

/** 扫描一行里的 wikilink 与 Markdown 链接（跳过行内代码与转义）。 */
function scanLineLinks(line: string): ScannedLink[] {
  const masked = maskInlineCode(line)
  const pattern = /(!?)\[\[([^\]\n]*)\]\]|\[([^\]\n]*)\]\(([^)\n]*)\)/g
  const out: ScannedLink[] = []

  let match = pattern.exec(masked)
  while (match !== null) {
    const start = match.index
    const end = start + match[0].length
    const wikiInner = match[2]
    if (wikiInner !== undefined) {
      const parts = splitWikilink(wikiInner)
      out.push({
        form: 'wiki',
        raw: parts.target,
        alias: parts.alias,
        anchor: parts.anchor,
        start,
        end,
      })
    } else {
      const raw = cleanMarkdownTarget(match[4] ?? '')
      if (raw !== '' && !/^[a-z][a-z0-9+.-]*:/i.test(raw) && !raw.startsWith('#')) {
        const parts = splitWikilink(raw)
        out.push({
          form: 'markdown',
          raw: parts.target,
          alias: match[3] === '' || match[3] === undefined ? null : match[3],
          anchor: parts.anchor,
          start,
          end,
        })
      }
    }
    match = pattern.exec(masked)
  }
  return out
}

/** 从 `fromDir` 到 `toRelPath` 的 POSIX 相对路径。 */
function relativeRelPath(fromDir: string, toRelPath: string): string {
  const from = fromDir === '' ? [] : fromDir.split('/')
  const to = toRelPath.split('/')
  const lastIndex = to.length - 1
  let common = 0
  while (common < from.length && common < lastIndex && from[common] === to[common]) common += 1
  const ups = Array.from({ length: from.length - common }, () => '..')
  return [...ups, ...to.slice(common)].join('/')
}

/** 用新目标重建一条链接（保留 `!` 前缀、别名与锚点）。 */
function rebuildLink(line: string, link: ScannedLink, target: string): string {
  const original = line.slice(link.start, link.end)
  if (link.form === 'wiki') {
    const bang = original.startsWith('!') ? '!' : ''
    const anchor = link.anchor === null ? '' : `#${link.anchor}`
    const alias = link.alias === null ? '' : `|${link.alias}`
    return `${bang}[[${target}${anchor}${alias}]]`
  }
  const label = link.alias ?? ''
  const rendered = /\s/.test(target) ? `<${target}>` : target
  return `[${label}](${rendered})`
}

/**
 * 把 `text` 里所有**解析到 `oldRelPath`** 的链接改写成指向 `newRelPath`。
 *
 * 目标写法规则（与 Rust 侧一致，保持最小 diff）：
 * - 原目标不含 `/` → 用新文件名（保持用户原来的裸名写法）；
 * - 含路径 → 用相对当前文件目录的 POSIX 相对路径；
 * - Markdown 链接沿用"原来带不带扩展名"的写法。
 */
function mockRewriteLinks(
  text: string,
  fromRelPath: string,
  oldRelPath: string,
  newRelPath: string,
  resolver: MockResolver,
): { text: string; count: number } {
  const newName = newRelPath.split('/').pop() ?? newRelPath
  const newStem = newName.replace(/\.(md|markdown)$/i, '')
  const newExt = extensionOf(newRelPath) === '' ? 'md' : extensionOf(newRelPath)
  const fromDir = parentOf(fromRelPath)

  let inFence = false
  let count = 0
  const lines = text.split('\n').map((line) => {
    const trimmed = line.trimStart()
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence
      return line
    }
    if (inFence) return line

    const links = scanLineLinks(line)
    if (links.length === 0) return line

    let out = ''
    let cursor = 0
    for (const link of links) {
      const key = normalizeLinkTarget(link.raw)
      if (key === '' || resolver(fromRelPath, link.raw).path !== oldRelPath) continue
      const keepsExtension = link.form === 'markdown' && /\.(md|markdown)$/i.test(link.raw)
      const suffix = keepsExtension ? `.${newExt}` : ''
      const target = key.includes('/')
        ? `${relativeRelPath(fromDir, newRelPath)}${suffix}`
        : `${newStem}${suffix}`
      out += line.slice(cursor, link.start) + rebuildLink(line, link, target)
      cursor = link.end
      count += 1
    }
    return out + line.slice(cursor)
  })

  return { text: lines.join('\n'), count }
}

// ---------------------------------------------------------------------------
// Mock 的标签 / frontmatter（`mn_core::tags` + `mn_core::frontmatter` 的简化镜像）
//
// 权威实现在 Rust 侧（那里的规则有 30+ 个单测钉死）。这里只需让"浏览器预览 + UI 层测试"
// 拿到形状正确的数据，因此刻意简化了两处：块数组项的**行号**统一取字段所在行；
// YAML 只认 `key: value`、`[a, b]`、`- item` 三种形态。
// ---------------------------------------------------------------------------

/** 归一化标签为索引键（小写、去 `#`、折叠空白与 `/`、去首尾 `/`）。 */
function mockNormalizeTag(raw: string): string {
  const withoutHash = raw
    .trim()
    .replace(/^#+/, '')
    .split(/\s+/)
    .filter((part) => part !== '')
    .join(' ')
  const collapsed = withoutHash.toLowerCase().replace(/\/{2,}/g, '/')
  return collapsed.replace(/^\/+/, '').replace(/\/+$/, '')
}

/** 标签字符：Unicode 字母数字（含 CJK）+ `_` + `-` + 层级 `/`。 */
function isMockTagChar(char: string): boolean {
  return /[\p{L}\p{N}_/-]/u.test(char)
}

function stripQuotes(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

/** 解析行内数组 `[a, b]`；不是数组返回空。 */
function parseInlineList(value: string): string[] {
  if (!value.startsWith('[') || !value.endsWith(']')) return []
  return value
    .slice(1, -1)
    .split(',')
    .map((item) => stripQuotes(item))
    .filter((item) => item !== '')
}

interface MockFrontmatter {
  fields: FrontmatterField[]
  /** 标签与它们在原文里的行号（块数组项在 Mock 里统一取字段行）。 */
  tags: { tag: string; line: number }[]
  /** 区块占用的行数（含首尾分隔行）；未闭合时为 0。 */
  lines: number
}

/** 把原始值文本归类成 `FrontmatterValue`（与 Rust 同口径：数字保留原始文本）。 */
function classifyFrontmatterValue(text: string): FrontmatterValue {
  if (text === '' || text === '~' || text.toLowerCase() === 'null') return { kind: 'null' }
  if (/^(true|false)$/i.test(text)) return { kind: 'bool', value: text.toLowerCase() === 'true' }
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text) || /^-?\d+\.$/.test(text)) {
    return { kind: 'number', value: text }
  }
  return { kind: 'scalar', value: stripQuotes(text) }
}

/** 解析开头的 frontmatter 区块（未闭合 → `null`，整篇按正文处理）。 */
function mockParseFrontmatter(text: string): MockFrontmatter | null {
  const lines = text.split('\n')
  const first = (lines[0] ?? '').replace(/^\u{feff}/u, '').trim()
  if (first !== '---') return null

  let end = -1
  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index] ?? '').trim() === '---') {
      end = index
      break
    }
  }
  if (end === -1) return null

  const fields: FrontmatterField[] = []
  for (let index = 1; index < end; index += 1) {
    const raw = (lines[index] ?? '').replace(/\r$/, '')
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue

    const item = /^\s*-\s+(.*)$/.exec(raw)
    if (item !== null) {
      const previous = fields[fields.length - 1]
      if (previous !== undefined) {
        const items = previous.value.kind === 'list' ? previous.value.value : []
        previous.value = { kind: 'list', value: [...items, stripQuotes(item[1] ?? '')] }
      }
      continue
    }

    const colon = raw.indexOf(':')
    if (colon <= 0) continue
    const value = raw.slice(colon + 1).trim()
    const inline = parseInlineList(value)
    fields.push({
      key: raw.slice(0, colon).trim(),
      value: inline.length > 0 ? { kind: 'list', value: inline } : classifyFrontmatterValue(value),
      line: index + 1,
    })
  }

  const tags: { tag: string; line: number }[] = []
  for (const field of fields) {
    if (field.key !== 'tags' && field.key !== 'tag') continue
    const values =
      field.value.kind === 'list'
        ? field.value.value
        : field.value.kind === 'scalar' || field.value.kind === 'number'
          ? field.value.value
              .split(',')
              .map((part) => stripQuotes(part))
              .filter((part) => part !== '')
          : []
    for (const value of values) tags.push({ tag: value, line: field.line })
  }

  return { fields, tags, lines: end + 1 }
}

/** 抽取正文行内 `#标签`（跳过围栏代码、行内代码、HTML 注释、标题行、转义）。 */
function mockScanInlineTags(bodyLines: readonly string[], lineOffset: number): TagRef[] {
  const out: TagRef[] = []
  let fence: string | null = null
  let inComment = false

  for (let row = 0; row < bodyLines.length; row += 1) {
    const line = (bodyLines[row] ?? '').replace(/\r$/, '')
    const trimmed = line.trimStart()

    if (fence !== null) {
      if (trimmed.startsWith(fence)) fence = null
      continue
    }
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed)
    if (fenceMatch !== null && !inComment) {
      fence = fenceMatch[1] ?? '```'
      continue
    }
    if (!inComment) {
      const run = /^#+/.exec(trimmed)?.[0].length ?? 0
      const afterRun = trimmed[run] ?? ''
      const isHeading = run >= 2 || (run === 1 && (run === trimmed.length || afterRun === ' ' || afterRun === '\t'))
      if (isHeading) continue
    }

    let index = 0
    let codeTicks: number | null = null
    while (index < line.length) {
      const char = line[index] ?? ''

      if (inComment) {
        if (line.startsWith('-->', index)) {
          inComment = false
          index += 3
        } else {
          index += 1
        }
        continue
      }
      if (codeTicks !== null) {
        if (char === '`') {
          const run = /^`+/.exec(line.slice(index))?.[0].length ?? 1
          if (run >= codeTicks) codeTicks = null
          index += run
        } else {
          index += 1
        }
        continue
      }
      if (char === '`') {
        codeTicks = /^`+/.exec(line.slice(index))?.[0].length ?? 1
        index += codeTicks
        continue
      }
      if (char === '\\') {
        index += 2
        continue
      }
      if (char === '<' && line.startsWith('<!--', index)) {
        inComment = true
        index += 4
        continue
      }
      if (char !== '#') {
        index += 1
        continue
      }

      const previous = line[index - 1] ?? ''
      if (index !== 0 && !/\s/.test(previous)) {
        index += 1
        continue
      }

      let end = index + 1
      while (end < line.length && isMockTagChar(line[end] ?? '')) end += 1
      while (end > index + 1 && line[end - 1] === '/') end -= 1
      if (end > index + 1) {
        const raw = line.slice(index + 1, end)
        // `#123` 这类纯数字不是标签
        if (/\D/.test(raw)) {
          out.push({ tag: raw, source: 'inline', line: lineOffset + row + 1 })
        }
      }
      index = Math.max(end, index + 1)
    }
  }
  return out
}

/** 抽取一篇笔记的全部标签（frontmatter 在前，按归一化键去重）。 */
function mockExtractTags(text: string): TagRef[] {
  const frontmatter = mockParseFrontmatter(text)
  const out: TagRef[] = []
  const seen = new Set<string>()

  const push = (tag: string, source: TagSource, line: number): void => {
    const key = mockNormalizeTag(tag)
    if (key === '' || seen.has(key)) return
    seen.add(key)
    out.push({ tag, source, line })
  }

  const bodyStartLine = frontmatter === null ? 0 : frontmatter.lines
  if (frontmatter !== null) {
    for (const entry of frontmatter.tags) push(entry.tag, 'frontmatter', entry.line)
  }
  for (const tag of mockScanInlineTags(text.split('\n').slice(bodyStartLine), bodyStartLine)) {
    push(tag.tag, 'inline', tag.line)
  }
  return out
}

// ---------------------------------------------------------------------------
// Mock 的全文搜索（`mn-index` 的 FTS5 检索的**简化镜像**）
//
// ⚠️ **权威实现永远在 Rust 侧**：宿主用 SQLite FTS5 建索引、按 `bm25` 排序，
// 前端只消费 `search_query` 的返回值。这里用"逐行大小写不敏感子串匹配"近似，
// 分数（{@link mockSearchScore}）也是自造的粗糙量，**与 bm25 不可比**，
// 仅供浏览器预览与 UI 层测试把整条链路（防抖 → IPC → 渲染 → 打开笔记）跑通。
// ---------------------------------------------------------------------------

/**
 * Mock 里"这是一篇 Markdown 笔记"的判定。
 *
 * 与 `noteCount()` 原来的内联写法完全一致（按扩展名），抽出来只是为了让**笔记计数**与
 * **全文搜索**用同一个口径 —— 否则"统计到 7 篇笔记、搜索却命中 .txt 附件"这种不一致
 * 迟早要排查。（`domain/paths` 的 `isMarkdown` 是同一口径的另一份实现，这里沿用本文件的写法。）
 */
function isMockMarkdown(relPath: string): boolean {
  const ext = relPath.split('.').pop()?.toLowerCase()
  return ext === 'md' || ext === 'markdown'
}

/** 每篇笔记最多返回多少条命中（真实实现由 FTS5 的 bm25 排序 + 截断决定）。 */
const MOCK_HITS_PER_NOTE = 5

/** `snippet` 的最大长度（字符数）；与 Rust 侧"裁剪到一行、约 120 字符"对齐。 */
const SNIPPET_MAX_CHARS = 120

/**
 * 命中行的展示片段。
 *
 * - 先 `trim` 掉首尾空白：缩进与 CRLF 不该出现在搜索结果里；
 * - 超过 {@link SNIPPET_MAX_CHARS} 时**以命中位置为中心**裁剪：关键词被切掉的搜索结果
 *   等于没搜到，所以命中点左右各留一半，被截断的那一侧加省略号。
 */
function mockSnippet(line: string, matchIndex: number, matchLength: number): string {
  const leading = line.length - line.trimStart().length
  const text = line.trim()
  const hit = Math.max(0, matchIndex - leading)
  if (text.length <= SNIPPET_MAX_CHARS) return text

  const half = Math.max(0, Math.floor((SNIPPET_MAX_CHARS - matchLength) / 2))
  let start = Math.max(0, hit - half)
  let end = Math.min(text.length, start + SNIPPET_MAX_CHARS)
  // 命中点靠近行尾时会"越过"右边界：把窗口整体左移，保证片段长度稳定
  start = Math.max(0, end - SNIPPET_MAX_CHARS)
  end = Math.min(text.length, start + SNIPPET_MAX_CHARS)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

/**
 * 相关度的近似值（**不是** bm25，只是 Mock 的占位）：
 * 命中次数越多越相关，并用篇幅做长度归一 —— 让"短笔记里反复出现"排在"长笔记里提了一次"前面。
 * 同一篇笔记的所有命中共享同一个分数，因此篇内自然按行号升序（契约要求的次级排序）。
 */
function mockSearchScore(occurrences: number, textLength: number): number {
  return Math.round((occurrences * 1000) / (1 + textLength / 500))
}

/** 在内存文件表里做一次全文检索，返回契约形状的结果。 */
function mockSearch(files: Map<string, MockNote>, query: string, limit: number): SearchResult {
  const started = Date.now()
  const trimmed = query.trim()
  // 空查询：宿主也返回空结果（前端本就不该发这个请求，这里再兜一层，两边语义一致）
  if (trimmed === '') return { query, hits: [], total: 0, elapsedMs: 0 }

  const needle = trimmed.toLowerCase()
  const hits: SearchHit[] = []
  // total 是**全部**命中数（含被"每篇 5 条"截掉的那些），与契约里"可能大于 hits.length"一致
  let total = 0

  for (const note of files.values()) {
    if (!isMockMarkdown(note.relPath)) continue

    const lower = note.text.toLowerCase()
    let occurrences = 0
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
      occurrences += 1
    }
    if (occurrences === 0) continue

    const score = mockSearchScore(occurrences, note.text.length)
    const lines = note.text.split('\n')
    let taken = 0
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      const at = line.toLowerCase().indexOf(needle)
      if (at === -1) continue
      total += 1
      if (taken >= MOCK_HITS_PER_NOTE) continue
      taken += 1
      hits.push({
        relPath: note.relPath,
        line: index + 1,
        snippet: mockSnippet(line, at, needle.length),
        score,
      })
    }
  }

  hits.sort(
    (a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath) || a.line - b.line,
  )
  const capped =
    Number.isFinite(limit) && limit > 0 ? hits.slice(0, Math.floor(limit)) : hits
  return { query, hits: capped, total, elapsedMs: Math.max(0, Date.now() - started) }
}

export interface MockAdapter extends IpcAdapter {
  /** 模拟外部程序修改文件（用于手工验证冲突横幅）。 */
  simulateExternalEdit(relPath: string, text: string): void
  /** 当前快照（测试断言用）。 */
  dump(): MockNote[]
}

export function createMockAdapter(options: MockAdapterOptions = {}): MockAdapter {
  const rootPath = options.rootPath ?? MOCK_VAULT_PATH
  const writeLatencyMs = options.writeLatencyMs ?? 0
  const files = new Map<string, MockNote>()
  const dirs = new Set<string>()
  const trashed: TrashRecord[] = []
  let clock = Date.now()

  const touch = (): number => {
    clock += 1
    return clock
  }

  const seed = (list: MockNote[]): void => {
    files.clear()
    dirs.clear()
    for (const note of list) {
      files.set(note.relPath, { relPath: note.relPath, text: note.text })
      const parts = note.relPath.split('/')
      parts.pop()
      let acc = ''
      for (const part of parts) {
        acc = acc === '' ? part : `${acc}/${part}`
        dirs.add(acc)
      }
    }
  }
  seed(options.notes ?? DEFAULT_NOTES)

  const mtimes = new Map<string, number>()
  const mtimeOf = (relPath: string): number => {
    const existing = mtimes.get(relPath)
    if (existing !== undefined) return existing
    const value = touch()
    mtimes.set(relPath, value)
    return value
  }

  const entries = (): EntryMeta[] => {
    const out: EntryMeta[] = []
    for (const dir of [...dirs].sort()) {
      out.push({
        relPath: dir,
        name: dir.split('/').pop() ?? dir,
        isDir: true,
        sizeBytes: 0,
        mtimeMs: null,
        ext: null,
      })
    }
    for (const note of [...files.values()].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
      const name = note.relPath.split('/').pop() ?? note.relPath
      const dot = name.lastIndexOf('.')
      out.push({
        relPath: note.relPath,
        name,
        isDir: false,
        sizeBytes: new TextEncoder().encode(note.text).length,
        mtimeMs: mtimeOf(note.relPath),
        ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : null,
      })
    }
    return out
  }

  const noteCount = (): number => [...files.keys()].filter(isMockMarkdown).length

  // 显式类型标注：让 TypeScript 的流程分析知道调用后不可达（从而正确收窄 note 等变量）
  const fail: (code: ErrorCode, message: string) => never = (code, message) => {
    throw new MimenoteError({ code, message, detail: null, currentMtimeMs: null })
  }

  const validate = (relPath: string): void => {
    if (relPath.trim() === '') fail('PATH_INVALID', '路径为空')
    if (relPath.startsWith('/') || /^[a-zA-Z]:/.test(relPath)) fail('PATH_INVALID', '不允许绝对路径')
    for (const segment of relPath.split('/')) {
      if (segment === '' || segment === '.' || segment === '..') {
        fail('PATH_INVALID', `非法路径段：${segment}`)
      }
    }
  }

  const sleep = async (): Promise<void> => {
    if (writeLatencyMs > 0) await new Promise((resolve) => setTimeout(resolve, writeLatencyMs))
  }

  return {
    kind: 'mock',
    dump: () => [...files.values()].map((n) => ({ ...n })),
    simulateExternalEdit: (relPath, text) => {
      const existing = files.get(relPath)
      if (existing === undefined) return
      files.set(relPath, { relPath, text })
      mtimes.set(relPath, touch())
    },
    async invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
      const a = args ?? {}
      switch (method) {
        case 'vault_open':
        case 'vault_snapshot': {
          const list = entries()
          const payload: VaultSnapshot = {
            rootPath,
            name: 'MockVault',
            entries: list,
            noteCount: noteCount(),
            folderCount: dirs.size,
            truncated: false,
            skipped: 0,
            scanMs: 3,
            generatedAtMs: Date.now(),
          }
          // vault_open 与 vault_snapshot 在契约上返回同一结构（见 commands.rs）
          return payload as T
        }
        case 'vault_info': {
          const info: VaultInfo = {
            rootPath,
            name: 'MockVault',
            entryCount: entries().length,
            noteCount: noteCount(),
            folderCount: dirs.size,
            truncated: false,
            skipped: 0,
            scanMs: 3,
          }
          return info as T
        }
        case 'vault_close':
          return undefined as T
        case 'startup_vault':
          return (options.startupVaultPath ?? null) as T
        case 'index_status': {
          const status: IndexStatus = {
            phase: 'ready',
            indexed: noteCount(),
            total: noteCount(),
            durationMs: 2,
            links: [...files.keys()].reduce(
              (sum, rel) => sum + buildMockNoteLinks(files, rel).outbound.length,
              0,
            ),
          }
          return status as T
        }
        case 'note_links': {
          const relPath = String(a.relPath ?? '')
          validate(relPath)
          return buildMockNoteLinks(files, relPath) as T
        }
        case 'note_read': {
          const relPath = String(a.relPath ?? '')
          validate(relPath)
          const note = files.get(relPath)
          if (note === undefined) fail('NOT_FOUND', `文件不存在：${relPath}`)
          const payload: NoteContent = {
            relPath,
            text: note.text,
            sizeBytes: new TextEncoder().encode(note.text).length,
            mtimeMs: mtimeOf(relPath),
          }
          return payload as T
        }
        case 'note_write': {
          const relPath = String(a.relPath ?? '')
          const text = String(a.text ?? '')
          const baseMtimeMs = a.baseMtimeMs === null || a.baseMtimeMs === undefined ? null : Number(a.baseMtimeMs)
          const force = a.force === true
          validate(relPath)
          await sleep()
          const current = mtimeOf(relPath)
          if (!force && baseMtimeMs !== null && baseMtimeMs !== current) {
            throw new MimenoteError({
              code: 'CONFLICT',
              message: '文件已被外部修改',
              detail: null,
              currentMtimeMs: current,
            })
          }
          files.set(relPath, { relPath, text })
          const next = touch()
          mtimes.set(relPath, next)
          const payload: WriteOutcome = {
            relPath,
            mtimeMs: next,
            sizeBytes: new TextEncoder().encode(text).length,
            writtenInMs: writeLatencyMs,
          }
          return payload as T
        }
        case 'note_create': {
          const parentRel = String(a.parentRel ?? '')
          const title = String(a.title ?? '').trim()
          const stem = (title === '' ? '未命名' : title).replace(/[\\/:*?"<>|]/g, '-')
          let candidate = parentRel === '' ? `${stem}.md` : `${parentRel}/${stem}.md`
          let attempt = 0
          while (files.has(candidate)) {
            attempt += 1
            candidate = parentRel === '' ? `${stem} ${attempt}.md` : `${parentRel}/${stem} ${attempt}.md`
          }
          validate(candidate)
          const text = title === '' ? '' : `# ${title}\n`
          files.set(candidate, { relPath: candidate, text })
          if (parentRel !== '') dirs.add(parentRel)
          const payload: NoteContent = {
            relPath: candidate,
            text,
            sizeBytes: new TextEncoder().encode(text).length,
            mtimeMs: mtimeOf(candidate),
          }
          return payload as T
        }
        case 'note_delete': {
          const relPath = String(a.relPath ?? '')
          if (a.confirm !== true) fail('CONFIRMATION_REQUIRED', '删除需要显式确认')
          validate(relPath)
          const note = files.get(relPath)
          if (note === undefined) fail('NOT_FOUND', `文件不存在：${relPath}`)
          files.delete(relPath)
          const record: TrashRecord = {
            id: `mock-${trashed.length + 1}`,
            originalRelPath: relPath,
            storedRelPath: `.mimenote/trash/mock-${trashed.length + 1}__${relPath.split('/').pop() ?? ''}`,
            deletedAtMs: Date.now(),
            sizeBytes: new TextEncoder().encode(note.text).length,
            isDir: false,
          }
          trashed.push(record)
          return record as T
        }
        case 'note_rename': {
          const relPath = String(a.relPath ?? '')
          const newTitle = String(a.newTitle ?? '').trim()
          const updateLinks = a.updateLinks !== false
          validate(relPath)
          const note = files.get(relPath)
          if (note === undefined) fail('NOT_FOUND', `文件不存在：${relPath}`)
          if (newTitle === '' || newTitle === '.' || newTitle === '..' || /[\\/:*?"<>|]/.test(newTitle)) {
            fail('PATH_INVALID', `非法文件名：${newTitle}`)
          }

          const dir = parentOf(relPath)
          const ext = extensionOf(relPath) === '' ? 'md' : extensionOf(relPath)
          const newRelPath = joinRel(dir, `${newTitle}.${ext}`)
          validate(newRelPath)
          if (newRelPath !== relPath && files.has(newRelPath)) {
            fail('ALREADY_EXISTS', `目标已存在：${newRelPath}`)
          }

          // ⚠️ 解析器必须基于**改名前**的文件表：改名之后 `[[旧名]]` 再也解析不到任何文件，
          // 就无法判断哪些链接原本指向它了（Rust 侧用的是索引里的改名前快照，同一个道理）。
          const resolver = updateLinks ? createMockResolver(files) : null

          files.delete(relPath)
          files.set(newRelPath, { relPath: newRelPath, text: note.text })
          const movedMtime = mtimeOf(relPath)
          mtimes.delete(relPath)
          mtimes.set(newRelPath, movedMtime)

          const updatedLinks: RenameLinkUpdate[] = []
          if (resolver !== null) {
            for (const from of [...files.keys()].sort()) {
              const current = files.get(from)
              if (current === undefined) continue
              const result = mockRewriteLinks(current.text, from, relPath, newRelPath, resolver)
              if (result.count === 0) continue
              files.set(from, { relPath: from, text: result.text })
              mtimes.set(from, touch())
              // 被改名文件**自身**的条目用**旧路径**上报：前端要在"改名前的坐标系"里判断
              // "我正在编辑的这一篇也被改写了"。Rust 侧（`mn_index::rename`）用的是同一口径，
              // 这里必须对齐，否则浏览器模式下自链接场景走不到"重新读取"分支。
              updatedLinks.push({ relPath: from === newRelPath ? relPath : from, count: result.count })
            }
          }

          const payload: RenameOutcome = {
            oldRelPath: relPath,
            newRelPath,
            newMtimeMs: mtimeOf(newRelPath),
            updatedLinks,
            updatedLinkCount: updatedLinks.reduce((sum, item) => sum + item.count, 0),
            elapsedMs: 1,
          }
          return payload as T
        }
        case 'note_tags': {
          const relPath = String(a.relPath ?? '')
          validate(relPath)
          const note = files.get(relPath)
          if (note === undefined) fail('NOT_FOUND', `文件不存在：${relPath}`)
          const frontmatter = mockParseFrontmatter(note.text)
          const payload: NoteTags = {
            relPath,
            tags: mockExtractTags(note.text),
            frontmatter: frontmatter === null ? [] : frontmatter.fields,
          }
          return payload as T
        }
        case 'tags_list': {
          const summary = new Map<string, { tag: string; count: number }>()
          for (const note of files.values()) {
            const counted = new Set<string>()
            for (const tag of mockExtractTags(note.text)) {
              const key = mockNormalizeTag(tag.tag)
              if (key === '' || counted.has(key)) continue
              counted.add(key)
              const existing = summary.get(key)
              if (existing === undefined) summary.set(key, { tag: tag.tag, count: 1 })
              else existing.count += 1
            }
          }
          const payload: TagSummary[] = [...summary.entries()]
            .map(([key, value]) => ({ key, tag: value.tag, count: value.count }))
            .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key))
          return payload as T
        }
        case 'tag_notes': {
          const key = mockNormalizeTag(String(a.key ?? ''))
          if (key === '') fail('PATH_INVALID', '标签为空')
          const notes = [...files.entries()]
            .filter(([, note]) =>
              mockExtractTags(note.text).some((tag) => mockNormalizeTag(tag.tag) === key),
            )
            .map(([rel]) => rel)
            .sort()
          const payload: TagNotes = { key, notes }
          return payload as T
        }
        case 'search_query': {
          const query = String(a.query ?? '')
          const limit = a.limit === undefined ? 50 : Number(a.limit)
          return mockSearch(files, query, limit) as T
        }
        case 'asset_authorize': {
          // 逐文件授权的 Mock（ADR-0007）：真实宿主用 `path_guard::resolve_existing` 逐级检查
          // 符号链接并拒绝越界；这里只做形状与最基础的越界拒绝 —— 浏览器预览不渲染本地图片，
          // 这个分支主要用于让契约保持完整（前端只有在 Tauri 运行时才会调用它）。
          const requested = Array.isArray(a.relPaths) ? a.relPaths : []
          const grants: AssetGrant[] = []
          for (const raw of requested) {
            const rel = String(raw)
            validate(rel)
            const separator = rootPath.includes('\\') ? '\\' : '/'
            grants.push({
              relPath: rel,
              absolutePath: `${rootPath.replace(/[\\/]+$/, '')}${separator}${rel.replaceAll('/', separator)}`,
              sizeBytes: new TextEncoder().encode(files.get(rel)?.text ?? '').length,
            })
          }
          return grants as T
        }
        case 'snippets_list': {
          const snippets = [
            { name: 'example.css', css: '.mn-preview h1 { letter-spacing: 0.02em; }', sizeBytes: 44 },
          ]
          return snippets as T
        }
        case 'note_stats': {
          const relPath = String(a.relPath ?? '')
          validate(relPath)
          const note = files.get(relPath)
          if (note === undefined) fail('NOT_FOUND', `文件不存在：${relPath}`)
          const payload = {
            relPath,
            sizeBytes: new TextEncoder().encode(note.text).length,
            mtimeMs: mtimeOf(relPath),
            stats: {
              chars: note.text.length,
              charsNoWhitespace: note.text.replace(/\s/g, '').length,
              words: note.text.split(/\s+/).filter((w) => w !== '').length,
              cjkChars: 0,
              lines: note.text === '' ? 0 : note.text.split('\n').length,
              readingMinutes: 1,
            },
          }
          return payload as T
        }
        case 'version_info': {
          const info = { app: '0.1.0', core: '0.1.0', tauri: 'mock' }
          return info as T
        }
        default:
          return fail('INTERNAL', `Mock 适配器未实现命令：${method}`)
      }
    },
  }
}
