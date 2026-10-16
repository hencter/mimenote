// @vitest-environment jsdom
/**
 * 「从模板新建」对话框的集成测试（内存适配器，不需要 Tauri）。
 *
 * 断言的是整条链路真的走通：清单 → 选中 → 起名 → （有 `@prompt` 时第二步）→ 创建到
 * **磁盘上**（Mock Vault 的 `dump()` 是唯一事实来源），且展开结果与设计 02 的语义一致
 * （`@cursor` 被去掉、`@prompt` 的答案进了正文、`@today` 展开成日期）。
 *
 * 光标落点（`placeCaretWhenReady`）这里没有编辑器实例，它会在超时前静默放弃 ——
 * 那是它的既定行为（落点是增强），应用层 E2E 才验真光标位置。
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter, type MockAdapter } from '@/ipc/mock-adapter'
import { DEFAULT_TEMPLATES_DIR } from '@/state/settings-store'
import { useNoteStore } from '@/state/note-store'
import { useTemplateStore } from '@/state/template-store'
import { useToastStore } from '@/state/toast-store'
import { useVaultStore } from '@/state/vault-store'

import { TemplatePickerDialog } from '@/features/template/TemplatePickerDialog'

let adapter: MockAdapter

/** 磁盘上某篇笔记的正文（Mock 适配器里就是真相）。 */
function onDisk(relPath: string): string | undefined {
  return adapter.dump().find((note) => note.relPath === relPath)?.text
}

/** 磁盘上所有笔记的相对路径。 */
function diskPaths(): string[] {
  return adapter.dump().map((note) => note.relPath)
}

function toastTexts(kind: string): string[] {
  return useToastStore
    .getState()
    .toasts.filter((item) => item.kind === kind)
    .map((item) => `${item.message} ${item.detail ?? ''}`)
}

beforeEach(() => {
  adapter = createMockAdapter({
    notes: [
      { relPath: '.mimenote/templates/日记.md', text: '# @today\n\n@cursor' },
      { relPath: '.mimenote/templates/会议.md', text: '## @prompt=主题\n\n@prompt=参与者\n' },
    ],
  })
  setIpcAdapter(adapter)
  useToastStore.setState({ toasts: [] })
  useNoteStore.getState().closeAll()
  useVaultStore.setState({ info: null, entries: [], selected: null })
  useTemplateStore.setState({
    open: false,
    dir: DEFAULT_TEMPLATES_DIR,
    status: 'idle',
    templates: [],
    error: null,
    selected: null,
  })
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('从模板新建', () => {
  it('列出模板目录里的 `.md`，标题不含扩展名', async () => {
    render(<TemplatePickerDialog />)
    await act(async () => {
      await useTemplateStore.getState().openPicker()
    })

    const options = screen.getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual([
      '会议.mimenote/templates/会议.md',
      '日记.mimenote/templates/日记.md',
    ])
    // 标题框有默认值，关闭前不会建任何东西
    expect((screen.getByLabelText('新笔记标题') as HTMLInputElement).value).toBe('未命名笔记')
    expect(diskPaths()).not.toContain('未命名笔记.md')
  })

  it('没有 `@prompt`：选模板 → 起名 → 创建，`@today` 展开、`@cursor` 消失', async () => {
    render(<TemplatePickerDialog />)
    await act(async () => {
      await useTemplateStore.getState().openPicker()
    })

    fireEvent.click(screen.getByRole('option', { name: /日记/u }))
    fireEvent.change(screen.getByLabelText('新笔记标题'), { target: { value: '周报' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))

    await waitFor(() => {
      expect(onDisk('周报.md')).toBeDefined()
    })
    // `@cursor` 被去掉（它在模板末尾，留下的就是那个空行）；`@today` 是当天日期
    expect(onDisk('周报.md')).toMatch(/^# \d{4}-\d{2}-\d{2}\n\n$/u)
    // 关闭对话框 + 成功提示 + 笔记被打开
    await waitFor(() => {
      expect(useTemplateStore.getState().open).toBe(false)
    })
    expect(toastTexts('success').join(' ')).toContain('周报.md')
    expect(useNoteStore.getState().doc?.relPath).toBe('周报.md')
  })

  it('有 `@prompt`：先问完再创建，答案进正文', async () => {
    render(<TemplatePickerDialog />)
    await act(async () => {
      await useTemplateStore.getState().openPicker()
    })

    fireEvent.click(screen.getByRole('option', { name: /会议/u }))
    fireEvent.click(screen.getByRole('button', { name: '创建' }))

    // 第二步：按标签渲染输入框（标签就是问题）
    const subject = await screen.findByLabelText('主题')
    const attendee = screen.getByLabelText('参与者')
    expect(onDisk('未命名笔记.md')).toBeUndefined() // 还没创建

    fireEvent.change(subject, { target: { value: '周会' } })
    fireEvent.change(attendee, { target: { value: '甲、乙' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))

    await waitFor(() => {
      expect(onDisk('未命名笔记.md')).toBe('## 周会\n\n甲、乙\n')
    })
    expect(useNoteStore.getState().doc?.relPath).toBe('未命名笔记.md')
  })

  it('第二步可以退回第一步，且什么都没创建', async () => {
    render(<TemplatePickerDialog />)
    await act(async () => {
      await useTemplateStore.getState().openPicker()
    })

    fireEvent.click(screen.getByRole('option', { name: /会议/u }))
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    await screen.findByLabelText('主题')

    fireEvent.click(screen.getByRole('button', { name: '上一步' }))
    // 回到第一步：标题框又在（`getByLabelText` 找不到会直接抛）
    expect(screen.getByLabelText('新笔记标题')).toBeTruthy()
    expect(diskPaths().filter((path) => !path.startsWith('.mimenote/'))).toEqual([])
  })

  it('取消：关闭对话框，一个文件都不建', async () => {
    render(<TemplatePickerDialog />)
    await act(async () => {
      await useTemplateStore.getState().openPicker()
    })

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => {
      expect(useTemplateStore.getState().open).toBe(false)
    })
    expect(diskPaths().filter((path) => !path.startsWith('.mimenote/'))).toEqual([])
  })

  it('空目录：说清"去哪儿放文件"，而不是报错', async () => {
    setIpcAdapter(createMockAdapter({ notes: [] }))
    render(<TemplatePickerDialog />)
    await act(async () => {
      await useTemplateStore.getState().openPicker()
    })

    expect(screen.queryAllByRole('option')).toEqual([])
    expect(screen.getByText(/还没有模板/u)).toBeTruthy()
    expect((screen.getByRole('button', { name: '创建' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
