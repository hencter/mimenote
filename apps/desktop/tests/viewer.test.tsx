// @vitest-environment jsdom
/**
 * 附件查看器（图片，只读；ADR-0032）。
 *
 * 用户报的"图片选择后无法预览"：文件树里点一张图片，从前只会把它**选中**，什么都不显示
 * （`FileTree` 的分派只认 Markdown）。这一层测接线与三条收口路径，判据本身（哪些能打开）
 * 在 `domain/viewable.ts` 里一并钉住。
 *
 * 图片**真的渲染出来**（asset 协议、`naturalWidth > 0`）只能在应用层 E2E 里验：
 * jsdom 没有 asset 协议，浏览器预览也没有 —— 这里断言的是那种情况下"如实说明"的那条路
 * （一个明确的说明，而不是永远转圈的骨架）。
 */

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { App } from '@/App'
import { openNote } from '@/app/actions'
import { registerBuiltinCommands } from '@/app/builtin-commands'
import { isViewable, viewerKindOf } from '@/domain/viewable'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter } from '@/ipc/mock-adapter'
import { useNoteStore } from '@/state/note-store'
import { useTabsStore } from '@/state/tabs-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'

const IMAGE = '附件/图.png'

function treeRow(relPath: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.mn-tree [data-rel-path="${relPath}"]`)
}

function viewer(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-viewer-kind]')
}

/** 开一个 Vault，并往条目表里塞一张图片（Mock Vault 本身没有图片，见它的注释）。 */
async function mountWithImage(): Promise<void> {
  render(<App />)
  await useVaultStore.getState().openVault('C:\\MockVault')
  await waitFor(() => {
    expect(document.querySelectorAll('.mn-tree-row').length).toBeGreaterThan(0)
  })
  await act(async () => {
    useVaultStore.getState().registerAttachment({ relPath: IMAGE, sizeBytes: 2048 })
  })
  await waitFor(() => {
    expect(treeRow(IMAGE), '塞进去的图片应当出现在文件树里').not.toBeNull()
  })
}

async function clickTreeRow(relPath: string): Promise<void> {
  const row = treeRow(relPath)
  if (row === null) throw new Error(`文件树里没有 ${relPath}`)
  await act(async () => {
    row.click()
  })
}

beforeEach(() => {
  setIpcAdapter(createMockAdapter())
  registerBuiltinCommands()
  window.localStorage.clear()
  useNoteStore.getState().close()
  useUiStore.setState({ openedFile: null, viewMode: 'edit' })
  useTabsStore.setState({ tabs: [] })
  useVaultStore.setState({
    status: 'idle',
    info: null,
    entries: [],
    tree: [],
    expanded: new Set<string>(),
    selected: null,
    filter: '',
    error: null,
    lastRoot: null,
  })
})

afterEach(() => {
  cleanup()
})

describe('判据：哪些附件能打开（domain/viewable.ts）', () => {
  it('图片扩展名（与宿主白名单同一份口径）打开成图片查看器', () => {
    expect(viewerKindOf('附件/图.png')).toBe('image')
    expect(viewerKindOf('a/b/照片.JPEG')).toBe('image')
    expect(viewerKindOf('icon.svg')).toBe('image')
    expect(isViewable(IMAGE)).toBe(true)
  })

  it('其余一律不提供预览（笔记有它自己的三种视图，其他附件保持"只选中"）', () => {
    for (const relPath of ['项目/设计.md', '附件/说明.txt', '归档.zip', '.gitignore', '无扩展名', 'a.']) {
      expect(viewerKindOf(relPath), `${relPath} 不该被当成可预览`).toBeNull()
    }
  })
})

describe('接线：点开一张图片', () => {
  it('主区换成图片查看器，标题栏跟着换，**不进标签页**（标签页仍然只装笔记）', async () => {
    await mountWithImage()
    await clickTreeRow(IMAGE)

    await waitFor(() => {
      expect(viewer()?.getAttribute('data-viewer-kind')).toBe('image')
    })
    expect(document.querySelector('.mn-pane--file')).not.toBeNull()
    // 标题栏中区是"我在看什么"：现在是那张图（`data-main-path` 给的是真实路径）
    expect(
      document.querySelector('.mn-titlebar__path')?.getAttribute('data-main-path'),
    ).toBe(IMAGE)
    // 标签页只装笔记：看一张图不该冒出一个标签
    expect(useTabsStore.getState().tabs).toEqual([])
    // 也没有打开任何笔记
    expect(useNoteStore.getState().doc).toBeNull()
  })

  it('jsdom / 浏览器预览里拿不到 asset 协议：**如实说明**，而不是一个永远转圈的骨架', async () => {
    await mountWithImage()
    await clickTreeRow(IMAGE)

    await waitFor(() => {
      expect(document.querySelector('[data-viewer-unavailable="true"]')).not.toBeNull()
    })
    expect(
      document.querySelector('[data-viewer-unavailable="true"]')?.textContent ?? '',
    ).toContain('浏览器预览')
    // 环境说明态下不该有"实际大小"这种没有意义的动作
    expect(document.querySelector('[data-viewer-action="toggle-fit"]')).toBeNull()
  })

  it('不可预览的附件（`.txt`）保持原样：只选中，主区不动', async () => {
    await mountWithImage()
    await clickTreeRow('附件/说明.txt')

    expect(viewer()).toBeNull()
    expect(useVaultStore.getState().selected).toBe('附件/说明.txt')
  })

  it('打开一篇笔记就离开查看器（三条收口路径之一）', async () => {
    await mountWithImage()
    await clickTreeRow(IMAGE)
    await waitFor(() => {
      expect(viewer()).not.toBeNull()
    })

    await act(async () => {
      await openNote('项目/设计.md')
    })
    await waitFor(() => {
      expect(viewer()).toBeNull()
    })
    expect(document.querySelector('.mn-titlebar__path')?.getAttribute('data-main-path')).toBe(
      '项目/设计.md',
    )
  })

  it('点状态栏的视图按钮也回到笔记（"我要看笔记的那一种形态"）', async () => {
    await mountWithImage()
    await clickTreeRow(IMAGE)
    await waitFor(() => {
      expect(viewer()).not.toBeNull()
    })

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('button[aria-label="阅读（渲染后）"]')
        ?.click()
    })
    await waitFor(() => {
      expect(viewer()).toBeNull()
    })
    expect(useUiStore.getState().viewMode).toBe('read')
    expect(useUiStore.getState().openedFile).toBeNull()
  })
})
