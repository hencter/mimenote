/**
 * 分栏的**焦点目录**：列链的末列显示它的内容（见 `domain/columns.ts` 的文件头）。
 *
 * 它是分栏唯一的额外状态，也是体验上唯一必须记住的东西 —— 所以按 **Vault 根分桶**
 * 持久化（与 `mimenote.vault.expanded.v1` 同一姿态：换一个 Vault 就是另一套"我在看哪儿"）。
 *
 * ## 为什么不用 `vault-store` / `settings-store`
 *
 * - `vault-store` 是"打开 Vault 时扫一次"的数据层（`expanded` 那种与数据同源的偏好才住那里），
 *   而焦点目录是纯界面状态；
 * - `settings-store` 的 `treeLayout` 管的是"用哪种画法"，而不是"看到哪一层"。
 *
 * 两条都不合适，于是留在视图层自己的 localStorage 键里。**与 Lead 的落地无耦合**：
 * 这里只碰 `mimenote.tree.focus.v1` 这一个键。
 *
 * ## 与单栏的语义边界
 *
 * 单栏的"回到哪"由持久化的 `expanded` 与每次打开都清空的 `selected` 共同决定。
 * 分栏多记住一个"末列是哪个目录"，但它**不影响单栏**：切回单栏时 `expanded` 原样生效，
 * 这两个状态互不覆盖。设计文档 §2.3 记了这条取舍。
 */

import { loadJson, saveJson } from '@/state/persist'

/** 每个 Vault 根一份：`{ [vaultRoot]: 相对目录路径 }`。 */
export const TREE_FOCUS_KEY = 'mimenote.tree.focus.v1'

/** 焦点目录为空串是合法的（= Vault 根），所以用 `null` 表示"这个 Vault 还没有记录"。 */
export function loadTreeFocus(vaultRoot: string): string | null {
  if (vaultRoot === '') return null
  const map = loadJson<Record<string, unknown>>(TREE_FOCUS_KEY, {})
  const value = map[vaultRoot]
  return typeof value === 'string' ? value : null
}

/** 记下焦点目录（`null` = 清掉这一项，例如点回根目录时不必留一条空串记录）。 */
export function saveTreeFocus(vaultRoot: string, focus: string | null): void {
  if (vaultRoot === '') return
  const map = loadJson<Record<string, unknown>>(TREE_FOCUS_KEY, {})
  if (focus === null) delete map[vaultRoot]
  else map[vaultRoot] = focus
  saveJson(TREE_FOCUS_KEY, map)
}
