/**
 * `@` 补全的**候选**（纯函数：不 import React / Zustand / CodeMirror / DOM）。
 *
 * 数据源就是 `builtins.ts` 那一张表 —— 候选列表因此不可能与展开器漂移（同一个判据驱动
 * 补全与展开，设计 02 §9 第 3 条）。这里只做三件事：过滤、排序、把"确认后插入什么"
 * 算出来（含"要等用户/剪贴板/随机源"的三个记号）。
 *
 * ## 候选右侧那一列显示什么
 * `previewTemplateValue` 给的是**真实值**（`@today` → `2026-10-12`），用户因此不必记名字。
 * 只有 `@clipboard` / `@prompt` / `@uuid` 三个给的是占位说明，理由见 `expand.ts` 里那段
 * —— 它们同步拿不到值，而每按一个键去读一次剪贴板是荒唐的。
 *
 * ## 为什么 `@cursor` 不进候选
 * 它是"模板里我创建笔记时光标落哪儿"的记号。在编辑器里用户的光标**本来就在那儿**，
 * 而它的展开值是空串 —— 选中它等于把刚敲的四个字删掉（设计 02 §6"绝不静默吞掉用户输入"
 * 的同一条纪律）。它仍然能在模板文件里用，展开器照样认它。
 */

import { TEMPLATE_BUILTINS } from '@/domain/template/builtins'
import { previewTemplateValue } from '@/domain/template/expand'
import type { TemplateSnapshot } from '@/domain/template/builtins'
import { fuzzyMatch } from '@/features/palette/match'

/** 确认那一刻从哪里取插入文本（判据只在这里分一次，插件按它分支）。 */
export type TemplateInsertSource =
  /** 同步展开值（绝大多数记号）。 */
  | 'value'
  /** 原样插入记号本身（`@prompt`：编辑器里弹输入框会打断写作，设计 02 §5.2 的例外）。 */
  | 'literal-token'
  /** 确认时异步读剪贴板（拿不到 → 空串 + 提示）。 */
  | 'clipboard'
  /** 确认时现场生成（每次生成都不同的值不能在候选里先算好）。 */
  | 'uuid'

/** 列表里的一条候选。 */
export interface TemplateCandidate {
  /** 记号名（不含 `@`，规范小写名）。 */
  name: string
  /** 一句话说明（悬停提示 `title`）。 */
  summary: string
  /** 右侧显示的展开值（或"要问出来"的占位说明）。 */
  value: string
  /** 命中字符在 {@link name} 里的下标（升序；空查询为空数组）。 */
  indices: readonly number[]
  /** 插入文本的来源（见 {@link TemplateInsertSource}）。 */
  source: TemplateInsertSource
  /**
   * 确认后写进文档的文本。
   *
   * `clipboard` / `uuid` 两种来源在确认那一刻才知道值，这里恒为空串 —— 插件按
   * {@link source} 取真正要插入的东西，绝不用这个字段去猜。
   */
  insert: string
}

/** 名字 → 插入来源（**唯一**一处分支）。 */
function insertSourceOf(name: string): TemplateInsertSource {
  switch (name) {
    case 'prompt':
      return 'literal-token'
    case 'clipboard':
      return 'clipboard'
    case 'uuid':
      return 'uuid'
    default:
      return 'value'
  }
}

/**
 * 过滤候选。
 *
 * 查询串是 `@` 与光标之间的名字（可能为空、可能还没打完），匹配手感与 `[[` 补全、
 * 命令面板完全一致（子序列匹配：打 `tdy` 能命中 `today`）。
 *
 * `argument` 是用户已经敲下的参数（`@today=d` 里的 `d`）：模式串类记号的候选值要跟着它走，
 * 于是"边敲参数边看右侧的真值"是成立的（`@today=ddd` 右侧直接显示 `周一`）。
 *
 * 排序：分数降序，同分保持表内顺序（表本身是"最常用在前"）。表只有 12 项，
 * 不需要上限截断 —— 这个列表不可能长到要担心渲染代价。
 */
export function filterTemplateCandidates(
  query: string,
  argument: string | null,
  snapshot: TemplateSnapshot,
): TemplateCandidate[] {
  const lowerQuery = query.trim().toLowerCase()
  const matched: Array<{ score: number; order: number; candidate: TemplateCandidate }> = []

  TEMPLATE_BUILTINS.forEach((builtin, order) => {
    // 理由见模块头：`@cursor` 在编辑器里没有意义，且它的展开值是空串
    if (builtin.name === 'cursor') return
    const match = fuzzyMatch(builtin.name, lowerQuery)
    if (match === null) return
    const source = insertSourceOf(builtin.name)
    matched.push({
      score: match.score,
      order,
      candidate: {
        name: builtin.name,
        summary: builtin.summary,
        value: previewTemplateValue(builtin.name, argument, snapshot),
        indices: match.indices,
        source,
        insert:
          source === 'literal-token'
            ? `@prompt${argument === null ? '' : `=${argument}`}`
            : source === 'value'
              ? previewTemplateValue(builtin.name, argument, snapshot)
              : '',
      },
    })
  })

  // 稳定排序：同分时保持表内顺序
  matched.sort((a, b) => b.score - a.score || a.order - b.order)
  return matched.map((item) => item.candidate)
}
