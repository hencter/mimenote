/**
 * 文档**仓库**的集成测试（ADR-0054）：几篇同时开着时，正文 / 脏标记 / 保存 / 冲突各归各的。
 *
 * 与 `note-store.test.ts` 的分工：那边钉"当前文档"这套旧 API 的契约一字未改；
 * 这边钉**按篇**的那一半 —— 也就是"分栏里每格都能编辑"能成立的地基。
 *
 * 最后两条（干净要重读、脏了不重读）是**真实回归**的直接门禁：
 * `ui.e2e.test.ts` 的"重命名笔记…并验证可逆"曾经因为"已在仓库就一律不重读"而红 ——
 * 重命名会外部改写别的笔记（改指向它的链接），而阅读视图渲染的是内存正文。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter, type MockAdapter } from '@/ipc/mock-adapter'
import { hasUnsavedChanges, useNoteStore } from '@/state/note-store'

let adapter: MockAdapter

function textOnDisk(relPath: string): string | undefined {
  return adapter.dump().find((note) => note.relPath === relPath)?.text
}

beforeEach(() => {
  adapter = createMockAdapter({
    notes: [
      { relPath: 'a.md', text: '# A\n' },
      { relPath: 'b.md', text: '# B\n' },
    ],
  })
  setIpcAdapter(adapter)
  useNoteStore.getState().closeAll()
})

afterEach(() => {
  useNoteStore.getState().closeAll()
})

describe('文档仓库：几篇同时开着', () => {
  it('openDoc 进仓库但不抢当前文档；两篇各有自己的正文', async () => {
    await useNoteStore.getState().open('a.md')
    const state = useNoteStore.getState()
    expect(state.activePath).toBe('a.md')
    expect(state.docs['b.md']).toBeUndefined()

    // 分栏里新出现的格子读自己的那一篇 —— 不改变"当前文档"
    expect(await state.openDoc('b.md')).toBe(true)
    const after = useNoteStore.getState()
    expect(after.activePath).toBe('a.md')
    expect(after.doc?.relPath).toBe('a.md')
    expect(after.docOf('a.md')?.text).toBe('# A\n')
    expect(after.docOf('b.md')?.text).toBe('# B\n')
    // 同一篇再问一次：已经在仓库里，不会再读一遍（幂等）
    expect(await useNoteStore.getState().openDoc('b.md')).toBe(true)
  })

  it('按篇写正文与脏标记：改 B 不影响 A', async () => {
    useNoteStore.getState().closeAll()
    await useNoteStore.getState().open('a.md')
    await useNoteStore.getState().openDoc('b.md')

    useNoteStore.getState().setTextFor('b.md', '# B 改过\n')
    const state = useNoteStore.getState()
    expect(state.docOf('b.md')?.dirty).toBe(true)
    expect(state.docOf('a.md')?.dirty).toBe(false)
    expect(state.dirtyPaths).toEqual(['b.md'])
    expect(state.dirty).toBe(false) // 镜像说的是当前文档（A）那一篇
    expect(hasUnsavedChanges()).toBe(true) // 但"有没有未保存内容"要照顾所有篇
  })

  it('按篇保存：只有这一篇落盘，别的篇一个字节都不动', async () => {
    await useNoteStore.getState().open('a.md')
    await useNoteStore.getState().openDoc('b.md')
    useNoteStore.getState().setTextFor('b.md', '# B 已保存\n')

    expect(await useNoteStore.getState().saveNowFor('b.md')).toBe(true)
    expect(textOnDisk('b.md')).toBe('# B 已保存\n')
    expect(textOnDisk('a.md')).toBe('# A\n')
    expect(useNoteStore.getState().docOf('b.md')?.dirty).toBe(false)
    expect(useNoteStore.getState().dirtyPaths).toEqual([])
  })

  it('冲突按篇：B 撞外部改动只让 B 进冲突态，A 照旧', async () => {
    await useNoteStore.getState().open('a.md')
    await useNoteStore.getState().openDoc('b.md')
    useNoteStore.getState().setTextFor('b.md', '# 我的版本\n')
    adapter.simulateExternalEdit('b.md', '# 别人的版本\n')

    expect(await useNoteStore.getState().saveNowFor('b.md')).toBe(false)
    const state = useNoteStore.getState()
    expect(state.docOf('b.md')?.conflict).not.toBeNull()
    expect(state.docOf('b.md')?.dirty).toBe(true)
    expect(state.conflictPaths).toEqual(['b.md'])
    // 当前文档（A）不受影响：镜像仍是 ready、没有冲突
    expect(state.doc?.relPath).toBe('a.md')
    expect(state.status).toBe('ready')
    expect(state.conflict).toBeNull()
    // 别人的版本原样留在磁盘上
    expect(textOnDisk('b.md')).toBe('# 别人的版本\n')
  })

  it('closeDoc 只收这一篇；closeAll 清空整个仓库', async () => {
    await useNoteStore.getState().open('a.md')
    await useNoteStore.getState().openDoc('b.md')

    useNoteStore.getState().closeDoc('b.md')
    expect(useNoteStore.getState().docs['b.md']).toBeUndefined()
    expect(useNoteStore.getState().docs['a.md']).toBeDefined()

    useNoteStore.getState().closeAll()
    const empty = useNoteStore.getState()
    expect(empty.docs).toEqual({})
    expect(empty.activePath).toBeNull()
    expect(empty.doc).toBeNull()
  })
})

describe('文档仓库：切当前时的重读口径', () => {
  it('干净的那篇被切为当前时**重读盘**（外部改写进得来）', async () => {
    await useNoteStore.getState().open('a.md')
    await useNoteStore.getState().openDoc('b.md')
    expect(useNoteStore.getState().docOf('b.md')?.text).toBe('# B\n')

    // 外部（例如"重命名别的笔记"的链接改写）把 b.md 改了
    adapter.simulateExternalEdit('b.md', '# B 被别人改过\n')

    await useNoteStore.getState().open('b.md')
    const state = useNoteStore.getState()
    expect(state.activePath).toBe('b.md')
    expect(state.docOf('b.md')?.text).toBe('# B 被别人改过\n')
    expect(state.docOf('b.md')?.dirty).toBe(false)
  })

  it('有未保存内容的那篇被切为当前时**不重读**（一个编辑都不能丢）', async () => {
    await useNoteStore.getState().open('a.md')
    await useNoteStore.getState().openDoc('b.md')
    useNoteStore.getState().setTextFor('b.md', '# B 我正在写\n')

    adapter.simulateExternalEdit('b.md', '# 磁盘上的另一个版本\n')

    await useNoteStore.getState().open('b.md')
    const state = useNoteStore.getState()
    expect(state.activePath).toBe('b.md')
    // 内存里的编辑原样保留（下一次保存会以冲突/覆盖的形式让用户决定，绝不静默丢）
    expect(state.docOf('b.md')?.text).toBe('# B 我正在写\n')
    expect(state.docOf('b.md')?.dirty).toBe(true)
  })
})
