/**
 * 打开的**文档仓库** + 每篇文档自己的自动保存流水线。
 *
 * ## 为什么从"当前文档"改成"仓库"（用户要求：分栏里每格都能编辑）
 * 从前全局只有一份 `doc`：非当前那格只能挂只读编辑器（ADR-0049），属性面板也只给当前那格
 * （`MarkdownEditor` 里 `relPath === activePath` 那道门）。用户的诉求是**每格都能编辑** ——
 * 那就必须让每篇文档各有自己的正文、脏标记、冲突态与 `(mtime, size)` 令牌。
 * 容器切割树的不变式（一篇笔记全树只出现一次）不受影响：几篇**不同**的笔记同时显示在不同格子里，
 * 正是这个仓库要承载的形态。
 *
 * ## 三条纪律（ADR-0004 / architecture.md §3.3，一条都没放宽）
 * 1. **输入路径零 IO**：`setText` 只改内存并调度防抖保存；
 * 2. **写操作串行**：全局单飞 + 按路径的"待写"标记 —— 同一文件永不并发写（不同文件也排队，
 *    宿主只有一把写锁，排队还顺带免掉"两篇同时保存抢锁"的假冲突）；
 * 3. **冲突不静默覆盖**：每篇各有自己的冲突态，由用户在自己的那份横幅上决定。
 *
 * ## `doc` / `dirty` / `status` / `conflict` … 是**派生镜像**
 * 它们仍然是 state 的字段，但永远是 `docs[activePath]` 的视图（每次写入统一由
 * {@link mirrors} 重算）。于是"当前文档"这一整套既有 API —— 大纲、标签面板、状态栏、
 * 导出、图谱焦点、窗口关闭守卫、`hasUnsavedChanges` —— **一个字都不用改**，
 * 而分栏里的每一格用自己的 {@link NoteState.docOf}。
 *
 * `activePath` 只在"用户/入口明确切到某篇"时改（打开笔记、点某一格、关闭标签）；
 * `openDoc` 只把正文读进仓库，**不抢当前** —— 分栏里新出现的格子不该改变大纲在说哪一篇。
 */

import { create } from 'zustand'

import { fromEditorText, toEditorText, type TextFormat } from '@/domain/eol'
import { displayPath, isMarkdown } from '@/domain/paths'
import { ipc } from '@/ipc/client'
import { MimenoteError, describeError } from '@/ipc/types'
import type { TextStats } from '@/ipc/types'
import { useSettingsStore } from '@/state/settings-store'
import { toast } from './toast-store'

/** 一篇文档的正文 + 版本令牌（旧 API 的 `doc` 就是它）。 */
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

/**
 * 一篇已打开文档的**完整**状态：正文本身 + 它自己的保存/冲突状态。
 *
 * 为什么不复用全局字段：全局字段只能描述"一篇"。分栏之后"几篇同时脏"是常态，
 * 而"哪一篇有冲突、哪一篇还没落盘"必须是**按篇**的事实。
 */
export interface NoteDoc extends OpenDocument {
  dirty: boolean
  status: NoteStatus
  error: MimenoteError | null
  conflict: ConflictState | null
  /** 最近一次读取耗时（毫秒），用于验证"打开 1MB ≤ 100ms"预算。 */
  loadMs: number
  lastSavedAt: number | null
  lastWriteMs: number | null
  lastWriteBytes: number | null
  /** 磁盘真实统计（`note_stats`），保存后刷新。 */
  diskStats: TextStats | null
}

type DocsMap = Record<string, NoteDoc>

/** `docs[activePath]` 的视图（派生镜像的六个字段一起算，别只算一半）。 */
interface MirrorFields {
  doc: OpenDocument | null
  status: NoteStatus
  dirty: boolean
  error: MimenoteError | null
  conflict: ConflictState | null
  loadMs: number
  lastSavedAt: number | null
  lastWriteMs: number | null
  lastWriteBytes: number | null
  diskStats: TextStats | null
}

interface NoteState extends MirrorFields {
  /** 所有已打开的文档（分栏里每格一篇；同一篇不会被两个格子同时持有）。 */
  docs: DocsMap
  /** "当前文档" = 大纲 / 标签面板 / 状态栏 / 导出 / 图谱焦点认的那一篇。 */
  activePath: string | null
  /** 脏 / 冲突的路径清单（引用稳定：只有集合真的变了才换新数组，标签条按它订阅）。 */
  dirtyPaths: readonly string[]
  conflictPaths: readonly string[]
  saveCount: number

  // ---- 当前文档（旧 API，语义与签名一字未改）-------------------------------------
  open: (relPath: string) => Promise<boolean>
  setText: (text: string) => void
  saveNow: (options?: { force?: boolean }) => Promise<boolean>
  noteExternalChange: (currentMtimeMs: number) => void
  applyExternalChange: (change: { currentMtimeMs: number; removed?: boolean }) => Promise<void>
  resolveConflict: (choice: 'overwrite' | 'reload') => Promise<void>
  reload: (options?: { silent?: boolean }) => Promise<void>
  retarget: (newRelPath: string, mtimeMs: number) => void
  applyWrittenText: (diskText: string, options: { mtimeMs: number; sizeBytes: number }) => void
  close: () => void
  refreshDiskStats: () => Promise<void>

  // ---- 按篇（分栏里每格一个编辑器用它们）------------------------------------------
  /** 仓库里某一篇的完整状态（没打开 → `null`）。 */
  docOf: (relPath: string) => NoteDoc | null
  /** 把一篇读进仓库。**不抢当前文档**（分栏里新出现的格子不该改大纲在说哪一篇）。 */
  openDoc: (relPath: string) => Promise<boolean>
  /** 把仓库里**已经有**的那篇设为当前文档（不读盘、不落盘）。 */
  activateDoc: (relPath: string) => void
  setTextFor: (relPath: string, text: string) => void
  saveNowFor: (relPath: string, options?: { force?: boolean }) => Promise<boolean>
  reloadFor: (relPath: string, options?: { silent?: boolean }) => Promise<void>
  resolveConflictFor: (relPath: string, choice: 'overwrite' | 'reload') => Promise<void>
  noteExternalChangeFor: (relPath: string, currentMtimeMs: number) => void
  applyExternalChangeFor: (relPath: string, change: { currentMtimeMs: number; removed?: boolean }) => Promise<void>
  refreshDiskStatsFor: (relPath: string) => Promise<void>
  /** 关掉某一篇（标签关闭 / 条目表里它已经不存在）。 */
  closeDoc: (relPath: string) => void
  /** 关掉一批（条目表对账用）。 */
  closeDocs: (relPaths: readonly string[]) => void
  /** 关掉全部文档（换 Vault）。 */
  closeAll: () => void
}

let autosaveDelayMs = 600
/** 按路径的防抖定时器（每篇自己的节奏）。 */
const autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** 全局单飞：宿主只有一把写锁，所以**所有**写排队（与旧实现的全局 `inFlight` 同义）。 */
let inFlight = false
/** 排在队尾的路径（写过一轮之后再各自重排一次自动保存）。 */
const pendingSaves = new Set<string>()
let revisionCounter = 0
/**
 * 仓库"代际"：每次整仓清空（换 Vault / 测试复位）自增。
 *
 * 为什么需要它：`tabs-store` 的"恢复上次激活标签"会推迟一拍（`setTimeout 0`）再打开笔记。
 * 那一拍里如果整仓已经被清过（换 Vault、或测试夹具复位），这次打开就属于**过期意图**——
 * 不拦的话它会在新会话里凭空打开上一篇笔记。调度方记下当时的值，执行前比对。
 */
let repositoryGeneration = 0
/** 按路径的读取取消令牌：同一篇的慢响应被后一次取代，不同篇互不影响。 */
const readTokens = new Map<string, number>()

/** 当前仓库代际（`tabs-store` 的延迟恢复用它判断"这次恢复是不是已经过期"）。 */
export function noteRepositoryGeneration(): number {
  return repositoryGeneration
}

/** 调整自动保存防抖（测试用；生产默认 600ms）。 */
export function configureAutosave(options: { delayMs?: number }): void {
  if (options.delayMs !== undefined) autosaveDelayMs = Math.max(0, options.delayMs)
}

/** 取消**所有**待执行的自动保存。 */
export function cancelAutosave(): void {
  for (const timer of autosaveTimers.values()) clearTimeout(timer)
  autosaveTimers.clear()
}

function cancelAutosaveFor(relPath: string): void {
  const timer = autosaveTimers.get(relPath)
  if (timer !== undefined) {
    clearTimeout(timer)
    autosaveTimers.delete(relPath)
  }
}

/**
 * 立即把**所有**未保存的文档写掉（窗口失焦/隐藏时调用，防止意外退出丢内容）。
 *
 * 分栏之后"同时脏两篇"是常态，所以这里不能只看当前那一篇 —— 漏掉一篇就是丢一份内容。
 */
export function flushAutosave(): void {
  for (const [relPath, doc] of Object.entries(useNoteStore.getState().docs)) {
    if (!doc.dirty || doc.conflict !== null) continue
    cancelAutosaveFor(relPath)
    void useNoteStore.getState().saveNowFor(relPath)
  }
}

function scheduleAutosaveFor(relPath: string): void {
  cancelAutosaveFor(relPath)
  autosaveTimers.set(
    relPath,
    setTimeout(() => {
      autosaveTimers.delete(relPath)
      const state = useNoteStore.getState()
      const doc = state.docs[relPath]
      // 冲突期间不自动重试：必须由用户在横幅里做出选择
      if (doc === undefined || doc.conflict !== null) return
      void state.saveNowFor(relPath)
    }, autosaveDelayMs),
  )
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function toOpenDocument(doc: NoteDoc): OpenDocument {
  return {
    relPath: doc.relPath,
    text: doc.text,
    format: doc.format,
    baseMtimeMs: doc.baseMtimeMs,
    sizeBytes: doc.sizeBytes,
    revision: doc.revision,
    openedAt: doc.openedAt,
  }
}

/** `docs[activePath]` 的视图。所有写入都必须经过它 —— 镜像与仓库永远不会各说一套。 */
function mirrors(docs: DocsMap, activePath: string | null): MirrorFields {
  const active = activePath === null ? undefined : docs[activePath]
  return {
    doc: active === undefined ? null : toOpenDocument(active),
    status: active?.status ?? 'idle',
    dirty: active?.dirty ?? false,
    error: active?.error ?? null,
    conflict: active?.conflict ?? null,
    loadMs: active?.loadMs ?? 0,
    lastSavedAt: active?.lastSavedAt ?? null,
    lastWriteMs: active?.lastWriteMs ?? null,
    lastWriteBytes: active?.lastWriteBytes ?? null,
    diskStats: active?.diskStats ?? null,
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

/**
 * 脏 / 冲突清单。
 *
 * 为什么放在 state 里而不是让订阅方自己 `filter`：标签条要按**引用**订阅
 * （`useNoteStore((s) => s.dirtyPaths)`）。每次 set 都新建数组的话，任何一次按键
 * 都会让每条标签重渲染一遍 —— 这里只集合真的变了才换新数组。
 */
function flagsOf(docs: DocsMap, previous: readonly string[], pick: (doc: NoteDoc) => boolean): readonly string[] {
  const next = Object.keys(docs).filter((relPath) => pick(docs[relPath] as NoteDoc))
  return sameList(next, previous) ? previous : next
}

/**
 * 把"直接 `setState` 注入的当前文档"收进仓库。
 *
 * 生产路径上文档一定经过 {@link NoteState.openDoc} 进仓库；但既有测试（以及少量旧代码）会
 * 直接 `useNoteStore.setState({ doc: … })` 来摆一个当前文档。这种注入不该在**下一次写入**
 * 时凭空消失，所以补一份仓库条目 —— 一句话：镜像里有、仓库里没有，就补进仓库。
 */
function adoptFromMirror(state: NoteState, relPath: string): NoteDoc | undefined {
  if (state.doc === null || state.doc.relPath !== relPath) return undefined
  return {
    ...state.doc,
    dirty: state.dirty,
    status: state.status,
    error: state.error,
    conflict: state.conflict,
    loadMs: state.loadMs,
    lastSavedAt: state.lastSavedAt,
    lastWriteMs: state.lastWriteMs,
    lastWriteBytes: state.lastWriteBytes,
    diskStats: state.diskStats,
  }
}

export const useNoteStore = create<NoteState>((set, get) => {
  /** 仓库里那一篇（没有就尝试从镜像收养一份）。 */
  const entryOf = (relPath: string): NoteDoc | undefined =>
    get().docs[relPath] ?? adoptFromMirror(get(), relPath)

  /** 镜像里的当前文档路径（旧 API 的"当前"口径）。 */
  const activeOf = (): string | null =>
    get().activePath ?? get().doc?.relPath ?? null

  /**
   * 唯一的状态写入口：改仓库 → 重算镜像与两份清单 → 上报。
   *
   * `mutate` 收到一份可改的 `docs` 副本与"此刻的当前路径"，返回新的当前路径：
   * - 返回**路径** → 当前文档换成它；
   * - 返回 `null` → **清空**当前文档（关闭这一篇 / 整仓清空）；
   * - 返回 `undefined` → 不动（改的是别的篇）。
   *
   * ⚠️ 三种返回必须分清楚：早先这里写成 `mutate(...) ?? activePath`，于是 `null` 被当成
   * "没给值"而保留旧路径 —— 直接后果是"关闭当前文档"根本关不掉（`doc` 还在），
   * 而 `line-jump`/`app-shell` 里"没打开任何笔记"的断言会莫名失败。
   *
   * 所有写入都走它，是因为镜像字段漏更新一次就会让状态栏/标签条各说一套，
   * 而这种 bug 只在"同时开着两篇"时才现形。
   */
  const commit = (
    mutate: (docs: DocsMap, activePath: string | null) => string | null | undefined,
  ): void => {
    set((state) => {
      const docs: DocsMap = { ...state.docs }
      const activePath = state.activePath ?? state.doc?.relPath ?? null
      // 注入形态：当前文档在镜像里、仓库里没有 → 先补进仓库，再改
      if (activePath !== null && docs[activePath] === undefined) {
        const adopted = adoptFromMirror(state, activePath)
        if (adopted !== undefined) docs[activePath] = adopted
      }
      const returned = mutate(docs, activePath)
      const nextActive = returned === undefined ? activePath : returned
      return {
        docs,
        activePath: nextActive,
        dirtyPaths: flagsOf(docs, state.dirtyPaths, (doc) => doc.dirty),
        conflictPaths: flagsOf(docs, state.conflictPaths, (doc) => doc.conflict !== null),
        ...mirrors(docs, nextActive),
      }
    })
  }

  /** 只改某一篇（它是当前文档时，镜像跟着变）。 */
  const patch = (relPath: string, mutate: (doc: NoteDoc) => NoteDoc | null): void => {
    commit((docs, activePath) => {
      const current = docs[relPath]
      if (current === undefined) return null
      const next = mutate(current)
      if (next === null) delete docs[relPath]
      else docs[relPath] = next
      return activePath
    })
  }

  /** 读一篇进仓库（可选择顺带设为当前）。 */
  const readInto = async (relPath: string, activate: boolean): Promise<boolean> => {
    const token = (readTokens.get(relPath) ?? 0) + 1
    readTokens.set(relPath, token)
    // ⚠️ **读成功之前绝不改当前文档**。改了会让 `tabs-store` 的订阅看到"文档没了"，
    // 于是它把激活项清空、新笔记变成"追加"而不是"顶掉当前那条"（实测：标签越开越多）。
    // 旧实现也是这个顺序 —— 读盘期间 `doc` 还是上一篇，成功那一刻才整篇换过去。
    commit((docs, activePath) => {
      const current = docs[relPath]
      if (current !== undefined) docs[relPath] = { ...current, status: 'loading', error: null }
      return activePath
    })
    // 旧 API 的"正在打开"：状态栏与 `tabs-store` 的恢复对账都读它。
    // 只对**要成为当前文档**的那次读上报 —— 分栏里读别人的正文不该改状态栏在说谁。
    if (activate) set({ status: 'loading', error: null })
    const started = nowMs()
    try {
      const content = await ipc.noteRead(relPath)
      if (readTokens.get(relPath) !== token) return false // 已被更新的请求取代
      const { text, format } = toEditorText(content.text)
      revisionCounter += 1
      commit((docs, activePath) => {
        docs[relPath] = {
          relPath,
          text,
          format,
          baseMtimeMs: content.mtimeMs,
          sizeBytes: content.sizeBytes,
          revision: revisionCounter,
          openedAt: Date.now(),
          dirty: false,
          status: 'ready',
          error: null,
          conflict: null,
          loadMs: Math.round(nowMs() - started),
          lastSavedAt: null,
          lastWriteMs: null,
          lastWriteBytes: null,
          diskStats: null,
        }
        return activate ? relPath : activePath
      })
      return true
    } catch (cause) {
      if (readTokens.get(relPath) !== token) return false
      const error = MimenoteError.from(cause)
      commit((docs, activePath) => {
        delete docs[relPath]
        return activate ? null : activePath
      })
      // 要成为当前文档的那一次失败：状态进错误态（状态栏/冲突横幅照旧读它）。
      // 分栏里读别人的正文失败不该污染当前文档的状态 —— 那一格自己就是空的。
      if (activate) set({ status: 'error', error })
      toast.error(describeError(error, '打开笔记失败'))
      return false
    }
  }

  const save = async (relPath: string, options: { force?: boolean } = {}): Promise<boolean> => {
    const force = options.force === true
    const doc = entryOf(relPath)
    if (doc === undefined) return false

    if (inFlight) {
      // 已有写入在途：标记"完成后再写一次"，保证最后一次编辑一定落盘
      pendingSaves.add(relPath)
      return false
    }

    inFlight = true
    cancelAutosaveFor(relPath)
    patch(relPath, (current) => ({ ...current, status: 'saving', error: null }))

    try {
      const payload = fromEditorText(doc.text, doc.format)
      const outcome = await ipc.noteWrite(
        doc.relPath,
        payload,
        doc.baseMtimeMs,
        force,
        useSettingsStore.getState().frontmatterTimestamps,
      )

      patch(relPath, (current) => {
        // 保存期间用户又改了内容 → 保持 dirty，交由下一轮自动保存
        const stillDirty = current.text !== doc.text
        return {
          ...current,
          baseMtimeMs: outcome.mtimeMs,
          sizeBytes: outcome.sizeBytes,
          status: 'ready',
          dirty: stillDirty,
          conflict: null,
          error: null,
          lastSavedAt: Date.now(),
          lastWriteMs: outcome.writtenInMs,
          lastWriteBytes: outcome.sizeBytes,
        }
      })
      set((state) => ({ saveCount: state.saveCount + 1 }))

      if (force) toast.success('已覆盖保存', `${displayPath(doc.relPath)}（${outcome.writtenInMs}ms）`)
      return true
    } catch (cause) {
      const error = MimenoteError.from(cause)
      if (error.isConflict) {
        patch(relPath, (current) => ({
          ...current,
          status: 'conflict',
          dirty: true,
          error,
          conflict: { currentMtimeMs: error.currentMtimeMs ?? 0, detectedAt: Date.now() },
        }))
        return false
      }
      patch(relPath, (current) => ({ ...current, status: 'error', error }))
      toast.error(describeError(error, '保存失败'))
      return false
    } finally {
      inFlight = false
      const queued = [...pendingSaves]
      pendingSaves.clear()
      for (const queuedPath of queued) scheduleAutosaveFor(queuedPath)
    }
  }

  const reloadDoc = async (relPath: string, options: { silent?: boolean } = {}): Promise<void> => {
    const doc = entryOf(relPath)
    if (doc === undefined) return
    const started = nowMs()
    const token = (readTokens.get(relPath) ?? 0) + 1
    readTokens.set(relPath, token)
    try {
      const content = await ipc.noteRead(relPath)
      if (readTokens.get(relPath) !== token) return
      const { text, format } = toEditorText(content.text)
      revisionCounter += 1
      patch(relPath, (current) => ({
        ...current,
        text,
        format,
        baseMtimeMs: content.mtimeMs,
        sizeBytes: content.sizeBytes,
        revision: revisionCounter,
        openedAt: Date.now(),
        status: 'ready',
        dirty: false,
        error: null,
        conflict: null,
        loadMs: Math.round(nowMs() - started),
      }))
      // `silent`：外部改动触发的那次重载由调用方给一条更贴切的提示（ADR-0016）
      if (!options.silent) toast.info('已从磁盘重新加载', doc.relPath)
    } catch (cause) {
      const error = MimenoteError.from(cause)
      patch(relPath, (current) => ({ ...current, status: 'error', error }))
      toast.error(describeError(error, '重新加载失败'))
    }
  }

  const externalChange = (relPath: string, currentMtimeMs: number): void => {
    const doc = entryOf(relPath)
    if (doc === undefined) return
    // 刻意**不动** `dirty`：这次冲突是"磁盘被别人改了"，本地一个字符都没改，
    // 谎报 dirty 会让标签页上的 ● 与关闭窗口时的"有未保存修改"确认框凭空出现
    patch(relPath, (current) => ({
      ...current,
      status: 'conflict',
      conflict: { currentMtimeMs, detectedAt: Date.now() },
    }))
  }

  const applyExternal = async (
    relPath: string,
    { currentMtimeMs, removed = false }: { currentMtimeMs: number; removed?: boolean },
  ): Promise<void> => {
    const doc = entryOf(relPath)
    if (doc === undefined) return

    // 待写的防抖保存先取消：它带着的是"看到磁盘新版本之前"的文本
    cancelAutosaveFor(relPath)

    if (doc.dirty || doc.conflict !== null) {
      // 有未保存内容（或已经处于冲突态）→ 只进冲突态，一个字节都不写：
      // 与保存时撞上外部改动完全同一套语义，交给横幅里的用户决定
      externalChange(relPath, currentMtimeMs)
      return
    }

    if (removed) {
      // 磁盘上这篇已经不在了（被删掉或改名搬走）。编辑器里留着最后一次读到的内容，
      // 但不假装"重新加载成功"——后台标签会被 `tabs-store` 按条目表剪掉。
      toast.warn('磁盘上的这篇笔记已被删除或移动', doc.relPath)
      return
    }

    await reloadDoc(relPath, { silent: true })
    // 重载失败（例如刚被删掉）时 `reload` 自己已经给了错误提示，不在这里再补一条
    if (entryOf(relPath)?.status === 'ready') {
      toast.info('已在磁盘上更新，已重新加载', doc.relPath)
    }
  }

  return {
    docs: {},
    activePath: null,
    dirtyPaths: [],
    conflictPaths: [],
    ...mirrors({}, null),
    saveCount: 0,

    // ---- 当前文档（旧 API）-------------------------------------------------------

    open: async (relPath) => {
      const current = get()
      // 已经是当前文档（含"直接 setState 注入"的形态）→ 什么都不用做，绝不重读
      const loaded = current.docs[relPath] !== undefined || current.doc?.relPath === relPath
      if (loaded && activeOf() === relPath) return true

      // 切换前先落盘（冲突态除外：那种情况必须由用户决定）
      const active = activeOf()
      const activeDoc = active === null ? undefined : current.docs[active]
      if (active !== null && activeDoc !== undefined && activeDoc.dirty && activeDoc.conflict === null) {
        await save(active, {})
      }
      if (active !== null) cancelAutosaveFor(active)

      if (!isMarkdown(relPath)) {
        toast.warn('M1 只能编辑 Markdown 文件', relPath)
        return false
      }

      // 已经在仓库里（别的格子里开着）：
      // - **有未保存内容** → 只切当前文档，绝不重读（重读会把那一格里还没落盘的编辑吃掉）；
      // - **干净** → 照旧**重新读盘**。这一条是必须的：重命名 / 移动会**外部改写别的笔记**
      //   （改指向它的链接），而阅读视图渲染的是内存里的正文 —— 不重读就会一直显示旧链接
      //   （真实回归：`ui.e2e.test.ts` 的"重命名笔记…并验证可逆"）。
      if (get().docs[relPath] !== undefined) {
        const entry = get().docs[relPath]
        if (entry !== undefined && (entry.dirty || entry.conflict !== null)) {
          get().activateDoc(relPath)
          return true
        }
        return readInto(relPath, true)
      }

      commit((_docs, activePath) => activePath) // 先把注入形态收进仓库（若有）
      return readInto(relPath, true)
    },

    setText: (text) => {
      const relPath = activeOf()
      if (relPath === null) return
      get().setTextFor(relPath, text)
    },

    saveNow: async (options) => {
      const relPath = activeOf()
      if (relPath === null) return false
      return save(relPath, options ?? {})
    },

    noteExternalChange: (currentMtimeMs) => {
      const relPath = activeOf()
      if (relPath === null) return
      externalChange(relPath, currentMtimeMs)
    },

    applyExternalChange: async (change) => {
      const relPath = activeOf()
      if (relPath === null) return
      await applyExternal(relPath, change)
    },

    resolveConflict: async (choice) => {
      const relPath = activeOf()
      if (relPath === null) return
      await get().resolveConflictFor(relPath, choice)
    },

    reload: async (options) => {
      const relPath = activeOf()
      if (relPath === null) return
      await reloadDoc(relPath, options ?? {})
    },

    close: () => {
      const relPath = activeOf()
      if (relPath === null) return
      get().closeDoc(relPath)
    },

    retarget: (newRelPath, mtimeMs) => {
      const relPath = activeOf()
      if (relPath === null) return
      cancelAutosaveFor(relPath)
      commit((docs, activePath) => {
        const doc = docs[relPath]
        if (doc === undefined) return activePath
        delete docs[relPath]
        docs[newRelPath] = { ...doc, relPath: newRelPath, baseMtimeMs: mtimeMs, status: 'ready', error: null, conflict: null }
        return activePath === relPath ? newRelPath : activePath
      })
    },

    applyWrittenText: (diskText, { mtimeMs, sizeBytes }) => {
      const relPath = activeOf()
      if (relPath === null) return
      // 待写的那次防抖保存必须取消：它的文本是"改标签之前"的，写下去等于撤销这次改动
      cancelAutosaveFor(relPath)
      const { text, format } = toEditorText(diskText)
      revisionCounter += 1
      patch(relPath, (current) => ({
        ...current,
        text,
        format,
        baseMtimeMs: mtimeMs,
        sizeBytes,
        revision: revisionCounter,
        status: 'ready',
        dirty: false,
        error: null,
        conflict: null,
      }))
    },

    refreshDiskStats: async () => {
      const relPath = activeOf()
      if (relPath === null) return
      await get().refreshDiskStatsFor(relPath)
    },

    // ---- 按篇 --------------------------------------------------------------------

    docOf: (relPath) => get().docs[relPath] ?? null,

    openDoc: async (relPath) => {
      if (!isMarkdown(relPath)) return false
      if (get().docs[relPath] !== undefined) return true
      commit((_docs, activePath) => activePath) // 先把注入形态收进仓库（若有）
      return readInto(relPath, false)
    },

    activateDoc: (relPath) => {
      commit((docs, activePath) => (docs[relPath] === undefined ? activePath : relPath))
    },

    setTextFor: (relPath, text) => {
      const doc = entryOf(relPath)
      if (doc === undefined || doc.text === text) return
      patch(relPath, (current) => ({
        ...current,
        text,
        dirty: true,
        status: current.status === 'saving' || current.status === 'conflict' ? current.status : 'ready',
      }))
      // 冲突期间不自动重试：必须由用户在横幅里做出选择
      if (doc.conflict === null) scheduleAutosaveFor(relPath)
    },

    saveNowFor: async (relPath, options) => save(relPath, options ?? {}),

    reloadFor: async (relPath, options) => reloadDoc(relPath, options ?? {}),

    resolveConflictFor: async (relPath, choice) => {
      if (choice === 'overwrite') {
        await save(relPath, { force: true })
      } else {
        await reloadDoc(relPath, {})
      }
    },

    noteExternalChangeFor: (relPath, currentMtimeMs) => externalChange(relPath, currentMtimeMs),

    applyExternalChangeFor: async (relPath, change) => applyExternal(relPath, change),

    refreshDiskStatsFor: async (relPath) => {
      const doc = entryOf(relPath)
      if (doc === undefined) return
      try {
        const result = await ipc.noteStats(relPath)
        patch(relPath, (current) => (current.relPath === relPath ? { ...current, diskStats: result.stats } : current))
      } catch {
        // 统计失败不影响编辑（例如文件刚被外部删除）
      }
    },

    closeDoc: (relPath) => {
      cancelAutosaveFor(relPath)
      readTokens.set(relPath, (readTokens.get(relPath) ?? 0) + 1)
      commit((docs, activePath) => {
        delete docs[relPath]
        return activePath === relPath ? null : activePath
      })
    },

    closeDocs: (relPaths) => {
      for (const relPath of relPaths) cancelAutosaveFor(relPath)
      commit((docs, activePath) => {
        for (const relPath of relPaths) delete docs[relPath]
        return activePath !== null && relPaths.includes(activePath) ? null : activePath
      })
    },

    closeAll: () => {
      cancelAutosave()
      readTokens.clear()
      repositoryGeneration += 1
      commit((docs) => {
        for (const relPath of Object.keys(docs)) delete docs[relPath]
        return null
      })
    },
  }
})

/** 当前是否存在未保存内容（窗口关闭拦截用）—— **任何**一篇都算。 */
export function hasUnsavedChanges(): boolean {
  const state = useNoteStore.getState()
  return Object.values(state.docs).some((doc) => doc.dirty)
}

/** 当前文档路径（没有就是 `null`）。 */
export function activeNotePath(): string | null {
  const state = useNoteStore.getState()
  return state.activePath ?? state.doc?.relPath ?? null
}

/**
 * 某篇**已打开**文档的文本（没打开 → `undefined`）。
 *
 * 为什么需要它：属性面板要拿到"正文已就位"的那一份 frontmatter，而编辑器组件的挂载时机
 * 可能早于正文到达（分栏里的格子是挂载之后才读盘的）。渲染期同步读一次 store 是安全的 ——
 * 换笔记时 `open()`/`openDoc()` 已经把新文本写进仓库了；而**绝不能订阅 `text`**
 * （每条按键都重渲染是 `MarkdownEditor` 文件头明令禁止的）。
 */
export function openNoteText(relPath: string): string | undefined {
  return useNoteStore.getState().docs[relPath]?.text
}
