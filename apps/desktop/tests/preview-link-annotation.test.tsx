// @vitest-environment jsdom
/**
 * 阅读视图的链接补类名：**线性**查找，且与改造前逐条等价。
 *
 * 改造前的写法是"对每个 `a.mn-wikilink` 做 `outbound.find(...)`"，而 find 的回调里又调用
 * `normalizeLinkTarget` —— 两边都归一化，2000 条链接的笔记就是 2000×N 次字符串处理（每次渲染
 * 都做一遍二次方工作）。这里**计数而不是计时**：计时断言在 CI 上会抖，而调用次数是确定性事实。
 *
 * 计数靠 `vi.mock` 把归一化函数包一层（构造函数不是产品代码的一部分）。
 * 参考实现（下面第二组用例）用 `vi.importActual` 拿**未经包装**的那一份，
 * 免得把对照实现自己的调用也算进计数里。
 */

import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { openNote } from '@/app/actions'
import { MarkdownPreview } from '@/features/preview/MarkdownPreview'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter } from '@/ipc/mock-adapter'
import type { ResolvedLink } from '@/ipc/types'
import { useLinksStore } from '@/state/links-store'
import { useNoteStore } from '@/state/note-store'
import { useVaultStore } from '@/state/vault-store'

/** `normalizeLinkTarget` 被调用了多少次（`vi.hoisted`：mock 工厂会在 import 之前执行）。 */
const counter = vi.hoisted(() => ({ normalize: 0 }))

vi.mock('@/domain/links', async (importActual) => {
  const actual = await importActual<typeof import('@/domain/links')>()
  return {
    ...actual,
    normalizeLinkTarget: (raw: string): string => {
      counter.normalize += 1
      return actual.normalizeLinkTarget(raw)
    },
  }
})

function link(rawTarget: string, resolvedRelPath: string | null, ambiguous = false): ResolvedLink {
  return {
    kind: 'wiki',
    rawTarget,
    display: rawTarget,
    alias: null,
    anchor: null,
    line: 1,
    resolvedRelPath,
    ambiguous,
  }
}

function bodyOf(container: HTMLElement): HTMLElement {
  const body = container.querySelector('.mn-preview__body')
  if (body === null) throw new Error('预览正文还没挂上')
  return body as HTMLElement
}

/** 按 `data-target` 找那个链接元素（断言里的可读入口）。 */
function anchorOf(container: HTMLElement, target: string): HTMLAnchorElement {
  const found = Array.from(container.querySelectorAll('a.mn-wikilink')).find(
    (element) => element.getAttribute('data-target') === target,
  )
  if (found === undefined) throw new Error(`没有这个链接：${target}`)
  return found as HTMLAnchorElement
}

async function openWithLinks(text: string, outbound: ResolvedLink[]): Promise<HTMLElement> {
  setIpcAdapter(
    createMockAdapter({ notes: [{ relPath: '笔记/链接.md', text }] }),
  )
  await openNote('笔记/链接.md')
  // 出链表**在打开笔记之后**写入：`openNote` 会清空/刷新链接 store，
  // 先写会被覆盖掉（那会让用例测的是空表，而不是"按索引补类名"）
  useLinksStore.setState({
    links: { relPath: '笔记/链接.md', outbound, backlinks: [], unresolvedCount: 0 },
  })
  const { container } = render(<MarkdownPreview />)
  await waitFor(() => {
    expect(container.querySelector('.mn-preview__body')).not.toBeNull()
  })
  return container as HTMLElement
}

beforeEach(async () => {
  counter.normalize = 0
  useNoteStore.getState().close()
  useLinksStore.getState().clear()
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
  await useVaultStore.getState().openVault('C:\\MockVault')
})

afterEach(() => {
  cleanup()
})

describe('阅读视图的链接补类名', () => {
  it('2000 条链接的补类名不走二次方（计数，不靠计时）', async () => {
    const count = 2000
    const text = [
      '# 链接',
      '',
      ...Array.from({ length: count }, (_, index) => `见 [[目标${index}]]。`),
      '',
    ].join('\n')
    const outbound = Array.from({ length: count }, (_, index) =>
      link(`目标${index}`, `目标${index}.md`),
    )

    counter.normalize = 0
    const container = await openWithLinks(text, outbound)
    await waitFor(() => {
      expect(container.querySelectorAll('a.mn-wikilink')).toHaveLength(count)
    })

    // 线性：每条出链归一化一次（建表）+ 每个链接元素归一化一次（查表）
    const calls = counter.normalize
    expect(calls).toBeGreaterThanOrEqual(count * 2)
    // 上限放到两倍是给"effect 可能多跑一轮"留的余量。二次方的实现在这个规模下是
    // 2000×2000 ≈ 4×10⁶（find 逐条扫到命中为止也有 ~2×10⁶），差了三个数量级，
    // 这个断言因此既不抖、又能真正抓住回退。
    expect(calls).toBeLessThanOrEqual(count * 4)
  })

  it('已解析 / 悬空 / 歧义三种类名与 title 与从前逐条一致（含同一目标取第一次）', async () => {
    const text = [
      '# 链接',
      '',
      '见 [[存在的笔记]]。',
      '',
      '见 [[不存在的笔记]]。',
      '',
      '见 [[同名多篇]]。',
      '',
      '见 [[重复目标]]。',
      '',
      '见 [[大小写与扩展名.MD]]。',
      '',
    ].join('\n')
    const outbound: ResolvedLink[] = [
      link('存在的笔记', '存在的笔记.md'),
      link('同名多篇', '目录甲/同名多篇.md', true),
      // 同一目标出现两次：`Array.prototype.find` 命中的是**第一个**，
      // 归一化成 Map 时必须判重，否则后面的会覆盖前面的（行为就变了）
      link('重复目标.md', '第一处.md', true),
      link('重复目标', '第二处.md'),
      // 大小写与扩展名的归一化口径（与 Rust 侧一致）
      link('大小写与扩展名.md', '大小写与扩展名.md'),
    ]

    const container = await openWithLinks(text, outbound)
    const body = bodyOf(container)
    await waitFor(() => {
      expect(body.querySelectorAll('a.mn-wikilink')).toHaveLength(5)
    })

    // 参考实现：与改造前的写法**逐字一致**（O(L×M) 的 find + 两个 toggle + title 改写）
    const plain = await vi.importActual<typeof import('@/domain/links')>('@/domain/links')
    const elements = Array.from(body.querySelectorAll('a.mn-wikilink'))
    expect(elements).toHaveLength(5)
    for (const element of elements) {
      const key = plain.normalizeLinkTarget(element.getAttribute('data-target') ?? '')
      const match = outbound.find((item) => plain.normalizeLinkTarget(item.rawTarget) === key)
      const resolved = match?.resolvedRelPath ?? null

      expect(element.classList.contains('mn-wikilink--unresolved')).toBe(resolved === null)
      expect(element.classList.contains('mn-wikilink--ambiguous')).toBe(match?.ambiguous === true)
      expect(element.getAttribute('data-rel-path')).toBe(resolved)
      expect(element.getAttribute('title')).toBe(
        resolved === null
          ? `${element.getAttribute('data-target') ?? ''}（还不存在，点击创建）`
          : resolved,
      )
    }

    // 三种形态各钉一条（读起来比上面的循环更直观）
    const resolvedAnchor = anchorOf(container, '存在的笔记')
    expect(resolvedAnchor.getAttribute('data-rel-path')).toBe('存在的笔记.md')
    expect(resolvedAnchor.getAttribute('title')).toBe('存在的笔记.md')
    expect(resolvedAnchor.classList.contains('mn-wikilink--unresolved')).toBe(false)

    const dangling = anchorOf(container, '不存在的笔记')
    expect(dangling.hasAttribute('data-rel-path')).toBe(false)
    expect(dangling.classList.contains('mn-wikilink--unresolved')).toBe(true)
    expect(dangling.getAttribute('title')).toBe('不存在的笔记（还不存在，点击创建）')

    const ambiguous = anchorOf(container, '同名多篇')
    expect(ambiguous.classList.contains('mn-wikilink--ambiguous')).toBe(true)
    expect(ambiguous.getAttribute('data-rel-path')).toBe('目录甲/同名多篇.md')

    // 同一目标出现多次：路径与 ambiguous 都取**第一条**
    const repeated = anchorOf(container, '重复目标')
    expect(repeated.getAttribute('data-rel-path')).toBe('第一处.md')
    expect(repeated.classList.contains('mn-wikilink--ambiguous')).toBe(true)

    // 归一化（大小写 + `.md`）仍然能命中
    expect(anchorOf(container, '大小写与扩展名.MD').getAttribute('data-rel-path')).toBe(
      '大小写与扩展名.md',
    )
  })
})
