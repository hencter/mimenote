/**
 * 标签过滤纯函数单测（`domain/tag-filter.ts`）。
 *
 * 这里钉住的是**行为契约**（不是实现）：层级怎么算、多选是并还是交、祖先怎么补、
 * 计数取哪一份口径。界面上的说明文字与这些契约同源（见 `TagFilterControl`），
 * 因此任何一条改动都必须先在这里说清楚。
 */

import { describe, expect, it } from 'vitest'

import { makeEntry } from '@/ipc/client'
import type { EntryMeta } from '@/ipc/types'
import {
  countMarkdownEntries,
  countTagHitNotes,
  countVisibleNotes,
  descendantTagKeys,
  isTagFilterActive,
  isTagFilterQueryEmpty,
  tagFilterSignature,
  tagFilterVisiblePaths,
} from '@/domain/tag-filter'

/** 一组全库标签键（`tags_list` 的键：小写、去首尾 `/`、`/` 表示层级）。 */
const ALL_KEYS = ['a', 'a/b', 'a/c', 'a/c/d', 'ab', 'b', '笔记', '笔记/乙', '笔记/甲']

function file(relPath: string): EntryMeta {
  return makeEntry({ relPath })
}

function dir(relPath: string): EntryMeta {
  return makeEntry({ relPath, isDir: true })
}

describe('层级：`/` 就是层级', () => {
  it('子标签 = 前缀为 `父/` 的全部键，含更深层', () => {
    expect(descendantTagKeys(ALL_KEYS, 'a')).toEqual(['a/b', 'a/c', 'a/c/d'])
    expect(descendantTagKeys(ALL_KEYS, 'a/c')).toEqual(['a/c/d'])
    expect(descendantTagKeys(ALL_KEYS, 'a/c/d')).toEqual([])
  })

  it('`ab` 不是 `a` 的子标签（前缀必须是 `父/`，不是裸字符串前缀）', () => {
    expect(descendantTagKeys(ALL_KEYS, 'a')).not.toContain('ab')
    expect(descendantTagKeys(ALL_KEYS, '笔记')).not.toContain('笔记甲')
  })

  it('空键没有任何子标签（空键本身是被宿主拒绝的输入）', () => {
    expect(descendantTagKeys(ALL_KEYS, '')).toEqual([])
  })
})

describe('过滤条件（与宿主 `tag_filter` 一一对应）', () => {
  it('空条件 = 什么都没限（调用方据此完全不收窄）', () => {
    expect(isTagFilterQueryEmpty({ any: [], none: [], includeChildren: true })).toBe(true)
    expect(isTagFilterQueryEmpty({ any: [], none: ['b'], includeChildren: false })).toBe(false)
    expect(isTagFilterQueryEmpty({ any: ['a'], none: [], includeChildren: false })).toBe(false)
    expect(isTagFilterActive([])).toBe(false)
    expect(isTagFilterActive(['a'])).toBe(true)
  })

  it('指纹只与**条件**有关：顺序无关、层级开关与"不含"都算进指纹', () => {
    const base = { any: ['a', 'b'], none: [], includeChildren: true }
    // 选定顺序不影响结果，也就不该让结果过期
    expect(tagFilterSignature(base)).toBe(
      tagFilterSignature({ any: ['b', 'a'], none: [], includeChildren: true }),
    )
    // 加一个"不含"必须换指纹（否则界面会拿旧结果当新条件的结果）
    expect(tagFilterSignature(base)).not.toBe(
      tagFilterSignature({ any: ['a', 'b'], none: ['c'], includeChildren: true }),
    )
    // 「含子标签」换档同理
    expect(tagFilterSignature(base)).not.toBe(
      tagFilterSignature({ any: ['a', 'b'], none: [], includeChildren: false }),
    )
    // 空条件的指纹是空串（界面据此判定"未生效"）
    expect(tagFilterSignature({ any: [], none: [], includeChildren: true })).toBe('')
  })

  it('层级提示只用来"多算几个"的说明：子标签按 `/` 前缀算，`ab` 不算 `a` 的子标签', () => {
    expect(descendantTagKeys(ALL_KEYS, 'a')).toEqual(['a/b', 'a/c', 'a/c/d'])
    expect(descendantTagKeys(ALL_KEYS, 'a')).not.toContain('ab')
    expect(descendantTagKeys(ALL_KEYS, '笔记')).not.toContain('笔记甲')
    expect(descendantTagKeys(ALL_KEYS, '')).toEqual([])
  })
})
describe('可见路径集合', () => {
  it('命中笔记 + 它的每一级祖先目录', () => {
    const visible = tagFilterVisiblePaths(['项目/子项目/细节.md'])
    expect([...visible].sort()).toEqual(['项目', '项目/子项目', '项目/子项目/细节.md'])
  })

  it('根目录下的笔记没有祖先可补', () => {
    expect([...tagFilterVisiblePaths(['随手记.md'])]).toEqual(['随手记.md'])
  })

  it('**不变式**：集合里的目录一定是某条命中笔记的祖先 —— 空目录因此天然不显示', () => {
    const visible = tagFilterVisiblePaths(['项目/设计.md'])
    expect(visible.has('项目')).toBe(true)
    // 同一棵树上的兄弟目录、以及"没有命中的目录"都不在集合里：
    // 它们进了集合就会在过滤视图里骗人（"这里面还有命中"）
    expect(visible.has('日记')).toBe(false)
    expect(visible.has('项目/子项目')).toBe(false)
  })

  it('非 Markdown 的命中被丢掉（标签过滤是"收窄到用了某标签的**笔记**"）', () => {
    const visible = tagFilterVisiblePaths(['附件/说明.txt'])
    expect(visible.size).toBe(0)
    expect(visible.has('附件')).toBe(false)
  })

  it('计数与可见集合口径一致', () => {
    const hits = ['项目/设计.md', '附件/说明.txt', '项目/设计.md']
    expect(countTagHitNotes(hits)).toBe(2)
  })
})

describe('计数：分子与分母取同一份条目表', () => {
  const entries: EntryMeta[] = [
    dir('项目'),
    file('项目/设计.md'),
    dir('项目/子项目'),
    file('项目/子项目/细节.md'),
    file('附件'),
    file('无标签.md'),
  ]

  it('分母是条目表里的 Markdown 笔记数（非笔记条目不算）', () => {
    expect(countMarkdownEntries(entries)).toBe(3)
  })

  it('分子只数"可见集合 ∩ 条目表"里的笔记（命中里不存在于树的那些不算）', () => {
    const visible = tagFilterVisiblePaths(['项目/设计.md', '已经删掉的.md'])
    expect(countVisibleNotes(visible, entries)).toBe(1)
  })

  it('可见集合里的目录不会被算成"篇"', () => {
    const visible = tagFilterVisiblePaths(['项目/子项目/细节.md'])
    expect(countVisibleNotes(visible, entries)).toBe(1)
  })
})

describe('条件指纹（与 `TagFilterQuery` 的形状一起核对）', () => {
  it('没选条件时是空串（调用方据此判定"未生效"）', () => {
    expect(tagFilterSignature({ any: [], none: [], includeChildren: true })).toBe('')
    expect(isTagFilterActive([])).toBe(false)
  })

  it('选择顺序不影响指纹（否则点两次同一个标签顺序一变就白跑一轮 IPC）', () => {
    const left = { any: ['a', 'b'], none: [], includeChildren: true }
    const right = { any: ['b', 'a'], none: [], includeChildren: true }
    expect(tagFilterSignature(left)).toBe(tagFilterSignature(right))
  })

  it('「含子标签」与「不含」都是条件的一部分（任一处不同 → 结果是两回事）', () => {
    const base = { any: ['a'], none: [], includeChildren: true }
    expect(tagFilterSignature(base)).not.toBe(
      tagFilterSignature({ ...base, includeChildren: false }),
    )
    expect(tagFilterSignature(base)).not.toBe(tagFilterSignature({ ...base, none: ['b'] }))
  })
})
