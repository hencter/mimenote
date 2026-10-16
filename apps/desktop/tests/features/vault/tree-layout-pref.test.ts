/**
 * 文件树画法偏好：三态循环与分栏族判定。
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  isColumnsFamily,
  nextTreeLayout,
  readTreeLayout,
  toggleTreeLayout,
} from '@/features/vault/tree-layout-pref'
import { useSettingsStore } from '@/state/settings-store'

beforeEach(() => {
  useSettingsStore.setState({ treeLayout: 'single' })
})

describe('readTreeLayout / nextTreeLayout', () => {
  it('非法值退回 single', () => {
    expect(readTreeLayout(null)).toBe('single')
    expect(readTreeLayout({ treeLayout: 'nope' })).toBe('single')
    expect(readTreeLayout({ treeLayout: 'columns' })).toBe('columns')
    expect(readTreeLayout({ treeLayout: 'stack' })).toBe('stack')
  })

  it('循环 single → columns → stack → single', () => {
    expect(nextTreeLayout('single')).toBe('columns')
    expect(nextTreeLayout('columns')).toBe('stack')
    expect(nextTreeLayout('stack')).toBe('single')
  })

  it('分栏族含 columns 与 stack', () => {
    expect(isColumnsFamily('single')).toBe(false)
    expect(isColumnsFamily('columns')).toBe(true)
    expect(isColumnsFamily('stack')).toBe(true)
  })
})

describe('toggleTreeLayout', () => {
  it('写回 settings-store 并走完一圈', () => {
    expect(useSettingsStore.getState().treeLayout).toBe('single')
    toggleTreeLayout()
    expect(useSettingsStore.getState().treeLayout).toBe('columns')
    toggleTreeLayout()
    expect(useSettingsStore.getState().treeLayout).toBe('stack')
    toggleTreeLayout()
    expect(useSettingsStore.getState().treeLayout).toBe('single')
  })
})
