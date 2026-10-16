/**
 * 键位解析（`domain/keymap.ts`，ADR-0055）。
 *
 * 这是"按了键会发生什么"的判据层，因此用例集中在四条容易出错的地方：
 * 1. **优先级**：用户覆盖 > 档案 > 默认表；
 * 2. **"键存在但数组为空"（显式解绑）与"键不存在"（没配过）是两件事** ——
 *    混成一个 `??` 就会让"我不想给这个动作快捷键"变成"恢复默认"；
 * 3. **档案只写差异**：`obsidian` 档案必须真的换掉那几条有肌肉记忆的键，其余保持默认；
 * 4. **冲突检测要能区分**"真的会撞"与"互斥视图下的同名键"。
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_KEYMAP_PROFILE,
  KEYMAP_PROFILE_BINDINGS,
  KEYMAP_PROFILES,
  defaultChordsOf,
  findChordConflicts,
  normalizeChords,
  normalizeOverrides,
  resolveChords,
  type KeymapCommand,
} from '@/domain/keymap'

const saveCommand: KeymapCommand = { id: 'note.save', keybinding: 'Mod+S' }
const quickSwitch: KeymapCommand = { id: 'palette.quickSwitch', keybinding: 'Mod+P' }

describe('默认值与归一化', () => {
  it('默认档案是 mimenote（人体工学表）', () => {
    expect(DEFAULT_KEYMAP_PROFILE).toBe('mimenote')
    expect(KEYMAP_PROFILES.map((profile) => profile.id)).toEqual(['mimenote', 'obsidian', 'vscode'])
  })

  it('默认键位可枚举（设置页的"默认值"列靠它）', () => {
    expect(defaultChordsOf(saveCommand)).toEqual(['Mod+S'])
    expect(defaultChordsOf({ id: 'x' })).toEqual([])
    // 数组写法与字符串写法等价
    expect(defaultChordsOf({ id: 'y', keybinding: ['Mod+-', 'Mod+Shift+_'] })).toEqual([
      'Mod+-',
      'Mod+Shift+_',
    ])
  })

  it('归一化：大小写与修饰键名统一、重复项去掉', () => {
    expect(normalizeChords(['mod+alt+s'])).toEqual(['Mod+Alt+S'])
    expect(normalizeChords(['Mod+S', 'mod+s', 'MOD+S'])).toEqual(['Mod+S'])
    expect(normalizeChords(['', 'Mod+S'])).toEqual(['Mod+S'])
  })
})

describe('解析优先级', () => {
  it('没有覆盖、档案也不管这条 → 用默认值', () => {
    expect(resolveChords(saveCommand, 'mimenote', {})).toEqual(['Mod+S'])
  })

  it('档案能改写指定命令，其余继承默认', () => {
    expect(resolveChords(saveCommand, 'obsidian', {})).toEqual(['Mod+S'])
    expect(resolveChords(quickSwitch, 'obsidian', {})).toEqual(['Mod+O'])
    expect(resolveChords(quickSwitch, 'mimenote', {})).toEqual(['Mod+P'])
  })

  it('用户覆盖赢过档案与默认', () => {
    expect(resolveChords(quickSwitch, 'obsidian', { 'palette.quickSwitch': ['Mod+Shift+O'] })).toEqual([
      'Mod+Shift+O',
    ])
  })

  it('空数组是"显式解绑"，与"没配过"是两件事', () => {
    expect(resolveChords(saveCommand, 'mimenote', { 'note.save': [] })).toEqual([])
    expect(resolveChords(saveCommand, 'mimenote', {})).toEqual(['Mod+S'])
  })

  it('obsidian 档案确实把三条有肌肉记忆的键换掉了', () => {
    expect(KEYMAP_PROFILE_BINDINGS.obsidian['palette.quickSwitch']).toEqual(['Mod+O'])
    expect(KEYMAP_PROFILE_BINDINGS.obsidian['palette.open']).toEqual(['Mod+P'])
    expect(KEYMAP_PROFILE_BINDINGS.obsidian['vault.open']).toEqual(['Mod+Shift+O'])
    // 差异式声明：默认档案不写任何条目
    expect(Object.keys(KEYMAP_PROFILE_BINDINGS.mimenote)).toEqual([])
  })
})

describe('覆盖的读入形态', () => {
  it('认字符串、数组、`none` 与空数组；非法项被丢掉', () => {
    const overrides = normalizeOverrides({
      'note.save': 'Mod+S',
      'note.new': ['Mod+N', 'Mod+Alt+N'],
      'note.delete': [],
      'note.rename': 'none',
      'note.move': 42,
      'note.stats': null,
    })
    expect(overrides['note.save']).toEqual(['Mod+S'])
    expect(overrides['note.new']).toEqual(['Mod+N', 'Mod+Alt+N'])
    expect(overrides['note.delete']).toEqual([])
    expect(overrides['note.rename']).toEqual([])
    expect(overrides['note.move']).toBeUndefined()
    expect(overrides['note.stats']).toBeUndefined()
  })

  it('不是对象的输入 → 空覆盖（不是崩溃）', () => {
    expect(normalizeOverrides(null)).toEqual({})
    expect(normalizeOverrides(['Mod+S'])).toEqual({})
    expect(normalizeOverrides('Mod+S')).toEqual({})
  })
})

describe('冲突检测', () => {
  it('同一键被两条命令占用 → 报出来', () => {
    const conflicts = findChordConflicts(
      [
        { id: 'a', keybinding: 'Mod+X' },
        { id: 'b', keybinding: 'Mod+X' },
        { id: 'c', keybinding: 'Mod+Y' },
      ],
      'mimenote',
      {},
    )
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.chord).toBe('Mod+X')
    expect(conflicts[0]?.commandIds).toEqual(['a', 'b'])
    expect(conflicts[0]?.real).toBe(true)
  })

  it('互斥视图下的同名键不算"真的会撞"，但依然列出', () => {
    const conflicts = findChordConflicts(
      [
        { id: 'graph.zoom', keybinding: 'Mod+0', when: () => false },
        { id: 'note.fit', keybinding: 'Mod+0', when: () => true },
      ],
      'mimenote',
      {},
    )
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.real).toBe(false)
  })

  it('用户覆盖造成的冲突同样可见', () => {
    const conflicts = findChordConflicts(
      [
        { id: 'a', keybinding: 'Mod+A' },
        { id: 'b', keybinding: 'Mod+B' },
      ],
      'mimenote',
      { b: ['Mod+A'] },
    )
    expect(conflicts.map((conflict) => conflict.chord)).toEqual(['Mod+A'])
  })
})
