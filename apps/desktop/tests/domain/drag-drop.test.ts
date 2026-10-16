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
  it('笔记与文件夹都可以拖（附件仍然不行）', () => {
    expect(canDrag(makeEntry({ relPath: '项目/设计.md' }))).toBe(true)
    expect(canDrag(makeEntry({ relPath: '项目/笔记.markdown' }))).toBe(true)
    // 目录拖动：连同整棵子树的搬迁已经交付（`dir_move`）
    expect(canDrag(makeEntry({ relPath: '项目', isDir: true }))).toBe(true)
    // 附件（图片/`.txt`）不行：索引里没有它的条目，搬它不会带来任何链接改写
    expect(canDrag(makeEntry({ relPath: '附件/说明.txt' }))).toBe(false)
    expect(canDrag(null)).toBe(false)
    expect(canDrag(undefined)).toBe(false)
  })

  it('载荷带 Vault 相对路径 + 类型（笔记 / 文件夹）', () => {
    expect(dragPayloadOf(makeEntry({ relPath: '项目/设计.md' }))).toEqual({
      relPath: '项目/设计.md',
      kind: 'note',
    })
    expect(dragPayloadOf(makeEntry({ relPath: '项目', isDir: true }))).toEqual({
      relPath: '项目',
      kind: 'folder',
    })
  })
})

describe('落点计算', () => {
  const dragged = { relPath: '项目/设计.md', kind: 'note' as const }

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

describe('文件夹拖动：自己的后代是无效落点', () => {
  const folder = { relPath: '项目', kind: 'folder' as const }

  it('拖到别的文件夹：合法（整棵子树搬过去）', () => {
    const target = dropTargetFor(makeEntry({ relPath: '归档', isDir: true }), folder)
    expect(target.valid).toBe(true)
    expect(target.parentRel).toBe('归档')
  })

  it('拖到自己身上：无效，并说明"不能移到自己里面"', () => {
    const target = dropTargetFor(makeEntry({ relPath: '项目', isDir: true }), folder)
    expect(target.valid).toBe(false)
    expect(target.parentRel).toBeNull()
    expect(target.dataState).toBe('invalid')
    expect(target.reason).toContain('自己里面')
  })

  it('拖到自己的后代上（深一层也算）：无效，并说明是子目录', () => {
    for (const descendant of ['项目/子', '项目/子/更深/最深']) {
      const target = dropTargetFor(makeEntry({ relPath: descendant, isDir: true }), folder)
      expect(target.valid).toBe(false)
      expect(target.reason).toContain('子目录')
    }
    // 拖到自己后代里的**笔记**上（落点是它所在的目录）同样无效
    const viaNote = dropTargetFor(makeEntry({ relPath: '项目/子/细节.md' }), folder)
    expect(viaNote.valid).toBe(false)
    expect(viaNote.reason).toContain('子目录')
  })

  it('段感知：`项目2` 不是 `项目` 的后代（同前缀的兄弟目录仍然合法）', () => {
    const sibling = dropTargetFor(makeEntry({ relPath: '项目2', isDir: true }), folder)
    expect(sibling.valid).toBe(true)
    expect(sibling.parentRel).toBe('项目2')
  })

  it('拖到空白区域（= Vault 根）：本来就在根目录 → 无效（没变化）', () => {
    const target = dropTargetFor(null, folder)
    expect(target.valid).toBe(false)
    expect(target.reason).toContain('已经')
  })

  it('笔记拖到自己所在目录仍然是"没变化"（与文件夹判定互不干扰）', () => {
    const note = { relPath: '项目/设计.md', kind: 'note' as const }
    expect(dropTargetFor(makeEntry({ relPath: '项目', isDir: true }), note).valid).toBe(false)
    // 文件夹的那条守卫**不会**误伤笔记：`项目/设计.md` 拖到 `项目/子` 上是合法的
    expect(dropTargetFor(makeEntry({ relPath: '项目/子', isDir: true }), note).valid).toBe(true)
  })
})

describe('拖拽载荷的过手与校验', () => {
  it('写进 dataTransfer 并能读回来（`kind` 前缀让外部拖拽也能区分文件夹）', () => {
    const dt = fakeDataTransfer()
    writeDragPayload(dt, { relPath: '项目/设计.md', kind: 'note' })
    // 内部读的是"类型:路径"，外部程序认的 text/plain 仍然是裸相对路径
    expect(dt.getData(DRAG_MIME)).toBe('note:项目/设计.md')
    expect(dt.getData('text/plain')).toBe('项目/设计.md')
    expect(dt.effectAllowed).toBe('move')
    expect(readDragPayload(dt)).toEqual({ relPath: '项目/设计.md', kind: 'note' })

    const folder = fakeDataTransfer()
    writeDragPayload(folder, { relPath: '项目', kind: 'folder' })
    expect(readDragPayload(folder)).toEqual({ relPath: '项目', kind: 'folder' })
  })

  it('没有 `kind` 前缀的老格式载荷按笔记处理（不会因此变成非法）', () => {
    const dt = fakeDataTransfer()
    dt.setData(DRAG_MIME, '项目/设计.md')
    expect(readDragPayload(dt)).toEqual({ relPath: '项目/设计.md', kind: 'note' })
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
