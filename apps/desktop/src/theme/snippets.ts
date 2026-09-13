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
