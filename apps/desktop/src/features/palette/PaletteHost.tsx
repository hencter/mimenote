/**
 * 面板宿主：常驻挂载（**关着的时候也在树上**）。
 *
 * 必须常驻的原因：打开面板的按键监听（见 `use-palette-hotkeys.ts`）要在面板关闭时
 * 依然生效 —— 它就是"把面板打开"的那个东西。真正的面板只在打开时才渲染，
 * 于是"关闭 = 卸载 = 清空查询串 + 归还焦点"这条链路不需要任何额外的清理代码。
 */

import { useMemo } from 'react'

import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'
import { CommandPalette } from './CommandPalette'
import { buildNoteIndex } from './match'
import { usePaletteHotkeys } from './use-palette-hotkeys'

export function PaletteHost() {
  const mode = useUiStore((state) => state.paletteMode)
  const entries = useVaultStore((state) => state.entries)

  usePaletteHotkeys()

  // 笔记索引按「Vault 变化」派生，而不是按「面板打开」派生：
  // 1 万条目下这一步（小写化 + 排序）约 35ms，而 entries 在两次打开之间通常完全没变。
  // 若把 useMemo 放在面板组件里，组件每次关闭都会卸载、每次打开都要重算一遍 ——
  // 于是"按 Ctrl+P"这件最常做的事反而最慢。
  //
  // 全文搜索（第三种模式）**不需要**这里的索引：它的匹配发生在宿主（SQLite FTS5），
  // 前端只在 `usePaletteSearch` 里按查询串取结果，因此搜索模式下这份索引虽然被算出来
  // 也用不上（代价可忽略：它只在 Vault 变化时算一次，而 Ctrl+P 本来就要用）。
  const noteIndex = useMemo(() => buildNoteIndex(entries), [entries])

  return mode === null ? null : <CommandPalette mode={mode} noteIndex={noteIndex} />
}
