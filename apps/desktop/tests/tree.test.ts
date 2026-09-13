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
  ancestorsOf,
  buildTree,
  collectDirectoryPaths,
  compareEntries,
  countNodes,
  flattenTree,
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
