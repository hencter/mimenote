/**
 * 标签面板（M2）：当前笔记的标签与 Frontmatter 属性 + 全库标签概览。
 *
 * 设计取舍：
 * - **自取数据**：面板订阅 `note-store` 的当前文档并在其变化时刷新（与链接面板同一套路），
 *   这样挂载点只需要一行 `<TagsPanel />`，宿主不必关心"什么时候该刷新标签"；
 * - **点击即用**：本篇标签可点击 → 展开"哪些笔记用了同一个标签" → 点笔记直接打开；
 * - 标签的判同走宿主（`tag_notes` 内部会再归一化一次），所以这里可以直接把**原始写法**
 *   当作 key 传下去，前端不需要复制一遍归一化规则（规则只有一份，在 Rust 侧）；
 * - **改标签只有一种入口**：`app/actions` 的 `editCurrentNoteTags` —— 它负责"先落盘、
 *   再让宿主改 frontmatter、然后把内存文本对齐磁盘"的完整顺序，组件不自己编排；
 * - **重命名/合并是全库动作**：它由 [`TagRenameDialog`] 承载（输入 → 预览"这会改 N 篇"
 *   → 执行 → 汇报改了哪些、哪些没改），入口是本篇标签与全库概览每一行上的 `✎`。
 *   面板只负责"把哪一条标签交给对话框"，不动手写盘；
 * - **行内标签只读**：正文里的 `#标签` 不在 frontmatter 里，面板改不动它。这里的做法是
 *   `×` 仍然可点、但点下去给一句"请到正文里删"，而不是把按钮做成禁用态 ——
 *   禁用按钮只会让用户以为面板坏了（`aria-disabled` 的样式 + 可读提示才是诚实的）。
 *   **唯一的例外是重命名/合并**：不改正文里的 `#标签` 就等于没改名，那条边界由
 *   `mn_core::tags::rename_tags` 打开（见 ADR-0006 的「后续修订」）。
 */

import { useEffect, useState } from 'react'

import { editCurrentNoteTags, explainInlineTag, openNote } from '@/app/actions'
import { Icon } from '@/components/Icon'
import { frontmatterValueText, isFrontmatterEmpty } from '@/domain/frontmatter'
import type { TagRef, TagSummary } from '@/ipc/types'
import { useNoteStore } from '@/state/note-store'
import { useTagsStore } from '@/state/tags-store'
import { TagRenameDialog } from './TagRenameDialog'
import { parseTagInput } from './tag-input'

import './tags-panel.css'

/**
 * 「移到…」对话框里的父标签候选：全库键里**去掉它自己与它自己的后代**。
 *
 * 这两种移动宿主一定会拒绝（"不能挂到自己下面"、"会造出改不完的层级"），
 * 所以不给建议 —— 但这只是 `datalist` 里的提示，**不是校验**：用户照样可以手打
 * 一个还不存在的父标签（层级编辑的正常用法之一），判定始终在宿主那一次。
 */
function parentCandidates(summary: readonly TagSummary[], self: string): string[] {
  return summary.map((item) => item.key).filter((key) => key !== self && !key.startsWith(`${self}/`))
}

export function TagsPanel() {
  const open = useTagsStore((state) => state.open)
  const noteTags = useTagsStore((state) => state.noteTags)
  const summary = useTagsStore((state) => state.summary)
  const activeKey = useTagsStore((state) => state.activeKey)
  const activeRaw = useTagsStore((state) => state.activeRaw)
  const activeNotes = useTagsStore((state) => state.activeNotes)
  const loading = useTagsStore((state) => state.loading)
  const error = useTagsStore((state) => state.error)
  const relPath = useNoteStore((state) => state.doc?.relPath ?? null)
  const dirty = useNoteStore((state) => state.dirty)
  const setOpen = useTagsStore((state) => state.setOpen)
  const selectTag = useTagsStore((state) => state.selectTag)

  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  /**
   * 正在被重命名/合并的那一条标签（`null` = 对话框没开）。
   *
   * 三个字段一起记：`tag` 是原始写法（改名时的源）、`key`/`count` 只有全库概览才有。
   * 从本篇 chip 进来时 `key = null`（判同交给宿主），`count = null`（不知道就说不知道，
   * 不编一个数字出来）。
   */
  const [renameTarget, setRenameTarget] = useState<{
    tag: string
    key: string | null
    count: number | null
  } | null>(null)
  /**
   * 正在被调整层级的那一条标签（`null` = 对话框没开）。
   *
   * 与 `renameTarget` 分开一个状态而不是加个 `mode` 字段：两者虽然共用同一个对话框组件，
   * 但同时只能开一个，而"现在开的是哪一个"由**入口按钮**决定 —— 混在一个对象里就得在
   * 每次 setState 时判断该不该切模式，反而更容易出现"点了移动却开了改名"。
   */
  const [moveTarget, setMoveTarget] = useState<{
    tag: string
    key: string
    count: number | null
  } | null>(null)

  // 面板可见时跟随"当前笔记"刷新；关闭时不发请求（省一次 IPC）
  useEffect(() => {
    if (!open) return
    void useTagsStore.getState().refreshFor(relPath)
  }, [open, relPath])

  // 编辑正文会让标签/属性变化：只在**落盘之后**（`dirty` 由 true 变 false）刷新一次，
  // 而不是每次按键都打一次 IPC（那会让输入路径上多出网络往返）。
  useEffect(() => {
    if (!open || relPath === null || dirty) return
    const timer = setTimeout(() => {
      void useTagsStore.getState().refreshFor(relPath)
    }, 250)
    return () => {
      clearTimeout(timer)
    }
  }, [open, relPath, dirty])

  if (!open) return null

  const tags = noteTags?.tags ?? []
  const frontmatter = noteTags?.frontmatter ?? []

  const submitAdd = async (): Promise<void> => {
    const add = parseTagInput(draft)
    if (add.length === 0 || busy) return
    setBusy(true)
    try {
      const result = await editCurrentNoteTags({ add })
      // 只有真的写出去了才清空输入框：失败（冲突/只读 Vault）时用户输的字不该消失
      if (result !== null && result.changed) setDraft('')
    } finally {
      setBusy(false)
    }
  }

  const removeTag = async (tag: TagRef): Promise<void> => {
    if (busy) return
    if (tag.source === 'inline') {
      explainInlineTag(tag.tag)
      return
    }
    setBusy(true)
    try {
      await editCurrentNoteTags({ remove: [tag.tag] })
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="mn-tags" aria-label="标签面板">
      <header className="mn-tags__header">
        <Icon name="sparkle" size="sm" />
        <h2 className="mn-tags__title">标签与属性</h2>
        <button
          type="button"
          className="mn-icon-button"
          aria-label="关闭标签面板"
          onClick={() => setOpen(false)}
        >
          <Icon name="x" size="xs" />
        </button>
      </header>

      <div className="mn-tags__body">
        {relPath === null ? (
          <p className="mn-empty__text">先打开一篇笔记，这里会显示它的标签与属性。</p>
        ) : error !== null && noteTags === null ? (
          // 宿主侧的标签索引还没接上（旧宿主/测试替身）时，宁可说清楚也不要一直显示"读取中"
          <p className="mn-empty__text">读不到标签：{error.message}</p>
        ) : loading && noteTags === null ? (
          <p className="mn-empty__text">读取标签…</p>
        ) : (
          <>
            <section className="mn-tags__section">
              <h3 className="mn-tags__section-title">本篇标签</h3>
              {tags.length === 0 ? (
                <p className="mn-empty__text">
                  没有标签。在下面的输入框里加一个，或直接在正文写 <code>#标签</code>。
                </p>
              ) : (
                <ul className="mn-tags__chips">
                  {tags.map((tag) => (
                    <li key={`${tag.source}-${tag.line}-${tag.tag}`} className="mn-tags__chip">
                      <button
                        type="button"
                        className={activeRaw === tag.tag ? 'mn-tag mn-tag--active' : 'mn-tag'}
                        data-tag={tag.tag}
                        data-tag-source={tag.source}
                        title={
                          tag.source === 'frontmatter'
                            ? 'Frontmatter（可在这里移除）'
                            : `正文第 ${tag.line} 行（只读：请在正文里改）`
                        }
                        onClick={() => void selectTag(activeRaw === tag.tag ? null : tag.tag)}
                      >
                        #{tag.tag}
                        {tag.source === 'inline' && (
                          <span className="mn-tag__source" title="写在正文里">
                            正文
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        className="mn-tag__action"
                        data-tag-rename-open={tag.tag}
                        aria-label={`重命名或合并标签 ${tag.tag}`}
                        title="重命名 / 合并（全库，连正文行内标签一起改）"
                        disabled={busy}
                        onClick={() => setRenameTarget({ tag: tag.tag, key: null, count: null })}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className={
                          tag.source === 'inline'
                            ? 'mn-tag__remove mn-tag__remove--inline'
                            : 'mn-tag__remove'
                        }
                        data-tag-remove={tag.tag}
                        aria-label={
                          tag.source === 'frontmatter'
                            ? `从 frontmatter 移除标签 ${tag.tag}`
                            : `标签 ${tag.tag} 写在正文里，点击查看说明`
                        }
                        title={
                          tag.source === 'frontmatter'
                            ? '从 frontmatter 移除'
                            : '这是正文里的标签，请到正文里删'
                        }
                        disabled={busy}
                        onClick={() => void removeTag(tag)}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {tags.some((tag) => tag.source === 'inline') && (
                <p className="mn-tags__hint" data-tag-hint="inline-readonly">
                  带「正文」角标的标签写在正文里（<code>#标签</code>），面板只能删 frontmatter 里的
                  那些 —— 点它的 × 会说明去哪儿改。
                </p>
              )}

              {/* 用 form 而非裸 input：回车提交是浏览器行为，不需要自己抢键盘事件 */}
              <form
                className="mn-tags__add"
                onSubmit={(event) => {
                  event.preventDefault()
                  void submitAdd()
                }}
              >
                <input
                  className="mn-tags__add-input"
                  type="text"
                  aria-label="添加标签"
                  placeholder="加标签，逗号分隔"
                  value={draft}
                  disabled={busy}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <button
                  type="submit"
                  className="mn-button mn-button--small"
                  data-tag-add
                  disabled={busy || draft.trim() === ''}
                >
                  添加
                </button>
              </form>
            </section>

            {frontmatter.length > 0 && (
              <section className="mn-tags__section">
                <h3 className="mn-tags__section-title">属性（Frontmatter）</h3>
                <dl className="mn-tags__props">
                  {frontmatter.map((field) => (
                    <div className="mn-tags__prop" key={`${field.key}-${field.line}`}>
                      <dt>{field.key}</dt>
                      <dd className={isFrontmatterEmpty(field.value) ? 'mn-tags__prop--empty' : undefined}>
                        {frontmatterValueText(field.value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}

            {activeKey !== null && (
              <section className="mn-tags__section">
                <h3 className="mn-tags__section-title">含「{activeRaw ?? activeKey}」的笔记（{activeNotes.length}）</h3>
                {activeNotes.length === 0 ? (
                  <p className="mn-empty__text">没有其他笔记使用这个标签。</p>
                ) : (
                  <ul className="mn-tags__notes">
                    {activeNotes.map((note) => (
                      <li key={note}>
                        <button
                          type="button"
                          className="mn-tags__note"
                          data-tag-note={note}
                          onClick={() => void openNote(note)}
                        >
                          {note}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </>
        )}

        {summary.length > 0 && (
          <section className="mn-tags__section">
            <h3 className="mn-tags__section-title">全库标签（{summary.length}）</h3>
            <ul className="mn-tags__chips">
              {summary.slice(0, 60).map((item) => (
                <li key={item.key} className="mn-tags__chip">
                  <button
                    type="button"
                    className={activeKey === item.key ? 'mn-tag mn-tag--active' : 'mn-tag'}
                    data-tag-key={item.key}
                    onClick={() => void selectTag(activeKey === item.key ? null : item.key)}
                  >
                    #{item.tag}
                    <span className="mn-tag__count">{item.count}</span>
                  </button>
                  {/* 全库概览是"重命名/合并"最自然的入口：这里的每一行本来就代表一个标签 */}
                  <button
                    type="button"
                    className="mn-tag__action"
                    data-tag-rename-open={item.key}
                    aria-label={`重命名或合并标签 ${item.tag}`}
                    title="重命名 / 合并（全库，连正文行内标签一起改）"
                    disabled={busy}
                    onClick={() => setRenameTarget({ tag: item.tag, key: item.key, count: item.count })}
                  >
                    ✎
                  </button>
                  {/*
                    层级编辑的入口只放在全库概览这一行上：层级是**标签全局的属性**，
                    而本篇 chip 连归一化键都没有（同一篇里 `#项目` 与 `#项目/甲` 是两个标签，
                    从 chip 出发看不出"它现在挂在哪儿"）。少一个入口换来的是一处说得清的位置。
                  */}
                  <button
                    type="button"
                    className="mn-tag__action"
                    data-tag-move-open={item.key}
                    aria-label={`调整标签 ${item.tag} 的层级`}
                    title="移到…（挂到别的标签下面，或提回顶层）"
                    disabled={busy}
                    onClick={() => setMoveTarget({ tag: item.tag, key: item.key, count: item.count })}
                  >
                    ⇥
                  </button>
                </li>
              ))}
            </ul>
            {summary.length > 60 && (
              <p className="mn-empty__text">只显示前 60 个标签（共 {summary.length} 个）</p>
            )}
            <p className="mn-tags__hint" data-tag-rename-hint>
              点标签旁的 <code>✎</code> 可以重命名它：<strong>全库</strong>改写，连正文里的{' '}
              <code>#标签</code> 一起改；输入一个已经存在的标签名就是把它<strong>合并</strong>过去。
            </p>
            <p className="mn-tags__hint" data-tag-move-hint>
              <code>⇥</code> 是<strong>调整层级</strong>：把标签挂到另一个标签下面（<code>#甲</code>{' '}
              → <code>#父/甲</code>）或提回顶层。<strong>只换位置、不动名字</strong> ——
              要改名请用 <code>✎</code>。
            </p>
            <p className="mn-tags__hint">
              重命名会改动<strong>全库</strong>：对话框会先告诉你"这会改 N 篇笔记"，确认之后才写盘。
            </p>
          </section>
        )}
      </div>

      {renameTarget !== null && (
        <TagRenameDialog
          tag={renameTarget.tag}
          tagKey={renameTarget.key}
          count={renameTarget.count}
          onClose={() => setRenameTarget(null)}
        />
      )}

      {moveTarget !== null && (
        <TagRenameDialog
          tag={moveTarget.tag}
          tagKey={moveTarget.key}
          count={moveTarget.count}
          mode="move"
          parentOptions={parentCandidates(summary, moveTarget.key)}
          onClose={() => setMoveTarget(null)}
        />
      )}
    </aside>
  )
}
