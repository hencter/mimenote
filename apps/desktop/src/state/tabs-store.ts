/**
 * 多标签页状态（M3）。
 *
 * ## 为什么标签页**不**接管 note-store
 * `note-store` 是"当前文档"的唯一持有者，它同时管着三件高危逻辑：自动保存流水线
 * （防抖 + 单飞 + 待写标记）、冲突令牌（`baseMtimeMs`）与编辑器整篇替换的时机（`revision`）。
 * 把它改造成"多文档仓库"会同时动到这三处，收益却只是"少存一次路径"。
 * 所以这里**只**保存"已打开笔记的相对路径列表"；正文、未保存状态、冲突态仍然只有一份，
 * 在 `note-store` 里。"当前激活项"本质上就是 `note-store.doc.relPath`
 * （{@link TabsState.active} 是它的镜像，只由 {@link syncFromNote} 写，用来算
 * "相邻标签/下一个标签"并持久化 —— 见下面的"单一写入者"约定）。
 *
 * ## 为什么切换标签必须走 `app/actions.openNote`
 * `openNote` 里写着两条顺序约束：**切走前把未保存内容落盘**、切完把文件树的选中项同步过去。
 * 直接改 store 会绕过它们 —— 于是"切标签丢内容"与"树上的选中项和编辑器不一致"
 * 会立刻出现，而且难以复现。切标签本质上就是"打开另一篇笔记"，没有第二种打开方式。
 *
 * ## 为什么按 Vault 根持久化
 * 标签里存的是**相对 Vault 根的路径**。同一个 `notes/a.md` 在两个 Vault 里是两篇不同的文件，
 * 混在一起恢复就会张冠李戴。因此列表按根存（`{ [rootPath]: { tabs, active } }`），
 * 换 Vault 时内存里的列表必须清空（见 {@link handleVaultChange}）。
 *
 * ## 标签从哪里来
 * 任何入口（文件树、快速切换、wikilink、标签面板、命令面板…）打开笔记，最终都会落到
 * `note-store.doc`。因此这里**订阅 note-store**，看到新路径就把它补进列表 ——
 * 否则"点了 wikilink 却没有新标签"这种事就要求每个调用点都记得加一行。
 *
 * ## 单一写入者约定
 * 1. `tabs` 的增删：{@link syncFromNote}（补进新路径）、{@link closeTab}（用户关闭）、
 *    {@link pruneMissing}/{@link handleVaultChange}（条目表与 Vault 根的对账）；
 * 2. `active` 的写入：{@link syncFromNote}（跟着 `note-store.doc` 走）、{@link closeTab}、
 *    {@link handleVaultChange}（换 Vault 时清空）。
 *    `activate()` **不**自己写 `active` —— 它只是去打开笔记，让状态自己收敛。
 */

import { create } from 'zustand'

import { openNote } from '@/app/actions'
import type { Disposer } from '@/app/commands'
import type { EntryMeta } from '@/ipc/types'
import { useConfirmStore } from './confirm-store'
import { useNoteStore } from './note-store'
import { loadJson, saveJson } from './persist'
import { reconcileLayout } from '@/features/layout/layout-sync'
import { useUiStore } from './ui-store'
import { useVaultStore } from './vault-store'

/** 持久化键：`{ [vaultRoot]: { tabs, active } }`。 */
const STORAGE_KEY = 'mimenote.tabs.v1'

/**
 * 重新打开同一个 Vault 时，是否把"上次激活的标签"也重新打开。
 *
 * 打开（而不是只恢复列表）才符合"回到上次的工作现场"的预期：标签栏里有一个高亮项，
 * 编辑器里就是那篇笔记。若只想恢复列表（启动时不自动打开任何笔记），把它改成 `false` 即可 ——
 * 这是本功能唯一的观感开关。
 */
export const RESTORE_ACTIVE_TAB = true

interface PersistedTabs {
  tabs: string[]
  active: string | null
}

type PersistedMap = Record<string, PersistedTabs>

/**
 * 编辑器光标/滚动位置的记忆器。
 *
 * 为什么是"注入的适配器"而不是直接在这里 import CodeMirror：
 * `state/` 层不认识编辑器（也不该认识），实现放在 `features/tabs/caret-memory.ts`，
 * 由 `TabBar` 挂载时注册、卸载时注销（副作用可逆，见 architecture.md §2 第 6 条）。
 */
export interface CaretMemory {
  /** 记下某篇笔记当前的光标与滚动位置（在**切走之前**调用）。 */
  capture: (relPath: string) => void
  /** 恢复某篇笔记的光标与滚动位置（在新文档已经进编辑器之后调用）。 */
  restore: (relPath: string) => void
}

let caretMemory: CaretMemory | null = null

/** 注册/注销光标记忆器（`null` = 注销）。 */
export function setCaretMemory(memory: CaretMemory | null): void {
  caretMemory = memory
}

interface TabsState {
  /** 已打开的笔记（相对 Vault 根的 POSIX 路径，按打开顺序；最后一项 = 最近打开）。 */
  tabs: readonly string[]
  /** 当前激活标签（`note-store.doc.relPath` 的镜像；`null` = 编辑器里没有文档）。 */
  active: string | null
  /** 已经为哪个 Vault 根恢复过持久化列表（避免重复恢复、重复自动打开）。 */
  restoredRoot: string | null

  /** 切换到某个标签（已经在当前标签上则什么都不做）。 */
  activate: (relPath: string) => Promise<boolean>
  /** 跳到第 N 个标签（从 0 开始；`Ctrl+1..9` 用）。 */
  activateIndex: (index: number) => Promise<boolean>
  /** 循环切换（`step` 为 1/-1）。标签数 < 2 时不动。 */
  cycle: (step: 1 | -1) => Promise<boolean>
  /** 关闭某个标签：有未保存内容先二次确认；关的是当前标签则激活相邻项。 */
  closeTab: (relPath: string) => Promise<void>
  /** 关闭除它之外的标签（标签右键菜单）。 */
  closeOthers: (relPath: string) => Promise<void>
  /** 关闭全部标签（标签右键菜单）。 */
  closeAll: () => Promise<void>
  /** 关闭当前标签（`Mod+W`）。 */
  closeCurrent: () => Promise<void>
}

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------

function isPersistedTabs(value: unknown): value is PersistedTabs {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { tabs?: unknown; active?: unknown }
  if (!Array.isArray(candidate.tabs)) return false
  if (!candidate.tabs.every((item) => typeof item === 'string')) return false
  return candidate.active === null || typeof candidate.active === 'string'
}

function isPersistedMap(value: unknown): value is PersistedMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value as Record<string, unknown>).every(isPersistedTabs)
}

/** 读取某个 Vault 根的标签列表（没有就返回空）。 */
export function loadTabsFor(rootPath: string): PersistedTabs {
  const map = loadJson<PersistedMap>(STORAGE_KEY, {}, isPersistedMap)
  const saved = map[rootPath]
  if (saved === undefined) return { tabs: [], active: null }
  return { tabs: [...saved.tabs], active: saved.active }
}

/** 写入某个 Vault 根的标签列表（其它根的原样保留）。 */
export function persistTabsFor(
  rootPath: string,
  tabs: readonly string[],
  active: string | null,
): void {
  if (rootPath === '') return
  const map = loadJson<PersistedMap>(STORAGE_KEY, {}, isPersistedMap)
  saveJson(STORAGE_KEY, { ...map, [rootPath]: { tabs: [...tabs], active } } satisfies PersistedMap)
}

function currentRoot(): string {
  return useVaultStore.getState().info?.rootPath ?? ''
}

/** 更新内存状态并落盘（**唯一**同时改这两处的入口，避免写了内存忘了盘）。 */
function commit(tabs: readonly string[], active: string | null): void {
  useTabsStore.setState({ tabs, active })
  persistTabsFor(currentRoot(), tabs, active)
}

// ---------------------------------------------------------------------------
// 与 note-store / vault-store 的对账
// ---------------------------------------------------------------------------

/**
 * 把标签列表里落在某个目录子树里的路径整体换成新前缀（目录改名/移动时调用）。
 *
 * 为什么必须**先换标签、再换条目表**：条目表一变，`pruneMissing` 就会把旧路径的标签剪掉，
 * 而 `syncFromNote` 只会把"当前文档"补回列表末尾 —— 结果是**标签顺序被打乱**
 * （原来在第 1 个的标签跑到最后一个）。这里提前把列表换好，剪枝与补入就都成了空操作。
 *
 * 与 `note-store` 的文档路径无关：那一半由 `app/actions` 的目录搬迁流程自己收敛
 *（它知道被改写的是哪几篇，也知道当前文档在不在子树里）。
 */
function relocateTabs(oldRel: string, newRel: string): void {
  const { tabs, active } = useTabsStore.getState()
  const remap = (relPath: string): string =>
    relPath === oldRel
      ? newRel
      : relPath.startsWith(`${oldRel}/`)
        ? `${newRel}${relPath.slice(oldRel.length)}`
        : relPath
  const next = tabs.map(remap)
  if (next.every((relPath, index) => relPath === tabs[index])) return
  commit(next, active === null ? null : remap(active))
}

/**
 * 换 Vault 期间为真。
 *
 * `handleVaultChange` 里会调用 `note-store.close()`（上一篇笔记属于旧根），而 close 会**同步**
 * 触发 note 订阅；若不挡住，`syncFromNote` 会把**旧根**的标签列表按"当前根"（此刻已经是新根）
 * 写进 localStorage —— 正是"张冠李戴"的那个 bug。换 Vault 的对账由 `handleVaultChange`
 * 自己一口气做完，中间不让别的路径插手。
 */
let switchingVault = false

/** 新路径进入编辑器 → 补进标签列表（已经在列表里的只更新激活项，不改变顺序）。 */
function syncFromNote(relPath: string | null, prevRelPath: string | null): void {
  if (switchingVault) return
  if (relPath === prevRelPath) return
  const { tabs } = useTabsStore.getState()

  if (relPath === null) {
    // 文档被关掉但标签未必该关（删除/改名都会走到这里）：只清激活项，
    // 列表由条目表对账（`pruneMissing`）负责 —— 两条职责不重叠
    if (useTabsStore.getState().active !== null) commit(tabs, null)
    return
  }
  commit(tabs.includes(relPath) ? tabs : [...tabs, relPath], relPath)
}

/** 条目表变化（删除、改名、重扫）→ 剪掉已经不存在的标签，避免点开就是一个 NOT_FOUND。 */
function pruneMissing(entries: readonly EntryMeta[]): void {
  const { tabs, active } = useTabsStore.getState()
  const existing = new Set(entries.map((entry) => entry.relPath))
  const next = tabs.filter((relPath) => existing.has(relPath))
  if (next.length === tabs.length) return
  // 被剪掉的可能正是当前文档（例如它被删了）：激活项跟着失效，但不在这里删文档 ——
  // "删掉的那篇是否要退出编辑器"由调用方（deleteSelected）决定
  commit(next, active !== null && next.includes(active) ? active : null)
}

/**
 * Vault 根变化（打开另一个 Vault / 关闭 Vault）：清空并按新根恢复。
 *
 * 换 Vault 必须清空：标签里存的是相对路径，旧根的 `笔记/甲.md` 在新根里是**另一篇**文件。
 */
function handleVaultChange(rootPath: string | null, entries: readonly EntryMeta[]): void {
  // 期间挡住 note 订阅（见 `switchingVault` 的说明），整段做完再放行
  switchingVault = true
  try {
    const note = useNoteStore.getState()
    if (note.doc !== null) {
      // 上一篇笔记的路径是相对旧根的：把它留在编辑器里，下一次自动保存就会写进新 Vault 的同名路径。
      // 关掉它（取消防抖保存 + 清掉内存改动），比留着一个"属于另一个 Vault"的文档安全。
      note.close()
    }

    if (rootPath === null || rootPath === '') {
      useTabsStore.setState({ tabs: [], active: null, restoredRoot: null })
      return
    }

    const existing = new Set(entries.map((entry) => entry.relPath))
    const saved = loadTabsFor(rootPath)
    const tabs = saved.tabs.filter((relPath) => existing.has(relPath))
    const active = saved.active !== null && tabs.includes(saved.active) ? saved.active : null

    // 把剪掉失效路径之后的列表写回去：磁盘上不该长期留着"已经不存在的标签"
    persistTabsFor(rootPath, tabs, active)
    useTabsStore.setState({ tabs, active: null, restoredRoot: rootPath })

    if (!RESTORE_ACTIVE_TAB || active === null) return
    // 等一拍再打开：① 让 openVault 的 set 链先跑完（此刻还在它的订阅回调里）；
    // ② 若这一拍里用户（或测试）已经打开了别的笔记，就不去抢当前文档。
    const scheduledRoot = rootPath
    setTimeout(() => {
      // 这一拍里换了 Vault：刚才那份列表已经不属于当前根，不能再打开它
      if (currentRoot() !== scheduledRoot) return
      const current = useNoteStore.getState()
      if (current.doc !== null || current.status === 'loading') return
      void openNote(active)
    }, 0)
  } finally {
    switchingVault = false
  }
}

/**
 * 安装标签页与其它 store 的对账（订阅 note-store / vault-store）。
 *
 * 由 `TabBar` 挂载时调用、卸载时 dispose（副作用可逆）。挂载那一刻会**先对一次账**：
 * `TabBar` 是在 `openVault` 之后才挂载的，只订阅"变化"会永远看不到那次打开 Vault。
 */
export function installTabsSync(): Disposer {
  /*
   * **布局树随标签对账**（ADR-0035 的接线）：树管"谁在哪"，`tabs-store` 管"谁存在"。
   * 对账是幂等的（没变化返回原引用 ⇒ `setLayout` 直接返回，不写盘），所以挂在这里每帧调也安全。
   * 安装点选在这里而不是 `ui-store`：那边不该反向依赖业务 store（同一份数据两个方向订阅会成环）。
   */
  const syncLayout = (): void => {
    const ui = useUiStore.getState()
    ui.setLayout(reconcileLayout(ui.layout, { notes: useTabsStore.getState().tabs }))
  }
  syncLayout()
  const disposeLayout = useTabsStore.subscribe(syncLayout)
  const vault = useVaultStore.getState()
  const root = vault.info?.rootPath ?? null
  if (useTabsStore.getState().restoredRoot !== root) {
    handleVaultChange(root, vault.entries)
  }
  // 兜底：挂载时编辑器里已经有文档（列表里没有就补上）
  syncFromNote(useNoteStore.getState().doc?.relPath ?? null, null)

  const disposeVault = useVaultStore.subscribe((state, prev) => {
    const nextRoot = state.info?.rootPath ?? null
    const prevRoot = prev.info?.rootPath ?? null
    if (nextRoot !== prevRoot) {
      handleVaultChange(nextRoot, state.entries)
      return
    }
    if (state.entries !== prev.entries) pruneMissing(state.entries)
  })

  const disposeNote = useNoteStore.subscribe((state, prev) => {
    syncFromNote(state.doc?.relPath ?? null, prev.doc?.relPath ?? null)
  })

  return () => {
    disposeLayout()

    disposeVault()
    disposeNote()
  }
}

/**
 * 目录搬迁前把标签列表整棵子树换到新前缀（**必须在条目表变化之前调用**）。
 *
 * 见 [`relocateTabs`] 的说明：顺序反了标签顺序就会被剪枝打乱。
 * 由 `app/actions` 的 `relocateDirectory` 调用 —— 标签 store 不自己去订阅目录搬迁事件，
 * 因为"哪个目录搬到了哪里"只有那一次调用的上下文知道。
 */
export function relocateTabsForDirectory(oldRel: string, newRel: string): void {
  relocateTabs(oldRel, newRel)
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

export const useTabsStore = create<TabsState>((_set, get) => ({
  tabs: [],
  active: null,
  restoredRoot: null,

  activate: async (relPath) => {
    const note = useNoteStore.getState()
    if (note.doc?.relPath === relPath) return true // 已经是当前标签：不用重新读盘
    if (note.doc !== null) caretMemory?.capture(note.doc.relPath)
    const ok = await openNote(relPath)
    // 此时编辑器的文档替换可能还没跑（React 的 effect 在这之后），
    // 所以由 caretMemory 自己决定"什么时候恢复"（它用 rAF 等一帧）
    if (ok) caretMemory?.restore(relPath)
    return ok
  },

  activateIndex: async (index) => {
    const target = get().tabs[index]
    if (target === undefined) return false
    return get().activate(target)
  },

  cycle: async (step) => {
    const { tabs } = get()
    if (tabs.length < 2) return false
    const current = useNoteStore.getState().doc?.relPath ?? null
    const index = current === null ? -1 : tabs.indexOf(current)
    // 没有当前文档（理论上不该发生）时：往下从第一个开始，往上从最后一个开始
    if (index === -1) {
      const fallback = step > 0 ? tabs[0] : tabs[tabs.length - 1]
      return fallback === undefined ? false : get().activate(fallback)
    }
    const size = tabs.length
    const nextIndex = (((index + step) % size) + size) % size
    const target = tabs[nextIndex]
    return target === undefined ? false : get().activate(target)
  },

  closeTab: async (relPath) => {
    const { tabs } = get()
    const index = tabs.indexOf(relPath)

    const note = useNoteStore.getState()
    const isActive = note.doc?.relPath === relPath
    // 既不在列表里、又不是当前文档 → 没什么可关的。
    // （"不在列表里但正是当前文档"仍然允许关闭：列表可能被条目表剪过，
    //   这种时候不该让 `Mod+W` 变成按下去毫无反应。）
    if (index === -1 && !isActive) return

    // 未保存内容只在**当前文档**上可能（note-store 只持有一份），因此这里只对
    // 关闭当前标签的情况要确认 —— 与 `deleteSelected` 的写法一致（confirm-store）。
    if (isActive && note.dirty) {
      const confirmed = await useConfirmStore.getState().ask({
        title: '关闭这个标签？',
        message: `「${relPath}」有未保存的修改，关闭后这些修改会丢失。想保留请先按 Ctrl+S 保存。`,
        confirmLabel: '关闭并丢弃修改',
        danger: true,
      })
      if (!confirmed) return
    }

    // 相邻标签：优先右边，没有右边就用左边（数组下标以**关闭前**的列表为准）
    const neighbor =
      index === -1 ? undefined : (tabs[index + 1] ?? (index > 0 ? tabs[index - 1] : undefined))
    const rest = tabs.filter((path) => path !== relPath)
    const nextActive = isActive ? null : get().active

    if (isActive) {
      // 关掉之前记一下光标位置：重新打开这篇时还能回到原处（标签关了，笔记本身没变）
      caretMemory?.capture(relPath)
      // 先关掉 note-store 的当前文档：`close()` 会取消待执行的自动保存，
      // 于是随后 `activate(相邻标签)` 里的 `openNote` 不会把"用户刚刚确认要丢弃"的内容写回磁盘
      // （note-store.open 的语义是"切走前先落盘"，这里必须让它的 `doc` 已经是空）。
      useNoteStore.getState().close()
    }
    commit(rest, nextActive)

    if (!isActive) return
    if (neighbor === undefined) return // 没有相邻项 = 全部标签关完了，已经回到空态
    await get().activate(neighbor)
  },

  closeCurrent: async () => {
    const relPath = useNoteStore.getState().doc?.relPath ?? get().active
    if (relPath === null) return
    await get().closeTab(relPath)
  },

  /**
   * 关闭除 `relPath` 之外的标签（标签右键菜单的「关闭其他」）。
   *
   * 逐个走 `closeTab`，不做"一次性 commit 剩下的那些"：未保存确认、光标位置记忆、
   * 关掉当前标签之后接续哪一个 —— 全都在那一条路径里。代价是 N 次状态写入，
   * 而 N 是标签数（几十），可以忽略；换来的是"三条关闭路径的行为完全一致"。
   */
  closeOthers: async (relPath) => {
    for (const path of [...get().tabs]) {
      if (path === relPath) continue
      await get().closeTab(path)
    }
    // 保留下来的那个如果不是当前文档（它本来就不是活动标签时），把它切回来 ——
    // 用户右键的是"这一个"，关完其他之后理应看到它
    if (useNoteStore.getState().doc?.relPath !== relPath) await get().activate(relPath)
  },

  /** 关闭全部标签（右键菜单的「关闭全部」）。同样逐个走 `closeTab`（理由见上）。 */
  closeAll: async () => {
    for (const path of [...get().tabs]) await get().closeTab(path)
  },
}))
