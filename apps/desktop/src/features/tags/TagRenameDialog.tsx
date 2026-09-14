/**
 * 标签重命名 / 合并对话框，**同时承载层级编辑**（标签面板的写入口）。
 *
 * 三段式，**每一步都让用户看见会发生什么**：
 *
 * ```
 * 输入新名字（+「同时改名子标签」）→「预览改动」（dryRun：走完全一样的判定，不落盘）
 *   → "这会改 12 篇笔记" 与明细          →「确定改名」（真跑）
 *   → 结果：改了 N 篇 / 跳过 M 篇 + 原因与下一步
 * ```
 *
 * 为什么不是"输入完点一下就静默改写全库"：这个动作会改**几十上百个文件**，其中还包括正文
 * 里的行内 `#标签`（那是用户自己写的字）。不给一次确认的机会，等于让用户在看不见范围的情况下
 * 按下"全库替换"；而只给确认、不给结果，等于改了也不知道有没有改干净 —— 所以两段都要。
 * 预演与真跑在宿主里走**同一条判定**（`tag_rename` 的 `dryRun`），因此"这会改 N 篇"与
 * 随后"改了 N 篇"是同一个数，不是估的。
 *
 * **两种模式共用一个对话框**（`mode`）：`rename` 输入新名字，`move` 输入**父标签**
 * （留空 = 提到顶层）。它们不是两个动作，而是同一个动作的两种写法 ——
 * 宿主侧 `tag_move` 内部就是 `tag_rename_in`，连出参（`TagRenameOutcome`）都是同一个形状。
 * 因此这里也只分叉"输入什么 / 怎么说"，三段式流程、明细、跳过汇报、键盘行为全部共享：
 * 复制一份界面出来，两边迟早会在"跳过怎么说"这类细节上分叉。
 *
 * 键盘：`Esc` 取消（写盘途中不响应，否则用户会以为取消了）、输入框里 `Enter` 走当前阶段的
 * 主按钮（输入阶段 = 预览，预览阶段 = 确定）。样式沿用全站的 `.mn-overlay` / `.mn-dialog`
 * （与文件重命名对话框同一套视觉语言），标签特有的部分在 `tags-panel.css` 里。
 */

import { useEffect, useRef, useState } from 'react'

import { moveTag, renameTag } from '@/app/actions'
import type { TagRenameOutcome } from '@/ipc/types'
import {
  changedAnything,
  editDetail,
  groupSkips,
  previewSentence,
  resultSentence,
  skipAdvice,
} from './tag-rename'

/** 结果里最多逐条列出多少个文件（再多只报数量：没有用户会去读几百行路径）。 */
const MAX_LISTED_FILES = 20

type Phase = 'input' | 'preview' | 'applying' | 'done'

/**
 * 一个标签键的**父标签**（`项目/后端` → `项目`；顶层标签 → 空串）。
 *
 * 只用来给移动模式的输入框填初值（"现在挂在哪儿"），**不参与任何判定**：
 * 目标键始终由宿主算（`tag_move_target`），这里判断错了的代价只是输入框初值不理想。
 */
function parentOfTagKey(key: string | null): string {
  if (key === null) return ''
  const at = key.lastIndexOf('/')
  return at <= 0 ? '' : key.slice(0, at)
}

export interface TagRenameDialogProps {
  /** 要被改掉的标签（**原始写法**，即面板上那一条）。 */
  tag: string
  /**
   * 它的归一化键（全库概览里有，本篇 chip 没有传 `null`）。
   *
   * 刻意**不叫 `key`**：那是 React 的保留属性，会被当作列表 `key` 吃掉 —— 组件里读到的
   * 永远是 `undefined`（React 19 只会打一行警告）。这个属性此前就叫 `key`，
   * 于是"从概览进来时手上就有归一化键"这条信息从来没有真正到过对话框里；
   * 层级编辑要靠它算"现在挂在哪儿"，才发现并改正。
   */
  tagKey: string | null
  /** 它在全库多少篇笔记里出现（概览里有；`null` = 不知道）。 */
  count: number | null
  /** `rename` = 改名字/合并（缺省）；`move` = 调整层级（挂到某个父标签下 / 提回顶层）。 */
  mode?: 'rename' | 'move'
  /** 移动模式下的父标签候选（全库概览里的键；只作为 `datalist` 提示，填什么都不拦）。 */
  parentOptions?: readonly string[]
  onClose: () => void
}

export function TagRenameDialog({
  tag,
  tagKey,
  count,
  mode = 'rename',
  parentOptions = [],
  onClose,
}: TagRenameDialogProps) {
  const isMove = mode === 'move'
  const [phase, setPhase] = useState<Phase>('input')
  const [draft, setDraft] = useState(() => (isMove ? parentOfTagKey(tagKey) : ''))
  const [includeChildren, setIncludeChildren] = useState(true)
  const [preview, setPreview] = useState<TagRenameOutcome | null>(null)
  const [result, setResult] = useState<TagRenameOutcome | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const busy = phase === 'applying'
  // 移动模式传**归一化键**（面板上那一条可能只是"某个写法"）；没有键时退回原始写法，
  // 宿主照样会归一化，只是 `fromDisplay` 显示的是用户写的那一种
  const source = tagKey ?? tag

  /**
   * 两种模式只差"第二个参数是什么"：新名字 / 父标签。其余（保存当前笔记、
   * 改完对齐当前编辑器、刷新面板、toast）都在 `actions.ts` 里各自那份里做，这里不重抄。
   */
  const runTagChange = (
    value: string,
    options: { includeChildren: boolean; dryRun: boolean },
  ): Promise<TagRenameOutcome | null> =>
    isMove ? moveTag(source, value, options) : renameTag(tag, value, options)

  /**
   * 新名字是不是"同一个标签的另一种写法"（只为了给一句提示）。
   *
   * 这里刻意用一个近似判据（去 `#` + 转小写）：它**不参与任何写入决策**，判同的权威永远是
   * 宿主里的 `normalize_tag`。从全库概览进来时手上就有归一化键，直接用；从本篇标签进来
   * 时没有键，只好拿原始写法比一下 —— 提示不准的代价只是少说一句话，而多复制一份判同规则
   * 的代价是两处口径迟早分叉（ADR-0006 第 2 条最反对的事）。
   */
  const sameTagSpelling = (): boolean => {
    const wanted = draft.trim().replace(/^#+/, '').toLowerCase()
    const current = (tagKey ?? tag).trim().replace(/^#+/, '').toLowerCase()
    return wanted !== '' && wanted === current
  }

  // 打开即聚焦输入框：这个对话框的主路径是"打字 → 预览"，不该要求先点一下
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // 关掉之后把焦点还给打开它的那个 `✎`：键盘用户不会"掉到文档开头"（与 RenameDialog 同一条纪律）
  useEffect(() => {
    const previous = typeof document === 'undefined' ? null : document.activeElement
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  const runPreview = async (): Promise<void> => {
    // 重命名必须有个新名字；移动模式空输入是**合法的**（= 提到顶层），不能一起拦
    if (busy || (!isMove && draft.trim() === '')) return
    const outcome = await runTagChange(draft, { includeChildren, dryRun: true })
    if (outcome === null) return
    setPreview(outcome)
    setPhase('preview')
  }

  const runApply = async (): Promise<void> => {
    if (busy) return
    setPhase('applying')
    const outcome = await runTagChange(draft, { includeChildren, dryRun: false })
    setResult(outcome)
    setPhase('done')
  }

  /**
   * `Esc` 取消：与 `ConfirmDialog` 同一套做法（**捕捉阶段**挂在 `window` 上、卸载即移除）。
   *
   * 挂在对话框的某个 `div` 上会依赖"事件恰好冒泡到它"，焦点在输入框里、在复选框上、
   * 在按钮上时行为各不相同 —— 那正是"有时候 Esc 不灵"的来源。写盘途中刻意不响应：
   * 请求已经发出去了，这时允许"取消"只会让用户以为没改。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || busy) return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [busy, onClose])

  return (
    <div
      className="mn-overlay"
      role="presentation"
      data-tag-rename-dialog
      data-tag-move-dialog={isMove ? '' : undefined}
      onClick={() => {
        if (!busy) onClose()
      }}
    >
      <div
        className="mn-dialog mn-dialog--tag-rename"
        role="dialog"
        aria-modal="true"
        aria-label={
          isMove ? `调整标签 ${tag} 的层级` : `重命名或合并标签 ${tag}`
        }
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mn-dialog__header">
          <h2>{isMove ? '调整标签层级' : '重命名 / 合并标签'}</h2>
        </div>

        <p className="mn-dialog__message">
          {isMove ? '正在移动：' : '正在改：'}
          <code className="mn-tag-rename__source">#{tag}</code>
          {count !== null ? <span className="mn-tag-rename__count"> · 全库 {count} 篇</span> : null}
        </p>

        {phase !== 'done' ? (
          <>
            <div className="mn-rename__field">
              <input
                ref={inputRef}
                type="text"
                className="mn-rename__input"
                data-tag-rename-input
                aria-label={isMove ? '父标签' : '新的标签名'}
                placeholder={
                  isMove ? '留空 = 提到顶层；例如 项目' : '例如 项目/进行中（用 / 表示层级）'
                }
                list={isMove && parentOptions.length > 0 ? 'mn-tag-parent-options' : undefined}
                value={draft}
                disabled={busy || phase === 'preview'}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  // Esc/Enter 不进全局快捷键：这里处理完就停住（与 RenameDialog 同一条纪律）
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    event.stopPropagation()
                    if (!busy) onClose()
                    return
                  }
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    event.stopPropagation()
                    if (phase === 'input') void runPreview()
                    else if (phase === 'preview') void runApply()
                  }
                }}
              />
              {isMove && parentOptions.length > 0 ? (
                <datalist id="mn-tag-parent-options">
                  {parentOptions.map((option) => (
                    <option key={option} value={option} />
                  ))}
                </datalist>
              ) : null}
            </div>

            {isMove ? (
              <>
                <p className="mn-tag-rename__hint" data-tag-move-hint="leaf-kept">
                  只换位置，不动名字：末段始终是它自己的名字 —— <code>#父/甲</code> 移到{' '}
                  <code>母</code> 下面是 <code>#母/甲</code>，留空则回到顶层 <code>#甲</code>。
                  想改名字请用 <code>✎</code>「重命名 / 合并」。
                </p>
                <button
                  type="button"
                  className="mn-button mn-button--small"
                  data-tag-move-top
                  disabled={busy || phase === 'preview' || draft === ''}
                  onClick={() => setDraft('')}
                >
                  移到顶层
                </button>
              </>
            ) : null}

            <label className="mn-rename__option">
              <input
                type="checkbox"
                data-tag-rename-children
                checked={includeChildren}
                disabled={busy || phase === 'preview'}
                onChange={(event) => setIncludeChildren(event.target.checked)}
              />
              <span>
                {isMove ? (
                  <>
                    连同子标签一起移动（<code>#{tag}/子</code> 也跟着挪到新的位置）
                  </>
                ) : (
                  <>
                    连同子标签一起改（<code>#{tag}/子</code> → <code>#新名字/子</code>）
                  </>
                )}
              </span>
            </label>

            {!isMove && sameTagSpelling() ? (
              <p className="mn-tag-rename__hint" data-tag-rename-same-key>
                新名字与旧标签是同一个标签（判同不区分大小写）：这次只把全库的写法统一成你输入的
                那一种，不会合并其他标签。
              </p>
            ) : null}
          </>
        ) : null}

        {phase === 'preview' && preview !== null ? (
          <div className="mn-tag-rename__panel" data-tag-rename-preview>
            <p className="mn-tag-rename__sentence">{previewSentence(preview)}</p>
            <p className="mn-tag-rename__detail">{editDetail(preview)}</p>
            {preview.edited.length > 0 ? (
              <ul className="mn-tag-rename__files">
                {preview.edited.slice(0, MAX_LISTED_FILES).map((file) => (
                  <li key={file.relPath} data-tag-rename-preview-file={file.relPath}>
                    {file.relPath}
                  </li>
                ))}
              </ul>
            ) : null}
            {preview.edited.length > MAX_LISTED_FILES ? (
              <p className="mn-tag-rename__hint">
                还有 {preview.edited.length - MAX_LISTED_FILES} 篇没有列出。
              </p>
            ) : null}
            <p className="mn-tag-rename__hint">
              改动会写进磁盘，包含正文里的行内 <code>#{tag}</code>；代码块、行内代码与 frontmatter
              区块里的 <code>#</code> 不算标签，一个字都不会动。
            </p>
          </div>
        ) : null}

        {phase === 'done' && result !== null ? (
          <div className="mn-tag-rename__panel" data-tag-rename-result>
            <p className="mn-tag-rename__sentence">{resultSentence(result)}</p>
            {result.edited.length > 0 ? (
              <p className="mn-tag-rename__detail">{editDetail(result)}</p>
            ) : null}
            {changedAnything(result) ? (
              <ul className="mn-tag-rename__files">
                {result.edited.slice(0, MAX_LISTED_FILES).map((file) => (
                  <li key={file.relPath} data-tag-rename-file={file.relPath}>
                    {file.relPath}
                    <span className="mn-tag-rename__file-detail">
                      frontmatter {file.frontmatterEdits} · 正文 {file.inlineEdits}
                      {file.inlineRemoved > 0 ? ` · 去重 ${file.inlineRemoved}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {result.edited.length > MAX_LISTED_FILES ? (
              <p className="mn-tag-rename__hint">
                还有 {result.edited.length - MAX_LISTED_FILES} 篇没有列出。
              </p>
            ) : null}

            {/* 没改的那些必须**逐组**说清楚：原因 + 下一步。只报"成功"是这一块最该避免的事 */}
            {groupSkips(result.skipped).map((group) => (
              <div className="mn-tag-rename__skip" key={group.reason} data-tag-rename-skip={group.reason}>
                <p className="mn-tag-rename__skip-title">
                  有 {group.files.length} 篇没改（{group.label}）—— {group.advice}
                </p>
                <ul className="mn-tag-rename__files">
                  {group.files.slice(0, MAX_LISTED_FILES).map((relPath) => (
                    <li key={relPath}>{relPath}</li>
                  ))}
                </ul>
              </div>
            ))}
            {result.unchanged > 0 ? (
              <p className="mn-tag-rename__hint">
                另有 {result.unchanged} 篇本来就没有旧写法（上一次已经改过），这次没有动它们。
              </p>
            ) : null}
            {result.skipped.length > 0 ? (
              <p className="mn-tag-rename__hint" data-tag-rename-retry-advice>
                {skipAdvice(result.skipped[0]?.reason ?? 'write-failed')}
                ：关掉窗口再执行一次即可，已经改过的笔记不会被改第二遍。
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="mn-dialog__actions">
          {phase === 'input' ? (
            <>
              <button type="button" className="mn-button" data-tag-rename-cancel onClick={onClose}>
                取消
              </button>
              <button
                type="button"
                className="mn-button mn-button--primary"
                data-tag-rename-preview-button
                disabled={!isMove && draft.trim() === ''}
                onClick={() => void runPreview()}
              >
                预览改动
              </button>
            </>
          ) : null}

          {phase === 'preview' ? (
            <>
              <button
                type="button"
                className="mn-button"
                data-tag-rename-back
                onClick={() => {
                  setPreview(null)
                  setPhase('input')
                }}
              >
                返回修改
              </button>
              <button
                type="button"
                className="mn-button mn-button--primary"
                data-tag-rename-confirm
                onClick={() => void runApply()}
              >
                {isMove ? '确定移动' : '确定改名'}
              </button>
            </>
          ) : null}

          {phase === 'applying' ? (
            <button type="button" className="mn-button" disabled data-tag-rename-busy>
              正在改写…
            </button>
          ) : null}

          {phase === 'done' ? (
            <button
              type="button"
              className="mn-button mn-button--primary"
              data-tag-rename-done
              onClick={onClose}
            >
              完成
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
