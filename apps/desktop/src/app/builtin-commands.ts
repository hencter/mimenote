/** 内置命令表（M1 的全部命令；M2 的命令面板直接渲染这张表）。 */

import { useNoteStore } from '@/state/note-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'
import {
  closeVault,
  createNoteHere,
  deleteSelected,
  openVaultInteractive,
  reloadCurrentNote,
  rescanVault,
  saveCurrentNote,
  showAbout,
  toggleSnippets,
} from './actions'
import { commands, type Command, type Disposer } from './commands'
import { requestFilterFocus } from './dom-events'

/** 扩展点 API 版本（M4 的插件 manifest 会声明 `minAppVersion`）。 */
export const API_VERSION = 1

const hasVault = (): boolean => useVaultStore.getState().info !== null
const hasDocument = (): boolean => useNoteStore.getState().doc !== null
const hasSelection = (): boolean => useVaultStore.getState().selected !== null

export const BUILTIN_COMMANDS: readonly Command[] = [
  {
    id: 'vault.open',
    title: '打开 Vault…',
    category: 'Vault',
    keybinding: 'Mod+O',
    run: openVaultInteractive,
  },
  {
    id: 'vault.rescan',
    title: '重新扫描 Vault',
    category: 'Vault',
    keybinding: 'Mod+Alt+R',
    when: hasVault,
    run: rescanVault,
  },
  {
    id: 'vault.close',
    title: '关闭 Vault',
    category: 'Vault',
    when: hasVault,
    run: closeVault,
  },

  {
    id: 'note.new',
    title: '新建笔记',
    category: '笔记',
    keybinding: 'Mod+N',
    when: hasVault,
    run: createNoteHere,
  },
  {
    id: 'note.save',
    title: '保存笔记',
    category: '笔记',
    keybinding: 'Mod+S',
    when: hasDocument,
    run: saveCurrentNote,
  },
  {
    id: 'note.reload',
    title: '从磁盘重新加载',
    category: '笔记',
    keybinding: 'Mod+Alt+L',
    when: hasDocument,
    run: reloadCurrentNote,
  },
  {
    id: 'note.delete',
    title: '删除到回收站',
    category: '笔记',
    when: hasSelection,
    run: () => deleteSelected(),
  },

  {
    id: 'view.cycleMode',
    title: '切换视图（编辑 / 分栏 / 预览）',
    category: '视图',
    keybinding: 'Mod+E',
    run: () => {
      useUiStore.getState().cycleViewMode()
    },
  },
  {
    id: 'view.toggleSidebar',
    title: '显示 / 隐藏侧栏',
    category: '视图',
    keybinding: 'Mod+B',
    run: () => {
      useUiStore.getState().toggleSidebar()
    },
  },

  {
    id: 'theme.next',
    title: '切换主题',
    category: '外观',
    keybinding: 'Mod+Alt+T',
    run: () => {
      useUiStore.getState().cycleTheme()
    },
  },
  {
    id: 'snippets.toggle',
    title: '启用 / 停用 CSS 片段',
    category: '外观',
    when: hasVault,
    run: toggleSnippets,
  },

  {
    id: 'tree.expandAll',
    title: '展开全部目录',
    category: '文件树',
    keybinding: 'Mod+Alt+E',
    when: hasVault,
    run: () => {
      useVaultStore.getState().expandAll()
    },
  },
  {
    id: 'tree.collapseAll',
    title: '折叠全部目录',
    category: '文件树',
    keybinding: 'Mod+Alt+W',
    when: hasVault,
    run: () => {
      useVaultStore.getState().collapseAll()
    },
  },
  {
    id: 'tree.focusFilter',
    title: '聚焦文件过滤框',
    category: '文件树',
    keybinding: 'Mod+Shift+F',
    when: hasVault,
    run: () => {
      requestFilterFocus()
    },
  },

  {
    id: 'help.about',
    title: '关于 Mimenote',
    category: '帮助',
    keybinding: 'Mod+Alt+A',
    run: showAbout,
  },
]

let disposer: Disposer | null = null

/** 注册内置命令（幂等）。返回卸载函数。 */
export function registerBuiltinCommands(): Disposer {
  if (disposer !== null) return disposer
  disposer = commands.registerAll(BUILTIN_COMMANDS)
  return disposer
}
