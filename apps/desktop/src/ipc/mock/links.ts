/**
 * ipc/mock/links.ts（从 mock-adapter.ts 逐字搬出，只加了 export 与 import）
 *
 * 链接的抽取 / 解析 / 改写 —— **Mock 侧的镜像**（权威实现在 Rust 的 `mn-index`，
 * 前端判据在 `domain/links.ts`；本文件的差异见 B11 的收敛清单）。
 */
import type { MockNote } from './model'
import { normalizeLinkTarget, splitWikilink, wikilinkDisplayText } from '@/domain/links'
import { extensionOf, parentOf } from '@/domain/paths'
import type { BacklinkRef, LinkKind, NoteLinks, RenameLinkUpdate, ResolvedLink } from '@/ipc/types'

// ---------------------------------------------------------------------------
// Mock 的链接解析
//
// ⚠️ 这里只是为了"浏览器预览 + UI 层测试"能跑通，规则是 Rust 实现
// （`mn-core::links` + `mn-index`）的**简化镜像**。权威实现永远在 Rust 侧，
// 真实行为由应用层 E2E 与 Rust 单测覆盖。
// ---------------------------------------------------------------------------

export interface MockRawLink {
  kind: LinkKind
  rawTarget: string
  alias: string | null
  anchor: string | null
  line: number
}

export function mockExtractLinks(text: string): MockRawLink[] {
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

export function pickMockCandidate(matches: string[]): { path: string | null; ambiguous: boolean } {
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
export function resolveRelativeKey(fromDir: string, key: string): string {
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
export type MockResolver = (from: string, raw: string) => { path: string | null; ambiguous: boolean }

/**
 * 构建解析器（一次遍历建立 stem 索引，避免在批量改写时反复重建）。
 *
 * 规则与 `mn-index` 对齐：裸名走 stem 索引 + 消歧；带路径的**先按相对来源文件目录解析**，
 * 再按相对 Vault 根解析，最后退化到路径后缀匹配。
 */
export function createMockResolver(files: Map<string, MockNote>): MockResolver {
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

export function buildMockNoteLinks(
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
export interface ScannedLink {
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
export function maskInlineCode(line: string): string {
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
export function cleanMarkdownTarget(raw: string): string {
  const trimmed = raw.trim()
  const withoutTitle = trimmed.split(/\s+"/)[0] ?? trimmed
  if (withoutTitle.startsWith('<') && withoutTitle.endsWith('>')) {
    return withoutTitle.slice(1, -1).trim()
  }
  return withoutTitle.trim()
}

/** 扫描一行里的 wikilink 与 Markdown 链接（跳过行内代码与转义）。 */
export function scanLineLinks(line: string): ScannedLink[] {
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
export function relativeRelPath(fromDir: string, toRelPath: string): string {
  const from = fromDir === '' ? [] : fromDir.split('/')
  const to = toRelPath.split('/')
  const lastIndex = to.length - 1
  let common = 0
  while (common < from.length && common < lastIndex && from[common] === to[common]) common += 1
  const ups = Array.from({ length: from.length - common }, () => '..')
  return [...ups, ...to.slice(common)].join('/')
}

/** 用新目标重建一条链接（保留 `!` 前缀、别名与锚点）。 */
export function rebuildLink(line: string, link: ScannedLink, target: string): string {
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
export function mockRewriteLinks(
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
export function mockRewriteDirLinks(options: {
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
export function mockBareDirTarget(landing: string, newDirOfFrom: string): string {
  const stem = (landing.split('/').pop() ?? landing).replace(/\.(md|markdown)$/i, '')
  if (parentOf(landing) === newDirOfFrom) return stem
  return relativeRelPath(newDirOfFrom, landing.replace(/\.(md|markdown)$/i, ''))
}

/** 路径形式的链接在目录搬迁后的写法（保留 `[[x]]` 不加扩展名的惯例）。 */
export function mockPathDirTarget(link: ScannedLink, landing: string, newDirOfFrom: string): string | null {
  const keepsExtension = link.form === 'markdown' && /\.(md|markdown)$/i.test(link.raw)
  const noExt = landing.replace(/\.(md|markdown)$/i, '')
  const target = relativeRelPath(newDirOfFrom, noExt)
  if (!keepsExtension) return target
  const ext = extensionOf(landing)
  return ext === '' ? target : `${target}.${ext}`
}
