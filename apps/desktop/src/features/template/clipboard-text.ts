/**
 * 读系统剪贴板的纯文本（`@clipboard` 的唯一取数口）。
 *
 * 为什么单独成模块：**两个**消费者要用它 —— 编辑器里的 `@` 补全（选中 `@clipboard` 时插入）
 * 与「从模板新建」（展开 `@clipboard` 时取值）。两处各写一遍的话，失败语义会立刻分叉
 * （一处提示"剪贴板里没有内容"、另一处静默插空串），而"拿不到就是拿不到"这条判断
 * 本来就该只有一处。
 *
 * 与 `app/clipboard.ts`（**写**剪贴板，复制正文/链接用）刻意分开：那边有一条
 * `execCommand('copy')` 兜底，读没有等价兜底（`document.execCommand('paste')` 在所有现代
 * WebView 里都不可用），两者的失败处理完全不同。
 *
 * 两个模块都碰 `navigator` / `document`，因此都**不在 `domain/`**（ADR-0060 的纯净性判据）：
 * 「写剪贴板」住在 `app/clipboard.ts`（运行时能力），「读剪贴板」留在这里（只有一个消费者面）。
 */

/** 读剪贴板纯文本；拿不到（权限被拒 / 非安全上下文 / 平台不支持）返回 `null`。 */
export async function readClipboardText(): Promise<string | null> {
  if (typeof navigator === 'undefined') return null
  const clipboard = navigator.clipboard
  if (clipboard === undefined || typeof clipboard.readText !== 'function') return null
  try {
    return await clipboard.readText()
  } catch {
    return null
  }
}
