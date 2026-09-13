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

import { useCallback, useDeferredValue, useEffect, useMemo, useRef } from 'react'

import { createNoteFromLink, openNote } from '@/app/actions'
import { Icon } from '@/components/Icon'
import { resolveVaultAssetPath } from '@/domain/assets'
import { frontmatterBody } from '@/domain/frontmatter'
import { isInternalNoteHref, normalizeLinkTarget } from '@/domain/links'
import { imagePlaceholderHtml, renderMarkdown } from '@/domain/markdown'
import { isTauriRuntime } from '@/ipc/client'
import { convertAssetUrl } from '@/ipc/tauri-adapter'
import { useLinksStore } from '@/state/links-store'
import { useNoteStore } from '@/state/note-store'
import { toast } from '@/state/toast-store'
import { useVaultStore } from '@/state/vault-store'

export function MarkdownPreview() {
  const relPath = useNoteStore((state) => state.doc?.relPath ?? null)
  const text = useNoteStore((state) => state.doc?.text ?? '')
  const links = useLinksStore((state) => state.links)
  const rootPath = useVaultStore((state) => state.info?.rootPath ?? null)
  const bodyRef = useRef<HTMLElement | null>(null)

  const deferredText = useDeferredValue(text)

  /**
   * 图片地址解析（ADR-0007）：只有真实宿主 + 已知 Vault 根时才产出 asset URL。
   *
   * 浏览器预览（`pnpm dev`）没有 asset 协议，解析器缺席 → 直接渲染占位元素，
   * 而不是产出一堆必然加载失败的 URL。
   */
  const imageEnv = useMemo(() => {
    if (!isTauriRuntime() || rootPath === null || relPath === null) return {}
    return {
      resolveImage: (src: string): string | null => {
        const absolute = resolveVaultAssetPath(rootPath, relPath, src)
        if (absolute === null) return null
        return convertAssetUrl(absolute)
      },
    }
  }, [rootPath, relPath])

  // 预览只渲染正文：frontmatter 是"元数据"，它已经由标签面板的属性表展示，
  // 渲染出来只会变成一条横线加几行 `key: value`（见 domain/frontmatter.ts 的判定口径）
  const html = useMemo(
    () => (relPath === null ? '' : renderMarkdown(frontmatterBody(deferredText), imageEnv)),
    [relPath, deferredText, imageEnv],
  )
  const stale = deferredText !== text

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
