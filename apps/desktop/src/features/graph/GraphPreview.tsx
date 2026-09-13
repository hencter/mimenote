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
 */

import { useEffect, useMemo, useState } from 'react'

import { Icon } from '@/components/Icon'
import { frontmatterBody } from '@/domain/frontmatter'
import { renderMarkdown } from '@/domain/markdown'
import { ipc } from '@/ipc/client'
import { MimenoteError, describeError } from '@/ipc/types'

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

export function GraphPreview({ relPath, title, onClose, onOpenInEditor }: GraphPreviewProps) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })

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

  const html = state.kind === 'ready' ? state.html : ''
  const rendered = useMemo(() => ({ __html: html }), [html])

  return (
    <aside
      className="mn-graph-preview"
      data-mn-graph-nopan
      aria-label={`预览 ${title}`}
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
            // html 已由 DOMPurify 净化（见 domain/markdown.ts 的两道防线）
            dangerouslySetInnerHTML={rendered}
          />
        )}
      </div>
    </aside>
  )
}
