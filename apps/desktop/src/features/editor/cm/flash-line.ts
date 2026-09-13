/**
 * "落到某一行"时的短暂高亮（闪烁）。
 *
 * 三条取舍：
 *
 * 1. **装饰，不改文档**：跳转只是"看"，往正文里插标记会改内容、进撤销历史、还会被
 *    自动保存写回磁盘 —— 那是在用户的文件里留下痕迹，绝对不能做。
 * 2. **记行号，不记位置**：位置要在每个事务里 `map`，而行号在这里的语义就是"第 N 行闪一下"。
 *    每次重算都从**当前**文档取行首，于是用户在这几百毫秒里改文档（甚至整篇替换成另一篇笔记）
 *    也不会把高亮甩到一个已经不属于这篇文档的偏移上；行号越界时夹取，绝不抛错。
 * 3. **必须由定时器摘掉**：CSS 动画"播完"只是画完了，装饰还在 DOM 上。不摘掉的话，
 *    该行滚出视口再滚回来会重新播一次动画（`animation` 在元素重建时重放），
 *    在用户眼里就是"某些行会莫名其妙闪一下"。
 */

import { StateEffect, StateField, type Extension, type Transaction } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type PluginValue,
  type ViewUpdate,
} from '@codemirror/view'

import { clampLineNumber } from '@/domain/line-target'

/**
 * 闪烁时长。
 *
 * 800ms 是"够看清落点、又不至于让人以为整行被选中"的量级：再短（<300ms）在
 * 大文档里刚滚完就已经消失了，再长（>1.5s）会让光标已经能输入了高亮还挂在那里。
 */
export const FLASH_LINE_MS = 800

/** 行装饰的类名（样式见本文件末尾的 {@link flashLineTheme}）。 */
export const FLASH_LINE_CLASS = 'mn-line-flash'

/** 高亮第 `line` 行（1 起）。不改变文档。 */
export const flashLineEffect = StateEffect.define<number>()

/** 摘掉高亮（由 {@link FLASH_LINE_MS} 到点后的定时器派发；测试也可以直接派发）。 */
export const clearFlashLineEffect = StateEffect.define<null>()

/**
 * 这次事务是不是"整篇替换"（覆盖了替换前的**全部**文档）。
 *
 * 切换笔记与"从磁盘重新加载"都走 `replaceEditorText`（一次覆盖全文的 change），
 * 那是唯一会让"第 N 行"改换门庭的操作：行号还在，行已经不是原来那一行了。
 */
function replacesWholeDoc(transaction: Transaction): boolean {
  if (!transaction.docChanged) return false
  const before = transaction.startState.doc.length
  if (before === 0) return true
  let whole = false
  transaction.changes.iterChangedRanges((fromA, toA) => {
    if (fromA === 0 && toA === before) whole = true
  })
  return whole
}

const flashLineField = StateField.define<number | null>({
  create: () => null,
  update(value, transaction) {
    let next = value
    for (const effect of transaction.effects) {
      if (effect.is(flashLineEffect)) next = effect.value
      else if (effect.is(clearFlashLineEffect)) next = null
    }
    // 整篇替换：摘掉高亮，否则刚切过去的那篇笔记上会有一行莫名其妙地闪一下
    // （跳转后 800ms 内点开另一篇笔记就能看到）
    if (next !== null && replacesWholeDoc(transaction)) next = null
    return next
  },
})

const flashLineDecoration = Decoration.line({ class: FLASH_LINE_CLASS })

/** 行号 → 行装饰（每次依赖变化都从当前文档重新取行首，见文件头第 2 条）。 */
const flashLineDecorations = EditorView.decorations.compute([flashLineField], (state) => {
  const line = state.field(flashLineField)
  if (line === null) return Decoration.none
  // 夹取一次：这几百毫秒里文档可能被删短，或者整篇换成了另一篇笔记
  const at = state.doc.line(clampLineNumber(line, state.doc.lines)).from
  return Decoration.set([flashLineDecoration.range(at)])
})

/**
 * 到点摘掉高亮。
 *
 * 只在"行号这一个值"真的变了时才重排定时器：按"每次事务"重排的话，用户在这 800ms 里
 * 每敲一个字就把倒计时清零，闪烁会一直不结束。
 */
const flashLineTimer = ViewPlugin.fromClass(
  class FlashLineTimer implements PluginValue {
    private timer: ReturnType<typeof setTimeout> | null = null

    constructor(view: EditorView) {
      this.arm(view)
    }

    update(update: ViewUpdate): void {
      if (update.state.field(flashLineField) !== update.startState.field(flashLineField)) {
        this.arm(update.view)
      }
    }

    destroy(): void {
      // 定时器是副作用，必须随插件一起消失（否则会在编辑器销毁后再派发一次事务）
      this.disarm()
    }

    private arm(view: EditorView): void {
      this.disarm()
      if (view.state.field(flashLineField) === null) return
      this.timer = setTimeout(() => {
        this.timer = null
        view.dispatch({ effects: clearFlashLineEffect.of(null) })
      }, FLASH_LINE_MS)
    }

    private disarm(): void {
      if (this.timer === null) return
      clearTimeout(this.timer)
      this.timer = null
    }
  },
)

/**
 * 闪烁的样式。
 *
 * 底色走主题令牌而不是写死颜色（换主题 / Vault CSS 片段都能跟着变）；用半透明混合而不是
 * 直接用 `--mn-accent`：闪烁那 800ms 里正文必须仍然可读，实色强调色配正文颜色会糊成一片。
 *
 * `prefers-reduced-motion` 下 `styles/app.css` 会把动画时长压到 0.01ms —— 那时这一行仍留着
 * 一层静态底色，直到定时器把它摘掉。于是"关掉动效"的用户同样能看到落点，只是不闪。
 */
export const flashLineTheme = EditorView.theme({
  [`.${FLASH_LINE_CLASS}`]: {
    backgroundColor: 'color-mix(in srgb, var(--mn-accent) 18%, transparent)',
    animation: `mn-line-flash-pulse ${FLASH_LINE_MS}ms ease-out`,
  },
  '@keyframes mn-line-flash-pulse': {
    from: { backgroundColor: 'color-mix(in srgb, var(--mn-accent) 45%, transparent)' },
    to: { backgroundColor: 'color-mix(in srgb, var(--mn-accent) 18%, transparent)' },
  },
})

/** 闪烁的扩展（字段 + 装饰 + 定时器 + 样式），由 `cm/setup.ts` 装进编辑器。 */
export function flashLineExtensions(): Extension[] {
  return [flashLineField, flashLineDecorations, flashLineTimer, flashLineTheme]
}
