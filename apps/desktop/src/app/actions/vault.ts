/**
 * app/actions/vault.ts —— Vault 生命周期 / 重扫 / 回收站 / 片段 / 关于（从 app/actions.ts 逐字搬出，只加了 export 与 import）。
 *
 * 为什么拆：1018 行的组合根动作文件里，"打开一篇笔记"与"改一个标签"的代码彼此无关，
 * 任何一次定位都要通读全文件。拆完 `app/actions.ts` 保留为**再导出壳**，39 处
 * `features → app/actions` 的调用点一行不改（ADR-0060 §3(c)）。
 */
import { pickDirectory } from '../dialogs'
import { formatBytes } from '@/domain/format'
import { displayPath } from '@/domain/paths'
import { currentAdapterKind, ipc } from '@/ipc/client'
import { MimenoteError, describeError } from '@/ipc/types'
import { flushAll, useNoteStore } from '@/state/note-store'
import { toast } from '@/state/toast-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'
import { applyVaultSnippets, unloadSnippets } from '@/theme/snippets'

/**
 * 高层动作：把多个 store 与 IPC 组合成"一件事"。
 *
 * UI 组件只调用这里的函数（以及 store 的纯状态读写），不自行编排多个 store，
 * 这样"切文档前先保存""删除前先确认"之类的顺序约束只存在一处。
 */

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

/**
 * 切到「最近打开的 Vault」列表里的一个（先把未保存内容落盘）。
 *
 * 与工具栏的「切换 Vault」同一条链路（`openVault` 失败时弹 toast、留在原 Vault），
 * 只是入口从系统目录选择框换成最近列表 —— 路径已经在列表里，不需要再选一次。
 */
export async function openRecentVault(rootPath: string): Promise<void> {
  await useVaultStore.getState().openVault(rootPath)
}

/**
 * 打开回收站（列出删掉的东西，可恢复）。
 *
 * 为什么做成动作而不是让命令直接改 store：命令注册表里的 `run` 都是"做一件事"的函数，
 * 菜单 / 命令面板 / 将来的快捷键三条入口共用同一个它；动作层也是唯一能一眼看清
 * "这条命令到底碰了哪些状态"的地方。对话框自己在打开时拉一次台账（见 `TrashDialog`），
 * 这里只负责把它打开。
 */
export async function openTrash(): Promise<void> {
  useUiStore.getState().setTrashDialogOpen(true)
}

/** 关闭当前 Vault（先把未保存内容落盘）。冲突或保存失败时留在原地，不把正文清掉。 */
export async function closeVault(): Promise<void> {
  const flushed = await flushAll()
  if (flushed.blocked.length > 0 || flushed.failed.length > 0) {
    toast.warn(
      '还有笔记没保存，没有关闭 Vault',
      [
        flushed.blocked.length > 0 ? `${flushed.blocked.length} 篇有冲突` : '',
        flushed.failed.length > 0 ? `${flushed.failed.length} 篇保存失败` : '',
      ]
        .filter((part) => part !== '')
        .join('，'),
    )
    return
  }
  useNoteStore.getState().close()
  unloadSnippets()
  await useVaultStore.getState().closeVault()
}

// ---------------------------------------------------------------------------
// 笔记
// ---------------------------------------------------------------------------

/**
 * 打开笔记（先展开路径、切走前保存旧文档）。
 *
 * ## 默认"顶掉"当前那条标签，而不是追加
 *
 * 用户的约定：「默认的新文件替换中的叶标签，即已打开的直接被新的替换掉」——
 * 列表动作本身在 `tabs-store` 的 `syncFromNote`（标签列表的唯一写入者）里，这里只负责
 * **在切换之前**问清一件事：当前那篇正处于**冲突态**时不要闷头换掉。
 *
 * 为什么只对冲突态要确认：`note-store.open` 的语义是"切走前先落盘"，所以普通的
 * "有未保存的修改"会在切换时被保存下来（什么都不丢），而冲突态是**唯一**不落盘的分支
 * （磁盘上的改动要由用户决定"覆盖还是重新加载"）—— 在那里弹"会丢修改"的确认才是诚实的；
 * 给每次"边打字边点文件树"都弹一个确认，只会把确认框训练成噪音。
 */

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
        `磁盘「${displayPath(doc.relPath)}」：${formatBytes(onDisk.sizeBytes)} · ${onDisk.stats.words} 词 · ${onDisk.stats.lines} 行 · 约 ${onDisk.stats.readingMinutes} 分钟`,
      )
    }
    toast.info(`Mimenote ${version.app}`, lines.join('\n'))
  } catch (cause) {
    toast.error(describeError(MimenoteError.from(cause), '读取版本信息失败'))
  }
}

