// @vitest-environment jsdom
/** 插件宿主：加载、命名空间门禁、错误边界、卸载清理（M4 第一批）。 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { CommandRegistry } from '@/app/commands'
import { EXAMPLE_PLUGIN } from '@/features/plugins/example'
import { PluginHost } from '@/features/plugins/host'
import { parsePluginManifest } from '@/features/plugins/manifest'

function manifestOf(id: string, permissions: string[] = ['commands']) {
  return parsePluginManifest({
    id,
    name: `插件 ${id}`,
    version: '0.1.0',
    minAppVersion: '0.2.0',
    permissions,
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PluginHost', () => {
  it('示例插件加载后命令可用，卸载后无残留', async () => {
    const registry = new CommandRegistry()
    const notified: string[] = []
    const host = new PluginHost({ registry, notify: (message) => notified.push(message) })

    const record = await host.load(EXAMPLE_PLUGIN)
    expect(record.status).toBe('active')
    expect(host.has('example.hello')).toBe(true)
    expect(registry.has('example.hello.say')).toBe(true)

    await registry.execute('example.hello.say')
    expect(notified).toEqual(['你好，插件在工作。'])

    record.dispose()
    expect(registry.has('example.hello.say')).toBe(false)
    expect(host.has('example.hello')).toBe(false)
    // 幂等：再调一次不报错
    record.dispose()
  })

  it('未声明 commands 权限时注册直接抛错且插件进 failed', async () => {
    const registry = new CommandRegistry()
    const host = new PluginHost({ registry, notify: () => {} })
    const record = await host.load({
      manifest: manifestOf('example.noperm', []),
      setup: (api) => {
        api.commands.register({ id: 'example.noperm.x', title: 'x', category: 'x', run: () => {} })
      },
    })
    expect(record.status).toBe('failed')
    expect(record.error).toContain('未声明')
  })

  it('命令 ID 不以插件 ID 开头时拒绝（防抢内置命令）', async () => {
    const registry = new CommandRegistry()
    const host = new PluginHost({ registry, notify: () => {} })
    const record = await host.load({
      manifest: manifestOf('example.scoped'),
      setup: (api) => {
        api.commands.register({ id: 'note.save', title: 'x', category: 'x', run: () => {} })
      },
    })
    expect(record.status).toBe('failed')
    expect(record.error).toContain('必须以 example.scoped. 开头')
    expect(registry.has('note.save')).toBe(false)
  })

  it('setup 抛错只让这一个插件失败', async () => {
    const registry = new CommandRegistry()
    const host = new PluginHost({ registry, notify: () => {} })
    const bad = await host.load({
      manifest: manifestOf('example.bad'),
      setup: () => {
        throw new Error('boom')
      },
    })
    expect(bad.status).toBe('failed')

    const good = await host.load(EXAMPLE_PLUGIN)
    expect(good.status).toBe('active')
    expect(registry.has('example.hello.say')).toBe(true)
  })

  it('插件命令运行时抛错只 toast、不掀翻宿主', async () => {
    const registry = new CommandRegistry()
    const host = new PluginHost({ registry, notify: () => {} })
    await host.load({
      manifest: manifestOf('example.thrower'),
      setup: (api) => {
        api.commands.register({
          id: 'example.thrower.bang',
          title: 'x',
          category: 'x',
          run: () => {
            throw new Error('run-boom')
          },
        })
      },
    })
    // 不抛给调用方（错误边界在宿主层吞掉并 toast）
    await expect(registry.execute('example.thrower.bang')).resolves.toBe(true)
  })

  it('重复加载同一 ID 返回 failed（不覆盖已加载的）', async () => {
    const registry = new CommandRegistry()
    const host = new PluginHost({ registry, notify: () => {} })
    const first = await host.load(EXAMPLE_PLUGIN)
    expect(first.status).toBe('active')
    const second = await host.load(EXAMPLE_PLUGIN)
    expect(second.status).toBe('failed')
    expect(second.error).toContain('已加载')
    host.unloadAll()
    expect(host.listed()).toEqual([])
  })
})
