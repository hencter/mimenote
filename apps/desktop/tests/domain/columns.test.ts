/**
 * 分栏文件树的列模型（`domain/columns.ts`）。
 *
 * 判据只有这些：列链怎么由**焦点目录**（+ 选中项）推导、每列只列直接子项、
 * 过滤/标签过滤怎么收窄、以及"这里绝不排序"（顺序必须原样来自 `TreeNode.children`
 * —— 排序的唯一真源在 `vault-store` 建树时的 `makeEntryComparator`）。
 *
 * 边界特意全都点名：空 Vault、只有根一层、深层目录、焦点目录被删掉、文本过滤生效、
 * 标签过滤生效、选中项不在条目表里。
 */

import { describe, expect, it } from 'vitest'

import {
  arrowLeftTarget,
  columnViewOf,
  columnsFor,
  directoryChainFor,
  directoryPathsOf,
  drillTarget,
  firstDirectoryIndex,
  revealTargetIn,
  rowsFor,
  siblingRowTarget,
} from '@/domain/columns'
import { buildTree, type TreeNode } from '@/domain/tree'
import { makeEntry } from '@/ipc/client'
import type { EntryMeta } from '@/ipc/types'

/**
 * 树：`README.md` + `附件/` + `项目/`（含 `项目/子项目/细节.md`）+ `日记/`。
 *
 * ⚠️ **不要对这个文件的兄弟顺序下断言**：`buildTree` 按 `entries()` 的输入顺序建
 * `children`，只有 `roots` 会被 `sortTree` 排序（所以根那一层的顺序与输入不同）。
 * 本文件要钉的是"取行时不动 `children` 的顺序"，因此一律拿 `tree()` 的 `children`
 * 当基准，而不是手写一份期望顺序。
 */
function entries(): EntryMeta[] {
  return [
    makeEntry({ relPath: '附件', isDir: true }),
    makeEntry({ relPath: '项目', isDir: true }),
    makeEntry({ relPath: '项目/子项目', isDir: true }),
    makeEntry({ relPath: '项目/设计.md' }),
    makeEntry({ relPath: '项目/子项目/细节.md' }),
    makeEntry({ relPath: '日记', isDir: true }),
    makeEntry({ relPath: '日记/2025-01-01.md' }),
    makeEntry({ relPath: 'README.md' }),
  ]
}

const tree = (list: EntryMeta[] = entries()): TreeNode[] => buildTree(list)

const paths = (nodes: readonly TreeNode[]): string[] => nodes.map((node) => node.entry.relPath)

describe('directoryChainFor：列链 = 焦点目录的祖先链', () => {
  it('没有焦点、没有选中项时只有 Vault 根一列', () => {
    expect(directoryChainFor(tree(), null)).toEqual([''])
  })

  it('焦点目录自己就是最后一列（它的内容显示在那一列里）', () => {
    expect(directoryChainFor(tree(), '项目/子项目')).toEqual(['', '项目', '项目/子项目'])
  })

  it('没有焦点时按选中项的父目录推导（打开笔记后回到它所在的那一列）', () => {
    expect(directoryChainFor(tree(), null, '项目/子项目/细节.md')).toEqual([
      '',
      '项目',
      '项目/子项目',
    ])
  })

  it('选中的是目录且没有焦点：链到它的父目录（它作为一行出现在末列里）', () => {
    expect(directoryChainFor(tree(), null, '项目')).toEqual([''])
  })

  it('空 Vault 没有列（连根那一列也没有）', () => {
    expect(directoryChainFor([], null)).toEqual([])
    expect(directoryChainFor([], '', 'README.md')).toEqual([])
  })

  it('焦点目录已不在条目表里 → 退回选中项的父目录', () => {
    expect(directoryChainFor(tree(), '项目/已删除', '项目/设计.md')).toEqual(['', '项目'])
    // 连选中项也没有（空焦点 + 无选中）→ 退回根
    expect(directoryChainFor(tree(), '项目/已删除', null)).toEqual([''])
  })

  it('祖先链中间断了一级 → 在断点处停下，宁可少一列', () => {
    // `项目/子项目` 不在条目表里（被 ignore 规则漏掉）⇒ `domain/tree` 把它的子项提升为根节点
    const list = entries().filter((entry) => entry.relPath !== '项目/子项目')
    expect(directoryChainFor(buildTree(list), '项目/子项目')).toEqual([''])
  })
})

describe('columnsFor：列链 + 每列直接子项', () => {
  it('焦点列是选中项所在的目录：activeIndex 指向它，选中项在其中高亮', () => {
    const view = columnsFor({ tree: tree(), selected: '项目/设计.md', focus: null })
    expect(view.directories).toEqual(['', '项目'])
    expect(view.columns.map((column) => column.path)).toEqual(['', '项目'])
    // 顺序 = `TreeNode.children` 的顺序（拿树本身当基准：本文件不断言排序口径）
    expect(paths(view.columns[0]!.rows)).toEqual(paths(tree()))
    const project = tree().find((node) => node.entry.relPath === '项目')!
    expect(paths(view.columns[1]!.rows)).toEqual(paths(project.children))
    expect(view.activeIndex).toBe(1)
    expect(view.focusAccepted).toBe(true)
  })

  it('推进到一个目录之后：末列变成它的内容，焦点列也跟着换过去', () => {
    const view = columnsFor({ tree: tree(), selected: '项目', focus: '项目' })
    expect(view.directories).toEqual(['', '项目'])
    // 被点的目录在**根那一列**里仍然高亮着，而 `↑/↓` 作用在末列（它刚打开的内容）
    expect(view.activeIndex).toBe(1)
    expect(paths(view.columns[1]!.rows)).toContain('项目/设计.md')
  })

  it('焦点被显式给到深层目录时，列链一路铺到它', () => {
    const view = columnsFor({ tree: tree(), selected: '项目', focus: '项目/子项目' })
    expect(view.directories).toEqual(['', '项目', '项目/子项目'])
    expect(paths(view.columns[2]!.rows)).toEqual(['项目/子项目/细节.md'])
  })

  it('空 Vault：一列都没有（空态由界面画，不由这里画一列空壳）', () => {
    const view = columnsFor({ tree: [], selected: null, focus: null })
    expect(view.columns).toEqual([])
    expect(view.activeIndex).toBe(-1)
  })

  it('每列只列直接子项：深层笔记不会被拉平到根那一列（与单栏 flattenTree 的差别）', () => {
    const view = columnsFor({ tree: tree(), selected: '项目/子项目/细节.md', focus: null })
    const root = paths(view.columns[0]!.rows)
    expect(root).not.toContain('项目/子项目')
    expect(root).not.toContain('项目/子项目/细节.md')
    expect(paths(view.columns[2]!.rows)).toEqual(['项目/子项目/细节.md'])
  })

  it('顺序原样来自 children：这里一行排序逻辑都没有', () => {
    const view = columnsFor({ tree: tree(), selected: 'README.md', focus: null })
    expect(paths(view.columns[0]!.rows)).toEqual(paths(tree()))
  })

  it('选中项不在条目表里（刚删掉/刚重扫）：退回根一列，不崩', () => {
    const view = columnsFor({ tree: tree(), selected: '不存在的目录/笔记.md', focus: null })
    expect(view.columns.map((column) => column.path)).toEqual([''])
    expect(view.activeIndex).toBe(0)
  })

  it('焦点不合法时 focusAccepted 为假，界面据此把回退值写回持久化', () => {
    const view = columnsFor({ tree: tree(), selected: null, focus: '已经没有了' })
    expect(view.directories).toEqual([''])
    expect(view.focusAccepted).toBe(false)
    expect(columnsFor({ tree: tree(), selected: null, focus: '' }).focusAccepted).toBe(true)
  })
})

describe('过滤：文本 ∩ 标签，逐列收窄', () => {
  it('文本过滤按子串匹配（复用 matchesFilter 的口径：名称或 relPath）', () => {
    const view = columnsFor({ tree: tree(), selected: '项目/设计.md', focus: null, filter: '设计' })
    // 根那一列空了：分栏**不**像 `flattenTree` 那样把命中的祖先目录拉进行里
    // （层级由"哪一列"表达）—— 但列链本身还在，所以路径仍然一直看得见
    expect(paths(view.columns[0]!.rows)).toEqual([])
    expect(paths(view.columns[1]!.rows)).toEqual(['项目/设计.md'])
    // 被过滤掉的行要如实报出来，界面才好说"这一列还有 N 项被挡住了"
    expect(view.columns[0]!.truncated).toBe(true)
    expect(view.columns[1]!.truncated).toBe(true)
  })

  it('过滤词两端空白与大小写不敏感（与 flattenTree 同一条口径）', () => {
    const view = columnsFor({ tree: tree(), selected: null, focus: null, filter: '  README  ' })
    expect(paths(view.columns[0]!.rows)).toEqual(['README.md'])
  })

  it('标签过滤只留可见路径（Set 成员判定，不重算命中）', () => {
    const view = columnsFor({
      tree: tree(),
      selected: '项目/设计.md',
      focus: null,
      visiblePaths: new Set(['项目/设计.md', '项目']),
    })
    expect(paths(view.columns[0]!.rows)).toEqual(['项目'])
    expect(paths(view.columns[1]!.rows)).toEqual(['项目/设计.md'])
  })

  it('文本过滤与标签过滤同时生效 = 交集', () => {
    const view = columnsFor({
      tree: tree(),
      selected: '项目/设计.md',
      focus: null,
      filter: '设',
      visiblePaths: new Set(['项目/设计.md', '项目', '项目/子项目/细节.md']),
    })
    // 根列：`项目` 命中标签但 `设` 匹配不上它（名称"项目"、路径"项目"）→ 空
    expect(paths(view.columns[0]!.rows)).toEqual([])
    // 项目列：`子项目` 在标签集合里，但文本过滤掉；`设计.md` 两个条件都过
    expect(paths(view.columns[1]!.rows)).toEqual(['项目/设计.md'])
  })

  it('标签过滤收窄后列链**仍在**（祖先路径一直看得见）', () => {
    const view = columnsFor({
      tree: tree(),
      selected: '项目/子项目/细节.md',
      focus: null,
      visiblePaths: new Set(['项目/子项目/细节.md', '项目/子项目', '项目']),
    })
    expect(view.directories).toEqual(['', '项目', '项目/子项目'])
    expect(paths(view.columns[2]!.rows)).toEqual(['项目/子项目/细节.md'])
  })

  it('空目录也返回一列（列的位置稳定，不因为空而左移）', () => {
    const view = columnsFor({ tree: tree(), selected: '附件/图片.png', focus: null })
    expect(view.columns).toHaveLength(2)
    expect(view.columns[1]!.rows).toEqual([])
    expect(view.columns[1]!.truncated).toBe(false)
  })
})

describe('rowsFor / columnViewOf：单列级的纯函数', () => {
  const project = tree().find((node) => node.entry.relPath === '项目')!
  const children = project.children

  it('没有过滤时原样返回（同一个引用 —— 少一次数组分配）', () => {
    expect(rowsFor(children)).toBe(children)
    expect(rowsFor(children, { filter: '   ' })).toBe(children)
    expect(rowsFor(children, { visiblePaths: null })).toBe(children)
  })

  it('truncated 只在真的有行被挡掉时为真', () => {
    const map = new Map([['项目', children]])
    expect(columnViewOf('项目', map).truncated).toBe(false)
    expect(columnViewOf('项目', map, { filter: '设计' }).truncated).toBe(true)
    // 空目录：0 行被挡（不是"被过滤光"）
    expect(columnViewOf('空目录', map).truncated).toBe(false)
  })

  it('10k 条目的 Vault 上只算得出可见的那几列（不把整棵树铺成行）', () => {
    // 结构性的性能判据：列只由"焦点目录"的祖先链决定。整棵树有 200 个目录、
    // 每个 50 篇笔记（10 200 条目），但这里只应出现 2 列、行数也只有这两列的子项数。
    // **刻意不做耗时断言** —— 时间在 CI 上是噪声，这里钉的是"算出来的东西与 Vault
    // 有多大无关"这个形状。
    const big = buildTree(
      Array.from({ length: 200 }, (_, index) => [
        makeEntry({ relPath: `目录${index}`, isDir: true }),
        ...Array.from({ length: 50 }, (_, file) =>
          makeEntry({ relPath: `目录${index}/笔记${file}.md` }),
        ),
      ]).flat(),
    )
    const view = columnsFor({ tree: big, selected: '目录7/笔记3.md', focus: '目录7' })
    expect(view.directories).toEqual(['', '目录7'])
    expect(view.columns[0]!.rows).toHaveLength(200)
    expect(view.columns[1]!.rows).toHaveLength(50)
  })
})

describe('导航辅助', () => {
  const root = tree()
  const view = columnsFor({ tree: root, selected: 'README.md', focus: null })

  it('siblingRowTarget 在焦点列内上下走；不在这一列里时从第一/最后一行起步', () => {
    const column = view.columns[0]!
    const list = paths(column.rows)
    const first = list[0]!
    const last = list[list.length - 1]!
    // 挑一个**不在两端**的行来验证"上下走"（`README.md` 恰好是最后一行）
    const middle = list[1]!
    expect(siblingRowTarget(column, middle, 'down')).toBe(list[2])
    expect(siblingRowTarget(column, middle, 'up')).toBe(first)
    // 不在这一列里（刚推进一列）：从两头起步
    expect(siblingRowTarget(column, '别处', 'down')).toBe(first)
    expect(siblingRowTarget(column, '别处', 'up')).toBe(last)
    // 边界：走完了就给 null（跨列是 `←/→` 的事）
    expect(siblingRowTarget(column, last, 'down')).toBeNull()
    expect(siblingRowTarget(column, first, 'up')).toBeNull()
  })

  it('drillTarget 只认**在条目表里**的目录', () => {
    const dirs = directoryPathsOf(root)
    const project = root.find((node) => node.entry.relPath === '项目')
    const readme = root.find((node) => node.entry.relPath === 'README.md')
    expect(drillTarget(project?.entry, dirs)).toBe('项目')
    expect(drillTarget(readme?.entry, dirs)).toBeNull() // 文件：走"打开笔记"那一支
    expect(drillTarget(undefined, dirs)).toBeNull()
    // 不在条目表里的目录（刚创建）：无操作，而不是把焦点设到一个不存在的地方
    expect(drillTarget(makeEntry({ relPath: '刚建的', isDir: true }), dirs)).toBeNull()
  })

  it('arrowLeftTarget 只在有上一级时给目标', () => {
    expect(arrowLeftTarget('项目/子项目')).toBe('项目')
    expect(arrowLeftTarget('项目')).toBe('')
    expect(arrowLeftTarget('')).toBeNull()
  })

  it('firstDirectoryIndex 找本列第一个目录', () => {
    expect(firstDirectoryIndex(view.columns[0]!.rows)).toBe(0)
    expect(firstDirectoryIndex([])).toBe(-1)
  })

  it('revealTargetIn 取最右那个包含该行的列', () => {
    const deep = columnsFor({ tree: root, selected: '项目/子项目/细节.md', focus: null })
    expect(revealTargetIn(deep.columns, '项目/子项目/细节.md')).toEqual({
      columnIndex: deep.columns.length - 1,
      rowIndex: 0,
    })
    // `目录` 这一级的路径**会**同时出现在"父列"与"它自己那一列"里（列 = 目录，行 = 它的子项），
    // 所以"取最右"是必须的语义：滚到用户此刻正在看的那一列
    expect(revealTargetIn(deep.columns, '项目')).toEqual({
      columnIndex: 0,
      rowIndex: paths(deep.columns[0]!.rows).indexOf('项目'),
    })
  })

  it('revealTargetIn 找不到时给 null（不滚到一个随机位置）', () => {
    expect(revealTargetIn(view.columns, '项目/子项目/细节.md')).toBeNull()
  })
})
