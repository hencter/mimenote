/**
 * 插件宿主（M4 第一批）：加载、权限门禁、错误边界、卸载清理。
 *
 * 本批刻意**不做**的两件事（下一批）：
 * 1. **动态代码加载 + Worker 隔离**：插件定义是调用方直接传入的对象（示例插件在 `example.ts`），
 *    还没有"从 Vault 读 `manifest.json` + `plugin.js` 并在 Worker 里跑"；隔离之前第三方代码
 *    不进应用，`PluginHost` 只管理受信任的内置示例与测试替身；
 * 2. **主题 / CSS 片段 / 编辑器扩展 / 设置**四类 API：第一批只暴露 `commands`（最小权限闭环），
 *    其它扩展点仍是内部机制（见 ADR-0005 的对应表），逐个开放时逐个加权限名与测试。
 *
 * 三条纪律（M4 能顺利落地的前提，见 ADR-0005 的"影响"）：
 * - **可逆**：`load` 返回的 `dispose` 必须清掉该插件的一切（命令、监听），调两次不报错；
 * - **可枚举**：`loaded()` 随时能列出已加载的插件（设置页与测试都读它）；
 * - **错误边界**：插件 `setup` 抛错只让这一个插件进 `failed`，插件命令运行时抛错只 toast 一次，
 *   宿主与其它插件不受影响。
 */

import { commands, type Command, type CommandRegistry, type Disposer } from '@/app/commands'
import { toast } from '@/state/toast-store'

import type { PluginManifest, PluginPermission } from './manifest'

/** 插件暴露给外部的最小 API（第一批只有命令 + 通知）。 */
export interface PluginApi {
  commands: {
    /** 注册一条命令（ID 必须以 `<插件ID>.` 开头；需要 `commands` 权限）。 */
    register: (command: Command) => Disposer
  }
  /** 给用户看一句轻提示（默认走 toast）。 */
  notify: (message: string) => void
}

/** 插件定义（调用方传入，动态加载接上后改为从文件构造）。 */
export interface PluginDefinition {
  manifest: PluginManifest
  /** 安装逻辑；返回的卸载函数与宿主的命令清理会合并执行。 */
  setup: (api: PluginApi) => void | Promise<void> | Disposer | void
}

/** 已加载插件的状态。 */
export type PluginStatus = 'active' | 'failed'

/** 已加载插件的记录。 */
export interface LoadedPlugin {
  manifest: PluginManifest
  status: PluginStatus
  /** 失败原因（`failed` 时有值）。 */
  error?: string
  /** 卸载（幂等）。 */
  dispose: () => void
}

/** 宿主的注入点（测试用假 registry / 假 notify；生产用默认值）。 */
export interface PluginHostOptions {
  registry?: CommandRegistry
  notify?: (message: string) => void
}

function defaultNotify(message: string): void {
  toast.success(message)
}

export class PluginHost {
  private readonly registry: CommandRegistry
  private readonly notifyFn: (message: string) => void
  private readonly loaded = new Map<string, LoadedPlugin>()

  constructor(options: PluginHostOptions = {}) {
    this.registry = options.registry ?? commands
    this.notifyFn = options.notify ?? defaultNotify
  }

  /** 已加载的插件（按 ID 排序）。 */
  listed(): LoadedPlugin[] {
    return [...this.loaded.values()].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))
  }

  /** 是否已加载。 */
  has(id: string): boolean {
    return this.loaded.has(id)
  }

  /**
   * 加载插件。
   *
   * 失败只影响这一个插件：`setup` 同步抛错 / 返回 rejected promise / 重复 ID，
   * 都会记成 `failed` 并返回记录（不抛给调用方，调用方读 `record.status` 即可）。
   */
  async load(definition: PluginDefinition): Promise<LoadedPlugin> {
    const { manifest } = definition
    const existing = this.loaded.get(manifest.id)
    if (existing !== undefined) {
      const failed: LoadedPlugin = {
        manifest,
        status: 'failed',
        error: `插件已加载：${manifest.id}`,
        dispose: () => {},
      }
      return failed
    }

    const disposers: Disposer[] = []
    let disposed = false
    const disposeOnce = (): void => {
      if (disposed) return
      disposed = true
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose()
        } catch {
          // 卸载路径不许再抛：部分清理失败也不能挡住剩下的清理。
        }
      }
      this.loaded.delete(manifest.id)
    }

    const api: PluginApi = {
      commands: {
        register: (command: Command): Disposer => {
          if (!manifest.permissions.includes('commands' satisfies PluginPermission)) {
            throw new Error(`插件 ${manifest.id} 未声明 commands 权限`)
          }
          if (!command.id.startsWith(`${manifest.id}.`)) {
            throw new Error(`插件命令 ID 必须以 ${manifest.id}. 开头：${command.id}`)
          }
          // 错误边界包在宿主这一层：插件命令抛错只 toast，不掀翻调用栈上的其它逻辑。
          const guarded: Command = {
            ...command,
            run: async () => {
              try {
                await command.run()
              } catch (error) {
                const detail = error instanceof Error ? error.message : String(error)
                toast.error(`插件 ${manifest.name} 执行失败`, detail)
              }
            },
          }
          const dispose = this.registry.register(guarded)
          disposers.push(dispose)
          return () => {
            dispose()
            const index = disposers.indexOf(dispose)
            if (index >= 0) disposers.splice(index, 1)
          }
        },
      },
      notify: (message: string): void => {
        this.notifyFn(message)
      },
    }

    try {
      const result = definition.setup(api)
      if (result instanceof Promise) await result
      if (typeof result === 'function') disposers.push(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      disposeOnce()
      const failed: LoadedPlugin = {
        manifest,
        status: 'failed',
        error: message,
        dispose: () => {},
      }
      this.loaded.set(manifest.id, failed)
      toast.error(`插件 ${manifest.name} 加载失败`, message)
      return failed
    }

    const record: LoadedPlugin = { manifest, status: 'active', dispose: disposeOnce }
    this.loaded.set(manifest.id, record)
    return record
  }

  /** 卸载（没有这个插件时什么都不做）。 */
  unload(id: string): void {
    this.loaded.get(id)?.dispose()
  }

  /** 全部卸载（切换 Vault / 测试清理用）。 */
  unloadAll(): void {
    for (const id of [...this.loaded.keys()]) this.unload(id)
  }
}

/** 全局宿主（生产路径；测试请 `new PluginHost` 自建）。 */
export const pluginHost = new PluginHost()
