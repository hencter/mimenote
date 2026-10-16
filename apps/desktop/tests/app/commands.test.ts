/** 命令注册表与快捷键解析（内置扩展点的核心机制）。 */

import { describe, expect, it, vi } from 'vitest'

import {
  CommandRegistry,
  chordFromEvent,
  formatChord,
  normalizeChord,
  normalizeKeyName,
} from '@/app/commands'

function keyEvent(init: {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}): KeyboardEvent {
  return {
    key: init.key,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
  } as KeyboardEvent
}

describe('CommandRegistry', () => {
  it('注册、查询、执行', async () => {
    const registry = new CommandRegistry()
    const run = vi.fn()
    registry.register({ id: 'demo.run', title: '执行', category: '测试', run })

    expect(registry.has('demo.run')).toBe(true)
    await expect(registry.execute('demo.run')).resolves.toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('重复 ID 直接抛错（尽早暴露冲突）', () => {
    const registry = new CommandRegistry()
    registry.register({ id: 'a', title: 'a', category: 'x', run: () => {} })
    expect(() => registry.register({ id: 'a', title: 'a2', category: 'x', run: () => {} })).toThrow(
      /重复注册/,
    )
  })

  it('空 ID 抛错', () => {
    const registry = new CommandRegistry()
    expect(() => registry.register({ id: '  ', title: 'x', category: 'x', run: () => {} })).toThrow()
  })

  it('未注册的命令返回 false', async () => {
    const registry = new CommandRegistry()
    await expect(registry.execute('nope')).resolves.toBe(false)
  })

  it('when 为 false 时不执行', async () => {
    const registry = new CommandRegistry()
    const run = vi.fn()
    registry.register({ id: 'gated', title: 'x', category: 'x', when: () => false, run })
    await expect(registry.execute('gated')).resolves.toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('available 只返回条件成立的命令', () => {
    const registry = new CommandRegistry()
    registry.register({ id: 'always', title: '总是', category: 'x', run: () => {} })
    registry.register({ id: 'never', title: '从不', category: 'x', when: () => false, run: () => {} })
    expect(registry.available().map((command) => command.id)).toEqual(['always'])
  })

  it('list 按分类 + 标题排序', () => {
    const registry = new CommandRegistry()
    registry.register({ id: 'b', title: 'B', category: 'beta', run: () => {} })
    registry.register({ id: 'a', title: 'A', category: 'alpha', run: () => {} })
    expect(registry.list().map((command) => command.id)).toEqual(['a', 'b'])
  })

  it('分类为中文时按拼音排序（一等同"一"，二是"er"）', () => {
    const registry = new CommandRegistry()
    registry.register({ id: 'one', title: '一', category: '视图', run: () => {} })
    registry.register({ id: 'two', title: '二', category: '笔记', run: () => {} })
    expect(registry.list().map((command) => command.id)).toEqual(['two', 'one'])
  })

  it('byChord 命中快捷键（含数组与大小写归一化）', () => {
    const registry = new CommandRegistry()
    registry.register({ id: 'save', title: '保存', category: 'x', keybinding: 'mod+s', run: () => {} })
    registry.register({
      id: 'multi',
      title: '多键',
      category: 'x',
      keybinding: ['Mod+Alt+T', 'Mod+Shift+T'],
      run: () => {},
    })
    expect(registry.byChord('Mod+S').map((command) => command.id)).toEqual(['save'])
    expect(registry.byChord('Mod+Shift+T').map((command) => command.id)).toEqual(['multi'])
    expect(registry.byChord('')).toEqual([])
    expect(registry.byChord('Mod+Q')).toEqual([])
  })

  it('registerAll 返回统一卸载函数', () => {
    const registry = new CommandRegistry()
    const dispose = registry.registerAll([
      { id: '1', title: '1', category: 'x', run: () => {} },
      { id: '2', title: '2', category: 'x', run: () => {} },
    ])
    expect(registry.list()).toHaveLength(2)
    dispose()
    expect(registry.list()).toHaveLength(0)
  })
})

describe('快捷键解析', () => {
  it('normalizeChord 统一大小写与修饰键名', () => {
    expect(normalizeChord('mod+alt+s')).toBe('Mod+Alt+S')
    expect(normalizeChord('CTRL+S')).toBe('CTRL+S') // 非 Mod 写法保持原样，仅归一化键名
    expect(normalizeChord('Mod+Shift+ArrowUp')).toBe('Mod+Shift+ArrowUp')
  })

  it('normalizeKeyName 处理特殊键', () => {
    expect(normalizeKeyName(' ')).toBe('Space')
    expect(normalizeKeyName('Esc')).toBe('Escape')
    expect(normalizeKeyName('Up')).toBe('ArrowUp')
    expect(normalizeKeyName('a')).toBe('A')
  })

  it('chordFromEvent：Windows/Linux 用 Ctrl 作为 Mod', () => {
    expect(chordFromEvent(keyEvent({ key: 's', ctrlKey: true }), false)).toBe('Mod+S')
    expect(chordFromEvent(keyEvent({ key: 'S', ctrlKey: true, shiftKey: true }), false)).toBe('Mod+Shift+S')
    expect(chordFromEvent(keyEvent({ key: 'e', ctrlKey: true, altKey: true }), false)).toBe('Mod+Alt+E')
  })

  it('chordFromEvent：macOS 用 Cmd 作为 Mod', () => {
    expect(chordFromEvent(keyEvent({ key: 's', metaKey: true }), true)).toBe('Mod+S')
    // mac 上 Ctrl 不是 Mod
    expect(chordFromEvent(keyEvent({ key: 's', ctrlKey: true }), true)).toBe('S')
  })

  it('单独按下修饰键不产生组合', () => {
    expect(chordFromEvent(keyEvent({ key: 'Control', ctrlKey: true }), false)).toBe('')
    expect(chordFromEvent(keyEvent({ key: 'Shift', shiftKey: true }), false)).toBe('')
    expect(chordFromEvent(keyEvent({ key: 'Unidentified' }), false)).toBe('')
  })

  it('无修饰键的按键也能识别', () => {
    expect(chordFromEvent(keyEvent({ key: 'F2' }), false)).toBe('F2')
    expect(chordFromEvent(keyEvent({ key: 'Escape' }), false)).toBe('Escape')
  })

  it('formatChord 生成可读文本', () => {
    expect(formatChord('Mod+S', false)).toBe('Ctrl+S')
    expect(formatChord('Mod+Shift+F', false)).toBe('Ctrl+Shift+F')
    expect(formatChord('Mod+S', true)).toBe('⌘S')
  })
})
