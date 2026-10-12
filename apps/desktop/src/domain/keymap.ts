/**
 * 键位解析的**唯一判据**（ADR-0055）：默认表 + 档案（profile）+ 用户覆盖。
 *
 * 为什么单独成一层而不是塞进 `app/commands.ts`：
 * 1. 它是纯函数（无 React、无注册表、无 DOM），能被单测直接钉住 —— 而"哪条命令最终是谁的键"
 *    一旦出错，症状是"按了没反应"或"按了做错事"，靠人眼在界面上找非常贵；
 * 2. 设置页要展示**同一份结果**（当前键位、冲突、默认值），命令面板也要显示它 ——
 *    两个消费者共用一个判据，才不会出现"设置页说 A、实际按出来是 B"。
 *
 * 优先级（先命中者胜，见设计文档 §1）：
 * 用户覆盖 → 档案 → 命令自带的默认键位 → 无键位。
 */

/** 命令在键位层需要知道的最小形状（只依赖结构，不依赖命令注册表的实现）。 */
export interface KeymapCommand {
  readonly id: string
  readonly keybinding?: string | readonly string[]
  /** 生效条件（冲突检测用它判断"两条命令是不是真的会同时抢一个键"）。 */
  readonly when?: () => boolean
}

export type KeymapProfileId = 'mimenote' | 'obsidian' | 'vscode'

export const DEFAULT_KEYMAP_PROFILE: KeymapProfileId = 'mimenote'

export interface KeymapProfileMeta {
  readonly id: KeymapProfileId
  readonly label: string
  readonly description: string
}

/** 档案列表（设置页的下拉顺序即此顺序）。 */
export const KEYMAP_PROFILES: readonly KeymapProfileMeta[] = [
  {
    id: 'mimenote',
    label: 'Mimenote（默认，按人体工学排列）',
    description: '高频动作占单修饰键，面板与视图放 Mod+Shift，低频破坏性动作放 Mod+Alt。',
  },
  {
    id: 'obsidian',
    label: 'Obsidian 兼容',
    description: '把快速切换/命令面板/打开 Vault 换成 Obsidian 的默认键位，保住肌肉记忆。',
  },
  {
    id: 'vscode',
    label: 'VS Code 兼容',
    description: '命令面板用 Mod+Shift+P、快速切换用 Mod+P；侧栏仍留在 Mod+Shift+B（Mod+B 归加粗）。',
  },
]

/**
 * 档案只写**"与默认表不同"**的那些命令。
 *
 * 为什么不给每个档案写全表：全表意味着每加一条命令都要在三个档案里各补一行，
 * 漏一处就是"某档案下这条命令没有键位"的静默缺陷。差异式声明把维护面压到最小。
 */
export const KEYMAP_PROFILE_BINDINGS: Readonly<Record<KeymapProfileId, Readonly<Record<string, readonly string[]>>>> = {
  mimenote: {},
  obsidian: {
    'palette.quickSwitch': ['Mod+O'],
    'palette.open': ['Mod+P'],
    'vault.open': ['Mod+Shift+O'],
  },
  vscode: {
    'palette.quickSwitch': ['Mod+P'],
    'palette.open': ['Mod+Shift+P'],
    'vault.open': ['Mod+K'],
  },
}

/** 用户覆盖：键是命令 id，值是**归一化之前**的键位数组；空数组 = 显式解绑。 */
export type KeymapOverrides = Readonly<Record<string, readonly string[]>>

/** 解绑的书写形式（配置里写 `chords = []` 或 `chords = "none"` 都认）。 */
export const UNBIND_TOKEN = 'none'

/**
 * 解析一条命令最终生效的键位（已归一化、已去重，顺序与声明一致）。
 *
 * 注意"键存在但数组为空"与"键不存在"的区别：前者是用户**显式解绑**，
 * 后者是"没配过"。把它们混成一个 `??` 就会让"我不想给这个动作快捷键"变成"恢复默认"。
 */
export function resolveChords(
  command: KeymapCommand,
  profile: KeymapProfileId,
  overrides: KeymapOverrides,
): readonly string[] {
  const override = overrides[command.id]
  const source =
    override !== undefined
      ? override
      : (KEYMAP_PROFILE_BINDINGS[profile][command.id] ?? defaultChordsOf(command))
  return normalizeChords(source)
}

/** 命令自带的默认键位（设置页的"默认值"列用）。 */
export function defaultChordsOf(command: KeymapCommand): readonly string[] {
  if (command.keybinding === undefined) return []
  const list = Array.isArray(command.keybinding) ? command.keybinding : [command.keybinding]
  return normalizeChords(list as readonly string[])
}

/** 同时按下会冲突的键位与它的争夺者。 */
export interface ChordConflict {
  readonly chord: string
  readonly commandIds: readonly string[]
  /**
   * 是否**真的**会撞：两条命令的 `when` 同时成立（或至少一条没有 `when`）时为 true。
   * 否则是"互斥视图下的同名键"（例如编辑与图谱各自的 `Mod+0`），只需提示、不算缺陷。
   */
  readonly real: boolean
}

/**
 * 找出同一键位被多条命令占用的情形。
 *
 * 为什么连"互斥视图下的同名键"也报出来：用户看到的是"一个键出现在两条命令上"，
 * 需要有人告诉他这是**有意**的（互斥生效），而不是让他自己猜。
 */
export function findChordConflicts(
  commands: readonly KeymapCommand[],
  profile: KeymapProfileId,
  overrides: KeymapOverrides,
): readonly ChordConflict[] {
  const byChord = new Map<string, string[]>()
  for (const command of commands) {
    for (const chord of resolveChords(command, profile, overrides)) {
      const list = byChord.get(chord)
      if (list === undefined) byChord.set(chord, [command.id])
      else list.push(command.id)
    }
  }

  const conflicts: ChordConflict[] = []
  for (const [chord, commandIds] of byChord) {
    if (commandIds.length < 2) continue
    const owners = commandIds
      .map((id) => commands.find((command) => command.id === id))
      .filter((command): command is KeymapCommand => command !== undefined)
    const active = owners.filter((command) => command.when?.() ?? true)
    conflicts.push({ chord, commandIds, real: active.length >= 2 })
  }
  // 真冲突排前面，其余按字母序 —— 列表的稳定顺序让"截图比对"这件事变得可能
  return conflicts.sort((left, right) => {
    if (left.real !== right.real) return left.real ? -1 : 1
    return left.chord.localeCompare(right.chord)
  })
}

/** 把配置里读到的原始值收敛成 {@link KeymapOverrides}（认数组、字符串、`none` 与空数组）。 */
export function normalizeOverrides(raw: unknown): KeymapOverrides {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const result: Record<string, readonly string[]> = {}
  for (const [commandId, value] of Object.entries(raw as Record<string, unknown>)) {
    const chords = normalizeOverrideValue(value)
    if (chords === null) continue
    result[commandId] = chords
  }
  return result
}

function normalizeOverrideValue(value: unknown): readonly string[] | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return []
    return trimmed.toLowerCase() === UNBIND_TOKEN ? [] : [trimmed]
  }
  if (Array.isArray(value)) {
    const list: string[] = []
    for (const item of value) {
      if (typeof item !== 'string') return null
      const trimmed = item.trim()
      if (trimmed === '') continue
      if (trimmed.toLowerCase() === UNBIND_TOKEN) continue
      list.push(trimmed)
    }
    return list
  }
  return null
}

/** 一组键位串的归一化 + 去重（保留声明顺序）。 */
export function normalizeChords(chords: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const chord of chords) {
    const normalized = normalizeChord(chord)
    if (normalized === '' || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

/*
 * ---------------------------------------------------------------------------
 * 键盘原语（`normalizeChord` / `chordFromEvent` / `formatChord` …）
 *
 * 它们原先住在 `app/commands.ts`。搬到这里的原因是**分层**：这几个函数是纯字符串/事件
 * 逻辑，不碰注册表也不碰 React，而键位解析（本文件上半部分）必须用到它们 ——
 * 留在 app 层就会让 domain 反过来依赖 app。
 *
 * `app/commands.ts` 仍然**再导出**同样这几个名字：调用点（keymap.ts、面板、测试）不必改，
 * 而实现只有这一份。
 * ---------------------------------------------------------------------------
 */

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

/**
 * "主修饰键是不是 Cmd"的**注入点**（ADR-0060 的 domain 纯净性）。
 *
 * 为什么不是一个 `isMacPlatform()` 直接读 `navigator`：那会让 `domain` 碰浏览器全局 ——
 * 按 ADR-0060 的判据，碰了就说明它不该住 domain。环境探测住在 `app/env.ts`
 * （运行时层），由 `app/bootstrap.ts` 在启动时装进来；**未安装时的默认值是 `false`**
 * （Windows/Linux 语义），于是纯单测里的行为是确定的，不依赖 jsdom 的 `navigator` 长什么样。
 */
let macPlatformResolver: () => boolean = () => false

/** 安装平台探测（`bootstrap` 里调一次；传 `null` 回到"非 mac"）。 */
export function setMacPlatformResolver(next: (() => boolean) | null): void {
  macPlatformResolver = next ?? (() => false)
}

/** 键盘事件 → 归一化快捷键串（无有效主键时返回空串）。 */
export function chordFromEvent(event: KeyboardEvent, isMac = macPlatformResolver()): string {
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

/** 人类可读的快捷键展示（状态栏/命令面板/设置页用）。 */
export function formatChord(chord: string, isMac = macPlatformResolver()): string {
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
