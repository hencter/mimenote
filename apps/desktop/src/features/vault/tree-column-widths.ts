/**
 * 分栏列宽偏好：按 **Vault 根分桶**、按 **列所显示的目录相对路径** 存一份像素宽度。
 *
 * 与 `tree-focus.ts` 同一姿态：这是纯界面状态，不进 `vault-store` / `settings-store`。
 * 键用目录路径而不是"第几列"：推进/回退后同一目录再出现时宽度还在，比按列序更稳。
 *
 * 默认 240、下限 140、上限 560 —— 下限避免拖成一条废线，上限与侧栏 `SIDEBAR_MAX` 对齐。
 */

import { loadJson, saveJson } from '@/state/persist'

export const TREE_COLUMN_WIDTHS_KEY = 'mimenote.tree.column-widths.v1'

export const COLUMN_WIDTH_DEFAULT = 240
export const COLUMN_WIDTH_MIN = 140
export const COLUMN_WIDTH_MAX = 560

export type ColumnWidths = Record<string, number>

export function clampColumnWidth(px: number): number {
  if (!Number.isFinite(px)) return COLUMN_WIDTH_DEFAULT
  return Math.min(COLUMN_WIDTH_MAX, Math.max(COLUMN_WIDTH_MIN, Math.round(px)))
}

export function columnWidthOf(widths: ColumnWidths, path: string): number {
  const saved = widths[path]
  return typeof saved === 'number' ? clampColumnWidth(saved) : COLUMN_WIDTH_DEFAULT
}

export function loadColumnWidths(vaultRoot: string): ColumnWidths {
  if (vaultRoot === '') return {}
  const map = loadJson<Record<string, unknown>>(TREE_COLUMN_WIDTHS_KEY, {})
  const raw = map[vaultRoot]
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const next: ColumnWidths = {}
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      next[path] = clampColumnWidth(value)
    }
  }
  return next
}

export function saveColumnWidths(vaultRoot: string, widths: ColumnWidths): void {
  if (vaultRoot === '') return
  const map = loadJson<Record<string, unknown>>(TREE_COLUMN_WIDTHS_KEY, {})
  const cleaned: ColumnWidths = {}
  for (const [path, value] of Object.entries(widths)) {
    if (value === COLUMN_WIDTH_DEFAULT) continue
    cleaned[path] = clampColumnWidth(value)
  }
  if (Object.keys(cleaned).length === 0) delete map[vaultRoot]
  else map[vaultRoot] = cleaned
  saveJson(TREE_COLUMN_WIDTHS_KEY, map)
}
