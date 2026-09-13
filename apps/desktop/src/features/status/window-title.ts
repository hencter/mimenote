/**
 * 窗口标题：`笔记名 — Mimenote`（有未保存修改时加一个圆点）。
 *
 * 为什么值得做：窗口标题是任务栏、Alt+Tab 与截图里唯一能说明"这是哪篇笔记"的地方 ——
 * 现在无论打开什么，标题永远是 "Mimenote"。多窗口时尤其明显（将来若开多窗口，这是唯一区分）。
 *
 * 两条路：
 * - `document.title` 永远设置（浏览器 `pnpm dev` 下标签名跟着变，顺手也能看出状态）；
 * - 真实窗口走 Tauri 的 `setTitle`（**需要 `core:window:allow-set-title` 能力**，见
 *   `capabilities/default.json` 的说明）。拿不到能力时（旧版本、权限被裁剪）只记一次日志，
 *   绝不影响界面 —— 标题是锦上添花，不该让应用起不来。
 *
 * 只在"笔记 / 未保存状态 / Vault"三者之一变化时调用（不是每次按键），因此没有节流问题。
 */

import { useEffect } from 'react'

import { basename } from '@/domain/paths'
import { isTauriRuntime } from '@/ipc/client'

/** 应用名（窗口标题的后缀，与 `tauri.conf.json` 的 productName 一致）。 */
const APP_NAME = 'Mimenote'

/** 未保存标记：一个圆点（与标签页上的一致），避免用 "※" 这类看不清的符号。 */
const DIRTY_MARK = '•'

/** Tauri 的 setTitle 动态导入只做一次；失败后不再重试（避免每篇笔记都刷一条日志）。 */
let windowTitleUnavailable = false

interface TitleInput {
  /** 当前笔记的相对路径（`null` = 没有打开的笔记）。 */
  relPath: string | null
  /** 是否有未保存的修改。 */
  dirty: boolean
  /** 当前 Vault 的根路径（`null` = 还没打开 Vault）。 */
  rootPath: string | null
}

/** 算出标题文本（纯函数，便于单测）。 */
export function windowTitle(input: TitleInput): string {
  const vault = input.rootPath === null ? '' : lastSegment(input.rootPath)
  if (input.relPath === null) {
    return vault === '' ? APP_NAME : `${APP_NAME} — ${vault}`
  }
  const name = basename(input.relPath)
  const mark = input.dirty ? ` ${DIRTY_MARK}` : ''
  return `${name}${mark} — ${APP_NAME}`
}

/**
 * 取路径的最后一段。
 *
 * 为什么不用 `domain/paths` 的 `basename`：那个函数服务于**Vault 内的相对路径**（POSIX 口径，
 * 只认 `/`），而 Vault 根是**原生绝对路径** —— Windows 上是 `C:\Notes\知识库`，
 * 用 POSIX 口径切出来会变成整条路径（标题里就会出现一串盘符）。
 */
function lastSegment(path: string): string {
  const trimmed = path.replace(/[/\\]+$/u, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return index === -1 ? trimmed : trimmed.slice(index + 1)
}

/** 把标题写给真实窗口（非 Tauri 运行时、或不支持时静默跳过）。 */
async function applyToWindow(title: string): Promise<void> {
  if (!isTauriRuntime() || windowTitleUnavailable) return
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().setTitle(title)
  } catch (cause) {
    // 只报一次：能力缺失/旧宿主都会走到这里，而"每切换一篇笔记报一次"会淹没日志
    windowTitleUnavailable = true
    console.warn('[window] 设置窗口标题失败（界面不受影响）：', cause)
  }
}

/** 把当前笔记同步到窗口标题（在 `App` 里调用一次即可）。 */
export function useWindowTitle(input: TitleInput): void {
  const { relPath, dirty, rootPath } = input
  useEffect(() => {
    const title = windowTitle({ relPath, dirty, rootPath })
    if (typeof document !== 'undefined') document.title = title
    void applyToWindow(title)
  }, [relPath, dirty, rootPath])
}
