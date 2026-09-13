// @vitest-environment jsdom
/**
 * 编辑器里的**粘贴 / 拖入图片**：`features/editor/image-input.ts`（ADR-0013）。
 *
 * 这一层要证明四件在真实使用中立刻能感觉到的事：
 *
 * 1. 粘贴一张图 → 经过一次 `attachment_save` 落进 Vault，编辑器里出现**指向它的相对路径**；
 * 2. **文本粘贴一个字都不能变**：我们的处理器必须把没有文件的粘贴原样交回 CodeMirror
 *    （用户粘一行代码、一段表格，行为要和加这个功能之前完全一致）；
 * 3. 拖入非图片 → 明确拒绝 + 可读提示，而且**一个 IPC 都不发**（不是静默失败）；
 * 4. 设置里的"附件目录"真的被用上，插图之后 `dirty` 与保存流水线照常工作。
 *
 * 事件是真造的 `paste` / `drop`（`EditorView.domEventHandlers` 只认 CodeMirror 自己的分发链，
 * 直接调内部函数证明不了"接线接对了"）。`defaultPrevented` 就是"事件被吃掉了吗"的答案：
 * CodeMirror 的规则是"第一个返回 true 的处理器吃掉事件并 preventDefault"（见模块文档）。
 *
 * 唯一在 jsdom 里测不准的是**拖放坐标**（没有真实排版，`posAtCoords` 拿不到坐标）——
 * 落点规则因此放在最后一个用例里按纯函数测（`__testing.insertAttachmentBlock`）。
 */

import { undo } from '@codemirror/commands'
import { EditorView } from '@codemirror/view'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { bytesToBase64 } from '@/domain/attachments'
import { MarkdownEditor } from '@/features/editor/MarkdownEditor'
import { __testing } from '@/features/editor/image-input'
import { setIpcAdapter } from '@/ipc/client'
import type { AttachmentInput } from '@/ipc/types'
import { MOCK_VAULT_PATH, createMockAdapter, type MockAdapter } from '@/ipc/mock-adapter'
import { cancelAutosave, useNoteStore } from '@/state/note-store'
import { useSettingsStore } from '@/state/settings-store'
import { useToastStore } from '@/state/toast-store'
import { useVaultStore } from '@/state/vault-store'

/** 当前打开的笔记（在 `项目/` 下，因此附件链接必须带 `../`）。 */
const NOTE = '项目/设计.md'

/** 一张 1×1 PNG 的字节。 */
const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

interface RecordedCall {
  method: string
  args: Record<string, unknown>
}

let calls: RecordedCall[] = []
let mock: MockAdapter

/** 造一份"像真的"拖放/剪贴板载荷（jsdom 的 `DataTransfer` 造不出带文件的实例）。 */
function fakeTransfer(spec: { files?: File[]; text?: string }): DataTransfer {
  const files = spec.files ?? []
  return {
    files,
    items: [],
    types: files.length > 0 ? ['Files'] : ['text/plain'],
    getData: (type: string) => (type === 'text/plain' ? (spec.text ?? '') : ''),
  } as unknown as DataTransfer
}

function dispatchPaste(view: EditorView, transfer: DataTransfer): boolean {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: transfer })
  view.contentDOM.dispatchEvent(event)
  return event.defaultPrevented
}

function dispatchDrop(view: EditorView, transfer: DataTransfer): boolean {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: transfer })
  // `posAtCoords` 要读坐标；jsdom 没有排版，这里给 (0,0)（结果是 null 或文档开头，都能插）
  Object.defineProperty(event, 'clientX', { value: 0 })
  Object.defineProperty(event, 'clientY', { value: 0 })
  view.contentDOM.dispatchEvent(event)
  return event.defaultPrevented
}

function imageFile(name: string, type = 'image/png'): File {
  return new File([new Uint8Array(PNG_BYTES)], name, { type })
}

/** 从记录里取 `attachment_save` 的入参。 */
function attachmentArgs(): { dirRel: string; files: AttachmentInput[] } | null {
  const call = calls.find((item) => item.method === 'attachment_save')
  return call === undefined ? null : (call.args as { dirRel: string; files: AttachmentInput[] })
}

function toastsOf(kind: string): string[] {
  return useToastStore
    .getState()
    .toasts.filter((item) => item.kind === kind)
    .map((item) => `${item.message} ${item.detail ?? ''}`)
}

/** 挂载编辑器并返回 CodeMirror 实例。 */
async function mountEditor(): Promise<EditorView> {
  render(<MarkdownEditor />)
  await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())
  const content = document.querySelector<HTMLElement>('.cm-content')
  const view = content === null ? null : EditorView.findFromDOM(content)
  if (view === null) throw new Error('编辑器没有挂载成功')
  return view
}

const views: EditorView[] = []

beforeEach(async () => {
  calls = []
  mock = createMockAdapter()
  setIpcAdapter({
    kind: 'test',
    async invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
      calls.push({ method, args: args ?? {} })
      return mock.invoke<T>(method, args)
    },
  })

  useToastStore.getState().clear()
  useSettingsStore.getState().setAttachmentDir('附件')
  useNoteStore.getState().close()
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
  await useVaultStore.getState().openVault(MOCK_VAULT_PATH)
  await useNoteStore.getState().open(NOTE)
})

afterEach(() => {
  cancelAutosave()
  for (const view of views.splice(0)) view.destroy()
  cleanup()
  document.body.innerHTML = ''
  useNoteStore.getState().close()
  useToastStore.getState().clear()
})

describe('粘贴图片', () => {
  it('落到附件目录、插入相对当前笔记的链接，光标停在图片下面一行', async () => {
    const view = await mountEditor()
    views.push(view)
    const before = view.state.doc.toString()

    // 光标在文末（插入点由光标决定）
    view.dispatch({ selection: { anchor: view.state.doc.length } })
    expect(dispatchPaste(view, fakeTransfer({ files: [imageFile('屏幕截图 2025-01-01.png')] }))).toBe(
      true,
    )

    await waitFor(() => expect(view.state.doc.toString()).toContain('![]('))

    // 1) IPC 契约：附件目录 + 文件名 + 原始字节的 base64
    const args = attachmentArgs()
    expect(args?.dirRel).toBe('附件')
    expect(args?.files).toEqual([
      {
        name: '屏幕截图 2025-01-01.png',
        dataBase64: bytesToBase64(new Uint8Array(PNG_BYTES)),
      },
    ])

    // 2) 插入的链接是**相对当前笔记**的路径（`项目/设计.md` → `../附件/…`），
    //    空格按 Markdown 规则百分号编码（否则地址会在空格处被截断）
    expect(view.state.doc.toString()).toBe(
      `${before}![](\u002e\u002e/附件/屏幕截图%202025-01-01.png)\n`,
    )

    // 3) 光标在图片下面一行：Live Preview 只在"光标不在该行"时把标记换成图片，
    //    停在同一行用户就看不到刚粘进来的图（ADR-0009）
    const head = view.state.selection.main.head
    expect(view.state.doc.lineAt(head).text).toBe('')
    expect(view.state.doc.lineAt(head - 1).text).toContain('![](')

    // 4) 文件树的数据源（条目表）增量更新了，而且没有重扫整个 Vault
    const entry = useVaultStore.getState().entries.find((item) => item.relPath === '附件/屏幕截图 2025-01-01.png')
    expect(entry).toBeDefined()
    expect(entry?.sizeBytes).toBe(PNG_BYTES.length)
    expect(calls.some((call) => call.method === 'vault_snapshot')).toBe(false)
  })

  it('这次插入可以一次撤销掉（进撤销历史）', async () => {
    const view = await mountEditor()
    views.push(view)
    const before = view.state.doc.toString()

    dispatchPaste(view, fakeTransfer({ files: [imageFile('图.png')] }))
    await waitFor(() => expect(view.state.doc.toString()).not.toBe(before))

    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe(before)
  })

  it('通用名（image.png）换成带时间戳的名字，连续粘贴不会互相覆盖', async () => {
    const view = await mountEditor()
    views.push(view)

    dispatchPaste(view, fakeTransfer({ files: [imageFile('image.png')] }))
    await waitFor(() => expect(calls.filter((call) => call.method === 'attachment_save')).toHaveLength(1))
    // 第二次粘贴（同一秒内）同名 → 由宿主/Mock 去重成 ` 1`
    dispatchPaste(view, fakeTransfer({ files: [imageFile('image.png')] }))
    await waitFor(() => expect(calls.filter((call) => call.method === 'attachment_save')).toHaveLength(2))

    const saved = useVaultStore
      .getState()
      .entries.filter((item) => item.relPath.startsWith('附件/粘贴图片 '))
      .map((item) => item.relPath)
    expect(saved).toHaveLength(2)
    expect(saved[0]).not.toBe(saved[1])
    // 两张都真的进了文档
    expect(view.state.doc.toString().match(/!\[\]\(/g)).toHaveLength(2)
  })

  it('多张一起粘贴：一次 IPC 落盘多张，逐行插入', async () => {
    const view = await mountEditor()
    views.push(view)

    dispatchPaste(
      view,
      fakeTransfer({ files: [imageFile('甲.png'), imageFile('乙.png')] }),
    )
    await waitFor(() => expect(view.state.doc.toString()).toContain('乙'))

    expect(calls.filter((call) => call.method === 'attachment_save')).toHaveLength(1)
    expect(attachmentArgs()?.files.map((file) => file.name)).toEqual(['甲.png', '乙.png'])
    const doc = view.state.doc.toString()
    expect(doc).toContain('../附件/甲.png')
    expect(doc).toContain('../附件/乙.png')
  })
})

describe('粘贴文本：默认路径一个字都不能变', () => {
  it('纯文本粘贴不触发附件链路，仍然由 CodeMirror 自己插入', async () => {
    const view = await mountEditor()
    views.push(view)
    view.dispatch({ selection: { anchor: view.state.doc.length } })

    dispatchPaste(view, fakeTransfer({ text: 'hello 粘贴' }))

    await waitFor(() => expect(view.state.doc.toString()).toContain('hello 粘贴'))
    expect(calls.some((call) => call.method === 'attachment_save')).toBe(false)
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })

  it('剪贴板里既没有文件也没有文本：我们也不插手', async () => {
    const view = await mountEditor()
    views.push(view)
    const before = view.state.doc.toString()

    dispatchPaste(view, fakeTransfer({}))
    expect(view.state.doc.toString()).toBe(before)
    expect(calls.some((call) => call.method === 'attachment_save')).toBe(false)
  })
})

describe('拖入文件', () => {
  it('拖入图片走同一条链路（落盘 + 插入链接）', async () => {
    const view = await mountEditor()
    views.push(view)

    expect(dispatchDrop(view, fakeTransfer({ files: [imageFile('拖进来的图.png')] }))).toBe(true)

    await waitFor(() => expect(view.state.doc.toString()).toContain('![]('))
    expect(attachmentArgs()?.dirRel).toBe('附件')
    expect(view.state.doc.toString()).toContain('../附件/拖进来的图.png')
  })

  it('拖入非图片：明确拒绝并给可读提示，一个 IPC 都不发', async () => {
    const view = await mountEditor()
    views.push(view)
    const before = view.state.doc.toString()

    const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], '说明.pdf', {
      type: 'application/pdf',
    })
    // 仍然要**吃掉**事件：交给 CodeMirror 兜底的话它会把 PDF 的字节当文本读进来
    expect(dispatchDrop(view, fakeTransfer({ files: [pdf] }))).toBe(true)

    expect(view.state.doc.toString()).toBe(before)
    expect(calls.some((call) => call.method === 'attachment_save')).toBe(false)
    const errors = toastsOf('error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('只接受图片文件')
    expect(errors[0]).toContain('说明.pdf')
  })

  it('一批里混进非图片：整批拒绝（不允许"部分成功"的中间态）', async () => {
    const view = await mountEditor()
    views.push(view)

    const pdf = new File([new Uint8Array([0x25])], '附件.pdf', { type: 'application/pdf' })
    dispatchDrop(view, fakeTransfer({ files: [imageFile('好图.png'), pdf] }))

    expect(calls.some((call) => call.method === 'attachment_save')).toBe(false)
    expect(toastsOf('error')[0]).toContain('附件.pdf')
    expect(view.state.doc.toString()).not.toContain('好图.png')
  })

  it('粘贴非图片同样明确拒绝（截图工具之外的东西不该静默消失）', async () => {
    const view = await mountEditor()
    views.push(view)

    dispatchPaste(view, fakeTransfer({ files: [imageFile('剪贴板.bmp', 'image/tiff')] }))
    expect(calls.some((call) => call.method === 'attachment_save')).toBe(false)
    expect(toastsOf('error')[0]).toContain('只接受图片文件')
  })
})

describe('与设置的接线', () => {
  it('附件目录改成 assets 之后，图片就落到 assets/ 里', async () => {
    useSettingsStore.getState().setAttachmentDir('assets')
    const view = await mountEditor()
    views.push(view)

    dispatchPaste(view, fakeTransfer({ files: [imageFile('图.png')] }))
    await waitFor(() => expect(view.state.doc.toString()).toContain('![]('))

    expect(attachmentArgs()?.dirRel).toBe('assets')
    expect(view.state.doc.toString()).toContain('../assets/图.png')
    expect(useVaultStore.getState().entries.some((item) => item.relPath === 'assets/图.png')).toBe(true)
  })

  it('附件目录留空 = Vault 根目录', async () => {
    useSettingsStore.getState().setAttachmentDir('')
    const view = await mountEditor()
    views.push(view)

    dispatchPaste(view, fakeTransfer({ files: [imageFile('图.png')] }))
    await waitFor(() => expect(view.state.doc.toString()).toContain('![]('))

    expect(attachmentArgs()?.dirRel).toBe('')
    expect(view.state.doc.toString()).toContain('![](../图.png)')
  })
})

describe('插图之后的保存流水线', () => {
  it('插入即 dirty，保存后磁盘上的笔记里确实有这条链接', async () => {
    const view = await mountEditor()
    views.push(view)

    expect(useNoteStore.getState().dirty).toBe(false)
    dispatchPaste(view, fakeTransfer({ files: [imageFile('图.png')] }))
    await waitFor(() => expect(view.state.doc.toString()).toContain('![]('))
    expect(useNoteStore.getState().dirty).toBe(true)

    cancelAutosave()
    await useNoteStore.getState().saveNow()

    const onDisk = mock.dump().find((note) => note.relPath === NOTE)
    expect(onDisk?.text).toContain('![](../附件/图.png)')
    expect(useNoteStore.getState().dirty).toBe(false)
  })

  it('落盘失败时**不**往文档里插链接（不留指向不存在文件的引用）', async () => {
    setIpcAdapter({
      kind: 'test',
      async invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
        calls.push({ method, args: args ?? {} })
        if (method === 'attachment_save') {
          throw { code: 'TOO_LARGE', message: '图片太大', detail: null, currentMtimeMs: null }
        }
        return mock.invoke<T>(method, args)
      },
    })

    const view = await mountEditor()
    views.push(view)
    const before = view.state.doc.toString()

    dispatchPaste(view, fakeTransfer({ files: [imageFile('图.png')] }))
    await waitFor(() => expect(toastsOf('error').length).toBeGreaterThan(0))

    expect(view.state.doc.toString()).toBe(before)
    expect(toastsOf('error').join(' ')).toContain('图片太大')
  })
})

describe('从剪贴板 / 拖放载荷里取文件', () => {
  it('`files` 为空时退到 `items`（截图工具粘贴就是这种情况）', () => {
    const file = imageFile('blob')
    const transfer = {
      files: [],
      items: [
        { kind: 'file', getAsFile: () => file },
        { kind: 'string', getAsFile: () => null },
      ],
      types: ['Files'],
    } as unknown as DataTransfer

    expect(__testing.filesOf(transfer)).toEqual([file])
    expect(__testing.hasFiles(transfer)).toBe(true)
  })

  it('没有文件时返回空数组（调用方据此判定"这次不该我管"）', () => {
    expect(__testing.filesOf(fakeTransfer({ text: 'hi' }))).toEqual([])
    expect(__testing.filesOf(null)).toEqual([])
    expect(__testing.hasFiles(fakeTransfer({ text: 'hi' }))).toBe(false)
    expect(__testing.hasFiles(fakeTransfer({ files: [imageFile('图.png')] }))).toBe(true)
    expect(__testing.hasFiles(null)).toBe(false)
  })
})

describe('插入块的落点规则（jsdom 里没有排版，坐标相关的部分按纯函数测）', () => {
  it('独占一段 + 光标落到下一行；插在行中间时不会把原来那一行截断', async () => {
    const view = await mountEditor()
    views.push(view)
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '甲乙丙' } })

    __testing.insertAttachmentBlock(view, 1, '![](图.png)', 'input.drop')

    expect(view.state.doc.toString()).toBe('甲\n![](图.png)\n乙丙')
    expect(view.state.doc.lineAt(view.state.selection.main.head).text).toBe('乙丙')
  })

  it('已经独占一行的插入点不再补空行（不会多出空段）', async () => {
    const view = await mountEditor()
    views.push(view)
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '甲\n乙' } })

    __testing.insertAttachmentBlock(view, 2, '![](图.png)', 'input.paste')

    expect(view.state.doc.toString()).toBe('甲\n![](图.png)\n乙')
  })

  it('位置被夹在文档长度之内（异步落盘期间文档可能已被改短）', async () => {
    const view = await mountEditor()
    views.push(view)
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '甲' } })

    __testing.insertAttachmentBlock(view, 99, '![](图.png)', 'input.paste')
    expect(view.state.doc.toString()).toBe('甲\n![](图.png)\n')
  })
})
