/**
 * 笔记状态机集成测试（内存适配器，无 Tauri）。
 *
 * 覆盖 M1 的关键安全/正确性契约：
 * 自动保存、切换文档不丢内容、外部修改冲突、强制覆盖、CRLF 保真、读写取消。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter, type MockAdapter } from '@/ipc/mock-adapter'
import { configureAutosave, useNoteStore } from '@/state/note-store'

let adapter: MockAdapter

function textOnDisk(relPath: string): string | undefined {
  return adapter.dump().find((note) => note.relPath === relPath)?.text
}

beforeEach(() => {
  adapter = createMockAdapter({
    notes: [
      { relPath: 'a.md', text: '# A\n' },
      { relPath: 'b.md', text: '# B\r\n\r\nCRLF 内容\r\n' },
      { relPath: '附件/说明.txt', text: 'not markdown' },
    ],
  })
  setIpcAdapter(adapter)
  configureAutosave({ delayMs: 50 })
  useNoteStore.getState().close()
  useNoteStore.setState({
    status: 'idle',
    dirty: false,
    error: null,
    conflict: null,
    loadMs: 0,
    lastSavedAt: null,
    lastWriteMs: null,
    lastWriteBytes: null,
    saveCount: 0,
    diskStats: null,
  })
})

afterEach(() => {
  useNoteStore.getState().close()
  vi.useRealTimers()
})

describe('打开文档', () => {
  it('读取内容、记录 mtime 基线、并且不是脏状态', async () => {
    const ok = await useNoteStore.getState().open('a.md')
    expect(ok).toBe(true)
    const state = useNoteStore.getState()
    expect(state.doc?.relPath).toBe('a.md')
    expect(state.doc?.text).toBe('# A\n')
    expect(state.doc?.baseMtimeMs).toBeGreaterThan(0)
    expect(state.dirty).toBe(false)
    expect(state.status).toBe('ready')
    expect(state.loadMs).toBeGreaterThanOrEqual(0)
  })

  it('识别 CRLF 并在编辑器内归一化为 LF', async () => {
    await useNoteStore.getState().open('b.md')
    expect(useNoteStore.getState().doc?.text).toBe('# B\n\nCRLF 内容\n')
    expect(useNoteStore.getState().doc?.format.eol).toBe('\r\n')
  })

  it('非 Markdown 文件不打开', async () => {
    const ok = await useNoteStore.getState().open('附件/说明.txt')
    expect(ok).toBe(false)
    expect(useNoteStore.getState().doc).toBeNull()
  })

  it('每次打开/重载都会推进 revision（编辑器据此整篇替换）', async () => {
    await useNoteStore.getState().open('a.md')
    const first = useNoteStore.getState().doc?.revision ?? 0
    await useNoteStore.getState().open('b.md')
    const second = useNoteStore.getState().doc?.revision ?? 0
    await useNoteStore.getState().reload()
    const third = useNoteStore.getState().doc?.revision ?? 0
    expect(second).toBeGreaterThan(first)
    expect(third).toBeGreaterThan(second)
  })
})

describe('保存流水线', () => {
  it('输入后经过防抖延迟自动保存', async () => {
    vi.useFakeTimers()
    await useNoteStore.getState().open('a.md')
    useNoteStore.getState().setText('# A 已编辑\n')
    expect(useNoteStore.getState().dirty).toBe(true)

    await vi.advanceTimersByTimeAsync(30)
    expect(textOnDisk('a.md')).toBe('# A\n') // 尚未到防抖时间

    await vi.advanceTimersByTimeAsync(40)
    expect(textOnDisk('a.md')).toBe('# A 已编辑\n')
    const state = useNoteStore.getState()
    expect(state.dirty).toBe(false)
    expect(state.saveCount).toBe(1)
    expect(state.lastWriteMs).not.toBeNull()
  })

  it('显式保存立即落盘，并更新 mtime 基线', async () => {
    await useNoteStore.getState().open('a.md')
    const before = useNoteStore.getState().doc?.baseMtimeMs ?? 0
    useNoteStore.getState().setText('# 手动保存\n')
    const ok = await useNoteStore.getState().saveNow()
    expect(ok).toBe(true)
    expect(textOnDisk('a.md')).toBe('# 手动保存\n')
    expect(useNoteStore.getState().doc?.baseMtimeMs).toBeGreaterThan(before)
  })

  it('CRLF 文档保存后仍是 CRLF（不把整篇 diff 变成"全部修改"）', async () => {
    await useNoteStore.getState().open('b.md')
    useNoteStore.getState().setText('# B 已编辑\n换行保持\n')
    await useNoteStore.getState().saveNow()
    expect(textOnDisk('b.md')).toBe('# B 已编辑\r\n换行保持\r\n')
  })

  it('切换文档前会把未保存内容写入磁盘（不丢内容）', async () => {
    await useNoteStore.getState().open('a.md')
    useNoteStore.getState().setText('# A v2\n')
    await useNoteStore.getState().open('b.md')
    expect(textOnDisk('a.md')).toBe('# A v2\n')
    expect(useNoteStore.getState().doc?.relPath).toBe('b.md')
  })

  it('保存期间再次输入 → 保持 dirty 并等待下一轮写入', async () => {
    adapter = createMockAdapter({
      notes: [{ relPath: 'slow.md', text: 'v0\n' }],
      writeLatencyMs: 30,
    })
    setIpcAdapter(adapter)

    await useNoteStore.getState().open('slow.md')
    useNoteStore.getState().setText('v1\n')
    const pending = useNoteStore.getState().saveNow()
    useNoteStore.getState().setText('v2\n')
    await pending

    // 第一次写入的内容是 v1，但状态仍为 dirty（v2 还没落盘）
    expect(textOnDisk('slow.md')).toBe('v1\n')
    expect(useNoteStore.getState().dirty).toBe(true)
  })
})

describe('冲突处理（ADR-0004）', () => {
  it('文件被外部修改后保存进入冲突态，且绝不静默覆盖', async () => {
    await useNoteStore.getState().open('a.md')
    useNoteStore.getState().setText('# 我的版本\n')
    adapter.simulateExternalEdit('a.md', '# 别人的版本\n')

    const ok = await useNoteStore.getState().saveNow()
    expect(ok).toBe(false)
    const state = useNoteStore.getState()
    expect(state.status).toBe('conflict')
    expect(state.conflict).not.toBeNull()
    expect(state.dirty).toBe(true)
    // 磁盘内容保持别人的版本
    expect(textOnDisk('a.md')).toBe('# 别人的版本\n')
  })

  it('冲突期间不再自动重试保存', async () => {
    vi.useFakeTimers()
    await useNoteStore.getState().open('a.md')
    useNoteStore.getState().setText('# 我的版本\n')
    adapter.simulateExternalEdit('a.md', '# 别人的版本\n')
    await useNoteStore.getState().saveNow()
    expect(useNoteStore.getState().status).toBe('conflict')

    useNoteStore.getState().setText('# 我的版本 v2\n')
    await vi.advanceTimersByTimeAsync(200)
    expect(textOnDisk('a.md')).toBe('# 别人的版本\n')
    expect(useNoteStore.getState().status).toBe('conflict')
  })

  it('选择"重新加载"会用磁盘内容替换内存内容', async () => {
    await useNoteStore.getState().open('a.md')
    useNoteStore.getState().setText('# 我的版本\n')
    adapter.simulateExternalEdit('a.md', '# 别人的版本\n')
    await useNoteStore.getState().saveNow()

    await useNoteStore.getState().resolveConflict('reload')
    const state = useNoteStore.getState()
    expect(state.doc?.text).toBe('# 别人的版本\n')
    expect(state.dirty).toBe(false)
    expect(state.conflict).toBeNull()
    expect(state.status).toBe('ready')
  })

  it('选择"覆盖保存"会以内存内容为准，且使用新的 mtime 基线', async () => {
    await useNoteStore.getState().open('a.md')
    useNoteStore.getState().setText('# 我的版本\n')
    adapter.simulateExternalEdit('a.md', '# 别人的版本\n')
    await useNoteStore.getState().saveNow()

    await useNoteStore.getState().resolveConflict('overwrite')
    const state = useNoteStore.getState()
    expect(textOnDisk('a.md')).toBe('# 我的版本\n')
    expect(state.dirty).toBe(false)
    expect(state.conflict).toBeNull()
    // 覆盖后继续编辑不应再次冲突
    useNoteStore.getState().setText('# 我的版本 v3\n')
    await expect(useNoteStore.getState().saveNow()).resolves.toBe(true)
  })
})
