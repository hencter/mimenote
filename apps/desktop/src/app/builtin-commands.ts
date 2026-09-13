/** 内置命令表（M1 的全部命令；M2 的命令面板直接渲染这张表）。 */

import { useLinksStore } from '@/state/links-store'
import { useNoteStore } from '@/state/note-store'
import { useSettingsStore } from '@/state/settings-store'
import { useTagsStore } from '@/state/tags-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'
import { isMarkdown } from '@/domain/paths'
import {
  closeVault,
  createNoteHere,
  deleteSelected,
  openVaultInteractive,
  reloadCurrentNote,
  renameSelected,
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

/** 文件树选中项若是 Markdown 笔记则返回它（重命名只支持笔记，目录推迟到 M3）。 */
function selectedMarkdownNote(): string | null {
  const { selected, entries } = useVaultStore.getState()
  if (selected === null) return null
  const entry = entries.find((candidate) => candidate.relPath === selected)
  if (entry === undefined || entry.isDir) return null
  return isMarkdown(selected) ? selected : null
}

/**
 * 面板相关命令的稳定 ID。
 *
 * 面板的**全局按键**（`features/palette/use-palette-hotkeys.ts`）不写死快捷键字符串，
 * 而是拿 `commands.byChord()` 反查这几个 ID：命令表始终是快捷键的唯一事实来源，
 * 将来做按键重映射时不会出现"面板监听还认识旧键"的半截状态。
 */
export const PALETTE_COMMAND_IDS = {
  open: 'palette.open',
  quickSwitch: 'palette.quickSwitch',
  search: 'search.open',
} as const

export const BUILTIN_COMMANDS: readonly Command[] = [
  {
    id: PALETTE_COMMAND_IDS.open,
    title: '命令面板…',
    category: '通用',
    keybinding: 'Mod+K',
    run: () => {
      useUiStore.getState().openPalette('commands')
    },
  },
  {
    id: PALETTE_COMMAND_IDS.quickSwitch,
    title: '快速切换笔记…',
    category: '通用',
    keybinding: 'Mod+P',
    // 刻意**不设 when**：未打开 Vault 时也要能打开面板（显示"还没有打开 Vault"空态），
    // 否则 Ctrl+P 在门闸页上毫无反应，用户无从知道原因。
    run: () => {
      useUiStore.getState().openPalette('quickSwitch')
    },
  },
  {
    id: PALETTE_COMMAND_IDS.search,
    title: '全文搜索…',
    category: '通用',
    // 与快速切换同理：不设 when —— 未打开 Vault 时打开面板，给出"还没有打开 Vault"空态，
    // 总好过 Ctrl+Shift+F 在门闸页上毫无反应。
    keybinding: 'Mod+Shift+F',
    run: () => {
      useUiStore.getState().openPalette('search')
    },
  },

  {
    id: 'settings.open',
    title: '打开设置…',
    category: '通用',
    // 与另外几条面板命令一致：刻意不设 when —— 没打开 Vault 时也要能改主题/字号
    keybinding: 'Mod+,',
    run: () => {
      useSettingsStore.getState().openSettings()
    },
  },

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
    unavailableReason: '需要先打开 Vault',
    run: rescanVault,
  },
  {
    id: 'vault.close',
    title: '关闭 Vault',
    category: 'Vault',
    when: hasVault,
    unavailableReason: '需要先打开 Vault',
    run: closeVault,
  },

  {
    id: 'note.new',
    title: '新建笔记',
    category: '笔记',
    keybinding: 'Mod+N',
    when: hasVault,
    unavailableReason: '需要先打开 Vault',
    run: createNoteHere,
  },
  {
    id: 'note.save',
    title: '保存笔记',
    category: '笔记',
    keybinding: 'Mod+S',
    when: hasDocument,
    unavailableReason: '需要先打开一篇笔记',
    run: saveCurrentNote,
  },
  {
    id: 'note.reload',
    title: '从磁盘重新加载',
    category: '笔记',
    keybinding: 'Mod+Alt+L',
    when: hasDocument,
    unavailableReason: '需要先打开一篇笔记',
    run: reloadCurrentNote,
  },
  {
    id: 'note.delete',
    title: '删除到回收站',
    category: '笔记',
    when: hasSelection,
    unavailableReason: '需要先在文件树里选中条目',
    run: () => deleteSelected(),
  },
  {
    id: 'note.rename',
    title: '重命名笔记…',
    category: '笔记',
    keybinding: 'F2',
    // 只对"文件树里选中的 Markdown 笔记"生效：目录重命名推迟到 M3（与拖拽整理一起做）
    when: () => selectedMarkdownNote() !== null,
    unavailableReason: '需要先选中一篇 Markdown 笔记',
    run: () => renameSelected(),
  },

  {
    id: 'view.cycleMode',
    title: '切换视图（编辑 / 阅读 / 图谱）',
    category: '视图',
    keybinding: 'Mod+E',
    run: () => {
      useUiStore.getState().cycleViewMode()
    },
  },
  {
    id: 'view.mode.edit',
    title: '视图：所见即所得编辑',
    category: '视图',
    run: () => {
      useUiStore.getState().setViewMode('edit')
    },
  },
  {
    id: 'view.mode.read',
    title: '视图：阅读（渲染后）',
    category: '视图',
    run: () => {
      useUiStore.getState().setViewMode('read')
    },
  },
  {
    id: 'view.graph',
    title: '视图：知识图谱',
    category: '视图',
    keybinding: 'Mod+G',
    run: () => {
      useUiStore.getState().setViewMode('graph')
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
    id: 'view.toggleTagsPanel',
    title: '显示 / 隐藏标签面板（标签与 Frontmatter）',
    category: '视图',
    keybinding: 'Mod+Shift+T',
    run: () => {
      useTagsStore.getState().toggle()
    },
  },

  {
    id: 'view.toggleLinksPanel',
    title: '显示 / 隐藏链接面板（反向链接）',
    category: '视图',
    keybinding: 'Mod+Shift+L',
    run: () => {
      useUiStore.getState().toggleLinksPanel()
    },
  },
  {
    id: 'note.refreshLinks',
    title: '刷新当前笔记的链接',
    category: '笔记',
    when: hasDocument,
    unavailableReason: '需要先打开一篇笔记',
    run: () => {
      const relPath = useNoteStore.getState().doc?.relPath ?? null
      void useLinksStore.getState().refresh(relPath)
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
    unavailableReason: '需要先打开 Vault',
    run: toggleSnippets,
  },

  {
    id: 'tree.expandAll',
    title: '展开全部目录',
    category: '文件树',
    keybinding: 'Mod+Alt+E',
    when: hasVault,
    unavailableReason: '需要先打开 Vault',
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
    unavailableReason: '需要先打开 Vault',
    run: () => {
      useVaultStore.getState().collapseAll()
    },
  },
  {
    id: 'tree.focusFilter',
    title: '聚焦文件过滤框',
    category: '文件树',
    // 原来是 `Mod+Shift+F`：全文搜索（`search.open`）要用它 —— 一个是"聚焦侧栏输入框"，
    // 一个是"搜索正文"，后者更值得占用更顺手的组合键，于是过滤框挪到 `Mod+Shift+E`。
    keybinding: 'Mod+Shift+E',
    when: hasVault,
    unavailableReason: '需要先打开 Vault',
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
