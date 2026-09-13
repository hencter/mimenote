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

import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openNote } from '@/app/actions'
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
})
