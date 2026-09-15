/**
 * Markdown 预览。
 *
 * 渲染是**净化后**的 HTML（见 domain/markdown.ts），因此可以安全地走 dangerouslySetInnerHTML。
 * 大文档用 `useDeferredValue` 降低渲染优先级，保证输入不被预览拖慢。
 *
 * 大文档（≥ PREVIEW_WORKER_MIN_BYTES）的**解析**交给 Web Worker（见 `preview-worker.ts`：
 * 为什么只能搬解析、搬不走净化），净化与落地仍在主线程。
 *
 * 链接交互（M2）：
 * - `[[wikilink]]` 渲染成 `a.mn-wikilink`，宿主索引返回后由这里补上"已解析/悬空"的类名；
 * - 点击 wikilink → 打开目标笔记；悬空 → 直接创建（Obsidian 的核心手感）；
 * - 点击 `[x](别的笔记.md)` → 同样走内部跳转；
 * - 外部链接不在应用内打开（M2 尚未接入系统浏览器），给出提示而不是让 WebView 跳走。
 *
 * 代码块（M3）：每个 `<pre>` 挂一个"复制"按钮与语言标签，点击由同一处委托处理
 * （见 `code-copy.ts`，其中写了"为什么渲染完再挂按钮"）。
 *
 * 图片（ADR-0007）：正文里先出占位元素，拿到宿主的逐文件授权后**就地**把那个占位换成 `<img>`
 * —— 绝不重算整篇 HTML（见下面 "补图" 那段 effect 的注释）。
 */

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'

import { createNoteFromLink, openNote } from '@/app/actions'
import { Icon } from '@/components/Icon'
import { createAssetResolver, isImageAssetTarget } from '@/domain/assets'
import { frontmatterBody } from '@/domain/frontmatter'
import { isInternalNoteHref, normalizeLinkTarget } from '@/domain/links'
import {
  imageHtml,
  imagePlaceholderHtml,
  imageSpecFromElement,
  renderMarkdown,
  sanitizeHtml,
  type ImageResolution,
} from '@/domain/markdown'
import { ipc, isTauriRuntime } from '@/ipc/client'
import { convertAssetUrl } from '@/ipc/tauri-adapter'
import { useLinksStore } from '@/state/links-store'
import { useNoteStore } from '@/state/note-store'
import { toast } from '@/state/toast-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'

import { attachCodeCopyButtons, handleCodeCopyClick } from './code-copy'
import {
  createPreviewRenderChannel,
  previewWorkerMinBytes,
  type PreviewRenderChannel,
} from './preview-worker'
import './preview-code.css'

/** 单次授权请求的图片数上限（宿主也有自己的上限；超出部分留到下一轮再请求）。 */
const ASSET_REQUEST_BATCH = 200

/**
 * 把一个元素**就地**换成另一份 HTML，返回新节点。
 *
 * 为什么不用 React 重渲染：`<div dangerouslySetInnerHTML>` 一变就是整篇重建
 * （markdown-it + DOMPurify + innerHTML + 全篇扫描），补 N 张图会来 ⌈N/200⌉+1 次。
 * 就地替换只动那一个节点 —— 其它节点的对象身份保持不变，灯箱的画廊快照、
 * 代码块的复制按钮、大纲的当前标题都不会被打断。
 *
 * 这里的 HTML 不经过 DOMPurify，安全性由**构造**保证：`imageHtml` 用 `escapeHtml` 拼属性，
 * 而规格来源（占位元素上的 `data-mn-*`）本身已经过净化，读回来是纯文本、再拼一次仍被转义。
 */
function replaceElementHtml(element: Element, html: string): Element | null {
  const holder = document.createElement('div')
  holder.innerHTML = html
  const node = holder.firstElementChild
  if (node === null) return null
  element.replaceWith(node)
  return node
}

export function MarkdownPreview() {
  const relPath = useNoteStore((state) => state.doc?.relPath ?? null)
  const text = useNoteStore((state) => state.doc?.text ?? '')
  /** 版本令牌：只在"打开 / 重新加载 / 外部改动"时自增，用于给 Worker 结果打上"哪一篇的哪个版本"。 */
  const revision = useNoteStore((state) => state.doc?.revision ?? 0)
  const links = useLinksStore((state) => state.links)
  const rootPath = useVaultStore((state) => state.info?.rootPath ?? null)
  /** Vault 条目表：给"裸文件名图片"做全库兜底解析用（已在 store 里，不额外请求）。 */
  const entries = useVaultStore((state) => state.entries)
  const viewMode = useUiStore((state) => state.viewMode)
  const bodyRef = useRef<HTMLElement | null>(null)

  /**
   * 已授权的图片：键是 `Vault 根 + 相对路径`（换 Vault 后旧条目不会被误用），值是 asset URL。
   *
   * 它现在**只是缓存**（"这张图已经授权过"）：不再参与 HTML 的计算 ——
   * 参考点一：把 assetUrls 放进 imageEnv 的依赖，等于每批授权都重算整篇 HTML；
   * 参考点二：正文里的 `<img>` 由补图流程就地换上去，那时已经没有 markdown 令牌了。
   */
  const [assetUrls, setAssetUrls] = useState<ReadonlyMap<string, string>>(() => new Map())
  /** 正在请求中的键：避免同一张图在多次渲染之间重复请求。 */
  const pendingAssetsRef = useRef<Set<string>>(new Set())
  /** 已请求过但失败/不存在的键：不再反复请求，就地留成终态占位。 */
  const deniedAssetsRef = useRef<Set<string>>(new Set())
  /**
   * 补图轮次：一次授权回来就 +1。
   *
   * 为什么需要它：补图的结果是**就地改 DOM**（不是 React 状态），而"这本笔记里还有哪些图
   * 该请求"要在下一次 effect 里重新扫一遍 DOM 才知道。授权**失败**时 `assetUrls` 不变
   * （没有新缓存可写），只靠 `assetUrls` 的引用变化触发不了重跑，那一批图就会永远停在
   * "等授权"的骨架态上 —— 所以用一个显式的计数器把这件事说清楚。
   */
  const [hydrationTicket, setHydrationTicket] = useState(0)
  /** Worker 通道永久失效（构造失败/onerror）：此后一律走同步路径，不再重试。 */
  const [workerFailed, setWorkerFailed] = useState(false)
  const workerChannelRef = useRef<PreviewRenderChannel | null>(null)
  /** Worker 送回来的（已净化的）HTML，连同"它是哪篇文档、哪份正文"的凭据。 */
  const [workerHtml, setWorkerHtml] = useState<{ docKey: string; body: string; html: string } | null>(
    null,
  )

  // 换 Vault 就清空授权缓存与去重集合
  useEffect(() => {
    setAssetUrls(new Map())
    pendingAssetsRef.current = new Set()
    deniedAssetsRef.current = new Set()
  }, [rootPath])

  const deferredText = useDeferredValue(text)

  /**
   * 图片地址解析（ADR-0007）：只有真实宿主 + 已知 Vault 根时才产出 asset URL。
   *
   * 解析用**带全库索引**的解析器（`createAssetResolver`）：`![[图.png]]` 这种裸文件名
   * 会先按"相对当前笔记"找，找不到再按文件名在整库图片里唯一匹配 —— 从 Obsidian 过来的
   * 用户默认就是这个语义，只按相对路径解析会让他们的图全变成占位元素。
   *
   * 浏览器预览（`pnpm dev`）没有 asset 协议，解析器缺席 → 直接渲染占位元素，
   * 而不是产出一堆必然加载失败的 URL。
   */
  const resolveAsset = useMemo(() => createAssetResolver(entries), [entries])

  const imageEnv = useMemo(() => {
    if (!isTauriRuntime() || rootPath === null || relPath === null) return {}
    return {
      resolveImage: (src: string): ImageResolution | null => {
        const rel = resolveAsset(relPath, src)
        // `![[…]]` 里不是图片的目标（例如 `![[另一篇笔记]]`）不该按图片占位
        if (rel === null || !isImageAssetTarget(rel)) return null
        const key = `${rootPath}\u0000${rel}`
        // 已被宿主拒过（越界、符号链接逃逸、不存在、非图片）：直接给"终态占位"，
        // 不要再渲染成"等授权"的样子 —— 否则它会一直挂着授权标记与骨架动画。
        if (deniedAssetsRef.current.has(key)) return null
        // ⚠️ **即使已经授权过也不在这里出 `<img>`**：那要求 assetUrls 参与 html 的依赖，
        // 于是每批授权回来都要重算整篇 HTML（N 张图 = ⌈N/200⌉+1 次 markdown-it + DOMPurify +
        // innerHTML + 全篇扫描）。这里一律先给"等授权"的占位，真正的图由补图 effect
        // **就地换掉那一个节点**补上去。
        return { kind: 'unauthorized', rel }
      },
    }
    // 刻意**不含** assetUrls：它只是缓存，改变它不该让整篇 HTML 重算（见上面的注释）。
    // 代价是这里读的是 deniedAssetsRef（一个 ref）：被拒的图要等补图 effect 把它换掉，
    // 而 effect 依赖 html —— 这正是"一次渲染 + 一次就地替换"的来源。
  }, [rootPath, relPath, resolveAsset])

  // 预览只渲染正文：frontmatter 是"元数据"，它已经由标签面板的属性表展示，
  // 渲染出来只会变成一条横线加几行 `key: value`（见 domain/frontmatter.ts 的判定口径）
  const body = useMemo(
    () => (relPath === null ? '' : frontmatterBody(deferredText)),
    [relPath, deferredText],
  )

  /**
   * 这一篇文档的身份：路径 + 版本号。
   *
   * 为什么还要路径：`revision` 只在"打开/重新加载"时自增，而通道可能在两篇笔记之间被复用
   * （同一篇笔记里连续编辑时 revision 根本不变）—— 两个凭据一起看，切笔记后旧结果才没有
   * 任何机会写进 DOM。
   */
  const docKey = relPath === null ? '' : `${relPath}\u0000${revision}`

  /**
   * 这次渲染走 Worker 吗。
   *
   * 四条门槛，缺一走同步（同步路径与改造前**完全一致**，这是所有既有行为的地基）：
   * 1. `viewMode === 'read'`：只有阅读视图在渲染正文（组件本身也只在这里挂载，这里再判一次
   *    是为了"离开阅读视图就释放线程"有一个明确的判据）；
   * 2. `typeof Worker === 'undefined'`：环境里根本没有 Worker（jsdom、老 WebView）；
   * 3. 正文长度 ≥ 门槛（`previewWorkerMinBytes()`，默认 1 MiB，依据见 preview-worker.ts）；
   * 4. `!workerFailed`：构造/运行期失败过一次之后**永久**走同步，不再重试。
   *
   * ⚠️ 刻意**不**再判 `isTauriRuntime()`：这条路径与宿主无关（纯 JS 解析），而判它的代价是
   * "只有真实 WebView 里才走 Worker" —— 于是 UI 层 E2E（系统 Edge）永远看不到 `worker`，
   * jsdom 里又没有 `Worker`，能观察它的地方只剩"CDP 会不会上报 worker target"这种不确定的事。
   * 现在浏览器预览（`pnpm dev`）也走同一条路，UI 层 E2E 用 `page.workers()` 就能把它钉住。
   */
  const usesWorker =
    relPath !== null &&
    !workerFailed &&
    viewMode === 'read' &&
    body.length >= previewWorkerMinBytes() &&
    typeof Worker !== 'undefined'

  /**
   * 现在就**把这份正文发给 Worker** 吗 —— 比 {@link usesWorker} 多一条"正文已经不再落后"。
   *
   * 为什么必须有这一条（一个真实的坑）：`useDeferredValue` 让**正文**比**路径**慢一拍。
   * 切笔记的那一瞬间 `relPath`/`revision` 已经是新的，而 `deferredText` 还是上一篇的 ——
   * 于是 (docKey, body) 这一对会短暂地"串味"：新笔记的键配上上一篇的正文。
   * 通道那边只按 `docKey` 配对，这份串味的正文会被当成新笔记的结果落地，
   * 表现就是"切过去先闪一下上一篇的内容"。
   *
   * 顺带的好处：正文没落定就不发请求，连续打字不会每敲一个键就克隆并解析一遍 1 MiB
   * （`useDeferredValue` 本来就会把突发输入合并，这里只是不再把中间态也送出去）。
   *
   * 代价（明确的取舍）：大文档在持续输入期间显示的是**上一次**渲染结果 + "正在同步预览…"
   * 提示，直到输入停下来。对 1 MiB 文档来说，这比"每敲一个键阻塞主线程 674ms"好得多。
   */
  const dispatchWorker = usesWorker && deferredText === text

  /**
   * 同步渲染结果。
   *
   * 走 Worker 时**不算**它：这一条就是"界面还能动"的全部来源 —— 1 MiB 正文的
   * markdown-it 解析约 674ms，同步算出来就等于把主线程按在那里 674ms。
   *
   * 依赖里放 `usesWorker` 是必需的：Worker 失效后它变 `false`，这一个 memo 立刻重算，
   * 正文在**同一次渲染**里就回到同步结果（不会留下空白屏）。
   */
  const syncHtml = useMemo(
    () => (relPath === null || usesWorker ? '' : renderMarkdown(body, imageEnv)),
    [relPath, body, imageEnv, usesWorker],
  )

  /** Worker 的结果是"这篇文档的这份正文"渲染出来的吗（差一个字符就还算旧内容）。 */
  const workerFresh =
    workerHtml !== null && workerHtml.docKey === docKey && workerHtml.body === body

  /**
   * 真正落地到 DOM 的 HTML。
   *
   * Worker 路径下 `docKey` 对不上时给空串：切到另一篇笔记的瞬间**绝不能**还显示上一篇的正文。
   * 同一篇笔记里正文变了（revision 不变）则保留上一次的结果直到新的回来 —— 大文档重新解析
   * 要几百毫秒，中间清空会让正文闪一下，而"防抖合并"已经由 `useDeferredValue` 兜住了。
   */
  const html = usesWorker
    ? workerHtml !== null && workerHtml.docKey === docKey
      ? workerHtml.html
      : ''
    : syncHtml

  /** 走了哪条路。挂成 `data-mn-render` 供 E2E 断言 —— "开了 Worker 没有"不该靠肉眼猜。 */
  const renderPath: 'worker' | 'sync' = usesWorker ? 'worker' : 'sync'
  const stale = deferredText !== text || (usesWorker && !workerFresh)

  /** 通道按需创建：构造失败（CSP/不支持）就地永久回退同步，只记一次 warn。 */
  const ensureChannel = useCallback((): PreviewRenderChannel | null => {
    if (workerChannelRef.current !== null) return workerChannelRef.current
    const channel = createPreviewRenderChannel({
      // 能失败的都不是偶发问题（CSP、WebView 不支持、回包错乱）：永久回退，不重试。
      onFatal: () => {
        setWorkerFailed(true)
      },
    })
    if (channel === null) {
      setWorkerFailed(true)
      return null
    }
    workerChannelRef.current = channel
    return channel
  }, [])

  /**
   * 渲染管线：大文档把**解析**交给 Worker，拿到未净化 HTML 后在主线程净化再落地。
   *
   * 依赖只有三项（正文、文档键、要不要发）：任何一项变化都意味着"上一次的结果作废"。
   * 不要在这里依赖 `html` —— 它就是本 effect 的产物，依赖它会自己触发自己。
   */
  useEffect(() => {
    if (!usesWorker) {
      // 同步路径不占线程：顺手回收上一次留下的（正文缩到门槛以下、或离开了阅读视图）
      workerChannelRef.current?.terminate()
      workerChannelRef.current = null
      return
    }
    // 正文还没落定（`useDeferredValue` 慢一拍）：先不发，等它追上来 —— 见 dispatchWorker 的注释
    if (!dispatchWorker) return
    const channel = ensureChannel()
    if (channel === null) return

    let cancelled = false
    void channel
      .render(docKey, body)
      .then((raw) => {
        // 通道在更新一次请求时会以 `null` 收场：那不是结果，什么都不做
        if (cancelled || raw === null) return
        try {
          // 净化只能在主线程做（Worker 里 DOMPurify 的 `sanitize` 根本没有被定义）
          setWorkerHtml({ docKey, body, html: sanitizeHtml(raw) })
        } catch {
          // 净化抛错理论上不该发生；真发生了就退回同步路径，而不是让预览白屏
          setWorkerFailed(true)
        }
      })
      .catch(() => {
        setWorkerFailed(true)
      })

    return () => {
      cancelled = true
    }
  }, [usesWorker, dispatchWorker, docKey, body, ensureChannel])

  // 组件卸载：Worker 是一条真实线程，留着它只会白占内存与 CPU（可逆副作用的收口）
  useEffect(
    () => () => {
      workerChannelRef.current?.terminate()
      workerChannelRef.current = null
    },
    [],
  )

  /**
   * **补图**：为这一屏里"能解析但还没授权"的图片批量换取读权限，拿到结果后就地换掉那一个节点。
   *
   * 一次 IPC 拿一整批（不是每张图一次往返），每批上限见 {@link ASSET_REQUEST_BATCH}：
   * 超出的部分留到下一轮（授权结果写进 `assetUrls` → `hydrationTicket` 变 → 本 effect 再跑一次），
   * 因此不会丢图。
   *
   * 宿主的返回里只含**通过校验**的路径（越界、符号链接逃逸、非图片扩展名都会被跳过），
   * 没返回的就是拿不到授权：**就地换成终态占位**（不带 `data-mn-asset`，于是不会被反复请求，
   * 也不会一直闪骨架动画 —— CSS 全靠那个标记区分"等授权"与"已经放弃"）。
   *
   * 三种占位在这一处收敛：
   * - `data-mn-asset`：整篇渲染时解析出的 Vault 相对路径（同步路径）；
   * - `data-mn-defer`：Worker 里没有全库索引，目标**还没解析** —— 用它带着的原始地址
   *   在这里补一次解析（同一个 `resolveAsset`，所以两条路的解析口径不会分叉）；
   * - 两者都没有：终态占位，什么都不做。
   */
  useEffect(() => {
    const root = bodyRef.current
    if (root === null) return
    // 非 Tauri 运行时（浏览器预览）没有 asset 协议：占位元素就是终态，不解析也不请求
    if (!isTauriRuntime() || rootPath === null || relPath === null) return

    const candidates = Array.from(root.querySelectorAll('.mn-image-placeholder')).filter(
      (element) => element.hasAttribute('data-mn-asset') || element.hasAttribute('data-mn-defer'),
    )
    if (candidates.length === 0) return

    /** 本轮要请求的图：key → 相对路径（同一个 key 只请求一次，与元素出现几次无关）。 */
    const wanted = new Map<string, string>()
    for (const element of candidates) {
      const spec = imageSpecFromElement(element)
      const rel = spec.assetRel ?? resolveAsset(relPath, spec.src)
      // 越界、外部地址、非图片：终态占位（把两个待办标记都摘掉）
      if (rel === null || !isImageAssetTarget(rel)) {
        replaceElementHtml(
          element,
          imageHtml({ ...spec, assetRel: undefined, defer: undefined }),
        )
        continue
      }
      const key = `${rootPath}\u0000${rel}`
      const url = assetUrls.get(key)
      if (url !== undefined) {
        replaceElementHtml(
          element,
          imageHtml({ ...spec, assetRel: undefined, defer: undefined, url }),
        )
        continue
      }
      if (deniedAssetsRef.current.has(key)) {
        replaceElementHtml(
          element,
          imageHtml({ ...spec, assetRel: undefined, defer: undefined }),
        )
        continue
      }
      if (pendingAssetsRef.current.has(key)) continue
      // 本批已满：留在占位态，下一轮再请求（不能丢图）
      if (wanted.size >= ASSET_REQUEST_BATCH) continue
      wanted.set(key, rel)
    }

    if (wanted.size === 0) return
    const batch = [...wanted]
    for (const [key] of batch) pendingAssetsRef.current.add(key)

    void (async () => {
      let grants: Awaited<ReturnType<typeof ipc.assetAuthorize>> = []
      try {
        grants = await ipc.assetAuthorize(batch.map(([, rel]) => rel))
      } catch {
        // 授权失败（旧宿主没有这个命令、Vault 只读等）：整批按"拒绝"处理，不刷屏报错
        grants = []
      }

      const granted = new Map<string, string>()
      for (const grant of grants) {
        granted.set(`${rootPath}\u0000${grant.relPath}`, convertAssetUrl(grant.absolutePath))
      }
      for (const [key] of batch) {
        pendingAssetsRef.current.delete(key)
        if (!granted.has(key)) deniedAssetsRef.current.add(key)
      }
      if (granted.size > 0) {
        setAssetUrls((current) => {
          const next = new Map(current)
          for (const [key, url] of granted) next.set(key, url)
          return next
        })
      }
      // 无论成功与否都踢一轮：成功 → 换 `<img>` 并继续下一批；失败 → 就地换终态占位。
      setHydrationTicket((ticket) => ticket + 1)
    })()
  }, [html, rootPath, relPath, assetUrls, hydrationTicket, resolveAsset])

  /**
   * 图片加载失败 → 就地换成占位元素。
   *
   * 为什么必须做：作用域没覆盖到、文件被删掉、路径其实是外部资源……都会让 `<img>` 变成裂图，
   * 那比"没有图片"更糟。这里用**捕获阶段**的 error（error 事件不冒泡）+ 原始地址回退成占位。
   *
   * 与"补图"共用 `imageHtml`：`<img>` 与占位元素是同一个生成器的两个分支，
   * 所以"失败后"和"从没成功过"长得一模一样。
   */
  useEffect(() => {
    const root = bodyRef.current
    if (root === null) return
    const onError = (event: Event): void => {
      const target = event.target
      if (!(target instanceof HTMLImageElement) || !target.classList.contains('mn-image')) return
      const src = target.getAttribute('data-mn-src') ?? target.getAttribute('src') ?? ''
      replaceElementHtml(target, imagePlaceholderHtml(src, target.getAttribute('alt') ?? ''))
    }
    root.addEventListener('error', onError, true)
    return () => {
      root.removeEventListener('error', onError, true)
    }
  }, [html])

  // 把宿主索引的解析结果"贴"到渲染出来的 wikilink 上（不重新渲染 HTML）
  useEffect(() => {
    const root = bodyRef.current
    if (root === null) return

    const outbound = links?.outbound ?? []
    /**
     * 出链的归一化**只做一次**：`rawTarget → 出链`。
     *
     * 为什么必须建表：改造前对每个 `a.mn-wikilink` 都要 `outbound.find(...)`，而 find 的回调里
     * 又对每条出链调用 `normalizeLinkTarget` —— 2000 条链接的笔记就是 2000×N 次字符串归一化
     * （每篇笔记都有出链表，等于每次渲染都做一遍二次方工作）。
     *
     * `!byTarget.has(key)` 判重是**行为等价的硬要求**：`Array.prototype.find` 命中的是数组里
     * **第一个**匹配项，直接 `set` 会让后面的覆盖前面的，"同一目标出现多次"结果就变了。
     */
    const byTarget = new Map<string, (typeof outbound)[number]>()
    for (const link of outbound) {
      const key = normalizeLinkTarget(link.rawTarget)
      if (!byTarget.has(key)) byTarget.set(key, link)
    }

    for (const element of Array.from(root.querySelectorAll('a.mn-wikilink'))) {
      const key = normalizeLinkTarget(element.getAttribute('data-target') ?? '')
      const match = byTarget.get(key)
      const resolved = match?.resolvedRelPath ?? null

      element.classList.toggle('mn-wikilink--unresolved', resolved === null)
      element.classList.toggle('mn-wikilink--ambiguous', match?.ambiguous === true)
      if (resolved === null) {
        element.removeAttribute('data-rel-path')
        element.setAttribute('title', `${element.getAttribute('data-target') ?? ''}（还不存在，点击创建）`)
      } else {
        element.setAttribute('data-rel-path', resolved)
        element.setAttribute('title', resolved)
      }
    }
  }, [html, links])

  // 代码块的"复制"按钮与语言标签（HTML 每次重建 → 这里重挂；卸载即摘掉）
  useEffect(() => attachCodeCopyButtons(bodyRef.current), [html])

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      const target = event.target
      if (!(target instanceof Element)) return

      // 代码块的复制按钮（是个 <button>，与下面的链接分支互不干扰）
      if (handleCodeCopyClick(target)) return

      const anchor = target.closest('a')
      if (anchor === null) return

      // wikilink：已解析 → 打开；悬空 → 创建
      if (anchor.classList.contains('mn-wikilink')) {
        event.preventDefault()
        const resolved = anchor.getAttribute('data-rel-path')
        if (resolved !== null) {
          void openNote(resolved)
        } else if (relPath !== null) {
          void createNoteFromLink(anchor.getAttribute('data-target') ?? '', relPath)
        }
        return
      }

      const href = anchor.getAttribute('href') ?? ''
      if (href === '' || href.startsWith('#')) return

      // Markdown 内部链接：用宿主返回的出链表判断指向哪一篇
      // （点击是一次性的，这里的线性查找与"补类名"的批量场景不是一回事，刻意保持不变）
      const key = normalizeLinkTarget(href)
      const match = (links?.outbound ?? []).find(
        (link) => normalizeLinkTarget(link.rawTarget) === key,
      )
      if (match?.resolvedRelPath != null) {
        event.preventDefault()
        void openNote(match.resolvedRelPath)
        return
      }

      if (isInternalNoteHref(href)) {
        event.preventDefault()
        if (relPath !== null) void createNoteFromLink(href, relPath)
        return
      }

      // 外部链接：不让 WebView 直接跳走（会丢掉整个界面）
      event.preventDefault()
      toast.info('外部链接未在应用内打开', `${href}（M2 之后接入系统浏览器打开）`)
    },
    [links, relPath],
  )

  if (relPath === null) {
    return (
      <div className="mn-preview mn-preview--empty" data-mn-render="sync">
        <p className="mn-empty__text">没有打开的笔记</p>
      </div>
    )
  }

  return (
    <div
      className={`mn-preview${stale ? ' mn-preview--stale' : ''}`}
      data-mn-render={renderPath}
    >
      <div className="mn-preview__scroller">
        {/* html 已由 DOMPurify 净化（两道防线见 domain/markdown.ts） */}
        <article
          className="mn-preview__body"
          ref={bodyRef}
          onClick={handleClick}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
      {stale && (
        <div className="mn-preview__stale-hint">
          <Icon name="refresh" size="xs" /> 正在同步预览…
        </div>
      )}
    </div>
  )
}
