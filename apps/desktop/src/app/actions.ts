/**
 * 高层动作：把多个 store 与 IPC 组合成"一件事"。
 *
 * UI 组件只调用这里的函数（以及 store 的纯状态读写），不自行编排多个 store，
 * 这样"切文档前先保存""删除前先确认"之类的顺序约束只存在一处。
 */

import { formatBytes } from '@/domain/format'
import { basename, isMarkdown, parentOf } from '@/domain/paths'
import { currentAdapterKind, ipc } from '@/ipc/client'
import { MimenoteError, describeError } from '@/ipc/types'
import type { RenameOutcome } from '@/ipc/types'
import { useConfirmStore } from '@/state/confirm-store'
import { useLinksStore } from '@/state/links-store'
import { hasUnsavedChanges, useNoteStore } from '@/state/note-store'
import { toast } from '@/state/toast-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'
import { applyVaultSnippets, unloadSnippets } from '@/theme/snippets'
import { pickDirectory } from './dialogs'
import { requestRename } from './dom-events'

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

/** 弹出目录选择框并打开 Vault。 */
export async function openVaultInteractive(): Promise<void> {
  // 浏览器预览模式没有系统目录选择框：直接打开内存里的示例 Vault，
  // 否则这个按钮点下去只有一句提示，等于死路（也挡住了 UI 层的自动化测试）。
  if (currentAdapterKind() === 'mock') {
    const { MOCK_VAULT_PATH } = await import('@/ipc/mock-adapter')
    toast.info('浏览器预览模式', '没有系统目录选择框，已打开内存示例 Vault（不会读写本机文件）')
    await useVaultStore.getState().openVault(MOCK_VAULT_PATH)
    return
  }

  const path = await pickDirectory('选择 Vault 文件夹')
  if (path === null) return
  await useVaultStore.getState().openVault(path)
}

/** 重新扫描当前 Vault。 */
export async function rescanVault(): Promise<void> {
  await useVaultStore.getState().rescan()
}

/** 关闭当前 Vault（先把未保存内容落盘）。 */
export async function closeVault(): Promise<void> {
  if (hasUnsavedChanges()) {
    await useNoteStore.getState().saveNow()
  }
  useNoteStore.getState().close()
  unloadSnippets()
  await useVaultStore.getState().closeVault()
}

// ---------------------------------------------------------------------------
// 笔记
// ---------------------------------------------------------------------------

/** 打开笔记（先展开路径、切走前保存旧文档）。 */
export async function openNote(relPath: string): Promise<boolean> {
  if (!isMarkdown(relPath)) {
    toast.warn('M1 只能打开 Markdown 笔记', relPath)
    return false
  }
  const vault = useVaultStore.getState()
  vault.revealPath(relPath)
  const ok = await useNoteStore.getState().open(relPath)
  if (ok) vault.select(relPath)
  return ok
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
    const note = await ipc.noteCreate(dirRel, title)
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
        : ''),
    confirmLabel: '移入回收站',
    danger: true,
  })
  if (!confirmed) return

  try {
    const record = await ipc.noteDelete(target, true)
    useVaultStore.getState().registerDeletedEntry(record)
    if (useNoteStore.getState().doc?.relPath === target) {
      useNoteStore.getState().close()
    }
    toast.success('已移入回收站', record.storedRelPath)
  } catch (cause) {
    toast.error(describeError(MimenoteError.from(cause), '删除失败'))
  }
}

// ---------------------------------------------------------------------------
// 重命名
// ---------------------------------------------------------------------------

/**
 * 重命名笔记（同目录改名）并改写全库指向它的链接。
 *
 * 顺序约束集中在这里（组件不需要知道）：
 * 1. **先落盘**：改名会就地重写其他文件里的链接；若当前还有未保存内容，
 *    磁盘改写会让编辑器里的版本令牌失效（下次保存必报冲突）。落盘失败就整体放弃，
 *    不留"文件已改名、内容没写"的半截状态。
 * 2. 宿主负责改名 + 精确改写链接（保 BOM/换行，跳过代码块）+ 增量更新索引。
 * 3. 前端状态收尾：
 *    - 被改名的笔记正在编辑 → 原路径换新路径（内容没变，保留光标与撤销历史）；
 *      若它自己也被改写（自链接）→ 关掉重新读取；
 *    - 其他被改写的文件正在编辑 → 重新读取（磁盘内容已变，用旧文本保存会覆盖改写）。
 */
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

/** 请求重命名文件树选中项（目录重命名推迟到 M3）。 */
export function renameSelected(relPath?: string): void {
  const target = relPath ?? useVaultStore.getState().selected
  if (target === null || target === undefined) return
  const entry = useVaultStore.getState().entries.find((candidate) => candidate.relPath === target)
  if (entry?.isDir === true) {
    toast.warn('目录重命名暂未支持', '当前只能重命名单篇笔记；目录重命名在 M3 与拖拽整理一起做')
    return
  }
  if (!isMarkdown(target)) {
    toast.warn('只能重命名 Markdown 笔记', target)
    return
  }
  requestRename(target)
}

// ---------------------------------------------------------------------------
// 定制化
// ---------------------------------------------------------------------------

/** 应用/卸载 Vault CSS 片段。 */
export async function syncSnippets(enabled: boolean, options: { silent?: boolean } = {}): Promise<void> {
  if (useVaultStore.getState().info === null) {
    unloadSnippets()
    return
  }
  try {
    const result = await applyVaultSnippets(enabled)
    if (!options.silent) {
      toast.info(
        enabled ? `已加载 ${result.count} 个 CSS 片段` : '已停用 CSS 片段',
        result.names.length > 0 ? result.names.join('、') : '把 .css 放进 Vault 的 .mimenote/snippets/ 即可',
      )
    }
  } catch (cause) {
    toast.error(describeError(MimenoteError.from(cause), '加载 CSS 片段失败'))
  }
}

/** 切换片段开关。 */
export async function toggleSnippets(): Promise<void> {
  const ui = useUiStore.getState()
  const next = !ui.snippetsEnabled
  ui.setSnippetsEnabled(next)
  await syncSnippets(next)
}

/** 关于面板：版本 + 当前文档的磁盘真实统计。 */
export async function showAbout(): Promise<void> {
  try {
    const version = await ipc.versionInfo()
    const lines = [
      `mn-core ${version.core} · Tauri ${version.tauri}`,
      `IPC 适配器：${currentAdapterKind() ?? '未初始化'}`,
    ]
    const doc = useNoteStore.getState().doc
    if (doc !== null) {
      const onDisk = await ipc.noteStats(doc.relPath)
      lines.push(
        `磁盘「${doc.relPath}」：${formatBytes(onDisk.sizeBytes)} · ${onDisk.stats.words} 词 · ${onDisk.stats.lines} 行 · 约 ${onDisk.stats.readingMinutes} 分钟`,
      )
    }
    toast.info(`Mimenote ${version.app}`, lines.join('\n'))
  } catch (cause) {
    toast.error(describeError(MimenoteError.from(cause), '读取版本信息失败'))
  }
}
