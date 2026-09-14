/**
 * Vault 状态：条目表、树、展开/选中、过滤。
 *
 * 性能要点（architecture.md §3.2）：打开 Vault **只扫描一次**，
 * 之后新建/删除只做增量更新 —— 10k 笔记下不存在"每次操作重扫目录"的开销。
 */

import { create } from 'zustand'

import {
  buildTree,
  collectDirectoryPaths,
  ancestorsOf,
  makeEntryComparator,
  type EntryComparator,
  type TreeNode,
} from '@/domain/tree'
import { extensionOf, parentOf } from '@/domain/paths'
import { ipc } from '@/ipc/client'
import { MimenoteError, describeError } from '@/ipc/types'
import type { EntryMeta, NoteContent, RenameOutcome, TrashRecord, VaultInfo, VaultSnapshot } from '@/ipc/types'
import { useNoteStore } from './note-store'
import { loadJson, loadString, saveJson, saveString } from './persist'
import { toast } from './toast-store'
import { useUiStore } from './ui-store'

const LAST_VAULT_KEY = 'mimenote.vault.last'
const EXPANDED_KEY = 'mimenote.vault.expanded.v1'
/** 最近打开的 Vault 列表（`removeRecentVault` 的测试与组件都需要这个键名）。 */
export const RECENT_VAULTS_KEY = 'mimenote.vault.recent.v1'
/** 最近列表的上限：再多就从"快速切换"退化成"又一个要管理的列表"。 */
export const RECENT_VAULTS_MAX = 8

/** 宿主推送"Vault 被外部改动"的事件名（与 `src-tauri/src/watcher.rs` 保持一致）。 */
export const VAULT_CHANGED_EVENT = 'mn://vault-changed'

/**
 * 宿主推来的外部改动（`watcher.rs` 的 `VaultChanged` 手工镜像，字段名不可偏离）。
 *
 * `paths` 只用于日志与排障：**判断"当前笔记要不要重载"用的是重扫回来的 mtime**，
 * 而不是这张表 —— 路径超过上限时会被截断，而 mtime 比对在任何规模下都成立。
 */
export interface VaultChanged {
  /** 这次合并里被判为外部改动的相对路径（字典序，最多 256 条）。 */
  paths: string[]
  /** 是否有路径因为上限被截掉。 */
  truncated: boolean
  /** 去抖窗口里一共收到多少条事件路径（含重复）。 */
  changes: number
  /** 宿主判定时刻（毫秒时间戳）。 */
  detectedAtMs: number
}

export type VaultStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 最近打开的 Vault 的一条记录。 */
export interface RecentVaultEntry {
  rootPath: string
  /** 显示名（目录 basename，与 `VaultInfo.name` 同一来源）。 */
  name: string
  /** 最近一次成功打开的时刻（毫秒时间戳；排序本身靠数组顺序，它只是展示/排障用）。 */
  openedAtMs: number
}

interface VaultState {
  status: VaultStatus
  info: VaultInfo | null
  entries: EntryMeta[]
  tree: TreeNode[]
  expanded: ReadonlySet<string>
  selected: string | null
  filter: string
  error: MimenoteError | null
  /** 上次成功打开的 Vault 根（启动时尝试恢复）。 */
  lastRoot: string | null
  /**
   * 最近打开的 Vault（最新在前，按 `rootPath` 去重，最多 {@link RECENT_VAULTS_MAX} 条）。
   *
   * `closeVault` **不**清它 —— 这个列表就是为"切走再切回来"准备的；
   * 条目失效（目录已不在）时 `openVault` 自己会失败并弹提示，不在读取时做存活性检查
   * （每个条目一次 IPC，代价与收益不成比例）。
   */
  recentVaults: RecentVaultEntry[]

  openVault: (path: string) => Promise<boolean>
  restoreLastVault: () => Promise<void>
  rescan: () => Promise<void>
  /** 从最近列表移除一条（用户显式点 ×；不影响 `lastRoot`，也不碰磁盘）。 */
  removeRecentVault: (rootPath: string) => void
  /**
   * 用当前的排序偏好重建树（排序变化时由 ui-store 的订阅触发，见文件末尾）。
   *
   * 为什么不是"就地重排现有树"：`sortTree` 是**就地**排序，直接调会污染
   * store 里的树对象（引用不变，React 察觉不到）；从 `entries` 重建反而更便宜、
   * 也不会有半个树排过、半个没排的中间态。
   */
  resortTree: () => void
  /**
   * 宿主报告"Vault 在应用之外被改动了"（ADR-0016）：静默重扫条目表 → 让当前笔记跟随磁盘。
   *
   * 为什么不复用 `rescan`：那是用户按 `Ctrl+Alt+R` 的路径，会弹"已重扫 N 条目"的成功提示；
   * 而外部改动是**背景事件**（同步盘可能每分钟都在落文件），每次都弹提示等于噪音。
   */
  applyExternalChange: (payload: VaultChanged) => Promise<void>
  /**
   * 从回收站恢复之后对齐条目表与文件树（静默；见实现处的文档）。
   */
  syncAfterRestore: () => Promise<void>
  closeVault: () => Promise<void>

  toggleExpanded: (relPath: string) => void
  setExpanded: (relPath: string, value: boolean) => void
  expandAll: () => void
  collapseAll: () => void
  revealPath: (relPath: string) => void

  select: (relPath: string | null) => void
  setFilter: (filter: string) => void

  registerCreatedNote: (note: NoteContent) => void
  registerDeletedEntry: (record: TrashRecord) => void
  /** 重命名成功后就地替换条目（不重扫；改名不改变条目数量）。 */
  registerRenamedNote: (outcome: RenameOutcome) => void
  /**
   * **目录搬迁**成功后就地替换整棵子树的条目（不重扫）。
   *
   * 为什么不能用 `registerRenamedNote`：那个函数只换**一条**（单篇改名/移动），而目录搬迁
   * 会让子树里每一篇的路径都变 —— 只换目录那一条，前端文件树会空一片（磁盘上它们好好的）。
   * 展开状态也要跟着换前缀，否则搬迁后原来展开的目录全被折叠（`expanded` 里存的是旧路径）。
   */
  registerRelocatedDirectory: (outcome: RenameOutcome) => void
  /**
   * 附件落盘后就地插入条目（粘贴/拖入图片，见 ADR-0013）。
   *
   * 为什么不做一次 `rescan`：条目表是"打开 Vault 时扫一次"的快照，重扫在 1 万笔记下是
   * 800ms 级别的开销，而"刚写了一个文件"这条信息**已经在返回值里**了（见 architecture.md §3.2）。
   * 附件目录不存在时磁盘上刚被创建，因此祖先目录条目要一并补上（否则树会把它当根节点）。
   */
  registerAttachment: (file: { relPath: string; sizeBytes: number }) => void
}

/** 从快照派生概要信息。 */
export function infoFromSnapshot(snapshot: VaultSnapshot): VaultInfo {
  return {
    rootPath: snapshot.rootPath,
    name: snapshot.name,
    entryCount: snapshot.entries.length,
    noteCount: snapshot.noteCount,
    folderCount: snapshot.folderCount,
    truncated: snapshot.truncated,
    skipped: snapshot.skipped,
    scanMs: snapshot.scanMs,
  }
}

type ExpandedMap = Record<string, string[]>

/**
 * 当前排序偏好的比较器。
 *
 * 排序判据在 `domain/tree.ts`（唯一真源），偏好存在 `ui-store`；数据层在**每次建树时**
 * 现取 —— 建树总是从这里拿同一份口径，就不会出现"打开时按名称、重扫后按修改时间"。
 */
function treeComparator(): EntryComparator {
  return makeEntryComparator(useUiStore.getState().treeSort)
}

/** 校验持久化回来的最近列表；任何一条形状不对就整份当空表（坏数据不该半恢复）。 */
function isRecentVaults(value: unknown): value is RecentVaultEntry[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>)['rootPath'] === 'string' &&
        (item as Record<string, unknown>)['rootPath'] !== '' &&
        typeof (item as Record<string, unknown>)['name'] === 'string' &&
        typeof (item as Record<string, unknown>)['openedAtMs'] === 'number',
    )
  )
}

function loadRecentVaults(): RecentVaultEntry[] {
  return loadJson<RecentVaultEntry[]>(RECENT_VAULTS_KEY, [], isRecentVaults)
}

/**
 * 记录一次成功打开：按 `rootPath` 去重、最新在前、截到上限。
 *
 * 去重键是**完整根路径**而不是显示名 —— 两台同名目录（`D:\笔记` 与 `E:\笔记`）
 * 是两个 Vault，不能因为名字一样互相顶掉。
 */
function recordRecentVault(list: readonly RecentVaultEntry[], rootPath: string, name: string): RecentVaultEntry[] {
  const next = [
    { rootPath, name, openedAtMs: Date.now() },
    ...list.filter((item) => item.rootPath !== rootPath),
  ].slice(0, RECENT_VAULTS_MAX)
  saveJson(RECENT_VAULTS_KEY, next)
  return next
}

function restoreExpanded(rootPath: string, entries: readonly EntryMeta[]): Set<string> {
  const map = loadJson<ExpandedMap>(EXPANDED_KEY, {})
  const saved = map[rootPath]
  if (Array.isArray(saved)) {
    // 只保留仍然存在的目录，避免陈旧数据越积越多
    const existing = new Set(entries.filter((entry) => entry.isDir).map((entry) => entry.relPath))
    return new Set(saved.filter((rel) => existing.has(rel)))
  }
  // 首次打开：只展开顶层目录，避免一上来就挂载上万行（虚拟化仍会兜底）
  return new Set(
    entries.filter((entry) => entry.isDir && !entry.relPath.includes('/')).map((entry) => entry.relPath),
  )
}

function persistExpanded(rootPath: string, expanded: ReadonlySet<string>): void {
  const map = loadJson<ExpandedMap>(EXPANDED_KEY, {})
  saveJson(EXPANDED_KEY, { ...map, [rootPath]: [...expanded] })
}

export const useVaultStore = create<VaultState>((set, get) => ({
  status: 'idle',
  info: null,
  entries: [],
  tree: [],
  expanded: new Set<string>(),
  selected: null,
  filter: '',
  error: null,
  lastRoot: loadString(LAST_VAULT_KEY),
  recentVaults: loadRecentVaults(),

  openVault: async (path) => {
    set({ status: 'loading', error: null })
    try {
      const snapshot = await ipc.vaultOpen(path)
      const tree = buildTree(snapshot.entries, treeComparator())
      const expanded = restoreExpanded(snapshot.rootPath, snapshot.entries)
      saveString(LAST_VAULT_KEY, snapshot.rootPath)

      set({
        status: 'ready',
        info: infoFromSnapshot(snapshot),
        entries: snapshot.entries,
        tree,
        expanded,
        selected: null,
        filter: '',
        error: null,
        lastRoot: snapshot.rootPath,
        recentVaults: recordRecentVault(get().recentVaults, snapshot.rootPath, snapshot.name),
      })

      if (snapshot.truncated) {
        toast.warn(
          `Vault 条目数超过上限，仅显示前 ${snapshot.entries.length} 条`,
          '可在 mn-core 的 ScanOptions 中调整 max_entries',
        )
      }
      if (snapshot.skipped > 0) {
        toast.warn(`${snapshot.skipped} 个条目被跳过（权限或符号链接）`)
      }
      console.info(
        `[vault] 已打开 ${snapshot.rootPath}：${snapshot.entries.length} 条目，扫描 ${snapshot.scanMs}ms`,
      )
      return true
    } catch (cause) {
      const error = MimenoteError.from(cause)
      set({ status: 'error', error, info: null, entries: [], tree: [] })
      toast.error(describeError(error, '打开 Vault 失败'))
      return false
    }
  },

  restoreLastVault: async () => {
    // 1. 命令行参数优先：`mimenote.exe <vault 目录>`（快捷方式/"打开方式"/E2E）
    try {
      const fromArgs = await ipc.startupVault()
      if (fromArgs !== null && fromArgs !== '') {
        const opened = await get().openVault(fromArgs)
        if (opened) return
        toast.warn('命令行指定的 Vault 打不开', `${fromArgs}（回退到上次打开的 Vault）`)
      }
    } catch {
      // 命令不存在（旧版本宿主/测试替身）时静默跳过，不影响启动
    }

    // 2. 上次打开的 Vault
    const root = get().lastRoot
    if (root === null || root === '') return
    const ok = await get().openVault(root)
    if (!ok && get().error?.code === 'NOT_FOUND') {
      // 上次的 Vault 已不在原位置：静默回到选择界面
      saveString(LAST_VAULT_KEY, '')
      set({ status: 'idle', error: null, lastRoot: null })
    }
  },

  rescan: async () => {
    if (get().info === null) return
    const started = nowMs()
    try {
      const snapshot = await ipc.vaultSnapshot()
      set(snapshotPatch(snapshot, get().selected))
      toast.success(
        `已重扫：${snapshot.entries.length} 条目`,
        `耗时 ${snapshot.scanMs}ms（含扫描与构建树 ${Math.round(nowMs() - started)}ms）`,
      )
    } catch (cause) {
      const error = MimenoteError.from(cause)
      set({ error })
      toast.error(describeError(error, '重扫失败'))
    }
  },

  removeRecentVault: (rootPath) => {
    const next = get().recentVaults.filter((item) => item.rootPath !== rootPath)
    if (next.length === get().recentVaults.length) return
    saveJson(RECENT_VAULTS_KEY, next)
    set({ recentVaults: next })
  },

  resortTree: () => {
    // 没打开 Vault 时没有树可排（entries 为空时 buildTree 也会返回空树，但连状态都不必换）
    if (get().entries.length === 0) return
    set({ tree: buildTree(get().entries, treeComparator()) })
  },

  applyExternalChange: async (payload) => {
    const info = get().info
    if (info === null) return
    // 打开/重扫正在进行时不掺和：那两次会把条目表整体换掉，这里再叠一次只会打架
    if (get().status === 'loading') return

    const seq = ++externalSeq
    const started = nowMs()
    try {
      // 走宿主既有的重扫命令：条目表刷新 + **后台**重建索引（可取消，不阻塞 UI）
      const snapshot = await ipc.vaultSnapshot()
      if (seq !== externalSeq) return // 已被更新的一轮取代
      set(snapshotPatch(snapshot, get().selected))
      console.info(
        `[vault] 外部改动：${payload.changes} 条事件路径${
          payload.truncated ? '（路径表已截断）' : ''
        } → 重扫 ${snapshot.entries.length} 条目（扫描 ${snapshot.scanMs}ms，端到端 ${Math.round(
          nowMs() - started,
        )}ms）`,
      )
      await followDiskForOpenNote(snapshot.entries)
    } catch (cause) {
      // 外部改动触发的重扫失败（最常见：Vault 目录被搬走/删掉）。不打断编辑，
      // 但也不能装作没发生 —— 给一条提示，用户至少知道"界面现在可能不是磁盘的样子"
      const error = MimenoteError.from(cause)
      console.warn('[vault] 外部改动后重扫失败：', error)
      toast.warn('外部改动后重扫失败', describeError(error, 'Vault 可能已被移动或删除'))
    }
  },

  /**
   * 从回收站恢复之后，把条目表与文件树对齐（**静默**，不弹"已重扫"提示）。
   *
   * 为什么必须刷新：宿主的 `note_restore` 会让文件回到磁盘（并就地更新索引与它自己那份条目表），
   * 但**前端这份快照**是打开 Vault 时拍的 —— 不刷新的话文件已经回来了、树里却没有那一行。
   *
   * 为什么走一次完整重扫，而不是"往树里插一行"：一次恢复可能是**一整棵目录**（几百个文件），
   * 逐条插入等于把扫描器的口径（扩展名、忽略规则、大小统计）抄第二遍；
   * 而 `vault_snapshot` 会复用索引缓存，1 万笔记约 0.1–0.3 s，代价可接受。
   * 单篇恢复时宿主其实已经就地补好了条目与索引，这一步只是让前端跟上。
   */
  syncAfterRestore: async () => {
    if (get().info === null || get().status === 'loading') return
    const seq = ++externalSeq
    try {
      const snapshot = await ipc.vaultSnapshot()
      if (seq !== externalSeq) return
      set(snapshotPatch(snapshot, get().selected))
    } catch (cause) {
      const error = MimenoteError.from(cause)
      console.warn('[vault] 恢复后刷新条目表失败：', error)
      toast.warn('恢复后刷新失败', describeError(error, '请按 Ctrl+Alt+R 手工重扫一次'))
    }
  },

  closeVault: async () => {
    try {
      await ipc.vaultClose()
    } catch {
      // 关闭失败不应阻塞 UI 回到选择界面
    }
    saveString(LAST_VAULT_KEY, '')
    set({
      status: 'idle',
      info: null,
      entries: [],
      tree: [],
      selected: null,
      filter: '',
      error: null,
      lastRoot: null,
    })
  },

  toggleExpanded: (relPath) => {
    const expanded = new Set(get().expanded)
    if (expanded.has(relPath)) expanded.delete(relPath)
    else expanded.add(relPath)
    set({ expanded })
    persistExpanded(get().info?.rootPath ?? '', expanded)
  },

  setExpanded: (relPath, value) => {
    const expanded = new Set(get().expanded)
    if (value) expanded.add(relPath)
    else expanded.delete(relPath)
    set({ expanded })
    persistExpanded(get().info?.rootPath ?? '', expanded)
  },

  expandAll: () => {
    const expanded = new Set(collectDirectoryPaths(get().tree))
    set({ expanded })
    persistExpanded(get().info?.rootPath ?? '', expanded)
  },

  collapseAll: () => {
    const expanded = new Set<string>()
    set({ expanded })
    persistExpanded(get().info?.rootPath ?? '', expanded)
  },

  revealPath: (relPath) => {
    const expanded = new Set(get().expanded)
    for (const ancestor of ancestorsOf(relPath)) expanded.add(ancestor)
    set({ expanded })
    persistExpanded(get().info?.rootPath ?? '', expanded)
  },

  select: (selected) => set({ selected }),

  setFilter: (filter) => set({ filter }),

  registerCreatedNote: (note) => {
    const parent = parentOf(note.relPath)
    const entry: EntryMeta = {
      relPath: note.relPath,
      name: note.relPath.split('/').pop() ?? note.relPath,
      isDir: false,
      sizeBytes: note.sizeBytes,
      mtimeMs: note.mtimeMs,
      ext: 'md',
    }
    const entries = upsertEntry(get().entries, entry)
    const expanded = new Set(get().expanded)
    if (parent !== '') expanded.add(parent)
    const info = get().info
    set({
      entries,
      tree: buildTree(entries, treeComparator()),
      expanded,
      selected: note.relPath,
      info:
        info === null
          ? null
          : { ...info, entryCount: entries.length, noteCount: info.noteCount + 1 },
    })
    persistExpanded(info?.rootPath ?? '', expanded)
  },

  registerRenamedNote: (outcome) => {
    const renamed = get().entries.map((entry) =>
      entry.relPath === outcome.oldRelPath
        ? {
            ...entry,
            relPath: outcome.newRelPath,
            name: outcome.newRelPath.split('/').pop() ?? outcome.newRelPath,
            mtimeMs: outcome.newMtimeMs,
          }
        : entry,
    )
    // 移动可能落到一个**刚创建**的目录里（宿主会创建它，但条目表是"打开 Vault 时扫一次"
    // 的快照）。缺了父目录条目，`domain/tree` 会把这篇笔记当成"父目录缺失"而提升成根节点 ——
    // 表现是"笔记跑到了最外层、新建的目录看不见"。这个信息就在路径里，不必再问宿主。
    const { entries, added } = withAncestorDirs(renamed, outcome.newRelPath)
    const info = get().info
    const nextInfo =
      info === null || added === 0 ? info : { ...info, entryCount: entries.length, folderCount: info.folderCount + added }

    const selected = get().selected
    const selectedAfter = selected === outcome.oldRelPath ? outcome.newRelPath : selected
    if (selectedAfter !== null && selectedAfter !== selected) {
      const expanded = new Set(get().expanded)
      for (const ancestor of ancestorsOf(selectedAfter)) expanded.add(ancestor)
      persistExpanded(info?.rootPath ?? '', expanded)
      set({ entries, tree: buildTree(entries, treeComparator()), selected: selectedAfter, expanded, info: nextInfo })
      return
    }
    set({ entries, tree: buildTree(entries, treeComparator()), selected: selectedAfter, info: nextInfo })
  },

  registerRelocatedDirectory: (outcome) => {
    const { oldRelPath, newRelPath } = outcome
    const remap = (relPath: string): string =>
      relPath === oldRelPath
        ? newRelPath
        : relPath.startsWith(`${oldRelPath}/`)
          ? `${newRelPath}${relPath.slice(oldRelPath.length)}`
          : relPath

    const entries = get().entries.map((entry) => {
      const relPath = remap(entry.relPath)
      return relPath === entry.relPath ? entry : { ...entry, relPath, name: relPath.split('/').pop() ?? relPath }
    })
    // 目录搬到一个**刚创建**的目录里时，祖先链上可能缺条目（条目表是"打开 Vault 时扫一次"
    // 的快照）。缺了它 `domain/tree` 会把子树提升成根节点 —— 表现是"目录跑到了最外层"。
    const { entries: withAncestors, added } = withAncestorDirs(entries, newRelPath)

    // 展开状态跟着换前缀：不然搬迁后原来展开的目录全被折叠（`expanded` 里存的是旧路径）
    const expanded = new Set<string>()
    for (const dir of get().expanded) expanded.add(remap(dir))

    const selected = get().selected
    const selectedAfter = selected === null ? null : remap(selected)
    const info = get().info
    const nextInfo =
      info === null
        ? null
        : added === 0
          ? info
          : { ...info, entryCount: withAncestors.length, folderCount: info.folderCount + added }

    set({
      entries: withAncestors,
      tree: buildTree(withAncestors, treeComparator()),
      expanded,
      selected: selectedAfter,
      info: nextInfo,
    })
    persistExpanded(info?.rootPath ?? '', expanded)
  },

  registerAttachment: (file) => {
    const parent = parentOf(file.relPath)
    const ext = extensionOf(file.relPath)
    const entry: EntryMeta = {
      relPath: file.relPath,
      name: file.relPath.split('/').pop() ?? file.relPath,
      isDir: false,
      sizeBytes: file.sizeBytes,
      // 附件不参与冲突检测（它不是笔记），但条目形状要与扫描结果一致：
      // 拿不到 mtime 时用 `null`（契约允许），不要塞 0 冒充"1970 年改过"
      mtimeMs: null,
      ext: ext === '' ? null : ext,
    }
    // 附件目录可能是**刚被宿主创建**的：缺了父目录条目，`domain/tree` 会把附件提升成根节点
    const { entries, added } = withAncestorDirs(upsertEntry(get().entries, entry), file.relPath)
    const expanded = new Set(get().expanded)
    if (parent !== '') expanded.add(parent)
    const info = get().info
    set({
      entries,
      tree: buildTree(entries, treeComparator()),
      expanded,
      info:
        info === null
          ? null
          : {
              ...info,
              entryCount: entries.length,
              folderCount: info.folderCount + added,
            },
    })
    persistExpanded(info?.rootPath ?? '', expanded)
  },

  registerDeletedEntry: (record) => {
    const prefix = `${record.originalRelPath}/`
    const entries = get().entries.filter(
      (entry) => entry.relPath !== record.originalRelPath && !entry.relPath.startsWith(prefix),
    )
    const info = get().info
    const removedNotes = get().entries.filter(
      (entry) =>
        (entry.relPath === record.originalRelPath || entry.relPath.startsWith(prefix)) &&
        entry.isDir === false &&
        (entry.ext === 'md' || entry.ext === 'markdown'),
    ).length
    const removedFolders = get().entries.filter(
      (entry) =>
        (entry.relPath === record.originalRelPath || entry.relPath.startsWith(prefix)) && entry.isDir,
    ).length
    const selected = get().selected
    const selectedRemoved =
      selected !== null && (selected === record.originalRelPath || selected.startsWith(prefix))

    set({
      entries,
      tree: buildTree(entries, treeComparator()),
      selected: selectedRemoved ? null : selected,
      info:
        info === null
          ? null
          : {
              ...info,
              entryCount: entries.length,
              noteCount: Math.max(0, info.noteCount - removedNotes),
              folderCount: Math.max(0, info.folderCount - removedFolders),
            },
    })
  },
}))

function upsertEntry(entries: readonly EntryMeta[], entry: EntryMeta): EntryMeta[] {
  const index = entries.findIndex((candidate) => candidate.relPath === entry.relPath)
  if (index === -1) return [...entries, entry]
  const next = entries.slice()
  next[index] = entry
  return next
}

/**
 * 补上 `relPath` 缺失的祖先目录，返回新表与新增条数。
 *
 * 目录条目的形状与扫描口径一致：`sizeBytes = 0`、`mtimeMs = null`、`ext = null`
 * （见 `mn_core::scanner`，别在增量路径上发明第二套形状）。
 */
function withAncestorDirs(
  entries: readonly EntryMeta[],
  relPath: string,
): { entries: EntryMeta[]; added: number } {
  const existing = new Set(entries.map((entry) => entry.relPath))
  const missing: EntryMeta[] = []
  // `ancestorsOf` 由近到远（先父目录）；反向压入让父目录排在子目录之前，读起来更顺
  for (const dir of ancestorsOf(relPath).reverse()) {
    if (existing.has(dir)) continue
    existing.add(dir)
    missing.push({
      relPath: dir,
      name: dir.split('/').pop() ?? dir,
      isDir: true,
      sizeBytes: 0,
      mtimeMs: null,
      ext: null,
    })
  }
  if (missing.length === 0) return { entries: [...entries], added: 0 }
  return { entries: [...entries, ...missing], added: missing.length }
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

// -- 外部改动（ADR-0016）-------------------------------------------------------

/**
 * 外部改动重扫的请求序号：同步盘的风暴被宿主去抖合并过，但"手工重扫 + 外部改动"
 * 仍可能并发，过期的那一份快照必须丢掉 —— 否则界面会回退到一棵旧树。
 */
let externalSeq = 0

/**
 * 把一份新快照装进 store（手工重扫与外部改动共用同一段收尾）。
 *
 * 选中项若已不在条目表里就清掉：保留一个指向不存在路径的选中项，会让文件树的主区域
 * 显示空白，而用户完全不知道为什么。
 */
function snapshotPatch(snapshot: VaultSnapshot, selected: string | null): Partial<VaultState> {
  const stillExists =
    selected === null || snapshot.entries.some((entry) => entry.relPath === selected)
  return {
    status: 'ready',
    info: infoFromSnapshot(snapshot),
    entries: snapshot.entries,
    tree: buildTree(snapshot.entries, treeComparator()),
    selected: stillExists ? selected : null,
    error: null,
  }
}

/**
 * 当前打开的笔记若在磁盘上变了，交给 `note-store` 决定"重载"还是"进冲突"。
 *
 * 判据是**重扫回来的 mtime 与文档的版本令牌**（而不是宿主事件里的路径表）：
 * 路径表有上限、会被截断，而 mtime 比对在任何规模下都成立，也天然覆盖了
 * "同一次风暴里既有别的文件、也有当前笔记"的情况。
 */
async function followDiskForOpenNote(entries: readonly EntryMeta[]): Promise<void> {
  const note = useNoteStore.getState()
  const doc = note.doc
  if (doc === null) return

  const entry = entries.find((candidate) => candidate.relPath === doc.relPath)
  if (entry === undefined) {
    // 条目表里没有它：磁盘上被删掉或改名搬走了
    await note.applyExternalChange({ currentMtimeMs: 0, removed: true })
    return
  }
  if (entry.mtimeMs === doc.baseMtimeMs) return // 没变（我们自己写的那种也落在这一档）

  await note.applyExternalChange({ currentMtimeMs: entry.mtimeMs ?? 0 })
}

/**
 * 排序偏好变化 → 用同一份判据重建树。
 *
 * 订阅方放在**消费树的 store** 这一侧（而不是 ui-store 反过来调 vault-store）：
 * ui-store 只管偏好本身，不需要知道谁在意它；方向反过来会让"UI 偏好"这个最底层的
 * store 依赖业务 store，层级就倒了。
 */
useUiStore.subscribe((state, previous) => {
  if (state.treeSort === previous.treeSort) return
  useVaultStore.getState().resortTree()
})

/**
 * 订阅"Vault 被外部改动"事件（`App` 挂载时调用一次，返回取消订阅函数）。
 *
 * 与 `subscribeIndexStatus` 同一个姿态：浏览器预览模式（没有 Tauri 事件系统）下静默降级 ——
 * 功能优雅缺席，界面不报错也不算坏。
 */
export function subscribeVaultChanges(): () => void {
  let disposed = false
  let unlisten: (() => void) | null = null

  void (async () => {
    try {
      const { listen } = await import('@tauri-apps/api/event')
      const stop = await listen<VaultChanged>(VAULT_CHANGED_EVENT, (event) => {
        void useVaultStore.getState().applyExternalChange(event.payload)
      })
      if (disposed) {
        stop()
        return
      }
      unlisten = stop
    } catch (cause) {
      // 浏览器预览模式（没有 Tauri 事件系统）会走到这里，属预期降级
      console.debug('[vault] 订阅外部改动事件失败（外部改动将需要手动重扫）：', cause)
    }
  })()

  return () => {
    disposed = true
    unlisten?.()
    unlisten = null
  }
}
