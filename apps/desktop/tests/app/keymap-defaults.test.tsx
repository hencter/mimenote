// @vitest-environment jsdom
/**
 * 默认键位表（ADR-0055 / 设计 01 §3）——它是**设计的一部分**，所以要有门禁钉住。
 *
 * 为什么值得一个文件：这张表是"人体工学分四层"这个决定的全部体现，而它散落在
 * `builtin-commands.ts` 的几十条命令里。没有门禁时，一次无意的 `keybinding` 改动
 * （或者新增命令时挑了个已被占用的键）只会表现为"用户按了没反应"，而不会有人发现。
 *
 * 这里断言两件事：
 * 1. **设计表逐条落地**（含新命令：格式化 / 收件箱 / 模板 / 双栏树）；
 * 2. **没有真冲突**：把整张表交给 `findChordConflicts`，只允许"互斥视图下的同名键"
 *    （图谱的 `Mod+=`/`Mod+-`/`Mod+0`/`Escape` 与全局命令不是同一视图）。
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { registerBuiltinCommands } from '@/app/builtin-commands'
import { commands } from '@/app/commands'
import {
  DEFAULT_KEYMAP_PROFILE,
  defaultChordsOf,
  resolveChords,
} from '@/domain/keymap'

/** 设计文档 §3.2 的表（命令 id → 期望键位）。 */
const EXPECTED_CHORDS: readonly (readonly [string, readonly string[]])[] = [
  // 编辑与文档
  ['note.new', ['Mod+N']],
  ['note.save', ['Mod+S']],
  ['note.formatBold', ['Mod+B']],
  ['note.formatItalic', ['Mod+I']],
  ['note.formatLink', ['Mod+K']],
  ['note.formatCode', ['Mod+Shift+K']],
  ['note.formatStrike', ['Mod+Shift+X']],
  ['note.formatTable', ['Mod+Alt+F']],
  ['export.pdf', ['Mod+Alt+P']],
  // 导航
  ['palette.quickSwitch', ['Mod+P']],
  ['palette.open', ['Mod+Shift+P']],
  ['search.open', ['Mod+Shift+F']],
  ['settings.open', ['Mod+,']],
  // 视图与面板
  ['view.cycleMode', ['Mod+E']],
  ['view.graph', ['Mod+G']],
  ['view.toggleSidebar', ['Mod+Shift+B']],
  ['view.toggleLinksPanel', ['Mod+Shift+L']],
  ['view.toggleTagsPanel', ['Mod+Shift+T']],
  ['view.toggleOutlinePanel', ['Mod+Shift+O']],
  ['view.toggleLineNumbers', ['Mod+Alt+N']],
  // 捕获 / 模板 / 文件树
  ['inbox.capture', ['Mod+Shift+I']],
  ['inbox.open', ['Mod+Alt+I']],
  ['template.newFrom', ['Mod+Shift+N']],
  ['tree.toggleColumns', ['Mod+Alt+C']],
  ['tree.focusFilter', ['Mod+Shift+E']],
  ['tree.expandAll', ['Mod+Alt+E']],
  ['tree.collapseAll', ['Mod+Alt+W']],
  // Vault / 外观 / 帮助
  ['vault.open', ['Mod+Alt+O']],
  ['vault.rescan', ['Mod+Alt+R']],
  ['theme.next', ['Mod+Alt+T']],
  ['help.about', ['Mod+Alt+A']],
]

beforeAll(() => {
  registerBuiltinCommands()
})

describe('默认键位表', () => {
  it.each(EXPECTED_CHORDS)('%s → %s', (commandId, expected) => {
    const command = commands.get(commandId)
    expect(command, `命令未注册：${commandId}`).toBeDefined()
    if (command === undefined) return
    // 默认档案下：解析结果 = 设计表
    expect(resolveChords(command, DEFAULT_KEYMAP_PROFILE, {})).toEqual(expected)
    // 命令自带的 `keybinding`（设置页"默认值"列的数据源）也必须等于设计表 ——
    // 否则用户在其中一处看到的"默认"是假的
    expect(defaultChordsOf(command)).toEqual(expected)
  })

  it('命令面板与"插入链接"的键位确实是互换之后的（ADR-0055 的核心决定）', () => {
    expect(resolveChords(commands.get('palette.open')!, DEFAULT_KEYMAP_PROFILE, {})).toEqual([
      'Mod+Shift+P',
    ])
    expect(resolveChords(commands.get('note.formatLink')!, DEFAULT_KEYMAP_PROFILE, {})).toEqual([
      'Mod+K',
    ])
    // `Mod+B` 归"加粗"，侧栏在 `Mod+Shift+B`
    expect(resolveChords(commands.get('note.formatBold')!, DEFAULT_KEYMAP_PROFILE, {})).toEqual([
      'Mod+B',
    ])
    expect(resolveChords(commands.get('view.toggleSidebar')!, DEFAULT_KEYMAP_PROFILE, {})).toEqual([
      'Mod+Shift+B',
    ])
  })

  it('整张表里没有结构性重叠（不依赖运行环境，只允许图谱那一族的互斥键）', () => {
    /*
     * 为什么不用 `findChordConflicts(...).real` 断言：那个判据要调 `when()`，
     * 在"没有打开 Vault / 笔记"的环境里一堆命令都不可用，于是**真冲突会被判成互斥**——
     * 这条用例第一版就是这么假绿的（`Mod+Shift+P` 同时给了命令面板与导出 PDF，没被发现）。
     *
     * 这里改用与环境无关的结构判据：同一 chord 的所有者里，只要不全是图谱命令
     * （`graph.*` 一族只在图谱视图里生效，`Mod+=`/`Mod+-`/`Mod+0`/`Escape` 与全局命令天然互斥），
     * 就算重叠。
     */
    const byChord = new Map<string, string[]>()
    for (const command of commands.list()) {
      const chords = [...defaultChordsOf(command)]
      for (const chord of chords) {
        const owners = byChord.get(chord) ?? []
        owners.push(command.id)
        byChord.set(chord, owners)
      }
    }

    const structural = [...byChord.entries()]
      .filter(([, owners]) => owners.length > 1)
      .filter(([, owners]) => owners.some((id) => !id.startsWith('graph.')))
      .map(([chord, owners]) => `${chord} → ${owners.join(' / ')}`)

    expect(structural).toEqual([])
  })

  it('obsidian 档案把三条肌肉记忆的键换掉（其余保持默认）', () => {
    const quickSwitch = commands.get('palette.quickSwitch')
    expect(quickSwitch).toBeDefined()
    if (quickSwitch === undefined) return
    expect(resolveChords(quickSwitch, 'obsidian', {})).toEqual(['Mod+O'])
    expect(resolveChords(commands.get('palette.open')!, 'obsidian', {})).toEqual(['Mod+P'])
    expect(resolveChords(commands.get('vault.open')!, 'obsidian', {})).toEqual(['Mod+Shift+O'])
    // 不受档案影响的命令仍走默认表
    expect(resolveChords(commands.get('note.save')!, 'obsidian', {})).toEqual(['Mod+S'])
  })
})
