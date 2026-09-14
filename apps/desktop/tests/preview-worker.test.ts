// @vitest-environment jsdom
/**
 * 大文档预览的 Worker 管线：**协议与状态机**。
 *
 * 这里刻意**不断言"真的在另一个线程上跑"** —— 那在 jsdom 里证不了（没有真实线程，
 * 也没有可观测的线程边界）。能证、也值得证的是这些：
 * - 请求带着 `docKey` 与正文、结果是**未净化**的 HTML（净化仍在主线程）；
 * - 旧 `requestId` 或旧 `docKey` 的结果一个字节都不写进 DOM（通道复用的两个凭据）；
 * - worker 构造失败 / `onerror` → 永久回落同步路径，且只记一次 warn；
 * - 门槛以下不创建 worker；`viewMode !== 'read'` 或卸载即 `terminate()`；
 * - `data-mn-render` 让"走了哪条路"成为可断言的事实。
 *
 * jsdom 里没有 `Worker`，所以**必须桩掉它**（与既有测试桩 `window.__TAURI_INTERNALS__`
 * 是同一手法：把环境里不存在的东西换成一个可控的替身）。
 */

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { createElement, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { openNote } from '@/app/actions'
import { MarkdownPreview } from '@/features/preview/MarkdownPreview'
import {
  PREVIEW_WORKER_MIN_BYTES,
  configurePreviewWorker,
  type PreviewRenderRequest,
  type PreviewWorkerPort,
} from '@/features/preview/preview-worker'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter } from '@/ipc/mock-adapter'
import { useLinksStore } from '@/state/links-store'
import { useNoteStore } from '@/state/note-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'

/** 够长（超过用例调低后的门槛），但同步渲染它只要几毫秒。 */
function noteText(title: string): string {
  return `# ${title}\n\n${`${title}的正文。`.repeat(40)}\n`
}

const NOTES = [
  { relPath: '笔记/甲.md', text: noteText('甲篇') },
  { relPath: '笔记/乙.md', text: noteText('乙篇') },
]

/** 用例里调低后的门槛（真在 jsdom 里渲染 1 MiB 正文要好几秒，而门槛本身不是被测对象）。 */
const TEST_MIN_BYTES = 64

/**
 * 桩掉的 Worker：只记消息、可以手动回包，永不真起线程。
 *
 * 实现的是 `PreviewWorkerPort`（主线程真正用到的那四个成员），因此不必假装自己是完整的 `Worker`。
 */
class FakeWorker implements PreviewWorkerPort {
  static instances: FakeWorker[] = []
  static constructions = 0
  static throwOnConstruct = false

  readonly posted: PreviewRenderRequest[] = []
  terminated = false
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onmessageerror: ((event: unknown) => void) | null = null

  constructor() {
    FakeWorker.constructions += 1
    // CSP 禁止 worker、宿主 WebView 不支持 module worker 都是这样失败的
    if (FakeWorker.throwOnConstruct) throw new Error('不允许创建 worker')
    FakeWorker.instances.push(this)
  }

  postMessage(message: PreviewRenderRequest): void {
    this.posted.push(message)
  }

  terminate(): void {
    this.terminated = true
  }

  /** 模拟 Worker 回包（结果或错误）。 */
  reply(message: unknown): void {
    this.onmessage?.({ data: message })
  }
}

function worker(): FakeWorker {
  const instance = FakeWorker.instances[0]
  if (instance === undefined) throw new Error('还没有创建 worker')
  return instance
}

/**
 * 挂载预览。
 *
 * 为什么用 `createElement` 而不是 JSX：这份用例的文件名是 `.ts`（`tsconfig` 只对 `.tsx` 开 JSX），
 * 而用例要断言的恰恰是"组件与 React 一起工作时"的行为（切笔记、卸载、`data-mn-render`）。
 */
function preview(): ReactElement {
  return createElement(MarkdownPreview)
}

function previewRoot(container: HTMLElement): HTMLElement {
  const root = container.querySelector('.mn-preview')
  if (root === null) throw new Error('预览根节点还没挂上')
  return root as HTMLElement
}

function bodyText(container: HTMLElement): string {
  return container.querySelector('.mn-preview__body')?.textContent ?? ''
}

/** 只统计本模块自己打的 warn（别的模块的 warn 不该被算进来）。 */
function previewWarnings(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter((call) => String(call[0] ?? '').includes('[preview]')).length
}

async function appendText(line: string): Promise<void> {
  const doc = useNoteStore.getState().doc
  useNoteStore.getState().setText(`${doc?.text ?? ''}\n\n${line}\n`)
}

beforeEach(async () => {
  FakeWorker.instances = []
  FakeWorker.constructions = 0
  FakeWorker.throwOnConstruct = false
  ;(globalThis as unknown as Record<string, unknown>)['Worker'] = FakeWorker
  ;(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {
    convertFileSrc: (path: string) => path,
  }
  configurePreviewWorker({ minBytes: TEST_MIN_BYTES })
  setIpcAdapter(createMockAdapter({ notes: NOTES }))
  useUiStore.setState({ viewMode: 'read' })
  useNoteStore.getState().close()
  useLinksStore.getState().clear()
  useVaultStore.setState({
    status: 'idle',
    info: null,
    entries: [],
    tree: [],
    expanded: new Set<string>(),
    selected: null,
    filter: '',
    error: null,
  })
  await useVaultStore.getState().openVault('C:\\MockVault')
  await openNote('笔记/甲.md')
})

afterEach(() => {
  cleanup()
  configurePreviewWorker({ minBytes: PREVIEW_WORKER_MIN_BYTES })
  delete (globalThis as unknown as Record<string, unknown>)['Worker']
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__']
})

describe('大文档预览的 Worker 管线', () => {
  it('请求带着 docKey 与正文；回包在主线程净化后落地，根节点带 data-mn-render="worker"', async () => {
    const { container } = render(preview())
    expect(previewRoot(container).getAttribute('data-mn-render')).toBe('worker')

    await waitFor(() => {
      expect(worker().posted).toHaveLength(1)
    })
    const sent = worker().posted[0] as PreviewRenderRequest
    const doc = useNoteStore.getState().doc
    // docKey = `${relPath}\u0000${revision}`（打开/重新加载时 revision 自增）
    expect(sent.docKey).toBe(`${doc?.relPath ?? ''}\u0000${doc?.revision ?? 0}`)
    expect(sent.body).toContain('甲篇的正文')
    // 正文是"去掉 frontmatter 的那一份"：Worker 拿到的输入与同步路径完全一致
    expect(sent.body.startsWith('# 甲篇')).toBe(true)

    // 结果没回来之前**不**先同步渲染一遍（否则"解析期间界面还能动"就是假的）
    expect(bodyText(container)).toBe('')

    await act(async () => {
      worker().reply({
        requestId: sent.requestId,
        docKey: sent.docKey,
        html: '<p>甲的结果</p>',
      })
    })
    await waitFor(() => {
      expect(bodyText(container)).toContain('甲的结果')
    })
    // 走 worker 的痕迹不因结果落地而改变
    expect(previewRoot(container).getAttribute('data-mn-render')).toBe('worker')
    expect(FakeWorker.constructions).toBe(1)
  })

  it('旧 requestId 的结果被丢弃（同一个 docKey 内靠请求号判断）', async () => {
    const { container } = render(preview())
    await waitFor(() => {
      expect(worker().posted).toHaveLength(1)
    })
    const first = worker().posted[0] as PreviewRenderRequest

    // 正文变了 → 第二个请求。注意 docKey **没变**（revision 只在重新加载时自增），
    // 所以这一次只有请求号能救：这正是"连打几个字"时的真实情形。
    await act(async () => {
      await appendText('第二轮。')
    })
    await waitFor(() => {
      expect(worker().posted).toHaveLength(2)
    })
    const second = worker().posted[1] as PreviewRenderRequest
    expect(second.requestId).toBeGreaterThan(first.requestId)
    expect(second.docKey).toBe(first.docKey)

    // 旧结果先回来 → 一个字节都不写进 DOM
    await act(async () => {
      worker().reply({ requestId: first.requestId, docKey: first.docKey, html: '<p>旧结果</p>' })
    })
    expect(bodyText(container)).not.toContain('旧结果')

    // 新结果才作数
    await act(async () => {
      worker().reply({ requestId: second.requestId, docKey: second.docKey, html: '<p>新结果</p>' })
    })
    await waitFor(() => {
      expect(bodyText(container)).toContain('新结果')
    })
    expect(bodyText(container)).not.toContain('旧结果')
  })

  it('切笔记（docKey 变化）后旧结果一个字节都不写进 DOM', async () => {
    const { container } = render(preview())
    await waitFor(() => {
      expect(worker().posted).toHaveLength(1)
    })
    const jia = worker().posted[0] as PreviewRenderRequest

    // 甲篇的结果先落地
    await act(async () => {
      worker().reply({ requestId: jia.requestId, docKey: jia.docKey, html: '<p>甲的正文</p>' })
    })
    await waitFor(() => {
      expect(bodyText(container)).toContain('甲的正文')
    })

    // 切到乙篇：新请求，docKey 变了
    await act(async () => {
      await openNote('笔记/乙.md')
    })
    await waitFor(() => {
      expect(worker().posted).toHaveLength(2)
    })
    const yi = worker().posted[1] as PreviewRenderRequest
    expect(yi.docKey).not.toBe(jia.docKey)
    // 切过去之后，上一篇的内容立刻从 DOM 上消失（绝不"粘"在新笔记上）
    expect(bodyText(container)).not.toContain('甲的正文')

    // ① 迟到的旧回包 → 丢弃
    await act(async () => {
      worker().reply({ requestId: jia.requestId, docKey: jia.docKey, html: '<p>甲的正文</p>' })
    })
    expect(bodyText(container)).not.toContain('甲的正文')

    // ② 请求号是新的、文档却是旧的（通道被复用/错乱）→ 同样不写进 DOM，
    //    并且按"永久失效"处理：内容交给同步路径重算，而不是留一个空屏
    await act(async () => {
      worker().reply({ requestId: yi.requestId, docKey: jia.docKey, html: '<p>串味的正文</p>' })
    })
    expect(bodyText(container)).not.toContain('串味的正文')
    await waitFor(() => {
      expect(previewRoot(container).getAttribute('data-mn-render')).toBe('sync')
    })
    await waitFor(() => {
      expect(bodyText(container)).toContain('乙篇的正文')
    })
  })

  it('worker 构造失败时自动回落同步路径，并只记一次 warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    FakeWorker.throwOnConstruct = true

    const { container } = render(preview())

    await waitFor(() => {
      expect(previewRoot(container).getAttribute('data-mn-render')).toBe('sync')
    })
    // 回落之后内容照常出来（用户对这件事应当**无感**，只是慢回旧样子）
    await waitFor(() => {
      expect(bodyText(container)).toContain('甲篇的正文')
    })

    // 再改两次正文：不再尝试构造新 worker，也不再刷 warn
    await act(async () => {
      await appendText('第一次改动')
    })
    await waitFor(() => {
      expect(bodyText(container)).toContain('第一次改动')
    })
    await act(async () => {
      await appendText('第二次改动')
    })
    await waitFor(() => {
      expect(bodyText(container)).toContain('第二次改动')
    })

    expect(FakeWorker.constructions).toBe(1)
    expect(previewWarnings(warn)).toBe(1)
  })

  it('worker onerror 时自动回落同步路径，并只记一次 warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { container } = render(preview())
    await waitFor(() => {
      expect(worker().posted).toHaveLength(1)
    })
    expect(bodyText(container)).toBe('')

    await act(async () => {
      worker().onerror?.(new Error('worker 挂了'))
    })

    await waitFor(() => {
      expect(previewRoot(container).getAttribute('data-mn-render')).toBe('sync')
    })
    // 线程被释放（可逆副作用），正文由同步路径补上
    expect(worker().terminated).toBe(true)
    await waitFor(() => {
      expect(bodyText(container)).toContain('甲篇的正文')
    })

    await act(async () => {
      await appendText('改动一次')
    })
    await waitFor(() => {
      expect(bodyText(container)).toContain('改动一次')
    })
    expect(FakeWorker.constructions).toBe(1)
    expect(previewWarnings(warn)).toBe(1)
  })

  it('小于门槛的文档根本不创建 worker（构造次数为 0）', async () => {
    // 用**默认门槛**：门槛本身是需求的一部分，不能只测被用例调低过的那条线
    configurePreviewWorker({ minBytes: PREVIEW_WORKER_MIN_BYTES })
    expect(PREVIEW_WORKER_MIN_BYTES).toBe(1024 * 1024)

    const { container } = render(preview())
    await waitFor(() => {
      expect(bodyText(container)).toContain('甲篇的正文')
    })
    expect(previewRoot(container).getAttribute('data-mn-render')).toBe('sync')
    expect(FakeWorker.constructions).toBe(0)
    expect(FakeWorker.instances).toHaveLength(0)
  })

  it('环境里没有 Worker（老 WebView / jsdom）时走同步路径，且不尝试构造', async () => {
    // 门槛里**刻意没有** `isTauriRuntime()`：这条路径与宿主无关（纯 JS 解析），判它会带来
    // "只有真实 WebView 才走 Worker"的后果 —— UI 层 E2E 就永远看不到 `worker`，
    // 而那个键位恰好是唯一能在真实浏览器里观察它的地方（见 `MarkdownPreview` 的注释）。
    // 于是回退条件只剩"环境里根本没有 Worker"这一条 —— 这条用例钉的就是它。
    const globalWithWorker = globalThis as unknown as { Worker?: unknown }
    const saved = globalWithWorker.Worker
    delete globalWithWorker.Worker

    try {
      const { container } = render(preview())
      await waitFor(() => {
        expect(bodyText(container)).toContain('甲篇的正文')
      })
      expect(previewRoot(container).getAttribute('data-mn-render')).toBe('sync')
      expect(FakeWorker.constructions).toBe(0)
    } finally {
      globalWithWorker.Worker = saved
    }
  })

  it('离开阅读视图就释放线程（terminate），正文立刻由同步路径接上', async () => {
    const { container } = render(preview())
    await waitFor(() => {
      expect(worker().posted).toHaveLength(1)
    })

    await act(async () => {
      useUiStore.setState({ viewMode: 'edit' })
    })

    expect(worker().terminated).toBe(true)
    await waitFor(() => {
      expect(previewRoot(container).getAttribute('data-mn-render')).toBe('sync')
    })
    await waitFor(() => {
      expect(bodyText(container)).toContain('甲篇的正文')
    })
  })
})
