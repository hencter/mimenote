/**
 * 图片查看器（只读）：把文件树里选中的一张图片显示出来。
 *
 * ## 为什么需要
 * 图片此前**只能**在笔记正文里看到（阅读视图 / 所见即所得里点开灯箱）。文件树里点一张图片
 * 只会把它选中 —— 用户报的"图片选择后无法预览"就是这个。查看器补上那一格。
 *
 * ## 三条与既有管线一致的纪律
 * 1. **授权走 `asset_authorize`（逐文件）**：不新开读文件的 IPC，也不自己拼路径 ——
 *    越界、符号链接逃逸、扩展名不在白名单、文件不存在，宿主都会跳过，这里如实显示原因；
 * 2. **非 Tauri 运行时不假装能看**：浏览器预览里没有 asset 协议（`convertFileSrc` 无意义），
 *    此时显示一句明确的说明，而不是一个永远转圈的骨架 —— 与预览面板对图片的处理同一个姿态；
 * 3. **尺寸/大小如实**：文件大小来自条目表（`vault-store`），像素尺寸来自图片自身的
 *    `naturalWidth/Height`（解码完成才有，因此是"加载后补上"而不是预先猜）。
 */

import { useEffect, useState } from 'react'

import { Icon } from '@/components/Icon'
import { formatBytes } from '@/domain/format'
import { displayName } from '@/domain/paths'
import { ipc, isTauriRuntime } from '@/ipc/client'
import { convertAssetUrl } from '@/ipc/tauri-adapter'
import { useVaultStore } from '@/state/vault-store'

/** 加载状态：只有"拿到了 URL"才画 `<img>`；其余两种都要给人话。 */
type State =
  | { kind: 'loading' }
  | { kind: 'ready'; url: string }
  | { kind: 'unavailable'; reason: string }

export function ImageViewer({ relPath }: { relPath: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  /** 适应窗口（默认）↔ 实际大小。 */
  const [fit, setFit] = useState(true)
  /** 解码后才知道的真实像素尺寸（`null` = 还没加载出来，或加载失败）。 */
  const [pixels, setPixels] = useState<{ width: number; height: number } | null>(null)

  const entry = useVaultStore((store) =>
    store.entries.find((candidate) => candidate.relPath === relPath),
  )

  useEffect(() => {
    let disposed = false
    setState({ kind: 'loading' })
    setPixels(null)
    setFit(true)

    // 浏览器预览（`pnpm dev` / UI E2E）：没有 asset 协议，如实说明而不是假装能看
    if (!isTauriRuntime()) {
      setState({
        kind: 'unavailable',
        reason: '浏览器预览模式读不到本地文件：请在桌面应用里打开（或把图片放进一篇笔记的正文里看）。',
      })
      return
    }

    void (async () => {
      try {
        const grants = await ipc.assetAuthorize([relPath])
        if (disposed) return
        const grant = grants.find((candidate) => candidate.relPath === relPath)
        if (grant === undefined) {
          setState({
            kind: 'unavailable',
            reason:
              '这张图没能拿到读取授权：文件可能已被移动或删除，扩展名不在支持范围内，或者路径越出了这个 Vault。',
          })
          return
        }
        setState({ kind: 'ready', url: convertAssetUrl(grant.absolutePath) })
      } catch (cause) {
        if (disposed) return
        setState({
          kind: 'unavailable',
          reason: `读取授权失败：${cause instanceof Error ? cause.message : String(cause)}`,
        })
      }
    })()

    return () => {
      disposed = true
    }
  }, [relPath])

  const meta = [
    pixels === null ? null : `${pixels.width} × ${pixels.height}`,
    entry === undefined ? null : formatBytes(entry.sizeBytes),
    relPath,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')

  return (
    <div className="mn-viewer mn-viewer--image" data-viewer-kind="image" data-viewer-path={relPath}>
      <header className="mn-viewer__bar">
        <Icon name="file" size={14} />
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
            data-viewer-action="toggle-fit"
            aria-pressed={fit}
            title={fit ? '按实际像素显示' : '缩放到适应窗口'}
            onClick={() => setFit((current) => !current)}
          >
            {fit ? '实际大小' : '适应窗口'}
          </button>
        )}
      </header>

      <div className={`mn-viewer__stage${fit ? ' mn-viewer__stage--fit' : ''}`}>
        {state.kind === 'loading' && <p className="mn-viewer__note">正在读取…</p>}
        {state.kind === 'unavailable' && (
          <p className="mn-viewer__note" data-viewer-unavailable="true">
            {state.reason}
          </p>
        )}
        {state.kind === 'ready' && (
          <img
            className="mn-viewer__image"
            src={state.url}
            alt={displayName(relPath)}
            onLoad={(event) => {
              const image = event.currentTarget
              setPixels({ width: image.naturalWidth, height: image.naturalHeight })
            }}
            onError={() => {
              setState({
                kind: 'unavailable',
                reason: '图片无法显示：文件可能在磁盘上已经被替换或损坏。',
              })
            }}
          />
        )}
      </div>
    </div>
  )
}
