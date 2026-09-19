/** 状态栏：Vault 概览 · 当前文档统计 · 保存状态与实测耗时 · 视图/主题/片段开关。 */

import { useDeferredValue, useMemo } from 'react'

import { Icon } from '@/components/Icon'
import { formatBytes, formatClock, formatDuration } from '@/domain/format'
import { computeStats } from '@/domain/stats'
import { currentAdapterKind } from '@/ipc/client'
import { displayPath } from '@/domain/paths'
import { useNoteStore } from '@/state/note-store'
import { toggleSnippets } from '@/app/actions'
import { useUiStore, type ViewMode } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'
import { THEMES } from '@/theme/apply'

const VIEW_MODES: ReadonlyArray<{ mode: ViewMode; label: string; icon: 'pencil' | 'eye' | 'links' }> = [
  { mode: 'edit', label: '编辑（所见即所得）', icon: 'pencil' },
  { mode: 'read', label: '阅读（渲染后）', icon: 'eye' },
  { mode: 'graph', label: '知识图谱', icon: 'links' },
]

/**
 * 文档视图（编辑 / 阅读）与知识图谱**分开成两组**（用户反馈："图谱独立按钮不和编辑/预览的
 * 快捷键放一块"）：前两个是"同一篇笔记的两种呈现"，图谱是另一个视图 —— 中间用一条细竖线
 * 隔开，点错组的概率更低。
 */
const DOCUMENT_VIEW_MODES = VIEW_MODES.filter((item) => item.mode !== 'graph')
const GRAPH_VIEW_MODE = VIEW_MODES.find((item) => item.mode === 'graph')!

export function StatusBar() {
  const info = useVaultStore((state) => state.info)
  const relPath = useNoteStore((state) => state.doc?.relPath ?? null)
  /*
   * "我在看什么"：打开着附件就是附件，否则是当前笔记。
   *
   * 这一格原先在标题栏中区（ADR-0029）；用户定稿"标题栏与标签栏并成一行、中区给标签"之后，
   * 中区让给了标签栏，路径落到状态栏 —— 标签上已经写着文件名，悬停标签能看全路径，
   * 所以这里要的是"完整相对路径"，恰好状态栏那一条也放得下。
   */
  const openedFile = useUiStore((state) => state.openedFile)
  const shownPath = openedFile ?? relPath
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
  const linksPanelVisible = useUiStore((state) => state.linksPanelVisible)

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
      {shownPath !== null && (
        <div className="mn-statusbar__group">
          <Icon name={openedFile === null ? 'pencil' : 'file'} size="xs" />
          {/* 可见文字不带 `.md`（`displayPath`，ADR-0030）；真实路径给 `title` 与 `data-main-path` */}
          <span title={shownPath} data-main-path={shownPath}>
            {displayPath(shownPath)}
          </span>
          {openedFile === null && status === 'saving' && (
            <span className="mn-statusbar__muted">保存中…</span>
          )}
        </div>
      )}

      <div className="mn-statusbar__group">
        <Icon name="folder" size="xs" />
        <span title={info?.rootPath ?? ''}>{info?.name ?? '未打开 Vault'}</span>
        {info !== null && (
          <span className="mn-statusbar__muted">
            {info.noteCount} 篇 · {info.entryCount} 条目 · 扫描 {formatDuration(info.scanMs)}
            {/* 标题栏退役后（ADR-0038）这一份是**唯一**的库统计，截断标记也得跟过来 */}
            {info.truncated && ' · 已截断'}
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
        {DOCUMENT_VIEW_MODES.map((item) => (
          <button
            key={item.mode}
            type="button"
            className={`mn-icon-button${viewMode === item.mode ? ' mn-icon-button--active' : ''}`}
            title={`${item.label}（Ctrl+E 循环切换）`}
            aria-label={item.label}
            aria-pressed={viewMode === item.mode}
            onClick={() => setViewMode(item.mode)}
          >
            <Icon name={item.icon} size="sm" />
          </button>
        ))}
      </div>

      {/* 图谱单独一组：它不是"这一篇的另一种呈现"，与编辑/阅读之间画一条细竖线 */}
      <span className="mn-statusbar__divider" aria-hidden="true" />

      <div className="mn-statusbar__group mn-statusbar__group--buttons">
        <button
          type="button"
          className={`mn-icon-button${viewMode === GRAPH_VIEW_MODE.mode ? ' mn-icon-button--active' : ''}`}
          title={`${GRAPH_VIEW_MODE.label}（Ctrl+G）`}
          aria-label={GRAPH_VIEW_MODE.label}
          aria-pressed={viewMode === GRAPH_VIEW_MODE.mode}
          onClick={() => setViewMode(GRAPH_VIEW_MODE.mode)}
        >
          <Icon name={GRAPH_VIEW_MODE.icon} size="sm" />
        </button>
      </div>

      <div className="mn-statusbar__group">
        <button
          type="button"
          className={`mn-icon-button${linksPanelVisible ? ' mn-icon-button--active' : ''}`}
          title="链接面板：反向链接 / 出链（Ctrl+Shift+L）"
          aria-label="链接面板"
          aria-pressed={linksPanelVisible}
          onClick={() => useUiStore.getState().toggleLinksPanel()}
        >
          <Icon name="links" size="sm" />
        </button>
        <button
          type="button"
          className={`mn-icon-button${snippetsEnabled ? ' mn-icon-button--active' : ''}`}
          title={`Vault CSS 片段：${snippetsEnabled ? '已启用' : '已停用'}（.mimenote/snippets/*.css）`}
          aria-label="启用或停用 CSS 片段"
          aria-pressed={snippetsEnabled}
          onClick={() => void toggleSnippets()}
        >
          <Icon name="palette" size="sm" />
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
