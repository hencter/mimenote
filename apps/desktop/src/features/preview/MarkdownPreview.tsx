/**
 * Markdown 预览。
 *
 * 渲染是**净化后**的 HTML（见 domain/markdown.ts），因此可以安全地走 dangerouslySetInnerHTML。
 * 大文档用 `useDeferredValue` 降低渲染优先级，保证输入不被预览拖慢（M5 会迁移到 Web Worker）。
 *
 * 链接交互（M2）：
 * - `[[wikilink]]` 渲染成 `a.mn-wikilink`，宿主索引返回后由这里补上"已解析/悬空"的类名；
 * - 点击 wikilink → 打开目标笔记；悬空 → 直接创建（Obsidian 的核心手感）；
 * - 点击 `[x](别的笔记.md)` → 同样走内部跳转；
 * - 外部链接不在应用内打开（M2 尚未接入系统浏览器），给出提示而不是让 WebView 跳走。
 */

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'

import { createNoteFromLink, openNote } from '@/app/actions'
import { Icon } from '@/components/Icon'
import { createAssetResolver, isImageAssetTarget } from '@/domain/assets'
import { frontmatterBody } from '@/domain/frontmatter'
import { isInternalNoteHref, normalizeLinkTarget } from '@/domain/links'
import { imagePlaceholderHtml, renderMarkdown, type ImageResolution } from '@/domain/markdown'
import { ipc, isTauriRuntime } from '@/ipc/client'
import { convertAssetUrl } from '@/ipc/tauri-adapter'
import { useLinksStore } from '@/state/links-store'
import { useNoteStore } from '@/state/note-store'
import { toast } from '@/state/toast-store'
import { useVaultStore } from '@/state/vault-store'

/** 单次授权请求的图片数上限（宿主也有自己的上限；超出部分留到下一轮渲染再请求）。 */
const ASSET_REQUEST_BATCH = 200

export function MarkdownPreview() {
  const relPath = useNoteStore((state) => state.doc?.relPath ?? null)
  const text = useNoteStore((state) => state.doc?.text ?? '')
  const links = useLinksStore((state) => state.links)
  const rootPath = useVaultStore((state) => state.info?.rootPath ?? null)
  /** Vault 条目表：给"裸文件名图片"做全库兜底解析用（已在 store 里，不额外请求）。 */
  const entries = useVaultStore((state) => state.entries)
  const bodyRef = useRef<HTMLElement | null>(null)

  /**
   * 已授权的图片：键是 `Vault 根 + 相对路径`（换 Vault 后旧条目不会被误用），值是 asset URL。
   *
   * 为什么需要它：本地图片要**逐文件**向宿主换取读权限（ADR-0007 —— 目录级作用域会被
   * Vault 内的符号链接绕过），因此渲染分两步：先渲染带 `data-mn-asset` 的占位元素，
   * 拿到授权后再重渲染成真正的 `<img>`。
   */
  const [assetUrls, setAssetUrls] = useState<ReadonlyMap<string, string>>(() => new Map())
  /** 正在请求中的键：避免同一张图在多次渲染之间重复请求。 */
  const pendingAssetsRef = useRef<Set<string>>(new Set())
  /** 已请求过但失败/不存在的键：不再反复请求。 */
  const deniedAssetsRef = useRef<Set<string>>(new Set())

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
  const resolveAsset = useMemo(
    () => createAssetResolver(entries),
    [entries],
  )

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
        const url = assetUrls.get(key)
        return url === undefined ? { kind: 'unauthorized', rel } : { kind: 'ready', url }
      },
    }
  }, [rootPath, relPath, assetUrls, resolveAsset])

  // 预览只渲染正文：frontmatter 是"元数据"，它已经由标签面板的属性表展示，
  // 渲染出来只会变成一条横线加几行 `key: value`（见 domain/frontmatter.ts 的判定口径）
  const html = useMemo(
    () => (relPath === null ? '' : renderMarkdown(frontmatterBody(deferredText), imageEnv)),
    [relPath, deferredText, imageEnv],
  )
  const stale = deferredText !== text

  /**
   * 为这一屏里"能解析但还没授权"的图片**批量**换取读权限。
   *
   * 一次 IPC 拿一整批（不是每张图一次往返），每批上限见 {@link ASSET_REQUEST_BATCH}：
   * 宿主单次请求有上限，超出的部分留在占位态，由**下一轮渲染**继续请求（授权结果写进
   * `assetUrls` → `imageEnv` 变 → `html` 变 → 本效果再跑一次），因此不会丢图。
   *
   * 宿主的返回里只含**通过校验**的路径（越界、符号链接逃逸、非图片扩展名都会被跳过），
   * 没返回的就是拿不到授权，永久留在占位态（不再反复请求）。
   */
  useEffect(() => {
    const root = bodyRef.current
    if (root === null || !isTauriRuntime() || rootPath === null) return

    const wanted = new Set<string>()
    for (const element of Array.from(root.querySelectorAll('[data-mn-asset]'))) {
      const rel = element.getAttribute('data-mn-asset')
      if (rel === null || rel === '') continue
      const key = `${rootPath}\u0000${rel}`
      if (pendingAssetsRef.current.has(key) || deniedAssetsRef.current.has(key)) continue
      wanted.add(rel)
      if (wanted.size >= ASSET_REQUEST_BATCH) break
    }
    if (wanted.size === 0) return

    const keys = [...wanted].map((rel) => `${rootPath}\u0000${rel}`)
    for (const key of keys) pendingAssetsRef.current.add(key)

    void (async () => {
      try {
        const grants = await ipc.assetAuthorize([...wanted])
        setAssetUrls((current) => {
          const next = new Map(current)
          for (const grant of grants) {
            next.set(`${rootPath}\u0000${grant.relPath}`, convertAssetUrl(grant.absolutePath))
          }
          return next
        })
        const granted = new Set(grants.map((grant) => grant.relPath))
        for (const rel of wanted) {
          if (!granted.has(rel)) deniedAssetsRef.current.add(`${rootPath}\u0000${rel}`)
        }
      } catch {
        // 授权失败（旧宿主没有这个命令、Vault 只读等）：永久回退占位元素，不刷屏报错
        for (const key of keys) deniedAssetsRef.current.add(key)
      } finally {
        for (const key of keys) pendingAssetsRef.current.delete(key)
      }
    })()
  }, [html, rootPath])

  /**
   * 图片加载失败 → 就地换成占位元素。
   *
   * 为什么必须做：作用域没覆盖到、文件被删掉、路径其实是外部资源……都会让 `<img>` 变成裂图，
   * 那比"没有图片"更糟。这里用**捕获阶段**的 error（error 事件不冒泡）+ 原始地址回退成占位。
   */
  useEffect(() => {
    const root = bodyRef.current
    if (root === null) return
    const onError = (event: Event): void => {
      const target = event.target
      if (!(target instanceof HTMLImageElement) || !target.classList.contains('mn-image')) return
      const src = target.getAttribute('data-mn-src') ?? target.getAttribute('src') ?? ''
      const holder = document.createElement('span')
      holder.innerHTML = imagePlaceholderHtml(src, target.getAttribute('alt') ?? '')
      const node = holder.firstElementChild
      if (node !== null) target.replaceWith(node)
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
    for (const element of Array.from(root.querySelectorAll('a.mn-wikilink'))) {
      const key = normalizeLinkTarget(element.getAttribute('data-target') ?? '')
      const match = outbound.find((link) => normalizeLinkTarget(link.rawTarget) === key)
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

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      const target = event.target
      if (!(target instanceof Element)) return
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
      <div className="mn-preview mn-preview--empty">
        <p className="mn-empty__text">没有打开的笔记</p>
      </div>
    )
  }

  return (
    <div className={`mn-preview${stale ? ' mn-preview--stale' : ''}`}>
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
          <Icon name="refresh" size={12} /> 正在同步预览…
        </div>
      )}
    </div>
  )
}
