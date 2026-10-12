/**
 * app/actions/notes.ts —— 笔记的打开、新建、保存、删除（含"打开并定位到行"）（从 app/actions.ts 逐字搬出，只加了 export 与 import）。
 *
 * 为什么拆：1018 行的组合根动作文件里，"打开一篇笔记"与"改一个标签"的代码彼此无关，
 * 任何一次定位都要通读全文件。拆完 `app/actions.ts` 保留为**再导出壳**，39 处
 * `features → app/actions` 的调用点一行不改（ADR-0060 §3(c)）。
 */
import { basename, isMarkdown, parentOf } from '@/domain/paths'
import { jumpToLineWhenReady } from '@/features/editor/line-jump'
import { ipc } from '@/ipc/client'
import { MimenoteError, describeError } from '@/ipc/types'
import type { RenameOutcome } from '@/ipc/types'
import { useConfirmStore } from '@/state/confirm-store'
import { useLinksStore } from '@/state/links-store'
import { hasUnsavedChanges, useNoteStore } from '@/state/note-store'
import { useSettingsStore } from '@/state/settings-store'
import { captureCaretFor, openNextNoteInNewTab } from '@/state/tabs-store'
import { toast } from '@/state/toast-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'

export async function openNote(relPath: string): Promise<boolean> {
  if (!isMarkdown(relPath)) {
    toast.warn('M1 只能打开 Markdown 笔记', relPath)
    return false
  }
  if (!(await confirmReplaceCurrentNote(relPath))) return false
  /*
    离开这一篇之前记一笔光标/滚动位置：默认的打开行为会**顶掉**它那条标签，
    重新打开它时因此回得到原处（与「关闭标签」走的是同一个记忆器）。
    必须在切换**之前**调 —— 切换之后编辑器里已经是新文档了。
  */
  const leaving = useNoteStore.getState().doc
  if (leaving !== null && leaving.relPath !== relPath) captureCaretFor(leaving.relPath)
  const vault = useVaultStore.getState()
  vault.revealPath(relPath)
  const ok = await useNoteStore.getState().open(relPath)
  if (ok) vault.select(relPath)
  // 打开笔记 = 离开附件查看器（主区一次只显示一类对象，见 ADR-0032）
  if (ok) useUiStore.getState().closeFile()
  return ok
}

/**
 * 打开笔记并**保留当前那条标签**（加入列表而不是顶掉它）。
 *
 * 入口是文件树的 `Ctrl/⌘ + 点击` 与中键 —— 多标签仍然要有路可走：`Ctrl+Tab` / `Ctrl+1..9` /
 * 「关闭其他」/ 把标签拖到另一格，这些都要列表里能多于一条。
 * 旗子在 `tabs-store` 里，是一次性的（见 `openNextNoteInNewTab` 的说明）。
 */
export async function openNoteInNewTab(relPath: string): Promise<boolean> {
  openNextNoteInNewTab()
  return openNote(relPath)
}

/**
 * 切换笔记前确认"要顶掉的那条"有没有不该丢的东西。
 *
 * 只有**冲突态**才拦（理由见 `openNote` 上那段）。返回 `false` = 用户选择留在原处，
 * 这次打开整体取消（标签与文档都不动）—— 与「关闭标签」被拒绝时的结果一致。
 */
export async function confirmReplaceCurrentNote(relPath: string): Promise<boolean> {
  const current = useNoteStore.getState()
  if (current.doc === null || current.doc.relPath === relPath) return true
  if (current.conflict === null) return true
  return useConfirmStore.getState().ask({
    title: '打开另一篇笔记？',
    message: `「${current.doc.relPath}」在磁盘上被外部改动过，还没决定怎么处理；打开「${relPath}」会放弃这次改动，当前显示的那条标签也会被它顶掉。`,
    confirmLabel: '放弃改动并打开',
    danger: true,
  })
}

/**
 * 打开笔记并把光标落到第 `line` 行（搜索结果与反向链接的落点）。
 *
 * 为什么放在动作层而不是 `features/editor/line-jump.ts`：**打开笔记只有这一条路径**
 * （切走前落盘 → 展开路径 → 同步文件树选中项），跳转只是它的后续动作。放在这里，
 * 调用方（搜索面板、反链面板）就只依赖 `app/actions`，不必知道编辑器内部还有
 * `jumpToLineWhenReady` 这一半 —— 也就避免了 `actions ↔ line-jump` 的循环 import。
 *
 * 为什么先切回编辑视图：阅读视图与图谱视图里没有光标，"落到第 N 行"在那里没有可表达的
 * 结果（图谱视图连正文都不在屏幕上）。统一切到编辑视图，同一个操作才只有一个行为；
 * 切视图幂等，而且刻意放在 `await` 之前 —— 界面切换与读盘并行开始，大笔记不必先白等一次 IO。
 *
 * 定位本身不碰 `note-store`：不改文档、不置 dirty，未保存内容的自动保存流水线
 * 既不被打断也不被触发。
 */
export async function openNoteAt(relPath: string, line: number): Promise<boolean> {
  useUiStore.getState().setViewMode('edit')
  const ok = await openNote(relPath)
  if (!ok) return false
  jumpToLineWhenReady(relPath, line)
  return true
}

/** 新建笔记时的目标目录：选中目录 → 该目录；选中文件 → 其父目录；未选中 → 根目录。 */
export function targetDirectoryForNewNote(): string {
  const { selected, entries } = useVaultStore.getState()
  if (selected === null) return ''
  const entry = entries.find((candidate) => candidate.relPath === selected)
  if (entry === undefined) return ''
  return entry.isDir ? entry.relPath : parentOf(selected)
}

/** 在指定目录新建笔记并打开。 */
export async function createNoteIn(dirRel: string, title = '未命名笔记'): Promise<string | null> {
  try {
    const note = await ipc.noteCreate(
      dirRel,
      title,
      useSettingsStore.getState().frontmatterTimestamps,
    )
    useVaultStore.getState().registerCreatedNote(note)
    const vault = useVaultStore.getState()
    vault.revealPath(note.relPath)
    await openNote(note.relPath)
    toast.success('已新建笔记', note.relPath)
    return note.relPath
  } catch (cause) {
    toast.error(describeError(MimenoteError.from(cause), '新建笔记失败'))
    return null
  }
}

/** 在当前上下文新建笔记。 */
export async function createNoteHere(): Promise<string | null> {
  return createNoteIn(targetDirectoryForNewNote())
}

/**
 * 悬空链接 → 一键创建目标笔记（wikilink 的核心体验之一）。
 *
 * 规则：目标带目录时按 Vault 根创建（`项目/设计` → `项目/设计.md`）；
 * 只有文件名时"就近创建"在与来源笔记相同的目录下。
 */
export async function createNoteFromLink(
  rawTarget: string,
  fromRelPath: string,
): Promise<string | null> {
  const cleaned = rawTarget.trim().split('#')[0]?.split('^')[0]?.trim() ?? ''
  if (cleaned === '') return null

  const parentRel = cleaned.includes('/') ? parentOf(cleaned) : parentOf(fromRelPath)
  const stem = basename(cleaned).replace(/\.(md|markdown)$/i, '')
  if (stem === '') return null

  const created = await createNoteIn(parentRel, stem)
  if (created !== null) toast.success('已创建笔记', created)
  return created
}

/** 显式保存（Ctrl+S）：带反馈。 */
export async function saveCurrentNote(): Promise<void> {
  const store = useNoteStore.getState()
  if (store.doc === null) return
  const started = Date.now()
  const ok = await store.saveNow()
  if (ok) {
    const state = useNoteStore.getState()
    toast.success('已保存', `${state.doc?.relPath ?? ''}（写入 ${state.lastWriteMs ?? Date.now() - started}ms）`)
    void state.refreshDiskStats()
  }
}

/** 从磁盘重新加载当前文档（丢弃内存改动）。 */
export async function reloadCurrentNote(): Promise<void> {
  const store = useNoteStore.getState()
  if (store.doc === null) return
  if (store.dirty) {
    const confirmed = await useConfirmStore.getState().ask({
      title: '放弃未保存的修改？',
      message: '重新加载会用磁盘内容覆盖编辑器中的内容，未保存的修改将丢失。',
      confirmLabel: '放弃并重新加载',
      danger: true,
    })
    if (!confirmed) return
  }
  await store.reload()
}

/** 删除选中的文件/目录（二次确认 → 移入回收站）。 */
export async function deleteSelected(relPath?: string): Promise<void> {
  const target = relPath ?? useVaultStore.getState().selected
  if (target === null || target === undefined) return

  const entry = useVaultStore.getState().entries.find((candidate) => candidate.relPath === target)
  const isDirectory = entry?.isDir === true
  const confirmed = await useConfirmStore.getState().ask({
    title: isDirectory ? '删除目录？' : '删除笔记？',
    message:
      `「${target}」将被移动到 Vault 内的 .mimenote/trash（不会真正删除文件）。` +
      (isDirectory ? '\n\n目录内的所有内容都会一起被移走。' : '') +
      (useNoteStore.getState().dirty && useNoteStore.getState().doc?.relPath === target
        ? '\n\n该笔记有未保存的修改，删除后这些修改将丢失。'
        : '') +
      // 说清"这不是单向动作"：用户敢按删除，往往是因为知道能找回来
      '\n\n删掉之后可以随时在「回收站」（菜单 / 命令面板搜"回收站"）里恢复。',
    confirmLabel: '移入回收站',
    danger: true,
  })
  if (!confirmed) return

  try {
    const record = await ipc.noteDelete(target, true)
    useVaultStore.getState().registerDeletedEntry(record)
    // 关掉**这一篇**（它可能正显示在某一格里，未必是当前文档）：磁盘上已经没有了，
    // 留在仓库里下次打开就会显示缓存正文。别的格子里的文档一篇都不动。
    useNoteStore.getState().closeDoc(target)
    toast.success('已移入回收站', '可在「回收站」里恢复')
  } catch (cause) {
    toast.error(describeError(MimenoteError.from(cause), '删除失败'))
  }
}

// ---------------------------------------------------------------------------
// 标签（frontmatter 的增删）
// ---------------------------------------------------------------------------

/** 一次标签编辑的结果（`null` = 根本没发出去，界面状态不该变）。 */

export async function renameNote(
  relPath: string,
  newTitle: string,
  options: { updateLinks?: boolean } = {},
): Promise<RenameOutcome | null> {
  const title = newTitle.trim()
  if (title === '') return null

  const updateLinks = options.updateLinks ?? true
  const openRelPath = useNoteStore.getState().doc?.relPath ?? null

  try {
    if (hasUnsavedChanges()) {
      const saved = await useNoteStore.getState().saveNow()
      if (!saved && hasUnsavedChanges()) {
        toast.error('已取消重命名', '当前笔记有未保存的修改，请先解决保存冲突')
        return null
      }
    }

    const outcome = await ipc.noteRename(relPath, title, updateLinks)
    const vault = useVaultStore.getState()
    vault.registerRenamedNote(outcome)
    vault.revealPath(outcome.newRelPath)

    const rewritten = new Set(outcome.updatedLinks.map((item) => item.relPath))
    if (openRelPath === outcome.oldRelPath) {
      // 宿主用**旧路径**上报"被改名文件自身也被改写"（自链接），但这里两种口径都认 ——
      // 判错的代价是"保留旧文本继续编辑"，随后一次保存就会把链接改写覆盖掉，代价太高。
      if (rewritten.has(outcome.oldRelPath) || rewritten.has(outcome.newRelPath)) {
        useNoteStore.getState().close()
        await openNote(outcome.newRelPath)
      } else {
        useNoteStore.getState().retarget(outcome.newRelPath, outcome.newMtimeMs)
      }
    } else if (openRelPath !== null && rewritten.has(openRelPath)) {
      await useNoteStore.getState().reload()
    }

    void useLinksStore.getState().refresh(useNoteStore.getState().doc?.relPath ?? null)

    const summary =
      outcome.updatedLinkCount === 0
        ? updateLinks
          ? '没有其他文件需要更新链接'
          : '按要求未改动任何链接'
        : `更新了 ${outcome.updatedLinkCount} 条链接（涉及 ${outcome.updatedLinks.length} 个文件）`
    toast.success(
      '已重命名',
      `${outcome.oldRelPath} → ${outcome.newRelPath}\n${summary}，耗时 ${Math.round(outcome.elapsedMs)}ms`,
    )
    return outcome
  } catch (cause) {
    toast.error(describeError(MimenoteError.from(cause), '重命名失败'))
    return null
  }
}

// ---------------------------------------------------------------------------
// 移动（拖拽整理）
// ---------------------------------------------------------------------------

/**
 * 跨目录移动一篇笔记。
 *
 * 与 {@link renameNote} 是同一条链路的两种入口（宿主里就是同一条：换位置 + 改写全库链接 +
 * 增量同步索引），因此这里的顺序约束与状态收尾**刻意与重命名逐条对齐**：
 *
 * 1. **先落盘**：移动会就地重写其他文件里的链接；若当前还有未保存内容，磁盘改写会让
 *    编辑器里的版本令牌失效（下次保存必报冲突）；
 * 2. 宿主负责搬文件（原子 rename，跨卷退回复制 + 删除）、改写链接、更新索引；
 * 3. 前端状态收尾：条目表换路径（标签页的剪枝跟着跑）、正在编辑的这篇笔记换路径
 *    （内容没变，保留光标与撤销历史）；若它自身也被改写（自链接）就重新读取；
 *    其他被改写的文件正在编辑 → 重新读取。
 *
 * `newTitle` 为 `null` 时沿用原文件名（拖拽就是这种情况）。
 */
export async function moveNote(
  relPath: string,
  targetParentRel: string,
  options: { newTitle?: string | null; updateLinks?: boolean } = {},
): Promise<RenameOutcome | null> {
  const updateLinks = options.updateLinks ?? true
  const newTitle = options.newTitle ?? null
  const openRelPath = useNoteStore.getState().doc?.relPath ?? null

  try {
    if (hasUnsavedChanges()) {
      const saved = await useNoteStore.getState().saveNow()
      if (!saved && hasUnsavedChanges()) {
        toast.error('已取消移动', '当前笔记有未保存的修改，请先解决保存冲突')
        return null
      }
    }

    const outcome = await ipc.noteMove(relPath, targetParentRel, newTitle, updateLinks)
    const vault = useVaultStore.getState()
    vault.registerRenamedNote(outcome)
    vault.revealPath(outcome.newRelPath)

    const rewritten = new Set(outcome.updatedLinks.map((item) => item.relPath))
    if (openRelPath === outcome.oldRelPath) {
      if (rewritten.has(outcome.oldRelPath) || rewritten.has(outcome.newRelPath)) {
        useNoteStore.getState().close()
        await openNote(outcome.newRelPath)
      } else {
        useNoteStore.getState().retarget(outcome.newRelPath, outcome.newMtimeMs)
      }
    } else if (openRelPath !== null && rewritten.has(openRelPath)) {
      await useNoteStore.getState().reload()
    }

    void useLinksStore.getState().refresh(useNoteStore.getState().doc?.relPath ?? null)

    const summary =
      outcome.updatedLinkCount === 0
        ? updateLinks
          ? '没有其他文件需要更新链接'
          : '按要求未改动任何链接'
        : `更新了 ${outcome.updatedLinkCount} 条链接（涉及 ${outcome.updatedLinks.length} 个文件）`
    const moved = outcome.oldRelPath === outcome.newRelPath
    toast.success(
      moved ? '无需移动' : '已移动',
      moved
        ? `${outcome.newRelPath} 已经在这个目录里`
        : `${outcome.oldRelPath} → ${outcome.newRelPath}\n${summary}，耗时 ${Math.round(outcome.elapsedMs)}ms`,
    )
    return outcome
  } catch (cause) {
    const error = MimenoteError.from(cause)
    // 目标重名是拖拽最常见的失败：给一句"怎么办"，而不是只报"目标已存在"
    if (error.code === 'ALREADY_EXISTS') {
      toast.error(
        '目标目录已有同名文件',
        `${targetParentRel === '' ? 'Vault 根目录' : targetParentRel} 里已存在同名文件，已取消移动（不会覆盖）`,
      )
      return null
    }
    toast.error(describeError(error, '移动失败'))
    return null
  }
}
