// @vitest-environment jsdom
/**
 * 阅读视图的**补图**：整篇 HTML 只渲染一次，之后每张图只就地换一个节点。
 *
 * 为什么这值得单测：改造前的写法把授权结果写进一个参与 `html` 计算的缓存，于是
 * "N 张图 = ⌈N/200⌉+1 次整篇渲染"（每次都含 markdown-it + DOMPurify + innerHTML + 全篇扫描）。
 * 这类放大的表现是"图一多，阅读视图在几秒里反复假死"，但**肉眼看不到重渲染**，
 * 只有"节点的对象身份变没变"能钉死它 —— 所以这里的硬证据全是 `toBe` 比较节点身份。
 *
 * 装配方式与 `tests/preview-images.test.tsx` 一致：桩掉 `window.__TAURI_INTERNALS__` 与
 * `convertFileSrc`（jsdom 里没有 asset 协议）。额外的一层：授权回来的**时机**由用例控制
 * （`authorizeGate`），这样"占位还在"与"图已经补上"之间才有确定的观察窗口。
 */

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openNote } from '@/app/actions'
import { imageHtml, renderMarkdown } from '@/domain/markdown'
import { MarkdownPreview } from '@/features/preview/MarkdownPreview'
import { setIpcAdapter, type IpcAdapter } from '@/ipc/client'
import { createMockAdapter } from '@/ipc/mock-adapter'
import type { AssetGrant } from '@/ipc/types'
import { useLinksStore } from '@/state/links-store'
import { useNoteStore } from '@/state/note-store'
import { useVaultStore } from '@/state/vault-store'

/** 1×1 GIF：jsdom 不会为它触发 error（不会把补好的图又打回占位）。 */
const OK_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

interface MockNote {
  relPath: string
  text: string
}

const ONE_IMAGE: MockNote[] = [
  {
    relPath: '笔记/图片.md',
    text: ['# 标题', '', '正文段落。', '', '![图](images/pic.png)', '', '结尾段落。', ''].join('\n'),
  },
]

/** 每次 `asset_authorize` 请求了哪些相对路径（按批记录）。 */
let authorizeCalls: string[][] = []
/** 宿主"没返回我"的路径：等于拿不到授权（越界/不存在/非图片在真实宿主里也是这样被跳过的）。 */
let deniedRels: Set<string> = new Set()
/** 放行授权：在它 resolve 之前，占位元素会一直留在 DOM 上。 */
let authorizeGate: Promise<void> = Promise.resolve()

function stubTauriRuntime(): void {
  ;(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {
    convertFileSrc: () => OK_IMAGE,
  }
}

/** 包一层 Mock 适配器：只为了记账与"什么时候放行授权"。 */
function installAdapter(notes: MockNote[]): void {
  const base = createMockAdapter({ notes })
  const adapter: IpcAdapter = {
    kind: 'test',
    async invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
      if (method !== 'asset_authorize') return base.invoke<T>(method, args)
      const requested = args?.['relPaths']
      authorizeCalls.push(Array.isArray(requested) ? (requested as string[]) : [])
      await authorizeGate
      const grants = await base.invoke<AssetGrant[]>('asset_authorize', args)
      return grants.filter((grant) => !deniedRels.has(grant.relPath)) as T
    },
  }
  setIpcAdapter(adapter)
}

/** 把一段 HTML 解析成 DOM，用来与"落地后的 DOM"比同一份表示形式（`<img />` 与 `<img>` 的区别在序列化里）。 */
function toDom(html: string): HTMLElement {
  const holder = document.createElement('div')
  holder.innerHTML = html
  return holder
}

function bodyOf(container: HTMLElement): HTMLElement {
  const body = container.querySelector('.mn-preview__body')
  if (body === null) throw new Error('预览正文还没挂上')
  return body as HTMLElement
}

beforeEach(async () => {
  authorizeCalls = []
  deniedRels = new Set()
  authorizeGate = Promise.resolve()
  stubTauriRuntime()
  installAdapter(ONE_IMAGE)
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
  await openNote('笔记/图片.md')
})

afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__']
})

describe('阅读视图的就地补图', () => {
  it('图片授权回来后只替换占位元素，整篇 HTML 不重建', async () => {
    let release: () => void = () => undefined
    authorizeGate = new Promise<void>((resolve) => {
      release = resolve
    })

    const { container } = render(<MarkdownPreview />)
    await waitFor(() => {
      expect(container.querySelector('[data-mn-asset]')).not.toBeNull()
    })

    const body = bodyOf(container)
    const heading = body.querySelector('h1')
    const paragraphs = Array.from(body.querySelectorAll('p'))
    const placeholder = body.querySelector('[data-mn-asset]')
    expect(heading).not.toBeNull()
    expect(placeholder).not.toBeNull()

    await act(async () => {
      release()
    })
    await waitFor(() => {
      expect(body.querySelector('img.mn-image')).not.toBeNull()
    })

    // 硬证据：其它节点的**对象身份**一个都没变（若整篇 HTML 被重算，
    // React 会把 dangerouslySetInnerHTML 下的整棵子树换成新节点）
    expect(container.querySelector('.mn-preview__body')).toBe(body)
    expect(body.querySelector('h1')).toBe(heading)
    expect(Array.from(body.querySelectorAll('p'))).toEqual(paragraphs)

    // 只有那一个占位节点被换掉了：它已经脱离文档，而新的图在原位
    expect(placeholder?.isConnected).toBe(false)
    expect(body.querySelectorAll('.mn-figure')).toHaveLength(1)
  })

  it('同一批 500 张图：按上限分批请求，每张图只被请求一次，整篇也只渲染一次', async () => {
    // 名字里的"只触发一次授权请求"指的是**每张图只请求一次**：批上限 200，所以是 ⌈500/200⌉=3 批
    const count = 500
    const lines = Array.from(
      { length: count },
      (_, index) => `![图${index}](images/p${String(index).padStart(3, '0')}.png)`,
    )
    const text = ['# 多图', '', ...lines, ''].join('\n\n')
    installAdapter([{ relPath: '笔记/多图.md', text }])
    await openNote('笔记/多图.md')

    const { container } = render(<MarkdownPreview />)
    const body = bodyOf(container)
    const heading = body.querySelector('h1')

    await waitFor(
      () => {
        expect(container.querySelectorAll('img.mn-image')).toHaveLength(count)
      },
      { timeout: 10_000 },
    )

    expect(authorizeCalls).toHaveLength(Math.ceil(count / 200))
    for (const batch of authorizeCalls) {
      expect(batch.length).toBeLessThanOrEqual(200)
    }
    const requested = authorizeCalls.flat()
    expect(requested).toHaveLength(count)
    // 每张图只出现一次：重复请求会让"⌈N/200⌉ 轮"变成无限轮
    expect(new Set(requested).size).toBe(count)

    // 三批之间整篇 HTML 一次都没重建
    expect(container.querySelector('.mn-preview__body')).toBe(body)
    expect(body.querySelector('h1')).toBe(heading)
  })

  it('授权失败的那张变成终态占位（与普通占位逐字节相同），且不再被反复请求', async () => {
    deniedRels.add('笔记/images/pic.png')

    const { container } = render(<MarkdownPreview />)

    // 授权回来之前：这一份是**待办**的占位，带着整份规格（补图唯一的依据）
    const pending = container.querySelector('[data-mn-asset]')
    expect(pending?.getAttribute('data-mn-asset')).toBe('笔记/images/pic.png')
    expect(pending?.getAttribute('data-mn-src')).toBe('images/pic.png')
    expect(pending?.getAttribute('data-mn-alt')).toBe('图')
    // 独占一段的图片：块级标记也必须在（否则补出来的图会退化成行内）
    expect(pending?.hasAttribute('data-mn-block')).toBe(true)

    const body = bodyOf(container)
    await waitFor(() => {
      const placeholder = container.querySelector('.mn-image-placeholder')
      expect(placeholder).not.toBeNull()
      // 终态：两个待办标记都摘掉 —— 否则它既会被反复请求，也会一直闪"等授权"的骨架动画
      expect(placeholder?.hasAttribute('data-mn-asset')).toBe(false)
      expect(placeholder?.hasAttribute('data-mn-defer')).toBe(false)
    })
    expect(authorizeCalls).toHaveLength(1)

    // 终态占位必须与"从没成功过"的普通占位**结构完全一致**：同一份规格去掉待办标记后，
    // 应当回到同一个形状（连一个多余的 `data-mn-*` 都不该留下）
    const terminal = container.querySelector('.mn-image-placeholder') as HTMLElement
    const plain = toDom(
      renderMarkdown('![图](images/pic.png)', { resolveImage: () => null }),
    ).querySelector('.mn-image-placeholder')
    expect(terminal.outerHTML).toBe(plain?.outerHTML)
    expect(terminal.outerHTML).not.toContain('data-mn-')

    // 改一次正文 → 整篇重渲染（占位元素会重新生成），被拒的那张**不该**再被请求
    await act(async () => {
      const doc = useNoteStore.getState().doc
      useNoteStore.getState().setText(`${doc?.text ?? ''}\n\n新增一行\n`)
    })
    await waitFor(() => {
      expect(body.textContent).toContain('新增一行')
    })
    expect(authorizeCalls).toHaveLength(1)
    expect(container.querySelector('[data-mn-asset]')).toBeNull()
  })

  it('补出来的 img 与整篇渲染出来的 img 逐字节相同', async () => {
    const { container } = render(<MarkdownPreview />)
    const figure = await waitFor(() => {
      const node = container.querySelector('.mn-figure') as HTMLElement | null
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    // ① 与"直接拿 imageHtml 生成一张"比（规格就是整篇渲染时会算出来的那一份）
    const expected = toDom(
      imageHtml({
        src: 'images/pic.png',
        alt: '图',
        title: null,
        width: null,
        height: null,
        block: true,
        url: OK_IMAGE,
      }),
    ).firstElementChild
    expect(figure.outerHTML).toBe(expected?.outerHTML)

    // ② 与"整篇一次渲染出来"的那一张比：`![](…)` + 解析器直接给 url（同步路径）
    const whole = toDom(
      renderMarkdown('![图](images/pic.png)', {
        resolveImage: () => ({ kind: 'ready', url: OK_IMAGE }),
      }),
    )
    expect(figure.outerHTML).toBe(whole.querySelector('.mn-figure')?.outerHTML)
    // 图注与提示也在：补图走的是同一个生成器，不是"只把 <img> 塞进去"
    expect(figure.querySelector('.mn-image__hint')).not.toBeNull()
    expect(figure.querySelector('.mn-image__caption')?.textContent).toBe('图')
  })
})
