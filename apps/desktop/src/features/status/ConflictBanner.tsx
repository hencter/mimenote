/**
 * 冲突横幅：宿主检测到"文件被外部修改"时出现，必须由用户决定如何取舍（ADR-0004）。
 *
 * ## 多文档之后：这条横幅要照顾**所有**打开的文档
 * 从前只有一份文档，所以"冲突就是当前那篇的冲突"。分栏之后几格可以同时开着几篇，
 * 而**非当前那格**也会进冲突态（外部改了它、它自己保存时撞上外部改动）—— 只渲染当前文档
 * 的冲突，那一格的横幅就永远不出现：内容既不落盘、用户也不知道，属于静默丢改动。
 *
 * 取舍（刻意保持简单）：一次只显示**一条**横幅 —— 优先当前文档那一篇，没有就看第一篇
 * 冲突的。横幅上写明是哪一篇，用户处理完它，下一条（若有）自然接着出现。
 * 不做"多条堆叠"：横幅在窗口顶部，堆两条就会把正文挤走，而冲突是要用户**停下来**处理的事，
 * 一条一条来反而更清楚。
 */

import { useState } from 'react'

import { Icon } from '@/components/Icon'
import { formatClock } from '@/domain/format'
import { displayPath } from '@/domain/paths'
import { useNoteStore } from '@/state/note-store'

export function ConflictBanner() {
  /*
   * 选哪一篇：当前文档优先，否则**按打开顺序**取第一篇冲突的（`Object.keys` 的插入序
   * 就是打开顺序）。返回值是字符串，所以引用稳定 —— 不会因为一次按键就重渲染。
   */
  const conflictPath = useNoteStore((state) => {
    const active = state.activePath ?? state.doc?.relPath ?? null
    if (active !== null && state.docs[active]?.conflict != null) return active
    return Object.keys(state.docs).find((relPath) => state.docs[relPath]?.conflict != null) ?? null
  })
  const conflict = useNoteStore((state) =>
    conflictPath === null ? null : (state.docs[conflictPath]?.conflict ?? null),
  )
  const doc = useNoteStore((state) =>
    conflictPath === null ? null : (state.docs[conflictPath] ?? null),
  )
  const resolveConflictFor = useNoteStore((state) => state.resolveConflictFor)
  const [busy, setBusy] = useState(false)

  if (conflict === null || doc === null || conflictPath === null) return null

  const run = async (choice: 'overwrite' | 'reload'): Promise<void> => {
    setBusy(true)
    try {
      await resolveConflictFor(conflictPath, choice)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mn-conflict" role="alert">
      <Icon name="alert" size="md" />
      <div className="mn-conflict__body">
        <strong title={doc.relPath}>「{displayPath(doc.relPath)}」已被外部修改</strong>
        <span>
          编辑器中的内容基于 {formatClock(doc.openedAt)} 读取的版本，磁盘上的版本更新于{' '}
          {formatClock(conflict.detectedAt)}。为避免覆盖别人的改动，保存已暂停。
        </span>
      </div>
      <div className="mn-conflict__actions">
        <button
          type="button"
          className="mn-button mn-button--danger"
          disabled={busy}
          onClick={() => void run('overwrite')}
        >
          用我的内容覆盖
        </button>
        <button
          type="button"
          className="mn-button"
          disabled={busy}
          onClick={() => void run('reload')}
        >
          丢弃我的修改并重新加载
        </button>
      </div>
    </div>
  )
}
