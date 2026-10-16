/**
 * 文件树：构建、排序、过滤、展开/折叠、祖先路径。
 *
 * 排序说明：目录优先，同类按 `Intl.Collator('zh-Hans-CN', { numeric: true })`。
 * 中文名按拼音排序（附件 < 日记 < 项目），汉字与拉丁字母的**相对**顺序由 ICU 决定，
 * 因此这里只断言拼音之间的顺序，以及 ASCII 名称之间的自然序。
 */

import { describe, expect, it } from 'vitest'

import { makeEntry } from '@/ipc/client'
import type { EntryMeta } from '@/ipc/types'
import {
  DEFAULT_TREE_SORT,
  ancestorsOf,
  buildTree,
  collectDirectoryPaths,
  compareEntries,
  countNodes,
  flattenTree,
  isTreeSort,
  makeEntryComparator,
  matchesFilter,
} from '@/domain/tree'

const entries: EntryMeta[] = [
  makeEntry({ relPath: 'notes', isDir: true }),
  makeEntry({ relPath: 'notes/2025', isDir: true }),
  makeEntry({ relPath: 'notes/2025/01.md' }),
  makeEntry({ relPath: 'notes/beta.md' }),
  makeEntry({ relPath: 'notes/Alpha.md' }),
  makeEntry({ relPath: 'assets', isDir: true }),
  makeEntry({ relPath: 'assets/1.png' }),
  makeEntry({ relPath: 'README.md' }),
]

describe('compareEntries', () => {
  it('目录优先于文件', () => {
    const sorted = [...entries].sort(compareEntries)
    const firstFileIndex = sorted.findIndex((entry) => !entry.isDir)
    const lastDirIndex = sorted.map((entry) => entry.isDir).lastIndexOf(true)
    expect(lastDirIndex).toBeLessThan(firstFileIndex)
  })

  it('同类按名称自然序、忽略大小写', () => {
    const children = entries
      .filter((entry) => {
        if (entry.isDir || !entry.relPath.startsWith('notes/')) return false
        return !entry.relPath.slice('notes/'.length).includes('/')
      })
      .sort(compareEntries)
      .map((entry) => entry.relPath)
    expect(children).toEqual(['notes/Alpha.md', 'notes/beta.md'])
  })

  it('数字按自然序而非字典序', () => {
    const files = [makeEntry({ relPath: 'n10.md' }), makeEntry({ relPath: 'n2.md' })]
    expect(files.sort(compareEntries).map((entry) => entry.relPath)).toEqual(['n2.md', 'n10.md'])
  })

  it('中文目录按拼音排序', () => {
    const dirs = [
      makeEntry({ relPath: '项目', isDir: true }),
      makeEntry({ relPath: '附件', isDir: true }),
      makeEntry({ relPath: '日记', isDir: true }),
    ]
    expect(dirs.sort(compareEntries).map((entry) => entry.relPath)).toEqual([
      '附件',
      '日记',
      '项目',
    ])
  })
})

describe('makeEntryComparator（可配置排序）', () => {
  it('默认配置的比较器与 compareEntries 逐点一致（默认行为不得变）', () => {
    const made = makeEntryComparator(DEFAULT_TREE_SORT)
    // 两两比较全排列：任何一对输入下两个比较器都必须给出同号结果
    for (const a of entries) {
      for (const b of entries) {
        expect(Math.sign(made(a, b)), `${a.relPath} vs ${b.relPath}`).toBe(
          Math.sign(compareEntries(a, b)),
        )
      }
    }
  })

  it('名称降序：只翻转主键，目录仍在最前', () => {
    const files = [makeEntry({ relPath: 'a.md' }), makeEntry({ relPath: 'b.md' })]
    const sorted = files.sort(
      makeEntryComparator({ by: 'name', direction: 'desc', foldersFirst: true }),
    )
    expect(sorted.map((entry) => entry.relPath)).toEqual(['b.md', 'a.md'])

    const mixed = [
      makeEntry({ relPath: 'a.md' }),
      makeEntry({ relPath: 'z目录', isDir: true }),
      makeEntry({ relPath: 'b.md' }),
    ]
    const result = mixed.sort(
      makeEntryComparator({ by: 'name', direction: 'desc', foldersFirst: true }),
    )
    expect(result.map((entry) => entry.relPath)).toEqual(['z目录', 'b.md', 'a.md'])
  })

  it('修改时间：升序/降序都按 mtimeMs，null（目录/附件）恒在最后', () => {
    // 注意不能用 makeEntry 构造 null mtime（它把 null 归一成 0）——这里手工造条目
    const entry = (relPath: string, mtimeMs: number | null, isDir = false): EntryMeta => ({
      relPath,
      name: relPath.split('/').pop() ?? relPath,
      isDir,
      sizeBytes: 0,
      mtimeMs,
      ext: isDir ? null : (relPath.split('.').pop() ?? null),
    })
    const list = (): EntryMeta[] => [
      entry('old.md', 100),
      entry('dir', null, true),
      entry('new.md', 300),
      entry('mid.md', 200),
      entry('asset.png', null),
    ]
    const comparator = (direction: 'asc' | 'desc') =>
      // 关掉"目录在前"才能真正考验 null 的落点（否则目录被 foldersFirst 提前拦走）
      makeEntryComparator({ by: 'mtime', direction, foldersFirst: false })

    const asc = list().sort(comparator('asc')).map((item) => item.relPath)
    expect(asc.slice(0, 3)).toEqual(['old.md', 'mid.md', 'new.md'])
    // 两个 null 之间的相对顺序走名称兜底，而 CJK/拉丁的相对序由 ICU 决定 —— 只断言"都在最后"
    expect([...asc.slice(3)].sort()).toEqual(['asset.png', 'dir'].sort())

    // 降序：时间倒排，但 null 仍然在最后 —— "没有修改时间"不等于"最新"
    const desc = list().sort(comparator('desc')).map((item) => item.relPath)
    expect(desc.slice(0, 3)).toEqual(['new.md', 'mid.md', 'old.md'])
    expect([...desc.slice(3)].sort()).toEqual(['asset.png', 'dir'].sort())
  })

  it('大小排序：按 sizeBytes，同大小按名称兜底（确定性）', () => {
    const sorted = [
      makeEntry({ relPath: 'b.md', sizeBytes: 10 }),
      makeEntry({ relPath: 'a.md', sizeBytes: 10 }),
      makeEntry({ relPath: 'c.md', sizeBytes: 5 }),
    ].sort(makeEntryComparator({ by: 'size', direction: 'asc', foldersFirst: true }))
    expect(sorted.map((entry) => entry.relPath)).toEqual(['c.md', 'a.md', 'b.md'])
  })

  it('类型排序：按扩展名（无扩展名按空串排在最前）', () => {
    const sorted = [
      makeEntry({ relPath: 'b.md' }),
      makeEntry({ relPath: 'a.png' }),
      makeEntry({ relPath: '无后缀', ext: null }),
    ].sort(makeEntryComparator({ by: 'type', direction: 'asc', foldersFirst: false }))
    expect(sorted.map((entry) => entry.relPath)).toEqual(['无后缀', 'b.md', 'a.png'])
  })

  it('foldersFirst: false 时目录与文件按主键混排', () => {
    const sorted = [
      makeEntry({ relPath: 'b.md' }),
      makeEntry({ relPath: 'a目录', isDir: true }),
      makeEntry({ relPath: 'c.md' }),
    ].sort(makeEntryComparator({ by: 'name', direction: 'asc', foldersFirst: false }))
    expect(sorted.map((entry) => entry.relPath)).toEqual(['a目录', 'b.md', 'c.md'])
  })

  it('主键与名称都相同（理论上不该存在）时按 relPath 兜底，结果与输入顺序无关', () => {
    const comparator = makeEntryComparator({ by: 'size', direction: 'asc', foldersFirst: false })
    const forward = [makeEntry({ relPath: 'x/a.md' }), makeEntry({ relPath: 'y/a.md' })]
    const backward = [...forward].reverse()
    expect(forward.sort(comparator).map((entry) => entry.relPath)).toEqual(['x/a.md', 'y/a.md'])
    expect(backward.sort(comparator).map((entry) => entry.relPath)).toEqual(['x/a.md', 'y/a.md'])
  })

  it('buildTree 接受比较器：同一批条目按不同配置得到不同的树', () => {
    const source = [
      makeEntry({ relPath: 'b.md', mtimeMs: 100 }),
      makeEntry({ relPath: 'a.md', mtimeMs: 200 }),
    ]
    const byName = buildTree(source).map((node) => node.entry.relPath)
    const byMtime = buildTree(
      source,
      makeEntryComparator({ by: 'mtime', direction: 'asc', foldersFirst: true }),
    ).map((node) => node.entry.relPath)
    expect(byName).toEqual(['a.md', 'b.md'])
    expect(byMtime).toEqual(['b.md', 'a.md'])
  })
})

describe('isTreeSort（持久化恢复的形状校验）', () => {
  it('合法配置原样通过', () => {
    expect(isTreeSort(DEFAULT_TREE_SORT)).toBe(true)
    expect(isTreeSort({ by: 'mtime', direction: 'desc', foldersFirst: false })).toBe(true)
  })

  it('坏形状一律不认（调用方退回默认）', () => {
    expect(isTreeSort(null)).toBe(false)
    expect(isTreeSort('name')).toBe(false)
    expect(isTreeSort({ by: 'date', direction: 'asc', foldersFirst: true })).toBe(false)
    expect(isTreeSort({ by: 'name', direction: 'up', foldersFirst: true })).toBe(false)
    expect(isTreeSort({ by: 'name', direction: 'asc' })).toBe(false)
    expect(isTreeSort([])).toBe(false)
  })
})

describe('buildTree', () => {
  it('构建父子关系，目录先于文件', () => {
    const tree = buildTree(entries)
    expect(tree.map((node) => node.entry.relPath)).toEqual(['assets', 'notes', 'README.md'])

    const notes = tree.find((node) => node.entry.relPath === 'notes')
    expect(notes?.children.map((node) => node.entry.relPath)).toEqual([
      'notes/2025',
      'notes/Alpha.md',
      'notes/beta.md',
    ])
    expect(countNodes(tree)).toBe(entries.length)
  })

  it('父目录缺失的条目被提升为根（不静默丢失文件）', () => {
    const orphan = [makeEntry({ relPath: 'a/b/c.md' })]
    expect(buildTree(orphan).map((node) => node.entry.relPath)).toEqual(['a/b/c.md'])
  })

  it('空输入返回空树', () => {
    expect(buildTree([])).toEqual([])
  })
})

describe('flattenTree', () => {
  const tree = buildTree(entries)

  it('未展开时只显示根层', () => {
    const rows = flattenTree(tree, { expanded: new Set<string>() })
    expect(rows.map((row) => row.node.entry.relPath)).toEqual(['assets', 'notes', 'README.md'])
  })

  it('展开后插入子行，父行在子行之前且深度正确', () => {
    const rows = flattenTree(tree, { expanded: new Set(['notes']) })
    expect(rows.map((row) => row.node.entry.relPath)).toEqual([
      'assets',
      'notes',
      'notes/2025',
      'notes/Alpha.md',
      'notes/beta.md',
      'README.md',
    ])
    const child = rows.find((row) => row.node.entry.relPath === 'notes/2025')
    expect(child?.depth).toBe(1)
    expect(child?.hasChildren).toBe(true)
    const file = rows.find((row) => row.node.entry.relPath === 'notes/Alpha.md')
    expect(file?.hasChildren).toBe(false)
  })

  it('多级展开后深层文件可见', () => {
    const rows = flattenTree(tree, { expanded: new Set(['notes', 'notes/2025']) })
    expect(rows.map((row) => row.node.entry.relPath)).toContain('notes/2025/01.md')
  })

  it('折叠父目录会隐藏其后代', () => {
    const rows = flattenTree(tree, { expanded: new Set(['notes/2025']) })
    expect(rows.map((row) => row.node.entry.relPath)).not.toContain('notes/2025/01.md')
  })

  it('过滤时保留命中项的祖先链并自动展开', () => {
    const rows = flattenTree(tree, { expanded: new Set<string>(), filter: '01' })
    expect(rows.map((row) => row.node.entry.relPath)).toEqual([
      'notes',
      'notes/2025',
      'notes/2025/01.md',
    ])
  })

  it('过滤忽略大小写', () => {
    const rows = flattenTree(tree, { expanded: new Set<string>(), filter: 'alpha' })
    expect(rows.map((row) => row.node.entry.relPath)).toEqual(['notes', 'notes/Alpha.md'])
  })

  it('过滤中文目录名也能命中，并连带显示子项', () => {
    const cjk = buildTree([
      makeEntry({ relPath: '项目', isDir: true }),
      makeEntry({ relPath: '项目/设计.md' }),
      makeEntry({ relPath: '日记', isDir: true }),
    ])
    const rows = flattenTree(cjk, { expanded: new Set<string>(), filter: '项目' })
    expect(rows.map((row) => row.node.entry.relPath)).toEqual(['项目', '项目/设计.md'])
  })

  it('无命中时返回空数组', () => {
    expect(flattenTree(tree, { expanded: new Set<string>(), filter: '不存在的词' })).toEqual([])
  })
})

describe('辅助函数', () => {
  it('collectDirectoryPaths 收集所有目录', () => {
    const paths = [...collectDirectoryPaths(buildTree(entries))].sort()
    expect(paths).toEqual(['assets', 'notes', 'notes/2025'])
  })

  it('ancestorsOf 由近及远列出祖先', () => {
    expect(ancestorsOf('a/b/c.md')).toEqual(['a/b', 'a'])
    expect(ancestorsOf('a.md')).toEqual([])
  })

  it('matchesFilter 同时匹配名称与完整路径', () => {
    const entry = makeEntry({ relPath: 'notes/深度/笔记.md' })
    expect(matchesFilter(entry, '笔记')).toBe(true)
    expect(matchesFilter(entry, '深度/笔记')).toBe(true)
    expect(matchesFilter(entry, 'zzz')).toBe(false)
  })

  it('countNodes 统计全部条目（含目录）', () => {
    expect(countNodes(buildTree(entries))).toBe(entries.length)
    expect(countNodes([])).toBe(0)
  })
})
