// @vitest-environment jsdom
/**
 * 标签与 Frontmatter（M2）集成测试。
 *
 * 分两层：
 * 1. **抽取规则**（走 Mock 适配器，是 Rust `mn_core::tags` 的简化镜像）：本测钉住的是
 *    "界面上能看到什么"，真正的规则权威在 Rust（`cargo test -p mn-core` 有 20+ 个用例）；
 * 2. **面板行为**：当前笔记的标签/属性渲染、点击标签展开笔记、点击笔记真的打开它。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openNote } from '@/app/actions'
import { TagsPanel } from '@/features/tags/TagsPanel'
import { ipc, setIpcAdapter } from '@/ipc/client'
import { createMockAdapter, type MockAdapter } from '@/ipc/mock-adapter'
import { useNoteStore } from '@/state/note-store'
import { useTagsStore } from '@/state/tags-store'
import { useVaultStore } from '@/state/vault-store'

const NOTES = [
  {
    relPath: '甲.md',
    text: '---\ntitle: 甲\ntags: [笔记/甲, 乙]\n---\n\n正文 #丙 与 #父/子 与 #123 与 a#b\n',
  },
  {
    relPath: '乙.md',
    text: '# 标题 #伪装\n\n```\n#代码里的不算\n```\n\n行内 `#也不算`。\n\n#丙\n',
  },
  { relPath: '丙.md', text: '---\ntags:\n  - 丙\n  - Rust\n---\n\n#rust 大小写算同一个\n' },
  // 完全没有标签：只用来验证面板的空态文案
  { relPath: '丁.md', text: '# 只有标题\n\n普通正文，没有任何标签。\n' },
]

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
}

beforeEach(async () => {
  adapter = createMockAdapter({ notes: NOTES })
  setIpcAdapter(adapter)
  resetStores()
  await useVaultStore.getState().openVault('C:\\MockVault')
})

afterEach(() => {
  cleanup()
})

describe('标签抽取（Mock 镜像）', () => {
  it('frontmatter 与正文行内标签都会抽到，并带来源与行号', async () => {
    const result = await ipc.noteTags('甲.md')
    expect(result.tags.map((tag) => tag.tag)).toEqual(['笔记/甲', '乙', '丙', '父/子'])
    expect(result.tags[0]?.source).toBe('frontmatter')
    expect(result.tags[2]?.source).toBe('inline')
    // 行号：frontmatter 第 3 行、正文第 6 行
    expect(result.tags[0]?.line).toBe(3)
    expect(result.tags[2]?.line).toBe(6)
  })

  it('纯数字、行内 `a#b` 不算标签', async () => {
    const result = await ipc.noteTags('甲.md')
    const tags = result.tags.map((tag) => tag.tag)
    expect(tags).not.toContain('123')
    expect(tags).not.toContain('b')
  })

  it('标题行、代码块与行内代码里的 `#` 不抽', async () => {
    const result = await ipc.noteTags('乙.md')
    expect(result.tags.map((tag) => tag.tag)).toEqual(['丙'])
  })

  it('frontmatter 属性保序，并按类型标注（scalar / list / number）', async () => {
    const first = await ipc.noteTags('甲.md')
    expect(first.frontmatter.map((field) => field.key)).toEqual(['title', 'tags'])
    expect(first.frontmatter[0]?.value).toEqual({ kind: 'scalar', value: '甲' })

    const third = await ipc.noteTags('丙.md')
    const tagsField = third.frontmatter.find((field) => field.key === 'tags')
    expect(tagsField?.value).toEqual({ kind: 'list', value: ['丙', 'Rust'] })
    // 大小写归一：`tags: [Rust]` 与正文 `#rust` 是同一个标签，保留首次写法
    expect(third.tags.map((tag) => tag.tag)).toEqual(['丙', 'Rust'])
  })

  it('数字与布尔的分类与 Rust 同口径（数字保留原始文本）', async () => {
    adapter = createMockAdapter({
      notes: [{ relPath: '类型.md', text: '---\nweight: 1.50\nstarred: true\nempty: ~\n---\n正文。\n' }],
    })
    setIpcAdapter(adapter)
    const result = await ipc.noteTags('类型.md')
    const byKey = new Map(result.frontmatter.map((field) => [field.key, field.value]))
    expect(byKey.get('weight')).toEqual({ kind: 'number', value: '1.50' })
    expect(byKey.get('starred')).toEqual({ kind: 'bool', value: true })
    expect(byKey.get('empty')).toEqual({ kind: 'null' })
  })

  it('全库标签概览按笔记数降序，并保留首次出现的写法', async () => {
    const summary = await ipc.tagsList()
    const byKey = new Map(summary.map((item) => [item.key, item]))
    // 「丙」出现在 甲（行内）、乙（行内）、丙.md（frontmatter）三篇里
    expect(byKey.get('丙')?.count).toBe(3)
    expect(byKey.get('rust')?.tag).toBe('Rust')
    expect(byKey.get('笔记/甲')?.count).toBe(1)
    // 计数相同的按 key 字典序
    const counts = summary.map((item) => item.count)
    expect([...counts].sort((a, b) => b - a)).toEqual(counts)
  })

  it('按标签取笔记列表（传原始写法也可以，归一化在宿主侧）', async () => {
    const result = await ipc.tagNotes('Rust')
    expect(result.key).toBe('rust')
    expect(result.notes).toEqual(['丙.md'])
  })
})

describe('标签面板', () => {
  it('显示当前笔记的标签与属性，点击标签展开笔记列表并可打开', async () => {
    await openNote('甲.md')
    useTagsStore.setState({ open: true })
    const { container } = render(<TagsPanel />)

    // 本篇标签（注意同名的标签也会出现在"全库标签"里，所以用属性选择器精确定位）
    await waitFor(() => {
      expect(container.querySelector('[data-tag="笔记/甲"]')).not.toBeNull()
    })
    expect(container.querySelector('[data-tag="乙"]')).not.toBeNull()
    expect(container.querySelector('[data-tag-source="frontmatter"]')).not.toBeNull()
    // Frontmatter 属性
    expect(screen.getByText('title')).toBeDefined()
    expect(screen.getByText('甲')).toBeDefined()

    // 点击标签 → 展开含该标签的笔记
    fireEvent.click(container.querySelector('[data-tag="丙"]') as HTMLElement)
    await waitFor(() => {
      expect(screen.getByText(/含「丙」的笔记/)).toBeDefined()
    })
    const noteButtons = container.querySelectorAll('[data-tag-note]')
    expect(noteButtons.length).toBe(3)

    // 点击笔记 → 真的打开它
    fireEvent.click(noteButtons[0] as HTMLElement)
    await waitFor(() => {
      expect(['甲.md', '乙.md', '丙.md']).toContain(useNoteStore.getState().doc?.relPath)
    })
  })

  it('chip 用原始写法、概览行用归一化键：点一次两边同时高亮', async () => {
    // 丙.md：frontmatter 写 `Rust`，正文明明写 `#rust` —— 归一化后是同一个标签
    await openNote('丙.md')
    useTagsStore.setState({ open: true })
    const { container } = render(<TagsPanel />)

    const chip = await waitFor(() => {
      const found = container.querySelector('[data-tag="Rust"]')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    const summaryRow = container.querySelector('[data-tag-key="rust"]') as HTMLElement
    expect(summaryRow).not.toBeNull()

    fireEvent.click(chip)
    await waitFor(() => {
      expect(container.querySelector('[data-tag="Rust"]')?.className).toContain('mn-tag--active')
    })
    // 概览行用的是宿主返回的归一化键 → 也必须高亮
    expect(container.querySelector('[data-tag-key="rust"]')?.className).toContain('mn-tag--active')
    // 标题显示的是用户点的那条写法，而不是键
    expect(screen.getByText(/含「Rust」的笔记/)).toBeDefined()

    // 再点一次收起
    fireEvent.click(container.querySelector('[data-tag="Rust"]') as HTMLElement)
    await waitFor(() => {
      expect(useTagsStore.getState().activeKey).toBeNull()
    })
  })

  it('没有标签时给出写法提示', async () => {
    await openNote('丁.md')
    useTagsStore.setState({ open: true })
    render(<TagsPanel />)

    await waitFor(() => {
      expect(screen.getByText(/没有标签/)).toBeDefined()
    })
  })

  it('关闭按钮收起面板', async () => {
    await openNote('甲.md')
    useTagsStore.setState({ open: true })
    const { container } = render(<TagsPanel />)
    await waitFor(() => {
      expect(container.querySelector('[data-tag="笔记/甲"]')).not.toBeNull()
    })

    fireEvent.click(screen.getByLabelText('关闭标签面板'))
    expect(useTagsStore.getState().open).toBe(false)
    expect(container.querySelector('[data-tag="笔记/甲"]')).toBeNull()
  })
})
