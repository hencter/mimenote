/** 冲突横幅：宿主检测到"文件被外部修改"时出现，必须由用户决定如何取舍（ADR-0004）。 */

import { useState } from 'react'

import { Icon } from '@/components/Icon'
import { formatClock } from '@/domain/format'
import { displayPath } from '@/domain/paths'
import { useNoteStore } from '@/state/note-store'

export function ConflictBanner() {
  const conflict = useNoteStore((state) => state.conflict)
  const doc = useNoteStore((state) => state.doc)
  const resolveConflict = useNoteStore((state) => state.resolveConflict)
  const [busy, setBusy] = useState(false)

  if (conflict === null || doc === null) return null

  const run = async (choice: 'overwrite' | 'reload'): Promise<void> => {
    setBusy(true)
    try {
      await resolveConflict(choice)
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
