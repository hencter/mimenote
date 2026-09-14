/** 内置命令表（M1 的全部命令；M2 的命令面板直接渲染这张表）。 */

import { useGraphStore } from '@/state/graph-store'
import { useLinksStore } from '@/state/links-store'
import { useNoteStore } from '@/state/note-store'
import { useSettingsStore } from '@/state/settings-store'
import { useTabsStore } from '@/state/tabs-store'
import { useTagsStore } from '@/state/tags-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'
import { requestExportKind } from '@/features/export/export-events'
import { isMarkdown } from '@/domain/paths'
import {
  closeVault,
  createNoteHere,
  deleteSelected,
  moveSelected,
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

/** 标签数 ≥ 2：循环切换才有意义（命令面板里据此置灰）。 */
const hasMultipleTabs = (): boolean => useTabsStore.getState().tabs.length >= 2

/**
 * 当前主区域是不是知识图谱视图。
 *
 * 图谱的四条命令（缩放 / 适应窗口 / 关闭预览）都以此为条件：它们操作的是**画布**，
 * 其它视图里按这些键应该照旧（比如编辑器里敲 `+` 就是打出一个加号，
 * 不能因为命令表里有 `graph.zoomIn` 就被吃掉）。条件不成立时 `keymap.ts` 连
 * `preventDefault` 都不会做，按键原样留给当前视图。
 */
const isGraphView = (): boolean => useUiStore.getState().viewMode === 'graph'

/** 图谱命令未生效时的统一说明（面板里显示在置灰项旁边；怎么切过去由 `view.graph` 那条命令展示）。 */
const NEED_GRAPH_VIEW = '需要先切换到知识图谱视图'

/**
 * 文件树选中项能否改名 / 移动：**笔记与文件夹都可以**。
 *
 * 为什么要单独一条（而不是只认笔记）：目录搬迁已经交付，重命名与移动两条命令对文件夹同样
 * 有效 —— 条件写死成"必须是笔记"会让 F2 / F6 在文件夹上按不动，而用户看到的是一个
 * "明明选中了却毫无反应"的界面。
 */
function selectedMovableEntry(): string | null {
  const { selected, entries } = useVaultStore.getState()
  if (selected === null) return null
  const entry = entries.find((candidate) => candidate.relPath === selected)
  if (entry === undefined) return null
  if (entry.isDir) return selected
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

/**
 * 图谱命令的稳定 ID。
 *
 * 除了给命令面板与 README 用，画布还需要它们：`+` / `=` 这两个键**写不进命令表**
 * （`normalizeChord` 把 `+` 当分隔符，加号键本身无法成为快捷键串 —— 见 `graph.zoomIn` 的说明），
 * 只能由画布按键后按 ID 反查命令。因此这里同样不把命令字符串散落在组件里。
 */
export const GRAPH_COMMAND_IDS = {
  zoomIn: 'graph.zoomIn',
  zoomOut: 'graph.zoomOut',
  fit: 'graph.fit',
  closePreview: 'graph.closePreview',
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
    title: '重命名…',
    category: '笔记',
    keybinding: 'F2',
    // 笔记与文件夹都可以（`renameSelected` 按条目类型分派到 `note_rename` / `dir_rename`）
    when: () => selectedMovableEntry() !== null,
    unavailableReason: '需要先选中一篇笔记或一个文件夹',
    run: () => renameSelected(),
  },
  {
    // 拖拽的**键盘等价物**：纯拖拽对键盘用户不可用，所以"移动到文件夹"必须是一条命令
    // （`F6` 与 JetBrains 全家的 "Move" 一致，也避开了 F2 重命名）。
    // 拖拽与这条命令最终走的是同一个 `moveEntry`，行为与提示完全一致。
    id: 'note.move',
    title: '移动到文件夹…',
    category: '笔记',
    keybinding: 'F6',
    when: () => selectedMovableEntry() !== null,
    unavailableReason: '需要先选中一篇笔记或一个文件夹',
    run: () => moveSelected(),
  },

  // --- 标签页（多标签编辑）-------------------------------------------------
  {
    id: 'tabs.closeCurrent',
    title: '关闭当前标签',
    category: '标签页',
    keybinding: 'Mod+W',
    when: hasDocument,
    unavailableReason: '需要先打开一篇笔记',
    run: async () => {
      await useTabsStore.getState().closeCurrent()
    },
  },
  {
    id: 'tabs.next',
    title: '下一个标签',
    category: '标签页',
    keybinding: 'Mod+Alt+ArrowRight',
    when: hasMultipleTabs,
    unavailableReason: '需要至少打开两个标签',
    run: async () => {
      await useTabsStore.getState().cycle(1)
    },
  },
  {
    id: 'tabs.prev',
    title: '上一个标签',
    category: '标签页',
    keybinding: 'Mod+Alt+ArrowLeft',
    when: hasMultipleTabs,
    unavailableReason: '需要至少打开两个标签',
    run: async () => {
      await useTabsStore.getState().cycle(-1)
    },
  },
  // `Mod+1..9`：跳到第 N 个标签（与浏览器/编辑器一致的心智模型）。
  //
  // 为什么用生成而不是手写九条：九条的差别只有下标，手写既啰嗦又容易漏一格；
  // 而 `tabs-store` 早就提供了 `activateIndex`（原来没有任何调用方 —— 命令表才是
  // 快捷键的唯一事实来源，没接上就等于这个能力不存在）。
  //
  // 为什么 `when` 要求"至少这么多标签"：置灰而不是"按了没反应" —— 命令面板会因此
  // 显示"需要至少打开 N 个标签"，用户能立刻明白为什么按不动。
  ...Array.from({ length: 9 }, (_, index) => ({
    id: `tabs.activate${index + 1}`,
    title: `切换到第 ${index + 1} 个标签`,
    category: '标签页',
    keybinding: `Mod+${index + 1}`,
    when: () => useTabsStore.getState().tabs.length > index,
    unavailableReason: `需要至少打开 ${index + 1} 个标签`,
    run: async () => {
      await useTabsStore.getState().activateIndex(index)
    },
  })),

  // --- 导出 ---------------------------------------------------------------
  //
  // 两条命令**直接执行**：`export.html` 后面紧跟系统保存对话框，`export.pdf` 后面紧跟系统打印
  // 对话框 —— 再叠一层"你要哪种"只是多一次点击。想先看清两种产物的区别就走标题栏的「导出」按钮。
  // 两者都只**派发一次请求事件**：实现只有一份（`features/export/export-note.ts`）。
  {
    id: 'export.html',
    title: '导出为自包含 HTML…',
    category: '导出',
    keybinding: 'Mod+Shift+S',
    when: hasDocument,
    unavailableReason: '需要先打开一篇笔记',
    run: () => {
      requestExportKind('html')
    },
  },
  {
    id: 'export.pdf',
    title: '打印 / 另存为 PDF…',
    category: '导出',
    keybinding: 'Mod+Shift+P',
    when: hasDocument,
    unavailableReason: '需要先打开一篇笔记',
    run: () => {
      requestExportKind('print')
    },
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

  // ---------------------------------------------------------------------------
  // 知识图谱（`graph.*`）
  //
  // 这些按键原来只监听在画布元素上（焦点必须在画布或卡片上才生效）。挪到命令表的理由
  // 与面板命令一致：**命令表是快捷键的唯一事实来源**（`keymap.ts` 按 `commands.byChord`
  // 分发），画布那套监听于是被删掉，缩放/适应窗口/关预览只剩一份实现（store 的
  // `zoomIn` / `zoomOut` / `fitToWindow` / `closePreview`），不会出现两套逻辑漂移。
  //
  // 键位说明（真实键盘）：
  // - `Mod+-`：`Ctrl` + `-`（减号不需要 Shift），这是减号侧最顺手的组合；
  // - `Shift+_` / `Mod+Shift+_`：实际就是 `Shift`+`-` 与 `Ctrl`+`Shift`+`-`；
  // - `0` / `Mod+0`：适应窗口（与画布上的眼睛按钮同一条动作）；
  // - **加号侧只有 `Mod+=` 能写进表**：命令表的快捷键串用 `+` 当分隔符（`'Mod+='.split('+')`），
  //   所以 `+` 这个键本身无法被表示 —— 真实键盘上 `Ctrl`+`+` 的事件会被算成 `Mod+Shift++`，
  //   与任何归一化后的串都对不上。`+` / `=` 因此由画布自己按键后转交给 `graph.zoomIn`
  //   （见 `features/graph/GraphCanvas.tsx` 的 `GRAPH_COMMAND_IDS` 兜底分发），
  //   行为仍只有命令 → store 动作一份实现。
  // 面板/菜单只显示每条命令的**第一个**键位（见 `features/palette/match.ts`），
  // 因此把最常按的 `Mod+-` / `Mod+0` 放在数组最前面。
  // ---------------------------------------------------------------------------
  {
    id: GRAPH_COMMAND_IDS.zoomIn,
    title: '图谱：放大',
    category: '图谱',
    keybinding: 'Mod+=',
    when: isGraphView,
    unavailableReason: NEED_GRAPH_VIEW,
    run: () => {
      useGraphStore.getState().zoomIn()
    },
  },
  {
    id: GRAPH_COMMAND_IDS.zoomOut,
    title: '图谱：缩小',
    category: '图谱',
    keybinding: ['Mod+-', 'Mod+Shift+_', '-', 'Shift+_'],
    when: isGraphView,
    unavailableReason: NEED_GRAPH_VIEW,
    run: () => {
      useGraphStore.getState().zoomOut()
    },
  },
  {
    id: GRAPH_COMMAND_IDS.fit,
    title: '图谱：适应窗口（整块画布落进视口）',
    category: '图谱',
    keybinding: ['Mod+0', '0'],
    when: isGraphView,
    unavailableReason: NEED_GRAPH_VIEW,
    run: () => {
      useGraphStore.getState().fitToWindow()
    },
  },
  {
    id: GRAPH_COMMAND_IDS.closePreview,
    title: '图谱：关闭预览',
    category: '图谱',
    keybinding: 'Escape',
    when: isGraphView,
    unavailableReason: NEED_GRAPH_VIEW,
    run: () => {
      useGraphStore.getState().closePreview()
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
    // 与标签/链接面板一样是"视图开关"：没有笔记时也允许打开（面板自己显示空态）
    id: 'view.toggleOutlinePanel',
    title: '显示 / 隐藏大纲面板（当前笔记的标题树）',
    category: '视图',
    keybinding: 'Mod+Shift+O',
    run: () => {
      useUiStore.getState().toggleOutlinePanel()
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

/**
 * 注册内置命令（幂等）。返回卸载函数。
 *
 * 卸载后必须把模块级指针清空：否则"注册 → 卸载 → 再注册"会拿到**已经用过一次**的
 * 卸载函数，命令表里却一条命令都没有（生产只在 bootstrap 调一次，所以这个坑只在
 * 测试/热更新里露头 —— 但它会让后来者花半天怀疑是快捷键坏了）。
 */
export function registerBuiltinCommands(): Disposer {
  if (disposer !== null) return disposer
  const disposeRegistered = commands.registerAll(BUILTIN_COMMANDS)
  disposer = () => {
    disposeRegistered()
    disposer = null
  }
  return disposer
}
