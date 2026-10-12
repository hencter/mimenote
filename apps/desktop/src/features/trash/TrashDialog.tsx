/**
 * 回收站对话框：列出删掉的东西，把其中一条**恢复回来**，或者**永久删掉**。
 *
 * ## 为什么值得一个界面
 * 删除早就走"移进 `.mimenote/trash` + 写台账"（从不 `unlink`，见 ADR 与 `mn_core::trash`），
 * 但在此之前**应用里没有任何办法把东西拿回来** —— 用户只能去文件管理器里翻
 * `.mimenote/trash/`，而那里的文件名前面还带着时间戳前缀。README 的已知限制里写着
 * "恢复界面在 M2"，这一条一直挂着；这个对话框把它补上。
 * **永久删除/清空**则是同一处长期的另一半：在此之前回收站**没有任何出口**真删东西，
 * 用户只能去文件管理器里手工清（清完台账还会留下孤儿记录）。
 *
 * ## 三条交互上的硬要求
 * 1. **绝不覆盖**：目标位置已经有东西时宿主返回 `ALREADY_EXISTS`，这里**不重试、不覆盖**，
 *    而是把「恢复为…」这条路指出来（输入框预填原路径，用户改个名再恢复）；
 * 2. **孤儿记录要说清**：台账里有、`.mimenote/trash` 里已经没有的那些（用户手工清过回收站）
 *    标成"文件已不在回收站"并禁用「恢复」，而不是让用户点了才吃到 `NOT_FOUND`。
 *    它们的「永久删除」语义不同 —— 那一步只清掉**台账记录**，不是删文件，按钮就写「清掉记录」；
 * 3. **结果如实汇报**：恢复成功要说明"恢复到哪、顺手建了哪些目录"，需要重扫时由调用方
 *    触发一次静默重扫（目录恢复）—— 界面不能假装"已经同步好了"。永久删除同理：
 *    "删了 N 项、释放 X"之外，被跳过/失败的**逐条**列出理由（宿主逐条校验台账，见下）。
 *
 * ## 永久删除的两条纪律（都落在界面上）
 * * **二次确认且措辞不可恢复**：两条路（行内「永久删除」与顶部「清空回收站」）都走
 *   `confirm-store` 的 `ask`（`danger: true`），文案明确写"不能恢复"——"删除到回收站"那种
 *   "可以随时恢复"的话在这里一个字都不能出现，否则用户按下去就是数据没了；
 * * **不隐藏宿主的拒绝**：宿主对每条台账记录重新跑一遍 `path_guard`（台账是可手改的 JSONL），
 *   校验不过的那条**不执行**，于是它会留在列表里并给出理由 —— 界面把这些理由原话带出来。
 *
 * ## 与删除确认的关系
 * 删除确认框里有一句"可在回收站里恢复"（删除不再是单向动作）。两者的文案都指向这个对话框。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { basename, displayName, displayPath } from '@/domain/paths'
import { useConfirmStore } from '@/state/confirm-store'
import { useTrashStore } from '@/state/trash-store'
import { toast } from '@/state/toast-store'
import { useUiStore } from '@/state/ui-store'
import { useVaultStore } from '@/state/vault-store'
import type { MimenoteError, PurgeFailure, PurgeSummary, RestoreSummary, TrashEntry } from '@/ipc/types'

import './trash-dialog.css'

/** 字节数 → 可读大小（Dialog 里只用来给用户一个量级感）。 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 删除时间 → "3 分钟前"这种相对说法（绝对时间放在 `title` 里）。 */
function formatDeletedAt(ms: number, now: number): string {
  const delta = Math.max(0, now - ms)
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`
  return `${Math.floor(delta / 86_400_000)} 天前`
}

/** 宿主的稳定错误码 → 人话（保持与其它面板一致的口径）。 */
function explainError(error: MimenoteError | null): string {
  if (error === null) return '未知错误'
  if (error.code === 'ALREADY_EXISTS') {
    return '原位置已经有别的文件了 —— 用「恢复为…」换个名字放回去（绝不覆盖）'
  }
  if (error.code === 'NOT_FOUND') {
    return '这条记录对应的文件已经不在回收站里了（可能被手工清理过）'
  }
  if (error.code === 'PATH_INVALID' || error.code === 'PATH_ESCAPE') {
    return '那个路径不合法（不能指向 .mimenote 里，也不能带 .. 越出 Vault）'
  }
  return error.message
}

/**
 * 一条**没能永久删除**的理由（`PurgeFailure.reason`）→ 人话。
 *
 * 换错误码在这里没有意义：`describeError` 是按错误码翻译的，而这些拒绝恰恰**不是**
 * "整批操作失败"，它们是"这一条我没敢动"。宿主写的那句原话（`message`）才是用户能据以
 * 行动的东西，所以这里只给一句"为什么类别"，原话照抄在后面。
 */
function explainPurgeFailure(failure: PurgeFailure): string {
  switch (failure.reason) {
    case 'path-invalid':
      return '台账记录指向的不是回收站目录下的条目，已拒绝执行'
    case 'path-escape':
      return '台账记录指向了 Vault 之外（或被符号链接带出去），已拒绝执行'
    case 'io':
      return '删除失败'
    default:
      return '未能删除'
  }
}

export function TrashDialog() {
  const open = useUiStore((state) => state.trashDialogOpen)
  const close = useCallback((): void => {
    useUiStore.getState().setTrashDialogOpen(false)
  }, [])

  const entries = useTrashStore((state) => state.entries)
  const status = useTrashStore((state) => state.status)
  const error = useTrashStore((state) => state.error)
  const restoringId = useTrashStore((state) => state.restoringId)
  const purgingId = useTrashStore((state) => state.purgingId)

  /** 正在"恢复为…"的那一条（点开输入框后才非 null）。 */
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [target, setTarget] = useState('')
  /** "现在"只在打开时取一次：相对时间不需要逐秒跳动。 */
  const [now] = useState(() => Date.now())

  const targetInputRef = useRef<HTMLInputElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) {
      setRenamingId(null)
      setTarget('')
      return
    }
    void useTrashStore.getState().refresh()
  }, [open])

  useEffect(() => {
    if (renamingId !== null) targetInputRef.current?.focus()
  }, [renamingId])

  if (!open) return null

  const alive = entries.filter((entry) => entry.present).length
  const orphans = entries.length - alive
  const busy = restoringId !== null || purgingId !== null

  const restore = async (entry: TrashEntry, asPath?: string): Promise<void> => {
    // 关掉"恢复为…"的输入框：无论成功失败都不该留着它挡住列表
    setRenamingId(null)
    const summary = await useTrashStore.getState().restore(entry.id, asPath)
    if (summary === null) {
      const failure = useTrashStore.getState().error
      toast.error('恢复失败', explainError(failure))
      return
    }
    report(summary, entry.isDir)
  }

  /**
   * 永久删除一条（行内按钮）。
   *
   * 二次确认的文案按 `entry.present` **分开写**：孤儿记录的那一步只清台账记录，
   * 说成"永久删除文件"就是在骗用户（那个文件早就不在了）。
   */
  const purge = async (entry: TrashEntry): Promise<void> => {
    const name = entry.isDir ? basename(entry.originalRelPath) : displayName(entry.originalRelPath)
    const confirmed = await useConfirmStore.getState().ask(
      entry.present
        ? {
            title: entry.isDir ? '永久删除这个文件夹？' : '永久删除这篇笔记？',
            message:
              `「${entry.originalRelPath}」会被**真的从磁盘上删掉**（整棵内容一起），` +
              '并从回收站台账里去掉这条记录。\n\n这个操作**不能恢复**，也没有第二次机会。',
            confirmLabel: '永久删除',
            danger: true,
          }
        : {
            title: '清掉这条记录？',
            message:
              `「${entry.originalRelPath}」在回收站里**已经找不到文件了**，` +
              '这一步只是把台账里这条记录去掉（不会删任何文件，也没有空间可释放）。',
            confirmLabel: '清掉记录',
            danger: true,
          },
    )
    if (!confirmed) return

    const summary = await useTrashStore.getState().purge(entry.id, true)
    if (summary === null) {
      toast.error('永久删除失败', explainError(useTrashStore.getState().error))
      return
    }
    reportPurge(summary, `已永久删除「${name}」`)
  }

  /** 清空回收站（顶部按钮）。 */
  const emptyAll = async (): Promise<void> => {
    const confirmed = await useConfirmStore.getState().ask({
      title: '清空回收站？',
      message:
        `回收站里的 ${entries.length} 条记录（${alive} 项文件/文件夹${orphans > 0 ? `，另有 ${orphans} 条只有台账记录` : ''}）` +
        '会被**真的从磁盘上删掉**，台账也会被清空。\n\n这个操作**不能恢复** —— 要留下哪一条，请先用「恢复」或「恢复为…」把它拿回来。',
      confirmLabel: '清空回收站',
      danger: true,
    })
    if (!confirmed) return

    const summary = await useTrashStore.getState().emptyTrash(true)
    if (summary === null) {
      toast.error('清空回收站失败', explainError(useTrashStore.getState().error))
      return
    }
    reportPurge(summary, '已清空回收站')
  }

  return (
    <div
      className="mn-overlay"
      role="presentation"
      onMouseDown={(event) => {
        // 点遮罩关闭（点对话框内部不关）
        if (event.target === event.currentTarget) close()
      }}
    >
      <div
        className="mn-dialog mn-trash"
        role="dialog"
        aria-modal="true"
        aria-label="回收站"
        ref={dialogRef}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            close()
          }
        }}
      >
        <header className="mn-trash__header">
          <h2 className="mn-trash__title">回收站</h2>
          <span className="mn-trash__count" data-trash-count={entries.length}>
            {status === 'ready'
              ? entries.length === 0
                ? '还没有删过东西'
                : `${alive} 条可恢复${orphans > 0 ? ` · ${orphans} 条文件已不在回收站` : ''}`
              : '读取中…'}
          </span>
          <button
            type="button"
            className="mn-button mn-button--danger"
            data-trash-empty-all="true"
            disabled={entries.length === 0 || busy}
            title={
              entries.length === 0
                ? '回收站里没有东西'
                : `把回收站里的 ${entries.length} 条记录全部永久删除（不能恢复）`
            }
            onClick={() => void emptyAll()}
          >
            {purgingId === '' ? '清空中…' : '清空回收站'}
          </button>
          <button type="button" className="mn-button" onClick={close} aria-label="关闭回收站">
            关闭
          </button>
        </header>

        <p className="mn-trash__hint">
          删除只是把文件移进 <code>.mimenote/trash/</code>（不 `unlink`）并记一笔台账。
          恢复会把它放回**原来的位置**；那里已经有别的文件时**绝不覆盖**，改个名字用「恢复为…」放回去。
          「永久删除」/「清空回收站」才是真的从磁盘上删掉，**不能恢复**。
        </p>

        {status === 'error' && (
          <p className="mn-trash__error" role="alert">
            读不到回收站台账：{explainError(error)}{' '}
            <button
              type="button"
              className="mn-button"
              onClick={() => void useTrashStore.getState().refresh()}
            >
              重试
            </button>
          </p>
        )}

        {status !== 'error' && entries.length === 0 && status === 'ready' && (
          <p className="mn-trash__empty" data-trash-empty="true">
            回收站是空的。删掉的笔记会出现在这里，随时能放回去。
          </p>
        )}

        <ul className="mn-trash__list">
          {entries.map((entry) => (
            <li className="mn-trash__row" key={entry.id} data-trash-entry={entry.id}>
              <div className="mn-trash__meta">
                <span className="mn-trash__name" title={entry.originalRelPath}>
                  {entry.isDir ? '📁 ' : ''}
                  {entry.isDir ? basename(entry.originalRelPath) : displayName(entry.originalRelPath)}
                </span>
                <span className="mn-trash__path" title={entry.originalRelPath}>
                  {entry.isDir ? entry.originalRelPath : displayPath(entry.originalRelPath)}
                </span>
                <span className="mn-trash__sub">
                  <span title={new Date(entry.deletedAtMs).toLocaleString()}>
                    {formatDeletedAt(entry.deletedAtMs, now)}
                  </span>
                  {' · '}
                  {entry.isDir ? '文件夹' : formatSize(entry.sizeBytes)}
                  {!entry.present && (
                    <span className="mn-trash__orphan" data-trash-orphan="true">
                      {' '}
                      · 文件已不在回收站
                    </span>
                  )}
                </span>
              </div>

              <div className="mn-trash__actions">
                <button
                  type="button"
                  className="mn-button mn-button--primary"
                  disabled={!entry.present || busy}
                  title={entry.present ? '放回原来的位置' : '回收站里已经没有这个文件了'}
                  onClick={() => void restore(entry)}
                >
                  {restoringId === entry.id ? '恢复中…' : '恢复'}
                </button>
                <button
                  type="button"
                  className="mn-button"
                  disabled={!entry.present || busy}
                  onClick={() => {
                    setRenamingId(entry.id)
                    setTarget(entry.originalRelPath)
                  }}
                >
                  恢复为…
                </button>
                {/* 孤儿记录走的是"清台账记录"而不是"删文件"，按钮名与确认文案都要跟着变 */}
                <button
                  type="button"
                  className="mn-button mn-button--danger"
                  data-trash-purge={entry.id}
                  disabled={busy}
                  title={
                    entry.present
                      ? '真的从磁盘上删掉这条（不能恢复）'
                      : '回收站里已经没有这个文件了：这一步只清掉台账记录'
                  }
                  onClick={() => void purge(entry)}
                >
                  {purgingId === entry.id ? '删除中…' : entry.present ? '永久删除' : '清掉记录'}
                </button>
              </div>

              {renamingId === entry.id && (
                <form
                  className="mn-trash__form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    const wanted = target.trim()
                    if (wanted === '') return
                    void restore(entry, wanted)
                  }}
                >
                  <label className="mn-trash__label" htmlFor={`mn-trash-target-${entry.id}`}>
                    恢复到哪个路径（Vault 相对路径）
                  </label>
                  <input
                    id={`mn-trash-target-${entry.id}`}
                    className="mn-input"
                    ref={targetInputRef}
                    value={target}
                    onChange={(event) => setTarget(event.target.value)}
                    spellCheck={false}
                  />
                  <button type="submit" className="mn-button mn-button--primary" disabled={busy}>
                    恢复
                  </button>
                  <button type="button" className="mn-button" onClick={() => setRenamingId(null)}>
                    取消
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/** 恢复成功后的提示 + 一次静默的条目表刷新。 */
function report(summary: RestoreSummary, isDir: boolean): void {
  const where = summary.restoredToOriginalPlace
    ? '已恢复到原来的位置'
    : `已恢复到 ${summary.restoredRelPath}`
  const dirs =
    summary.createdDirs.length === 0
      ? ''
      : `（顺手建了 ${summary.createdDirs.length} 个目录：${summary.createdDirs.join('、')}）`
  toast.success(`${isDir ? basename(summary.restoredRelPath) : displayName(summary.restoredRelPath)} ${where}`, dirs.replace(/^（|）$/g, ''))

  // **总是**刷新条目表与文件树：宿主的恢复只更新它自己那份条目表与索引，而前端这一份是
  // 打开 Vault 时拍的快照 —— 不刷新就会出现"文件回到磁盘了、树里却没有那一行"（真踩过）。
  // 目录恢复尤其需要（一次带回几百个文件）；单篇也走同一条路，免得两套收尾各自漂移。
  void useVaultStore.getState().syncAfterRestore()
}

/**
 * 永久删除之后的汇报：**如实**说出删了几项、释放了多少、哪几条没成、为什么。
 *
 * 刻意不用一句"操作成功"糊过去：一次清空可能删掉了 12 项、同时有 1 条台账记录指向
 * 回收站之外而**被拒绝执行**（那条记录还在列表里）。只报前半句，用户会以为回收站已经干净了。
 *
 * 也不需要刷新条目表：删的只是 `.mimenote/trash` 里的东西，它本来就不在扫描范围里
 * （`.mimenote/` 被扫描器忽略），文件树与索引一个字节都没变。
 */
function reportPurge(summary: PurgeSummary, title: string): void {
  const parts: string[] = [`永久删除了 ${summary.removed.length} 项，释放 ${formatSize(summary.bytesFreed)}`]
  // `missing` 与 `removed` 分开说：它们对用户是两件事（一个是删了东西，一个是清了记录）
  if (summary.missing.length > 0) parts.push(`另清掉 ${summary.missing.length} 条「文件已不在回收站」的记录`)
  const message = `${title}：${parts.join('；')}`

  if (summary.failed.length === 0) {
    toast.success(message)
    return
  }

  // 失败逐条列出理由（宿主写的那句话是原话，比任何概括都准）
  const detail = summary.failed
    .map((failure) => `${failure.originalRelPath}：${explainPurgeFailure(failure)}（${failure.message}）`)
    .join('\n')
  toast.warn(
    `${message}；${summary.failed.length} 条未能删除（记录仍在列表里）`,
    detail,
  )
}

/** 供命令面板/菜单调用：打开回收站（并保证面板里能看到最新的那条）。 */
export function openTrashDialog(): void {
  useUiStore.getState().setTrashDialogOpen(true)
}
