/**
 * 当前文档状态 + 自动保存流水线。
 *
 * 核心约束（ADR-0004 / architecture.md §3.3）：
 * 1. **输入路径零 IO**：`setText` 只改内存并调度防抖保存，不 await 任何东西；
 * 2. **写操作串行**：单飞标志 + 待写标记，同一文件永不并发写；
 * 3. **冲突不静默覆盖**：宿主返回 `CONFLICT` 时进入冲突态，交给用户决定；
 * 4. **切换文档先落盘**：切走之前把未保存内容写掉，避免"手滑切走丢内容"。
 */

import { create } from 'zustand'

import { fromEditorText, toEditorText, type TextFormat } from '@/domain/eol'
import { isMarkdown } from '@/domain/paths'
import { ipc } from '@/ipc/client'
import { MimenoteError, describeError } from '@/ipc/types'
import type { TextStats } from '@/ipc/types'
import { toast } from './toast-store'

export interface OpenDocument {
  relPath: string
  /** 编辑器态文本（`\n` 归一化）。 */
  text: string
  /** 磁盘格式（BOM / 换行风格），保存时还原。 */
  format: TextFormat
  /** 版本令牌：磁盘上的 mtime。 */
  baseMtimeMs: number
  sizeBytes: number
  /** 外部替换计数：仅"打开/重新加载"时自增，编辑器据此整篇替换（避免逐键 diff）。 */
  revision: number
  openedAt: number
}

export type NoteStatus = 'idle' | 'loading' | 'ready' | 'saving' | 'conflict' | 'error'

export interface ConflictState {
  currentMtimeMs: number
  detectedAt: number
}

interface NoteState {
  doc: OpenDocument | null
  status: NoteStatus
  dirty: boolean
  error: MimenoteError | null
  conflict: ConflictState | null
  /** 最近一次读取耗时（毫秒），用于验证"打开 1MB ≤ 100ms"预算。 */
  loadMs: number
  lastSavedAt: number | null
  lastWriteMs: number | null
  lastWriteBytes: number | null
  saveCount: number
  /** 磁盘真实统计（`note_stats`），保存后刷新。 */
  diskStats: TextStats | null

  open: (relPath: string) => Promise<boolean>
  setText: (text: string) => void
  saveNow: (options?: { force?: boolean }) => Promise<boolean>
  resolveConflict: (choice: 'overwrite' | 'reload') => Promise<void>
  reload: () => Promise<void>
  /**
   * 改名后把当前文档**原地换到新路径**。
   *
   * 为什么不是"关掉再打开"：改名不改变文件内容，重新读取会整篇替换编辑器文本，
   * 顺带丢掉光标位置与撤销历史。这里只换路径与版本令牌，编辑体验连续。
   * （若文件内容也被改写过 —— 例如自链接 —— 调用方应改用 `open()` 重新读取。）
   */
  retarget: (newRelPath: string, mtimeMs: number) => void
  close: () => void
  refreshDiskStats: () => Promise<void>
}

let autosaveDelayMs = 600
let autosaveTimer: ReturnType<typeof setTimeout> | null = null
let inFlight = false
let pendingSave = false
let revisionCounter = 0
/**
 * 异步读取的取消令牌：用户快速点击多篇笔记时，只有**最后一次**请求的结果会被采纳，
 * 过期的响应直接丢弃（避免"慢请求覆盖新内容"的经典竞态）。
 */
let readToken = 0

/** 调整自动保存防抖（测试用；生产默认 600ms）。 */
export function configureAutosave(options: { delayMs?: number }): void {
  if (options.delayMs !== undefined) autosaveDelayMs = Math.max(0, options.delayMs)
}

/** 取消待执行的自动保存。 */
export function cancelAutosave(): void {
  if (autosaveTimer !== null) {
    clearTimeout(autosaveTimer)
    autosaveTimer = null
  }
}

/** 立即触发一次保存（窗口失焦/隐藏时调用，防止意外退出丢内容）。 */
export function flushAutosave(): void {
  const state = useNoteStore.getState()
  if (state.doc === null || !state.dirty || state.conflict !== null) return
  cancelAutosave()
  void state.saveNow()
}

function scheduleAutosave(): void {
  cancelAutosave()
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null
    const state = useNoteStore.getState()
    if (state.conflict !== null) return
    void state.saveNow()
  }, autosaveDelayMs)
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

export const useNoteStore = create<NoteState>((set, get) => ({
  doc: null,
  status: 'idle',
  dirty: false,
  error: null,
  conflict: null,
  loadMs: 0,
  lastSavedAt: null,
  lastWriteMs: null,
  lastWriteBytes: null,
  saveCount: 0,
  diskStats: null,

  open: async (relPath) => {
    const current = get()
    if (current.doc?.relPath === relPath) return true

    // 切换前先落盘（冲突态除外：那种情况必须由用户决定）
    if (current.doc !== null && current.dirty && current.conflict === null) {
      await current.saveNow()
    }
    cancelAutosave()

    if (!isMarkdown(relPath)) {
      toast.warn('M1 只能编辑 Markdown 文件', relPath)
      return false
    }

    set({ status: 'loading', error: null, conflict: null })
    const started = nowMs()
    const token = ++readToken
    try {
      const content = await ipc.noteRead(relPath)
      if (token !== readToken) return false // 已被更新的请求取代
      const { text, format } = toEditorText(content.text)
      revisionCounter += 1
      set({
        doc: {
          relPath,
          text,
          format,
          baseMtimeMs: content.mtimeMs,
          sizeBytes: content.sizeBytes,
          revision: revisionCounter,
          openedAt: Date.now(),
        },
        status: 'ready',
        dirty: false,
        error: null,
        conflict: null,
        loadMs: Math.round(nowMs() - started),
        diskStats: null,
      })
      return true
    } catch (cause) {
      const error = MimenoteError.from(cause)
      if (token !== readToken) return false
      set({ status: 'error', error, doc: null, dirty: false })
      toast.error(describeError(error, '打开笔记失败'))
      return false
    }
  },

  setText: (text) => {
    const state = get()
    const doc = state.doc
    if (doc === null || doc.text === text) return
    set({
      doc: { ...doc, text },
      dirty: true,
      status: state.status === 'saving' || state.status === 'conflict' ? state.status : 'ready',
    })
    // 冲突期间不自动重试：必须由用户在横幅里做出选择
    if (state.conflict === null) scheduleAutosave()
  },

  saveNow: async ({ force = false } = {}) => {
    const state = get()
    const doc = state.doc
    if (doc === null) return false

    if (inFlight) {
      // 已有写入在途：标记"完成后再写一次"，保证最后一次编辑一定落盘
      pendingSave = true
      return false
    }

    inFlight = true
    cancelAutosave()
    set({ status: 'saving', error: null })

    try {
      const payload = fromEditorText(doc.text, doc.format)
      const outcome = await ipc.noteWrite(doc.relPath, payload, doc.baseMtimeMs, force)

      set((current) => {
        if (current.doc === null || current.doc.relPath !== doc.relPath) {
          return { status: 'ready' }
        }
        // 保存期间用户又改了内容 → 保持 dirty，交由下一轮自动保存
        const stillDirty = current.doc.text !== doc.text
        return {
          doc: {
            ...current.doc,
            baseMtimeMs: outcome.mtimeMs,
            sizeBytes: outcome.sizeBytes,
          },
          status: 'ready',
          dirty: stillDirty,
          conflict: null,
          error: null,
          lastSavedAt: Date.now(),
          lastWriteMs: outcome.writtenInMs,
          lastWriteBytes: outcome.sizeBytes,
          saveCount: current.saveCount + 1,
        }
      })

      if (force) toast.success('已覆盖保存', `${doc.relPath}（${outcome.writtenInMs}ms）`)
      return true
    } catch (cause) {
      const error = MimenoteError.from(cause)
      if (error.isConflict) {
        set({
          status: 'conflict',
          dirty: true,
          error,
          conflict: { currentMtimeMs: error.currentMtimeMs ?? 0, detectedAt: Date.now() },
        })
        return false
      }
      set({ status: 'error', error })
      toast.error(describeError(error, '保存失败'))
      return false
    } finally {
      inFlight = false
      if (pendingSave) {
        pendingSave = false
        scheduleAutosave()
      }
    }
  },

  resolveConflict: async (choice) => {
    if (choice === 'overwrite') {
      await get().saveNow({ force: true })
    } else {
      await get().reload()
    }
  },

  reload: async () => {
    const doc = get().doc
    if (doc === null) return
    const started = nowMs()
    const token = ++readToken
    try {
      const content = await ipc.noteRead(doc.relPath)
      if (token !== readToken) return
      const { text, format } = toEditorText(content.text)
      revisionCounter += 1
      set({
        doc: {
          relPath: doc.relPath,
          text,
          format,
          baseMtimeMs: content.mtimeMs,
          sizeBytes: content.sizeBytes,
          revision: revisionCounter,
          openedAt: Date.now(),
        },
        status: 'ready',
        dirty: false,
        error: null,
        conflict: null,
        loadMs: Math.round(nowMs() - started),
      })
      toast.info('已从磁盘重新加载', doc.relPath)
    } catch (cause) {
      const error = MimenoteError.from(cause)
      set({ status: 'error', error })
      toast.error(describeError(error, '重新加载失败'))
    }
  },

  close: () => {
    cancelAutosave()
    readToken += 1
    set({ doc: null, status: 'idle', dirty: false, conflict: null, error: null, diskStats: null })
  },
  retarget: (newRelPath, mtimeMs) => {
    const doc = get().doc
    if (doc === null) return
    cancelAutosave()
    set({
      doc: { ...doc, relPath: newRelPath, baseMtimeMs: mtimeMs },
      status: 'ready',
      error: null,
      conflict: null,
    })
  },

  refreshDiskStats: async () => {
    const doc = get().doc
    if (doc === null) return
    try {
      const result = await ipc.noteStats(doc.relPath)
      set((current) =>
        current.doc?.relPath === doc.relPath ? { diskStats: result.stats } : {},
      )
    } catch {
      // 统计失败不影响编辑（例如文件刚被外部删除）
    }
  },
}))

/** 当前是否存在未保存内容（窗口关闭拦截用）。 */
export function hasUnsavedChanges(): boolean {
  const state = useNoteStore.getState()
  return state.doc !== null && state.dirty
}
