/**
 * 全局快捷键分发。
 *
 * 规则：
 * - 只在**未聚焦到文本输入框**时劫持（`<input>`/`<textarea>` 里让用户正常打字）；
 * - 编辑器（contenteditable）**参与**快捷键，否则 Ctrl+S 在编辑器里会失效；
 * - 输入法组合期间（`isComposing`）一律不处理。
 */

import { useEffect } from 'react'

import { chordFromEvent, commands } from './commands'

/** 是否是不应被劫持的原生输入元素。 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return false
}

/** 安装全局 keydown 监听（组件卸载即移除）。 */
export function useGlobalKeymap(): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return
      if (event.isComposing) return
      if (isTextEntryTarget(event.target)) return

      const chord = chordFromEvent(event)
      if (chord === '') return

      const matched = commands.byChord(chord).filter((command) => command.when?.() ?? true)
      const first = matched[0]
      if (first === undefined) return

      event.preventDefault()
      event.stopPropagation()
      void commands.execute(first.id)
    }

    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('keydown', handler)
    }
  }, [])
}
