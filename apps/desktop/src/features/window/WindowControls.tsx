/**
 * 三个窗口按钮（最小化 / 最大化↔还原 / 关闭）。
 *
 * ## 为什么必须有
 * `tauri.conf.json` 里关掉了系统装饰（`decorations: false`），关掉系统装饰之后就**必须自己
 * 提供关窗口的办法** —— 否则用户只能去任务栏右键关它。这是"关系统标题栏"这个决定的必要配套，
 * 不是装饰。ADR-0038 之后它们不住在独立标题栏里，而是**右上叶标签条的右端**（`LeafTabs` 的
 * 窗口按钮槽，在标签滚动区之外，因此标签再多也挤不掉它们；"右上叶"= `topRightLeafId`，
 * 右停靠面板出现时按钮跟着最右一格走，而不是停在各叶中间）。
 *
 * ## 为什么不在非 Tauri 环境渲染
 * `pnpm dev` 的浏览器预览里没有窗口 API，渲染三个点了没反应的按钮比不渲染更让人困惑。
 * 因此这里先探测（`subscribeMaximizeState` 能成功拿到窗口对象才渲染），拿不到就整组不出现 ——
 * 界面其余部分照常，标签条右端也不会因此空出一块（按钮组不渲染就不占位）。
 *
 * ## 为什么图标用内联 SVG 而不是文字
 * 三个按钮住在 36px 高的标签条里，文字（"最小化"）放不下；同时它们必须是**可访问**的：
 * 每个按钮都有 `aria-label` 与 `title`，图标本身 `aria-hidden`。图标是 10×10 的几何图形
 * （按 14px 渲染，见 `styles/app.css` 的按钮尺寸），直接用 `<svg>` 画
 * （仓库里没有图标库依赖，也不该为三个符号引入一个）。
 */

import { useEffect, useState } from 'react'

import {
  closeWindow,
  minimizeWindow,
  subscribeMaximizeState,
  toggleMaximizeWindow,
} from './window-actions'

export function WindowControls() {
  /** `null` = 还没有探测出结果（首帧不渲染，避免"闪一下又消失"）。 */
  const [available, setAvailable] = useState<boolean | null>(null)
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let disposed = false
    let stop: (() => void) | null = null
    void (async () => {
      const unsubscribe = await subscribeMaximizeState((next) => {
        if (!disposed) setMaximized(next)
      })
      if (disposed) {
        unsubscribe?.()
        return
      }
      stop = unsubscribe
      setAvailable(unsubscribe !== null)
    })()
    return () => {
      disposed = true
      stop?.()
    }
  }, [])

  if (available !== true) return null

  return (
    <div className="mn-window-controls" data-tauri-drag-region="false">
      <button
        type="button"
        className="mn-window-controls__button"
        aria-label="最小化"
        title="最小化"
        onClick={() => void minimizeWindow()}
      >
        <svg width="14" height="14" viewBox="0 0 10 10" aria-hidden="true">
          <rect x="1" y="4.5" width="8" height="1" fill="currentColor" />
        </svg>
      </button>

      <button
        type="button"
        className="mn-window-controls__button"
        aria-label={maximized ? '还原' : '最大化'}
        aria-pressed={maximized}
        title={maximized ? '还原' : '最大化'}
        onClick={() => {
          void toggleMaximizeWindow().then((next) => {
            if (next !== null) setMaximized(next)
          })
        }}
      >
        {maximized ? (
          // 还原：两个错开的方框
          <svg width="14" height="14" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="1" y="3" width="6" height="6" fill="none" stroke="currentColor" />
            <path d="M3.5 3V1h5.5v5.5H7" fill="none" stroke="currentColor" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" />
          </svg>
        )}
      </button>

      <button
        type="button"
        className="mn-window-controls__button mn-window-controls__button--close"
        aria-label="关闭窗口"
        title="关闭窗口"
        onClick={() => void closeWindow()}
      >
        <svg width="14" height="14" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  )
}
