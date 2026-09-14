/**
 * 预览的**解析** Worker：正文 → 未净化的 HTML。仅此一件事。
 *
 * 为什么这里不净化（这是这个文件存在的全部理由）：DOMPurify 依赖 `window`，
 * 在 Worker 里 `isSupported === false` 且 `sanitize` 根本没有被定义 —— 调用会抛
 * `TypeError: DOMPurify.sanitize is not a function`。净化留在主线程
 * （`features/preview/MarkdownPreview.tsx` 拿到回包后过 `sanitizeHtml`），
 * 而且这一步**必须**做：Worker 只是换了个线程，不构成任何信任边界。
 *
 * 图片也在这里"半成品"化：Worker 里没有全库索引（条目表可能上千条，而正文只有一份），
 * 所以图片一律出"待解析"占位（`data-mn-defer`），由主线程补解析后再换 `<img>` ——
 * 否则大文档里的本地图片会全部停在终态占位上，一张都显示不出来。
 */

import { parseMarkdown } from '@/domain/markdown-core'

import type { PreviewRenderReply, PreviewRenderRequest } from './preview-worker'

/**
 * Worker 全局作用域。
 *
 * 为什么不写 `self.onmessage`：本仓库的 tsconfig 只有 DOM 库（没有 WebWorker 库），
 * `self` 的类型是 `Window & typeof globalThis` —— 直接写会被推断成 window 的事件，
 * 而这里**只**要 `onmessage` 与 `postMessage` 两件事，显式收窄反而更诚实。
 * （`PreviewRenderRequest`/`Reply` 用 `import type` 引入：类型会被完全擦除，
 * 这个 worker 的产物里不会带上主线程那个模块。）
 */
const scope = globalThis as unknown as {
  onmessage: ((event: { data: unknown }) => void) | null
  postMessage: (message: PreviewRenderReply) => void
}

/** 消息形状校验：投递方是我们自己的代码，但线程边界的输入一律当不可信处理。 */
function readRequest(data: unknown): PreviewRenderRequest | null {
  if (typeof data !== 'object' || data === null) return null
  const record = data as Record<string, unknown>
  const requestId = record['requestId']
  const docKey = record['docKey']
  const body = record['body']
  if (typeof requestId !== 'number' || typeof docKey !== 'string' || typeof body !== 'string') {
    return null
  }
  return { requestId, docKey, body }
}

scope.onmessage = (event) => {
  const request = readRequest(event.data)
  // 形状不对就**不回包**：连请求号都读不出来，回什么主线程都配不上，
  // 静默丢弃比回一条对不上号的错更安全（主线程那次渲染会一直等下去，
  // 而那说明投递侧已经坏了 —— 这不是这里能补救的）。
  if (request === null) return

  try {
    scope.postMessage({
      requestId: request.requestId,
      docKey: request.docKey,
      html: parseMarkdown(request.body, { imageDefer: true }),
    })
  } catch (cause) {
    // 解析抛错（畸形正文触发了 markdown-it 或我们自己的规则里的 bug）：
    // 把错误送回主线程，由它永久回退同步路径 —— 同步路径与这里同源，
    // 但至少错误会带着栈出现在应用日志里。
    scope.postMessage({
      requestId: request.requestId,
      docKey: request.docKey,
      kind: 'error',
      message: cause instanceof Error ? cause.message : String(cause),
    })
  }
}
