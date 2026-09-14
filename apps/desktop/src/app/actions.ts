/**
 * 高层动作：把多个 store 与 IPC 组合成"一件事"。
 *
 * UI 组件只调用这里的函数（以及 store 的纯状态读写），不自行编排多个 store，
 * 这样"切文档前先保存""删除前先确认"之类的顺序约束只存在一处。
 */

import { formatBytes } from '@/domain/format'
import { basename, isMarkdown, parentOf } from '@/domain/paths'
import { jumpToLineWhenReady } from '@/features/editor/line-jump'
import { changedAnything, groupSkips, resultSentence } from '@/features/tags/tag-rename'
import { currentAdapterKind, ipc } from '@/ipc/client'
import { MimenoteError, describeError } from '@/ipc/types'
import type { RenameOutcome, TagRenameOutcome } from '@/ipc/types'
import { useConfirmStore } from '@/state/confirm-store'
import { refreshGraphData } from '@/state/graph-store'
import { useLinksStore } from '@/state/links-store'
import { hasUnsavedChanges, useNoteStore } from '@/state/note-store'
import { relocateTabsForDirectory } from '@/state/tabs-store'
import { useTagsStore } from '@/state/tags-store'
import { toast } from '@/state/toast-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'
import { applyVaultSnippets, unloadSnippets } from '@/theme/snippets'
import { pickDirectory } from './dialogs'
import { requestMove, requestRename } from './dom-events'

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
// 标签（frontmatter 的增删）
// ---------------------------------------------------------------------------

/** 一次标签编辑的结果（`null` = 根本没发出去，界面状态不该变）。 */
export interface TagEditResult {
  /** 宿主是否真的写了盘（`false` = 结果与磁盘一致，一个字节都没动）。 */
  changed: boolean
  /** 写入后磁盘上真实的 frontmatter 标签。 */
  tags: string[]
  /** 请求删除、但**仍然在** frontmatter 里的标签（见下面的 `tag:` 字段说明）。 */
  notRemoved: string[]
}

/**
 * 在当前笔记的 frontmatter 上加/删标签（标签面板的写入口）。
 *
 * 顺序约束集中在这里，组件不需要知道（与 {@link renameNote} 逐条对齐）：
 *
 * 1. **先落盘**：宿主会基于**磁盘上的最新文本**改标签。若内存里还有未保存的正文，
 *    两者就会打架 —— 随后那次自动保存会把刚写下去的标签覆盖掉。落盘失败（典型是冲突）
 *    就整体放弃，并给出与保存冲突同一句提示；
 * 2. 宿主一次完成「令牌校验 → 读 → 改 frontmatter → 原子写 → 索引增量同步」：
 *    前端不自己拼 frontmatter，判同与最小 diff 只有一份（`mn_core`，见 ADR-0006）；
 * 3. 成功后把**内存文本对齐到磁盘**（`applyWrittenText`）——这一步不能省，理由同上；
 * 4. 面板与全库概览立刻重读（索引已在宿主侧增量更新，不需要重扫）；
 * 5. 图谱只在画布正显示时刷新：与 `startGraphAutoRefresh` 同一纪律，不给看不见的面板发 IPC。
 *
 * 冲突（磁盘在读取之后被外部改过）走**和保存冲突完全一样**的通道：进 `conflict` 态 →
 * 顶部出现同一条横幅 → 由用户选择"覆盖保存 / 重新加载"。绝不静默覆盖（ADR-0004）。
 */
export async function editCurrentNoteTags(changes: {
  add?: readonly string[]
  remove?: readonly string[]
}): Promise<TagEditResult | null> {
  const add = [...(changes.add ?? [])]
  const remove = [...(changes.remove ?? [])]
  if (add.length === 0 && remove.length === 0) return null

  const store = useNoteStore.getState()
  const doc = store.doc
  if (doc === null) {
    toast.warn('先打开一篇笔记', '标签写在笔记开头的 frontmatter 里')
    return null
  }

  try {
    if (hasUnsavedChanges()) {
      const saved = await store.saveNow()
      if (!saved && hasUnsavedChanges()) {
        toast.error('已取消修改标签', '当前笔记有未保存的修改，请先解决保存冲突')
        return null
      }
    }

    // 落盘期间用户可能换了文档：换过就整体放弃，别把标签写到另一篇上
    const current = useNoteStore.getState().doc
    if (current === null || current.relPath !== doc.relPath) return null

    const outcome = await ipc.noteSetTags(current.relPath, add, remove, current.baseMtimeMs)

    if (outcome.changed) {
      useNoteStore.getState().applyWrittenText(outcome.text, {
        mtimeMs: outcome.mtimeMs,
        sizeBytes: outcome.sizeBytes,
      })
    }

    const notRemoved = remove.filter((tag) =>
      outcome.tags.some((kept) => kept.toLowerCase() === tag.toLowerCase()),
    )

    await useTagsStore.getState().refreshFor(current.relPath)

    if (outcome.changed && useUiStore.getState().viewMode === 'graph') {
      void refreshGraphData()
    }

    if (notRemoved.length > 0) {
      // "点 × 没反应"最容易被当成 bug，所以这条提示优先于成功提示：删不掉不是失败，
      // 但必须说清为什么 —— `tags` 与 `tag` 两个字段并存时写入目标永远是 `tags`
      // （`mn_core::frontmatter::set_tags` 的既有口径），`tag:` 里的那个只能到属性区手动改
      toast.info(
        '有标签没能移除',
        `${notRemoved.join('、')} 仍在 frontmatter 里：它来自 tag: 字段，请在属性区手动改`,
      )
    } else if (outcome.changed) {
      toast.success(
        add.length > 0 && remove.length > 0 ? '标签已更新' : add.length > 0 ? '已添加标签' : '已移除标签',
        (add.length > 0 ? add : remove).join('、'),
      )
    } else if (add.length > 0) {
      toast.info('没有变化', '这些标签已经在 frontmatter 里了（判同不区分大小写）')
    }

    return { changed: outcome.changed, tags: outcome.tags, notRemoved }
  } catch (cause) {
    const error = MimenoteError.from(cause)
    if (error.isConflict) {
      // 与保存冲突**同一套语义**：进冲突态（顶部横幅、由用户二选一），不自己发明一套提示
      useNoteStore.getState().noteExternalChange(error.currentMtimeMs ?? 0)
      return null
    }
    toast.error(describeError(error, '修改标签失败'))
    return null
  }
}

/** 正文行内标签删不掉时给出的可读提示（面板的 `×` 走它，而不是让按钮看起来坏了）。 */
export function explainInlineTag(tag: string): void {
  toast.info('这是正文里的标签', `#${tag} 写在正文里，请到正文里删（标签面板只改 frontmatter）`)
}

/**
 * **全库**标签重命名 / 合并（标签面板的写入口）。
 *
 * 顺序约束集中在这里（组件不需要知道为什么）：
 *
 * 1. **先落盘**（只有真跑时）：宿主会基于磁盘上的文本改写**全库**。内存里若有未保存的正文，
 *    随后那次自动保存会把刚改好的那一篇（如果正好是当前这篇）覆盖回去；
 * 2. 宿主一次做完「候选集 → 逐篇令牌校验 → 改写 frontmatter 与正文 → 原子写 → 索引增量同步」，
 *    并**逐篇汇报**（`edited` / `skipped`）。前端不自己拼 frontmatter、也不自己遍历文件；
 * 3. 收尾四件事：
 *    - 面板与全库概览重读（索引已在宿主侧增量更新，不需要重扫）；
 *    - 展开中的那个标签换成新键（否则用户看到的还是旧标签下的名单）；
 *    - 正在编辑的那一篇若被改写 → **重读**。它有未保存内容时**不**重读（宁可让下一次保存
 *      走既有的冲突横幅，也不替用户丢掉他刚敲的字）；
 *    - 图谱只在画布正显示时刷新（与 `editCurrentNoteTags` 同一纪律）。
 *
 * `dryRun: true` 是"先查询再确认"里的查询：宿主走完全一样的判定但不落盘，
 * 于是对话框能说出"这会改 N 篇笔记"，而且那句话与真跑同源。
 *
 * 返回值 `null` 表示"这次请求没有发出去"（没打开 Vault、名称为空、保存冲突）——
 * 界面状态不该有任何变化。
 */
export async function renameTag(
  from: string,
  to: string,
  options: { includeChildren?: boolean; dryRun?: boolean } = {},
): Promise<TagRenameOutcome | null> {
  const includeChildren = options.includeChildren ?? true
  const dryRun = options.dryRun ?? false
  const source = from.trim()
  const target = to.trim().replace(/^#+/, '').trim()
  if (source === '' || target === '') {
    // 判同与清理的权威在宿主（`normalize_tag` / `TagRename::new`），这里只挡掉"明显空"的输入
    toast.warn('标签名不能为空', '请输入新的标签名（层级标签用 `/`，例如 项目/进行中）')
    return null
  }

  const openRelPath = useNoteStore.getState().doc?.relPath ?? null

  try {
    if (!dryRun && hasUnsavedChanges()) {
      const saved = await useNoteStore.getState().saveNow()
      if (!saved && hasUnsavedChanges()) {
        toast.error('已取消标签改名', '当前笔记有未保存的修改，请先解决保存冲突')
        return null
      }
    }

    const outcome = await ipc.tagRename(source, target, { includeChildren, dryRun })
    if (dryRun) return outcome

    const edited = new Set(outcome.edited.map((file) => file.relPath))
    if (changedAnything(outcome)) {
      // 当前笔记被改过：内存文本必须对齐磁盘（否则下一次自动保存会写回旧标签）。
      // 有未保存内容时**不**重读：那会丢掉用户刚敲的字，交给既有的冲突横幅更诚实。
      if (openRelPath !== null && edited.has(openRelPath) && !useNoteStore.getState().dirty) {
        await useNoteStore.getState().reload({ silent: true })
      }

      useTagsStore.getState().retargetActiveTag(outcome.from, outcome.to)
      await useTagsStore.getState().refreshFor(useNoteStore.getState().doc?.relPath ?? null)

      if (useUiStore.getState().viewMode === 'graph') {
        void refreshGraphData()
      }
      void useLinksStore.getState().refresh(useNoteStore.getState().doc?.relPath ?? null)
    }

    if (outcome.skipped.length > 0) {
      // "改了一部分"必须说出来（还带上"怎么办"）：只报成功会让用户以为改干净了
      const advice = groupSkips(outcome.skipped)
        .map((group) => group.advice)
        .join('；')
      toast.warn('标签改名未全部完成', `${resultSentence(outcome)} —— ${advice}`)
    } else if (outcome.edited.length > 0) {
      toast.success('已重命名标签', `${outcome.fromDisplay} → ${outcome.toDisplay}：${resultSentence(outcome)}`)
    } else {
      toast.info('没有变化', resultSentence(outcome))
    }

    return outcome
  } catch (cause) {
    toast.error(describeError(MimenoteError.from(cause), '标签改名失败'))
    return null
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
function finishDirectoryRelocation(
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
function linkSummary(outcome: RenameOutcome, updateLinks: boolean): string {
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
