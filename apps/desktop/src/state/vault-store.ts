/**
 * Vault 状态：条目表、树、展开/选中、过滤。
 *
 * 性能要点（architecture.md §3.2）：打开 Vault **只扫描一次**，
 * 之后新建/删除只做增量更新 —— 10k 笔记下不存在"每次操作重扫目录"的开销。
 */

import { create } from 'zustand'

import { buildTree, collectDirectoryPaths, ancestorsOf, type TreeNode } from '@/domain/tree'
import { parentOf } from '@/domain/paths'
import { ipc } from '@/ipc/client'
import { MimenoteError, describeError } from '@/ipc/types'
import type { EntryMeta, NoteContent, TrashRecord, VaultInfo, VaultSnapshot } from '@/ipc/types'
import { loadJson, loadString, saveJson, saveString } from './persist'
import { toast } from './toast-store'

const LAST_VAULT_KEY = 'mimenote.vault.last'
const EXPANDED_KEY = 'mimenote.vault.expanded.v1'

export type VaultStatus = 'idle' | 'loading' | 'ready' | 'error'

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

  openVault: (path: string) => Promise<boolean>
  restoreLastVault: () => Promise<void>
  rescan: () => Promise<void>
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

  openVault: async (path) => {
    set({ status: 'loading', error: null })
    try {
      const snapshot = await ipc.vaultOpen(path)
      const tree = buildTree(snapshot.entries)
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
      const selected = get().selected
      const stillExists =
        selected === null || snapshot.entries.some((entry) => entry.relPath === selected)
      set({
        status: 'ready',
        info: infoFromSnapshot(snapshot),
        entries: snapshot.entries,
        tree: buildTree(snapshot.entries),
        selected: stillExists ? selected : null,
        error: null,
      })
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
      tree: buildTree(entries),
      expanded,
      selected: note.relPath,
      info:
        info === null
          ? null
          : { ...info, entryCount: entries.length, noteCount: info.noteCount + 1 },
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
      tree: buildTree(entries),
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

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}
