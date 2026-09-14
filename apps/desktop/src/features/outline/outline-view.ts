/**
 * 大纲面板的"看什么"（级别过滤）与"看到多深"（章节折叠）—— 纯函数，不认识 React 与 DOM。
 *
 * 为什么放在 `features/outline/` 而不是 `domain/`：`domain/outline.ts` 生产的是一份
 * "所有视图都认的事实"（原文 → 标题列表 + 行号），而这里的两条规则只服务于**面板自己**的
 * 呈现：别的地方既不认识"用户此刻只想看 H1/H2"，也不关心某一节是展开还是收起。
 * 把面板私有的视图规则塞进领域层，只会让领域层替 UI 记账。
 *
 * ## 两条规则都围绕"序号（ordinal）"展开
 * 行号会随编辑移动、标题文本会重复（两节都叫"备注"），而"第几个标题"就是**解析结果本身的
 * 顺序** —— 阅读视图的跳转与"读到哪一节"（`outline-scroll.ts`）也是按它算的。于是这里
 * 定下一条硬约定：**过滤与折叠只决定"哪几条渲染"，绝不重新编号**。高亮
 * （`currentHeadingIndex` / `visibleHeadingOrdinal` 给出的下标）因此永远指着完整列表里的
 * 那一条，过滤或折叠都不会把它挤到相邻的条目上（这正是最容易做错的地方）。
 */

import type { OutlineHeading } from '@/domain/outline'

/**
 * 全部级别 = 默认值 = 不过滤。
 *
 * 为什么留成**模块级常量**而不是在渲染时现建 `[1..6]`：渲染层把它直接喂进 `useMemo`
 * 的依赖，每次新建数组会让"过滤后的可见列表"这个 memo 每次渲染都失效 ——
 * 而"每次按键重算整棵树"正是这个面板刻意避开的事（见文件头与组件注释）。
 */
export const ALL_HEADING_LEVELS: readonly number[] = [1, 2, 3, 4, 5, 6]

const MIN_LEVEL = 1
const MAX_LEVEL = 6

/**
 * 规范化级别集合：只留 1–6 的整数、去重、升序。
 *
 * 升序不是洁癖：它让"用户选了什么"在 localStorage 里是一份稳定、可肉眼核对的值，
 * 同一个选择不会因为点击顺序不同而写出两种形态。
 */
export function normalizeHeadingLevels(levels: Iterable<number>): number[] {
  const unique = new Set<number>()
  for (const level of levels) {
    if (Number.isInteger(level) && level >= MIN_LEVEL && level <= MAX_LEVEL) unique.add(level)
  }
  return [...unique].sort((a, b) => a - b)
}

/**
 * 切换某一级的显示开关，返回新的级别列表。
 *
 * **允许一级都不选**（结果为空数组）：那是一个诚实的"什么都不看"，面板会给出空态文案。
 * 反之若在这里替用户兜底（"至少留一级"），点击就会静默失效 —— 用户按了 H1 却没有任何
 * 变化，比看到一句"当前过滤条件下没有标题"更难理解。
 */
export function toggleHeadingLevel(levels: readonly number[], level: number): number[] {
  const next = new Set(levels)
  if (next.has(level)) next.delete(level)
  else next.add(level)
  return normalizeHeadingLevels(next)
}

/** 一行可见的大纲条目。 */
export interface OutlineRow {
  /** 在**完整标题列表**里的下标 —— 高亮判定与跳转都按它对齐（见文件头）。 */
  ordinal: number
  heading: OutlineHeading
  /** 缩进深度（来自完整列表的 `outlineDepths`，理由见 {@link buildOutlineRows}）。 */
  depth: number
  /** 是否渲染折叠三角：有没有**被过滤保留下来的**子标题（口径见 {@link buildOutlineRows}）。 */
  hasChildren: boolean
  collapsed: boolean
}

/**
 * 每个标题的子树结束位置（不含）：第一个 **级别 ≤ 自己** 的后继标题。
 *
 * 这就是"H2 折叠隐藏其后所有 H3+，直到遇到下一个 H1/H2"的字面实现 —— 用 `<=` 而不是
 * 用归一化深度，是因为写作里常见 `#` 直接跳到 `###`（缺中间层级），而折叠的语义是
 * "这一级标题管到哪"，与缩进怎么显示无关。
 *
 * 单调栈一趟算完（O(n)）：每个标题只会被弹出一次。为什么不用"对每一行再往后扫"的写法：
 * 那在大纲密集的笔记里是 O(n²)，而这份列表**每次输入都会重算**（deferred 文本变化即触发）。
 */
function subtreeEnds(headings: readonly OutlineHeading[]): number[] {
  const ends = new Array<number>(headings.length).fill(headings.length)
  const stack: number[] = []
  for (let index = 0; index < headings.length; index += 1) {
    const level = headings[index]?.level ?? 0
    while (stack.length > 0) {
      const top = stack[stack.length - 1] ?? -1
      if ((headings[top]?.level ?? 0) < level) break
      ends[top] = index
      stack.pop()
    }
    stack.push(index)
  }
  return ends
}

/**
 * 每个下标"后面第一个被过滤保留下来的标题"（没有则为 -1）；从右往左一趟扫完。
 *
 * 它只是算 `hasChildren` 的中间量：`nextVisible[i] < subtreeEnd(i)` 就说明第 i 条
 * 在**过滤后**还有子标题（子树里第一个位置若在辖区之外，这个子树里就没有可见的子标题）。
 */
function nextVisibleIndexes(
  headings: readonly OutlineHeading[],
  levels: ReadonlySet<number>,
): number[] {
  const nextVisible = new Array<number>(headings.length).fill(-1)
  let next = -1
  for (let index = headings.length - 1; index >= 0; index -= 1) {
    nextVisible[index] = next
    const level = headings[index]?.level
    if (level !== undefined && levels.has(level)) next = index
  }
  return nextVisible
}

/**
 * 算出"过滤 + 折叠"之后真正要渲染的条目（顺序与原列表一致）。
 *
 * - `depths` 传**完整列表**的缩进序列（`outlineDepths(headings)`），不是过滤后的：
 *   否则打开/关掉某一级时，剩余条目的缩进会整体重排（一条 H3 在 H2 被过滤掉之后突然
 *   变浅一层），用户的方位感就被打乱了。缩进是"它在原文里有多深"，与此刻显示什么无关。
 * - 折叠只由**看得见的**折叠项生效：三角只长在看得见的条目上，若让一个已被过滤掉的折叠项
 *   继续吞掉它下面的条目，面板就会出现"一片空白且没有任何三角可点"的死状态。反过来，
 *   过滤不会自动展开什么 —— 用户看得见的那几条，由他看得见的三角决定去留。
 * - `hasChildren`（要不要长三角）按**过滤后**算：一个按下去什么都不消失的三角是假控件。
 *   但它**不看折叠状态** —— 收起的条目必须留着三角，否则收起之后就再也展不开了。
 */
export function buildOutlineRows(
  headings: readonly OutlineHeading[],
  depths: readonly number[],
  levels: ReadonlySet<number>,
  collapsed: ReadonlySet<number>,
): OutlineRow[] {
  const ends = subtreeEnds(headings)
  const nextVisible = nextVisibleIndexes(headings, levels)

  const rows: OutlineRow[] = []
  /**
   * 当前仍生效的折叠项层级（`null` = 不在任何折叠区间里）。
   *
   * 一个变量就够：被折叠区间吞掉的条目不可能再被点开（它没有可见的三角），
   * 因此任何时刻**最多只有一个**折叠项生效。
   */
  let collapsedLevel: number | null = null

  for (let ordinal = 0; ordinal < headings.length; ordinal += 1) {
    const heading = headings[ordinal]
    if (heading === undefined) continue
    // 同级或更浅的标题结束了前面那个折叠项的辖区（被过滤掉的标题同样要结束它，
    // 否则折叠区间会越过一个 H1 继续吞掉后面的同级章节）
    if (collapsedLevel !== null && heading.level <= collapsedLevel) collapsedLevel = null
    if (!levels.has(heading.level)) continue

    const isCollapsed = collapsed.has(ordinal)
    const hidden = collapsedLevel !== null
    if (!hidden) {
      const next = nextVisible[ordinal] ?? -1
      rows.push({
        ordinal,
        heading,
        depth: depths[ordinal] ?? 0,
        hasChildren: next >= 0 && next < (ends[ordinal] ?? headings.length),
        collapsed: isCollapsed,
      })
    }
    if (!hidden && isCollapsed) collapsedLevel = heading.level
  }

  return rows
}
