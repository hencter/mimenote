/**
 * 高层动作：把多个 store 与 IPC 组合成"一件事"。
 *
 * UI 组件只调用这里的函数（以及 store 的纯状态读写），不自行编排多个 store，
 * 这样"切文档前先保存""删除前先确认"之类的顺序约束只存在一处。
 */

import { formatBytes } from '@/domain/format'
import { isMarkdown, parentOf } from '@/domain/paths'
import { currentAdapterKind, ipc } from '@/ipc/client'
import { MimenoteError, describeError } from '@/ipc/types'
import { useConfirmStore } from '@/state/confirm-store'
import { hasUnsavedChanges, useNoteStore } from '@/state/note-store'
import { toast } from '@/state/toast-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'
import { applyVaultSnippets, unloadSnippets } from '@/theme/snippets'
import { pickDirectory } from './dialogs'

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

/** 弹出目录选择框并打开 Vault。 */
export async function openVaultInteractive(): Promise<void> {
  const path = await pickDirectory('选择 Vault 文件夹')
  if (path === null) {
    if (currentAdapterKind() === 'mock') {
      toast.info('浏览器预览模式', '当前使用内存 Mock Vault；在 Tauri 中运行才能选择本机文件夹')
    }
    return
  }
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
