// @vitest-environment jsdom
/**
 * 标签**层级编辑**（把标签挂到父标签下 / 提回顶层）的集成测试。
 *
 * 这一层验的是"界面上能不能看懂这次移动意味着什么、以及拒绝发生时有没有说清为什么"
 * （目标键的算法由 `cargo test -p mn-core` 的 3 条 `move_target_*` 钉住，
 * 宿主命令的拒绝分支由 `cargo test -p mimenote` 的 `tag_move_*` 钉住，
 * 真实二进制的落盘由 `e2e/real-app.e2e.test.ts` 覆盖）：
 *
 * 1. **入口**：全库概览每一行的 `⇥` 打开层级对话框，输入框初值就是"它现在挂在哪儿"；
 * 2. **三段式照旧**：预览不落盘 → 确定才写 → 汇报改了哪些；
 * 3. **只换位置不动名字**：`#甲` → `#父/甲`；留空 = 提回顶层（`#父/甲` → `#甲`）；
 * 4. **非法移动必须说人话**：挂到自己/自己的后代下面、目标已被占用 —— 磁盘一个字不动；
 * 5. **子标签跟着走**，且面板上展开着的那一节跟着挪（不指向一个已经不存在的键）。
 */

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { moveTag } from '@/app/actions'
import { TagsPanel } from '@/features/tags/TagsPanel'
import { ipc, setIpcAdapter } from '@/ipc/client'
import { createMockAdapter, type MockAdapter } from '@/ipc/mock-adapter'
import { useNoteStore } from '@/state/note-store'
import { useTagsStore } from '@/state/tags-store'
import { useToastStore } from '@/state/toast-store'
import { useVaultStore } from '@/state/vault-store'

const TOP = '---\ntags: [甲]\n---\n\n正文里的 #甲 与 #别的。\n'
const CHILD = '---\ntags: [甲/子]\n---\n\n#甲/子 收尾\n'
const OTHER = '---\ntags: [别的]\n---\n\n#别的\n'

let adapter: MockAdapter

function resetStores(): void {
  useNoteStore.getState().close()
  useTagsStore.setState({
    open: false,
    relPath: null,
    noteTags: null,
    summary: [],
    activeKey: null,
    activeRaw: null,
    activeNotes: [],
    loading: false,
    error: null,
  })
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
  useToastStore.getState().clear()
}

function textOf(relPath: string): string | undefined {
  return adapter.dump().find((note) => note.relPath === relPath)?.text
}

async function openPanel(relPath: string): Promise<void> {
  const { openNote } = await import('@/app/actions')
  await openNote(relPath)
  useTagsStore.setState({ open: true })
  render(<TagsPanel />)
  await waitFor(() => {
    expect(document.querySelector('[data-tag]')).not.toBeNull()
  })
  // 全库概览（`⇥` 的入口）要等一次 `tags_list`：等它出现，避免测试与面板的竞态
  await waitFor(() => {
    expect(document.querySelector('[data-tag-move-open]')).not.toBeNull()
  })
}

/** 打开某个标签的层级对话框（走面板上那个 `⇥`，而不是直接渲染组件）。 */
function openMoveDialog(key: string): void {
  const button = document.querySelector(`[data-tag-move-open="${key}"]`) as HTMLElement
  expect(button, `面板上应当有 ${key} 的层级入口`).not.toBeNull()
  fireEvent.click(button)
  expect(document.querySelector('[data-tag-move-dialog]')).not.toBeNull()
}

function parentInput(): HTMLInputElement {
  return document.querySelector('[data-tag-rename-input]') as HTMLInputElement
}

function typeParent(value: string): HTMLInputElement {
  const input = parentInput()
  fireEvent.change(input, { target: { value } })
  return input
}

async function preview(): Promise<void> {
  fireEvent.click(document.querySelector('[data-tag-rename-preview-button]') as HTMLElement)
  await waitFor(() => {
    expect(document.querySelector('[data-tag-rename-preview]')).not.toBeNull()
  })
}

async function confirm(): Promise<void> {
  fireEvent.click(document.querySelector('[data-tag-rename-confirm]') as HTMLElement)
  await waitFor(() => {
    expect(document.querySelector('[data-tag-rename-result]')).not.toBeNull()
  })
}

beforeEach(async () => {
  adapter = createMockAdapter({
    notes: [
      { relPath: '甲.md', text: TOP },
      { relPath: '目录/子.md', text: CHILD },
      { relPath: '别的.md', text: OTHER },
    ],
  })
  setIpcAdapter(adapter)
  resetStores()
  await useVaultStore.getState().openVault('C:\\MockVault')
})

afterEach(() => {
  cleanup()
})

describe('入口与初值', () => {
  it('全库概览里有「移到…」入口；点开只是对话框，磁盘一个字都没动', async () => {
    await openPanel('甲.md')
    openMoveDialog('甲')

    expect(textOf('甲.md')).toBe(TOP)
    expect(document.querySelector('[data-tag-rename-preview]')).toBeNull()
    // 顶层标签的父标签是空的（留空 = 顶层），并且给了一句"只换位置不动名字"的说明
    expect(parentInput().value).toBe('')
    expect(document.querySelector('[data-tag-move-hint="leaf-kept"]')?.textContent).toContain(
      '只换位置，不动名字',
    )
  })

  it('输入框初值 = 它现在挂在哪儿（`甲/子` → `甲`），并给出父标签候选', async () => {
    await openPanel('甲.md')
    openMoveDialog('甲/子')

    expect(parentInput().value).toBe('甲')
    const options = [...document.querySelectorAll('#mn-tag-parent-options option')].map((node) =>
      node.getAttribute('value'),
    )
    // 候选里不能出现它自己（宿主一定会拒绝"挂到自己下面"）
    expect(options).not.toContain('甲/子')
    expect(options).toContain('别的')
  })

  it('Esc 取消：对话框关掉，磁盘不动', async () => {
    await openPanel('甲.md')
    openMoveDialog('甲')
    typeParent('父')

    fireEvent.keyDown(window, { key: 'Escape' })

    await waitFor(() => {
      expect(document.querySelector('[data-tag-move-dialog]')).toBeNull()
    })
    expect(textOf('甲.md')).toBe(TOP)
  })
})

describe('先预览再确定', () => {
  it('把 `#甲` 挂到 `#父` 下面：预览不落盘，确定后 frontmatter 与正文一起改', async () => {
    await openPanel('甲.md')
    openMoveDialog('甲')
    typeParent('父')
    await preview()

    // 默认连同子标签：`甲.md` 与 `目录/子.md` 都在候选集里（子标签见下一条用例）
    expect(document.querySelector('[data-tag-rename-preview]')?.textContent).toContain(
      '这会改 2 篇笔记',
    )
    expect(textOf('甲.md')).toBe(TOP)

    await confirm()
    expect(textOf('甲.md')).toBe('---\ntags: [父/甲]\n---\n\n正文里的 #父/甲 与 #别的。\n')
    expect(document.querySelector('[data-tag-rename-result]')?.textContent).toContain('改了 2 篇笔记')
  })

  it('留空 = 提回顶层：`#甲/子` → `#子`，面板与概览跟着换成新键', async () => {
    await openPanel('甲.md')
    openMoveDialog('甲/子')
    typeParent('')
    await preview()
    await confirm()

    expect(textOf('目录/子.md')).toBe('---\ntags: [子]\n---\n\n#子 收尾\n')
    await waitFor(() => {
      const keys = [...document.querySelectorAll('[data-tag-key]')].map((node) =>
        node.getAttribute('data-tag-key'),
      )
      expect(keys).toContain('子')
      expect(keys).not.toContain('甲/子')
    })
  })

  it('「移到顶层」按钮把输入框清空（不用手删到底）', async () => {
    await openPanel('甲.md')
    openMoveDialog('甲/子')
    expect(parentInput().value).toBe('甲')

    fireEvent.click(document.querySelector('[data-tag-move-top]') as HTMLElement)

    expect(parentInput().value).toBe('')
  })

  it('输入框里回车 = 预览改动（移动模式下空输入也是合法的）', async () => {
    await openPanel('甲.md')
    openMoveDialog('甲/子')
    const input = typeParent('')
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(document.querySelector('[data-tag-rename-preview]')).not.toBeNull()
    })
    expect(document.querySelector('[data-tag-rename-preview]')?.textContent).toContain('这会改 1 篇')
  })

  it('连同子标签一起移动：`甲` → `父/甲` 时 `甲/子` → `父/甲/子`；关掉开关就只动整条等于 `甲` 的', async () => {
    await openPanel('甲.md')
    openMoveDialog('甲')

    // 先关掉"连同子标签"→ 只改整条等于 `甲` 的（`甲/子` 留在原地）
    fireEvent.click(document.querySelector('[data-tag-rename-children]') as HTMLElement)
    typeParent('父')
    await preview()
    await confirm()

    expect(textOf('甲.md')).toBe('---\ntags: [父/甲]\n---\n\n正文里的 #父/甲 与 #别的。\n')
    expect(textOf('目录/子.md')).toBe(CHILD)
  })

  it('默认连同子标签：`甲` → `父/甲` 时子标签一起落到 `父/甲/子`', async () => {
    await openPanel('甲.md')
    openMoveDialog('甲')
    typeParent('父')
    await preview()
    await confirm()

    expect(textOf('目录/子.md')).toBe('---\ntags: [父/甲/子]\n---\n\n#父/甲/子 收尾\n')
  })
})

describe('非法移动必须说清为什么，且不碰磁盘', () => {
  it('挂到它自己下面 → 拒绝，理由是"不能把标签挂到它自己下面"', async () => {
    await openPanel('甲.md')
    openMoveDialog('甲')
    typeParent('甲')
    // 不用 `preview()` 辅助：**被拒绝时根本没有预览阶段**，对话框停在输入阶段
    fireEvent.click(document.querySelector('[data-tag-rename-preview-button]') as HTMLElement)

    await waitFor(() => {
      const toast = useToastStore.getState().toasts.find((item) => item.kind === 'error')
      expect(toast?.message).toContain('不能把标签挂到它自己下面')
    })
    expect(document.querySelector('[data-tag-rename-preview]')).toBeNull()
    expect(textOf('甲.md')).toBe(TOP)
  })

  it('挂到自己的后代下面 → 拒绝（会造出改不完的层级）', async () => {
    await openPanel('甲.md')
    openMoveDialog('甲')
    typeParent('甲/子')

    expect(await moveTag('甲', '甲/子', { dryRun: false })).toBeNull()
    const toast = useToastStore.getState().toasts.find((item) => item.kind === 'error')
    expect(toast?.message).toContain('不能把标签挂到它自己的子标签下面')
    expect(textOf('甲.md')).toBe(TOP)
    expect(textOf('目录/子.md')).toBe(CHILD)
  })

  it('目标已经被别的标签占用 → 拒绝并指向「重命名」（那是合并，不是移动）', async () => {
    // 造一个 `父/甲` 已经存在的 Vault：移动会把它并掉，必须拒绝
    adapter = createMockAdapter({
      notes: [
        { relPath: '甲.md', text: TOP },
        { relPath: '父甲.md', text: '---\ntags: [父/甲]\n---\n\n#父/甲\n' },
      ],
    })
    setIpcAdapter(adapter)
    await useVaultStore.getState().openVault('C:\\MockVault')

    expect(await moveTag('甲', '父', { dryRun: false })).toBeNull()
    const toast = useToastStore.getState().toasts.find((item) => item.kind === 'error')
    expect(toast?.message).toContain('已经是一个标签了')
    expect(toast?.message).toContain('重命名')
    expect(textOf('甲.md')).toBe(TOP)
    expect(textOf('父甲.md')).toBe('---\ntags: [父/甲]\n---\n\n#父/甲\n')
  })

  it('已经在那个父标签下面了 → 明确拒绝，而不是静默当成功', async () => {
    await openPanel('甲.md')
    openMoveDialog('甲/子')

    expect(await moveTag('甲/子', '甲', { dryRun: false })).toBeNull()
    const toast = useToastStore.getState().toasts.find((item) => item.kind === 'error')
    expect(toast?.message).toContain('已经在那个父标签下面了')
    expect(textOf('目录/子.md')).toBe(CHILD)
  })

  it('父标签里写了空段（`父//子`）→ 拒绝，不去猜用户想要什么', async () => {
    expect(await moveTag('甲', '父//子', { dryRun: false })).toBeNull()
    const toast = useToastStore.getState().toasts.find((item) => item.kind === 'error')
    expect(toast?.message).toContain('不能有空的层级')
    expect(textOf('甲.md')).toBe(TOP)
  })
})

describe('收尾：面板上正展开的那一节跟着挪', () => {
  it('移动父标签时，展开着的子标签不指向一个已经不存在的键', async () => {
    await openPanel('甲.md')
    // 模拟"正展开着 `甲/子`"（层级编辑之前它只会被整条重命名命中）
    useTagsStore.setState({ activeKey: '甲/子', activeRaw: '甲/子' })

    useTagsStore.getState().retargetActiveTag('甲', '父/甲')

    expect(useTagsStore.getState().activeKey).toBe('父/甲/子')
    // 与它无关的标签不受影响
    useTagsStore.setState({ activeKey: '别的', activeRaw: '别的' })
    useTagsStore.getState().retargetActiveTag('甲', '父/甲')
    expect(useTagsStore.getState().activeKey).toBe('别的')
  })
})

describe('Mock 镜像与 Rust 同一条纪律', () => {
  it('只换祖先不动名字：`甲/孙/末` 挂到 `父` 下是 `父/末`（末段才是它自己的名字）', async () => {
    adapter = createMockAdapter({
      notes: [{ relPath: '深.md', text: '---\ntags: [甲/孙/末]\n---\n\n#甲/孙/末\n' }],
    })
    setIpcAdapter(adapter)
    await useVaultStore.getState().openVault('C:\\MockVault')

    const outcome = await ipc.tagMove('甲/孙/末', '父', { dryRun: false })

    expect(outcome?.to).toBe('父/末')
    expect(textOf('深.md')).toBe('---\ntags: [父/末]\n---\n\n#父/末\n')
  })

  it('父标签首尾的 `/` 容忍（`/父/` 就是 `父`）', async () => {
    const outcome = await ipc.tagMove('甲', '/父/', { dryRun: true })

    expect(outcome?.to).toBe('父/甲')
  })
})
