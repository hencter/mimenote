/**
 * 键位解析器的安装点（ADR-0055）。
 *
 * 职责只有一条：把 `state/settings-store` 里的"档案 + 用户覆盖"接到
 * `app/commands` 的解析器上，并保证**每次设置变化后立刻重新解析**。
 *
 * 为什么键位状态不在这里另开一个 store：profile 与 overrides 是**偏好值**，
 * 它们必须和别的偏好一起写进同一个配置文件。两个 store 各写一次 config.toml，
 * 就会出现"谁后写谁赢"的丢字段问题 —— 配置文件的写者必须只有一个（见 ADR-0055）。
 * 因此这里是一个**派生层**：不持有状态，只做解析、冲突检测与查询。
 */

import { commands, setBindingResolver } from '@/app/commands'
import { findChordConflicts, resolveChords, type ChordConflict } from '@/domain/keymap'
import { useSettingsStore } from '@/state/settings-store'

/**
 * 安装解析器（`bootstrap` 里调一次）。
 *
 * 返回卸载函数：把解析器摘掉之后，命令表回到"只用自带默认键位"的状态 ——
 * 这是单测与"设置被清空"时唯一正确的退路。
 */
export function installKeymapResolver(): () => void {
  const apply = (): void => {
    const { keymapProfile, keymapOverrides } = useSettingsStore.getState()
    setBindingResolver((command) => resolveChords(command, keymapProfile, keymapOverrides))
  }

  apply()
  const unsubscribe = useSettingsStore.subscribe(apply)
  return () => {
    unsubscribe()
    setBindingResolver(null)
  }
}

/** 某条命令当前生效的键位（设置页与命令面板共用同一份结果）。 */
export function currentChordsOf(commandId: string): readonly string[] {
  const { keymapProfile, keymapOverrides } = useSettingsStore.getState()
  const command = commands.get(commandId)
  if (command === undefined) return []
  return resolveChords(command, keymapProfile, keymapOverrides)
}

/** 当前的键位冲突清单（真冲突排前面；互斥视图下的同名键也如实列出）。 */
export function keymapConflicts(): readonly ChordConflict[] {
  const { keymapProfile, keymapOverrides } = useSettingsStore.getState()
  return findChordConflicts(commands.list(), keymapProfile, keymapOverrides)
}
