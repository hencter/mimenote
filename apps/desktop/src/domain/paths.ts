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

/**
 * **显示用**文件名：笔记去掉 `.md` / `.markdown`，其他一切（附件、目录）原样返回。
 *
 * 为什么要有这一层、以及它出现在哪些地方，见 ADR-0030：界面上显示"这是哪一篇笔记"时
 * 不写扩展名（Obsidian 也是这个口径），而**真实路径**仍然要在三处看得见 ——
 * 悬停提示（`title`）、路径编辑类对话框、以及导出件/静态站点这类外部产物。
 *
 * 判据只有这一份：调用方不要自己 `replace(/\.md$/)`（`app/actions.ts` 里那处
 * 是**建笔记**时从用户输入推标题，属于数据加工，不是显示）。
 */
export function displayName(relPath: string): string {
  return isMarkdown(relPath) ? stem(relPath) : basename(relPath)
}

/**
 * **显示用**相对路径：只把最后一段的笔记扩展名去掉，目录部分逐字保留。
 *
 * 注意它按"最后一段是笔记"来判断 —— 目录名里带 `.md`（`归档.md/笔记.md`）时，
 * 被剥掉的仍然是笔记那一段，目录那一段不受影响。
 */
export function displayPath(relPath: string): string {
  if (!isMarkdown(relPath)) return relPath
  const name = basename(relPath)
  return relPath.slice(0, relPath.length - name.length) + stem(relPath)
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
