/**
 * 卡片预览面板：单击卡片后在画布右侧滑出，直接显示**渲染后的正文**。
 *
 * 这是需求里最核心的一条改动：Obsidian 里"要按住 Ctrl 才出预览"，而这里点一下就出正文，
 * 并且**不阻塞画布** —— 面板是浮在画布上的一层，它只是拦下自己的指针事件
 * （`data-mn-graph-nopan`），画布的平移/缩放/拖动照常可用，`Esc` 或右上角的 × 关闭。
 *
 * 渲染走 `@/domain/markdown` 的 `renderMarkdown(frontmatterBody(text))`：与主预览**同一套**
 * 渲染与净化管线（ADR-0005 的安全模型：raw HTML 关闭 + DOMPurify 二次净化），
 * 因此这里同样可以安全地 `dangerouslySetInnerHTML`。
 * 本地图片拿不到授权时会渲染成占位元素 —— 那正是 `renderMarkdown` 在没有解析器时的默认行为
 * （不传 `resolveImage` 就不发 `asset_authorize`，也就不会去动 `domain/**`）。
 *
 * ## 焦点
 *
 * 打开时把焦点移进面板、关闭时还给刚打开它的那个元素（写法与 `features/vault/RenameDialog.tsx`
 * 一致）。为什么必须做：面板是浮层，焦点留在卡片上会让"面板已经打开"对键盘用户不可见；
 * 而关掉之后焦点若落到 body，Tab 就得从头开始走。
 *
 * ## 正文里的链接
 *
 * `[[wikilink]]` 与 `[文字](笔记.md)` 都要能点开目标笔记，解析口径与 `MarkdownPreview`
 * **完全一致**（`normalizeLinkTarget` 去比对出链表的 `rawTarget`）。出链表从 `ipc.noteLinks`
 * 单独取，而不是读 `links-store` —— 后者只持有"当前打开的那篇笔记"的出链，而这里预览的
 * 未必就是打开的那篇（点开卡片并不会切换编辑器里的文档）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'

import { openNote } from '@/app/actions'
import { Icon } from '@/components/Icon'
import { frontmatterBody } from '@/domain/frontmatter'
import { isInternalNoteHref, normalizeLinkTarget } from '@/domain/links'
import { renderMarkdown } from '@/domain/markdown'
import { ipc } from '@/ipc/client'
import { MimenoteError, describeError } from '@/ipc/types'
import type { ResolvedLink } from '@/ipc/types'
import { useGraphStore } from '@/state/graph-store'
import { toast } from '@/state/toast-store'

export interface GraphPreviewProps {
  relPath: string
  title: string
  onClose: () => void
  onOpenInEditor: (relPath: string) => void
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; html: string }
  | { kind: 'error'; message: string }

/**
 * 跟随正文里的一条链接：面板滑到那篇卡片（画布上的"跟随链接"），同时把它读进编辑器。
 *
 * 两件事一起做：前者是这个面板存在的意义（不离开画布就能顺着链接读下去），
 * 后者复用全应用同一条"打开笔记"的动作链（`openNote`，与文件树/双击卡片一致），
 * 用户接着按 Ctrl+E 就能直接写。
 */
function followLink(relPath: string): void {
  useGraphStore.getState().select(relPath)
  void openNote(relPath)
}

export function GraphPreview({ relPath, title, onClose, onOpenInEditor }: GraphPreviewProps) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  /** 这篇笔记的出链（解析用）；拿不到就退化成"链接一律当作悬空"，正文照常显示。 */
  const [outbound, setOutbound] = useState<readonly ResolvedLink[]>([])
  const panelRef = useRef<HTMLElement | null>(null)
  const articleRef = useRef<HTMLElement | null>(null)
  /**
   * 打开面板时"被取代"的那个元素（就是那张卡片）：关闭后把焦点还回去。
   *
   * 与 `RenameDialog` 同一套写法：捕获 `document.activeElement` 而不是按 relPath 反查 DOM ——
   * 面板里可能还会打开别的东西（比如将来加搜索框），"谁打开的就还给谁"才是稳定的语义。
   */
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  // 打开时把焦点移进面板（`tabIndex={-1}` 让它可编程聚焦但不进 Tab 序列）
  useEffect(() => {
    const active = typeof document === 'undefined' ? null : document.activeElement
    // body 不算"上一个焦点"：那只是"页面上没有别的东西聚焦"，还给 body 等于没还
    restoreFocusRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null
    panelRef.current?.focus()
    return () => {
      const previous = restoreFocusRef.current
      restoreFocusRef.current = null
      if (previous !== null && previous.isConnected) previous.focus()
    }
  }, [])

  useEffect(() => {
    // 与 note-store 同一套"过期响应丢弃"策略：快速点不同的卡片时，只采纳最后一次的结果
    // （切换 relPath 时 React 会先跑上一个 effect 的清理函数，因此 disposed 就能挡住旧响应）。
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

  // 出链表：只在换一篇笔记时拉一次（与上面那次 note_read 是两次独立往返，
  // 但它们都不阻塞正文渲染 —— 解析结果晚到也不会让面板闪白）。
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
   *
   * 与 `MarkdownPreview` 完全同一套做法（同样的类名、同样的 title）：这样"已解析 / 悬空"
   * 在两个视图里的外观与含义一致，用户不会以为是两个功能。
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
   * 两者都按 `normalizeLinkTarget` 与出链表比对 —— 与 `MarkdownPreview` 同一套口径，
   * 否则"阅读视图里能点、图谱里点了没反应"这种不一致会让人怀疑整条链接链坏了。
   */
  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const anchor = target.closest('a')
      if (anchor === null) return

      // wikilink：已解析 → 打开那篇笔记；悬空 → 只提示（预览面板是只读的，不在这里建文件）
      if (anchor.classList.contains('mn-wikilink')) {
        event.preventDefault()
        const resolved = anchor.getAttribute('data-rel-path')
        if (resolved !== null) followLink(resolved)
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
        followLink(match.resolvedRelPath)
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
    <aside
      className="mn-graph-preview"
      data-mn-graph-nopan
      aria-label={`预览 ${title}`}
      tabIndex={-1}
      ref={panelRef}
    >
      <header className="mn-graph-preview__header">
        <div className="mn-graph-preview__heading">
          <div className="mn-graph-preview__title" title={title}>
            {title}
          </div>
          <div className="mn-graph-preview__path" title={relPath}>
            {relPath}
          </div>
        </div>
        <button
          type="button"
          className="mn-icon-button"
          aria-label="在编辑器中打开"
          title="在编辑器中打开（双击卡片也可以）"
          onClick={() => onOpenInEditor(relPath)}
        >
          <Icon name="pencil" size={14} />
        </button>
        <button
          type="button"
          className="mn-icon-button"
          aria-label="关闭预览"
          title="关闭预览（Esc）"
          onClick={onClose}
        >
          <Icon name="x" size={14} />
        </button>
      </header>

      <div className="mn-graph-preview__body">
        {state.kind === 'loading' && <p className="mn-empty__text">正在读取…</p>}
        {state.kind === 'error' && <p className="mn-empty__text mn-graph-preview__error">{state.message}</p>}
        {state.kind === 'ready' && (
          <article
            className="mn-preview__body mn-graph-preview__article"
            ref={articleRef}
            // html 已由 DOMPurify 净化（见 domain/markdown.ts 的两道防线）
            dangerouslySetInnerHTML={rendered}
            onClick={handleClick}
          />
        )}
      </div>
    </aside>
  )
}
