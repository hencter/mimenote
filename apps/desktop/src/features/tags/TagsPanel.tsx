/**
 * 标签面板（M2）：当前笔记的标签与 Frontmatter 属性 + 全库标签概览。
 *
 * 设计取舍：
 * - **自取数据**：面板订阅 `note-store` 的当前文档并在其变化时刷新（与链接面板同一套路），
 *   这样挂载点只需要一行 `<TagsPanel />`，宿主不必关心"什么时候该刷新标签"；
 * - **点击即用**：本篇标签可点击 → 展开"哪些笔记用了同一个标签" → 点笔记直接打开；
 * - 标签的判同走宿主（`tag_notes` 内部会再归一化一次），所以这里可以直接把**原始写法**
 *   当作 key 传下去，前端不需要复制一遍归一化规则（规则只有一份，在 Rust 侧）。
 */

import { useEffect } from 'react'

import { openNote } from '@/app/actions'
import { Icon } from '@/components/Icon'
import { frontmatterValueText, isFrontmatterEmpty } from '@/domain/frontmatter'
import { useNoteStore } from '@/state/note-store'
import { useTagsStore } from '@/state/tags-store'

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
                  没有标签。写 <code>#标签</code>，或在开头加 <code>tags: [甲, 乙]</code>。
                </p>
              ) : (
                <ul className="mn-tags__chips">
                  {tags.map((tag) => (
                    <li key={`${tag.source}-${tag.line}-${tag.tag}`}>
                      <button
                        type="button"
                        className={activeRaw === tag.tag ? 'mn-tag mn-tag--active' : 'mn-tag'}
                        data-tag={tag.tag}
                        data-tag-source={tag.source}
                        title={tag.source === 'frontmatter' ? 'Frontmatter' : `正文第 ${tag.line} 行`}
                        onClick={() => void selectTag(activeRaw === tag.tag ? null : tag.tag)}
                      >
                        #{tag.tag}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
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
