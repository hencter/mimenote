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
 * - **行内标签只读**：正文里的 `#标签` 不在 frontmatter 里，面板改不动它。这里的做法是
 *   `×` 仍然可点、但点下去给一句"请到正文里删"，而不是把按钮做成禁用态 ——
 *   禁用按钮只会让用户以为面板坏了（`aria-disabled` 的样式 + 可读提示才是诚实的）。
 */

import { useEffect, useState } from 'react'

import { editCurrentNoteTags, explainInlineTag, openNote } from '@/app/actions'
import { Icon } from '@/components/Icon'
import { frontmatterValueText, isFrontmatterEmpty } from '@/domain/frontmatter'
import type { TagRef } from '@/ipc/types'
import { useNoteStore } from '@/state/note-store'
import { useTagsStore } from '@/state/tags-store'
import { parseTagInput } from './tag-input'

import './tags-panel.css'

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
        <Icon name="sparkle" size={14} />
        <h2 className="mn-tags__title">标签与属性</h2>
        <button
          type="button"
          className="mn-icon-button"
          aria-label="关闭标签面板"
          onClick={() => setOpen(false)}
        >
          <Icon name="x" size={13} />
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
                <li key={item.key}>
                  <button
                    type="button"
                    className={activeKey === item.key ? 'mn-tag mn-tag--active' : 'mn-tag'}
                    data-tag-key={item.key}
                    onClick={() => void selectTag(activeKey === item.key ? null : item.key)}
                  >
                    #{item.tag}
                    <span className="mn-tag__count">{item.count}</span>
                  </button>
                </li>
              ))}
            </ul>
            {summary.length > 60 && (
              <p className="mn-empty__text">只显示前 60 个标签（共 {summary.length} 个）</p>
            )}
          </section>
        )}
      </div>
    </aside>
  )
}
