/**
 * ipc/mock/tags.ts（从 mock-adapter.ts 逐字搬出，只加了 export 与 import）
 *
 * frontmatter 标签字段与行内标签的抽取 / 编辑 —— Mock 侧的镜像
 * （前端判据在 `domain/inline-tags.ts`、`domain/frontmatter.ts`）。
 */
import { isInlineTagChar } from '@/domain/inline-tags'
import type { FrontmatterField, FrontmatterValue, TagRef, TagSource } from '@/ipc/types'

// ---------------------------------------------------------------------------
// Mock 的标签 / frontmatter（`mn_core::tags` + `mn_core::frontmatter` 的简化镜像）
//
// 权威实现在 Rust 侧（那里的规则有 30+ 个单测钉死）。这里只需让"浏览器预览 + UI 层测试"
// 拿到形状正确的数据，因此刻意简化了两处：块数组项的**行号**统一取字段所在行；
// YAML 只认 `key: value`、`[a, b]`、`- item` 三种形态。
// ---------------------------------------------------------------------------

/** 归一化标签为索引键（小写、去 `#`、折叠空白与 `/`、去首尾 `/`）。 */
export function mockNormalizeTag(raw: string): string {
  const withoutHash = raw
    .trim()
    .replace(/^#+/, '')
    .split(/\s+/)
    .filter((part) => part !== '')
    .join(' ')
  const collapsed = withoutHash.toLowerCase().replace(/\/{2,}/g, '/')
  return collapsed.replace(/^\/+/, '').replace(/\/+$/, '')
}

// 「什么算标签名字符」不再自己写一份：用 `domain/inline-tags.ts` 的 `isInlineTagChar`
// （那里是 Unidata 字母数字 + `_` + `-` + 层级 `/` 的唯一判据，编辑器/阅读视图也用它）。
// 本文件仍然自己做代码块 / HTML 注释 / 行内代码的遮蔽 —— 那是"文档级"信息，
// 行内扫描器看不到（`inlineTagSpans` 的文档把这件事明确交给了调用方）。

export function stripQuotes(raw: string): string {
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
export function parseInlineList(value: string): string[] {
  if (!value.startsWith('[') || !value.endsWith(']')) return []
  return value
    .slice(1, -1)
    .split(',')
    .map((item) => stripQuotes(item))
    .filter((item) => item !== '')
}

export interface MockFrontmatter {
  fields: FrontmatterField[]
  /** 标签与它们在原文里的行号（块数组项在 Mock 里统一取字段行）。 */
  tags: { tag: string; line: number }[]
  /** 区块占用的行数（含首尾分隔行）；未闭合时为 0。 */
  lines: number
}

/** 把原始值文本归类成 `FrontmatterValue`（与 Rust 同口径：数字保留原始文本）。 */
export function classifyFrontmatterValue(text: string): FrontmatterValue {
  if (text === '' || text === '~' || text.toLowerCase() === 'null') return { kind: 'null' }
  if (/^(true|false)$/i.test(text)) return { kind: 'bool', value: text.toLowerCase() === 'true' }
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text) || /^-?\d+\.$/.test(text)) {
    return { kind: 'number', value: text }
  }
  return { kind: 'scalar', value: stripQuotes(text) }
}

/** 解析开头的 frontmatter 区块（未闭合 → `null`，整篇按正文处理）。 */
export function mockParseFrontmatter(text: string): MockFrontmatter | null {
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
export function mockScanInlineTags(bodyLines: readonly string[], lineOffset: number): TagRef[] {
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
export interface MockTagSpan {
  tag: string
  /** 全文绝对行号（1 起）。 */
  line: number
  /** 在 `bodyLines` 里的下标。 */
  row: number
  start: number
  end: number
}

export function mockScanInlineTagSpans(bodyLines: readonly string[], lineOffset: number): MockTagSpan[] {
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
      while (end < line.length && isInlineTagChar(line[end] ?? '')) end += 1
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
export function mockApplyTagEdits(
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
export function mockFormatTag(tag: string): string {
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
export function mockSetTags(text: string, add: readonly string[], remove: readonly string[]): string {
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
export function mockExtractTags(text: string): TagRef[] {
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
