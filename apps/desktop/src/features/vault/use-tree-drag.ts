/**
 * 文件树的拖拽整理：**单栏与分栏共用**一套手柄（落点判定在 `domain/drag.ts`，仍然是纯函数）。
 *
 * 为什么抽成 hook：分栏视图的行与单栏的行是同一个组件（`TreeRow.tsx`），
 * 落点规则也应当逐字相同（拖到文件夹行 → 那个文件夹；拖到笔记行 → 它的父目录；
 * 拖到空白处 → 那个"空白"代表的目录）。两份复制品的第一次分叉就是"单栏能拖、
 * 分栏拖了没反应"这种最容易被当成随机 bug 的症状。
 *
 * ## 与单栏相比**唯一**的差别：空白处代表哪个目录
 *
 * - 单栏：整块的空白区域 = **Vault 根目录**（容器自己处理 dragover/drop）；
 * - 分栏：每一列的空白 = **那一列显示的目录**（列自己处理）—— 一列就是"一个目录的内容"，
 *   落在它的空白处自然是放进那个目录。第一列因此天然提供了"移到 Vault 根"这个落点，
 *   比"整块空白都是根目录"更符合"拖到哪儿就是哪儿"的直觉。
 *
 * 两处共用的纪律（见 `FileTree` 的文件头与 `domain/drag.ts` 的表格）：
 *
 * * `dragover` 阶段读不到 `dataTransfer.getData()`，所以"当前拖的是谁"由调用方持有的
 *   `dragRef` 提供（`useTreeDrag` 只读它，不持有它）；
 * * 行自己 `stopPropagation`，所以走到列的 dragover 一定是"落在列的空白处"；
 * * **标签过滤期间不接收空白落点**：收窄之后列表很短、空白很大，一次不经意的拖动就会
 *   把笔记静默搬走，而目标目录在收窄视图里通常根本看不见。不 `preventDefault` 让浏览器
 *   给出"不可放置"的光标 —— 比静默搬家诚实；真的走到 drop（真实浏览器不可能）也要说明原因。
 */

import { useCallback } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'

import { moveEntry } from '@/app/actions'
import { useLayoutDrag } from '@/features/layout/layout-drag'
import { noteItem } from '@/features/layout/tree-layout'
import {
  canDrag,
  dragPayloadOf,
  dropTargetFor,
  readDragPayload,
  writeDragPayload,
  type DragPayload,
  type DropTarget,
} from '@/domain/drag'
import type { EntryMeta } from '@/ipc/types'
import { toast } from '@/state/toast-store'
import type { RowRef } from './TreeRow'

/**
 * 落点的最终执行：**唯一**的"把拖拽变成移动"的地方。
 *
 * 笔记与文件夹都走同一条 `moveEntry`（它按条目类型分派）：拖拽只是"把某个条目挪到某个目录"
 * 的手势，两种条目在"搬 + 改写链接 + 索引同步"这条链路上没有区别。
 *
 * 不可放置的落点（同一目录、拖到自己身上、拖进自己的后代）在这里就被拦下：不触发 IPC，
 * 只把**原因**告诉用户 —— 静默无反应是拖拽最糟的反馈。
 */
export async function applyDrop(payload: DragPayload, target: DropTarget): Promise<void> {
  if (!target.valid || target.parentRel === null) {
    toast.info(target.label, target.reason ?? '')
    return
  }
  await moveEntry(payload.relPath, target.parentRel)
}

export interface TreeDragHandlers {
  handleDragStart: (row: RowRef, event: ReactDragEvent<HTMLDivElement>) => void
  handleDragOver: (row: RowRef, event: ReactDragEvent<HTMLDivElement>) => void
  handleDrop: (row: RowRef, event: ReactDragEvent<HTMLDivElement>) => void
  /**
   * 空白区域的 dragover / drop。`dirRelPath` 是这块空白代表的目录：
   * 单栏传 `''`（Vault 根），分栏传那一列的目录路径。
   */
  handleBlankDragOver: (dirRelPath: string, event: ReactDragEvent<HTMLDivElement>) => void
  handleBlankDrop: (dirRelPath: string, event: ReactDragEvent<HTMLDivElement>) => void
  /** 拖出树的范围时收掉高亮（`dragleave` 在子元素之间移动也会触发，所以要判包含关系）。 */
  handleDragLeave: (event: ReactDragEvent<HTMLDivElement>) => void
  /** 从源行冒泡上来的 `dragend`：无论成功与否都收掉高亮，不留一个假的"落点"。 */
  handleDragEnd: () => void
}

export interface TreeDragOptions {
  /** 当前"拖的是谁"的权威副本（HTML5 在 `dragover` 阶段读不到 dataTransfer）。 */
  dragRef: { current: DragPayload | null }
  /** 拖起来的瞬间把那一行选中（"我拖的是这一个"）。 */
  select: (relPath: string) => void
  setDragPayload: (payload: DragPayload | null) => void
  setDropTarget: (next: DropTarget | null) => void
  clearDrag: () => void
  showDropTarget: (next: DropTarget) => void
  /** 生效中的标签可见集合（`null` = 没有标签过滤）。 */
  tagVisible: ReadonlySet<string> | null
}

export function useTreeDrag(options: TreeDragOptions): TreeDragHandlers {
  const { dragRef, select, setDragPayload, setDropTarget, clearDrag, showDropTarget, tagVisible } =
    options

  const payloadOf = useCallback(
    (event: ReactDragEvent<HTMLDivElement>): DragPayload | null =>
      dragRef.current ?? readDragPayload(event.dataTransfer),
    [dragRef],
  )

  const handleDragStart = useCallback(
    (row: RowRef, event: ReactDragEvent<HTMLDivElement>): void => {
      const entry = row.node.entry
      if (!entry.isDir) useLayoutDrag.getState().begin(noteItem(entry.relPath), true)
      if (!canDrag(entry)) {
        // 附件（图片/`.txt`）不可拖动：移动它们要"顺带改写指向它的链接"，而索引里没有它们
        // 的条目 —— 拖了只会得到一次无提示的裸搬迁
        event.dataTransfer.effectAllowed = 'copyMove'
        event.dataTransfer.setData('application/x-mimenote-layout', entry.relPath)
        return
      }
      const payload = dragPayloadOf(entry)
      dragRef.current = payload
      setDragPayload(payload)
      writeDragPayload(event.dataTransfer, payload)
      select(entry.relPath)
    },
    [dragRef, select, setDragPayload],
  )

  const handleDragOver = useCallback(
    (row: RowRef, event: ReactDragEvent<HTMLDivElement>): void => {
      const payload = payloadOf(event)
      if (payload === null) return
      const target = dropTargetFor(row.node.entry, payload)
      // 必须 preventDefault，否则浏览器不认这里是可放置区（也就不会有 drop 事件）
      event.preventDefault()
      // 行自己处理落点，不要再冒泡到容器 —— 那里代表"空白区域 = 某个目录"
      event.stopPropagation()
      event.dataTransfer.dropEffect = target.valid ? 'move' : 'none'
      showDropTarget(target)
    },
    [payloadOf, showDropTarget],
  )

  const handleDrop = useCallback(
    (row: RowRef, event: ReactDragEvent<HTMLDivElement>): void => {
      const payload = payloadOf(event)
      if (payload === null) return
      event.preventDefault()
      event.stopPropagation()
      const target = dropTargetFor(row.node.entry, payload)
      clearDrag()
      void applyDrop(payload, target)
    },
    [clearDrag, payloadOf],
  )

  const handleBlankDragOver = useCallback(
    (dirRelPath: string, event: ReactDragEvent<HTMLDivElement>): void => {
      const payload = payloadOf(event)
      if (payload === null) return
      if (tagVisible !== null) {
        setDropTarget(null)
        return
      }
      const target = dropTargetFor(entryForBlank(dirRelPath), payload)
      event.preventDefault()
      event.dataTransfer.dropEffect = target.valid ? 'move' : 'none'
      showDropTarget(target)
    },
    [payloadOf, setDropTarget, showDropTarget, tagVisible],
  )

  const handleBlankDrop = useCallback(
    (dirRelPath: string, event: ReactDragEvent<HTMLDivElement>): void => {
      const payload = payloadOf(event)
      if (payload === null) return
      if (tagVisible !== null) {
        // 真实浏览器里到不了这里（没有 `preventDefault` 就没有 `drop`），但把原因说出来
        // 成本极低：静默吞掉一次拖拽才是最糟的反馈（也是这句提示存在的唯一理由）
        clearDrag()
        toast.info(
          '过滤期间不能拖到树的空白处',
          dirRelPath === ''
            ? '空白处 = Vault 根目录。请拖到看得见的文件夹行上，或先清除标签过滤。'
            : `空白处 = 列「${dirRelPath}」。请拖到看得见的文件夹行上，或先清除标签过滤。`,
        )
        return
      }
      event.preventDefault()
      const target = dropTargetFor(entryForBlank(dirRelPath), payload)
      clearDrag()
      void applyDrop(payload, target)
    },
    [clearDrag, payloadOf, tagVisible],
  )

  const handleDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget
    if (next instanceof Node && event.currentTarget.contains(next)) return
    setDropTarget(null)
  }, [setDropTarget])

  const handleDragEnd = useCallback((): void => {
    useLayoutDrag.getState().end()
    clearDrag()
  }, [clearDrag])

  return {
    handleDragStart,
    handleDragOver,
    handleDrop,
    handleBlankDragOver,
    handleBlankDrop,
    handleDragLeave,
    handleDragEnd,
  }
}

/**
 * 空白区域代表的"条目"。
 *
 * `dropTargetFor` 只认两种输入：一个真实条目（文件夹 / 笔记行）或 `null`（Vault 根）。
 * 分栏的空白是一个**目录**（第一列是 Vault 根），所以这里合成一个"目录条目"——
 * 形状与扫描口径一致（`sizeBytes: 0` / `mtimeMs: null` / `ext: null`，见 `mn_core::scanner`），
 * 而且**只用于算落点**：它不会被写进任何 store，也不会被渲染。
 */
function entryForBlank(dirRelPath: string): EntryMeta | null {
  if (dirRelPath === '') return null
  return {
    relPath: dirRelPath,
    name: dirRelPath.split('/').pop() ?? dirRelPath,
    isDir: true,
    sizeBytes: 0,
    mtimeMs: null,
    ext: null,
  }
}
