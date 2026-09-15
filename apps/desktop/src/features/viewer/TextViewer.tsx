/**
 * 纯文本查看器（只读）：`.txt` / `.json` / `.csv` / `.toml` / 各种源码文件……
 *
 * ## 为什么它几乎不用写
 * 宿主的 `note_read` **本来就不检查扩展名**：它只做路径防护（`resolve_existing`）、拒目录、
 * 限大小，然后把原文读回来。所以给这些文件加预览**不需要任何新 IPC** —— 缺的只是前端一个
 * "这属于哪一类、该怎么显示"的判据（`domain/viewable.ts`）与这一层渲染。
 *
 * ## 只读，且刻意朴素
 * 这一层**不解析**内容：JSON 不折叠、CSV 不成表 —— 那些是后续各自的查看器（同一根主轴，
 * 见 ADR-0032）。这里给的是"能看清原文"：等宽、保留空白、按需换行，加上行数/字数/大小。
 * 好处是它对**任何**文本都成立，包括还没写查看器的格式。
 *
 * 编辑**不在这里**：把非 Markdown 文件变成可写，是第二条写路径（冲突令牌、原子写、
 * 自动保存、标签页语义都要重新表态），要有意为之 —— 见 ADR-0032 的代价清单。
 */

import { useEffect, useState } from 'react'

import { Icon } from '@/components/Icon'
import { formatBytes } from '@/domain/format'
import { displayName } from '@/domain/paths'
import { ipc } from '@/ipc/client'
import { describeError, MimenoteError } from '@/ipc/types'

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; text: string; sizeBytes: number; mtimeMs: number }
  | { kind: 'unavailable'; reason: string }

/** 超过这个长度就默认关掉"按窗口换行"（几十万行的日志按窗口折行会让渲染与滚动都变慢）。 */
const WRAP_DEFAULT_LIMIT = 200_000

export function TextViewer({ relPath }: { relPath: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [wrap, setWrap] = useState(true)

  useEffect(() => {
    let disposed = false
    setState({ kind: 'loading' })

    void (async () => {
      try {
        const content = await ipc.noteRead(relPath)
        if (disposed) return
        setState({
          kind: 'ready',
          text: content.text,
          sizeBytes: content.sizeBytes,
          mtimeMs: content.mtimeMs,
        })
        setWrap(content.text.length <= WRAP_DEFAULT_LIMIT)
      } catch (cause) {
        if (disposed) return
        // 读不动就说清楚为什么（太大 / 不是文本 / 文件不见了）——`describeError` 认宿主给的错误码
        setState({ kind: 'unavailable', reason: describeError(MimenoteError.from(cause)) })
      }
    })()

    return () => {
      disposed = true
    }
  }, [relPath])

  const lines = state.kind === 'ready' ? state.text.split('\n').length : 0
  const meta =
    state.kind === 'ready'
      ? `${lines} 行 · ${state.sizeBytes === 0 ? formatBytes(state.text.length) : formatBytes(state.sizeBytes)} · ${relPath}`
      : relPath

  return (
    <div className="mn-viewer mn-viewer--text" data-viewer-kind="text" data-viewer-path={relPath}>
      <header className="mn-viewer__bar">
        <Icon name="file" size="sm" />
        <span className="mn-viewer__title" title={relPath}>
          {displayName(relPath)}
        </span>
        <span className="mn-viewer__meta" title={relPath}>
          {meta}
        </span>
        {state.kind === 'ready' && (
          <button
            type="button"
            className="mn-btn mn-btn--ghost"
            data-viewer-action="toggle-wrap"
            aria-pressed={wrap}
            title={wrap ? '不折行（横向滚动）' : '按窗口宽度折行'}
            onClick={() => setWrap((current) => !current)}
          >
            {wrap ? '不折行' : '折行'}
          </button>
        )}
      </header>

      <div className={`mn-viewer__stage mn-viewer__stage--text${wrap ? ' mn-viewer__stage--wrap' : ''}`}>
        {state.kind === 'loading' && <p className="mn-viewer__note">正在读取…</p>}
        {state.kind === 'unavailable' && (
          <p className="mn-viewer__note" data-viewer-unavailable="true">
            {state.reason}
          </p>
        )}
        {state.kind === 'ready' && (
          <pre className="mn-viewer__text" data-viewer-text="true">
            {state.text}
          </pre>
        )}
      </div>
    </div>
  )
}
