/**
 * 收件箱视图：列出"还没整理"的笔记，一条条打开或归档出去（ADR-0057 / 设计 03 §8）。
 *
 * 三条设计取舍：
 *
 * 1. **归档是"移出收件箱"，目标当场输入**：走 `app/actions.moveEntry`（与拖拽、「移动到…」
 *    同一条链路：宿主搬文件 + 改写全库链接 + 条目表换路径）。刻意**不**用
 *    `requestMove` 去唤 `features/vault/MoveDialog` —— 那个对话框由 `FileTree` 挂载，
 *    侧栏隐藏（`Ctrl+B`）时它根本不在树上，事件会**静默无效**：收件箱的归档不能有
 *    "看情况失效"的入口。目录候选走 `<datalist>`（与 MoveDialog 同一套做法：可打字直达、
 *    也可点选，输入不存在的目录由宿主创建）。
 * 2. **"还在收件箱里"的目标被拦在按钮上**：归档的语义是移出目录，输入 `Inbox` 或它的子目录
 *    等于没归档。判据复用 `isInboxPath`（唯一那一份），不在这里写第二个字符串比较。
 * 3. **不做虚拟列表**：收件箱的意义就是尽快清空，几千条的情形应当先解决"为什么没整理"，
 *    而不是给它做一套只为更大列表存在的渲染机制。
 *
 * 打开一条笔记会**先关掉这一层**：模态盖着正文，用户点开却什么都看不见，那一步就白点了。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'

import { moveEntry, openNote } from '@/app/actions'
import { isInboxPath } from '@/domain/inbox'
import { displayName, displayPath } from '@/domain/paths'
import { collectDirectoryPaths } from '@/domain/tree'
import { useInboxStore } from '@/state/inbox-store'
import { useVaultStore } from '@/state/vault-store'

import { useInboxDir, useInboxEntries } from './use-inbox-entries'

import './inbox-dialog.css'

/** 最后改动时间 → "3 分钟前"（绝对时间放在 `title` 里；与回收站对话框同一口径）。 */
function formatCapturedAt(ms: number | null, now: number): string {
  if (ms === null) return '时间未知'
  const delta = Math.max(0, now - ms)
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`
  return `${Math.floor(delta / 86_400_000)} 天前`
}

export function InboxDialog() {
  const entries = useInboxEntries()
  const dir = useInboxDir()
  const tree = useVaultStore((state) => state.tree)

  /** 正在"归档…"的那一条（点开输入框后才非 null）。 */
  const [archiving, setArchiving] = useState<string | null>(null)
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  /** "现在"只在挂载时取一次：相对时间不需要逐秒跳动（同回收站对话框）。 */
  const [now] = useState(() => Date.now())
  const targetInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (archiving !== null) targetInputRef.current?.focus()
  }, [archiving])

  const directories = useMemo(() => collectDirectoryPaths(tree), [tree, entries.length])
  // 面板一次只开一个，id 不需要按目录/条目区分（同屏只有一个「归档…」表单）
  const datalistId = 'mn-inbox-dirs'

  const close = (): void => {
    useInboxStore.getState().close()
  }

  const open = (relPath: string): void => {
    close()
    void openNote(relPath)
  }

  const submitArchive = async (event: FormEvent, relPath: string): Promise<void> => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      const outcome = await moveEntry(relPath, target.trim(), { updateLinks: true })
      // 成功才收起输入框；失败（重名、路径非法）留着它，用户改一个名字就能重试
      if (outcome !== null) {
        setArchiving(null)
        setTarget('')
      }
    } finally {
      setBusy(false)
    }
  }

  /** 目标还落在收件箱里 = 这一步不叫归档（判据与条目判定同一份）。 */
  const staysInInbox = target.trim() !== '' && isInboxPath(target.trim(), dir)

  return (
    <div
      className="mn-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div
        className="mn-dialog mn-inbox"
        role="dialog"
        aria-modal="true"
        aria-label="收件箱"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            // 先收输入框：Esc 的第一下应该是"取消这一步"，而不是把整个面板关掉
            if (archiving !== null) setArchiving(null)
            else close()
          }
        }}
      >
        <header className="mn-inbox__header">
          <h2 className="mn-inbox__title">收件箱</h2>
          <span className="mn-inbox__count" data-inbox-count={entries.length}>
            {entries.length === 0 ? '没有未整理的笔记' : `${entries.length} 条未整理`}
          </span>
          <button
            type="button"
            className="mn-button mn-button--primary"
            onClick={() => useInboxStore.getState().openCapture()}
          >
            捕获
          </button>
          <button type="button" className="mn-button" onClick={close} aria-label="关闭收件箱">
            关闭
          </button>
        </header>

        <p className="mn-inbox__hint">
          <code>{dir}/</code> 里的 Markdown 都是未整理的条目（子目录也算）。
          「归档…」把它移出这个目录 —— 去哪里由你填，链接会被一起改写；
          「捕获」（<code>Ctrl+Shift+I</code>）随手记一条。
        </p>

        {entries.length === 0 ? (
          <p className="mn-inbox__empty" data-inbox-empty="true">
            收件箱是空的。记完就走的入口是「捕获」，落进来的笔记会按时间倒序列在这里。
          </p>
        ) : (
          <ul className="mn-inbox__list">
            {entries.map((entry) => (
              <li className="mn-inbox__row" key={entry.relPath} data-inbox-entry={entry.relPath}>
                <div className="mn-inbox__meta">
                  <button
                    type="button"
                    className="mn-inbox__name"
                    title={`打开 ${entry.relPath}`}
                    onClick={() => open(entry.relPath)}
                  >
                    {displayName(entry.relPath)}
                  </button>
                  <span className="mn-inbox__path" title={entry.relPath}>
                    {displayPath(entry.relPath)}
                  </span>
                  <span className="mn-inbox__time">
                    <span title={entry.mtimeMs === null ? '拿不到修改时间' : new Date(entry.mtimeMs).toLocaleString()}>
                      {formatCapturedAt(entry.mtimeMs, now)}
                    </span>
                  </span>
                </div>

                <div className="mn-inbox__actions">
                  <button
                    type="button"
                    className="mn-button mn-button--primary"
                    onClick={() => open(entry.relPath)}
                  >
                    打开
                  </button>
                  <button
                    type="button"
                    className="mn-button"
                    data-inbox-archive={entry.relPath}
                    title={`把「${displayName(entry.relPath)}」移出收件箱（归档）`}
                    onClick={() => {
                      setArchiving(entry.relPath)
                      setTarget('')
                    }}
                  >
                    归档…
                  </button>
                </div>

                {archiving === entry.relPath && (
                  <form
                    className="mn-inbox__form"
                    onSubmit={(event) => void submitArchive(event, entry.relPath)}
                  >
                    <label className="mn-inbox__label" htmlFor="mn-inbox-target">
                      归档到哪个目录（Vault 相对路径，留空 = Vault 根）
                    </label>
                    <input
                      id="mn-inbox-target"
                      ref={targetInputRef}
                      className="mn-input mn-inbox__input"
                      list={datalistId}
                      value={target}
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(event) => setTarget(event.target.value)}
                    />
                    <button
                      type="submit"
                      className="mn-button mn-button--primary"
                      disabled={busy || staysInInbox}
                      title={
                        staysInInbox
                          ? '目标还在收件箱里：归档是"移出这个目录"，换个目标（或留空 = Vault 根）'
                          : '移出收件箱（宿主会一并改写指向它的链接）'
                      }
                    >
                      {busy ? '移动中…' : '移动'}
                    </button>
                    <button type="button" className="mn-button" onClick={() => setArchiving(null)}>
                      取消
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}

        {/* 目录候选只渲染一次（每个输入框共用同一份 datalist） */}
        <datalist id={datalistId}>
          {directories.map((directory) => (
            <option key={directory} value={directory} />
          ))}
        </datalist>
      </div>
    </div>
  )
}
