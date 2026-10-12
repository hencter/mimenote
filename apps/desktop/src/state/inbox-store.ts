/**
 * 收件箱状态：面板开关 + 捕获（单篇 / 当日两种语义）+ 条目的派生读取。
 *
 * ## 为什么单独一个 store
 * 它回答的是"我现在要把一句话放进收件箱 / 我现在要看收件箱"——生命周期跟着那两层面板走，
 * 与 `vault-store`（"这个 Vault 长什么样"）不是一回事（与 `trash-store` / `tags-store`
 * 分开的理由同源）。它**不**碰别人的字段：捕获写完只调用既有的登记动作
 * （`registerCreatedNote` / `registerRenamedNote` / `applyExternalChange`），
 * 移动（归档）走 `app/actions.moveEntry`。
 *
 * ## 为什么列表不放在这里
 * 条目表的唯一真相是 `vault-store.entries`（打开 Vault 时扫一次的快照，随外部改动刷新）。
 * 这里再存一份"收件箱列表"，迟早出现"树里刷新了、列表还是旧的"。所以本 store 只存
 * "怎么显示、怎么捕获"，条目用 {@link inboxEntriesOf} 现算 —— React 侧包一层 memo，
 * 见 `features/inbox/use-inbox-entries.ts`。
 *
 * ## 目录与配置来源
 * **收件箱目录不在这里存第二份**：真相是 `settings-store.inboxDir`（它的上游是 Vault 内的
 * 配置文件 `[inbox] dir`，设计 01 §2）。本模块每次调用时现读（`useSettingsStore`），
 * 于是"改配置"与"看列表/计数/捕获"永远看同一个值 —— 在这里缓存一份字段就会出现
 * "设置里改了、列表还在看老目录"。本 store 也**不写**配置：写配置是设置层与配置文件的职责。
 *
 * 完整规格见 `docs/design/03-inbox.md`，决定见 ADR-0057。
 */

import { create } from 'zustand'

import { fromEditorText, toEditorText } from '@/domain/eol'
import {
  appendCaptureEntry,
  inboxDailyPath,
  inboxDailyTitle,
  inboxEntries,
  inboxNoteTitle,
  isInboxEntry,
  mergeCapturedBody,
} from '@/domain/inbox'
import { ipc } from '@/ipc/client'
import { MimenoteError, describeError } from '@/ipc/types'
import type { EntryMeta, NoteContent } from '@/ipc/types'
import { useNoteStore } from './note-store'
import { useSettingsStore } from './settings-store'
import { toast } from './toast-store'
import { useVaultStore } from './vault-store'

/** 捕获语义（对应配置键 `inbox.dailyNote` 的两种取值）。 */
export type InboxCaptureMode = 'note' | 'daily'

/** 收件箱的两层面板（共用一个挂载点，见 `features/inbox/InboxHost.tsx`）。 */
export type InboxPanel = 'closed' | 'capture' | 'list'

export interface InboxState {
  /** 捕获语义：`note` = 一条一篇；`daily` = 追加到 `Inbox/YYYY-MM-DD.md`。 */
  captureMode: InboxCaptureMode
  /** 当前显示哪一层。 */
  panel: InboxPanel
  /** 捕获进行中（连按回车不写第二条）。 */
  capturing: boolean
  /** 最近一次捕获的宿主错误（界面展示用；下一次捕获开始时清掉）。 */
  error: MimenoteError | null

  /**
   * 配置键 `inbox.dailyNote` 的接线点（`true` → `'daily'`）。
   *
   * 目录**没有**这样的 setter：它读 `settings-store.inboxDir`（见文件头）。
   */
  setCaptureMode: (mode: InboxCaptureMode) => void

  openCapture: () => void
  openList: () => void
  close: () => void

  /**
   * 捕获一句话。成功返回落盘后的相对路径（调用方据此提示/关闭面板）；
   * 失败返回 `null` 并把宿主错误留在 `error` 里（输入框内容由调用方保留）。
   */
  capture: (text: string) => Promise<string | null>
}

/** 收件箱条目（现算；已按 mtime 倒序）。React 侧请用 `features/inbox/use-inbox-entries.ts`。 */
export function inboxEntriesOf(
  entries: readonly EntryMeta[],
  dir: string = inboxDir(),
): EntryMeta[] {
  return inboxEntries(entries, dir)
}

/**
 * 未整理计数（命令面板/状态栏这类非 React 环境用）。
 *
 * 口径：**仍在收件箱目录之内的条目数**——"归档 = 移出目录"，因此计数与"还有几条没整理"
 * 是同一个数。刻意不引入第二套标记（frontmatter 字段/标签/状态表），理由见设计 03 §3。
 */
export function inboxCount(dir: string = inboxDir()): number {
  return useVaultStore.getState().entries.filter((entry) => isInboxEntry(entry.relPath, dir)).length
}

/**
 * 收件箱目录（Vault 相对路径）—— 唯一来源是设置层的 `inboxDir`。
 *
 * 刻意不在这里再存一份：`inboxEntriesOf` / `inboxCount` / `capture` 全都现读它，
 * 于是"改配置"与"看列表"必然一致。归一化交给 `domain/inbox`（判据那一份）。
 */
export function inboxDir(): string {
  return useSettingsStore.getState().inboxDir
}

/**
 * 在收件箱目录里新建一篇笔记（目录还不存在时兜底）。
 *
 * 为什么需要兜底：真实宿主的 `note_create` **要求父目录已存在**
 * （`commands/notes.rs` 的 `create_note` 走 `resolve_existing`，缺失即 `NOT_FOUND`），
 * 而 Mock 适配器会自动补父目录（`dirs.add(parentRel)`）。只按 Mock 的行为写，
 * 结果就是"E2E 全绿、真机上第一次捕获报错"。
 *
 * 兜底路径用既有命令搭出来：先在 Vault 根创建，再 `note_move` 搬进去 —— 宿主的
 * `note_move` 会创建目标父目录（与「移动到…」输入一个还不存在的目录是同一件事）。
 * `updateLinks = false`：这是一篇刚创建的笔记，磁盘上不可能有指向它的链接，
 * 跳过全库链接改写这一步是诚实的（不是"为了快而漏掉"）。
 */
async function createNoteInInbox(
  dir: string,
  title: string,
  stampTimes: boolean,
): Promise<NoteContent> {
  try {
    const created = await ipc.noteCreate(dir, title, stampTimes)
    useVaultStore.getState().registerCreatedNote(created)
    return created
  } catch (cause) {
    const error = MimenoteError.from(cause)
    if (error.code !== 'NOT_FOUND') throw error

    const atRoot = await ipc.noteCreate('', title, stampTimes)
    useVaultStore.getState().registerCreatedNote(atRoot)
    const outcome = await ipc.noteMove(atRoot.relPath, dir, null, false)
    useVaultStore.getState().registerRenamedNote(outcome)
    return { ...atRoot, relPath: outcome.newRelPath, mtimeMs: outcome.newMtimeMs }
  }
}

/**
 * 单篇模式：建一篇新笔记，正文就是用户写的那句话（设计 03 §2.2）。
 *
 * 两次 IPC 是必须的：宿主的 `note_create` 只会写 `# 标题` 或 frontmatter 块，
 * 没有"带正文创建"的命令（新增宿主命令超出本轮范围）。第二次写用第一次返回的
 * `mtimeMs` 作版本令牌：中途有别人动过这个文件 → `CONFLICT`、一个字节都不写。
 * 第二次失败时磁盘上留着一篇只有标题的笔记（标题里就有首行摘要），内容不算丢。
 */
async function captureAsNote(dir: string, text: string, at: Date): Promise<string> {
  const stampTimes = useSettingsStore.getState().frontmatterTimestamps
  const created = await createNoteInInbox(dir, inboxNoteTitle(text, at), stampTimes)
  // 第二次写不带 `stampTimes`：frontmatter 块刚由 `note_create` 写好（`created`/`updated` 都
  // 是这一刻），这里只是把正文填进去 —— 再挂钩一次只会让 `updated` 比 `created` 大一秒
  await ipc.noteWrite(
    created.relPath,
    mergeCapturedBody(created.text, text),
    created.mtimeMs,
    false,
    false,
  )
  return created.relPath
}

/**
 * 当日模式：追加到 `Inbox/YYYY-MM-DD.md`（设计 03 §2.3）。
 *
 * 三条纪律：读回来的 `mtimeMs` 当版本令牌（冲突就退出、不自动重试）、
 * BOM 与换行风格经 `domain/eol.ts` 原样还原、目标正被编辑且有未保存内容时**拒绝**
 * （编辑器内存与磁盘是两条写入路径，同时成立必然有一方看不见另一方）。
 */
async function captureIntoDaily(dir: string, text: string, at: Date): Promise<string | null> {
  const canonical = inboxDailyPath(dir, at)
  const openDoc = useNoteStore.getState().docOf(canonical)
  if (openDoc !== null && (openDoc.dirty || openDoc.conflict !== null)) {
    toast.warn(
      '当日笔记正在编辑中',
      `${canonical} 还有未保存的内容：先保存或关掉那一篇，或者改用单篇捕获（inbox.dailyNote = false）`,
    )
    return null
  }

  const stampTimes = useSettingsStore.getState().frontmatterTimestamps
  let raw: string
  let mtimeMs: number
  let target = canonical
  try {
    const content = await ipc.noteRead(canonical)
    raw = content.text
    mtimeMs = content.mtimeMs
  } catch (cause) {
    const error = MimenoteError.from(cause)
    if (error.code !== 'NOT_FOUND') throw error
    const created = await createNoteInInbox(dir, inboxDailyTitle(at), stampTimes)
    raw = created.text
    mtimeMs = created.mtimeMs
    // 兜底路径可能因为根目录已有同名文件而落到 `YYYY-MM-DD 1.md`：以**实际**路径为准
    target = created.relPath
  }

  const { text: editorText, format } = toEditorText(raw)
  const appended = appendCaptureEntry(editorText, text, at)
  await ipc.noteWrite(target, fromEditorText(appended, format), mtimeMs, false, stampTimes)

  /*
    条目表里的 mtime 变了 —— 排序（mtime 倒序）要跟着变，否则刚捕获的那条会停在原位。
    走的是既有那条**静默**对齐路径：这次写入没经过编辑器，从编辑器那边看就是"磁盘被改了"
    （`applyExternalChange` 的语义），而且它带请求序号，与 watcher 随后推来的那次重扫
    不会互相盖掉（旧快照自己会被丢掉）。`rescan()` 也能对齐，但它会弹一条"已重扫 N 条目"，
    对一次人触发的捕获来说那是噪音。
  */
  void useVaultStore.getState().applyExternalChange({
    paths: [target],
    truncated: false,
    changes: 1,
    detectedAtMs: Date.now(),
  })
  return target
}

export const useInboxStore = create<InboxState>((set, get) => ({
  captureMode: 'note',
  panel: 'closed',
  capturing: false,
  error: null,

  setCaptureMode: (mode) => {
    set({ captureMode: mode === 'daily' ? 'daily' : 'note' })
  },

  openCapture: () => {
    // 打开即清掉上一次的错误：面板刚打开就红着一条"捕获失败"，用户不知道那是旧的
    set({ panel: 'capture', error: null })
  },

  openList: () => {
    set({ panel: 'list', error: null })
  },

  close: () => {
    // 面板开关不进任何持久化（与 paletteMode / trashDialogOpen 同一类瞬时状态）
    set({ panel: 'closed' })
  },

  capture: async (text) => {
    const body = text.trim()
    // 空输入不是错误（用户按了回车又删了而已）：不建文件、不报错、面板留着
    if (body === '' || get().capturing) return null
    if (useVaultStore.getState().info === null) {
      toast.warn('还没有打开 Vault', '收件箱是 Vault 里的一个目录，先打开一个 Vault')
      return null
    }

    set({ capturing: true, error: null })
    try {
      const { captureMode } = get()
      const dir = inboxDir()
      const at = new Date()
      const relPath =
        captureMode === 'daily'
          ? await captureIntoDaily(dir, body, at)
          : await captureAsNote(dir, body, at)
      // `null` = 当日模式自己拒绝的那条路（已经给过具体提示），不当作成功也不报错
      if (relPath === null) return null
      toast.success('已捕获', relPath)
      return relPath
    } catch (cause) {
      const error = MimenoteError.from(cause)
      set({ error })
      toast.error(describeError(error, '捕获失败'))
      return null
    } finally {
      set({ capturing: false })
    }
  },
}))
