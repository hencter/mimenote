/**
 * app/actions/tags.ts —— 标签编辑 / 改名 / 移动（从 app/actions.ts 逐字搬出，只加了 export 与 import）。
 *
 * 为什么拆：1018 行的组合根动作文件里，"打开一篇笔记"与"改一个标签"的代码彼此无关，
 * 任何一次定位都要通读全文件。拆完 `app/actions.ts` 保留为**再导出壳**，39 处
 * `features → app/actions` 的调用点一行不改（ADR-0060 §3(c)）。
 */
import { changedAnything, groupSkips, resultSentence } from '@/features/tags/tag-rename'
import { ipc } from '@/ipc/client'
import { MimenoteError, describeError, describeHostReason } from '@/ipc/types'
import type { TagRenameOutcome } from '@/ipc/types'
import { refreshGraphData } from '@/state/graph-store'
import { useLinksStore } from '@/state/links-store'
import { hasUnsavedChanges, useNoteStore } from '@/state/note-store'
import { useTagsStore } from '@/state/tags-store'
import { toast } from '@/state/toast-store'
import { useUiStore } from '@/state/ui-store'

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

/**
 * **层级编辑**：把某个标签挂到一个父标签下（`甲` → `父/甲`），或提回顶层（`父/甲` → `甲`）。
 *
 * 与 [`renameTag`] 共用**同一条链路**（宿主侧 `tag_move` 内部就是 `tag_rename_in`），
 * 因此这里的收尾逻辑逐条对应：先落盘 → 宿主改全库 → 当前笔记对齐 → 面板/概览/图谱跟上。
 * 差别只有两处，都写在入参上：
 *
 * * `parent` 是**父标签**而不是新名字（空 = 提回顶层）；目标写法由宿主的
 *   `tag_move_target` 算（"末段保留、只换祖先"这条规则只有一处）；
 * * 非法移动（挂到自己/自己的后代/目标被占用）由宿主拒绝，错误信息直接说人话，
 *   这里只负责把它翻成一条 toast —— **绝不静默并掉一个标签**（那是"合并"，
 *   用户点的是"移到…"，得由他明确选择去用「重命名」）。
 */
export async function moveTag(
  key: string,
  parent: string,
  options: { includeChildren?: boolean; dryRun?: boolean } = {},
): Promise<TagRenameOutcome | null> {
  const includeChildren = options.includeChildren ?? true
  const dryRun = options.dryRun ?? false
  const source = key.trim()
  if (source === '') {
    toast.warn('标签名为空', '请从面板里选一个标签再调整层级')
    return null
  }

  const openRelPath = useNoteStore.getState().doc?.relPath ?? null

  try {
    if (!dryRun && hasUnsavedChanges()) {
      const saved = await useNoteStore.getState().saveNow()
      if (!saved && hasUnsavedChanges()) {
        toast.error('已取消层级调整', '当前笔记有未保存的修改，请先解决保存冲突')
        return null
      }
    }

    const outcome = await ipc.tagMove(source, parent.trim(), { includeChildren, dryRun })
    if (dryRun) return outcome

    const edited = new Set(outcome.edited.map((file) => file.relPath))
    if (changedAnything(outcome)) {
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
      const advice = groupSkips(outcome.skipped).map((group) => group.advice).join('；')
      toast.warn('层级调整未全部完成', `${resultSentence(outcome)} —— ${advice}`)
    } else if (outcome.edited.length > 0) {
      toast.success('已调整标签层级', `${outcome.fromDisplay} → ${outcome.toDisplay}：${resultSentence(outcome)}`)
    } else {
      toast.info('没有变化', resultSentence(outcome))
    }

    return outcome
  } catch (cause) {
    // 宿主的拒绝理由本身就是给用户看的人话（"不能把标签挂到它自己下面"…），
    // 因此**不能**走 `describeError` 那套按错误码映射的文案：那里 `PATH_INVALID`
    // 会翻成"路径不合法或被拒绝（已阻止越界访问）"，把这句关键提示顶掉 ——
    // 而"父标签打成了它自己的名字"恰恰是移动这条路上最常见的输入错误。
    toast.error(describeHostReason(MimenoteError.from(cause), '调整标签层级失败'))
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
