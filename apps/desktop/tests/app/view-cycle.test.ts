// @vitest-environment jsdom
/**
 * `Ctrl+E` 只在编辑与阅读之间切换（图谱用 `Ctrl+G` 直达）。
 *
 * 图谱是另一个视图（状态栏里单独一组），按 `Ctrl+E` 绝不应该把人甩进图谱 ——
 * 以前是三循环（编辑 → 阅读 → 图谱 → 编辑），用户反馈后改成两态切换。
 */

import { describe, expect, it } from 'vitest'

import { useUiStore } from '@/state/ui-store'

describe('view.cycleMode（Ctrl+E）', () => {
  it('编辑 ↔ 阅读来回切，永远不进图谱', () => {
    const { setViewMode, cycleViewMode } = useUiStore.getState()

    setViewMode('edit')
    cycleViewMode()
    expect(useUiStore.getState().viewMode).toBe('read')
    cycleViewMode()
    expect(useUiStore.getState().viewMode).toBe('edit')
    cycleViewMode()
    expect(useUiStore.getState().viewMode).toBe('read')
  })

  it('从图谱按过来落到编辑（默认视图），而不是记住上次', () => {
    const { setViewMode, cycleViewMode } = useUiStore.getState()

    setViewMode('graph')
    cycleViewMode()
    expect(useUiStore.getState().viewMode).toBe('edit')
  })
})
