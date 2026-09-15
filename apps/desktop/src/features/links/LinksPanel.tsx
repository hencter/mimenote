/** 链接面板：当前笔记的反向链接与出链。 */

import { Icon } from '@/components/Icon'
import { displayName, displayPath } from '@/domain/paths'
import { createNoteFromLink, openNote, openNoteAt } from '@/app/actions'
import { useLinksStore } from '@/state/links-store'
import { useNoteStore } from '@/state/note-store'
import { useUiStore } from '@/state/ui-store'

function indexStatusLabel(status: { phase: string; indexed: number; total: number; links: number; durationMs: number }): string {
  switch (status.phase) {
    case 'building':
      return `索引中 ${status.indexed}/${status.total}`
    case 'ready':
      return `已索引 ${status.links} 条链接`
    case 'cancelled':
      return '索引已取消'
    case 'failed':
      return '索引失败'
    default:
      return '未索引'
  }
}

export function LinksPanel() {
  const close = useUiStore((state) => state.toggleLinksPanel)
  const relPath = useNoteStore((state) => state.doc?.relPath ?? null)
  const links = useLinksStore((state) => state.links)
  const status = useLinksStore((state) => state.status)
  const loading = useLinksStore((state) => state.loading)

  const backlinks = links?.backlinks ?? []
  const outbound = links?.outbound ?? []

  return (
    <aside className="mn-links" aria-label="链接面板">
      <header className="mn-links__header">
        <Icon name="links" size="sm" />
        <span className="mn-links__title">链接</span>
        <span className="mn-links__status" title={`索引耗时 ${status.durationMs}ms`}>
          {indexStatusLabel(status)}
        </span>
        <button type="button" className="mn-icon-button" aria-label="关闭链接面板" onClick={close}>
          <Icon name="x" size="xs" />
        </button>
      </header>

      {relPath === null ? (
        <p className="mn-links__empty">没有打开的笔记</p>
      ) : (
        <div className="mn-links__body">
          <section className="mn-links__section" aria-label="反向链接">
            <h3>
              反向链接
              <span className="mn-links__count">{backlinks.length}</span>
            </h3>
            {loading && backlinks.length === 0 && <p className="mn-links__empty">读取中…</p>}
            {!loading && backlinks.length === 0 && (
              <p className="mn-links__empty">还没有笔记链接到这一篇</p>
            )}
            <ul className="mn-links__list">
              {backlinks.map((backlink, index) => (
                <li key={`${backlink.fromRelPath}-${backlink.line}-${index}`}>
                  <button
                    type="button"
                    className="mn-links__item"
                    data-backlink-from={backlink.fromRelPath}
                    title={`${backlink.fromRelPath}（第 ${backlink.line} 行）`}
                    // 反向链接的行号是**来源笔记里**那一行的行号（`mn-index` 建 backlink
                    // 时用的就是引用所在行），所以可以直接跳过去 —— 与搜索结果同一个入口。
                    onClick={() => void openNoteAt(backlink.fromRelPath, backlink.line)}
                  >
                    <span className="mn-links__item-name">{displayName(backlink.fromRelPath)}</span>
                    <span className="mn-links__item-meta">
                      「{backlink.display}」 · 第 {backlink.line} 行
                      {backlink.anchor !== null ? ` · #${backlink.anchor}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="mn-links__section" aria-label="出链">
            <h3>
              出链
              <span className="mn-links__count">{outbound.length}</span>
            </h3>
            {outbound.length === 0 && <p className="mn-links__empty">这篇还没有链接别的笔记</p>}
            <ul className="mn-links__list">
              {outbound.map((link, index) => {
                const resolved = link.resolvedRelPath
                return (
                  <li key={`${link.rawTarget}-${link.line}-${index}`}>
                    <button
                      type="button"
                      className={`mn-links__item${resolved === null ? ' mn-links__item--dangling' : ''}`}
                      data-outbound-target={link.rawTarget}
                      title={
                        resolved === null
                          ? `${link.rawTarget} 还不存在（点击创建）`
                          : `${resolved}（第 ${link.line} 行）`
                      }
                      onClick={() => {
                        if (resolved === null) void createNoteFromLink(link.rawTarget, relPath)
                        // ⚠️ 出链**不定位**：`link.line` 是这一行在**当前笔记**里的行号
                        // （引用写在哪儿），不是目标笔记里的行号；而 `#小节` 是锚点名，
                        // 宿主没有"锚点 → 行号"的接口（`ResolvedLink` 只带 `anchor` 字符串）。
                        // 为它新增一条宿主命令不在本次范围内 —— 所以这里只打开、不跳转，
                        // 目标位置由用户自己看。
                        else void openNote(resolved)
                      }}
                    >
                      <span className="mn-links__item-name">{link.display}</span>
                      <span className="mn-links__item-meta">
                        {resolved === null ? '悬空 · 点击创建' : displayPath(resolved)}
                        {link.ambiguous ? ' · 同名多篇' : ''}
                        {link.anchor !== null ? ` · #${link.anchor}` : ''}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        </div>
      )}
    </aside>
  )
}
