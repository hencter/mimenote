/**
 * 窗口控制（最小化 / 最大化↔还原 / 关闭）的动作封装。
 *
 * ## 为什么需要它
 * 应用把**系统标题栏关掉了**（`tauri.conf.json` 的 `decorations: false`），顶部不再有系统
 * 或自绘的独立标题栏（ADR-0038：`mn-titlebar` 已退役，拖动区由标签条承担）。
 * 留着系统标题栏等于每条窗口两个顶栏，而且拖动/双击最大化会落在不同的地方。
 *
 * 代价是**必须自己提供窗口按钮**：关掉系统装饰之后，用户就没有任何办法关窗口了。
 * 所以本模块把三件事收在一起，并让它们在**拿不到 Tauri 时安静地退场**（浏览器 `pnpm dev`
 * 预览、单测）—— 界面照常渲染，只是按钮不出现（见 `WindowControls`）。
 *
 * ## 为什么每次调用都动态 import
 * `@tauri-apps/api/window` 需要 `window.__TAURI_INTERNALS__` 才有意义。仓库里
 * `features/status/window-title.ts`、`state/vault-store.ts` 都是同一个姿态：动态 import +
 * 失败只记一次日志，**绝不让"锦上添花的能力"影响应用启动**。这里保持一致。
 *
 * ## 与 `data-tauri-drag-region` 的分工
 * 拖动窗口与"双击最大化"由 Tauri 注入的脚本处理（`src/window/scripts/drag.js`）：
 * 元素带 `data-tauri-drag-region="deep"` 时，子树里的按下都会发起拖动，**但可点击元素
 * （button/input/a…）会自动拦住** —— 所以标题栏上放按钮是安全的，不需要额外
 * `stopPropagation`。本模块只负责"用户主动点了按钮"那三个动作。
 */

/** 一次窗口动作的结果：`false` = 当前环境没有窗口 API（浏览器预览、单测）。 */
export type WindowActionResult = 'done' | 'unavailable'

/** 只在第一次失败时记日志：标题栏按钮每点一次都刷日志没有任何价值。 */
let unavailableLogged = false

function noteUnavailable(reason: unknown): WindowActionResult {
  if (!unavailableLogged) {
    unavailableLogged = true
    console.debug('[window] 没有可用的窗口 API，窗口按钮已停用：', reason)
  }
  return 'unavailable'
}

/** 取当前窗口对象（拿不到就返回 `null`）。 */
async function currentWindow() {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    return getCurrentWindow()
  } catch (cause) {
    noteUnavailable(cause)
    return null
  }
}

/** 最小化窗口。 */
export async function minimizeWindow(): Promise<WindowActionResult> {
  const window = await currentWindow()
  if (window === null) return 'unavailable'
  try {
    await window.minimize()
    return 'done'
  } catch (cause) {
    return noteUnavailable(cause)
  }
}

/** 在"最大化"与"还原"之间切换，返回切换后的状态（拿不到时返回 `null`）。 */
export async function toggleMaximizeWindow(): Promise<boolean | null> {
  const window = await currentWindow()
  if (window === null) return null
  try {
    await window.toggleMaximize()
    return await window.isMaximized()
  } catch (cause) {
    noteUnavailable(cause)
    return null
  }
}

/** 关闭窗口（未保存的内容由既有的自动保存/关闭确认链路负责，这里不重复拦）。 */
export async function closeWindow(): Promise<WindowActionResult> {
  const window = await currentWindow()
  if (window === null) return 'unavailable'
  try {
    await window.close()
    return 'done'
  } catch (cause) {
    return noteUnavailable(cause)
  }
}

/**
 * 订阅窗口尺寸变化，回报**当前是否最大化**。
 *
 * 为什么必须订阅：窗口被最大化/还原的途径不止我们那个按钮 —— 双击标题栏（Tauri 注入脚本
 * 直接调 `internal_toggle_maximize`）、Win+↑、拖到屏幕上沿、从最大化状态往下拖。不订阅的话
 * 按钮上的图标会与真实状态长期不一致（显示"最大化"但窗口已经最大化了）。
 *
 * 返回取消订阅函数；拿不到窗口 API 时返回 `null`（调用方据此不渲染按钮）。
 */
export async function subscribeMaximizeState(
  onChange: (maximized: boolean) => void,
): Promise<(() => void) | null> {
  const window = await currentWindow()
  if (window === null) return null
  try {
    const initial = await window.isMaximized()
    onChange(initial)
    const stop = await window.onResized(() => {
      void window.isMaximized().then(onChange).catch(() => {})
    })
    return stop
  } catch (cause) {
    noteUnavailable(cause)
    return null
  }
}
