/** Vault 相对路径的纯字符串工具（统一使用 `/` 分隔，与 IPC 契约一致）。 */

export function basename(relPath: string): string {
  const index = relPath.lastIndexOf('/')
  return index === -1 ? relPath : relPath.slice(index + 1)
}

export function parentOf(relPath: string): string {
  const index = relPath.lastIndexOf('/')
  return index === -1 ? '' : relPath.slice(0, index)
}

/** 去掉扩展名的文件名。 */
export function stem(relPath: string): string {
  const base = basename(relPath)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? base : base.slice(0, dot)
}

/** 小写扩展名（不含点）；无扩展名返回空串。 */
export function extensionOf(relPath: string): string {
  const base = basename(relPath)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

export function isMarkdown(relPath: string): boolean {
  const ext = extensionOf(relPath)
  return ext === 'md' || ext === 'markdown'
}

export function joinRel(parentRel: string, name: string): string {
  return parentRel === '' ? name : `${parentRel}/${name}`
}

/** 深路径的显示截断：`很长的目录/…/笔记.md`。 */
export function shortenPath(relPath: string, maxLength = 48): string {
  if (relPath.length <= maxLength) return relPath
  const name = basename(relPath)
  const head = relPath.slice(0, Math.max(0, maxLength - name.length - 2))
  return `${head}…/${name}`
}
