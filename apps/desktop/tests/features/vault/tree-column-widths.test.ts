// @vitest-environment jsdom
/**
 * 分栏列宽偏好：夹紧、按路径取默认、按 Vault 分桶读写。
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  COLUMN_WIDTH_DEFAULT,
  COLUMN_WIDTH_MAX,
  COLUMN_WIDTH_MIN,
  TREE_COLUMN_WIDTHS_KEY,
  clampColumnWidth,
  columnWidthOf,
  loadColumnWidths,
  saveColumnWidths,
} from '@/features/vault/tree-column-widths'

beforeEach(() => {
  window.localStorage.clear()
})

describe('clampColumnWidth', () => {
  it('夹到 [MIN, MAX]，非法值回默认', () => {
    expect(clampColumnWidth(200)).toBe(200)
    expect(clampColumnWidth(COLUMN_WIDTH_MIN - 1)).toBe(COLUMN_WIDTH_MIN)
    expect(clampColumnWidth(COLUMN_WIDTH_MAX + 1)).toBe(COLUMN_WIDTH_MAX)
    expect(clampColumnWidth(Number.NaN)).toBe(COLUMN_WIDTH_DEFAULT)
  })
})

describe('columnWidthOf / 持久化', () => {
  it('未存过的路径用默认 240', () => {
    expect(columnWidthOf({}, '')).toBe(COLUMN_WIDTH_DEFAULT)
    expect(columnWidthOf({ 'a/b': 320 }, '')).toBe(COLUMN_WIDTH_DEFAULT)
  })

  it('按 Vault 根分桶读写；等于默认的项不落盘', () => {
    saveColumnWidths('/vault-a', { '': 300, inbox: COLUMN_WIDTH_DEFAULT })
    saveColumnWidths('/vault-b', { projects: 400 })

    expect(loadColumnWidths('/vault-a')).toEqual({ '': 300 })
    expect(loadColumnWidths('/vault-b')).toEqual({ projects: 400 })
    expect(loadColumnWidths('/vault-c')).toEqual({})

    const raw = JSON.parse(window.localStorage.getItem(TREE_COLUMN_WIDTHS_KEY) ?? '{}') as Record<
      string,
      unknown
    >
    expect(raw['/vault-a']).toEqual({ '': 300 })
  })

  it('清空到只剩默认时删掉该 Vault 桶', () => {
    saveColumnWidths('/vault-a', { '': 300 })
    saveColumnWidths('/vault-a', { '': COLUMN_WIDTH_DEFAULT })
    expect(loadColumnWidths('/vault-a')).toEqual({})
  })
})
