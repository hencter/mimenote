// @vitest-environment jsdom
/**
 * 标签**重命名 / 合并**（全库改写）的集成测试。
 *
 * 这一层验的是"界面上能不能看懂会发生什么、以及结果有没有被如实说出来"
 * （Rust 侧的精确改写由 `cargo test -p mn-core` / `-p mimenote` 覆盖，
 * 真实二进制的落盘由 `e2e/real-app.e2e.test.ts` 覆盖）：
 *
 * 1. **三段式**：输入新名字 → 预览"这会改 N 篇笔记"（不落盘）→ 确认 → 汇报结果；
 * 2. **改的是全库**：frontmatter 与**正文行内** `#标签` 一起改，代码块/行内代码里的不动；
 * 3. **合并去重**：同一篇里两个标签都有时，结果不出现重复项；
 * 4. **跳过必须说出来**：宿主报"有 N 篇没改（为什么、怎么办）"时，界面不许只报成功；
 * 5. **键盘**：`Esc` 取消、`Enter` 走主按钮。
 */

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { renameTag } from '@/app/actions'
import { TagRenameDialog } from '@/features/tags/TagRenameDialog'
import {
  describeSkipReason,
  editDetail,
  groupSkips,
  previewSentence,
  resultSentence,
  skipAdvice,
} from '@/features/tags/tag-rename'
import { TagsPanel } from '@/features/tags/TagsPanel'
import { ipc, setIpcAdapter, type IpcAdapter } from '@/ipc/client'
import { createMockAdapter, type MockAdapter } from '@/ipc/mock-adapter'
import { MimenoteError } from '@/ipc/types'
import type { TagRenameOutcome } from '@/ipc/types'
import { useNoteStore } from '@/state/note-store'
import { useTagsStore } from '@/state/tags-store'
import { useToastStore } from '@/state/toast-store'
import { useVaultStore } from '@/state/vault-store'

const FRONTMATTER = '---\ntitle: 甲\ntags: [旧, 别的]\ndraft: false\n---\n\n正文里的 #旧 与 #别的。\n'
const CODE = '```\n#旧\n```\n\n`#旧` 与正文的 #旧\n'
const MERGE = '---\ntags: [甲, 乙]\n---\n\n正文 #甲 与 #乙。\n'

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
}

/** 打开某个标签的重命名对话框（走面板上那个 `✎`，而不是直接渲染组件）。 */
function openRenameDialog(tag: string): void {
  const button = document.querySelector(`[data-tag-rename-open="${tag}"]`) as HTMLElement
  expect(button, `面板上应当有 ${tag} 的重命名入口`).not.toBeNull()
  fireEvent.click(button)
  expect(document.querySelector('[data-tag-rename-dialog]')).not.toBeNull()
}

function typeName(value: string): HTMLInputElement {
  const input = document.querySelector('[data-tag-rename-input]') as HTMLInputElement
  fireEvent.change(input, { target: { value } })
  return input
}

beforeEach(async () => {
  adapter = createMockAdapter({
    notes: [
      { relPath: '甲.md', text: FRONTMATTER },
      { relPath: '目录/乙.md', text: '---\ntag: 旧\n---\n\n#旧 收尾\n' },
    ],
  })
  setIpcAdapter(adapter)
  resetStores()
  await useVaultStore.getState().openVault('C:\\MockVault')
})

afterEach(() => {
  cleanup()
})

describe('入口与键盘', () => {
  it('面板上每个标签都有「重命名 / 合并」入口，点开是对话框而不是直接改写', async () => {
    await openPanel('甲.md')
    openRenameDialog('旧')
    // 只是打开了对话框：磁盘一个字都没动
    expect(textOf('甲.md')).toBe(FRONTMATTER)
    expect(document.querySelector('[data-tag-rename-preview]')).toBeNull()
  })

  it('Esc 取消：对话框关掉、磁盘一个字节都不动', async () => {
    await openPanel('甲.md')
    openRenameDialog('旧')
    typeName('新')

    fireEvent.keyDown(window, { key: 'Escape' })

    await waitFor(() => {
      expect(document.querySelector('[data-tag-rename-dialog]')).toBeNull()
    })
    expect(textOf('甲.md')).toBe(FRONTMATTER)
  })

  it('输入框里回车 = 预览改动（不需要去找按钮）', async () => {
    await openPanel('甲.md')
    openRenameDialog('旧')
    const input = typeName('新')
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(document.querySelector('[data-tag-rename-preview]')).not.toBeNull()
    })
  })
})

describe('先查询再确认，再执行', () => {
  it('预览说出"这会改 N 篇"，此时不落盘；确认之后 frontmatter 与正文一起改', async () => {
    await openPanel('甲.md')
    openRenameDialog('旧')
    typeName('新')
    fireEvent.click(document.querySelector('[data-tag-rename-preview-button]') as HTMLElement)

    await waitFor(() => {
      expect(document.querySelector('[data-tag-rename-preview]')?.textContent).toContain(
        '这会改 2 篇笔记',
      )
    })
    // 预演绝不落盘
    expect(textOf('甲.md')).toBe(FRONTMATTER)
    expect(textOf('目录/乙.md')).toBe('---\ntag: 旧\n---\n\n#旧 收尾\n')

    fireEvent.click(document.querySelector('[data-tag-rename-confirm]') as HTMLElement)

    await waitFor(() => {
      expect(document.querySelector('[data-tag-rename-result]')).not.toBeNull()
    })
    // 全库真的改了：frontmatter（两个字段都算）与正文行内标签
    expect(textOf('甲.md')).toBe(
      '---\ntitle: 甲\ntags: [新, 别的]\ndraft: false\n---\n\n正文里的 #新 与 #别的。\n',
    )
    expect(textOf('目录/乙.md')).toBe('---\ntag: 新\n---\n\n#新 收尾\n')
    expect(document.querySelector('[data-tag-rename-result]')?.textContent).toContain('改了 2 篇笔记')
    // 逐篇明细（哪一篇改了几处）
    expect(document.querySelector('[data-tag-rename-file="甲.md"]')).not.toBeNull()
    expect(document.querySelector('[data-tag-rename-file="目录/乙.md"]')).not.toBeNull()
  })

  it('改完之后面板与全库概览跟着刷新（复用索引增量路径，不重扫）', async () => {
    await openPanel('甲.md')
    openRenameDialog('旧')
    typeName('新')
    fireEvent.click(document.querySelector('[data-tag-rename-preview-button]') as HTMLElement)
    await waitFor(() => {
      expect(document.querySelector('[data-tag-rename-confirm]')).not.toBeNull()
    })
    fireEvent.click(document.querySelector('[data-tag-rename-confirm]') as HTMLElement)

    await waitFor(() => {
      expect(document.querySelector('.mn-tags [data-tag="新"]')).not.toBeNull()
    })
    expect(document.querySelector('.mn-tags [data-tag="旧"]')).toBeNull()
    const keys = [...document.querySelectorAll('[data-tag-key]')].map((node) =>
      node.getAttribute('data-tag-key'),
    )
    expect(keys).toContain('新')
    expect(keys).not.toContain('旧')
  })

  it('「返回修改」回到输入阶段：预演结果清掉，可以换个名字再来一次', async () => {
    await openPanel('甲.md')
    openRenameDialog('旧')
    typeName('临时')
    fireEvent.click(document.querySelector('[data-tag-rename-preview-button]') as HTMLElement)
    await waitFor(() => {
      expect(document.querySelector('[data-tag-rename-preview]')).not.toBeNull()
    })

    fireEvent.click(document.querySelector('[data-tag-rename-back]') as HTMLElement)
    expect(document.querySelector('[data-tag-rename-preview]')).toBeNull()
    const input = document.querySelector('[data-tag-rename-input]') as HTMLInputElement
    expect(input.value).toBe('临时')
    expect(textOf('甲.md')).toBe(FRONTMATTER)
  })

  it('名字与旧标签相同时如实说明"只会统一写法"，并且不会真的写盘', async () => {
    await openPanel('甲.md')
    openRenameDialog('旧')
    typeName('旧')
    expect(document.querySelector('[data-tag-rename-same-key]')).not.toBeNull()

    fireEvent.click(document.querySelector('[data-tag-rename-preview-button]') as HTMLElement)
    await waitFor(() => {
      expect(document.querySelector('[data-tag-rename-preview]')?.textContent).toContain(
        '不会改动任何文件',
      )
    })
    expect(textOf('甲.md')).toBe(FRONTMATTER)
  })
})

describe('改写的边界（Mock 镜像与 Rust 同一条纪律）', () => {
  it('代码块与行内代码里的 `#旧` 一个都不动，正文里的才改', async () => {
    adapter = createMockAdapter({ notes: [{ relPath: '码.md', text: CODE }] })
    setIpcAdapter(adapter)
    await useVaultStore.getState().openVault('C:\\MockVault')

    const outcome = await ipc.tagRename('旧', '新', { dryRun: false })

    expect(outcome?.edited.length).toBe(1)
    expect(outcome?.inlineEdits).toBe(1)
    expect(textOf('码.md')).toBe('```\n#旧\n```\n\n`#旧` 与正文的 #新\n')
  })

  it('合并：同一篇里两个标签都有时不留重复项（frontmatter 列表与正文提及都算）', async () => {
    adapter = createMockAdapter({ notes: [{ relPath: '合.md', text: MERGE }] })
    setIpcAdapter(adapter)
    await useVaultStore.getState().openVault('C:\\MockVault')

    const outcome = await ipc.tagRename('甲', '乙', { dryRun: false })

    expect(textOf('合.md')).toBe('---\ntags: [乙]\n---\n\n正文 与 #乙。\n')
    expect(outcome?.inlineRemoved).toBe(1)
    expect(outcome?.frontmatterEdits).toBe(2)
  })

  it('层级：连同子标签一起改（`旧/子` → `新/子`），关掉开关就只改整条等于旧标签的', async () => {
    const text = '---\ntags: [旧, 旧/子]\n---\n\n#旧 与 #旧/子\n'
    adapter = createMockAdapter({ notes: [{ relPath: '层.md', text }] })
    setIpcAdapter(adapter)
    await useVaultStore.getState().openVault('C:\\MockVault')

    await ipc.tagRename('旧', '新', { dryRun: false, includeChildren: true })
    expect(textOf('层.md')).toBe('---\ntags: [新, 新/子]\n---\n\n#新 与 #新/子\n')

    // 再来一次时不带子标签：`新/子` 留在原地（改的只是 `新` 本身 → 早已改完）
    const again = await ipc.tagRename('新', '新2', { dryRun: false, includeChildren: false })
    expect(textOf('层.md')).toBe('---\ntags: [新2, 新/子]\n---\n\n#新2 与 #新/子\n')
    expect(again?.inlineEdits).toBe(1)
  })

  it('重试是幂等的：已经改过的文件不会被改第二遍', async () => {
    await openPanel('甲.md')
    const first = await renameTag('旧', '新', { dryRun: false })
    expect(first?.edited.length).toBe(2)
    const after = textOf('甲.md')

    const second = await renameTag('旧', '新', { dryRun: false })
    expect(second?.edited.length).toBe(0)
    expect(textOf('甲.md')).toBe(after)
  })

  it('空名字明确拒绝（不发请求、不动任何文件）', async () => {
    const result = await renameTag('旧', '   ')
    expect(result).toBeNull()
    expect(textOf('甲.md')).toBe(FRONTMATTER)
    expect(useToastStore.getState().toasts.some((item) => item.kind === 'warn')).toBe(true)
  })
})

describe('如实汇报"没改的那些"', () => {
  /** 一个只会返回"有 2 篇没改"的宿主：界面必须把人话讲清楚，而不是装作成功。 */
  function adapterWithSkips(outcome: TagRenameOutcome): IpcAdapter {
    return {
      kind: 'mock',
      invoke: <T,>(method: string): Promise<T> =>
        method === 'tag_rename'
          ? Promise.resolve(outcome as T)
          : adapter.invoke<T>(method),
    }
  }

  const skippedOutcome: TagRenameOutcome = {
    from: '旧',
    to: '新',
    fromDisplay: '旧',
    toDisplay: '新',
    includeChildren: true,
    dryRun: false,
    candidates: 5,
    edited: [{ relPath: '甲.md', frontmatterEdits: 1, inlineEdits: 1, inlineRemoved: 0 }],
    skipped: [
      { relPath: '外.md', reason: 'external-change', message: '磁盘被外部改动，请重试' },
      { relPath: '只读.md', reason: 'write-failed', message: '写入失败：拒绝访问' },
    ],
    unchanged: 2,
    frontmatterEdits: 1,
    inlineEdits: 1,
    inlineRemoved: 0,
    elapsedMs: 12,
  }

  it('对话框逐组说明"有 N 篇没改（为什么）—— 怎么办"', async () => {
    setIpcAdapter(adapterWithSkips({ ...skippedOutcome, dryRun: true }))
    render(<TagRenameDialog tag="旧" tagKey="旧" count={5} onClose={() => {}} />)
    typeName('新')
    fireEvent.click(document.querySelector('[data-tag-rename-preview-button]') as HTMLElement)
    await waitFor(() => {
      expect(document.querySelector('[data-tag-rename-preview]')).not.toBeNull()
    })

    setIpcAdapter(adapterWithSkips(skippedOutcome))
    fireEvent.click(document.querySelector('[data-tag-rename-confirm]') as HTMLElement)

    await waitFor(() => {
      expect(document.querySelector('[data-tag-rename-skip="external-change"]')).not.toBeNull()
    })
    const body = document.querySelector('[data-tag-rename-result]')?.textContent ?? ''
    expect(body).toContain('改了 1 篇笔记，2 篇没改')
    expect(body).toContain('磁盘被外部改动')
    expect(body).toContain('请重试')
    expect(body).toContain('写入失败')
    // 重试入口也要说清（幂等：已经改过的不再改第二遍）
    expect(document.querySelector('[data-tag-rename-retry-advice]')?.textContent).toContain(
      '不会被改第二遍',
    )
  })

  it('有跳过时给的是警示提示，而不是成功提示（不许"部分成功却报告成功"）', async () => {
    setIpcAdapter(adapterWithSkips(skippedOutcome))
    const outcome = await renameTag('旧', '新', { dryRun: false })

    expect(outcome?.skipped.length).toBe(2)
    const toasts = useToastStore.getState().toasts
    expect(
      toasts.some((item) => item.kind === 'warn' && item.message === '标签改名未全部完成'),
    ).toBe(true)
    const message = toasts.find((item) => item.kind === 'warn')?.detail ?? ''
    expect(message).toContain('2 篇没改')
    expect(message).toContain('请重试')
    expect(toasts.some((item) => item.message === '已重命名标签')).toBe(false)
  })

  it('宿主报错（例如索引还没就绪）→ 一条错误提示，界面状态不变', async () => {
    const failing: IpcAdapter = {
      kind: 'mock',
      invoke: <T,>(method: string): Promise<T> =>
        method === 'tag_rename'
          ? Promise.reject(
              new MimenoteError({
                code: 'IO',
                message: '标签索引正在构建，请稍后重试',
                detail: null,
                currentMtimeMs: null,
              }),
            )
          : adapter.invoke<T>(method),
    }
    setIpcAdapter(failing)

    expect(await renameTag('旧', '新', { dryRun: true })).toBeNull()
    const errors = useToastStore.getState().toasts.filter((item) => item.kind === 'error')
    expect(errors.length).toBe(1)
    expect(textOf('甲.md')).toBe(FRONTMATTER)
  })
})

describe('文案是纯函数，逐条钉住', () => {
  const base: TagRenameOutcome = {
    from: '旧',
    to: '新',
    fromDisplay: '旧',
    toDisplay: '新',
    includeChildren: true,
    dryRun: false,
    candidates: 0,
    edited: [],
    skipped: [],
    unchanged: 0,
    frontmatterEdits: 0,
    inlineEdits: 0,
    inlineRemoved: 0,
    elapsedMs: 3,
  }

  it('原因与建议各有一句话（不出现错误码）', () => {
    expect(describeSkipReason('external-change')).toBe('磁盘被外部改动')
    expect(describeSkipReason('unreadable')).toBe('读不到这个文件')
    expect(describeSkipReason('write-failed')).toBe('写入失败')
    expect(skipAdvice('external-change')).toContain('请重试')
    expect(skipAdvice('write-failed')).toContain('只读')
  })

  it('分组按固定顺序，每组带文件清单', () => {
    const groups = groupSkips([
      { relPath: 'b.md', reason: 'write-failed', message: '' },
      { relPath: 'a.md', reason: 'external-change', message: '' },
      { relPath: 'c.md', reason: 'external-change', message: '' },
    ])
    expect(groups.map((group) => group.reason)).toEqual(['external-change', 'write-failed'])
    expect(groups[0]?.files).toEqual(['a.md', 'c.md'])
    expect(groups[1]?.files).toEqual(['b.md'])
  })

  it('预演与结果各有一句人话（含"一篇都没有"）', () => {
    expect(previewSentence(base)).toContain('没有笔记用到这个标签')
    expect(previewSentence({ ...base, candidates: 2 })).toContain('不会改动任何文件')
    expect(
      previewSentence({
        ...base,
        edited: [{ relPath: 'x.md', frontmatterEdits: 1, inlineEdits: 0, inlineRemoved: 0 }],
      }),
    ).toBe('这会改 1 篇笔记')

    expect(resultSentence(base)).toBe('没有笔记需要改动')
    expect(
      resultSentence({
        ...base,
        edited: [{ relPath: 'x.md', frontmatterEdits: 1, inlineEdits: 2, inlineRemoved: 0 }],
        skipped: [{ relPath: 'y.md', reason: 'external-change', message: '' }],
      }),
    ).toBe('改了 1 篇笔记，1 篇没改（1 篇磁盘被外部改动）')
    expect(
      editDetail({ ...base, frontmatterEdits: 3, inlineEdits: 4, inlineRemoved: 1 }),
    ).toBe('frontmatter 3 处 · 正文行内 4 处 · 合并去掉重复 1 处')
  })
})
