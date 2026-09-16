/**
 * 任意一篇笔记的**静态只读预览**（与阅读视图同一条渲染链路的"非当前文档"版本）。
 *
 * ## 它解决什么
 *
 * `MarkdownPreview` 不接收 props：它渲染的是 `note-store.doc`（当前打开的那一篇），还带着
 * 大文档 Worker 与图片授权那一整套管线。而这两处场景要显示的是**指定的另一篇**：
 *
 * - 图谱上的浮动笔记面板（`features/graph/FloatingNote.tsx`）—— 用户点开的那一篇；
 * - 容器切割树的叶子（`features/layout/TreeHost.tsx`）—— 激活标签是**非当前**笔记时
 *   （note-store 是单文档模型，编辑器全局只有一份；别的格子里的笔记只能是只读的）。
 *
 * 链路逐字对齐阅读视图，保证"同一篇笔记在四处看起来一致"：
 * `ipc.noteRead` → `renderMarkdown(frontmatterBody(text))`（返回的 HTML 已经过 DOMPurify
 * 净化，见 `domain/markdown.ts` 的两道防线）→ 出链表补 wikilink 的已解析/悬空标注
 * → 点击走 `openNote`。三条状态（加载中 / 出错 / 有正文）都处理。
 *
 * ## 与阅读视图的**两处刻意差异**
 *
 * - **不补图**：正文里的图片停留成占位元素（阅读视图那套逐文件授权 + 就地替换是给
 *   "当前文档"的重管线，浮窗与树叶子都不背它）；
 * - **悬空的 wikilink 只提示、不创建**：这里不是编辑器，点一个不存在的链接不该悄悄建文件。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'

import { openNote } from '@/app/actions'
import { frontmatterBody } from '@/domain/frontmatter'
import { isInternalNoteHref, normalizeLinkTarget } from '@/domain/links'
import { renderMarkdown } from '@/domain/markdown'
import { ipc } from '@/ipc/client'
import { MimenoteError, describeError, type ResolvedLink } from '@/ipc/types'
import { toast } from '@/state/toast-store'

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; html: string }
  | { kind: 'error'; message: string }

export interface StaticNotePreviewProps {
  relPath: string
  /** 滚动容器上附加的类名（各调用方自己的布局钩子）。 */
  className?: string
  /** 正文 `<article>` 上附加的类名。 */
  articleClassName?: string
  /** 出错段落上附加的类名。 */
  errorClassName?: string
}

export function StaticNotePreview({
  relPath,
  className,
  articleClassName,
  errorClassName,
}: StaticNotePreviewProps) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  /** 这篇笔记的出链（解析 wikilink 用）；拿不到就退化成"链接一律当作悬空"，正文照常显示。 */
  const [outbound, setOutbound] = useState<readonly ResolvedLink[]>([])
  const articleRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    // "过期响应丢弃"：快速换一篇时只采纳最后一次的结果
    let disposed = false
    setState({ kind: 'loading' })

    void (async () => {
      try {
        const content = await ipc.noteRead(relPath)
        if (disposed) return
        // frontmatter 不渲染（它是元数据，渲染出来只是一条横线加几行 key: value）
        setState({ kind: 'ready', html: renderMarkdown(frontmatterBody(content.text)) })
      } catch (cause) {
        if (disposed) return
        setState({ kind: 'error', message: describeError(MimenoteError.from(cause), '无法预览') })
      }
    })()

    return () => {
      disposed = true
    }
  }, [relPath])

  // 出链表：与正文那次读盘是两次独立往返，但它不阻塞正文渲染（解析结果晚到也不会闪白）
  useEffect(() => {
    let disposed = false
    setOutbound([])
    void (async () => {
      try {
        const links = await ipc.noteLinks(relPath)
        if (disposed) return
        setOutbound(links.outbound)
      } catch {
        // 索引还没建好（或旧宿主没有这个命令）：正文照常显示，只是链接点了没反应
      }
    })()
    return () => {
      disposed = true
    }
  }, [relPath])

  const html = state.kind === 'ready' ? state.html : ''
  const rendered = useMemo(() => ({ __html: html }), [html])

  /**
   * 把索引的解析结果"贴"到渲染出来的 wikilink 上（不重新渲染 HTML）。
   * 与 `MarkdownPreview` 同一套做法（同样的类名、同样的 title），
   * 这样"已解析 / 悬空 / 有歧义"在两处视图里的外观与含义一致。
   */
  useEffect(() => {
    const root = articleRef.current
    if (root === null) return
    for (const element of Array.from(root.querySelectorAll('a.mn-wikilink'))) {
      const key = normalizeLinkTarget(element.getAttribute('data-target') ?? '')
      const match = outbound.find((link) => normalizeLinkTarget(link.rawTarget) === key)
      const resolved = match?.resolvedRelPath ?? null
      element.classList.toggle('mn-wikilink--unresolved', resolved === null)
      element.classList.toggle('mn-wikilink--ambiguous', match?.ambiguous === true)
      if (resolved === null) {
        element.removeAttribute('data-rel-path')
        element.setAttribute('title', `${element.getAttribute('data-target') ?? ''}（还不存在）`)
      } else {
        element.setAttribute('data-rel-path', resolved)
        element.setAttribute('title', resolved)
      }
    }
  }, [html, outbound])

  /**
   * 正文里的链接：`[[wikilink]]`（目标写在 `data-target` 上）与普通 Markdown 链接（`href`）。
   *
   * 与阅读视图**唯一**的差别：悬空链接不创建文件，只提示（见文件头）——
   * 这里是只读预览，点一下不该在库里悄悄建出一篇笔记。
   */
  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const anchor = target.closest('a')
      if (anchor === null) return

      // wikilink：已解析 → 打开那篇笔记；悬空 → 只提示（只读，不建文件）
      if (anchor.classList.contains('mn-wikilink')) {
        event.preventDefault()
        const resolved = anchor.getAttribute('data-rel-path')
        if (resolved !== null) void openNote(resolved)
        else toast.info('目标笔记还不存在', anchor.getAttribute('data-target') ?? '')
        return
      }

      const href = anchor.getAttribute('href') ?? ''
      if (href === '' || href.startsWith('#')) return

      // Markdown 内部链接：同样用出链表判断指向哪一篇
      const key = normalizeLinkTarget(href)
      const match = outbound.find((link) => normalizeLinkTarget(link.rawTarget) === key)
      if (match?.resolvedRelPath != null) {
        event.preventDefault()
        void openNote(match.resolvedRelPath)
        return
      }

      event.preventDefault()
      if (isInternalNoteHref(href)) toast.info('目标笔记还不存在', href)
      // 外部链接：不让 WebView 直接跳走（会丢掉整个界面），与阅读视图同一处理
      else toast.info('外部链接未在应用内打开', `${href}（M2 之后接入系统浏览器打开）`)
    },
    [outbound],
  )

  return (
    // 滚的是这一层（容器自己 `overflow` 归调用方的类管），与停靠面板/阅读视图一致
    <div className={className}>
      {state.kind === 'loading' && <p className="mn-empty__text">正在读取…</p>}
      {state.kind === 'error' && (
        <p className={`mn-empty__text${errorClassName ? ` ${errorClassName}` : ''}`}>
          {state.message}
        </p>
      )}
      {state.kind === 'ready' && (
        <article
          className={`mn-preview__body${articleClassName ? ` ${articleClassName}` : ''}`}
          ref={articleRef}
          // html 已由 DOMPurify 净化（见 domain/markdown.ts 的两道防线）
          dangerouslySetInnerHTML={rendered}
          onClick={handleClick}
        />
      )}
    </div>
  )
}
