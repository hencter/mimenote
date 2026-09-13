/**
 * 命令注册表 —— 内置扩展点（ADR-0005）。
 *
 * 这是"高度自定义"的最小内核：命令具备 id / 标题 / 分类 / 快捷键 / 生效条件，
 * 可注册、可枚举、可卸载。M2 的命令面板与 M4 的插件 API 都直接消费它，
 * 因此它必须从 M1 起就是**可逆、可枚举、可版本化**的。
 */

/** 命令定义。 */
export interface Command {
  /** 稳定 ID（`域.动作`，例如 `note.save`）。 */
  id: string
  /** 面板/菜单中的展示名。 */
  title: string
  /** 分组（命令面板的排序与筛选依据）。 */
  category: string
  /** 默认快捷键，例如 `Mod+S`（`Mod` = Ctrl 或 Cmd）。 */
  keybinding?: string | string[]
  /** 生效条件；返回 false 时快捷键不响应、面板置灰。 */
  when?: () => boolean
  /**
   * `when` 为 false 时给用户看的原因（命令面板里显示在置灰项旁边）。
   *
   * 只影响**展示**：是否可执行始终以 `when()` 为唯一判据，
   * 面板也不会据此自己做判断 —— 否则就有两套状态可以不一致。
   */
  unavailableReason?: string
  run: () => void | Promise<void>
}

/** 卸载函数。 */
export type Disposer = () => void

export class CommandRegistry {
  private readonly entries = new Map<string, Command>()

  /** 注册命令；重复 ID 会抛错（尽早暴露冲突）。 */
  register(command: Command): Disposer {
    if (this.entries.has(command.id)) {
      throw new Error(`命令 ID 重复注册：${command.id}`)
    }
    if (command.id.trim() === '') {
      throw new Error('命令 ID 不能为空')
    }
    this.entries.set(command.id, command)
    return () => {
      this.entries.delete(command.id)
    }
  }

  /** 批量注册，返回统一卸载函数。 */
  registerAll(list: readonly Command[]): Disposer {
    const disposers = list.map((command) => this.register(command))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  get(id: string): Command | undefined {
    return this.entries.get(id)
  }

  /** 按分类 + 标题排序的全部命令。 */
  list(): Command[] {
    return [...this.entries.values()].sort((a, b) => {
      const byCategory = a.category.localeCompare(b.category, 'zh-Hans-CN')
      return byCategory !== 0 ? byCategory : a.title.localeCompare(b.title, 'zh-Hans-CN')
    })
  }

  /** 当前可执行（`when` 通过）的命令。 */
  available(): Command[] {
    return this.list().filter((command) => command.when?.() ?? true)
  }

  /** 按快捷键匹配（可返回多个，由调用方决定优先级）。 */
  byChord(chord: string): Command[] {
    if (chord === '') return []
    return this.list().filter((command) => bindingsOf(command).includes(chord))
  }

  /** 执行命令；返回是否真的执行了（未注册或 when 不通过返回 false）。 */
  async execute(id: string): Promise<boolean> {
    const command = this.entries.get(id)
    if (command === undefined) return false
    if (command.when !== undefined && !command.when()) return false
    await command.run()
    return true
  }
}

/** 全局注册表。 */
export const commands = new CommandRegistry()

function bindingsOf(command: Command): string[] {
  if (command.keybinding === undefined) return []
  const list = Array.isArray(command.keybinding) ? command.keybinding : [command.keybinding]
  return list.map(normalizeChord)
}

/** 归一化快捷键写法：`mod+s` → `Mod+S`。 */
export function normalizeChord(chord: string): string {
  return chord
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      if (part.toLowerCase() === 'mod') return 'Mod'
      if (part.toLowerCase() === 'alt') return 'Alt'
      if (part.toLowerCase() === 'shift') return 'Shift'
      return normalizeKeyName(part)
    })
    .join('+')
}

/** 键名归一化（与 KeyboardEvent.key 对齐）。 */
export function normalizeKeyName(key: string): string {
  const map: Record<string, string> = {
    ' ': 'Space',
    Esc: 'Escape',
    Up: 'ArrowUp',
    Down: 'ArrowDown',
    Left: 'ArrowLeft',
    Right: 'ArrowRight',
    Del: 'Delete',
    Return: 'Enter',
  }
  const mapped = map[key]
  if (mapped !== undefined) return mapped
  if (key.length === 1) return key.toUpperCase()
  return key
}

/** 是否为 macOS（决定 `Mod` 用 Cmd 还是 Ctrl）。 */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const platform = navigator.platform ?? ''
  return /mac|iphone|ipad/i.test(platform) || /Mac/i.test(navigator.userAgent)
}

/** 键盘事件 → 归一化快捷键串（无有效主键时返回空串）。 */
export function chordFromEvent(event: KeyboardEvent, isMac = isMacPlatform()): string {
  const modifiers: string[] = []
  const primary = isMac ? event.metaKey : event.ctrlKey
  if (primary) modifiers.push('Mod')
  if (event.altKey) modifiers.push('Alt')
  if (event.shiftKey) modifiers.push('Shift')

  const rawKey = event.key
  if (rawKey === 'Control' || rawKey === 'Meta' || rawKey === 'Alt' || rawKey === 'Shift') return ''
  if (rawKey === 'Unidentified') return ''

  // 纯修饰键之外的按键：字母/数字统一大写，其余按名称
  let key = normalizeKeyName(rawKey)
  if (/^[a-z]$/.test(key)) key = key.toUpperCase()

  return [...modifiers, key].join('+')
}

/** 人类可读的快捷键展示（状态栏/命令面板用）。 */
export function formatChord(chord: string, isMac = isMacPlatform()): string {
  return normalizeChord(chord)
    .split('+')
    .map((part) => {
      if (part === 'Mod') return isMac ? '⌘' : 'Ctrl'
      if (part === 'Alt') return isMac ? '⌥' : 'Alt'
      if (part === 'Shift') return isMac ? '⇧' : 'Shift'
      if (part === 'ArrowUp') return '↑'
      if (part === 'ArrowDown') return '↓'
      if (part === 'ArrowLeft') return '←'
      if (part === 'ArrowRight') return '→'
      if (part === 'Escape') return 'Esc'
      return part
    })
    .join(isMac ? '' : '+')
}
