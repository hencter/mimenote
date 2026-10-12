/**
 * 「从模板新建」的编排：读模板 → 建笔记 → 展开 → 落盘 → 打开 + 落光标。
 *
 * ## 顺序为什么是"先建后展开"
 * `@title` / `@filename` / `@path` 取的是**这篇新笔记**的名字，而这个名字由宿主定
 * （`note_create` 遇到同名会加后缀）。自己先猜一个路径再去 `note_write`，在同名时
 * 会写进另一篇笔记或直接报冲突 —— 所以先 `noteCreate` 拿到真实的 `relPath` 与版本令牌，
 * 再展开、再 `noteWrite`（`baseMtimeMs` 必须用创建时返回的那个，ADR-0004）。
 *
 * ## `@prompt` 在展开之前问完
 * 由调用方（`TemplatePickerDialog`）先 `collectTemplatePrompts` 收集标签、把答案装进
 * `promptAnswers`，这里才展开。展开因此是**同步纯函数**，没有"展开到一半弹输入框"
 * 这种能打断创建链路的分支（见 `domain/template/expand.ts` 的模块头）。
 *
 * ## 时间挂钩（ADR-0044）
 * `noteCreate` / `noteWrite` 都带上设置里的 `frontmatterTimestamps`，与"普通新建 + 保存"
 * 走同一条链路：设置关着（默认）时模板自己写的 `created: @now` 就是最终值；
 * 开着时挂钩写的也是同一个时刻，两者不打架。
 *
 * ## 为什么这一层可以 import `app/actions`
 * 打开笔记**只有一条路径**（`openNote`：切走前落盘 → 读取 → 同步文件树选中项），
 * 这条纪律在 `app/actions.ts` 的头部写着；`features/editor/cm/live-preview/plugin.ts`
 * 的"点击悬空链接建笔记"也是这么用的（同一个"高层动作"调用方）。在 feature 层复制一套
 * "打开笔记"的顺序约束，正是那条规定要防的事。
 */

import { Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { openNote, targetDirectoryForNewNote } from '@/app/actions'
import { basename, displayName } from '@/domain/paths'
import { collectTemplatePrompts, expandTemplate, type TemplateNote } from '@/domain/template/expand'
import { findEditorView } from '@/features/editor/line-jump'
import { ipc } from '@/ipc/client'
import type { NoteContent } from '@/ipc/types'
import { MimenoteError, describeError } from '@/ipc/types'
import { useNoteStore } from '@/state/note-store'
import { useSettingsStore } from '@/state/settings-store'
import { useTemplateStore } from '@/state/template-store'
import { toast } from '@/state/toast-store'
import { useVaultStore } from '@/state/vault-store'

import { readClipboardText } from './clipboard-text'

/** 没给标题时的兜底（与 `app/actions.createNoteIn` 的默认值一致）。 */
export const DEFAULT_NOTE_TITLE = '未命名笔记'

export interface CreateFromTemplateInput {
  /**
   * 模板正文 —— **已经读到的那一份**（{@link readTemplateForCreate} 的返回值里那个）。
   *
   * 为什么不让这里自己按路径再读一次：对话框要先读一遍算出"要问哪些 `@prompt`"，
   * 若创建时再读第二遍，两次之间文件被改过就会出现"问的问题与展开的正文对不上"。
   * 一份文本、一次读取，这里只消费。
   */
  templateText: string
  /** 模板文件的 Vault 相对路径（只用于提示与排障；正文以 `templateText` 为准）。 */
  templateRelPath?: string
  /** 新笔记的标题（不含扩展名）；不传 = {@link DEFAULT_NOTE_TITLE}。 */
  title?: string
  /** 目标目录（Vault 相对，`''` = 根）；不传 = 当前选中的目录（同"新建笔记"）。 */
  parentRel?: string
  /** `@prompt` 的答案（键 = `@prompt=标签` 里的标签）。 */
  promptAnswers?: ReadonlyMap<string, string>
}

export interface CreatedFromTemplate {
  /** 写入后的笔记（**版本令牌是写入之后的值**，条目表要用它，否则下次外部改动会对不上）。 */
  note: NoteContent
  /** 展开过程中的非阻断提示（设计 02 §6：不阻断，但界面要说出来）。 */
  notes: TemplateNote[]
}

/** 打开模板选择对话框（命令 `template.newFrom` 的入口）。 */
export async function openTemplatePicker(dir?: string): Promise<void> {
  await useTemplateStore.getState().openPicker(dir)
}

/** 选中一个模板后读到的正文，以及它要问用户的那几个 `@prompt` 标签。 */
export interface PreparedTemplate {
  templateRelPath: string
  text: string
  /** `@prompt` 的标签（按出现顺序、同标签去重）——对话框据此渲染第二步的输入框。 */
  prompts: string[]
}

/**
 * 读模板正文并算出要问的问题（对话框第一步 → 第二步的入口）。
 *
 * 只有这一处读模板正文："展开"与"要问哪些问题"必须看**同一份文本**（先读一次得出问题、
 * 创建时再读一次的话，两次之间文件被改了就会问出错的问题）。
 */
export async function readTemplateForCreate(templateRelPath: string): Promise<PreparedTemplate | null> {
  try {
    const file = await ipc.noteRead(templateRelPath)
    return {
      templateRelPath,
      text: file.text,
      prompts: collectTemplatePrompts(file.text),
    }
  } catch (cause) {
    toast.error(describeError(MimenoteError.from(cause), '读取模板失败'))
    return null
  }
}

/**
 * 从模板新建一篇笔记并打开它。
 *
 * 失败（模板读不到 / 建不了 / 写不了）时弹一条 toast 并返回 `null`；**展开里的非阻断提示
 * 不在这里弹** —— 它由调用方决定怎么呈现（对话框可以一次性列出来），返回值带走它们。
 */
export async function createNoteFromTemplate(
  input: CreateFromTemplateInput,
): Promise<CreatedFromTemplate | null> {
  try {
    const title = normalizeTitle(input.title)
    const parentRel = input.parentRel ?? targetDirectoryForNewNote()
    const stampTimes = useSettingsStore.getState().frontmatterTimestamps

    const created = await ipc.noteCreate(parentRel, title, stampTimes)
    // 剪贴板读**一次**、整篇共用（`@clipboard` 出现两次时两次读可能拿到不同的内容）
    const clipboard = await readClipboardText()
    const expansion = expandTemplate(input.templateText, {
      now: new Date(),
      // 标题按 ADR-0030 的 `displayName` 口径；展开器只消费算好的值，不碰路径字符串
      title: displayName(created.relPath),
      filename: basename(created.relPath),
      path: created.relPath,
      vault: useVaultStore.getState().info?.name ?? '',
      clipboard,
      prompt: (label) => input.promptAnswers?.get(label) ?? '',
    })

    const written = await ipc.noteWrite(
      created.relPath,
      expansion.text,
      created.mtimeMs,
      false,
      stampTimes,
    )
    const note: NoteContent = {
      relPath: created.relPath,
      text: expansion.text,
      sizeBytes: written.sizeBytes,
      mtimeMs: written.mtimeMs,
    }

    // 条目表就地插入（不重扫）：新建笔记只有这一条增量，与 `createNoteIn` 同一套收尾
    const vault = useVaultStore.getState()
    vault.registerCreatedNote(note)
    vault.revealPath(note.relPath)
    const opened = await openNote(note.relPath)
    if (opened) {
      // `@cursor` 的落点；没有记号时落在**文档末尾**（设计 02 §6）
      placeCaretWhenReady(note.relPath, expansion.cursor ?? expansion.text.length)
    }
    return { note, notes: expansion.notes }
  } catch (cause) {
    toast.error(
      describeError(MimenoteError.from(cause), '从模板新建失败'),
      input.templateRelPath,
    )
    return null
  }
}

/** 标题归一化：空白标题退回默认值（与 `createNoteIn` 的默认值同一档）。 */
function normalizeTitle(title: string | undefined): string {
  const trimmed = title?.trim() ?? ''
  return trimmed === '' ? DEFAULT_NOTE_TITLE : trimmed
}

// ---------------------------------------------------------------------------
// 落光标
// ---------------------------------------------------------------------------

/** 排队中的落点令牌：只有最后一次生效（与 `line-jump.ts` 的 `jumpToken` 同一个理由）。 */
let caretToken = 0

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/** 下一帧执行（没有 rAF 的环境退化成宏任务，语义不变：晚一拍）。 */
function nextFrame(run: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(run)
    return
  }
  setTimeout(run, 0)
}

/**
 * 等编辑器里装上 `relPath` 这篇文档，然后把光标落到**精确偏移**（`@cursor` 的落点）。
 *
 * 为什么不复用 `line-jump.ts` 的 `jumpToLineWhenReady`：那个定位器按**行**工作
 * （`locateLine` 派发的是 `selection: { anchor: 行首 }`）—— 搜索结果与反向链接只需要
 * "跳到哪一行"，而 `@cursor` 可以写在句子中间（`会议记录：@cursor`），按行首落会偏掉。
 * 于是这里保留同一套"按帧重试、直到文档真的进了编辑器"的语义（同样的令牌 + 超时），
 * 只把落点从行首换成给定偏移；"怎么找到当前编辑器"仍然用同一个 {@link findEditorView}，
 * 不另造一份判据。
 *
 * 放弃是静默的（与 `jumpToLineWhenReady` 一致）：用户看到的是"笔记打开了但光标在开头"，
 * 而落点本来就是增强；超时之后绝不能再把光标挪走（用户可能已经开始打字了）。
 */
export function placeCaretWhenReady(
  relPath: string,
  offset: number,
  options: { timeoutMs?: number } = {},
): () => void {
  const token = (caretToken += 1)
  const deadline = nowMs() + (options.timeoutMs ?? 1_500)
  let cancelled = false

  const attempt = (): void => {
    if (cancelled || token !== caretToken) return
    const view = findEditorView()
    if (view !== null && holdsNote(view, relPath)) {
      // 只改选区的事务**默认会进撤销历史**（history 会把 `tr.selection` 记一条），
      // 那样用户按 Ctrl+Z 会先把光标弹回开头，而不是撤销上一次真正的编辑
      const at = Math.min(Math.max(offset, 0), view.state.doc.length)
      view.dispatch({
        selection: { anchor: at },
        effects: EditorView.scrollIntoView(at, { y: 'center' }),
        annotations: Transaction.addToHistory.of(false),
        scrollIntoView: false,
      })
      view.focus()
      return
    }
    if (nowMs() >= deadline) return
    nextFrame(attempt)
  }

  // 第一帧之后再动手：打开笔记要经过 React 提交 → `revision` effect → 整篇替换
  nextFrame(attempt)
  return () => {
    cancelled = true
  }
}

/** 这个编辑器里现在装的**就是**这篇笔记吗（路径 + 正文逐字一致）。 */
function holdsNote(view: EditorView, relPath: string): boolean {
  const doc = useNoteStore.getState().doc
  if (doc === null || doc.relPath !== relPath) return false
  // 先比长度再比内容：整篇替换还没跑时长度通常就不一样，先短路掉绝大多数全量比较
  if (view.state.doc.length !== doc.text.length) return false
  return view.state.doc.toString() === doc.text
}

// ---------------------------------------------------------------------------
// 提示文案
// ---------------------------------------------------------------------------

/**
 * 把展开的非阻断提示拼成一句人话（没有提示时返回 `null`）。
 *
 * 文案放在 feature 层而不是 `domain/`：domain 只回稳定 kinds（`TemplateNoteKind`），
 * 怎么称呼它们属于界面（与 `describeError` / `tag-rename.ts` 的分工一致）。
 */
export function describeTemplateNotes(notes: readonly TemplateNote[]): string | null {
  if (notes.length === 0) return null
  const unknown = notes.filter((note) => note.kind === 'unknown').map((note) => note.raw)
  const parts: string[] = []
  if (unknown.length > 0) parts.push(`未识别的记号已原样保留：${unknown.join('、')}`)
  if (notes.some((note) => note.kind === 'extra-cursor')) {
    parts.push('模板里有多个 @cursor，只有第一个生效（其余原样保留）')
  }
  if (notes.some((note) => note.kind === 'clipboard-missing')) {
    parts.push('剪贴板里没有内容，@clipboard 展开成了空')
  }
  return parts.length === 0 ? null : parts.join('；')
}
