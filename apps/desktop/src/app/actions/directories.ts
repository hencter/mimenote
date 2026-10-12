/**
 * app/actions/directories.ts —— 目录改名与移动、条目级 rename/move 入口（从 app/actions.ts 逐字搬出，只加了 export 与 import）。
 *
 * 为什么拆：1018 行的组合根动作文件里，"打开一篇笔记"与"改一个标签"的代码彼此无关，
 * 任何一次定位都要通读全文件。拆完 `app/actions.ts` 保留为**再导出壳**，39 处
 * `features → app/actions` 的调用点一行不改（ADR-0060 §3(c)）。
 */
import { requestMove, requestRename } from '../dom-events'
import { moveNote, openNote, renameNote } from './notes'
import { isMarkdown, parentOf } from '@/domain/paths'
import { ipc } from '@/ipc/client'
import { MimenoteError, describeError } from '@/ipc/types'
import type { RenameOutcome } from '@/ipc/types'
import { useLinksStore } from '@/state/links-store'
import { hasUnsavedChanges, useNoteStore } from '@/state/note-store'
import { relocateTabsForDirectory } from '@/state/tabs-store'
import { toast } from '@/state/toast-store'
import { useVaultStore } from '@/state/vault-store'

/** 请求重命名文件树选中项（笔记或文件夹）。 */
export function renameSelected(relPath?: string): void {
  const target = relPath ?? useVaultStore.getState().selected
  if (target === null || target === undefined) return
  const entry = useVaultStore.getState().entries.find((candidate) => candidate.relPath === target)
  if (entry?.isDir === true) {
    // 文件夹改名与笔记改名是同一条链路的两种入口（宿主里就是同一条：换位置 + 改写全库
    // 指向子树里每一篇的链接），所以这里**不再拒绝** —— 只是对话框要说明改的是文件夹
    requestRename(target)
    return
  }
  if (!isMarkdown(target)) {
    toast.warn('只能重命名 Markdown 笔记', target)
    return
  }
  requestRename(target)
}

/**
 * 目录搬迁（改名 / 移动）的**共同收尾**。
 *
 * 与 {@link moveNote} 逐条对齐，只多两件事 —— 都源于"动的是一整棵子树"：
 *
 * 1. **先换标签、再换条目表**：条目表一变 `pruneMissing` 就会剪掉旧路径的标签，而
 *    `syncFromNote` 只把当前文档补回列表**末尾** —— 顺序反了标签顺序就被打乱；
 * 2. 当前文档在子树里时按**前缀**换路径（不是单篇那种"等于旧路径"的比较）。
 */
export function finishDirectoryRelocation(
  outcome: RenameOutcome,
  openRelPath: string | null,
  searchRewrite: (relPath: string) => boolean,
): void {
  const { oldRelPath, newRelPath } = outcome
  const inside = (relPath: string): boolean =>
    relPath === oldRelPath || relPath.startsWith(`${oldRelPath}/`)
  const remap = (relPath: string): string =>
    relPath === oldRelPath ? newRelPath : `${newRelPath}${relPath.slice(oldRelPath.length)}`

  // 1) 标签页整棵子树换前缀（**必须在条目表变化之前**）
  relocateTabsForDirectory(oldRelPath, newRelPath)
  // 2) 条目表就地替换整棵子树（不重扫）
  useVaultStore.getState().registerRelocatedDirectory(outcome)
  // 3) 重新展开到新路径（搬迁后"我原来在看的那篇"还在视野里）
  useVaultStore.getState().revealPath(
    openRelPath !== null && inside(openRelPath) ? remap(openRelPath) : newRelPath,
  )
  useVaultStore.getState().select(
    openRelPath !== null && inside(openRelPath) ? remap(openRelPath) : newRelPath,
  )

  // 4) 正在编辑的文档：在子树里 → 按前缀换路径；正文被改写过的还要重新读取
  if (openRelPath !== null && inside(openRelPath)) {
    if (searchRewrite(openRelPath)) {
      const target = remap(openRelPath)
      useNoteStore.getState().close()
      void openNote(target)
    } else {
      // 目录搬迁不会改这一篇的正文（它只是换了个位置）→ 保留光标与撤销历史
      useNoteStore.getState().retarget(remap(openRelPath), 0)
    }
  } else if (openRelPath !== null && searchRewrite(openRelPath)) {
    void useNoteStore.getState().reload()
  }

  void useLinksStore.getState().refresh(useNoteStore.getState().doc?.relPath ?? null)
}

/**
 * 重命名**目录**：磁盘上换名字 + 全库指向子树里每一篇的链接精确改写。
 *
 * 顺序约束与 {@link renameNote} 完全一致（**先落盘**、失败就整体放弃）：目录搬迁会就地重写
 * 其他文件里的链接，未保存的正文若不先落盘，磁盘改写会让编辑器的版本令牌失效。
 */
export async function renameDirectory(
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

    const outcome = await ipc.dirRename(relPath, title, updateLinks)
    const rewritten = new Set(outcome.updatedLinks.map((item) => item.relPath))
    finishDirectoryRelocation(outcome, openRelPath, (candidate) => rewritten.has(candidate))

    toast.success(
      '已重命名文件夹',
      `${outcome.oldRelPath} → ${outcome.newRelPath}\n${linkSummary(outcome, updateLinks)}，耗时 ${Math.round(outcome.elapsedMs)}ms`,
    )
    return outcome
  } catch (cause) {
    const error = MimenoteError.from(cause)
    if (error.code === 'ALREADY_EXISTS') {
      toast.error(
        '目标位置已有同名文件夹',
        `${parentOf(relPath) === '' ? 'Vault 根目录' : parentOf(relPath)} 里已存在同名文件夹，已取消（不会与它合并）`,
      )
      return null
    }
    toast.error(describeError(error, '重命名文件夹失败'))
    return null
  }
}

/**
 * 移动**目录**：整棵子树的路径跟着变 + 全库链接精确改写。
 *
 * 与 {@link moveNote} 是同一条链路的两种入口（宿主里就是同一条），差别只是候选集从
 * "一篇"变成"整棵子树"。`newTitle` 为 `null` 时沿用目录名（拖拽就是这种情况）。
 */
export async function moveDirectory(
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

    const outcome = await ipc.dirMove(relPath, targetParentRel, newTitle, updateLinks)
    const rewritten = new Set(outcome.updatedLinks.map((item) => item.relPath))
    finishDirectoryRelocation(outcome, openRelPath, (candidate) => rewritten.has(candidate))

    const moved = outcome.oldRelPath === outcome.newRelPath
    toast.success(
      moved ? '无需移动' : '已移动文件夹',
      moved
        ? `${outcome.newRelPath} 已经在这个目录里`
        : `${outcome.oldRelPath} → ${outcome.newRelPath}\n${linkSummary(outcome, updateLinks)}，耗时 ${Math.round(outcome.elapsedMs)}ms`,
    )
    return outcome
  } catch (cause) {
    const error = MimenoteError.from(cause)
    if (error.code === 'ALREADY_EXISTS') {
      toast.error(
        '目标位置已有同名文件夹',
        `${targetParentRel === '' ? 'Vault 根目录' : targetParentRel} 里已存在同名文件夹，已取消（不会与它合并）`,
      )
      return null
    }
    if (error.code === 'PATH_INVALID') {
      toast.error('这个落点不能放', error.message)
      return null
    }
    toast.error(describeError(error, '移动文件夹失败'))
    return null
  }
}

/** 链接改写的收尾说明（重命名/移动共用一句话术）。 */
export function linkSummary(outcome: RenameOutcome, updateLinks: boolean): string {
  if (outcome.updatedLinkCount === 0) {
    return updateLinks ? '没有其他文件需要更新链接' : '按要求未改动任何链接'
  }
  return `更新了 ${outcome.updatedLinkCount} 条链接（涉及 ${outcome.updatedLinks.length} 个文件）`
}

/**
 * 按条目类型分派重命名（文件树 F2 / 命令面板 / 菜单都走它）。
 *
 * 为什么要分派而不是让调用方自己判断：**决定走哪条链路的信息（是不是目录）只有一处**
 * （条目表），分派放在这一层以后，两个入口不会各自判断一遍（判错的代价是改错对象）。
 */
export async function renameEntry(
  relPath: string,
  newTitle: string,
  options: { updateLinks?: boolean } = {},
): Promise<RenameOutcome | null> {
  const entry = useVaultStore.getState().entries.find((item) => item.relPath === relPath)
  return entry?.isDir === true
    ? renameDirectory(relPath, newTitle, options)
    : renameNote(relPath, newTitle, options)
}

/**
 * 按条目类型分派移动（拖拽与「移动到…」对话框都走它）。
 *
 * 与 {@link renameEntry} 同一条理由：**"这是不是目录"只有条目表知道**，分派放在这一层，
 * 两个入口（拖拽、F6 对话框）就不会各自判断一遍。
 */
export async function moveEntry(
  relPath: string,
  targetParentRel: string,
  options: { newTitle?: string | null; updateLinks?: boolean } = {},
): Promise<RenameOutcome | null> {
  const entry = useVaultStore.getState().entries.find((item) => item.relPath === relPath)
  return entry?.isDir === true
    ? moveDirectory(relPath, targetParentRel, options)
    : moveNote(relPath, targetParentRel, options)
}

/**
 * 请求移动文件树选中项（命令面板的「移动到…」/ 文件树的 `Ctrl+X` 式入口）。
 *
 * 目录移动仍未做（与目录重命名一起推迟）：明确拒绝并说明，而不是让对话框
 * 打开后才发现"这个目标选不了"。
 */
export function moveSelected(relPath?: string): void {
  const target = relPath ?? useVaultStore.getState().selected
  if (target === null || target === undefined) return
  const entry = useVaultStore.getState().entries.find((candidate) => candidate.relPath === target)
  if (entry?.isDir === true) {
    toast.warn('目录移动暂未支持', '当前只能移动单篇笔记；目录移动与目录重命名一起推迟')
    return
  }
  if (!isMarkdown(target)) {
    toast.warn('只能移动 Markdown 笔记', target)
    return
  }
  requestMove(target)
}
