/**
 * 面板的全局按键（**捕捉阶段**装在 window 上）。
 *
 * 为什么不能只靠 `app/keymap.ts` 的全局快捷键：
 *
 * 1. **Ctrl+K 在编辑器里有别的含义**：CodeMirror 的 `defaultKeymap` 把 `Ctrl-k`
 *    绑到了 `deleteToLineEnd`，而 CM 的监听装在编辑器 DOM 上、事件到达它之前会先
 *    经过 window 的**捕捉阶段**。全局快捷键是 window 的**冒泡**监听，等它收到时
 *    CM 已经 `preventDefault()` 过了（`keymap.ts` 正是靠 `defaultPrevented` 提前返回），
 *    于是"编辑器聚焦时 Ctrl+K 打不开面板，反而删掉了一行后半截"。
 *    在捕捉阶段抢在 CM 之前处理，并 `stopPropagation()`，CM 就完全看不到这个事件。
 *    （Ctrl+Shift+F 的全文搜索同理走这条路：不依赖"编辑器将来不会占用这个键位"。）
 * 2. **Esc 不能漏给全局快捷键**：面板是模态层，Esc 只应该关闭它。
 *    捕捉阶段处理 + 阻止冒泡，冒泡链上的全局快捷键就收不到。
 *    （与 `components/ConfirmDialog.tsx` 的 Esc 处理是同一套路。）
 * 3. 全局快捷键只在"非输入元素"上生效（`keymap.ts` 的 `isTextEntryTarget`），
 *    而这里无视焦点位置：面板的呼出键必须在任何地方都能用。
 *
 * 键盘映射不在这里写死：用 `commands.byChord()` 按 ID 反查注册表，
 * 命令表始终是快捷键的唯一事实来源（见 `PALETTE_COMMAND_IDS`）。
 */

import { useEffect } from 'react'

import { PALETTE_COMMAND_IDS } from '@/app/builtin-commands'
import { chordFromEvent, commands } from '@/app/commands'
import { useConfirmStore } from '@/state/confirm-store'
import { useUiStore } from '@/state/ui-store'

/** 受本监听托管的三个面板命令（`Mod+K` / `Mod+P` / `Mod+Shift+F`）。 */
const PALETTE_IDS: readonly string[] = [
  PALETTE_COMMAND_IDS.open,
  PALETTE_COMMAND_IDS.quickSwitch,
  PALETTE_COMMAND_IDS.search,
]

/** 安装面板的全局按键监听（组件卸载即移除；严格模式下重复安装也无副作用）。 */
export function usePaletteHotkeys(): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.isComposing) return
      const ui = useUiStore.getState()

      if (ui.paletteMode !== null) {
        // 面板已打开：这里只处理 Esc（关闭）。
        // ↑↓ / Enter 由面板组件自己处理 —— 它需要读写"当前高亮第几条"这类面板私有状态；
        // Esc 放这里是因为它必须**不依赖焦点位置**都能生效（焦点可能已经不在输入框上）。
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        ui.closePalette()
        return
      }

      // 面板未打开：只关心带修饰键的组合。
      // 放行纯字符输入，避免在编辑器里每敲一个字都去查一遍快捷键表。
      if (!event.ctrlKey && !event.metaKey && !event.altKey) return

      const chord = chordFromEvent(event)
      if (chord === '') return

      const target = commands
        .byChord(chord)
        .find((command) => PALETTE_IDS.includes(command.id) && (command.when?.() ?? true))
      if (target === undefined) return

      // 确认框在上层时不要盖住它（Esc 的归属也会变得含混）
      if (useConfirmStore.getState().request !== null) return

      event.preventDefault()
      event.stopPropagation()
      void commands.execute(target.id)
    }

    window.addEventListener('keydown', handler, true)
    return () => {
      window.removeEventListener('keydown', handler, true)
    }
  }, [])
}
