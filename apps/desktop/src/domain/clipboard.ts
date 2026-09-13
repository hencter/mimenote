/**
 * 复制文本到系统剪贴板。
 *
 * 为什么要两条路：`navigator.clipboard` 只在**安全上下文**里存在，而 Tauri 的
 * 自定义协议（`tauri://localhost`）在部分 WebView 版本里不算安全上下文 —— 直接依赖它
 * 会出现"按钮点了没反应"。于是先试现代 API，失败再退回"临时 `<textarea>` + `execCommand`"，
 * 后者在所有 WebView 里都能用（虽然已标记废弃，但它没有替代品能覆盖这种场景）。
 *
 * 返回是否成功：调用方据此给出"已复制 / 复制失败"的反馈，**不要**静默吞掉失败 ——
 * 用户按了按钮却什么都没发生，比一句提示更让人困惑。
 */

/** 现代 API 是否可用（存在且真正可调用）。 */
function hasAsyncClipboard(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard?.writeText === 'function'
  )
}

/**
 * 旧路：临时 textarea + `execCommand('copy')`。
 *
 * 必须满足三个条件，否则复制会**静默失败**（尤其在键盘焦点不在文档里时）：
 * 元素要真的在文档里、要能选中、不能因为 `display: none` 而不可选。
 * 因此这里用"移出视口但可见"的定位，并在 `finally` 里无条件清理（副作用可逆）。
 */
function copyViaTextarea(text: string): boolean {
  if (typeof document === 'undefined') return false
  const area = document.createElement('textarea')
  area.value = text
  // 只读 + 移出视口：既不打断页面滚动，也避免移动端弹出软键盘
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '-1000px'
  area.style.left = '-1000px'
  area.style.opacity = '0'
  document.body.appendChild(area)

  try {
    area.select()
    area.setSelectionRange(0, text.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
  }
}

/** 复制文本；返回是否成功（失败时调用方负责提示）。 */
export async function copyText(text: string): Promise<boolean> {
  if (text === '') return false

  if (hasAsyncClipboard()) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // 权限被拒、非安全上下文、窗口失焦……都走到下面那条路
    }
  }
  return copyViaTextarea(text)
}
