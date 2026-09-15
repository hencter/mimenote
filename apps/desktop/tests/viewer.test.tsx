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

  it('文本类附件（`.txt` / `.json` / `.csv` / 源码…）走纯文本查看器', () => {
    // 宿主 `note_read` 本来就不限扩展名（只做路径防护/拒目录/限大小），所以这一类**不需要新 IPC**
    expect(viewerKindOf('附件/说明.txt')).toBe('text')
    expect(viewerKindOf('数据/表.CSV')).toBe('text')
    expect(viewerKindOf('配置/app.toml')).toBe('text')
    expect(viewerKindOf('脚本/x.py')).toBe('text')
  })

  it('其余一律不提供预览（笔记有自己的三种视图；二进制与未知类型保持"只选中"）', () => {
    // 白名单而不是"凡不是图片就按文本打开"：把 `.zip`/`.db` 当文本读，用户看到的是乱码，
    // 那比"打不开"更像 bug（`.md` 也不在这里 —— 它是笔记）
    for (const relPath of ['项目/设计.md', '归档.zip', '库.db', '图.png.exe', '.gitignore', '无扩展名', 'a.']) {
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
    // "我在看什么"在**状态栏**里（ADR-0034 把标题栏中区让给了标签栏）：现在是那张图
    expect(
      document.querySelector('.mn-statusbar [data-main-path]')?.getAttribute('data-main-path'),
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

  it('点一个 `.txt`：纯文本查看器把原文显示出来（只读，且不动笔记）', async () => {
    await mountWithImage()
    await clickTreeRow('附件/说明.txt')

    await waitFor(() => {
      expect(viewer()?.getAttribute('data-viewer-kind')).toBe('text')
    })
    // 内容真的来自磁盘（Mock 适配器的 note_read），不是占位
    expect(document.querySelector('[data-viewer-text="true"]')?.textContent ?? '').toContain(
      '非 Markdown 附件',
    )
    expect(useNoteStore.getState().doc).toBeNull()
    expect(useTabsStore.getState().tabs).toEqual([])
  })

  it('不可预览的附件（`.zip`）保持原样：只选中，主区不动', async () => {
    await mountWithImage()
    await act(async () => {
      useVaultStore.getState().registerAttachment({ relPath: '归档/打包.zip', sizeBytes: 4096 })
    })
    await waitFor(() => {
      expect(treeRow('归档/打包.zip')).not.toBeNull()
    })
    await clickTreeRow('归档/打包.zip')

    expect(viewer()).toBeNull()
    expect(useVaultStore.getState().selected).toBe('归档/打包.zip')
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
    expect(document.querySelector('.mn-statusbar [data-main-path]')?.getAttribute('data-main-path')).toBe(
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
