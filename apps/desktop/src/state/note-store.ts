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
  /**
   * 记录"磁盘上的文件被外部改过了"（**非编辑器**的写路径用它，例如标签面板改 frontmatter）。
   *
   * 为什么必须走这里、而不是各条写路径自己弹一个提示：冲突只有一种语义 ——
   * 顶部横幅 + 由用户在"覆盖保存 / 重新加载"之间二选一。任何写路径自己发明一套说法，
   * 用户就会同时面对两种互相矛盾的提示（而其中一套很可能是错的）。
   */
  noteExternalChange: (currentMtimeMs: number) => void
  /**
   * 外部改动落在**当前这篇**时的取舍（由 `vault-store` 收到宿主事件后调用，见 ADR-0016）。
   *
   * 两条分支与保存冲突是**同一套语义**：
   * * 没有未保存内容 → 从磁盘重新加载（一条不打扰的提示：状态栏之外只多一次 toast）；
   * * 有未保存内容 → 进入冲突态（复用 [`noteExternalChange`](#noteExternalChange)），
   *   等用户在横幅里决定 —— **绝不**自动覆盖，也绝不静默丢弃。
   *
   * 为什么决策必须放在这里：冲突态、自动保存流水线、`revision` 的整篇替换都绑在这个 store 上，
   * 让调用方自己去 `set` 状态等于把一台状态机拆成两半。
   */
  applyExternalChange: (change: { currentMtimeMs: number; removed?: boolean }) => Promise<void>
  resolveConflict: (choice: 'overwrite' | 'reload') => Promise<void>
  reload: (options?: { silent?: boolean }) => Promise<void>
  /**
   * 改名后把当前文档**原地换到新路径**。
   *
   * 为什么不是"关掉再打开"：改名不改变文件内容，重新读取会整篇替换编辑器文本，
   * 顺带丢掉光标位置与撤销历史。这里只换路径与版本令牌，编辑体验连续。
   * （若文件内容也被改写过 —— 例如自链接 —— 调用方应改用 `open()` 重新读取。）
   */
  retarget: (newRelPath: string, mtimeMs: number) => void
  /**
   * 用**刚刚写进磁盘的那份文本**替换当前文档（标签编辑用）。
   *
   * 为什么必须有这一条：改标签是"在别的通道上改同一个文件"。若内存里的文本还停在旧版本，
   * 下一次自动保存就会把刚写下去的标签**覆盖掉**（用户看到标签闪一下又没了）——
   * 这是数据正确性问题，优先级高于"光标别动"。
   *
   * 为什么走 `revision` 自增（整篇替换）而不是"原地换文本"：编辑器只订阅
   * `relPath` / `revision` 这类原始值（**刻意不订阅 `text`**，否则每次按键都会让 React 重渲染），
   * `revision` 是既有的、也是唯一的"把外部文本送进 CM 文档模型"的通道。代价是光标位置按旧偏移
   * 保留（标签改在文件开头，正文里的光标会差一个标签长度的偏移），但**撤销历史保留**
   * （整篇替换是一次普通事务），而且"刚改的那个标签可以被 Ctrl+Z 撤销"反而是好行为。
   */
  applyWrittenText: (diskText: string, options: { mtimeMs: number; sizeBytes: number }) => void
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

  noteExternalChange: (currentMtimeMs) => {
    if (get().doc === null) return
    // 刻意**不动** `dirty`：这次冲突是"磁盘被别人改了"，本地一个字符都没改，
    // 谎报 dirty 会让标签页上的 ● 与关闭窗口时的"有未保存修改"确认框凭空出现
    set({
      status: 'conflict',
      conflict: { currentMtimeMs, detectedAt: Date.now() },
    })
  },

  applyExternalChange: async ({ currentMtimeMs, removed = false }) => {
    const state = get()
    const doc = state.doc
    if (doc === null) return

    // 待写的防抖保存先取消：它带着的是"看到磁盘新版本之前"的文本
    cancelAutosave()

    if (state.dirty || state.conflict !== null) {
      // 有未保存内容（或已经处于冲突态）→ 只进冲突态，一个字节都不写：
      // 与保存时撞上外部改动完全同一套语义，交给横幅里的用户决定
      get().noteExternalChange(currentMtimeMs)
      return
    }

    if (removed) {
      // 磁盘上这篇已经不在了（被删掉或改名搬走）。编辑器里留着最后一次读到的内容，
      // 但不假装"重新加载成功"——后台标签会被 `tabs-store` 按条目表剪掉。
      toast.warn('磁盘上的这篇笔记已被删除或移动', doc.relPath)
      return
    }

    await get().reload({ silent: true })
    // 重载失败（例如刚被删掉）时 `reload` 自己已经给了错误提示，不在这里再补一条
    if (get().status === 'ready') {
      toast.info('已在磁盘上更新，已重新加载', doc.relPath)
    }
  },

  resolveConflict: async (choice) => {
    if (choice === 'overwrite') {
      await get().saveNow({ force: true })
    } else {
      await get().reload()
    }
  },

  reload: async ({ silent = false } = {}) => {
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
      // `silent`：外部改动触发的那次重载由调用方给一条更贴切的提示（ADR-0016）
      if (!silent) toast.info('已从磁盘重新加载', doc.relPath)
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

  applyWrittenText: (diskText, { mtimeMs, sizeBytes }) => {
    const doc = get().doc
    if (doc === null) return
    // 待写的那次防抖保存必须取消：它的文本是"改标签之前"的，写下去等于撤销这次改动
    cancelAutosave()
    const { text, format } = toEditorText(diskText)
    revisionCounter += 1
    set({
      doc: {
        ...doc,
        text,
        format,
        baseMtimeMs: mtimeMs,
        sizeBytes,
        revision: revisionCounter,
      },
      status: 'ready',
      dirty: false,
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
