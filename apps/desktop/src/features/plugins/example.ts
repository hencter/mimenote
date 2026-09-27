/**
 * 示例插件（M4 的可验证交付）：权限最小化前提下加载、运行、卸载无残留。
 *
 * 它只做一件事 —— 注册 `example.hello` 命令，执行时给用户一句提示。
 * 动态加载与 Worker 隔离落地之前，它由调用方直接传入 `pluginHost.load(EXAMPLE_PLUGIN)`；
 * 设置页的"插件"分区（下一批）会把它当作第一个可安装项。
 */

import { parsePluginManifest } from './manifest'
import type { PluginDefinition } from './host'

export const EXAMPLE_PLUGIN_MANIFEST = parsePluginManifest({
  id: 'example.hello',
  name: '示例插件',
  version: '0.1.0',
  minAppVersion: '0.2.0',
  permissions: ['commands'],
})

export const EXAMPLE_PLUGIN: PluginDefinition = {
  manifest: EXAMPLE_PLUGIN_MANIFEST,
  setup: (api) => {
    api.commands.register({
      id: 'example.hello.say',
      title: '打个招呼',
      category: '示例',
      run: () => {
        api.notify('你好，插件在工作。')
      },
    })
  },
}
