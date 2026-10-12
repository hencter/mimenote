/**
 * 收件箱条目的 React 读取层（memo 化）。
 *
 * 为什么单独一个 hook、而不是在 store 里选：`state/**` 全是 `.ts` 且不 import React
 * （store 只放状态与动作），而 selector 里现算一个新数组会让 zustand 每帧都判定"变了"
 * （引用不相等）。所以派生放在这一层，按 `(entries, dir)` 用 `useMemo` 缓存 ——
 * 与 `features/vault/use-tag-filter-view.ts` 同一个写法。
 *
 * 数据源是 `vault-store.entries`（打开 Vault 时扫一次的那份快照），**不另存一份收件箱列表**：
 * 两份列表迟早会分叉（树里刷新了、列表还是旧的）。目录同理，直接读 `settings-store.inboxDir`
 * （它的上游是 Vault 内的配置文件 `[inbox] dir`）。
 */

import { useMemo } from 'react'

import { inboxEntries } from '@/domain/inbox'
import { useSettingsStore } from '@/state/settings-store'
import { useVaultStore } from '@/state/vault-store'
import type { EntryMeta } from '@/ipc/types'

/** 收件箱条目（已按 mtime 倒序，见 `domain/inbox.compareInboxEntries`）。 */
export function useInboxEntries(): EntryMeta[] {
  const entries = useVaultStore((state) => state.entries)
  const dir = useInboxDir()
  return useMemo(() => inboxEntries(entries, dir), [entries, dir])
}

/** 未整理计数（= 仍在收件箱目录之内的条目数）。 */
export function useInboxCount(): number {
  return useInboxEntries().length
}

/** 当前收件箱目录（文件树置顶之类的调用方要它，别自己写 `'Inbox'`）。 */
export function useInboxDir(): string {
  return useSettingsStore((state) => state.inboxDir)
}
