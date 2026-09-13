/**
 * 拖拽整理文件：**落点判定**（纯函数，无 React/DOM 依赖，便于单测）。
 *
 * 为什么把判定提出去：拖拽最容易出错的地方不是"搬文件"（那是宿主的活），而是
 * "用户以为会搬到 A，实际搬到 B" —— 悬停高亮、状态栏提示、最终落点必须是**同一个判断**
 * 算出来的。放在纯函数里，这三处共用一份逻辑，也能用 vitest 单独钉死。
 *
 * 落点规则（文件管理器里最符合直觉的那一套）：
 *
 * | 拖到 | 落点目录 |
 * | --- | --- |
 * | 文件夹行 | 那个文件夹 |
 * | 笔记（非目录）行 | 那篇笔记**所在的目录** |
 * | 树的空白区域 | Vault 根目录 |
 *
 * 拖拽载荷刻意只带一个相对路径：本轮只支持单篇笔记（多选、目录拖动都推迟），
 * 而且跨 IPC 只传 Vault 相对路径这条约定在这里同样适用。
 */

import type { EntryMeta } from '@/ipc/types'
import { basename, isMarkdown, parentOf } from './paths'

/**
 * 拖拽载荷的 MIME 类型。
 *
 * 自定义类型是给"拖到别的窗口/编辑器"留的语义（外部程序看到 `text/plain` 里的相对路径），
 * **不是**本应用内部读落点的唯一来源：HTML5 的 `dragover` 阶段读不到 `getData()`
 * （安全限制），所以组件自己持有一份"当前拖的是谁"的状态，`dataTransfer` 只用于过手。
 */
export const DRAG_MIME = 'application/x-mimenote-note'

/** 一次拖拽的载荷。 */
export interface DragPayload {
  /** 被拖动的笔记（相对 Vault 根，POSIX）。 */
  relPath: string
}

/** 落点类型（同时决定悬停时的高亮样式）。 */
export type DropZoneKind =
  /** 树的空白区域 → Vault 根目录。 */
  | 'root'
  /** 文件夹行 → 这个文件夹。 */
  | 'folder'
  /** 笔记行 → 它的父目录。 */
  | 'note-parent'

/** 一次"这里能放吗"的判断结果。 */
export interface DropTarget {
  kind: DropZoneKind
  /** 落点目录（Vault 根为 `''`）；**不可放置时是 `null`**。 */
  parentRel: string | null
  /** 悬停行的稳定标识（`''` = 空白区域），用来在虚拟列表里只重绘受影响的两行。 */
  hostRelPath: string
  /** 是否可以落下。 */
  valid: boolean
  /**
   * 给 DOM 用的状态（`data-drop-state`）。
   *
   * 刻意**不是** `valid ? 'valid' : 'invalid'` 的三态缩写：`DropTarget` 只在悬停期间存在，
   * "没有落点"由 `null` 表达，所以这里只有两种取值 —— 组件里少一层判空。
   */
  dataState: 'valid' | 'invalid'
  /** 不能落下的原因（`valid === true` 时为 `null`）。 */
  reason: string | null
  /** 面向用户的一句话说明（悬停提示、状态栏、toast 都用它）。 */
  label: string
}

/** 这个条目能不能被拖动（本轮：只有 Markdown 笔记，目录明确推迟）。 */
export function canDrag(entry: EntryMeta | null | undefined): boolean {
  if (entry === null || entry === undefined) return false
  return !entry.isDir && isMarkdown(entry.relPath)
}

/** 由条目构造拖拽载荷（只在 `canDrag(entry)` 为真时调用）。 */
export function dragPayloadOf(entry: EntryMeta): DragPayload {
  return { relPath: entry.relPath }
}

/** 从条目表里找一条（`dropTargetFor` 的便捷入口）。 */
export function entryOf(relPath: string, entries: readonly EntryMeta[]): EntryMeta | null {
  return entries.find((entry) => entry.relPath === relPath) ?? null
}

/**
 * 算出"拖到 `target` 上"的落点。
 *
 * `target === null` 表示**树的空白区域**（见 `FileTree` 的容器级 drop handler）。
 * `dragged` 是拖拽载荷；判定"能不能放"时只比目录 —— 拖到自己所在目录是无意义的操作
 * （宿主会当无操作处理，但用户需要的是"别让我以为搬动了"）。
 */
export function dropTargetFor(target: EntryMeta | null, dragged: DragPayload): DropTarget {
  const fromDir = parentOf(dragged.relPath)

  if (target === null) {
    return resolve({
      kind: 'root',
      hostRelPath: '',
      parentRel: '',
      fromDir,
      what: 'Vault 根目录',
    })
  }

  if (target.isDir) {
    return resolve({
      kind: 'folder',
      hostRelPath: target.relPath,
      parentRel: target.relPath,
      fromDir,
      what: `文件夹「${target.name}」`,
    })
  }

  const parentRel = parentOf(target.relPath)
  return resolve({
    kind: 'note-parent',
    hostRelPath: target.relPath,
    parentRel,
    fromDir,
    what: parentRel === '' ? `「${target.name}」所在的 Vault 根目录` : `「${target.name}」所在的目录`,
  })
}

interface ResolveInput {
  kind: DropZoneKind
  hostRelPath: string
  parentRel: string
  fromDir: string
  what: string
}

/** 把"在哪放"补全成"能不能放"。 */
function resolve(input: ResolveInput): DropTarget {
  if (input.parentRel === input.fromDir) {
    return {
      kind: input.kind,
      hostRelPath: input.hostRelPath,
      parentRel: null,
      valid: false,
      dataState: 'invalid',
      reason: '已经在这个目录里了',
      label: input.parentRel === '' ? '已经在 Vault 根目录' : `已经在「${input.parentRel}」里`,
    }
  }
  return {
    kind: input.kind,
    hostRelPath: input.hostRelPath,
    parentRel: input.parentRel,
    valid: true,
    dataState: 'valid',
    reason: null,
    label: `移动到${input.what}`,
  }
}

/** 两个落点是不是同一处（避免每次 `dragover` 都触发一次 React 重渲染）。 */
export function sameDropTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  if (a === null || b === null) return a === b
  return a.hostRelPath === b.hostRelPath && a.valid === b.valid
}

/** 把载荷写进 `dataTransfer`（`dragstart` 用）。 */
export function writeDragPayload(dataTransfer: DataTransfer | null, payload: DragPayload): void {
  if (dataTransfer === null) return
  dataTransfer.setData(DRAG_MIME, payload.relPath)
  // 外部程序（编辑器、文件管理器）只认 text/plain：给相对路径比给别的好
  dataTransfer.setData('text/plain', payload.relPath)
  dataTransfer.effectAllowed = 'move'
}

/**
 * 从 `dataTransfer` 读回载荷（`drop` 用）。
 *
 * 注意 `dragover` 阶段读不到数据（浏览器安全限制），所以调用方必须自己留一份状态；
 * 这里只在 `drop` 时用它做兜底与交叉校验（例如从另一个窗口拖过来的文本 —— 那种情况
 * 我们会因为拿不到"这是本 Vault 的笔记"的确认而拒绝，见 `isSafeRelPath`）。
 */
export function readDragPayload(dataTransfer: DataTransfer | null): DragPayload | null {
  if (dataTransfer === null) return null
  const raw = dataTransfer.getData(DRAG_MIME)
  if (raw === '') return null
  return isSafeRelPath(raw) ? { relPath: raw } : null
}

/** 形状校验：必须是 Vault 相对路径（非空、不以 `/` 开头、不含 `..` 段）。 */
export function isSafeRelPath(relPath: string): boolean {
  if (relPath.trim() === '') return false
  if (relPath.startsWith('/') || /^[a-zA-Z]:/.test(relPath)) return false
  return relPath
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/** 文件名（`relPath` 的最后一段）—— 提示文案里用。 */
export function draggedName(payload: DragPayload): string {
  return basename(payload.relPath)
}
