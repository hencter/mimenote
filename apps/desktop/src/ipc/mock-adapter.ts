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
  AssetBytes,
  AssetGrant,
  AttachmentInput,
  AttachmentSaved,
  BacklinkRef,
  EntryMeta,
  ExportWriteOutcome,
  FrontmatterField,
  FrontmatterValue,
  GraphData,
  GraphEdge,
  GraphNode,
  IndexStatus,
  LinkKind,
  NoteContent,
  NoteLinks,
  NoteTags,
  RenameLinkUpdate,
  RenameOutcome,
  ResolvedLink,
  RestoreSummary,
  SearchHit,
  SearchResult,
  SetTagsOutcome,
  TagFilterResult,
  TagNotes,
  TagRef,
  TagRenameFile,
  TagRenameOutcome,
  TagRenameSkip,
  TagSource,
  TagSummary,
  TrashEntry,
  TrashRecord,
  VaultInfo,
  VaultSnapshot,
  WriteOutcome,
} from './types'
import { MimenoteError, type ErrorCode } from './types'
import type { IpcAdapter } from './client'
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BATCH_BYTES,
  MAX_ATTACHMENT_BYTES,
  estimatedDecodedBytes,
  uniqueAttachmentName,
} from '@/domain/attachments'
import { isImageAssetTarget } from '@/domain/assets'
import { normalizeLinkTarget, splitWikilink, wikilinkDisplayText } from '@/domain/links'
import { basename, extensionOf, joinRel, parentOf } from '@/domain/paths'

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
  // 专门用来演示「大纲面板」的笔记（多级标题 + 一个代码块里的伪标题）：
  // 其它用例请勿依赖它的内容。
  {
    relPath: '项目/大纲.md',
    text: [
      '# 大纲示例',
      '',
      '开头一段。',
      '',
      '## 第一节',
      '',
      '内容一。',
      '',
      '### 小节',
      '',
      '```md',
      '# 这是代码块里的伪标题',
      '```',
      '',
      '## 第二节',
      '',
      '内容二。',
      '',
    ].join('\n'),
  },
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

/**
 * 把"相对某个目录写的目标"归一化成 Vault 根口径的键（`..`/`.` 走位后拼平）。
 *
 * 为什么必须有它：跨目录移动会把链接改写成 `[[../日记/设计]]` 这种**相对路径**，
 * 而解析器原来的实现把带 `/` 的目标直接当成"从 Vault 根起算"，于是"移动后链接变成悬空"
 * 这种假象就会出现 —— Mock 与 Rust（`mn_core::links::join_relative`）在这一步必须同口径。
 */
function resolveRelativeKey(fromDir: string, key: string): string {
  const parts = fromDir === '' ? [] : fromDir.split('/')
  for (const segment of key.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  return parts.join('/')
}

/** 链接解析器：`(来源文件, 原始目标)` → 命中的笔记。 */
type MockResolver = (from: string, raw: string) => { path: string | null; ambiguous: boolean }

/**
 * 构建解析器（一次遍历建立 stem 索引，避免在批量改写时反复重建）。
 *
 * 规则与 `mn-index` 对齐：裸名走 stem 索引 + 消歧；带路径的**先按相对来源文件目录解析**，
 * 再按相对 Vault 根解析，最后退化到路径后缀匹配。
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
      const relative = resolveRelativeKey(parentOf(from), key)
      const direct =
        all.find((candidate) => normalizeLinkTarget(candidate) === relative) ??
        all.find((candidate) => normalizeLinkTarget(candidate) === key)
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
 * - `alwaysRelative`（**跨目录移动**）→ 一律走相对路径分支：文件换了目录之后，
 *   裸名链接会被"同目录优先"的消歧规则重新解释，可能落到另一篇同名笔记上；
 *   同目录换算天然退化成裸文件名，不必写特例；
 * - Markdown 链接沿用"原来带不带扩展名"的写法。
 */
function mockRewriteLinks(
  text: string,
  fromRelPath: string,
  oldRelPath: string,
  newRelPath: string,
  resolver: MockResolver,
  alwaysRelative = false,
): { text: string; count: number } {
  const newName = newRelPath.split('/').pop() ?? newRelPath
  const newStem = newName.replace(/\.(md|markdown)$/i, '')
  const newExt = extensionOf(newRelPath) === '' ? 'md' : extensionOf(newRelPath)
  // 相对路径按**去扩展名**的目标算，扩展名由"原来带不带"决定 ——
  // 与 Rust 侧 `relative_posix(from_dir, style.new_rel_no_ext)` + 按需补 `new_ext` 同一口径
  // （否则 wikilink 会被写成 `[[../目录/名.md]]`，而 Rust 写的是 `[[../目录/名]]`）。
  const newRelNoExt = newRelPath.replace(/\.(md|markdown)$/i, '')
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
      const target =
        alwaysRelative || key.includes('/')
          ? `${relativeRelPath(fromDir, newRelNoExt)}${suffix}`
          : `${newStem}${suffix}`
      out += line.slice(cursor, link.start) + rebuildLink(line, link, target)
      cursor = link.end
      count += 1
    }
    return out + line.slice(cursor)
  })

  return { text: lines.join('\n'), count }
}

/**
 * 目录搬迁：把一整棵子树从 `oldDir` 换到 `newDir`，并改写全库指向子树里每一篇的链接。
 *
 * 与 Rust（`mn-index/src/dir_move.rs`）**同一套语义**，逐条对齐：
 *
 * 1. 候选集 = "索引解析到子树里的那几条" ∪ "子树里每一篇自身"（后者的相对路径会随目录变）；
 * 2. 每条链接的落点 = `索引解析到的目标` 或 `相对本文件旧目录的路径算术`，再过一遍前缀映射；
 * 3. 用**本文件改写后的目录**重新表达；结果与原文一字不差就不写盘（子树内部保持最小 diff）；
 * 4. 裸名 wikilink 只在"原本就指向子树里的某篇"时改，且改成新文件名主干。
 *
 * 为什么不复用 `mockRewriteLinks`：那个函数是"单篇搬迁"的形状（一个旧目标 → 一个新目标），
 * 而目录搬迁要按**前缀**判断"这条链接是否落在被搬走的子树里"。两套形状各写一份是必要的，
 * 但**目标写法规则**（`relativeRelPath` + 保留裸名/扩展名写法）仍然共用同一份。
 */
function mockRewriteDirLinks(options: {
  files: Map<string, MockNote>
  oldDir: string
  newDir: string
  updateLinks: boolean
}): RenameLinkUpdate[] {
  const { files, oldDir, newDir, updateLinks } = options
  if (!updateLinks) return []

  const resolver = createMockResolver(files)
  const inside = (rel: string): boolean => rel === oldDir || rel.startsWith(`${oldDir}/`)
  const remap = (rel: string): string =>
    rel === oldDir ? newDir : `${newDir}${rel.slice(oldDir.length)}`

  /** 这条链接**改写后**落在哪个 Vault 根相对路径上（`undefined` = 不碰它）。 */
  const landingOf = (from: string, raw: string): string | undefined => {
    const resolved = resolver(from, raw).path
    if (resolved !== null) {
      // 解析到子树之外：按相对本文件旧目录的路径算术（索引没有"越界改写"的权限）
      return inside(resolved) ? remap(resolved) : undefined
    }
    const key = normalizeLinkTarget(raw)
    const folded = resolveRelativeKey('', key)
    if (inside(folded)) return remap(folded)
    return undefined
  }

  const updated: RenameLinkUpdate[] = []
  const writes: Array<{ from: string; text: string }> = []

  for (const [from, note] of files) {
    const fromAfter = inside(from) ? remap(from) : from
    const newDirOfFrom = parentOf(fromAfter)

    let inFence = false
    let count = 0
    const nextLines = note.text.split('\n').map((line) => {
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
        const bare = !normalizeLinkTarget(link.raw).includes('/')
        const landing = landingOf(from, link.raw)
        if (landing === undefined) continue

        const replacement = bare
          ? mockBareDirTarget(landing, newDirOfFrom)
          : mockPathDirTarget(link, landing, newDirOfFrom)
        if (replacement === null || replacement === link.raw) continue

        out += line.slice(cursor, link.start) + rebuildLink(line, link, replacement)
        cursor = link.end
        count += 1
      }
      return out + line.slice(cursor)
    })

    if (count === 0) continue
    writes.push({ from, text: nextLines.join('\n') })
    // 被改写的文件按**旧路径**上报（与 Rust 同一口径：前端在搬迁前的坐标系里对账）
    updated.push({ relPath: from, count })
  }

  for (const write of writes) {
    const existing = files.get(write.from)
    if (existing === undefined) continue
    files.set(write.from, { relPath: write.from, text: write.text })
  }
  return updated
}

/** 裸名 wikilink 在目录搬迁后的写法：同层保持裸名，跨层写成相对路径。 */
function mockBareDirTarget(landing: string, newDirOfFrom: string): string {
  const stem = (landing.split('/').pop() ?? landing).replace(/\.(md|markdown)$/i, '')
  if (parentOf(landing) === newDirOfFrom) return stem
  return relativeRelPath(newDirOfFrom, landing.replace(/\.(md|markdown)$/i, ''))
}

/** 路径形式的链接在目录搬迁后的写法（保留 `[[x]]` 不加扩展名的惯例）。 */
function mockPathDirTarget(link: ScannedLink, landing: string, newDirOfFrom: string): string | null {
  const keepsExtension = link.form === 'markdown' && /\.(md|markdown)$/i.test(link.raw)
  const noExt = landing.replace(/\.(md|markdown)$/i, '')
  const target = relativeRelPath(newDirOfFrom, noExt)
  if (!keepsExtension) return target
  const ext = extensionOf(landing)
  return ext === '' ? target : `${target}.${ext}`
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
    // `[...]` 一律是数组，**空数组 `[]` 也算**（Rust 的 `FrontmatterValue::List(vec![])`）。
    // 少了这一条，"删掉最后一个标签"留下的 `tags: []` 会被当成一个名叫 `[]` 的标量标签
    const isList = value.startsWith('[') && value.endsWith(']')
    fields.push({
      key: raw.slice(0, colon).trim(),
      value: isList ? { kind: 'list', value: inline } : classifyFrontmatterValue(value),
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
  return mockScanInlineTagSpans(bodyLines, lineOffset).map((span) => ({
    tag: span.tag,
    source: 'inline',
    line: span.line,
  }))
}

/**
 * 正文里一个行内标签的位置（**行内字符偏移**，`start` 指向 `#`）。
 *
 * 抽取与改写共用同一个扫描器（Rust 侧同样是这个纪律）：判据只写一遍，
 * "抽出来的标签改了、另一处没改"这种不一致才不会出现。
 */
interface MockTagSpan {
  tag: string
  /** 全文绝对行号（1 起）。 */
  line: number
  /** 在 `bodyLines` 里的下标。 */
  row: number
  start: number
  end: number
}

function mockScanInlineTagSpans(bodyLines: readonly string[], lineOffset: number): MockTagSpan[] {
  const out: MockTagSpan[] = []
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
          out.push({ tag: raw, line: lineOffset + row + 1, row, start: index, end })
        }
      }
      index = Math.max(end, index + 1)
    }
  }
  return out
}

/**
 * 在既有的 frontmatter 标签上做增删（Rust 侧 `mn_core::tags::apply_tag_edits` 的镜像）。
 *
 * 判同走 {@link mockNormalizeTag}：既有项的写法与顺序原样保留，`add` 会先清理
 * （去首尾空白与开头的 `#`、折叠连续空白），已经存在的不重复加入。
 */
function mockApplyTagEdits(
  existing: readonly string[],
  add: readonly string[],
  remove: readonly string[],
): string[] {
  const removed = new Set(remove.map((raw) => mockNormalizeTag(raw)).filter((key) => key !== ''))
  const out: string[] = []
  const seen = new Set<string>()

  for (const tag of existing) {
    const key = mockNormalizeTag(tag)
    if (key === '' || removed.has(key) || seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  for (const raw of add) {
    const tag = raw
      .trim()
      .replace(/^#+/, '')
      .trim()
      .split(/\s+/)
      .filter((part) => part !== '')
      .join(' ')
    if (tag === '') continue
    const key = mockNormalizeTag(tag)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out
}

/** 需要引号才能被读回来的标签（含空格/逗号/冒号等）——与 Rust 的 `needs_quote` 同口径的简化版。 */
function mockFormatTag(tag: string): string {
  return /^[\p{L}\p{N}_\-/.]+$/u.test(tag) ? tag : `'${tag.replace(/'/g, "''")}'`
}

/**
 * 把整篇文本的 `tags`/`tag` 字段改写成 `wanted`（Rust 侧 `mn_core::frontmatter::set_tags_or_create`
 * 的镜像）。
 *
 * ⚠️ 权威实现永远在 Rust：这里只覆盖面板真实会遇到的几种形态（行内数组 / 标量 / 块数组 /
 * 空值 / 没有 tags 字段 / 没有 frontmatter），为的是让 UI 层测试与浏览器预览**不是假绿** ——
 * `note_tags` 与 `tags_list` 都是从文本现算的，所以只要这里真的改了文本，面板就真的会变。
 * 保真纪律与 Rust 一致：只动 tags 那几行，BOM/CRLF/注释/未知键/字段顺序一律不动。
 */
function mockSetTags(text: string, add: readonly string[], remove: readonly string[]): string {
  const lines = text.split('\n')
  const bom = lines[0]?.startsWith('\u{feff}') === true ? '\u{feff}' : ''
  const bare = (line: string | undefined): string => (line ?? '').replace(/\r$/, '')
  const cr = (line: string | undefined): string => ((line ?? '').endsWith('\r') ? '\r' : '')

  // frontmatter 区块：首行（允许 BOM）是 `---`，且后面还有一行 `---`
  let end = -1
  if (bare(lines[0]).replace(bom, '').trim() === '---') {
    for (let index = 1; index < lines.length; index += 1) {
      if (bare(lines[index]).trim() === '---') {
        end = index
        break
      }
    }
  }

  // 写入目标：优先 `tags`（**无论它在文档里的位置**），其次 `tag` —— 与 Rust 的 `set_tags`
  // 落点一致（那里先 `find("tags")` 再 `find("tag")`）。写成"取第一行匹配的字段"会在
  // `tag:` 写在 `tags:` 前面时选错字段，于是"删不掉的标签"这个已知边界会表现成另一副样子
  const target = (() => {
    let fallback: { index: number; key: string; rest: string } | null = null
    for (let index = 1; index < end; index += 1) {
      const match = /^(tags|tag)\s*:(.*)$/.exec(bare(lines[index]))
      if (match === null) continue
      const candidate = { index, key: match[1] ?? 'tags', rest: match[2] ?? '' }
      if (candidate.key === 'tags') return candidate
      fallback ??= candidate
    }
    return fallback
  })()

  // **可编辑的那一份**（`mn_core::frontmatter::editable_tags` 的镜像）：只有写入目标**这一个**
  // 字段里的标签。用两个字段合并后的列表去改写，会把 `tag:` 里的标签复制进 `tags:`，
  // 而它自己又永远删不掉 —— 真实现刻意把"显示（合并）"与"改写（单字段）"分开，这里必须跟住
  const existing: string[] = (() => {
    if (target === null) return []
    const field = (mockParseFrontmatter(text)?.fields ?? []).find(
      (entry) => entry.key === target.key,
    )
    if (field === undefined) return []
    if (field.value.kind === 'list') return [...field.value.value]
    if (field.value.kind === 'scalar' || field.value.kind === 'number') {
      return field.value.value
        .split(',')
        .map((part) => stripQuotes(part))
        .filter((part) => part !== '')
    }
    return []
  })()

  const wanted = mockApplyTagEdits(existing, add, remove)
  const eol = lines[0]?.includes('\r') === true || text.includes('\r\n') ? '\r' : ''

  // 没有 frontmatter：有标签才补区块（正文一行都不吞）
  if (end <= 0) {
    if (wanted.length === 0) return text
    // 正文那几行原样搬过去，只把 BOM 从原来的首行挪到新的首行
    const body = [...lines]
    if (bom !== '') body[0] = (body[0] ?? '').slice(1)
    return [
      `${bom}---${eol}`,
      // 补区块时一律写行内数组（与 Rust 的 `set_tags_or_create` 一致：单个标签也带方括号）
      `tags: [${wanted.map(mockFormatTag).join(', ')}]${eol}`,
      `---${eol}`,
      ...body,
    ].join('\n')
  }

  const formatted = wanted.map(mockFormatTag)
  if (target === null) {
    if (wanted.length === 0) return text
    lines.splice(end, 0, `tags: [${formatted.join(', ')}]${eol}`)
    return lines.join('\n')
  }
  const raw = bare(lines[target.index])
  const value = target.rest.trim()
  const comment = value.startsWith('#') ? target.rest.trimEnd() : ''
  const trail = cr(lines[target.index])
  const written = wanted.length === 1 ? (formatted[0] ?? '') : `[${formatted.join(', ')}]`

  // 行内数组：只换 `[...]` 这一段（同一行上的行尾注释原样保留）
  const open = raw.indexOf('[', raw.indexOf(':'))
  const close = raw.lastIndexOf(']')
  if (open >= 0 && close > open) {
    lines[target.index] = `${raw.slice(0, open)}[${formatted.join(', ')}]${raw.slice(close + 1)}${trail}`
    return lines.join('\n')
  }

  if (value !== '' && comment === '') {
    // 标量：0 或 ≥2 个标签写成行内数组，1 个仍是标量
    const hash = value.indexOf(' #')
    const tail = hash >= 0 ? value.slice(hash) : ''
    lines[target.index] = `${target.key}: ${written}${tail}${trail}`
    return lines.join('\n')
  }

  // 空值：看后面紧跟的 `- item` 行是不是它的块数组
  const items: number[] = []
  for (let index = target.index + 1; index < end; index += 1) {
    if (/^\s*-\s+/.test(bare(lines[index]))) items.push(index)
    else break
  }
  if (items.length > 0) {
    const first = items[0] ?? 0
    const indent = /^(\s*)/.exec(bare(lines[first]))?.[1] ?? ''
    // 项行沿用**原来第一项**的缩进与行尾（最后一项整行删掉时不留空行）
    const replacement = formatted.map((tag) => `${indent}- ${tag}${cr(lines[first])}`)
    lines.splice(first, items.length, ...replacement)
    return lines.join('\n')
  }
  if (wanted.length === 0) return text
  lines[target.index] = `${target.key}: ${written}${comment}${trail}`
  return lines.join('\n')
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
// Mock 的标签改名/合并（`mn_core::tags::rename_tags` 的**简化镜像**）
//
// ⚠️ 权威实现永远在 Rust 侧（`crates/mn-core/src/tags.rs`）：判同、层级、去重、
// 跳过判据都在那里，并且由单测逐条钉住。这里只保证"浏览器预览与 UI 层测试不是假绿"：
// `note_tags` / `tags_list` 都是从文本现算的，所以只要这里真的改了文本，面板就真的会变。
//
// 两处刻意的简化（Rust 侧做得更细，测试也只在那里覆盖）：
// * 键名比较区分大小写（Rust 大小写不敏感）：`Tags:` 这类写法这里不认识；
// * 只在写入目标字段上改写（Rust 会把 `tags` 与 `tag` 两个字段都改一遍）。
// ---------------------------------------------------------------------------

/** 一次改名的映射（`mn_core::tags::TagRename` 的镜像）。 */
interface MockTagMapping {
  fromKey: string
  toDisplay: string
  toKey: string
  includeChildren: boolean
}

function mockTagMapping(from: string, to: string, includeChildren: boolean): MockTagMapping | null {
  const fromKey = mockNormalizeTag(from)
  const toDisplay = to
    .trim()
    .replace(/^#+/, '')
    .trim()
    .split(/\s+/)
    .filter((part) => part !== '')
    .join(' ')
  if (fromKey === '' || toDisplay === '') return null
  return { fromKey, toDisplay, toKey: mockNormalizeTag(toDisplay), includeChildren }
}

/** 「把标签挂到某个父标签下」的判定结果（`mn_core::tag_move_target` 的镜像）。 */
type MockTagMove = { ok: true; toKey: string } | { ok: false; reason: string }

/**
 * 「把标签移到某个父标签下」（`parent` 为空 = 提回**顶层**）算出来的目标键；
 * 非法移动返回**给用户看的原因**。
 *
 * 拒绝理由逐字对齐 Rust 侧 —— 界面把宿主的那句话直接显示出来，两处要是措辞不同，
 * 浏览器预览里看到的就不是真机上会看到的。规则只有三条：只换祖先不动名字、
 * 空父标签 = 提回顶层、目标与源相同要明确拒绝（而不是静默当成功）。
 */
function mockTagMoveTarget(key: string, parent: string): MockTagMove {
  const fromKey = mockNormalizeTag(key)
  if (fromKey === '') return { ok: false, reason: '标签名称为空，无法调整层级' }
  const segments = fromKey.split('/')
  const leaf = segments[segments.length - 1] ?? fromKey

  // 首尾的 `/` 容忍（常见输入滑手），只有**中间的空段**才拒绝：`父//子` 归一化之后
  // 会变成 `父/子`，与用户看到的东西不是一回事，宁可不猜。
  const trimmedParent = parent
    .trim()
    .replace(/^#+/, '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
  if (trimmedParent.includes('//')) {
    return { ok: false, reason: '父标签里不能有空的层级（`父//子`）' }
  }

  const parentKey = mockNormalizeTag(parent)
  if (parentKey === fromKey) return { ok: false, reason: '不能把标签挂到它自己下面' }
  if (parentKey.startsWith(`${fromKey}/`)) {
    return { ok: false, reason: '不能把标签挂到它自己的子标签下面（会造出改不完的层级）' }
  }

  const toKey = parentKey === '' ? leaf : `${parentKey}/${leaf}`
  if (toKey === fromKey) return { ok: false, reason: '它已经在那个父标签下面了' }
  return { ok: true, toKey }
}

/** 取子标签里源标签那一段**之后**的原文；不是后代 → `null`。 */
function mockDescendantSuffix(tag: string, fromKey: string): string | null {
  const depth = fromKey.split('/').length
  const segments = tag
    .trim()
    .replace(/^#+/, '')
    .trim()
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '')
  if (segments.length <= depth) return null
  if (mockNormalizeTag(segments.slice(0, depth).join('/')) !== fromKey) return null
  return segments.slice(depth).join('/')
}

/** 单个标签在这个映射下变成什么；不受影响 → `null`（`TagRename::apply` 的镜像）。 */
function mockApplyTagMapping(tag: string, mapping: MockTagMapping): string | null {
  const key = mockNormalizeTag(tag)
  if (key === '') return null
  if (key === mapping.fromKey) return mapping.toDisplay
  if (!mapping.includeChildren) return null
  const suffix = mockDescendantSuffix(tag, mapping.fromKey)
  return suffix === null ? null : `${mapping.toDisplay}/${suffix}`
}

/** 一个标签字段在原文里的形态（用于"改完写回去时保持原样"）。 */
type MockTagFieldStyle = 'inline' | 'scalar' | 'block' | 'empty'

interface MockTagField {
  index: number
  key: string
  rest: string
  style: MockTagFieldStyle
  items: string[]
  /** `block`：项行下标（本行之后紧跟的那些）。 */
  itemRows: number[]
}

/** 找出 frontmatter 区块里的标签字段（`tags` 在前、`tag` 在后，与面板的显示口径一致）。 */
function mockTagFields(lines: readonly string[], end: number): MockTagField[] {
  const bare = (line: string | undefined): string => (line ?? '').replace(/\r$/, '')
  const out: MockTagField[] = []
  for (let index = 1; index < end; index += 1) {
    const match = /^(tags|tag)\s*:(.*)$/.exec(bare(lines[index]))
    if (match === null) continue
    const rest = match[2] ?? ''
    const value = rest.trim()

    // 行内数组：`tags: [甲, 乙]`（也可能是空数组 `[]`）
    if (value.startsWith('[') && value.endsWith(']')) {
      out.push({ index, key: match[1] ?? 'tags', rest, style: 'inline', items: parseInlineList(value), itemRows: [] })
      continue
    }
    // 标量：`tags: 甲` 或 `tags: 甲, 乙`
    if (value !== '' && !value.startsWith('#')) {
      out.push({
        index,
        key: match[1] ?? 'tags',
        rest,
        style: 'scalar',
        items: value
          .split(',')
          .map((part) => stripQuotes(part))
          .filter((part) => part !== ''),
        itemRows: [],
      })
      continue
    }
    // 空值 + 紧跟的 `- item` 行（空行/注释行/别的字段都会结束这个块数组）
    const itemRows: number[] = []
    for (let row = index + 1; row < end; row += 1) {
      const item = /^\s*-\s+(.*)$/.exec(bare(lines[row]))
      if (item === null) break
      itemRows.push(row)
    }
    out.push({
      index,
      key: match[1] ?? 'tags',
      rest,
      style: itemRows.length > 0 ? 'block' : 'empty',
      items: itemRows.map((row) => stripQuotes(/^\s*-\s+(.*)$/.exec(bare(lines[row]))?.[1] ?? '')),
      itemRows,
    })
  }
  return out
}

/**
 * 把 frontmatter 里每个标签字段按 `map` 改写（`frontmatter::rename_tag_fields` 的镜像）。
 *
 * 只动字段自己的那几个字节：块数组仍写项行（缩进沿用原第一项）、行内数组只换 `[...]`、
 * 单个标签仍是标量、BOM/CRLF/注释/未知键/字段顺序一律不动。
 */
function mockRenameTagFields(
  text: string,
  mapping: MockTagMapping,
): { text: string; edits: number } {
  const lines = text.split('\n')
  const bare = (line: string | undefined): string => (line ?? '').replace(/\r$/, '')
  const cr = (line: string | undefined): string => ((line ?? '').endsWith('\r') ? '\r' : '')

  let end = -1
  if (bare(lines[0]).replace(/^\u{feff}/u, '').trim() === '---') {
    for (let index = 1; index < lines.length; index += 1) {
      if (bare(lines[index]).trim() === '---') {
        end = index
        break
      }
    }
  }
  if (end <= 0) return { text, edits: 0 }

  let edits = 0
  // 从后往前改：字段的项行区间互不重叠，倒序处理不会打乱前面的下标
  for (const field of [...mockTagFields(lines, end)].reverse()) {
    const wanted: string[] = []
    const seen = new Set<string>()
    let fieldEdits = 0
    for (const item of field.items) {
      const mapped = mockApplyTagMapping(item, mapping) ?? item
      const key = mockNormalizeTag(mapped)
      if (key === '' || seen.has(key)) {
        fieldEdits += 1
        continue
      }
      seen.add(key)
      if (mapped !== item) fieldEdits += 1
      wanted.push(mapped)
    }
    if (fieldEdits === 0) continue
    edits += fieldEdits

    const formatted = wanted.map(mockFormatTag)
    if (field.style === 'block') {
      // `block` 一定有项行（没有项行的空值字段是 `empty`）
      const first = field.itemRows[0] ?? field.index + 1
      const indent = /^(\s*)/.exec(bare(lines[first]))?.[1] ?? ''
      const replacement = formatted.map((tag) => `${indent}- ${tag}${cr(lines[first])}`)
      lines.splice(first, field.itemRows.length, ...replacement)
      continue
    }
    if (field.style === 'inline') {
      const raw = bare(lines[field.index])
      const open = raw.indexOf('[', raw.indexOf(':'))
      const close = raw.lastIndexOf(']')
      if (open >= 0 && close > open) {
        lines[field.index] =
          `${raw.slice(0, open)}[${formatted.join(', ')}]${raw.slice(close + 1)}${cr(lines[field.index])}`
      }
      continue
    }
    if (field.style === 'scalar') {
      // 1 个标签仍是标量，0 或 ≥2 个变成行内数组（与 Rust 的 `set_tags` 同口径）
      const written = wanted.length === 1 ? (formatted[0] ?? '') : `[${formatted.join(', ')}]`
      lines[field.index] = `${field.key}: ${written}${cr(lines[field.index])}`
    }
  }

  return { text: lines.join('\n'), edits }
}

/**
 * 一次标签改名/合并在**一整篇文本**上的结果（`mn_core::tags::rename_tags` 的镜像）。
 * 一个字都不用改 → `null`。
 */
function mockRenameTags(
  text: string,
  mapping: MockTagMapping,
): { text: string; frontmatterEdits: number; inlineEdits: number; inlineRemoved: number } | null {
  // 原文里出现过的全部标签键：合并时用它回答"目标标签是不是已经在别处出现"
  const present = new Set(
    mockExtractTags(text)
      .map((tag) => mockNormalizeTag(tag.tag))
      .filter((key) => key !== ''),
  )
  const merging = mapping.toKey !== mapping.fromKey

  const fields = mockRenameTagFields(text, mapping)
  let current = fields.text
  let inlineEdits = 0
  let inlineRemoved = 0

  // 正文（frontmatter 之后）里的行内标签：跳过判据与抽取器同源
  const all = current.split('\n')
  const bodyStart = mockParseFrontmatter(current)?.lines ?? 0
  const spans = mockScanInlineTagSpans(all.slice(bodyStart), bodyStart)
  const byRow = new Map<number, MockTagSpan[]>()
  for (const span of spans) {
    const list = byRow.get(span.row)
    if (list === undefined) byRow.set(span.row, [span])
    else list.push(span)
  }

  for (const [row, rowSpans] of byRow) {
    const absolute = bodyStart + row
    const hasCr = (all[absolute] ?? '').endsWith('\r')
    const line = (all[absolute] ?? '').replace(/\r$/, '')
    const chars = [...line]
    const ranges: Array<{ start: number; end: number; text: string }> = []

    for (const span of rowSpans) {
      const mapped = mockApplyTagMapping(span.tag, mapping)
      if (mapped === null) continue
      const key = mockNormalizeTag(mapped)
      if (merging && present.has(key)) {
        let from = span.start
        let to = span.end
        let after = span.end
        while (after < chars.length && (chars[after] === ' ' || chars[after] === '\t')) after += 1
        if (after > span.end) {
          to = after
        } else {
          while (from > 0 && (chars[from - 1] === ' ' || chars[from - 1] === '\t')) from -= 1
        }
        ranges.push({ start: from, end: to, text: '' })
        inlineRemoved += 1
        continue
      }
      if (mapped === span.tag) continue
      ranges.push({ start: span.start, end: span.end, text: `#${mapped}` })
      inlineEdits += 1
    }

    if (ranges.length === 0) continue
    let rebuilt = ''
    let cursor = 0
    for (const range of ranges) {
      rebuilt += chars.slice(cursor, range.start).join('')
      rebuilt += range.text
      cursor = range.end
    }
    rebuilt += chars.slice(cursor).join('')
    all[absolute] = hasCr ? `${rebuilt}\r` : rebuilt
  }

  current = all.join('\n')
  if (fields.edits === 0 && inlineEdits === 0 && inlineRemoved === 0) return null
  return {
    text: current,
    frontmatterEdits: fields.edits,
    inlineEdits,
    inlineRemoved,
  }
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

// ---------------------------------------------------------------------------
// Mock 的导出支持（`asset_read_base64` / `export_write_html`）
//
// 权威实现在 Rust 侧（`src-tauri/src/assets.rs`、`src-tauri/src/export.rs`），这里只是
// "形状与校验口径的镜像"：浏览器预览（`pnpm dev`）不写真实文件，UI 层测试也只需要
// 拿到契约形状的数据。**扩展名白名单与大小上限刻意与宿主保持一致** —— 两边漂移的话，
// 测试会绿得毫无意义。
// ---------------------------------------------------------------------------

/** Mock 里"扩展名 → MIME"的白名单（与 `ALLOWED_IMAGE_EXTENSIONS` 逐字对齐）。 */
const MOCK_IMAGE_MIMES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
}

/** 导出文件扩展名白名单（与宿主 `ALLOWED_EXPORT_EXTENSIONS` 一致）。 */
const MOCK_EXPORT_EXTENSIONS: readonly string[] = ['html', 'htm']

/** 导出大小上限（与宿主 `MAX_EXPORT_BYTES` 一致）。 */
const MOCK_MAX_EXPORT_BYTES = 32 * 1024 * 1024

/** 字节 → 标准 base64（Mock 里用 `btoa` 即可，不追求大文件性能）。 */
function mockBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** 取小写扩展名（不含点）；没有扩展名返回空串。 */
function mockExtensionOf(relPath: string): string {
  const name = relPath.split('/').pop() ?? relPath
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

// ---------------------------------------------------------------------------
// Mock 的附件写入（`attachment_save`）
//
// 权威实现在 Rust 侧（`src-tauri/src/attachments.rs`，见 ADR-0013），这里只镜像**能观察到的
// 行为**：白名单、三道上限、命名去重、附件目录、返回契约。之所以要镜像而不是"随便返回个成功"：
// UI 层 E2E 与组件测试都跑在这个适配器上，"Mock 说成功、真实宿主却拒绝"是最难查的一类假绿
// （与 `asset_read_base64` / `export_write_html` 两个 Mock 分支同一约定）。
// ---------------------------------------------------------------------------

/** 一次最多接受的张数（与宿主 `MAX_ATTACHMENTS_PER_REQUEST` 一致）。 */
const MOCK_MAX_ATTACHMENTS = MAX_ATTACHMENTS

/** 标准 base64 → 字节；非法输入返回 `null`（与宿主 `assets::base64_decode` 的严格口径一致）。 */
function mockDecodeBase64(encoded: string): Uint8Array | null {
  if (encoded.length % 4 !== 0) return null
  try {
    const binary = atob(encoded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  } catch {
    // `atob` 对白名单外字符会抛：在 Mock 里就是"载荷非法"
    return null
  }
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
  /**
   * 二进制附件（图片）单独存一张表：`files` 里的 `text` 是"笔记正文"，全文搜索、链接抽取、
   * 标签抽取都按它遍历 —— 把二进制塞进去等于让这些路径也开始处理图片。
   */
  const binaries = new Map<string, Uint8Array>()
  const trashed: TrashRecord[] = []
  /** 被删笔记的正文（`id → text`）：Mock 没有真文件系统，但"恢复后内容逐字回来"要成立。 */
  const removedTexts = new Map<string, string>()
  /** 被删/被恢复时"曾经存在过的目录"：Mock 用了扁平的文件表，目录需要单独记一笔。 */
  const trashDirs = new Set<string>()
  /** 台账里的记录现在还算不算"东西还在"（模拟用户在文件管理器里清过回收站）。 */
  const goneFromTrash = new Set<string>()
  const presentInTrash = (record: TrashRecord): boolean => !goneFromTrash.has(record.id)
  let clock = Date.now()

  const touch = (): number => {
    clock += 1
    return clock
  }

  const seed = (list: MockNote[]): void => {
    files.clear()
    dirs.clear()
    binaries.clear()
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
    // 图片附件（粘贴/拖入落下来的）：形状与扫描结果一致（大小按字节、ext 小写），
    // 这样文件树与过滤逻辑不需要知道"这条是笔记还是附件"
    for (const [relPath, bytes] of [...binaries.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const name = relPath.split('/').pop() ?? relPath
      const dot = name.lastIndexOf('.')
      out.push({
        relPath,
        name,
        isDir: false,
        sizeBytes: bytes.length,
        mtimeMs: mtimeOf(relPath),
        ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : null,
      })
    }
    return out
  }

  const noteCount = (): number => [...files.keys()].filter(isMockMarkdown).length

  // -- 目录搬迁的小工具（闭包内，直接读 `files` / `dirs` 两张表） --------------
  //
  // 与 Rust 的 `mn_index::path_inside` 同一纪律：`归档2` 以 `归档` 开头却**不是**它的后代，
  // 用 `startsWith(oldDir)` 一把梭会在"移动整棵子树"时动错目录。

  /** `rel` 是否在目录 `dir` 之内（`dir === ''` = Vault 根，任何路径都在内）。 */
  const insideDir = (rel: string, dir: string): boolean =>
    dir === '' || rel === dir || rel.startsWith(`${dir}/`)

  /** 把已在 `oldDir` 之内的路径映射到 `newDir` 下。 */
  const remapPrefix = (rel: string, oldDir: string, newDir: string): string => {
    const rest = oldDir === '' ? rel : rel === oldDir ? '' : rel.slice(oldDir.length + 1)
    return rest === '' ? newDir : newDir === '' ? rest : `${newDir}/${rest}`
  }

  /** 子树里每个文件的旧 → 新相对路径（字典序，测试可复现）。 */
  const relocateTree = (oldDir: string, newDir: string): Array<{ from: string; to: string }> =>
    [...files.keys()]
      .filter((rel) => insideDir(rel, oldDir))
      .sort()
      .map((from) => ({ from, to: remapPrefix(from, oldDir, newDir) }))

  /** 目录表里 `oldDir` 及其所有后代换成 `newDir` 前缀（拖拽后树里不能留着旧目录）。 */
  const remapDirs = (oldDir: string, newDir: string): void => {
    const doomed = [...dirs].filter((dir) => insideDir(dir, oldDir))
    for (const dir of doomed) dirs.delete(dir)
    for (const dir of doomed) dirs.add(remapPrefix(dir, oldDir, newDir))
  }

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

  /**
   * 全库标签改写的**共用实现**：`tag_rename` 与 `tag_move` 只差"目标键怎么算出来"
   * （前者直接用用户输入，后者由 `mockTagMoveTarget` 从父标签推），从"哪些笔记进了候选集"
   * 到"逐篇汇报了什么"这一段必须是**同一份** —— 分开写两份，结果界面就会在两处慢慢漂移。
   *
   * 刻意**永远返回空的 `skipped`**：内存 Vault 不可能"被外部改动"或"写失败"，
   * 编一个假的跳过项只会让浏览器预览里的汇报看起来更完整、实际更不可信。
   * 那条路径由宿主单测（`tag_rename_skips_files_changed_outside_the_app` 等）与 UI 层用桩适配器写的用例覆盖。
   */
  const rewriteTagsAcrossVault = (
    mapping: MockTagMapping,
    fromDisplay: string,
    dryRun: boolean,
  ): TagRenameOutcome => {
    const covers = (key: string): boolean =>
      key === mapping.fromKey ||
      (mapping.includeChildren && key.startsWith(`${mapping.fromKey}/`))

    const edited: TagRenameFile[] = []
    const skipped: TagRenameSkip[] = []
    let unchanged = 0
    let frontmatterEdits = 0
    let inlineEdits = 0
    let inlineRemoved = 0
    let candidates = 0

    for (const rel of [...files.keys()].sort()) {
      if (!isMockMarkdown(rel)) continue
      const note = files.get(rel)
      if (note === undefined) continue
      const keys = new Set(
        mockExtractTags(note.text)
          .map((tag) => mockNormalizeTag(tag.tag))
          .filter((key) => key !== ''),
      )
      if (![...keys].some(covers)) continue
      candidates += 1

      const rewrite = mockRenameTags(note.text, mapping)
      if (rewrite === null) {
        unchanged += 1
        continue
      }
      if (!dryRun) {
        files.set(rel, { relPath: rel, text: rewrite.text })
        mtimes.set(rel, touch())
      }
      frontmatterEdits += rewrite.frontmatterEdits
      inlineEdits += rewrite.inlineEdits
      inlineRemoved += rewrite.inlineRemoved
      edited.push({
        relPath: rel,
        frontmatterEdits: rewrite.frontmatterEdits,
        inlineEdits: rewrite.inlineEdits,
        inlineRemoved: rewrite.inlineRemoved,
      })
    }

    return {
      from: mapping.fromKey,
      to: mapping.toKey,
      fromDisplay,
      toDisplay: mapping.toDisplay,
      includeChildren: mapping.includeChildren,
      dryRun,
      candidates,
      edited,
      skipped,
      unchanged,
      frontmatterEdits,
      inlineEdits,
      inlineRemoved,
      elapsedMs: 1,
    }
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
          // 正文另存一份：真实宿主是把它移进 `.mimenote/trash`，Mock 里没有真文件系统，
          // 但"恢复之后内容逐字回来"这条必须在 Mock 下也成立（否则前端测试就是在测空气）
          removedTexts.set(record.id, note.text)
          trashed.push(record)
          return record as T
        }
        case 'trash_list': {
          // 与宿主同口径：按删除时间倒序，并如实标出"东西还在不在"
          const entries: TrashEntry[] = [...trashed]
            .sort((left, right) => right.deletedAtMs - left.deletedAtMs)
            .map((record) => ({ ...record, present: presentInTrash(record) }))
          return entries as T
        }
        case 'note_restore': {
          const id = String(a.id ?? '')
          const targetRaw = a.targetRelPath
          const index = trashed.findIndex((record) => record.id === id)
          if (index < 0) fail('NOT_FOUND', `回收站记录不存在：${id}`)
          const record = trashed[index]!
          if (!presentInTrash(record)) fail('NOT_FOUND', '回收站里的这个文件已经不在了')

          const target = targetRaw === undefined || targetRaw === null ? record.originalRelPath : String(targetRaw)
          validate(target)
          if (files.has(target) || trashDirs.has(target)) {
            fail('ALREADY_EXISTS', `目标已存在：${target}（先把那个文件移开，或用「恢复为…」换个名字）`)
          }

          // 父目录缺了就补（与 mn-core 的 restore_from_trash 同一行为），并自浅到深报出来
          const createdDirs: string[] = []
          const segments = target.split('/')
          let accumulated = ''
          for (const segment of segments.slice(0, -1)) {
            accumulated = accumulated === '' ? segment : `${accumulated}/${segment}`
            if (!trashDirs.has(accumulated) && !files.has(accumulated)) {
              trashDirs.add(accumulated)
              createdDirs.push(accumulated)
            }
          }

          const text = removedTexts.get(record.id)
          if (text === undefined) fail('NOT_FOUND', '回收站里的这个文件已经不在了')
          files.set(target, { relPath: target, text })
          touch()
          removedTexts.delete(record.id)
          trashed.splice(index, 1)

          const summary: RestoreSummary = {
            id: record.id,
            originalRelPath: record.originalRelPath,
            restoredRelPath: target,
            isDir: record.isDir,
            createdDirs,
            restoredToOriginalPlace: target === record.originalRelPath,
            // 目录恢复要交给真实重扫；Mock 里没有扫描器，但契约形状要保持一致
            needsRescan: record.isDir,
          }
          return summary as T
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
        case 'note_move': {
          // 跨目录移动（`note_move` 的 Mock 镜像）：与 `note_rename` 共用同一段"改路径 +
          // 改写全库链接"的机制，差别只有两点 —— 目标目录由参数给（不存在就建），
          // 以及链接一律写成相对新位置的路径（见 `mockRewriteLinks` 的 alwaysRelative）。
          const relPath = String(a.relPath ?? '')
          const rawTarget = String(a.targetParentRel ?? '')
          const rawTitle = a.newTitle === null || a.newTitle === undefined ? null : String(a.newTitle).trim()
          const updateLinks = a.updateLinks !== false
          validate(relPath)

          if (dirs.has(relPath)) fail('IS_DIRECTORY', `目录移动暂不支持：${relPath}`)
          const note = files.get(relPath)
          if (note === undefined) fail('NOT_FOUND', `文件不存在：${relPath}`)

          // 首尾 `/` 与反斜杠都容忍（`''` = Vault 根）；`..` 之类仍由 validate 拦下
          const parentRel = rawTarget.trim().replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '')
          if (parentRel !== '') validate(parentRel)

          const name = basename(relPath)
          let newName = name
          if (rawTitle !== null) {
            if (rawTitle === '' || rawTitle === '.' || rawTitle === '..' || /[\\/:*?"<>|]/.test(rawTitle)) {
              fail('PATH_INVALID', `非法文件名：${rawTitle}`)
            }
            const stem = rawTitle.replace(/\.(md|markdown)$/i, '')
            const ext = extensionOf(relPath)
            newName = ext === '' ? stem : `${stem}.${ext}`
          }
          const newRelPath = parentRel === '' ? newName : `${parentRel}/${newName}`
          validate(newRelPath)

          if (newRelPath === relPath) {
            // 移到自己所在目录：无操作（与宿主一致，连 mtime 都不动）
            const payload: RenameOutcome = {
              oldRelPath: relPath,
              newRelPath,
              newMtimeMs: mtimeOf(relPath),
              updatedLinks: [],
              updatedLinkCount: 0,
              elapsedMs: 0,
            }
            return payload as T
          }
          if (files.has(newRelPath)) fail('ALREADY_EXISTS', `目标已存在：${newRelPath}`)

          // ⚠️ 解析器必须基于**移动前**的文件表：搬完之后 `[[旧路径]]` 再也解析不到它，
          // 就无法判断哪些链接原本指向它了（Rust 侧用的是索引里的移动前快照，同一个道理）。
          const resolver = updateLinks ? createMockResolver(files) : null

          files.delete(relPath)
          files.set(newRelPath, { relPath: newRelPath, text: note.text })
          const movedMtime = mtimeOf(relPath)
          mtimes.delete(relPath)
          mtimes.set(newRelPath, movedMtime)

          // 目标目录不存在时创建（含缺失的祖先），否则树里会缺一层
          if (parentRel !== '') {
            const parts = parentRel.split('/')
            let acc = ''
            for (const part of parts) {
              acc = acc === '' ? part : `${acc}/${part}`
              dirs.add(acc)
            }
          }

          const updatedLinks: RenameLinkUpdate[] = []
          if (resolver !== null) {
            for (const from of [...files.keys()].sort()) {
              const current = files.get(from)
              if (current === undefined) continue
              // 被移动的文件**自身**：解析与相对路径换算都要按**移动前**的位置来
              // （Rust 的改写计划也是在移动前算的；否则自链接会算出"换个写法但等价"的差量）
              const fromBefore = from === newRelPath ? relPath : from
              const result = mockRewriteLinks(current.text, fromBefore, relPath, newRelPath, resolver, true)
              if (result.count === 0) continue
              files.set(from, { relPath: from, text: result.text })
              mtimes.set(from, touch())
              // 被移动文件自身的条目用**旧路径**上报（与 Rust 侧同一口径）
              updatedLinks.push({ relPath: fromBefore, count: result.count })
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
        case 'dir_rename': {
          // 目录改名（`dir_rename` 的 Mock 镜像）：真的搬整棵子树 + 改写指向它的链接。
          // 与宿主同一套语义（见 `mockRewriteDirLinks`）：子树里每篇都要跟着换路径，
          // 目标同名一律拒（**绝不合并两棵子树**）。
          const relPath = String(a.relPath ?? '')
          const rawTitle = String(a.newTitle ?? '')
          const updateLinks = a.updateLinks !== false
          validate(relPath)
          if (!dirs.has(relPath)) fail('NOT_A_DIRECTORY', `不是目录：${relPath}`)
          if (relPath === '.mimenote' || relPath.startsWith('.mimenote/')) {
            fail('PATH_INVALID', '.mimenote 是应用的内部目录，不能重命名或移动')
          }
          if (rawTitle !== rawTitle.trim()) fail('PATH_INVALID', '新名字不能带首尾空白')
          // 名字里的分隔符一律拒绝（与宿主同一口径）：允许 `子/新名` 会让"改名"偷偷变成"移动"，
          // 而改名与移动的链接改写规则不同 —— 换目录请走 `dir_move`
          if (rawTitle.includes('/') || rawTitle.includes('\\')) {
            fail('PATH_INVALID', '新名字不能包含路径分隔符（换目录请用目标目录参数）')
          }
          const name = rawTitle
          if (name === '' || name === '.' || name === '..' || /[\\/:*?"<>|]/.test(name)) {
            fail('PATH_INVALID', `非法目录名：${rawTitle}`)
          }

          const parent = parentOf(relPath)
          const newRelPath = parent === '' ? name : `${parent}/${name}`
          validate(newRelPath)
          if (newRelPath !== relPath && (dirs.has(newRelPath) || files.has(newRelPath))) {
            fail('ALREADY_EXISTS', `目标已存在：${newRelPath}`)
          }

          const updatedLinks = mockRewriteDirLinks({
            files,
            oldDir: relPath,
            newDir: newRelPath,
            updateLinks,
          })
          const moves = relocateTree(relPath, newRelPath)
          for (const item of moves) {
            const note = files.get(item.from)
            if (note === undefined) continue
            files.set(item.to, { relPath: item.to, text: note.text })
            const movedMtime = mtimeOf(item.from)
            mtimes.delete(item.from)
            mtimes.set(item.to, movedMtime)
          }
          for (const item of moves) files.delete(item.from)
          remapDirs(relPath, newRelPath)
          for (const from of updatedLinks.map((item) => item.relPath)) {
            mtimes.set(from, touch())
          }

          const payload: RenameOutcome = {
            oldRelPath: relPath,
            newRelPath,
            // 目录不是版本令牌的载体（与宿主一致：如实报 0）
            newMtimeMs: 0,
            updatedLinks,
            updatedLinkCount: updatedLinks.reduce((sum, item) => sum + item.count, 0),
            elapsedMs: 1,
          }
          return payload as T
        }
        case 'dir_move': {
          // 目录移动（`dir_move` 的 Mock 镜像）：与 `dir_rename` 共用同一段"搬子树 + 改写链接"，
          // 只有目标父目录由参数给（不存在就建）。搬进自己的后代一律拒绝 —— 与宿主同一口径。
          const relPath = String(a.relPath ?? '')
          const rawTarget = String(a.targetParentRel ?? '')
          const rawTitle =
            a.newTitle === null || a.newTitle === undefined ? null : String(a.newTitle)
          const updateLinks = a.updateLinks !== false
          validate(relPath)
          if (!dirs.has(relPath)) fail('NOT_A_DIRECTORY', `不是目录：${relPath}`)
          if (relPath === '.mimenote' || relPath.startsWith('.mimenote/')) {
            fail('PATH_INVALID', '.mimenote 是应用的内部目录，不能重命名或移动')
          }

          const parentRel = rawTarget
            .trim()
            .replaceAll('\\', '/')
            .replace(/^\/+/, '')
            .replace(/\/+$/, '')
          if (parentRel !== '') validate(parentRel)

          let name = basename(relPath)
          if (rawTitle !== null) {
            if (rawTitle !== rawTitle.trim()) fail('PATH_INVALID', '新名字不能带首尾空白')
            if (rawTitle.includes('/') || rawTitle.includes('\\')) {
              fail('PATH_INVALID', '新名字不能包含路径分隔符（换目录请用目标目录参数）')
            }
            name = rawTitle
            if (name === '' || name === '.' || name === '..' || /[\\/:*?"<>|]/.test(name)) {
              fail('PATH_INVALID', `非法目录名：${rawTitle}`)
            }
          }
          const newRelPath = parentRel === '' ? name : `${parentRel}/${name}`
          validate(newRelPath)
          // 搬进自己或自己的后代：宿主也是拒绝（这里给出同样的原因）
          if (newRelPath !== relPath && newRelPath.startsWith(`${relPath}/`)) {
            fail('PATH_INVALID', `不能把目录搬到它自己或它的子目录里（${relPath}）`)
          }
          if (newRelPath !== relPath && (dirs.has(newRelPath) || files.has(newRelPath))) {
            fail('ALREADY_EXISTS', `目标已存在：${newRelPath}`)
          }
          if (newRelPath === relPath) {
            const payload: RenameOutcome = {
              oldRelPath: relPath,
              newRelPath,
              newMtimeMs: 0,
              updatedLinks: [],
              updatedLinkCount: 0,
              elapsedMs: 0,
            }
            return payload as T
          }
          if (parentRel !== '') {
            let accumulated = ''
            for (const segment of parentRel.split('/')) {
              accumulated = accumulated === '' ? segment : `${accumulated}/${segment}`
              dirs.add(accumulated)
            }
          }

          const updatedLinks = mockRewriteDirLinks({
            files,
            oldDir: relPath,
            newDir: newRelPath,
            updateLinks,
          })
          const moves = relocateTree(relPath, newRelPath)
          for (const item of moves) {
            const note = files.get(item.from)
            if (note === undefined) continue
            files.set(item.to, { relPath: item.to, text: note.text })
            const movedMtime = mtimeOf(item.from)
            mtimes.delete(item.from)
            mtimes.set(item.to, movedMtime)
          }
          for (const item of moves) files.delete(item.from)
          remapDirs(relPath, newRelPath)
          for (const from of updatedLinks.map((item) => item.relPath)) {
            mtimes.set(from, touch())
          }

          const payload: RenameOutcome = {
            oldRelPath: relPath,
            newRelPath,
            newMtimeMs: 0,
            updatedLinks,
            updatedLinkCount: updatedLinks.reduce((sum, item) => sum + item.count, 0),
            elapsedMs: 1,
          }
          return payload as T
        }
        case 'note_set_tags': {
          // 与真实实现同一条纪律：令牌校验 → 改文本 → 写回 → `note_tags`/`tags_list` 立刻跟着变
          // （那两条都是从文本现算的，所以这里**必须真的改文本**，否则 UI/E2E 会假绿）
          const relPath = String(a.relPath ?? '')
          const add = Array.isArray(a.add) ? (a.add as unknown[]).map((item) => String(item)) : []
          const remove = Array.isArray(a.remove)
            ? (a.remove as unknown[]).map((item) => String(item))
            : []
          const baseMtimeMs =
            a.baseMtimeMs === null || a.baseMtimeMs === undefined ? null : Number(a.baseMtimeMs)
          validate(relPath)
          await sleep()
          const note = files.get(relPath)
          if (note === undefined) fail('NOT_FOUND', `文件不存在：${relPath}`)

          const current = mtimeOf(relPath)
          if (baseMtimeMs !== null && baseMtimeMs !== current) {
            throw new MimenoteError({
              code: 'CONFLICT',
              message: '文件已被外部修改',
              detail: null,
              currentMtimeMs: current,
            })
          }

          const updated = mockSetTags(note.text, add, remove)
          const changed = updated !== note.text
          if (changed) {
            files.set(relPath, { relPath, text: updated })
            mtimes.set(relPath, touch())
          }
          const frontmatter = mockParseFrontmatter(updated)
          const payload: SetTagsOutcome = {
            relPath,
            mtimeMs: mtimeOf(relPath),
            sizeBytes: new TextEncoder().encode(updated).length,
            writtenInMs: changed ? writeLatencyMs : 0,
            changed,
            tags: (frontmatter?.tags ?? []).map((entry) => entry.tag),
            text: updated,
          }
          return payload as T
        }
        case 'tag_rename': {
          // 标签改名/合并的 Mock 镜像：与真实宿主同一条纪律 —— 候选集来自"文本里的标签"，
          // 逐篇走 `mockRenameTags`（frontmatter 与正文一起改），逐篇如实汇报。
          // `dryRun` 只算不写，但判定与真跑完全一致（对话框那句"这会改 N 篇笔记"才可信）。
          // 执行部分与 `tag_move` 共用 `rewriteTagsAcrossVault`（见那里的注释）。
          const from = String(a.from ?? '')
          const to = String(a.to ?? '')
          const includeChildren = a.includeChildren !== false
          const dryRun = a.dryRun === true
          const mapping = mockTagMapping(from, to, includeChildren)
          if (mapping === null) fail('PATH_INVALID', '标签名称为空，无法改名')

          const payload = rewriteTagsAcrossVault(mapping, from, dryRun)
          return payload as T
        }
        case 'tag_move': {
          // 层级编辑的 Mock 镜像：目标键由 `mockTagMoveTarget` 算（与 Rust 的
          // `tag_move_target` 同规则、同拒绝理由），随后**走的是与改名同一条执行路径** ——
          // 宿主那边也是这样（`tag_move_in` 内部就是 `tag_rename_in`），
          // 所以"会改 N 篇 / 改了哪几篇"的汇报形状与原命令完全一致，界面无需分支。
          //
          // "目标键已被别的标签占用"这个判定这里也照做：内存 Vault 里所有标签都是从文本现算的，
          // 因此这条拒绝在浏览器预览里同样成立（不是宿主独有的分支）。
          const key = String(a.key ?? '')
          const parent = String(a.parent ?? '')
          const includeChildren = a.includeChildren !== false
          const dryRun = a.dryRun === true

          const move = mockTagMoveTarget(key, parent)
          if (!move.ok) fail('PATH_INVALID', move.reason)

          const fromKey = mockNormalizeTag(key)
          const taken = [...files.values()].some((note) =>
            mockExtractTags(note.text).some((tag) => {
              const existing = mockNormalizeTag(tag.tag)
              return existing === move.toKey && existing !== fromKey
            }),
          )
          if (taken) {
            fail('PATH_INVALID', `「${move.toKey}」已经是一个标签了；要合并请用「重命名」`)
          }

          const mapping = mockTagMapping(key, move.toKey, includeChildren)
          if (mapping === null) fail('PATH_INVALID', '标签名称为空，无法调整层级')

          const payload = rewriteTagsAcrossVault(mapping, key, dryRun)
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
        case 'tag_filter': {
          // 与宿主 `TagIndex::filter_notes` 同口径：含任意一个（空 = 全部有标签的笔记）
          // 且不含任何一个；`includeChildren` 按 `/` 切段匹配后代（`父老` 不是 `父` 的后代）。
          const anyKeys = (Array.isArray(a.any) ? a.any : [])
            .map((key) => mockNormalizeTag(String(key)))
            .filter((key) => key !== '')
          const noneKeys = (Array.isArray(a.none) ? a.none : [])
            .map((key) => mockNormalizeTag(String(key)))
            .filter((key) => key !== '')
          const includeChildren = a.includeChildren === true

          const keysOf = (path: string): Set<string> => {
            const note = files.get(path)
            if (note === undefined) return new Set()
            return new Set(
              mockExtractTags(note.text)
                .map((tag) => mockNormalizeTag(tag.tag))
                .filter((key) => key !== ''),
            )
          }
          /** 这组键是否命中某个想要的条件（含后代时按 `/` 切段比较）。 */
          const hits = (keys: Set<string>, wanted: string): boolean => {
            if (keys.has(wanted)) return true
            if (!includeChildren) return false
            const prefix = `${wanted}/`
            for (const key of keys) {
              if (key.startsWith(prefix)) return true
            }
            return false
          }

          let tagged = 0
          const paths: string[] = []
          for (const path of [...files.keys()].sort()) {
            const keys = keysOf(path)
            if (keys.size === 0) continue
            tagged += 1
            const included = anyKeys.length === 0 ? true : anyKeys.some((key) => hits(keys, key))
            if (!included) continue
            if (noneKeys.some((key) => hits(keys, key))) continue
            paths.push(path)
          }
          const result: TagFilterResult = { paths, matched: paths.length, tagged }
          return result as T
        }
        case 'search_query': {
          const query = String(a.query ?? '')
          const limit = a.limit === undefined ? 50 : Number(a.limit)
          return mockSearch(files, query, limit) as T
        }
        case 'graph_data': {
          // 图谱的 Mock 镜像（权威实现在 Rust 的链接索引里）：节点 = Markdown 笔记，
          // 边 = 抽取出的链接（resolved / 悬空都保留），按 (from, to) 去重后累加 count。
          const resolver = createMockResolver(files)
          const byPair = new Map<string, GraphEdge>()
          for (const [from, note] of files) {
            if (!isMockMarkdown(from)) continue
            for (const link of mockExtractLinks(note.text)) {
              const target = resolver(from, link.rawTarget).path
              const key = `${from}\u0000${target ?? ''}`
              const existing = byPair.get(key)
              if (existing !== undefined) {
                existing.count += 1
                continue
              }
              byPair.set(key, {
                fromRelPath: from,
                toRelPath: target,
                toRawTarget: link.rawTarget,
                kind: link.kind,
                count: 1,
              })
            }
          }
          const edges = [...byPair.values()].sort(
            (left, right) =>
              left.fromRelPath.localeCompare(right.fromRelPath) ||
              (left.toRelPath ?? '\uffff').localeCompare(right.toRelPath ?? '\uffff') ||
              left.kind.localeCompare(right.kind),
          )
          const outDegrees = new Map<string, number>()
          const inDegrees = new Map<string, number>()
          for (const edge of edges) {
            outDegrees.set(edge.fromRelPath, (outDegrees.get(edge.fromRelPath) ?? 0) + 1)
            if (edge.toRelPath !== null) {
              inDegrees.set(edge.toRelPath, (inDegrees.get(edge.toRelPath) ?? 0) + 1)
            }
          }
          const nodes: GraphNode[] = [...files.keys()]
            .filter(isMockMarkdown)
            .sort()
            .map((relPath) => {
              const note = files.get(relPath)
              const frontmatter = note === undefined ? null : mockParseFrontmatter(note.text)
              const titleField = frontmatter?.fields.find((field) => field.key === 'title')
              const title =
                titleField !== undefined && titleField.value.kind === 'scalar'
                  ? titleField.value.value
                  : (relPath.split('/').pop() ?? relPath).replace(/\.(md|markdown)$/i, '')
              return {
                relPath,
                title,
                folder: parentOf(relPath),
                tags: (note === undefined ? [] : mockExtractTags(note.text))
                  .slice(0, 8)
                  .map((tag) => tag.tag),
                outDegree: outDegrees.get(relPath) ?? 0,
                inDegree: inDegrees.get(relPath) ?? 0,
              }
            })
          const payload: GraphData = { nodes, edges, truncated: false, elapsedMs: 1 }
          return payload as T
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
              sizeBytes:
                binaries.get(rel)?.length ??
                new TextEncoder().encode(files.get(rel)?.text ?? '').length,
            })
          }
          return grants as T
        }
        case 'asset_read_base64': {
          // 导出内嵌（`asset_read_base64` 的 Mock 镜像）：只对白名单扩展名、且在"文件表"里
          // 存在的条目返回 base64；越界、非图片、不存在的路径一律跳过（与宿主一致：
          // 宿主也是"只返回成功的那些"，调用方把没返回的渲染成占位文字）。
          const requested = Array.isArray(a.relPaths) ? a.relPaths : []
          const items: AssetBytes[] = []
          for (const raw of requested) {
            const rel = String(raw)
            const mime = MOCK_IMAGE_MIMES[mockExtensionOf(rel)]
            if (mime === undefined) continue
            // 图片既可能是笔记表里的"假图片"（测试用），也可能是附件写入留下的真字节
            const bytes =
              binaries.get(rel) ??
              (files.get(rel) === undefined
                ? undefined
                : new TextEncoder().encode(files.get(rel)?.text ?? ''))
            if (bytes === undefined) continue
            items.push({
              relPath: rel,
              mime,
              dataBase64: mockBase64(bytes),
              sizeBytes: bytes.length,
            })
          }
          return items as T
        }
        case 'attachment_save': {
          // 附件写入的 Mock 镜像（ADR-0013）：**逐条**对齐宿主的行为 ——
          // 目录口径、白名单、三道上限、命名去重、返回契约，以及"要么全落、要么一张都不落"。
          const rawDir = String(a.dirRel ?? '')
          const dir = rawDir.trim().replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '')
          if (dir !== '') validate(dir)

          const requested = Array.isArray(a.files) ? a.files : []
          if (requested.length > MOCK_MAX_ATTACHMENTS) {
            fail('TOO_LARGE', `一次最多接受 ${MOCK_MAX_ATTACHMENTS} 张图片（本次 ${requested.length} 张）`)
          }

          // 第一阶段：只校验，不落盘
          const planned: Array<{ relPath: string; bytes: Uint8Array }> = []
          const reserved = new Set<string>()
          let totalBytes = 0
          for (const raw of requested) {
            const entry = (raw ?? {}) as Partial<AttachmentInput>
            const name = String(entry.name ?? '').trim()
            const encoded = String(entry.dataBase64 ?? '')
            if (name.includes('/') || name.includes('\\')) {
              fail('PATH_INVALID', `附件文件名不能含路径分隔符：${name}`)
            }
            if (!isImageAssetTarget(name) || mockExtensionOf(name) === '') {
              fail(
                'UNSUPPORTED_MEDIA',
                `只接受图片附件（png / jpg / jpeg / gif / webp / avif / bmp / svg / ico），已拒绝：${
                  name === '' ? '（文件名为空）' : name
                }`,
              )
            }
            // 先按 base64 长度估上界（与宿主同一口径），再解码
            const estimate = estimatedDecodedBytes(encoded.length)
            if (estimate > MAX_ATTACHMENT_BYTES) {
              fail('TOO_LARGE', `${name}：${estimate}+ 字节 > 单张上限 ${MAX_ATTACHMENT_BYTES} 字节`)
            }
            const bytes = mockDecodeBase64(encoded)
            if (bytes === null) {
              fail('UNSUPPORTED_MEDIA', `附件载荷不是合法的 base64：${name}`)
            }
            if (bytes.length === 0) {
              fail('UNSUPPORTED_MEDIA', `附件内容为空，已拒绝：${name}`)
            }
            totalBytes += bytes.length
            if (totalBytes > MAX_ATTACHMENT_BATCH_BYTES) {
              fail(
                'TOO_LARGE',
                `本批附件合计超过上限 ${MAX_ATTACHMENT_BATCH_BYTES} 字节（写到 ${name} 时已达 ${totalBytes} 字节）`,
              )
            }

            const rel = uniqueAttachmentName(name, (candidate) => {
              const path = dir === '' ? candidate : `${dir}/${candidate}`
              return reserved.has(path) || files.has(path) || binaries.has(path)
            })
            if (rel === null) fail('ALREADY_EXISTS', `${name} 的重名尝试次数过多`)
            const relPath = dir === '' ? rel : `${dir}/${rel}`
            reserved.add(relPath)
            planned.push({ relPath, bytes })
          }

          // 第二阶段：落盘（内存表）+ 造出附件目录（含缺失的祖先，与宿主建目录一致）
          if (dir !== '') {
            let accumulated = ''
            for (const segment of dir.split('/')) {
              accumulated = accumulated === '' ? segment : `${accumulated}/${segment}`
              dirs.add(accumulated)
            }
          }
          const payload: AttachmentSaved[] = planned.map((item) => {
            binaries.set(item.relPath, item.bytes)
            mtimes.set(item.relPath, touch())
            return { relPath: item.relPath, sizeBytes: item.bytes.length }
          })
          return payload as T
        }
        case 'export_write_html': {
          // 导出落盘（`export_write_html` 的 Mock 镜像）：**不写真实文件**，只回显契约形状；
          // 扩展名与大小上限与宿主保持一致，免得测试绿得毫无意义。
          const path = String(a.path ?? '')
          const html = String(a.html ?? '')
          const sizeBytes = new TextEncoder().encode(html).length
          if (
            path === '' ||
            !MOCK_EXPORT_EXTENSIONS.includes(mockExtensionOf(path.replaceAll('\\', '/')))
          ) {
            fail('PATH_INVALID', `导出只允许写 .html/.htm：${path}`)
          }
          if (sizeBytes > MOCK_MAX_EXPORT_BYTES) {
            fail('TOO_LARGE', `导出内容过大：${sizeBytes} 字节`)
          }
          const payload: ExportWriteOutcome = {
            absolutePath: path,
            sizeBytes,
            writtenInMs: 1,
          }
          return payload as T
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
