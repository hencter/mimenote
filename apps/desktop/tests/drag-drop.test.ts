/**
 * 拖拽落点判定（纯函数）：`domain/drag.ts`。
 *
 * 这一层的价值在于"用户以为会搬到 A、实际搬到 B"是最难查的一类缺陷 ——
 * 悬停高亮、提示文案、最终落点必须是同一份判断算出来的。所以这里把规则钉死：
 *
 * | 拖到 | 落点 |
 * | --- | --- |
 * | 文件夹 | 那个文件夹 |
 * | 笔记 | 它所在的目录 |
 * | 空白区域 | Vault 根目录 |
 *
 * 以及"无意义的落点"（已经在该目录里、拖到自己身上）必须**明确标成不可放置**，
 * 而不是静默地发一次 IPC 再回来告诉用户"什么都没变"。
 */

import { describe, expect, it } from 'vitest'

import {
  DRAG_MIME,
  canDrag,
  dragPayloadOf,
  dropTargetFor,
  isSafeRelPath,
  readDragPayload,
  sameDropTarget,
  writeDragPayload,
} from '@/domain/drag'
import { makeEntry } from '@/ipc/client'

/** 最小 `DataTransfer` 替身（jsdom 不实现它）。 */
function fakeDataTransfer(): DataTransfer {
  const store = new Map<string, string>()
  return {
    setData: (type: string, value: string) => {
      store.set(type, value)
    },
    getData: (type: string) => store.get(type) ?? '',
    effectAllowed: 'uninitialized',
  } as unknown as DataTransfer
}

describe('哪些条目可以拖动', () => {
  it('只有 Markdown 笔记可以拖（目录拖动明确推迟）', () => {
    expect(canDrag(makeEntry({ relPath: '项目/设计.md' }))).toBe(true)
    expect(canDrag(makeEntry({ relPath: '项目/笔记.markdown' }))).toBe(true)
    expect(canDrag(makeEntry({ relPath: '项目', isDir: true }))).toBe(false)
    expect(canDrag(makeEntry({ relPath: '附件/说明.txt' }))).toBe(false)
    expect(canDrag(null)).toBe(false)
    expect(canDrag(undefined)).toBe(false)
  })

  it('载荷只带 Vault 相对路径', () => {
    expect(dragPayloadOf(makeEntry({ relPath: '项目/设计.md' }))).toEqual({
      relPath: '项目/设计.md',
    })
  })
})

describe('落点计算', () => {
  const dragged = { relPath: '项目/设计.md' }

  it('拖到文件夹上 → 移到那个文件夹', () => {
    const target = dropTargetFor(makeEntry({ relPath: '日记', isDir: true }), dragged)
    expect(target.kind).toBe('folder')
    expect(target.parentRel).toBe('日记')
    expect(target.valid).toBe(true)
    expect(target.label).toContain('日记')
  })

  it('拖到另一篇笔记上 → 移到那篇笔记所在的目录', () => {
    const target = dropTargetFor(makeEntry({ relPath: '日记/2025-01-01.md' }), dragged)
    expect(target.kind).toBe('note-parent')
    expect(target.parentRel).toBe('日记')
    expect(target.valid).toBe(true)
  })

  it('拖到根目录下的笔记上 → 落点是 Vault 根（空串）', () => {
    const target = dropTargetFor(makeEntry({ relPath: 'README.md' }), dragged)
    expect(target.parentRel).toBe('')
    expect(target.valid).toBe(true)
    expect(target.label).toContain('根目录')
  })

  it('拖到树的空白区域 → Vault 根目录', () => {
    const target = dropTargetFor(null, dragged)
    expect(target.kind).toBe('root')
    expect(target.parentRel).toBe('')
    expect(target.valid).toBe(true)
    expect(target.hostRelPath).toBe('')
  })

  it('已经在该目录里 → 不可放置，并给出原因（而不是静默无反应）', () => {
    const sameFolder = dropTargetFor(makeEntry({ relPath: '项目', isDir: true }), dragged)
    expect(sameFolder.valid).toBe(false)
    expect(sameFolder.parentRel).toBeNull()
    expect(sameFolder.reason).toContain('已经')

    // 拖到自己身上：父目录就是它自己的目录
    const ontoItself = dropTargetFor(makeEntry({ relPath: '项目/设计.md' }), dragged)
    expect(ontoItself.valid).toBe(false)

    // 根目录里的笔记拖到空白区域同样是"没变化"
    const rootNote = { relPath: 'README.md' }
    expect(dropTargetFor(null, rootNote).valid).toBe(false)
  })

  it('文件夹是合法落点，即使它当前是收起状态（不看展开与否）', () => {
    const collapsed = makeEntry({ relPath: '很深的目录', isDir: true })
    expect(dropTargetFor(collapsed, dragged).parentRel).toBe('很深的目录')
  })

  it('落点标识稳定：同一处不重复 set（虚拟列表只重绘受影响的行）', () => {
    const a = dropTargetFor(makeEntry({ relPath: '日记', isDir: true }), dragged)
    const b = dropTargetFor(makeEntry({ relPath: '日记', isDir: true }), dragged)
    expect(sameDropTarget(a, b)).toBe(true)
    expect(sameDropTarget(a, dropTargetFor(null, dragged))).toBe(false)
    expect(sameDropTarget(null, null)).toBe(true)
    expect(sameDropTarget(a, null)).toBe(false)
  })
})

describe('拖拽载荷的过手与校验', () => {
  it('写进 dataTransfer 并能读回来', () => {
    const dt = fakeDataTransfer()
    writeDragPayload(dt, { relPath: '项目/设计.md' })
    expect(dt.getData(DRAG_MIME)).toBe('项目/设计.md')
    // 外部程序（编辑器/文件管理器）只认 text/plain
    expect(dt.getData('text/plain')).toBe('项目/设计.md')
    expect(dt.effectAllowed).toBe('move')
    expect(readDragPayload(dt)).toEqual({ relPath: '项目/设计.md' })
  })

  it('外部拖进来的普通文本不会被当成"本 Vault 的笔记"', () => {
    const dt = fakeDataTransfer()
    dt.setData('text/plain', '项目/设计.md')
    expect(readDragPayload(dt)).toBeNull()
    expect(readDragPayload(null)).toBeNull()
  })

  it('路径形状校验：越界与绝对路径一律拒收', () => {
    for (const bad of ['', '   ', '/etc/passwd', 'C:/x.md', '../外面.md', 'a/../b.md', 'a//b.md']) {
      expect(isSafeRelPath(bad)).toBe(false)
    }
    expect(isSafeRelPath('项目/设计.md')).toBe(true)

    const dt = fakeDataTransfer()
    dt.setData(DRAG_MIME, '../外面.md')
    expect(readDragPayload(dt)).toBeNull()
  })
})
