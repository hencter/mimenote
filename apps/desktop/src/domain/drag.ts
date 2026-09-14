/**
 * 拖拽整理文件：**落点判定**（纯函数，无 React/DOM 依赖，便于单测）。
 *
 * 为什么把判定提出去：拖拽最容易出错的地方不是"搬文件"（那是宿主的活），而是
 * "用户以为会搬到 A，实际搬到 B" —— 悬停高亮、状态栏提示、最终落点必须是**同一个判断**
 * 算出来的。放在纯函数里，这三处共用一份逻辑，也能用 vitest 单独钉死。
 *
 * 落点规则（文件管理器里最符合直觉的那一套）：
 *
 * | 拖到 | 落点目录 | 备注 |
 * | --- | --- | --- |
 * | 文件夹行 | 那个文件夹 | **文件夹拖到文件夹**时多一条守卫：见下 |
 * | 笔记（非目录）行 | 那篇笔记**所在的目录** | |
 * | 树的空白区域 | Vault 根目录 | |
 *
 * **文件夹拖到自己的后代上必须无效**：`项目` 拖到 `项目/子项目` 上等于"把目录移进它自己
 * 里面"，文件系统层面当然会失败，但错误是"系统找不到指定的路径"这种用户无法据以行动的话。
 * 这里判成 invalid 并给出原因（悬停就看得见），宿主那边也拦同一件事 —— 两侧都要有，
 * 前端负责"根本不让它落"，宿主负责"谁来都不许"。
 *
 * 拖拽载荷只带一个相对路径 + 一个 kind（笔记 / 文件夹）：跨 IPC 只传 Vault 相对路径这条
 * 约定在这里同样适用，`kind` 只用来算落点合法性（宿主不看它，它按落点所在的目录判定）。
 */

import type { EntryMeta } from '@/ipc/types'
import { displayName, isMarkdown, parentOf } from './paths'

/**
 * 拖拽载荷的 MIME 类型。
 *
 * 自定义类型是给"拖到别的窗口/编辑器"留的语义（外部程序看到 `text/plain` 里的相对路径），
 * **不是**本应用内部读落点的唯一来源：HTML5 的 `dragover` 阶段读不到 `getData()`
 * （安全限制），所以组件自己持有一份"当前拖的是谁"的状态，`dataTransfer` 只用于过手。
 */
export const DRAG_MIME = 'application/x-mimenote-note'

/** 被拖动的条目是笔记还是文件夹（决定落点合法性，不影响"搬到哪个目录"）。 */
export type DragKind = 'note' | 'folder'

/** 一次拖拽的载荷。 */
export interface DragPayload {
  /** 被拖动的条目（相对 Vault 根，POSIX）。 */
  relPath: string
  /**
   * 这条载荷是笔记还是文件夹（决定落点合法性，不影响"搬到哪个目录"）。
   *
   * 可选、缺省 `'note'`：载荷只带一个相对路径是本层的既有约定（"跨 IPC 只传 Vault 相对
   * 路径"那条纪律的延伸）—— 老格式的载荷（只有 `relPath`）按笔记处理，不会因此被判成非法落点。
   */
  kind?: DragKind
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

/**
 * 这个条目能不能被拖动。
 *
 * 笔记（Markdown）与**文件夹**都可以；附件（图片、`.txt`）不行 —— 移动它们要"顺带改写
 * 指向它的链接"，而索引里根本没有它们的条目，拖了只会得到一次无提示的裸搬迁。
 */
export function canDrag(entry: EntryMeta | null | undefined): boolean {
  if (entry === null || entry === undefined) return false
  if (entry.isDir) return true
  return isMarkdown(entry.relPath)
}

/** 由条目构造拖拽载荷（只在 `canDrag(entry)` 为真时调用）。 */
export function dragPayloadOf(entry: EntryMeta): DragPayload {
  return { relPath: entry.relPath, kind: entry.isDir ? 'folder' : 'note' }
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
      dragged,
      what: 'Vault 根目录',
    })
  }

  if (target.isDir) {
    return resolve({
      kind: 'folder',
      hostRelPath: target.relPath,
      parentRel: target.relPath,
      fromDir,
      dragged,
      what: `文件夹「${target.name}」`,
    })
  }

  const parentRel = parentOf(target.relPath)
  return resolve({
    kind: 'note-parent',
    hostRelPath: target.relPath,
    parentRel,
    fromDir,
    dragged,
    what: parentRel === '' ? `「${target.name}」所在的 Vault 根目录` : `「${target.name}」所在的目录`,
  })
}

interface ResolveInput {
  kind: DropZoneKind
  hostRelPath: string
  parentRel: string
  fromDir: string
  dragged: DragPayload
  what: string
}

/** 把"在哪放"补全成"能不能放"。 */
function resolve(input: ResolveInput): DropTarget {
  // 文件夹拖到它自己或它的后代上：那等于把目录搬进自己里面，必须无效并说明原因
  if (input.dragged.kind === 'folder' && isSameOrInside(input.parentRel, input.dragged.relPath)) {
    const ontoItself = input.parentRel === input.dragged.relPath
    return {
      kind: input.kind,
      hostRelPath: input.hostRelPath,
      parentRel: null,
      valid: false,
      dataState: 'invalid',
      reason: ontoItself
        ? '不能把文件夹移动到它自己里面'
        : '不能把文件夹移动到它自己的子目录里',
      label: ontoItself
        ? '不能把文件夹移动到它自己里面'
        : `「${displayName(input.dragged.relPath)}」不能移动到它自己的子目录里`,
    }
  }
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

/**
 * `relPath` 是不是在目录 `dir` 之内（含等于它自己）。
 *
 * 段感知：`项目2` 以 `项目` 开头却**不是**它的后代 —— 用 `startsWith(dir)` 一把梭会把
 * "拖到同前缀的兄弟目录"误判成"拖进自己的子目录"，用户会看到一句莫名其妙的原因。
 */
export function isSameOrInside(relPath: string, dir: string): boolean {
  if (dir === '') return false
  return relPath === dir || relPath.startsWith(`${dir}/`)
}

/** 两个落点是不是同一处（避免每次 `dragover` 都触发一次 React 重渲染）。 */
export function sameDropTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  if (a === null || b === null) return a === b
  return a.hostRelPath === b.hostRelPath && a.valid === b.valid
}

/**
 * 把载荷写进 `dataTransfer`（`dragstart` 用）。
 *
 * 自定义 MIME 里带上 `kind`（`folder:` / `note:` 前缀），`drop` 时才能从外部拖拽里区分
 * "这是一个文件夹"；`text/plain` 仍然是裸相对路径（外部程序只认它）。
 */
export function writeDragPayload(dataTransfer: DataTransfer | null, payload: DragPayload): void {
  if (dataTransfer === null) return
  dataTransfer.setData(DRAG_MIME, `${payload.kind}:${payload.relPath}`)
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
  const separator = raw.indexOf(':')
  const prefix = separator === -1 ? '' : raw.slice(0, separator)
  // 不带 `kind` 前缀的载荷按"笔记"处理（旧格式 / 手工塞进来的文本）
  const kind: DragKind = prefix === 'folder' ? 'folder' : 'note'
  const relPath = separator === -1 ? raw : raw.slice(separator + 1)
  return isSafeRelPath(relPath) ? { relPath, kind } : null
}

/** 形状校验：必须是 Vault 相对路径（非空、不以 `/` 开头、不含 `..` 段）。 */
export function isSafeRelPath(relPath: string): boolean {
  if (relPath.trim() === '') return false
  if (relPath.startsWith('/') || /^[a-zA-Z]:/.test(relPath)) return false
  return relPath
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/** 文件名（`relPath` 的最后一段）—— 提示文案里用；笔记不带 `.md`（ADR-0030）。 */
export function draggedName(payload: DragPayload): string {
  return displayName(payload.relPath)
}

