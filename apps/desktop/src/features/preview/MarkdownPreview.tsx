/**
 * Markdown 预览。
 *
 * 渲染是**净化后**的 HTML（见 domain/markdown.ts），因此可以安全地走 dangerouslySetInnerHTML。
 * 大文档用 `useDeferredValue` 降低渲染优先级，保证输入不被预览拖慢（M5 会迁移到 Web Worker）。
 */

import { useDeferredValue, useMemo } from 'react'

import { Icon } from '@/components/Icon'
import { renderMarkdown } from '@/domain/markdown'
import { useNoteStore } from '@/state/note-store'

export function MarkdownPreview() {
  const relPath = useNoteStore((state) => state.doc?.relPath ?? null)
  const text = useNoteStore((state) => state.doc?.text ?? '')
  const deferredText = useDeferredValue(text)

  const html = useMemo(() => (relPath === null ? '' : renderMarkdown(deferredText)), [relPath, deferredText])
  const stale = deferredText !== text

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
        <article className="mn-preview__body" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
      {stale && (
        <div className="mn-preview__stale-hint">
          <Icon name="refresh" size={12} /> 正在同步预览…
        </div>
      )}
    </div>
  )
}
