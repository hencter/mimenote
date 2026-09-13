/** 状态栏：Vault 概览 · 当前文档统计 · 保存状态与实测耗时 · 视图/主题/片段开关。 */

import { useDeferredValue, useMemo } from 'react'

import { Icon } from '@/components/Icon'
import { formatBytes, formatClock, formatDuration } from '@/domain/format'
import { computeStats } from '@/domain/stats'
import { currentAdapterKind } from '@/ipc/client'
import { useNoteStore } from '@/state/note-store'
import { toggleSnippets } from '@/app/actions'
import { useUiStore, type ViewMode } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'
import { THEMES } from '@/theme/apply'

const VIEW_MODES: ReadonlyArray<{ mode: ViewMode; label: string; icon: 'pencil' | 'columns' | 'eye' }> = [
  { mode: 'editor', label: '仅编辑', icon: 'pencil' },
  { mode: 'split', label: '分栏', icon: 'columns' },
  { mode: 'preview', label: '仅预览', icon: 'eye' },
]

export function StatusBar() {
  const info = useVaultStore((state) => state.info)
  const relPath = useNoteStore((state) => state.doc?.relPath ?? null)
  const text = useNoteStore((state) => state.doc?.text ?? '')
  const status = useNoteStore((state) => state.status)
  const dirty = useNoteStore((state) => state.dirty)
  const loadMs = useNoteStore((state) => state.loadMs)
  const lastSavedAt = useNoteStore((state) => state.lastSavedAt)
  const lastWriteMs = useNoteStore((state) => state.lastWriteMs)
  const lastWriteBytes = useNoteStore((state) => state.lastWriteBytes)
  const diskStats = useNoteStore((state) => state.diskStats)

  const deferredText = useDeferredValue(text)
  const stats = useMemo(
    () => (relPath === null ? null : computeStats(deferredText)),
    [relPath, deferredText],
  )

  const viewMode = useUiStore((state) => state.viewMode)
  const setViewMode = useUiStore((state) => state.setViewMode)
  const themeId = useUiStore((state) => state.themeId)
  const setThemeId = useUiStore((state) => state.setThemeId)
  const snippetsEnabled = useUiStore((state) => state.snippetsEnabled)

  const saveLabel =
    status === 'conflict'
      ? '冲突待处理'
      : status === 'saving'
        ? '保存中…'
        : dirty
          ? '未保存'
          : lastSavedAt === null
            ? '未修改'
            : `已保存 ${formatClock(lastSavedAt)}`

  const saveTone =
    status === 'conflict' ? 'danger' : status === 'saving' || dirty ? 'warn' : 'ok'

  return (
    <footer className="mn-statusbar">
      <div className="mn-statusbar__group">
        <Icon name="folder" size={13} />
        <span title={info?.rootPath ?? ''}>{info?.name ?? '未打开 Vault'}</span>
        {info !== null && (
          <span className="mn-statusbar__muted">
            {info.noteCount} 篇 · {info.entryCount} 条目 · 扫描 {formatDuration(info.scanMs)}
          </span>
        )}
      </div>

      {stats !== null && (
        <div className="mn-statusbar__group" title="编辑器内即时统计（CJK 感知）">
          <span>{stats.words} 词</span>
          <span className="mn-statusbar__muted">
            {stats.chars} 字 · {stats.lines} 行 · 约 {stats.readingMinutes} 分钟
          </span>
          {loadMs > 0 && <span className="mn-statusbar__muted">读取 {loadMs}ms</span>}
          {diskStats !== null && diskStats.words !== stats.words && (
            <span className="mn-statusbar__muted" title="磁盘上的版本（由 Rust 侧统计）">
              磁盘 {diskStats.words} 词
            </span>
          )}
        </div>
      )}

      <div className="mn-statusbar__spacer" />

      <div className="mn-statusbar__group">
        <span className={`mn-status-dot mn-status-dot--${saveTone}`} aria-hidden="true" />
        <span>{saveLabel}</span>
        {lastWriteMs !== null && (
          <span className="mn-statusbar__muted" title="上一次写入耗时（含 fsync）">
            写入 {formatDuration(lastWriteMs)}
            {lastWriteBytes !== null ? ` · ${formatBytes(lastWriteBytes)}` : ''}
          </span>
        )}
      </div>

      <div className="mn-statusbar__group mn-statusbar__group--buttons">
        {VIEW_MODES.map((item) => (
          <button
            key={item.mode}
            type="button"
            className={`mn-icon-button${viewMode === item.mode ? ' mn-icon-button--active' : ''}`}
            title={`${item.label}（Ctrl+E 循环切换）`}
            aria-label={item.label}
            aria-pressed={viewMode === item.mode}
            onClick={() => setViewMode(item.mode)}
          >
            <Icon name={item.icon} size={14} />
          </button>
        ))}
      </div>

      <div className="mn-statusbar__group">
        <button
          type="button"
          className={`mn-icon-button${snippetsEnabled ? ' mn-icon-button--active' : ''}`}
          title={`Vault CSS 片段：${snippetsEnabled ? '已启用' : '已停用'}（.mimenote/snippets/*.css）`}
          aria-label="启用或停用 CSS 片段"
          aria-pressed={snippetsEnabled}
          onClick={() => void toggleSnippets()}
        >
          <Icon name="palette" size={14} />
        </button>
        <label className="mn-statusbar__select">
          <span className="mn-visually-hidden">主题</span>
          <select
            value={themeId}
            title="切换主题（Ctrl+Alt+T）"
            onChange={(event) => setThemeId(event.target.value)}
          >
            {THEMES.map((theme) => (
              <option key={theme.id} value={theme.id}>
                {theme.name}
              </option>
            ))}
          </select>
        </label>
        <span className="mn-statusbar__muted" title="IPC 适配器">
          {currentAdapterKind() ?? '—'}
        </span>
      </div>
    </footer>
  )
}
