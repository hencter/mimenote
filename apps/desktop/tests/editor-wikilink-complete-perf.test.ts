/**
 * `[[` 补全在 **1 万条笔记**下的实测代价（architecture.md §6 的"输入延迟 ≤ 16ms"）。
 *
 * 为什么单独一个文件、而且跑在 node 环境：这里量的是**纯计算**（索引构建 + 按键过滤），
 * 与 DOM/编辑器无关；放在 jsdom 里会被无关开销淹没。断言只给**很宽**的上界
 * （只用来抓"不小心把 O(n) 变成 O(n log n) 每次按键"这类退化），真正的数字靠
 * `console.info` 打出来 —— 在 CI 上耗时会抖，次数不会（"按键路径上不重建索引"
 * 那条纪律由 `editor-wikilink-complete.test.tsx` 数构建次数来钉死）。
 */

import { describe, expect, it } from 'vitest'

import {
  buildWikilinkIndex,
  filterWikilinkCandidates,
  type WikilinkIndex,
} from '@/features/editor/cm/wiki-complete/candidates'
import { makeEntry } from '@/ipc/client'
import type { EntryMeta } from '@/ipc/types'

// ---------------------------------------------------------------------------
// 数据
// ---------------------------------------------------------------------------

const NOTE_COUNT = 10_000
const DIR_COUNT = 50
/** 名字用中文词根（子序列匹配在中英文下的代价不同，这里要贴近真实笔记名）。 */
const WORDS = ['设计', '日记', '会议', '阅读', '想法', '清单', '计划', '复盘', '灵感', '归档']

/** 合成一份"1 万篇笔记 / 50 个目录"的条目表（与 `palette/match.ts` 的基准同量级）。 */
function makeVault(count: number): EntryMeta[] {
  const entries: EntryMeta[] = []
  for (let index = 0; index < count; index += 1) {
    const relPath = `目录${index % DIR_COUNT}/${WORDS[index % WORDS.length] ?? ''}${String(index).padStart(5, '0')}.md`
    entries.push(makeEntry({ relPath }))
  }
  return entries
}

interface Timing {
  /** 单次最快耗时（毫秒）—— 最接近"用户感受到的那一次"。 */
  min: number
  /** 平均耗时（毫秒）。 */
  avg: number
}

/** 跑 `rounds` 次（先热身一次），返回最快与平均耗时。 */
function measure(run: () => void, rounds = 30): Timing {
  run()
  let min = Number.POSITIVE_INFINITY
  let total = 0
  for (let round = 0; round < rounds; round += 1) {
    const started = performance.now()
    run()
    const elapsed = performance.now() - started
    total += elapsed
    if (elapsed < min) min = elapsed
  }
  return { min, avg: total / rounds }
}

function ms(value: number): string {
  return `${value.toFixed(2)}ms`
}

// ---------------------------------------------------------------------------

describe(`1 万条笔记下的实测（${NOTE_COUNT} 条 / ${DIR_COUNT} 个目录）`, () => {
  const entries = makeVault(NOTE_COUNT)

  it('索引构建只在条目表变化时发生，且是一次性开销', () => {
    const timing = measure(() => buildWikilinkIndex(entries), 5)
    console.info(`[wiki-complete] buildWikilinkIndex(${NOTE_COUNT})：min ${ms(timing.min)} / avg ${ms(timing.avg)}`)
    // 只发生在"打开 Vault / 新建 / 删除 / 改名"之后第一次真的要用它时
    expect(timing.min).toBeLessThan(200)
  })

  const index: WikilinkIndex = buildWikilinkIndex(entries)
  const options = { noteRelPath: '目录0/设计00000.md', embed: false }

  /**
   * 每次按键 = 一次 filter。查询串按"用户正在打字"的形态给：
   * 空（刚敲下 `[[`）/ 单字（命中面最大）/ 常用词 / 目录名 / 无命中。
   */
  const queries: ReadonlyArray<{ label: string; query: string }> = [
    { label: '空查询（刚敲下 `[[`）', query: '' },
    { label: '单字「设」（约 1000 条命中）', query: '设' },
    { label: '词「设计」（约 1000 条命中）', query: '设计' },
    { label: '「设计00040」（唯一命中）', query: '设计00040' },
    { label: '目录名「目录7」（路径命中）', query: '目录7' },
    { label: '最坏情况「目」（全库 1 万条全命中）', query: '目' },
    { label: '无命中「zzz」', query: 'zzz' },
  ]

  for (const { label, query } of queries) {
    it(`每次按键过滤：${label}`, () => {
      const outcome = filterWikilinkCandidates(index, query, options)
      const timing = measure(() => filterWikilinkCandidates(index, query, options), 50)
      console.info(
        `[wiki-complete] 查询「${query}」命中 ${outcome.total} 条：min ${ms(timing.min)} / avg ${ms(timing.avg)}`,
      )
      // 预算：单次按键 ≤ 16ms（一帧）。实测远低于它，这里留足余量只挡退化
      expect(timing.min).toBeLessThan(16)
    })
  }

  it('空查询走的是"预排序 + 分桶"，不是"白排一万条"', () => {
    // 同一份索引、同一个空查询：连做 200 次仍然只有微秒级
    // （若空查询退化成"对 1 万条排序"，这里会立刻涨到每次 3~6ms）
    const started = performance.now()
    for (let round = 0; round < 200; round += 1) {
      filterWikilinkCandidates(index, '', options)
    }
    const perCall = (performance.now() - started) / 200
    console.info(`[wiki-complete] 空查询连续 200 次：每次 ${ms(perCall)}`)
    expect(perCall).toBeLessThan(2)
  })
})
