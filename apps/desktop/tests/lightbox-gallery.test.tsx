// @vitest-environment jsdom
/**
 * 灯箱里的多图翻页（同一篇笔记的第 N / 共 M 张）。
 *
 * 为什么值得单测：翻页的两个易错点都不在"看起来对不对"的层面 ——
 * ① 画廊是**打开那一刻**的 DOM 快照（预览是 `dangerouslySetInnerHTML` 渲染的，
 * 每次正文变化节点全换），错写成"每次翻页重新扫"就会在编辑时翻到一半没图；
 * ② 上一张的缩放/失败态会跟着跑到下一张上（一张 4K 截图放大到 300% 之后翻页，
 * 下一张小图会直接甩出画面外）。
 *
 * 装配方式与 `tests/preview-images.test.tsx` 一致：桩掉 Tauri 运行时 + `convertFileSrc`，
 * 让预览真的把 `<img>` 渲染出来（jsdom 加载不了自定义 scheme，因此用 `data:` URL）。
 */

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openNote } from '@/app/actions'
import { MarkdownEditor } from '@/features/editor/MarkdownEditor'
import { ImageLightbox } from '@/features/lightbox/ImageLightbox'
import { MarkdownPreview } from '@/features/preview/MarkdownPreview'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter, MOCK_VAULT_PATH } from '@/ipc/mock-adapter'
import { useLinksStore } from '@/state/links-store'
import { useNoteStore } from '@/state/note-store'
import { useVaultStore } from '@/state/vault-store'

/** 1×1 GIF：jsdom 不会为它触发 error。 */
const OK_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

const NOTES = [
  {
    relPath: '笔记/三张图.md',
    text: ['# 三张图', '', '![一](../附件/一.png)', '', '![二](../附件/二.png)', '', '![三](../附件/三.png)', ''].join(
      '\n',
    ),
  },
  {
    relPath: '笔记/一张图.md',
    text: ['# 一张图', '', '![只有一张](../附件/一.png)', ''].join('\n'),
  },
]

function stubTauriRuntime(): void {
  ;(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {
    convertFileSrc: () => OK_IMAGE,
  }
}

beforeEach(async () => {
  stubTauriRuntime()
  setIpcAdapter(createMockAdapter({ notes: NOTES }))
  useNoteStore.getState().close()
  useLinksStore.getState().clear()
  useVaultStore.setState({
    status: 'idle',
    info: null,
    entries: [],
    tree: [],
    selected: null,
  })
  // 必须先打开 Vault：没有 Vault 根就没有 asset 协议（图片会停在占位元素上，
  // 于是 `img.mn-image` 一个都不存在 —— 那正是这条用例要渲染的东西）
  await useVaultStore.getState().openVault(MOCK_VAULT_PATH)
})

afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__']
})

/** 打开一篇笔记，等图片元素真的渲染出来（授权是异步的两段式渲染）。 */
async function renderWithImages(relPath: string): Promise<HTMLImageElement[]> {
  render(
    <>
      <MarkdownPreview />
      <ImageLightbox />
    </>,
  )
  await act(async () => {
    await openNote(relPath)
  })
  return waitFor(() => {
    const images = Array.from(document.querySelectorAll<HTMLImageElement>('.mn-preview__body img.mn-image'))
    expect(images.length).toBeGreaterThan(0)
    return images
  })
}

function counterText(): string {
  return document.querySelector('.mn-lightbox__counter')?.textContent?.trim() ?? ''
}

function button(label: string): HTMLButtonElement {
  const node = Array.from(document.querySelectorAll<HTMLButtonElement>('.mn-lightbox__toolbar button')).find(
    (item) => item.textContent?.trim() === label,
  )
  if (node === undefined) throw new Error(`没有这个按钮：${label}`)
  return node
}

describe('灯箱多图翻页', () => {
  it('点第二张打开：显示 2 / 3，两侧按钮都可用', async () => {
    const images = await renderWithImages('笔记/三张图.md')

    await act(async () => {
      fireEvent.click(images[1] as HTMLImageElement)
    })
    await waitFor(() => {
      expect(document.querySelector('.mn-lightbox')).not.toBeNull()
    })

    expect(counterText()).toBe('2 / 3')
    expect(button('上一张').disabled).toBe(false)
    expect(button('下一张').disabled).toBe(false)
  })

  it('下一张 / 上一张按钮改的是显示的图与计数，端点处按钮置灰', async () => {
    const images = await renderWithImages('笔记/三张图.md')
    await act(async () => {
      fireEvent.click(images[0] as HTMLImageElement)
    })
    await waitFor(() => expect(counterText()).toBe('1 / 3'))
    // 第一张时"上一张"不可用（不是"点了没反应"）
    expect(button('上一张').disabled).toBe(true)

    await act(async () => {
      button('下一张').click()
    })
    await waitFor(() => expect(counterText()).toBe('2 / 3'))

    await act(async () => {
      button('下一张').click()
    })
    await waitFor(() => expect(counterText()).toBe('3 / 3'))
    expect(button('下一张').disabled).toBe(true)

    await act(async () => {
      button('上一张').click()
    })
    await waitFor(() => expect(counterText()).toBe('2 / 3'))

    // 显示的图确实换了：`src` 来自被点的那一张（这里是同一个 data URL，因此断言 alt 图注）
    expect(document.querySelector('.mn-lightbox__caption')?.textContent).toBe('二')
  })

  it('PageDown / PageUp 能翻页（方向键留给"平移大图"）', async () => {
    const images = await renderWithImages('笔记/三张图.md')
    await act(async () => {
      fireEvent.click(images[0] as HTMLImageElement)
    })
    await waitFor(() => expect(counterText()).toBe('1 / 3'))

    await act(async () => {
      fireEvent.keyDown(window, { key: 'PageDown' })
    })
    await waitFor(() => expect(counterText()).toBe('2 / 3'))

    await act(async () => {
      fireEvent.keyDown(window, { key: 'PageUp' })
    })
    await waitFor(() => expect(counterText()).toBe('1 / 3'))
  })

  it('翻页把缩放与失败态一起重置（上一张的 300% 不该甩到下一张身上）', async () => {
    const images = await renderWithImages('笔记/三张图.md')
    await act(async () => {
      fireEvent.click(images[0] as HTMLImageElement)
    })
    await waitFor(() => expect(counterText()).toBe('1 / 3'))

    // 放大两次 → 156%（1.25²）
    fireEvent.keyDown(window, { key: '=' })
    fireEvent.keyDown(window, { key: '=' })
    await waitFor(() => {
      expect(document.querySelector('.mn-lightbox__zoom')?.textContent).toBe('156%')
    })

    await act(async () => {
      fireEvent.keyDown(window, { key: 'PageDown' })
    })
    await waitFor(() => {
      expect(document.querySelector('.mn-lightbox__zoom')?.textContent).toBe('100%')
    })
    // 新的一张重新开始加载：不该继承"上一张加载失败"的错误态
    expect(document.querySelector('.mn-lightbox__error')).toBeNull()
  })

  it('只有一张图时不显示翻页控件（也不显示 1 / 1）', async () => {
    const images = await renderWithImages('笔记/一张图.md')
    await act(async () => {
      fireEvent.click(images[0] as HTMLImageElement)
    })
    await waitFor(() => {
      expect(document.querySelector('.mn-lightbox')).not.toBeNull()
    })

    expect(document.querySelector('.mn-lightbox__counter')).toBeNull()
    const labels = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.mn-lightbox__toolbar button'),
    ).map((item) => item.textContent?.trim())
    expect(labels).not.toContain('上一张')
    expect(labels).not.toContain('下一张')
  })

  it('关掉再打开另一张时，画廊按新图片重新定位（不会留在上一张的序号上）', async () => {
    const images = await renderWithImages('笔记/三张图.md')
    await act(async () => {
      fireEvent.click(images[2] as HTMLImageElement)
    })
    await waitFor(() => expect(counterText()).toBe('3 / 3'))

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    await waitFor(() => {
      expect(document.querySelector('.mn-lightbox')).toBeNull()
    })

    const again = Array.from(
      document.querySelectorAll<HTMLImageElement>('.mn-preview__body img.mn-image'),
    )
    await act(async () => {
      fireEvent.click(again[0] as HTMLImageElement)
    })
    await waitFor(() => expect(counterText()).toBe('1 / 3'))
  })
})

/**
 * 编辑器（所见即所得）里的图片也要能点开放大。
 *
 * 两处的图片类名不同（预览 `img.mn-image` / 编辑器 `img.mn-md-image`），而 Live Preview 把
 * 图片换成 widget 时会 `ignoreEvent()` —— 这些都不该让"点图片放大"只在阅读视图里成立：
 * 用户写作时看到的就是编辑器。
 */
describe('编辑器里的图片也能放大', () => {
  it('点编辑器里的图片打开灯箱，并与同一篇的其它图一起翻页', async () => {
    render(
      <>
        <MarkdownEditor />
        <ImageLightbox />
      </>,
    )
    await act(async () => {
      await openNote('笔记/三张图.md')
    })

    // 光标在文档开头（第一行），因此三张图都不在光标所在行 ⇒ 都渲染成 widget
    //
    // ⚠️ 给一个**宽**超时：图片 widget 是编辑器装饰的产物，而装饰要等 Lezer 把语法树解析到那几行
    // 才建得出来，解析本身有**时间预算**（机器忙时只解析一部分，下一轮继续）。默认的 1s 在
    // 全量套件并行（外加构建）时不够 —— 表现为"只找到 1 张图"这种与实现无关的假红。
    const images = await waitFor(
      () => {
        const nodes = Array.from(
          document.querySelectorAll<HTMLImageElement>('.cm-content img.mn-md-image'),
        )
        expect(nodes).toHaveLength(3)
        return nodes
      },
      { timeout: 15_000 },
    )

    await act(async () => {
      fireEvent.click(images[1] as HTMLImageElement)
    })
    await waitFor(() => {
      expect(document.querySelector('.mn-lightbox')).not.toBeNull()
    })

    // 画廊是"编辑器正文里那三张"，序号跟着被点的那一张
    expect(counterText()).toBe('2 / 3')
    await act(async () => {
      fireEvent.keyDown(window, { key: 'PageDown' })
    })
    await waitFor(() => expect(counterText()).toBe('3 / 3'))

    // 关掉之后编辑器还在原位（放大不改文档、不动光标）
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    await waitFor(() => {
      expect(document.querySelector('.mn-lightbox')).toBeNull()
    })
    expect(document.querySelectorAll('.cm-content img.mn-md-image')).toHaveLength(3)
  })

  it('编辑器里被 max-height 裁短的图片也打上 data-mn-clipped（"点击查看原图"常驻）', async () => {
    render(
      <>
        <MarkdownEditor />
        <ImageLightbox />
      </>,
    )
    await act(async () => {
      await openNote('笔记/三张图.md')
    })
    const image = await waitFor(() => {
      const node = document.querySelector<HTMLImageElement>('.cm-content img.mn-md-image')
      expect(node).not.toBeNull()
      return node as HTMLImageElement
    })
    const wrap = image.closest('.mn-md-image-wrap')
    expect(wrap).not.toBeNull()

    // jsdom 不做布局：手工给出"解码 900px、实际只显示 420px"（即被 max-height 压过）
    Object.defineProperty(image, 'naturalHeight', { value: 900, configurable: true })
    Object.defineProperty(image, 'clientHeight', { value: 420, configurable: true })
    await act(async () => {
      fireEvent.load(image)
    })
    expect(wrap?.getAttribute('data-mn-clipped')).toBe('1')

    // 尺寸够放时把标记撤掉（没被裁短就不该显示提示）
    Object.defineProperty(image, 'clientHeight', { value: 900, configurable: true })
    await act(async () => {
      fireEvent.load(image)
    })
    expect(wrap?.hasAttribute('data-mn-clipped')).toBe(false)
  })
})
