/**
 * 链接相关的纯函数（前端侧）。
 *
 * 归一化规则必须与 Rust `mn_core::links::normalize_target` 一致 ——
 * 它只用于"把预览里渲染出来的 `data-target` 与宿主返回的出链对上"，
 * 真正的链接解析权威实现仍在 Rust（`mn-index`）。
 */

/** 拆分 `[[目标#锚点|别名]]` 的内部文本。 */
export interface WikilinkParts {
  target: string
  alias: string | null
  anchor: string | null
}

/** 解析 wikilink 内部文本（与 Rust 的 `split_anchor` 行为一致）。 */
export function splitWikilink(inner: string): WikilinkParts {
  const pipeIndex = inner.indexOf('|')
  const targetPart = (pipeIndex === -1 ? inner : inner.slice(0, pipeIndex)).trim()
  const aliasRaw = pipeIndex === -1 ? '' : inner.slice(pipeIndex + 1).trim()

  const hashIndex = targetPart.indexOf('#')
  let target = hashIndex === -1 ? targetPart : targetPart.slice(0, hashIndex)
  let anchor = hashIndex === -1 ? null : targetPart.slice(hashIndex + 1)

  const caretIndex = target.indexOf('^')
  if (caretIndex !== -1) {
    if (anchor === null || anchor === '') anchor = target.slice(caretIndex + 1)
    target = target.slice(0, caretIndex)
  }

  return {
    target: target.trim(),
    alias: aliasRaw === '' ? null : aliasRaw,
    anchor: anchor === null || anchor === '' ? null : anchor,
  }
}

/** wikilink 的展示文本。 */
export function wikilinkDisplayText(parts: WikilinkParts): string {
  if (parts.alias !== null) return parts.alias
  if (parts.target !== '') return parts.target
  return parts.anchor === null ? '' : `#${parts.anchor}`
}

/**
 * 归一化链接目标为**匹配键**（小写、反斜杠转 `/`、去掉 `.md`/`.markdown`、去掉 `./`）。
 *
 * ⚠️ 与 Rust 实现对应，改动必须两边同步（`crates/mn-core/src/links.rs`）。
 */
export function normalizeLinkTarget(raw: string): string {
  const normalized = raw.trim().replaceAll('\\', '/').toLowerCase()
  let trimmed = normalized
  while (trimmed.startsWith('./')) trimmed = trimmed.slice(2)
  trimmed = trimmed.replace(/^\/+/, '').replace(/\/+$/, '')
  const withoutExtension = trimmed.replace(/\.markdown$/, '').replace(/\.md$/, '')
  return withoutExtension.trim()
}

/** 预览里点击的 href 是否是"指向某个 Markdown 笔记"的内部链接。 */
export function isInternalNoteHref(href: string): boolean {
  const value = href.trim().toLowerCase()
  if (value === '' || value.startsWith('#')) return false
  if (/^[a-z][a-z0-9+.-]*:/.test(value)) return false // http:、mailto:、data: …
  return value.endsWith('.md') || value.endsWith('.markdown') || !value.includes('.')
}
