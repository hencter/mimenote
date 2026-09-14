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
  TAG_MATCH_MODE,
  countMarkdownEntries,
  countTagHitNotes,
  countVisibleNotes,
  descendantTagKeys,
  expandTagKeys,
  isTagFilterActive,
  mergeTagHits,
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

describe('展开成"要问宿主的键集合"', () => {
  it('开「含子标签」= 自己 + 全部后代；关掉 = 只有自己', () => {
    expect(expandTagKeys(['a'], ALL_KEYS, true)).toEqual(['a', 'a/b', 'a/c', 'a/c/d'])
    expect(expandTagKeys(['a'], ALL_KEYS, false)).toEqual(['a'])
  })

  it('同时选了父与子时不重复问同一个键', () => {
    expect(expandTagKeys(['a', 'a/c'], ALL_KEYS, true)).toEqual(['a', 'a/b', 'a/c', 'a/c/d'])
  })

  it('空键被跳过（它会让宿主返回 PATH_INVALID）', () => {
    expect(expandTagKeys(['', 'b'], ALL_KEYS, true)).toEqual(['b'])
  })
})

describe('多选语义', () => {
  it('产品口径是并集：任一命中即显示', () => {
    expect(TAG_MATCH_MODE).toBe('or')
    expect(mergeTagHits([['a.md', 'b.md'], ['b.md', 'c.md']], TAG_MATCH_MODE)).toEqual([
      'a.md',
      'b.md',
      'c.md',
    ])
  })

  it('交集口径也钉在测试里（另一条路，防止有人"顺手"把它当成并集用）', () => {
    expect(mergeTagHits([['a.md', 'b.md'], ['b.md', 'c.md']], 'and')).toEqual(['b.md'])
    // 没有共同命中的两篇（这正是并集更可用的原因：交集会给一个空集，而空集与"坏了"难分辨）
    expect(mergeTagHits([['a.md'], ['b.md']], 'and')).toEqual([])
  })

  it('结果去重且稳定排序；没有键时是空集', () => {
    expect(mergeTagHits([['b.md', 'a.md'], ['a.md']], 'or')).toEqual(['a.md', 'b.md'])
    expect(mergeTagHits([], 'or')).toEqual([])
    expect(mergeTagHits([[]], 'or')).toEqual([])
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

describe('条件指纹', () => {
  it('没选标签时是空串（调用方据此判定"未生效"）', () => {
    expect(tagFilterSignature([], true)).toBe('')
    expect(isTagFilterActive([])).toBe(false)
  })

  it('选择顺序不影响指纹（否则点两次同一个标签顺序一变就白跑一轮 IPC）', () => {
    expect(tagFilterSignature(['a', 'b'], true)).toBe(tagFilterSignature(['b', 'a'], true))
  })

  it('「含子标签」是条件的一部分（同一个标签、开关不同 → 结果是两回事）', () => {
    expect(tagFilterSignature(['a'], true)).not.toBe(tagFilterSignature(['a'], false))
  })
})
