// @vitest-environment jsdom
/**
 * frontmatter 属性表（Obsidian 式）：类型图标、标签 pills、空值灰显。
 *
 * 标签面板与阅读视图正文顶部共用这一份（`PropertiesTable`）：同一份数据在两个地方
 * 长得不一样是最廉价的困惑，所以类型 → 图标的判据与值渲染只有这里一份。
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PropertiesTable, propertyIconFor } from '@/components/PropertiesTable'
import { openNote } from '@/app/actions'
import { MarkdownPreview } from '@/features/preview/MarkdownPreview'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter } from '@/ipc/mock-adapter'
import type { FrontmatterField } from '@/ipc/types'
import { useLinksStore } from '@/state/links-store'
import { useNoteStore } from '@/state/note-store'
import { useVaultStore } from '@/state/vault-store'

afterEach(() => {
  cleanup()
})

describe('propertyIconFor（类型 → 图标只有这一份）', () => {
  it('键名优先：date/datetime/tags 按 Obsidian 习惯', () => {
    expect(propertyIconFor('date', { kind: 'scalar', value: '2026-09-27' })).toBe('calendar')
    expect(propertyIconFor('datetime', { kind: 'scalar', value: 'x' })).toBe('clock')
    expect(propertyIconFor('created', { kind: 'scalar', value: 'x' })).toBe('clock')
    expect(propertyIconFor('created_at', { kind: 'scalar', value: 'x' })).toBe('clock')
    expect(propertyIconFor('tags', { kind: 'list', value: ['a'] })).toBe('tag')
    expect(propertyIconFor('TAGS', { kind: 'list', value: ['a'] })).toBe('tag')
  })

  it('其次看值形状：bool/number/list/标量', () => {
    expect(propertyIconFor('draft', { kind: 'bool', value: true })).toBe('check')
    expect(propertyIconFor('sources', { kind: 'number', value: '27' })).toBe('hash')
    expect(propertyIconFor('misc', { kind: 'list', value: ['a'] })).toBe('list')
    expect(propertyIconFor('title', { kind: 'scalar', value: '日报' })).toBe('type')
    expect(propertyIconFor('gone', { kind: 'null' })).toBe('type')
  })
})

describe('PropertiesTable（纯展示）', () => {
  const FIELDS: FrontmatterField[] = [
    { key: 'title', value: { kind: 'scalar', value: '信息日报' }, line: 2 },
    { key: 'date', value: { kind: 'scalar', value: '2026-09-27' }, line: 3 },
    { key: 'tags', value: { kind: 'list', value: ['技术', '方法'] }, line: 4 },
    { key: 'sources', value: { kind: 'number', value: '27' }, line: 5 },
    { key: 'draft', value: { kind: 'bool', value: false }, line: 6 },
    { key: 'gone', value: { kind: 'null' }, line: 7 },
  ]

  it('每行：图标 + 键 + 类型化值；空值灰显', () => {
    render(<PropertiesTable fields={FIELDS} />)
    expect(screen.getByText('信息日报')).not.toBeNull()
    expect(screen.getByText('2026-09-27')).not.toBeNull()
    expect(screen.getByText('27')).not.toBeNull()
    // 空值灰显（null）
    expect(screen.getByText('空')).not.toBeNull()
    // bool false 显示破折号（不是 true/false 英文）
    expect(screen.getByText('—')).not.toBeNull()
  })

  it('标签值渲染成 pills（只读，不可点）', () => {
    render(<PropertiesTable fields={FIELDS} />)
    const tech = screen.getByText('技术')
    const method = screen.getByText('方法')
    expect(tech.closest('button')).toBeNull()
    expect(method.closest('button')).toBeNull()
  })

  it('空数组什么都不渲染（调用方不用再判一次）', () => {
    const { container } = render(<PropertiesTable fields={[]} />)
    expect(container.innerHTML).toBe('')
  })

  it('一级映射渲染成 k/v 子行（OKF generated 这类）', () => {
    render(
      <PropertiesTable
        fields={[
          {
            key: 'generated',
            value: {
              kind: 'map',
              value: [
                { key: 'by', value: { kind: 'scalar', value: 'etl' }, line: 5 },
                { key: 'at', value: { kind: 'scalar', value: '2026-09-27' }, line: 6 },
              ],
            },
            line: 4,
          },
        ]}
      />,
    )
    expect(screen.getByText('generated')).not.toBeNull()
    expect(screen.getByText('etl')).not.toBeNull()
    expect(screen.getByText('2026-09-27')).not.toBeNull()
  })

  it('映射列表按组渲染（OKF verified/sources 这类）', () => {
    render(
      <PropertiesTable
        fields={[
          {
            key: 'verified',
            value: {
              kind: 'mapList',
              value: [
                [{ key: 'by', value: { kind: 'scalar', value: '人审' }, line: 5 }],
                [{ key: 'by', value: { kind: 'scalar', value: 'nightly' }, line: 6 }],
              ],
            },
            line: 4,
          },
        ]}
      />,
    )
    expect(screen.getByText('人审')).not.toBeNull()
    expect(screen.getByText('nightly')).not.toBeNull()
  })
})

describe('阅读视图正文顶部的属性块', () => {
  const NOTES = [
    {
      relPath: '笔记/日报.md',
      text: ['---', 'title: 信息日报', 'tags: [技术, 方法]', '---', '', '# 正文', ''].join('\n'),
    },
    { relPath: '笔记/素.md', text: '# 素\n\n没有 frontmatter。\n' },
  ]

  beforeEach(() => {
    setIpcAdapter(createMockAdapter({ notes: NOTES }))
    useNoteStore.getState().close()
    useLinksStore.getState().clear()
    useVaultStore.setState({ status: 'idle', info: null, entries: [], tree: [], selected: null })
  })

  it('有 frontmatter 的笔记：属性块出现在正文之前', async () => {
    render(<MarkdownPreview />)
    await act(async () => {
      await openNote('笔记/日报.md')
    })
    await waitFor(() => {
      expect(document.querySelector('.mn-props--note')).not.toBeNull()
    })
    const block = document.querySelector('.mn-props--note') as HTMLElement
    const body = document.querySelector('.mn-preview__body') as HTMLElement
    // 块在正文之前（DOM 顺序即视觉顺序）
    expect(block.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(block.textContent).toContain('信息日报')
    expect(block.textContent).toContain('技术')
  })

  it('没有 frontmatter 的笔记：不打多余的 IPC，也不多一块', async () => {
    render(<MarkdownPreview />)
    await act(async () => {
      await openNote('笔记/素.md')
    })
    await waitFor(() => {
      expect(document.querySelector('.mn-preview__body')).not.toBeNull()
    })
    expect(document.querySelector('.mn-props--note')).toBeNull()
  })
})
