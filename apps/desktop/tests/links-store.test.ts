/**
 * 链接索引集成测试（内存 Mock 适配器）。
 *
 * 真实解析权威在 Rust（`mn-core::links` + `mn-index`），这里验证的是：
 * 契约字段、请求竞态、以及"前端拿到的数据足以驱动面板与预览"。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter, MOCK_VAULT_PATH, type MockAdapter } from '@/ipc/mock-adapter'
import { applyIndexStatus, useLinksStore } from '@/state/links-store'
import { useNoteStore } from '@/state/note-store'

let adapter: MockAdapter

beforeEach(() => {
  adapter = createMockAdapter()
  setIpcAdapter(adapter)
  useLinksStore.getState().clear()
  useNoteStore.getState().close()
  useLinksStore.setState({ status: { phase: 'idle', indexed: 0, total: 0, durationMs: 0, links: 0, reusedNotes: 0 } })
})

describe('links store', () => {
  it('打开笔记后拉到出链，并解析到具体笔记', async () => {
    await useNoteStore.getState().open('项目/设计.md')
    await useLinksStore.getState().refresh('项目/设计.md')

    const links = useLinksStore.getState().links
    expect(links?.relPath).toBe('项目/设计.md')
    const targets = (links?.outbound ?? []).map((link) => link.rawTarget)
    expect(targets).toContain('路线图')
    expect(targets).toContain('细节')

    const roadmap = links?.outbound.find((link) => link.rawTarget === '路线图')
    expect(roadmap?.resolvedRelPath).toBe('项目/路线图.md')
    expect(roadmap?.kind).toBe('wiki')
    expect(roadmap?.line).toBeGreaterThan(0)
  })

  it('反向链接：谁指向了这篇', async () => {
    await useLinksStore.getState().refresh('项目/设计.md')
    const backlinks = useLinksStore.getState().links?.backlinks ?? []
    expect(backlinks.map((backlink) => backlink.fromRelPath)).toContain('项目/路线图.md')

    await useLinksStore.getState().refresh('项目/路线图.md')
    const reverse = useLinksStore.getState().links?.backlinks ?? []
    expect(reverse.map((backlink) => backlink.fromRelPath)).toContain('项目/设计.md')
  })

  it('悬空链接被标记为未解析，并计入 unresolvedCount', async () => {
    await useLinksStore.getState().refresh('项目/子项目/细节.md')
    const links = useLinksStore.getState().links
    const dangling = links?.outbound.find((link) => link.rawTarget === '还不存在的笔记')
    expect(dangling?.resolvedRelPath).toBeNull()
    expect(links?.unresolvedCount).toBe(1)
  })

  it('代码块里的 [[ ]] 不会被当成链接（解析在宿主侧，此处验证端到端结果）', async () => {
    await useLinksStore.getState().refresh('项目/子项目/细节.md')
    const outbound = useLinksStore.getState().links?.outbound ?? []
    // 该笔记的代码块里没有 wikilink，但正文里有一个悬空链接
    expect(outbound.length).toBe(1)
  })

  it('刷新到不存在的笔记时不抛错，返回空结构', async () => {
    await useLinksStore.getState().refresh('并不存在.md')
    expect(useLinksStore.getState().links?.outbound).toEqual([])
    expect(useLinksStore.getState().error).toBeNull()
  })

  it('传 null 会清空（关闭笔记）', async () => {
    await useLinksStore.getState().refresh('项目/设计.md')
    expect(useLinksStore.getState().links).not.toBeNull()
    await useLinksStore.getState().refresh(null)
    expect(useLinksStore.getState().links).toBeNull()
  })

  it('快速连续刷新只采纳最后一次结果（过期响应丢弃）', async () => {
    const slow = useLinksStore.getState().refresh('项目/设计.md')
    const fast = useLinksStore.getState().refresh('项目/路线图.md')
    await Promise.all([slow, fast])
    expect(useLinksStore.getState().links?.relPath).toBe('项目/路线图.md')
  })

  it('索引状态可查询', async () => {
    await useLinksStore.getState().refreshStatus()
    const status = useLinksStore.getState().status
    expect(status.phase).toBe('ready')
    expect(status.links).toBeGreaterThan(0)
  })

  it('索引进度事件丢失时由轮询兜底（回归：事件早于订阅发出）', async () => {
    vi.useFakeTimers()
    try {
      let phase: 'building' | 'ready' = 'building'
      setIpcAdapter({
        kind: 'test',
        invoke: <T,>(method: string): Promise<T> => {
          if (method === 'index_status') {
            return Promise.resolve({
              phase,
              indexed: phase === 'ready' ? 10 : 1,
              total: 10,
              durationMs: phase === 'ready' ? 8 : 0,
              links: phase === 'ready' ? 3 : 0,
            } as unknown as T)
          }
          return Promise.reject(new Error(`未预期的调用：${method}`))
        },
      })

      await useLinksStore.getState().refreshStatus()
      expect(useLinksStore.getState().status.phase).toBe('building')

      // 宿主建完了，但"完成事件"在前端订阅之前就发过了 —— 只有轮询能发现
      phase = 'ready'
      await vi.advanceTimersByTimeAsync(600)
      expect(useLinksStore.getState().status.phase).toBe('ready')
      expect(useLinksStore.getState().status.links).toBe(3)

      // 终态后不再继续轮询
      const settled = useLinksStore.getState().status
      await vi.advanceTimersByTimeAsync(2_000)
      expect(useLinksStore.getState().status).toEqual(settled)
    } finally {
      vi.useRealTimers()
    }
  })

  it('宿主推送的进度的处理函数可用（事件订阅的落点）', () => {
    applyIndexStatus({ phase: 'building', indexed: 30, total: 100, durationMs: 0, links: 0, reusedNotes: 0 })
    expect(useLinksStore.getState().status.phase).toBe('building')
    applyIndexStatus({ phase: 'ready', indexed: 100, total: 100, durationMs: 42, links: 7, reusedNotes: 0 })
    expect(useLinksStore.getState().status.links).toBe(7)
  })

  it('Mock Vault 的根路径常量与适配器一致', async () => {
    const snapshot = await adapter.invoke<{ rootPath: string }>('vault_snapshot')
    expect(snapshot.rootPath).toBe(MOCK_VAULT_PATH)
  })
})
