// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { PropertyInput } from '@/features/editor/PropertyInput'

afterEach(cleanup)
function Tags() {
  const [value, setValue] = useState<unknown>(['技术', '观点'])
  return <PropertyInput name="tags" value={value} change={setValue} remove={() => {}} />
}
it('空输入框退格依次删除前一个标签，保留输入焦点', () => {
  render(<Tags />)
  const input = screen.getByLabelText('添加 tags 条目')
  input.focus()
  fireEvent.keyDown(input, { key: 'Backspace' })
  expect(screen.queryByText('观点')).toBeNull()
  expect(screen.getByText('技术')).toBeTruthy()
  expect(document.activeElement).toBe(input)
  fireEvent.keyDown(input, { key: 'Backspace' })
  expect(screen.queryByText('技术')).toBeNull()
  fireEvent.keyDown(input, { key: 'Backspace' })
})
it('有文字或正在使用输入法时退格不删除标签', () => {
  render(<Tags />)
  const input = screen.getByLabelText('添加 tags 条目')
  fireEvent.change(input, { target: { value: '新' } })
  fireEvent.keyDown(input, { key: 'Backspace' })
  expect(screen.getByText('观点')).toBeTruthy()
  fireEvent.change(input, { target: { value: '' } })
  fireEvent.keyDown(input, { key: 'Backspace', isComposing: true })
  expect(screen.getByText('观点')).toBeTruthy()
})
