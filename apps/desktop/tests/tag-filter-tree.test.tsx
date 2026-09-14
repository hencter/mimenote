// @vitest-environment jsdom
/**
 * 标签过滤（文件树收窄视图）集成测试：**真实控件 + 真实文件树 + Mock 适配器**。
 *
 * 为什么要在 jsdom 里再测一遍（E2E 里也有一条）：这里能把几条**边界**摆出来
 * —— 命中为空、标签已被重命名、读取失败、重扫后自动重算 —— 它们靠点界面很难构造，
 * 却正是"树空着但界面不说为什么"最容易发生的几个位置。
 *
 * 夹具（`tags_list` / `tag_notes` 都从文本现算，Mock 是宿主标签索引的简化镜像）：
 *
 * | 笔记 | 标签 |
 * | --- | --- |
 * | `根笔记.md` | `#项目` |
 * | `项目/设计.md` | `#项目` |
 * | `项目/子项目/细节.md` | `项目/子项目`（frontmatter） |
 * | `日记/2025-01-01.md` | `#项目/进行中`、`#周记` |
 * | `无标签.md` | —— |
 * | `素材/说明.txt` | `#素材标签`（**非笔记**：Mock 抽标签不分扩展名，正好用来钉"过滤视图只收笔记"） |
 */

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openNote } from '@/app/actions'
import { FileTree } from '@/features/vault/FileTree'
import { TreeToolbar } from '@/features/vault/TreeToolbar'
import { ipc, setIpcAdapter } from '@/ipc/client'
import { createMockAdapter, type MockAdapter } from '@/ipc/mock-adapter'
import { useNoteStore } from '@/state/note-store'
import { useTagFilterStore } from '@/state/tag-filter-store'
import { useVaultStore } from '@/state/vault-store'

const NOTES = [
  { relPath: '根笔记.md', text: '# 根笔记\n\n#项目\n' },
  { relPath: '项目/设计.md', text: '# 设计\n\n#项目\n' },
  { relPath: '项目/子项目/细节.md', text: '---\ntags: [项目/子项目]\n---\n\n正文。\n' },
  { relPath: '日记/2025-01-01.md', text: '# 一月一日\n\n#项目/进行中 与 #周记\n' },
  { relPath: '无标签.md', text: '# 无标签\n\n普通正文，没有任何标签。\n' },
  { relPath: '素材/说明.txt', text: '纯文本附件，含 #素材标签。\n' },
]

const ALL_ROWS = [
  '项目',
  '项目/设计.md',
  '项目/子项目',
  '素材',
  '素材/说明.txt',
  '日记',
  '日记/2025-01-01.md',
  '根笔记.md',
  '无标签.md',
]

/** 「含子标签」开着时选 `#项目` 的可见集合：命中 4 篇 + 祖先目录。 */
const WITH_SUBTAGS = [
  '根笔记.md',
  '项目',
  '项目/设计.md',
  '项目/子项目',
  '项目/子项目/细节.md',
  '日记',
  '日记/2025-01-01.md',
]

/** 关掉「含子标签」：只剩直接写了 `#项目` 的两篇。 */
const WITHOUT_SUBTAGS = ['根笔记.md', '项目', '项目/设计.md']

let adapter: MockAdapter

function resetStores(): void {
  useNoteStore.getState().close()
  useTagFilterStore.setState({
    keys: [],
    includeSubtags: true,
    hits: [],
    hitsSignature: '',
    status: 'idle',
    error: null,
    summary: [],
    summaryStatus: 'idle',
    summaryError: null,
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
    lastRoot: null,
  })
}

/** 渲染"侧栏"的两半：工具栏（含标签过滤控件）+ 文件树。 */
function renderSidebar(): HTMLElement {
  const { container } = render(
    <>
      <TreeToolbar />
      <FileTree />
    </>,
  )
  return container
}

class TreeDom {
  constructor(private readonly root: HTMLElement) {}

  rows(): string[] {
    return [...this.root.querySelectorAll('.mn-tree-row')].map(
      (row) => row.getAttribute('data-rel-path') ?? '',
    )
  }

  text(selector: string): string | null {
    const node = this.root.querySelector(selector)
    return node === null ? null : (node.textContent ?? '')
  }

  has(selector: string): boolean {
    return this.root.querySelector(selector) !== null
  }

  /** 当前选中行的相对路径（没有选中项时为 `null`）。 */
  selectedPath(): string | null {
    return this.root.querySelector('.mn-tree-row--selected')?.getAttribute('data-rel-path') ?? null
  }

  node(selector: string): HTMLElement {
    const found = this.root.querySelector(selector)
    if (found === null) throw new Error(`界面上找不到：${selector}`)
    return found as HTMLElement
  }
}

/** 打开选择器（已经开着就不再点一次，否则会把浮层关掉）并点一个标签。 */
async function chooseTag(dom: TreeDom, key: string): Promise<void> {
  if (!dom.has('[data-tag-filter-popover]')) fireEvent.click(dom.node('[data-tag-filter-toggle]'))
  await waitFor(() => {
    expect(dom.has(`[data-tag-filter-option="${key}"]`)).toBe(true)
  })
  fireEvent.click(dom.node(`[data-tag-filter-option="${key}"]`))
}

/** 等可见行变成预期的集合（顺序无关；行序另有专门一条断言）。 */
async function expectRows(dom: TreeDom, expected: readonly string[]): Promise<void> {
  await waitFor(() => {
    expect([...dom.rows()].sort()).toEqual([...expected].sort())
  })
}

/**
 * 装一个"只有某条命令被替换掉"的适配器：其余命令仍走 Mock。
 *
 * 用来构造真实界面里很难点出来的边界 —— 宿主对这个标签返回空集、读取报错、
 * 标签概览读不到。返回 `null` 表示"这条命令不拦截，交给 Mock"。
 */
function useAdapterOverride(
  override: (method: string, args: Record<string, unknown> | undefined) => Promise<unknown> | null,
): void {
  const base = adapter
  setIpcAdapter({
    kind: 'test',
    invoke: (method: string, args?: Record<string, unknown>): Promise<never> => {
      const custom = override(method, args)
      if (custom !== null) return custom as Promise<never>
      return base.invoke(method, args) as Promise<never>
    },
  })
}

beforeEach(async () => {
  adapter = createMockAdapter({ notes: NOTES })
  setIpcAdapter(adapter)
  window.localStorage.clear()
  resetStores()
  await useVaultStore.getState().openVault('C:\\MockVault')
})

afterEach(() => {
  cleanup()
})

describe('默认状态：一个像素都不变', () => {
  it('没选标签时没有计数、没有选择器，行仍是全量（顶层目录展开）', async () => {
    const dom = new TreeDom(renderSidebar())
    await expectRows(dom, ALL_ROWS)
    expect(dom.has('[data-tag-filter-count]')).toBe(false)
    expect(dom.has('[data-tag-filter-popover]')).toBe(false)
    expect(dom.has('[data-tag-filter-hint]')).toBe(false)
    // 没有过滤时三角按真实展开状态走（顶层目录展开、二级没有）
    const sub = dom.node('[data-rel-path="项目/子项目"]')
    expect(sub.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('选一个标签：只留命中笔记与祖先目录', () => {
  it('命中笔记 + 祖先可见，兄弟目录/空目录/无标签笔记都不出现，顺序仍是父在子前', async () => {
    const dom = new TreeDom(renderSidebar())
    await chooseTag(dom, '项目')
    await expectRows(dom, WITH_SUBTAGS)

    // 祖先链：`日记`（命中笔记的父目录）在，`素材`（同样存在的空目录）不在
    expect(dom.rows()).toContain('日记')
    expect(dom.rows()).not.toContain('素材')
    // 非笔记的命中（`素材/说明.txt` 里写了 #素材标签）也不会把它带进来
    expect(dom.rows()).not.toContain('素材/说明.txt')
    expect(dom.rows()).not.toContain('无标签.md')

    // 父行仍在子行之前（祖先保留不改变树序）
    expect(dom.rows().indexOf('项目')).toBeLessThan(dom.rows().indexOf('项目/设计.md'))

    // 被过滤条件强制展开的目录，三角必须跟着说"展开"（否则界面自相矛盾）
    expect(dom.node('[data-rel-path="项目/子项目"]').getAttribute('aria-expanded')).toBe('true')
  })

  it('计数说清"只显示几篇中的几篇"，并且与可见行数一致', async () => {
    const dom = new TreeDom(renderSidebar())
    await chooseTag(dom, '项目')
    await expectRows(dom, WITH_SUBTAGS)
    // 4 篇命中 / 全库 5 篇 Markdown 笔记（`素材/说明.txt` 不算笔记）
    expect(dom.text('[data-tag-filter-count]')).toBe('仅显示 4/5 篇')
  })

  it('多选是并集（界面上也写着），不是交集', async () => {
    const dom = new TreeDom(renderSidebar())
    await chooseTag(dom, '项目')
    await expectRows(dom, WITH_SUBTAGS)
    // 关掉含子标签，再加一个 `#周记`（只有 `日记/2025-01-01.md` 有）
    fireEvent.click(dom.node('[data-tag-filter-subtags]'))
    await expectRows(dom, WITHOUT_SUBTAGS)
    await chooseTag(dom, '周记')

    // 并集：3 篇（交集会是 0 篇，那才是"看不出来是过滤坏了还是真没有"）
    await expectRows(dom, ['根笔记.md', '项目', '项目/设计.md', '日记', '日记/2025-01-01.md'])
    expect(dom.text('[data-tag-filter-count]')).toBe('仅显示 3/5 篇')
    // 语义写在界面上，不给用户猜的余地
    expect(dom.node('[data-tag-filter-hint]').getAttribute('data-tag-filter-hint')).toBe('or')
    expect(dom.text('[data-tag-filter-hint]')).toContain('任一')
  })
})

describe('层级标签：「含子标签」是一对一的开关', () => {
  it('默认包含子标签，关掉之后 `#项目/子项目` 与 `#项目/进行中` 都不算', async () => {
    const dom = new TreeDom(renderSidebar())
    await chooseTag(dom, '项目')
    await expectRows(dom, WITH_SUBTAGS)

    const toggle = dom.node('[data-tag-filter-subtags]')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(toggle.getAttribute('data-tag-filter-subtags')).toBe('on')
    // 有效果时必须说清"多算了几个子标签"
    expect(toggle.textContent).toContain('2')

    fireEvent.click(toggle)
    await expectRows(dom, WITHOUT_SUBTAGS)
    expect(dom.text('[data-tag-filter-count]')).toBe('仅显示 2/5 篇')
    expect(dom.node('[data-tag-filter-subtags]').getAttribute('data-tag-filter-subtags')).toBe('off')
  })

  it('选中键没有子标签时开关被禁用并说明原因（点了没反应比禁用更难懂）', async () => {
    const dom = new TreeDom(renderSidebar())
    await chooseTag(dom, '周记')
    await waitFor(() => {
      expect(dom.node('[data-rel-path="日记/2025-01-01.md"]')).not.toBeNull()
    })
    const toggle = dom.node('[data-tag-filter-subtags]') as HTMLButtonElement
    expect(toggle.disabled).toBe(true)
    expect(toggle.getAttribute('title')).toContain('没有子标签')
  })
})

describe('任何"树看起来不对"的情况都要有交代', () => {
  it('命中为空：空态与控件分别说明，而不是一片空白', async () => {
    // 让宿主对这个标签返回空集（等价于"这个标签下确实没有笔记"）
    useAdapterOverride((method) =>
      method === 'tag_notes' ? Promise.resolve({ key: '项目', notes: [] }) : null,
    )
    const dom = new TreeDom(renderSidebar())
    await chooseTag(dom, '项目')

    await waitFor(() => {
      expect(dom.text('[data-tag-filter-empty]')).toContain('没有笔记使用 #项目')
    })
    expect(dom.text('[data-tag-filter-count]')).toBe('仅显示 0/5 篇')
    expect(dom.has('[data-tag-filter-clear]')).toBe(true)
  })

  it('标签已经不在 Vault 里（被重命名/合并）：点名说出来，并给一条退路', async () => {
    const dom = new TreeDom(renderSidebar())
    // 先选一个真实存在的标签，再让它在标签概览里"消失"（模拟宿主侧刚被合并掉）
    useTagFilterStore.setState({ keys: ['项目'], includeSubtags: false })
    await useTagFilterStore.getState().reload()
    await expectRows(dom, WITHOUT_SUBTAGS)

    useTagFilterStore.setState({ summary: [], summaryStatus: 'ready' })
    await waitFor(() => {
      expect(dom.has('[data-tag-filter-missing="项目"]')).toBe(true)
    })
    expect(dom.text('[data-tag-filter-missing="项目"]')).toContain('已不在这个 Vault 里')
  })

  it('读取失败：不收窄（树上仍是全量）并说明原因 + 可重试', async () => {
    useAdapterOverride((method) =>
      method === 'tag_notes' ? Promise.reject(new Error('索引正在重建')) : null,
    )
    const dom = new TreeDom(renderSidebar())
    await chooseTag(dom, '项目')

    await waitFor(() => {
      expect(dom.has('[data-tag-filter-error]')).toBe(true)
    })
    // 关键：**不放行任何收窄** —— 宁可不过滤，也不给一个"少了几篇"的假收窄
    await expectRows(dom, ALL_ROWS)
    expect(dom.text('[data-tag-filter-count]')).toBe('过滤未生效')
  })

  it('读不到全库标签时说明「含子标签」这次没生效，而不是静默少算几篇', async () => {
    useAdapterOverride((method) =>
      method === 'tags_list' ? Promise.reject(new Error('索引还没就绪')) : null,
    )
    const dom = new TreeDom(renderSidebar())
    // 直接给出选择（正常路径上要能从选择器里点，而选择器本身就依赖这份概览）
    useTagFilterStore.setState({ keys: ['项目'] })
    await useTagFilterStore.getState().reload()

    // 层级展开拿不到键 → 只能按标签本身上报（`项目/子项目`、`项目/进行中` 暂时算不进来）
    await expectRows(dom, WITHOUT_SUBTAGS)
    await waitFor(() => {
      expect(dom.has('[data-tag-filter-subtags-degraded]')).toBe(true)
    })
    expect(dom.text('[data-tag-filter-subtags-degraded]')).toContain('含子标签')
  })

  it('当前打开的笔记不在结果里时提醒一句', async () => {
    const dom = new TreeDom(renderSidebar())
    await openNote('无标签.md')
    await chooseTag(dom, '项目')
    await expectRows(dom, WITH_SUBTAGS)
    await waitFor(() => {
      expect(dom.has('[data-tag-filter-open-hidden]')).toBe(true)
    })
    expect(dom.text('[data-tag-filter-open-hidden]')).toContain('无标签.md')
  })
})

describe('与条目表变化同步', () => {
  it('重扫之后命中集合自动重算（不然会留下指向已消失路径的静默错乱）', async () => {
    const dom = new TreeDom(renderSidebar())
    await chooseTag(dom, '项目')
    await expectRows(dom, WITH_SUBTAGS)

    // 给 `无标签.md` 写上 `#项目`（走宿主写路径），再重扫 —— 树与命中集合都该跟上
    const written = await ipc.noteWrite('无标签.md', '# 无标签\n\n现在有 #项目 了。\n', null)
    await useVaultStore.getState().rescan()

    await waitFor(() => {
      expect(dom.rows()).toContain('无标签.md')
    })
    expect(dom.text('[data-tag-filter-count]')).toBe('仅显示 5/5 篇')
    expect(written.mtimeMs).toBeGreaterThan(0)
  })
})

describe('键盘与清除', () => {
  it('方向键只在可见项之间走', async () => {
    const dom = new TreeDom(renderSidebar())
    await chooseTag(dom, '项目')
    await expectRows(dom, WITH_SUBTAGS)

    const tree = dom.node('.mn-tree')
    fireEvent.keyDown(tree, { key: 'ArrowDown' })
    const selected = dom.selectedPath()
    expect(selected).not.toBeNull()
    expect(WITH_SUBTAGS).toContain(selected)
  })

  it('Esc 回到全量（与控件上的「清除」同一条路径）', async () => {
    const dom = new TreeDom(renderSidebar())
    await chooseTag(dom, '项目')
    await expectRows(dom, WITH_SUBTAGS)

    fireEvent.keyDown(dom.node('.mn-tree'), { key: 'Escape' })
    await expectRows(dom, ALL_ROWS)
    expect(dom.has('[data-tag-filter-count]')).toBe(false)
    expect(useTagFilterStore.getState().keys).toEqual([])
  })

  it('「清除」按钮回到全量，且不会再自己过滤回来', async () => {
    const dom = new TreeDom(renderSidebar())
    await chooseTag(dom, '项目')
    await expectRows(dom, WITH_SUBTAGS)

    fireEvent.click(dom.node('[data-tag-filter-clear]'))
    await expectRows(dom, ALL_ROWS)
    expect(dom.has('[data-tag-filter-hint]')).toBe(false)
  })
})
