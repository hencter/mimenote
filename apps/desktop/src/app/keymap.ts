/**
 * 全局快捷键分发。
 *
 * 规则：
 * - 只在**未聚焦到文本输入框**时劫持（`<input>`/`<textarea>` 里让用户正常打字）；
 * - 编辑器（contenteditable）**参与**快捷键，否则 Ctrl+S 在编辑器里会失效；
 * - 输入法组合期间（`isComposing`）一律不处理；
 * - **模态层（`role="dialog"` / `role="alertdialog"`）里的按键不抢**：设置页打开时
 *   `Esc` 归它自己（它也在捕捉阶段处理），确认框打开时一次 `Esc` 只该取消确认；
 * - **装在捕捉阶段**：命令表是快捷键的唯一事实来源，注册过的组合键必须赢过编辑器
 *   自己的绑定。CodeMirror 的 `searchKeymap` 占着 `Mod+G`（查找下一个）、
 *   `defaultKeymap` 占着 `Mod+K`（删到行尾），而 CM 的监听装在编辑器 DOM 上、
 *   且会 `preventDefault()`；全局快捷键如果装在冒泡阶段，等它收到事件时已经晚了
 *   （旧实现正是靠 `defaultPrevented` 提前返回），于是"在编辑器里按 Ctrl+G 打不开
 *   图谱，反而跳到了下一个匹配"。捕捉阶段抢在 CM 之前处理，CM 就完全看不到这个事件
 *   —— 与 `use-palette-hotkeys.ts`、`SettingsDialog.tsx` 是同一套路。
 *
 * 与面板监听的分工：`Mod+K`/`Mod+P`/`Mod+Shift+F` 仍由 `use-palette-hotkeys.ts`
 * 独占（它在捕捉阶段还要处理"面板打开时 Esc 只关面板"）。这里**显式跳过**那三条命令，
 * 不去依赖两个监听的注册顺序 —— 同为目标上的捕捉监听，`stopPropagation()` 拦不住
 * 同一节点上的另一个监听，两边都执行就会开出两次面板。
 */

import { useEffect } from 'react'

import { PALETTE_COMMAND_IDS } from './builtin-commands'
import { chordFromEvent, commands } from './commands'

/** 面板自己托管的命令（见 `features/palette/use-palette-hotkeys.ts`）。 */
const PALETTE_OWNED: readonly string[] = [
  PALETTE_COMMAND_IDS.open,
  PALETTE_COMMAND_IDS.quickSwitch,
  PALETTE_COMMAND_IDS.search,
]

/** 是否是不应被劫持的原生输入元素。 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return false
}

/**
 * 焦点是否落在模态层内部（设置页、确认框、重命名框…）。
 *
 * 用 DOM 判据而不是读 store：这些对话框打开时都会把焦点收进自己（`role="dialog"`），
 * 于是"事件目标在对话框里"等价于"当前有模态层在管键盘"，不必让快捷键层认识 UI store。
 */
function isInsideModalLayer(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.closest('[role="dialog"], [role="alertdialog"]') !== null
}

/** 安装全局 keydown 监听（组件卸载即移除）。 */
export function useGlobalKeymap(): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return
      if (event.isComposing) return
      if (isTextEntryTarget(event.target)) return
      if (isInsideModalLayer(event.target)) return

      const chord = chordFromEvent(event)
      if (chord === '') return

      const matched = commands
        .byChord(chord)
        .filter((command) => command.when?.() ?? true)
        .filter((command) => !PALETTE_OWNED.includes(command.id))
      const first = matched[0]
      if (first === undefined) return

      event.preventDefault()
      event.stopPropagation()
      void commands.execute(first.id)
    }

    window.addEventListener('keydown', handler, true)
    return () => {
      window.removeEventListener('keydown', handler, true)
    }
  }, [])
}
