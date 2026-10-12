// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { FrontmatterEditor } from '@/features/editor/FrontmatterEditor'
import { PropertyInput } from '@/features/editor/PropertyInput'
import { editMetadataField, metadataBlock, parseMetadata, replaceMetadata } from '@/domain/frontmatter-edit'
afterEach(cleanup)
it('键名可直接修改，保留值和注释，拒绝覆盖已有键', () => {
  let text = '---\n# keep\ntitle: old\nstatus: draft\n---\nBody'
  render(<FrontmatterEditor read={() => text} apply={(next) => { text = next }} onSourceMode={() => {}} />)
  fireEvent.change(screen.getByLabelText('title 的属性名'), { target: { value: 'name' } })
  fireEvent.blur(screen.getByLabelText('title 的属性名'))
  expect(parseMetadata(metadataBlock(text)!.source, 'yaml')).toEqual({ name: 'old', status: 'draft' })
  expect(text).toContain('# keep')
  fireEvent.change(screen.getByLabelText('name 的属性名'), { target: { value: 'status' } })
  fireEvent.blur(screen.getByLabelText('name 的属性名'))
  expect(parseMetadata(metadataBlock(text)!.source, 'yaml')).toEqual({ name: 'old', status: 'draft' })
  expect(screen.getByRole('alert')).toBeTruthy()
})
it('从属性图标拖拽排序后写回顺序并保留注释', () => {
  let text = '---\n# keep\ntitle: old\nstatus: draft\n---\nBody'
  render(<FrontmatterEditor read={() => text} apply={(next) => { text = next }} onSourceMode={() => {}} />)
  const transfer = { setData: () => {}, getData: () => 'status', types: ['application/x-mimenote-property'] }
  fireEvent.dragStart(screen.getByRole('combobox', { name: 'status 的属性类型' }).parentElement!, { dataTransfer: transfer })
  fireEvent.dragOver(screen.getByLabelText('title').closest('.mn-metadata__row')!, { dataTransfer: transfer })
  fireEvent.drop(screen.getByLabelText('title').closest('.mn-metadata__row')!, { dataTransfer: transfer })
  expect(Object.keys(parseMetadata(metadataBlock(text)!.source, 'yaml'))).toEqual(['status', 'title'])
  expect(text).toContain('# keep')
})
it('点击添加后出现空白行，填完自动写回而不需要确认', () => {
  let text = '---\ntitle: old\n---\nBody'
  render(<FrontmatterEditor read={() => text} apply={(next) => { text = next }} onSourceMode={() => {}} />)
  expect(screen.queryByLabelText('新属性名称')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '添加笔记属性' }))
  fireEvent.change(screen.getByLabelText('新属性名称'), { target: { value: 'status' } })
  fireEvent.blur(screen.getByLabelText('新属性名称'))
  fireEvent.change(screen.getByLabelText('status'), { target: { value: '草稿' } })
  fireEvent.blur(screen.getByLabelText('status'))
  expect(parseMetadata(metadataBlock(text)!.source, 'yaml').status).toBe('草稿')
})
it('带时区日期正确显示，失焦不改写时区或精度', () => {
  const change = vi.fn()
  render(<PropertyInput name="datetime" value="2026-09-24T02:30:00+08:00" change={change} remove={() => {}} />)
  const input = screen.getByLabelText('datetime') as HTMLInputElement
  expect(input.value).toBe('2026-09-24T02:30')
  fireEvent.blur(input)
  expect(change).not.toHaveBeenCalled()
  fireEvent.change(input, { target: { value: '2026-09-25T03:15' } })
  fireEvent.blur(input)
  expect(change).toHaveBeenCalledWith('2026-09-25T03:15+08:00')
})
it('属性字段直接写回并保留 YAML 注释；源码按钮切换原编辑器而非 textarea', () => {
  let text = '---\n# keep\ntitle: old\n---\nBody'
  const mode = vi.fn()
  render(<FrontmatterEditor read={() => text} apply={(next) => { text = next }} onSourceMode={mode} />)
  fireEvent.change(screen.getByLabelText('title'), { target: { value: 'new' } })
  fireEvent.blur(screen.getByLabelText('title'))
  expect(text).toContain('title: new')
  expect(text).toContain('# keep')
  expect(text.endsWith('Body')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '编辑源码' }))
  expect(mode).toHaveBeenCalledWith(true)
  expect(document.querySelector('textarea')).toBeNull()
  expect(screen.queryByText('应用属性')).toBeNull()
})
it('TOML 与 JSON 正确读写，保留 BOM、CRLF 和正文', () => {
  const text = '\uFEFF+++\r\ntitle = "old"\r\n+++\r\n正文\r\n'
  const block = metadataBlock(text)!
  expect(parseMetadata(block.source, block.format).title).toBe('old')
  const next = replaceMetadata(text, '{"title":"new","done":true}', 'json')
  expect(next.startsWith('\uFEFF;;;\r\n')).toBe(true)
  expect(next.endsWith('正文\r\n')).toBe(true)
  expect(parseMetadata(metadataBlock(next)!.source, 'json').done).toBe(true)
  expect(() => replaceMetadata(text, '{broken', 'json')).toThrow()
  expect(() => editMetadataField('# keep\ntitle="x"', 'toml', 'title', 'y')).toThrow()
})
