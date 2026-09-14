// @vitest-environment jsdom
/**
 * 标签面板的**加/删标签**（frontmatter）集成测试。
 *
 * 这一层验三件事（Rust 侧的精确改写由 `cargo test -p mn-core` / `-p mimenote` 覆盖，
 * 真实二进制的落盘由 `e2e/real-app.e2e.test.ts` 覆盖）：
 *
 * 1. **面板交互**：frontmatter 标签能加能删、行内标签只读且有可读提示；
 * 2. **顺序约束**：脏状态下必须**先落盘**再改标签（否则随后那次自动保存会把标签覆盖掉）；
 * 3. **失败与冲突**：冲突走既有横幅那套语义（进 `conflict` 态），只读 Vault 时不改变界面状态。
 *
 * ⚠️ 一处刻意留给 E2E 的空白：jsdom 不实现"输入框里按回车提交表单"这条浏览器行为，
 * 这里只断言 `submit` 事件这条链路；真实的回车提交由应用层 E2E 用真键盘验。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { editCurrentNoteTags } from '@/app/actions'
import { ConflictBanner } from '@/features/status/ConflictBanner'
import { TagsPanel } from '@/features/tags/TagsPanel'
import { parseTagInput } from '@/features/tags/tag-input'
import { ipc, setIpcAdapter, type IpcAdapter } from '@/ipc/client'
import { createMockAdapter, type MockAdapter } from '@/ipc/mock-adapter'
import { MimenoteError } from '@/ipc/types'
import { useNoteStore } from '@/state/note-store'
import { useTagsStore } from '@/state/tags-store'
import { useToastStore } from '@/state/toast-store'
import { useVaultStore } from '@/state/vault-store'

const PLAIN = '---\ntitle: 甲\ntags: [旧]\ndraft: false\n---\n\n正文里的 #行内。\n'
const INLINE_ONLY = '# 只有正文\n\n正文里有 #行内。\n'
const BLOCK = '---\ntags:\n  - 甲\n  - 乙\n---\n正文\n'

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

/** 面板上的"×"（frontmatter 与行内标签都有，用同样的属性定位）。 */
function removeButton(tag: string): HTMLElement {
  return document.querySelector(`.mn-tags [data-tag-remove="${tag}"]`) as HTMLElement
}

async function openPanel(relPath: string): Promise<void> {
  const { openNote } = await import('@/app/actions')
  await openNote(relPath)
  useTagsStore.setState({ open: true })
  render(<TagsPanel />)
  await waitFor(() => {
    expect(document.querySelector('[data-tag]')).not.toBeNull()
  })
}

beforeEach(async () => {
  adapter = createMockAdapter({ notes: [{ relPath: '甲.md', text: PLAIN }] })
  setIpcAdapter(adapter)
  resetStores()
  await useVaultStore.getState().openVault('C:\\MockVault')
})

afterEach(() => {
  cleanup()
})

describe('输入框的解析规则', () => {
  it('逗号（半角/全角）分隔，空格不拆；空项与首尾空白被丢掉', () => {
    expect(parseTagInput('甲, 乙，丙')).toEqual(['甲', '乙', '丙'])
    expect(parseTagInput('中文 标签')).toEqual(['中文 标签'])
    expect(parseTagInput(',甲,,  ,乙,')).toEqual(['甲', '乙'])
    expect(parseTagInput('   ')).toEqual([])
    // 开头的 `#` 交给宿主清理（判同规则只有一份，在 Rust）
    expect(parseTagInput('#甲')).toEqual(['#甲'])
  })
})

describe('标签面板：加标签', () => {
  it('提交输入框 → frontmatter 真的多了这一项，其它内容一字不动', async () => {
    await openPanel('甲.md')

    const input = screen.getByLabelText('添加标签') as HTMLInputElement
    fireEvent.change(input, { target: { value: '新标签' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)

    await waitFor(() => {
      expect(textOf('甲.md')).toBe(
        '---\ntitle: 甲\ntags: [旧, 新标签]\ndraft: false\n---\n\n正文里的 #行内。\n',
      )
    })
    // 输入框清空（成功之后），面板与全库概览立刻跟上
    await waitFor(() => {
      expect(input.value).toBe('')
      expect(document.querySelector('.mn-tags [data-tag="新标签"]')).not.toBeNull()
    })
    const summaryKeys = [...document.querySelectorAll('[data-tag-key]')].map((node) =>
      node.getAttribute('data-tag-key'),
    )
    expect(summaryKeys).toContain('新标签')
  })

  it('一次可以加多个（逗号分隔），开头的 `#` 与多余空白都被清掉', async () => {
    await openPanel('甲.md')
    const input = screen.getByLabelText('添加标签')
    fireEvent.change(input, { target: { value: ' #父/子 , 带 空格 ' } })
    fireEvent.click(screen.getByText('添加'))

    await waitFor(() => {
      expect(textOf('甲.md')).toBe(
        "---\ntitle: 甲\ntags: [旧, 父/子, '带 空格']\ndraft: false\n---\n\n正文里的 #行内。\n",
      )
    })
    // 含空格的标签被引号保护后能原样读回来（面板上显示的就是它）
    await waitFor(() => {
      expect(document.querySelector('.mn-tags [data-tag="带 空格"]')).not.toBeNull()
    })
  })

  it('内存文本跟着磁盘走：编辑器里的正文与新令牌都对齐了（否则下次保存会覆盖标签）', async () => {
    await openPanel('甲.md')
    const before = useNoteStore.getState().doc
    const input = screen.getByLabelText('添加标签')
    fireEvent.change(input, { target: { value: '乙' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)

    await waitFor(() => {
      const state = useNoteStore.getState()
      expect(state.doc?.text).toContain('tags: [旧, 乙]')
      expect(state.doc?.revision).toBeGreaterThan(before?.revision ?? 0)
      expect(state.dirty).toBe(false)
      expect(state.doc?.baseMtimeMs).not.toBe(before?.baseMtimeMs)
    })
  })

  it('完全没有 frontmatter 的笔记：加标签会补出区块，正文一行都不被吞', async () => {
    adapter = createMockAdapter({ notes: [{ relPath: '裸.md', text: INLINE_ONLY }] })
    setIpcAdapter(adapter)
    await useVaultStore.getState().openVault('C:\\MockVault')
    await openPanel('裸.md')

    const input = screen.getByLabelText('添加标签')
    fireEvent.change(input, { target: { value: '新' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)

    await waitFor(() => {
      expect(textOf('裸.md')).toBe(`---\ntags: [新]\n---\n${INLINE_ONLY}`)
    })
    // 补出来的区块里只有这一个标签；正文里的行内标签照旧
    expect(document.querySelector('.mn-tags [data-tag="新"]')).not.toBeNull()
    expect(document.querySelector('.mn-tags [data-tag="行内"]')).not.toBeNull()
  })

  it('加一个已经存在的标签：不写盘、无意义 diff、给出"没有变化"的反馈', async () => {
    await openPanel('甲.md')
    const input = screen.getByLabelText('添加标签')
    // `#旧` 与 `旧` 归一化后是同一个标签
    fireEvent.change(input, { target: { value: '#旧' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)

    await waitFor(() => {
      expect(useToastStore.getState().toasts.some((item) => item.message === '没有变化')).toBe(true)
    })
    expect(textOf('甲.md')).toBe(PLAIN)
    // 失败/无变化时输入框保留用户输的字（不清空）
    expect((input as HTMLInputElement).value).toBe('#旧')
  })
})

describe('标签面板：删标签', () => {
  it('点 frontmatter 标签的 × → 磁盘上真的没了；面板与概览跟着变', async () => {
    await openPanel('甲.md')
    fireEvent.click(removeButton('旧'))

    await waitFor(() => {
      expect(textOf('甲.md')).toBe(
        '---\ntitle: 甲\ntags: []\ndraft: false\n---\n\n正文里的 #行内。\n',
      )
    })
    await waitFor(() => {
      expect(document.querySelector('.mn-tags [data-tag="旧"]')).toBeNull()
    })
    // 全库概览里也不再有这个标签（索引增量同步，不需要重扫）
    const summaryKeys = [...document.querySelectorAll('[data-tag-key]')].map((node) =>
      node.getAttribute('data-tag-key'),
    )
    expect(summaryKeys).not.toContain('旧')
    expect(summaryKeys).toContain('行内')
  })

  it('块数组删到一个不剩：只删项行、保留 `tags:` 字段（不删 key）', async () => {
    adapter = createMockAdapter({ notes: [{ relPath: '块.md', text: BLOCK }] })
    setIpcAdapter(adapter)
    await useVaultStore.getState().openVault('C:\\MockVault')
    await openPanel('块.md')

    fireEvent.click(removeButton('甲'))
    await waitFor(() => {
      expect(textOf('块.md')).toBe('---\ntags:\n  - 乙\n---\n正文\n')
    })
    fireEvent.click(removeButton('乙'))
    await waitFor(() => {
      expect(textOf('块.md')).toBe('---\ntags:\n---\n正文\n')
    })
  })

  it('行内标签：带「正文」角标，点 × 只给提示、一个字节都不写', async () => {
    await openPanel('甲.md')

    const chip = document.querySelector('.mn-tags [data-tag="行内"]')
    expect(chip?.getAttribute('data-tag-source')).toBe('inline')
    expect(chip?.textContent).toContain('正文')
    // 面板上有一句话解释"为什么删不掉"，而不是让用户对着一个坏掉的按钮发呆
    expect(document.querySelector('[data-tag-hint="inline-readonly"]')).not.toBeNull()

    fireEvent.click(removeButton('行内'))

    await waitFor(() => {
      expect(
        useToastStore.getState().toasts.some((item) => item.message === '这是正文里的标签'),
      ).toBe(true)
    })
    expect(textOf('甲.md')).toBe(PLAIN)
    expect(useNoteStore.getState().doc?.text).toBe(PLAIN.replace(/\r/g, ''))
    // 行内标签仍然在面板上（没有假装删掉）
    expect(document.querySelector('.mn-tags [data-tag="行内"]')).not.toBeNull()
  })
})

describe('顺序约束与失败降级', () => {
  it('脏状态下先落盘再改标签：未保存的正文与标签一起落盘', async () => {
    await openPanel('甲.md')
    useNoteStore.getState().setText('# 新正文\n\n还没保存的一段。\n')
    expect(useNoteStore.getState().dirty).toBe(true)

    const input = screen.getByLabelText('添加标签')
    fireEvent.change(input, { target: { value: '乙' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)

    await waitFor(() => {
      const onDisk = textOf('甲.md') ?? ''
      expect(onDisk).toContain('# 新正文')
      expect(onDisk).toContain('还没保存的一段。')
      // 落盘的正文里没有 frontmatter（用户把内容整段换掉了）→ 加标签会补一个区块出来
      expect(onDisk).toContain('---\ntags: [乙]\n---\n# 新正文')
    })
    expect(useNoteStore.getState().dirty).toBe(false)
    expect(useNoteStore.getState().doc?.text).toBe(textOf('甲.md'))
  })

  it('磁盘被外部改过 → CONFLICT：进既有冲突态（横幅出现），磁盘一个字节都不动', async () => {
    await openPanel('甲.md')
    const external = '---\ntitle: 甲\ntags: [外部改的]\n---\n别人写的正文。\n'
    adapter.simulateExternalEdit('甲.md', external)

    fireEvent.click(removeButton('旧'))

    await waitFor(() => {
      expect(useNoteStore.getState().conflict).not.toBeNull()
      expect(useNoteStore.getState().status).toBe('conflict')
    })
    // 绝不静默覆盖：外部那份原封不动
    expect(textOf('甲.md')).toBe(external)
    // 横幅就是既有那一条（同一套语义，不另发明提示）
    render(<ConflictBanner />)
    expect(screen.getByText(/已被外部修改/)).toBeDefined()
    // 本地没有未保存内容，不该凭空报 dirty（否则"关闭窗口"会问一句莫名其妙的话）
    expect(useNoteStore.getState().dirty).toBe(false)
  })

  it('写失败（只读 Vault）：界面状态不变、给一条可读错误，不假装成功', async () => {
    await openPanel('甲.md')
    const beforeDoc = useNoteStore.getState().doc

    // 只读 Vault：真实宿主会返回 IO（写入被系统拒绝），这里让适配器如实抛同一个错误
    const readOnly: IpcAdapter = {
      kind: 'mock',
      invoke: <T,>(method: string, args?: Record<string, unknown>): Promise<T> =>
        method === 'note_set_tags'
          ? Promise.reject(
              new MimenoteError({
                code: 'IO',
                message: '拒绝访问（Vault 只读）',
                detail: null,
                currentMtimeMs: null,
              }),
            )
          : adapter.invoke<T>(method, args),
    }
    setIpcAdapter(readOnly)

    const result = await editCurrentNoteTags({ add: ['乙'] })

    expect(result).toBeNull()
    expect(textOf('甲.md')).toBe(PLAIN)
    expect(useNoteStore.getState().doc?.text).toBe(beforeDoc?.text)
    expect(useNoteStore.getState().doc?.baseMtimeMs).toBe(beforeDoc?.baseMtimeMs)
    expect(useNoteStore.getState().conflict).toBeNull()
    const errors = useToastStore.getState().toasts.filter((item) => item.kind === 'error')
    expect(errors.length).toBe(1)
    // 面板上也没有多出那个标签（读盘重来还是旧的）
    expect(document.querySelector('.mn-tags [data-tag="乙"]')).toBeNull()
  })

  it('`tags` 与 `tag` 两个字段并存：只被 `tag:` 提供的那个删不掉，但会如实说明', async () => {
    const dual = '---\ntag: 单数\ntags: [甲]\n---\n正文\n'
    adapter = createMockAdapter({ notes: [{ relPath: '双.md', text: dual }] })
    setIpcAdapter(adapter)
    await useVaultStore.getState().openVault('C:\\MockVault')
    await openPanel('双.md')

    // 面板显示的是两个字段**合并**后的列表
    expect(document.querySelector('.mn-tags [data-tag="单数"]')).not.toBeNull()
    expect(document.querySelector('.mn-tags [data-tag="甲"]')).not.toBeNull()

    // 点 `单数` 的 ×：写入目标永远是 `tags`，所以它删不掉 —— 但必须说清楚为什么
    fireEvent.click(removeButton('单数'))
    await waitFor(() => {
      expect(
        useToastStore
          .getState()
          .toasts.some((item) => item.message === '有标签没能移除' && (item.detail ?? '').includes('tag: 字段')),
      ).toBe(true)
    })
    expect(textOf('双.md')).toBe(dual)
    expect(document.querySelector('.mn-tags [data-tag="单数"]')).not.toBeNull()

    // 加标签照常工作：结果写进 `tags`，不碰 `tag`
    const input = screen.getByLabelText('添加标签')
    fireEvent.change(input, { target: { value: '乙' } })
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    await waitFor(() => {
      expect(textOf('双.md')).toBe('---\ntag: 单数\ntags: [甲, 乙]\n---\n正文\n')
    })
    // `tags` 里的那个可以正常删掉，`tag:` 里的仍在
    fireEvent.click(removeButton('甲'))
    await waitFor(() => {
      expect(textOf('双.md')).toBe('---\ntag: 单数\ntags: [乙]\n---\n正文\n')
    })
  })

  it('没有打开的笔记时明确拒绝（不往"当前文档"以外的地方写）', async () => {
    useNoteStore.getState().close()
    const result = await editCurrentNoteTags({ add: ['乙'] })
    expect(result).toBeNull()
    expect(textOf('甲.md')).toBe(PLAIN)
    expect(useToastStore.getState().toasts.some((item) => item.kind === 'warn')).toBe(true)
  })
})

describe('IPC 契约', () => {
  it('note_set_tags 的返回形状与真实宿主一致（changed/tags/text）', async () => {
    // 令牌必须来自**读盘**的那一刻（与前端面板走的是同一条路）
    const content = await ipc.noteRead('甲.md')
    const outcome = await ipc.noteSetTags('甲.md', ['乙'], [], content.mtimeMs)
    expect(outcome.changed).toBe(true)
    expect(outcome.tags).toEqual(['旧', '乙'])
    expect(outcome.text).toBe(textOf('甲.md'))
    expect(outcome.sizeBytes).toBeGreaterThan(0)
    expect(outcome.mtimeMs).not.toBe(content.mtimeMs)
  })
})
