/**
 * 预览解析的 **Worker 通道**（主线程侧）：协议、状态机、以及"什么时候根本不该开线程"的门槛。
 *
 * 为什么只把**解析**搬进 Worker（这是这一轮最重要的取舍）：
 * - 1 MiB 笔记实测：`renderMarkdown` 共约 4143.8ms，其中净化（DOMPurify）约 3469.4ms（≈84%），
 *   解析（markdown-it）约 674.5ms（≈16%）；
 * - 净化**搬不进去**：DOMPurify 的 ESM 入口在没有 `window` 的环境里 `isSupported === false`，
 *   `DOMPurify.sanitize` 甚至没有被定义 —— 在 Worker 里调用会直接抛
 *   `TypeError: DOMPurify.sanitize is not a function`，不是"慢一点"；
 *   而 DOM 构建、样式、布局本来也只能在主线程。
 *
 * 所以 Worker 的价值是**"解析那 674.5ms 里界面还能动"**，不是吞吐：净化与 `innerHTML` 落地
 * 仍然会把主线程卡住三秒多。这一点必须写清楚，否则下一次有人会以为"开了 Worker 就不卡了"。
 *
 * 协议（纯 JSON，**刻意不用 transferable**）：字符串的结构化克隆很便宜，而 ArrayBuffer 传输
 * 要求主线程放弃自己还要用的正文副本（正文同时归编辑器所有，"转移"等于把它从别人手里抢走）。
 * - 主 → Worker：`{ requestId, docKey, body }`
 * - Worker → 主：`{ requestId, docKey, html }`（**未净化**）或 `{ requestId, docKey, kind: 'error', message }`
 */

/**
 * "多大才值得开线程"的门槛（默认 1 MiB）。
 *
 * 依据是 §上面的实测占比：解析只占约 16%，省下的是"这一段时间的界面响应"，
 * 而代价是每篇文档一次结构化克隆 + 一次线程间往返。小文档（几 KB）解析通常 <1ms，
 * 为它开线程只会让每次编辑都多一次异步往返。
 *
 * ⚠️ 与 `features/export/export-note.ts` 的 `LARGE_EXPORT_BYTES = 5 MiB` **不是同一把尺子**：
 * 那个是"要不要提前告诉用户'要等几秒'"的心理阈值（导出要内嵌图片、整篇重写），
 * 这个只是"要不要换一条线程做解析"。两个数字各自独立，不要互相引用。
 *
 * ⚠️ 比较的是**字符数**（`body.length`），不是 UTF-8 字节数：`TextEncoder` 会为 1 MiB 正文
 * 再分配一份副本（正是本节刻意避免的那种复制），而门槛是个数量级判断 ——
 * 中文 1 字符 = 3 字节的差异不会改变"要不要开线程"这个决定。
 */
export const PREVIEW_WORKER_MIN_BYTES = 1024 * 1024

/** 单次渲染请求（与 `render.worker.ts` 是一份契约的读写两端）。 */
export interface PreviewRenderRequest {
  /** 1 起的自增序号：**只有最新那个**请求的结果会被采纳（旧结果一律丢弃）。 */
  requestId: number
  /** `${relPath}\u0000${revision}`：切笔记/重新加载后立刻变，回包对不上就当它作废。 */
  docKey: string
  /** 去掉 frontmatter 的正文。 */
  body: string
}

/** Worker 的回包。 */
export type PreviewRenderReply =
  | { requestId: number; docKey: string; html: string }
  | { requestId: number; docKey: string; kind: 'error'; message: string }

/**
 * 主线程真正用到的 Worker 面。
 *
 * 为什么自定义一个接口而不是直接用全局 `Worker` 类型：jsdom 里**没有** `Worker`，
 * 单元测试必须能塞一个假对象进来（手法与既有测试桩 `window.__TAURI_INTERNALS__` 一致）；
 * 只声明这四个成员，假对象就不必假装自己是完整实现。
 */
export interface PreviewWorkerPort {
  postMessage: (message: PreviewRenderRequest) => void
  terminate: () => void
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
  onmessageerror: ((event: unknown) => void) | null
}

export interface PreviewRenderChannel {
  /**
   * 发一次渲染请求。
   *
   * 返回值是**未净化**的 HTML；`null` 表示这一条结果已经作废（被更新的请求取代，
   * 或通道在这期间失效）—— 调用方拿到 `null` 什么都不做即可。
   */
  render: (docKey: string, body: string) => Promise<string | null>
  /** 释放线程。可逆副作用：切走阅读视图、组件卸载都会走到这里。 */
  terminate: () => void
}

export interface PreviewRenderChannelOptions {
  /**
   * 通道**永久**失效（构造失败 / onerror / 回包协议不符）。
   *
   * 为什么不重试：能失败的都不是偶发问题（CSP 不允许 worker、宿主 WebView 不支持、
   * 回包对不上号），重试只会让同一份正文反复走两条路、更难查。组件收到通知后
   * 永久回退同步路径 —— 与"图片授权失败就永久占位"是同一个姿态。
   */
  onFatal: (reason: string) => void
}

/** 当前门槛（测试可以调低：真在 jsdom 里渲染 1 MiB 正文要好几秒，而门槛本身不是被测对象）。 */
let minBytes = PREVIEW_WORKER_MIN_BYTES

/** 当前门槛值。 */
export function previewWorkerMinBytes(): number {
  return minBytes
}

/** 调整门槛（测试用；生产默认 {@link PREVIEW_WORKER_MIN_BYTES}）。 */
export function configurePreviewWorker(options: { minBytes?: number } = {}): void {
  if (options.minBytes !== undefined) minBytes = Math.max(0, options.minBytes)
}

/** 回包形状校验：Worker 是我们自己的代码，但线程边界的输入一律当不可信处理。 */
function readReply(data: unknown): PreviewRenderReply | null {
  if (typeof data !== 'object' || data === null) return null
  const record = data as Record<string, unknown>
  const requestId = record['requestId']
  const docKey = record['docKey']
  if (typeof requestId !== 'number' || typeof docKey !== 'string') return null
  if (record['kind'] === 'error') {
    const message = record['message']
    return { requestId, docKey, kind: 'error', message: typeof message === 'string' ? message : '' }
  }
  const html = record['html']
  if (typeof html !== 'string') return null
  return { requestId, docKey, html }
}

/**
 * 造一条通道；环境里没有 `Worker`（jsdom、老 WebView）时返回 `null`，调用方走同步路径。
 *
 * 注意 `new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' })`
 * 是**必须逐字保留**的写法：Vite 靠静态识别这一句来把 worker 单独打包（这也是刻意不用
 * `import X from './render.worker?worker'` 的原因 —— `?worker` 的默认导出是 Vite 生成的包装类，
 * 它**不经过 `globalThis.Worker`**，于是既没法在测试里桩掉，也让
 * "`typeof Worker === 'undefined'` 就退回同步"这条回退分支形同虚设）。
 */
export function createPreviewRenderChannel(
  options: PreviewRenderChannelOptions,
): PreviewRenderChannel | null {
  if (typeof Worker === 'undefined') return null

  // 每次构造最多记一次 warn：失败就不再重试了（同一个通道里失败必然是永久性的），
  // 记在**通道实例**上而不是模块上，测试之间才不会互相吃掉这条痕迹。
  let warned = false
  const warn = (reason: string, cause?: unknown): void => {
    if (warned) return
    warned = true
    // 不弹 toast：预览退化成同步渲染对用户是**无感**的（内容照样出来，只是慢回旧样子），
    // 为一件用户看不见的事打断阅读是更糟的选择。
    console.warn(`[preview] 解析 Worker 不可用，已回退同步渲染：${reason}`, cause)
  }

  let worker: PreviewWorkerPort
  try {
    worker = new Worker(new URL('./render.worker.ts', import.meta.url), {
      type: 'module',
    }) as unknown as PreviewWorkerPort
  } catch (cause) {
    // CSP 禁止 worker、宿主 WebView 不支持 module worker 都会走到这里
    warn('构造失败', cause)
    return null
  }

  let nextRequestId = 1
  let latest: {
    requestId: number
    docKey: string
    settle: (html: string | null) => void
  } | null = null
  let dead = false

  const fail = (reason: string, cause?: unknown): void => {
    if (dead) return
    dead = true
    warn(reason, cause)
    // 在途的那一个请求以 `null` 收场：调用方据此什么都不做，由组件切回同步路径重算。
    const pending = latest
    latest = null
    worker.terminate()
    pending?.settle(null)
    options.onFatal(reason)
  }

  worker.onmessage = (event) => {
    const reply = readReply(event.data)
    if (reply === null) {
      fail('回包形状不符')
      return
    }
    const pending = latest
    // 不是最新那个请求的回包 → 丢弃。慢的 worker 结果**绝不能**盖掉新内容：
    // 用户连打几个字、或切走又切回来，界面必须只认最后一次请求。
    if (pending === null || reply.requestId !== pending.requestId) return
    // 请求号相同但文档对不上：说明通道错乱了（例如被复用到了另一篇笔记），
    // 宁可当作永久失效，也不要往 DOM 里写一份来源不明的正文。
    if (reply.docKey !== pending.docKey) {
      fail('回包与请求的文档不符')
      return
    }
    if ('kind' in reply) {
      fail(`解析失败：${reply.message}`)
      return
    }
    latest = null
    pending.settle(reply.html)
  }
  worker.onerror = (event) => {
    fail('运行时报错', event)
  }
  worker.onmessageerror = (event) => {
    fail('回包无法反序列化', event)
  }

  return {
    render: (docKey, body) => {
      if (dead) return Promise.resolve(null)
      const requestId = nextRequestId
      nextRequestId += 1
      // 上一个请求从此不再是"最新"：它的回包会被上面的请求号检查丢掉，
      // 这里顺手把它的 promise 收掉，免得调用方一直挂着等一个永远不会被采纳的结果。
      const previous = latest
      latest = null
      previous?.settle(null)

      return new Promise<string | null>((resolve) => {
        latest = { requestId, docKey, settle: resolve }
        try {
          worker.postMessage({ requestId, docKey, body })
        } catch (cause) {
          fail('投递消息失败', cause)
        }
      })
    },
    terminate: () => {
      if (dead) return
      dead = true
      const pending = latest
      latest = null
      worker.terminate()
      pending?.settle(null)
    },
  }
}
