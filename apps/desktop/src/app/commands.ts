/**
 * 命令注册表 —— 内置扩展点（ADR-0005）。
 *
 * 这是"高度自定义"的最小内核：命令具备 id / 标题 / 分类 / 快捷键 / 生效条件，
 * 可注册、可枚举、可卸载。M2 的命令面板与 M4 的插件 API 都直接消费它，
 * 因此它必须从 M1 起就是**可逆、可枚举、可版本化**的。
 */

import { normalizeChords } from '@/domain/keymap'

/** 命令定义。 */
export interface Command {
  /** 稳定 ID（`域.动作`，例如 `note.save`）。 */
  id: string
  /** 面板/菜单中的展示名。 */
  title: string
  /** 分组（命令面板的排序与筛选依据）。 */
  category: string
  /**
   * **默认**快捷键，例如 `Mod+S`（`Mod` = Ctrl 或 Cmd）。
   *
   * 语义在 ADR-0055 之后收窄为"默认值"：运行时生效的键位由 `state/keymap-store`
   * 安装到本模块的解析器决定（用户覆盖 → 档案 → 这里的默认值），见 `setBindingResolver`。
   */
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

/**
 * 快捷键解析器（由 `state/keymap-store` 安装）。
 *
 * 为什么要注入、而不是在这里直接读设置：命令表是 M1 就定下的**数据结构**，
 * 而"档案 + 用户覆盖"属于设置层。让注册表反向依赖设置层会成环，也会让这个最小内核
 * 多背一份配置状态。未安装解析器时（例如纯单测）按命令自带的默认值分发 —— 行为与从前一致。
 */
export type BindingResolver = (command: Command) => readonly string[]

let bindingResolver: BindingResolver | null = null

/** 安装/卸载解析器；传 `null` 回到"只用默认表"。 */
export function setBindingResolver(next: BindingResolver | null): void {
  bindingResolver = next
}

function bindingsOf(command: Command): readonly string[] {
  const resolved = bindingResolver === null ? defaultBindingList(command) : bindingResolver(command)
  return normalizeChords(resolved)
}

/** 命令自带的默认键位（解析器缺席时的唯一来源）。 */
function defaultBindingList(command: Command): readonly string[] {
  if (command.keybinding === undefined) return []
  return Array.isArray(command.keybinding) ? command.keybinding : [command.keybinding]
}

/*
 * 键盘原语（`normalizeChord` / `normalizeKeyName` / `isMacPlatform` / `chordFromEvent` /
 * `formatChord`）的实现搬到了 `domain/keymap.ts`：它们是纯逻辑，而键位解析（ADR-0055）
 * 必须用到它们 —— domain 不能反过来依赖 app。这里**再导出**同一组名字，
 * 既有调用点（`app/keymap.ts`、面板、测试）零改动，而实现只有一份。
 */
export { chordFromEvent, formatChord, isMacPlatform, normalizeChord, normalizeKeyName } from '@/domain/keymap'

