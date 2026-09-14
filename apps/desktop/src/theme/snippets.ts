/**
 * Vault 内的用户 CSS 片段（`.mimenote/snippets/*.css`）—— 内置扩展点之一。
 *
 * 安全边界（ADR-0005）：只加载**用户自己 Vault 目录里**的本地文件，
 * 不加载任何远程样式；每个片段对应一个可整体移除的 `<style>` 元素，
 * 关闭开关即彻底卸载（可逆副作用）。
 */

import { ipc } from '@/ipc/client'

const SNIPPET_ATTR = 'data-mn-snippet'

export interface SnippetResult {
  count: number
  names: string[]
}

/** 应用/卸载片段。返回实际生效的片段列表。 */
export async function applyVaultSnippets(enabled: boolean): Promise<SnippetResult> {
  unloadSnippets()
  if (!enabled) return { count: 0, names: [] }

  const files = await ipc.snippetsList()
  const names: string[] = []
  for (const file of files) {
    const style = document.createElement('style')
    style.setAttribute(SNIPPET_ATTR, file.name)
    // 注释里标注来源，便于用户在开发者工具里定位
    style.textContent = `/* mimenote snippet: ${file.name} */\n${file.css}`
    document.head.appendChild(style)
    names.push(file.name)
  }
  return { count: names.length, names }
}

/** 卸载全部片段。 */
export function unloadSnippets(): void {
  for (const element of Array.from(document.querySelectorAll(`style[${SNIPPET_ATTR}]`))) {
    element.remove()
  }
}

/** 当前生效的片段名。 */
export function activeSnippetNames(): string[] {
  return Array.from(document.querySelectorAll(`style[${SNIPPET_ATTR}]`)).map(
    (element) => element.getAttribute(SNIPPET_ATTR) ?? '',
  )
}

/**
 * 当前生效片段的**内容**（导出静态站点时把它们一并带走）。
 *
 * 为什么从 DOM 里读而不是再调一次 `snippets_list`：DOM 里的就是**此刻真正生效的**那一份 ——
 * 片段开关关掉之后它们根本不在；再查一次 IPC 会得到"磁盘上有什么"，与用户看到的样式可能不一致。
 * 导出件要复现的是用户眼前的样子，不是磁盘上的潜在状态（与 `readExportTokens` 从计算样式
 * 取主题令牌同一条理由）。
 */
export function collectSnippetCss(): Array<{ name: string; content: string }> {
  if (typeof document === 'undefined') return []
  return Array.from(document.querySelectorAll(`style[${SNIPPET_ATTR}]`)).map((element) => ({
    name: element.getAttribute(SNIPPET_ATTR) ?? 'snippet',
    content: element.textContent ?? '',
  }))
}
