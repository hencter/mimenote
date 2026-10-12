/**
 * ipc/mock/tag-rename.ts（从 mock-adapter.ts 逐字搬出，只加了 export 与 import）
 *
 * 标签改名 / 移动的映射与全库改写 —— Mock 侧的镜像。
 */
import { mockExtractTags, mockFormatTag, mockNormalizeTag, mockParseFrontmatter, mockScanInlineTagSpans, parseInlineList, stripQuotes } from './tags'
import type { MockTagSpan } from './tags'

export interface MockTagMapping {
  fromKey: string
  toDisplay: string
  toKey: string
  includeChildren: boolean
}

export function mockTagMapping(from: string, to: string, includeChildren: boolean): MockTagMapping | null {
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
export type MockTagMove = { ok: true; toKey: string } | { ok: false; reason: string }

/**
 * 「把标签移到某个父标签下」（`parent` 为空 = 提回**顶层**）算出来的目标键；
 * 非法移动返回**给用户看的原因**。
 *
 * 拒绝理由逐字对齐 Rust 侧 —— 界面把宿主的那句话直接显示出来，两处要是措辞不同，
 * 浏览器预览里看到的就不是真机上会看到的。规则只有三条：只换祖先不动名字、
 * 空父标签 = 提回顶层、目标与源相同要明确拒绝（而不是静默当成功）。
 */
export function mockTagMoveTarget(key: string, parent: string): MockTagMove {
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
export function mockDescendantSuffix(tag: string, fromKey: string): string | null {
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
export function mockApplyTagMapping(tag: string, mapping: MockTagMapping): string | null {
  const key = mockNormalizeTag(tag)
  if (key === '') return null
  if (key === mapping.fromKey) return mapping.toDisplay
  if (!mapping.includeChildren) return null
  const suffix = mockDescendantSuffix(tag, mapping.fromKey)
  return suffix === null ? null : `${mapping.toDisplay}/${suffix}`
}

/** 一个标签字段在原文里的形态（用于"改完写回去时保持原样"）。 */
export type MockTagFieldStyle = 'inline' | 'scalar' | 'block' | 'empty'

export interface MockTagField {
  index: number
  key: string
  rest: string
  style: MockTagFieldStyle
  items: string[]
  /** `block`：项行下标（本行之后紧跟的那些）。 */
  itemRows: number[]
}

/** 找出 frontmatter 区块里的标签字段（`tags` 在前、`tag` 在后，与面板的显示口径一致）。 */
export function mockTagFields(lines: readonly string[], end: number): MockTagField[] {
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
export function mockRenameTagFields(
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
export function mockRenameTags(
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
