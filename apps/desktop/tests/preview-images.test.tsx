// @vitest-environment jsdom
/**
 * 预览里的本地图片：**两段式渲染 + 逐文件授权**的组件级测试（ADR-0007）。
 *
 * 这是 ⑤ 里最容易出错的一段逻辑：先渲染带 `data-mn-asset` 的占位 → 批量向宿主换取授权
 * （宿主用 `path_guard` 逐级校验，只放行通过的那一个文件）→ 拿到绝对路径后重渲染成 `<img>`。
 * 它只在 Tauri 运行时启用，所以这里**桩掉** `window.__TAURI_INTERNALS__`（`isTauriRuntime()`
 * 就是看它）与 `convertFileSrc`；真实解码仍由应用层 E2E 覆盖（断言 `naturalWidth > 0`）。
 *
 * 注意 `convertFileSrc` 的桩返回 `data:` URL：jsdom 加载不了自定义 scheme，会立刻触发
 * `error`，从而走到"加载失败回退占位"那条分支（那正是另一个用例要单独验证的行为）。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openNote } from '@/app/actions'
import { ImageLightbox } from '@/features/lightbox/ImageLightbox'
import { MarkdownPreview } from '@/features/preview/MarkdownPreview'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter } from '@/ipc/mock-adapter'
import { useLinksStore } from '@/state/links-store'
import { useNoteStore } from '@/state/note-store'
import { useVaultStore } from '@/state/vault-store'

/** 1×1 GIF：jsdom 不会为它触发 error（不会干扰主路径断言）。 */
const OK_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

const NOTES = [
  {
    relPath: '笔记/图片.md',
    text: [
      '# 图片',
      '',
      '![图](../附件/图.png)',
      '',
      '![越界](../../外部.png)',
      '',
      '![远程](https://example.com/x.png)',
      '',
    ].join('\n'),
  },
  {
    // `![[…]]` 嵌入：图片目标走与 `![](…)` 同一条授权链路，非图片目标退回链接
    relPath: '笔记/嵌入.md',
    text: ['# 嵌入', '', '![[../附件/图.png|一张图注]]', '', '![[另一篇笔记]]', ''].join('\n'),
  },
]

/** 记录 `convertFileSrc` 被要求转换过哪些绝对路径。 */
let converted: string[] = []

function stubTauriRuntime(convert: (path: string) => string): void {
  ;(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = { convertFileSrc: convert }
}

function removeTauriRuntime(): void {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__']
}

beforeEach(async () => {
  converted = []
  stubTauriRuntime((path) => {
    converted.push(path)
    return OK_IMAGE
  })

  setIpcAdapter(createMockAdapter({ notes: NOTES }))
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
  removeTauriRuntime()
})

describe('预览里的本地图片（asset 逐文件授权）', () => {
  it('先渲染带 data-mn-asset 的占位，授权后重渲染成 img', async () => {
    const { container } = render(<MarkdownPreview />)

    // 第二段：授权回来后变成真正的 img，src 是 convertFileSrc 的结果
    await waitFor(() => {
      expect(container.querySelector('img.mn-image')).not.toBeNull()
    })
    const image = container.querySelector('img.mn-image') as HTMLImageElement
    expect(image.getAttribute('src')).toBe(OK_IMAGE)
    // 请求的是**绝对路径**，而且是 Vault 内那一张
    expect(converted).toEqual(['C:\\MockVault\\附件\\图.png'])
    // 原始地址留在 data-mn-src 上（加载失败回退占位时要用）。
    // markdown-it 会把非 ASCII 路径百分号编码，所以要解码后再比对。
    expect(decodeURIComponent(image.getAttribute('data-mn-src') ?? '')).toBe('../附件/图.png')
  })

  it('图片加载失败时就地回退成占位元素（不留裂图）', async () => {
    const { container } = render(<MarkdownPreview />)
    await waitFor(() => {
      expect(container.querySelector('img.mn-image')).not.toBeNull()
    })

    // 手动派发 error：不依赖 jsdom 的资源加载行为，跨环境确定
    const image = container.querySelector('img.mn-image') as HTMLImageElement
    image.dispatchEvent(new Event('error', { bubbles: true }))

    await waitFor(() => {
      expect(container.querySelector('img.mn-image')).toBeNull()
    })
    const placeholder = container.querySelector('.mn-image-placeholder') as HTMLElement
    expect(placeholder).not.toBeNull()
    // 回退出来的占位**不带**授权标记（它不是"等授权"，而是已经放弃）
    expect(placeholder.hasAttribute('data-mn-asset')).toBe(false)
    expect(decodeURIComponent(placeholder.getAttribute('title') ?? '')).toContain('../附件/图.png')
  })

  it('越界路径与外部地址连授权请求都不发', async () => {
    const { container } = render(<MarkdownPreview />)

    await waitFor(() => {
      expect(container.querySelector('img.mn-image')).not.toBeNull()
    })

    // 只请求了 Vault 内那一张：越界与外部地址在解析层就被拒了
    expect(converted).toHaveLength(1)
    expect(container.querySelector('[data-mn-asset]')).toBeNull()
    // 另外两张是普通占位（不带授权标记）
    expect(container.querySelectorAll('.mn-image-placeholder').length).toBe(2)
  })

  it('非 Tauri 运行时（浏览器预览）不产出 asset URL，全部走占位', async () => {
    removeTauriRuntime()
    const { container } = render(<MarkdownPreview />)

    await waitFor(() => {
      expect(container.querySelectorAll('.mn-image-placeholder').length).toBe(3)
    })
    expect(container.querySelector('img.mn-image')).toBeNull()
    expect(container.querySelector('[data-mn-asset]')).toBeNull()
    expect(converted).toEqual([])
  })

  it('`![[图.png]]` 嵌入走同一条链路：授权 → img（图注用别名），非图片目标退回链接', async () => {
    await openNote('笔记/嵌入.md')
    const { container } = render(<MarkdownPreview />)

    await waitFor(() => {
      expect(container.querySelector('img.mn-image')).not.toBeNull()
    })
    // 与 `![](…)` 完全一样的路径：请求的就是 Vault 内那一个文件的绝对路径
    expect(converted).toEqual(['C:\\MockVault\\附件\\图.png'])
    expect(container.querySelector('.mn-image__caption')?.textContent).toBe('一张图注')

    // `![[另一篇笔记]]` 不是图片 → 与 wikilink 一致的链接元素
    const link = container.querySelector('a.mn-wikilink')
    expect(link?.getAttribute('data-target')).toBe('另一篇笔记')
    expect(link?.getAttribute('data-mn-embed')).toBe('non-image')
    expect(container.querySelectorAll('.mn-image-placeholder').length).toBe(0)
  })
})

/**
 * 灯箱：**点击**由它自己在 `document` 上以捕获阶段监听（预览组件不需要转发任何东西），
 * 因此这里用真实的 DOM 事件驱动，而不是调用组件的内部回调 —— 那正是要验证的接线方式。
 */
describe('图片灯箱', () => {
  /** 让 jsdom 里的 `<img>` 看起来"加载成功"：自然尺寸为 0 会被灯箱判成坏图而不打开。 */
  function markLoaded(image: HTMLImageElement, width = 640, height = 480): void {
    Object.defineProperty(image, 'complete', { value: true, configurable: true })
    Object.defineProperty(image, 'naturalWidth', { value: width, configurable: true })
    Object.defineProperty(image, 'naturalHeight', { value: height, configurable: true })
  }

  /** 渲染"预览 + 灯箱"（接线方式就是这样：灯箱挂在应用根部，与预览互不引用）。 */
  async function mount(): Promise<{ image: HTMLImageElement; body: HTMLElement }> {
    const { container } = render(
      <>
        <MarkdownPreview />
        <ImageLightbox />
      </>,
    )
    await waitFor(() => {
      expect(container.querySelector('img.mn-image')).not.toBeNull()
    })
    const image = container.querySelector('img.mn-image') as HTMLImageElement
    const body = container.querySelector('.mn-preview__body') as HTMLElement
    markLoaded(image)
    return { image, body }
  }

  const lightbox = (): HTMLElement | null => document.querySelector<HTMLElement>('.mn-lightbox')
  const bigImage = (): HTMLImageElement | null =>
    document.querySelector<HTMLImageElement>('.mn-lightbox__image')

  it('点预览里的图片就打开灯箱（文档级捕获监听，无需预览转发）', async () => {
    const { image } = await mount()
    fireEvent.click(image)

    const dialog = lightbox()
    expect(dialog).not.toBeNull()
    expect(dialog?.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('true')
    // 放大的是同一张图，并且把图注也带过来了
    expect(bigImage()?.getAttribute('src')).toBe(OK_IMAGE)
    expect(document.querySelector('.mn-lightbox__caption')?.textContent).toBe('图')
  })

  it('缩放：按钮与 `+` / `-` / `0` 键都生效，且被夹在上下限内', async () => {
    const { image } = await mount()
    fireEvent.click(image)

    // 1 倍 = 适应窗口
    expect(bigImage()?.style.maxWidth).toBe('100%')

    fireEvent.click(screen.getByRole('button', { name: '放大' }))
    expect(bigImage()?.style.maxWidth).toBe('125%')
    expect(bigImage()?.style.maxHeight).toBe('125%')

    fireEvent.keyDown(window, { key: '+' })
    expect(bigImage()?.style.maxWidth).toBe('156.25%')

    fireEvent.keyDown(window, { key: '-' })
    expect(bigImage()?.style.maxWidth).toBe('125%')

    fireEvent.click(screen.getByRole('button', { name: '缩小' }))
    expect(bigImage()?.style.maxWidth).toBe('100%')

    // `0` 回到适应窗口
    fireEvent.keyDown(window, { key: '+' })
    fireEvent.keyDown(window, { key: '0' })
    expect(bigImage()?.style.maxWidth).toBe('100%')

    // 上限：一直放大也不会越过 800%
    for (let i = 0; i < 30; i += 1) fireEvent.keyDown(window, { key: '+' })
    expect(bigImage()?.style.maxWidth).toBe('800%')
  })

  it('Esc 关闭，并把焦点还给打开它的元素', async () => {
    const { image, body } = await mount()
    body.tabIndex = -1
    body.focus()
    expect(document.activeElement).toBe(body)

    fireEvent.click(image)
    expect(lightbox()).not.toBeNull()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(lightbox()).toBeNull()
    expect(document.activeElement).toBe(body)
  })

  it('点遮罩关闭；点图片本身不关', async () => {
    const { image } = await mount()
    fireEvent.click(image)

    fireEvent.click(bigImage() as HTMLImageElement)
    expect(lightbox()).not.toBeNull()

    fireEvent.click(lightbox() as HTMLElement)
    expect(lightbox()).toBeNull()
  })

  it('关闭按钮同样关闭', async () => {
    const { image } = await mount()
    fireEvent.click(image)
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(lightbox()).toBeNull()
  })

  it('加载失败的图片不打开灯箱（放大一张裂图只会更让人困惑）', async () => {
    const { image } = await mount()
    markLoaded(image, 0, 0) // complete 且 naturalWidth = 0 → 坏图
    fireEvent.click(image)
    expect(lightbox()).toBeNull()
  })

  it('点预览里的其它内容不会打开灯箱', async () => {
    const { body } = await mount()
    fireEvent.click(body.querySelector('h1') as HTMLElement)
    expect(lightbox()).toBeNull()
  })

  it('灯箱里的大图加载失败时给一句说明，而不是留个裂图', async () => {
    const { image } = await mount()
    fireEvent.click(image)
    fireEvent.error(bigImage() as HTMLImageElement)
    expect(document.querySelector('.mn-lightbox__error')).not.toBeNull()
    expect(bigImage()).toBeNull()
  })

  it('被超大图封顶裁短的图片打上 data-mn-clipped（提示常驻），没裁短的不打', async () => {
    const { image } = await mount()
    const figure = image.closest('.mn-figure') as HTMLElement

    // jsdom 不做布局：手工给出"解码 480px、实际只显示 300px"（即被 max-height 压过）
    Object.defineProperty(image, 'clientHeight', { value: 300, configurable: true })
    fireEvent.load(image)
    expect(figure.getAttribute('data-mn-clipped')).toBe('1')

    // 显示高度与解码高度一致时把标记撤掉（换了更宽的窗口就又不算裁短了）
    Object.defineProperty(image, 'clientHeight', { value: 480, configurable: true })
    fireEvent.load(image)
    expect(figure.hasAttribute('data-mn-clipped')).toBe(false)
  })
})
