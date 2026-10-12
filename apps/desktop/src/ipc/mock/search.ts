/**
 * ipc/mock/search.ts（从 mock-adapter.ts 逐字搬出，只加了 export 与 import）
 *
 * 全文搜索的打分与片段 —— Mock 侧的镜像（权威实现在 Rust 的 FTS5）。
 */
import type { MockHost } from './host'
import { isMarkdown } from '@/domain/paths'
import {  } from './model'
import type { MockNote } from './model'
import type { SearchHit, SearchResult } from '@/ipc/types'


// ---------------------------------------------------------------------------
// Mock 的全文搜索（`mn-index` 的 FTS5 检索的**简化镜像**）
//
// ⚠️ **权威实现永远在 Rust 侧**：宿主用 SQLite FTS5 建索引、按 `bm25` 排序，
// 前端只消费 `search_query` 的返回值。这里用"逐行大小写不敏感子串匹配"近似，
// 分数（{@link mockSearchScore}）也是自造的粗糙量，**与 bm25 不可比**，
// 仅供浏览器预览与 UI 层测试把整条链路（防抖 → IPC → 渲染 → 打开笔记）跑通。
// ---------------------------------------------------------------------------

/**
 * Mock 里"这是一篇 Markdown 笔记"的判定。
 *
 * 与 `noteCount()` 原来的内联写法完全一致（按扩展名），抽出来只是为了让**笔记计数**与
 * **全文搜索**用同一个口径 —— 否则"统计到 7 篇笔记、搜索却命中 .txt 附件"这种不一致
 * 迟早要排查。（`domain/paths` 的 `isMarkdown` 是同一口径的另一份实现，这里沿用本文件的写法。）
 */
/** 每篇笔记最多返回多少条命中（真实实现由 FTS5 的 bm25 排序 + 截断决定）。 */
export const MOCK_HITS_PER_NOTE = 5

/** `snippet` 的最大长度（字符数）；与 Rust 侧"裁剪到一行、约 120 字符"对齐。 */
export const SNIPPET_MAX_CHARS = 120

/**
 * 命中行的展示片段。
 *
 * - 先 `trim` 掉首尾空白：缩进与 CRLF 不该出现在搜索结果里；
 * - 超过 {@link SNIPPET_MAX_CHARS} 时**以命中位置为中心**裁剪：关键词被切掉的搜索结果
 *   等于没搜到，所以命中点左右各留一半，被截断的那一侧加省略号。
 */
export function mockSnippet(line: string, matchIndex: number, matchLength: number): string {
  const leading = line.length - line.trimStart().length
  const text = line.trim()
  const hit = Math.max(0, matchIndex - leading)
  if (text.length <= SNIPPET_MAX_CHARS) return text

  const half = Math.max(0, Math.floor((SNIPPET_MAX_CHARS - matchLength) / 2))
  let start = Math.max(0, hit - half)
  let end = Math.min(text.length, start + SNIPPET_MAX_CHARS)
  // 命中点靠近行尾时会"越过"右边界：把窗口整体左移，保证片段长度稳定
  start = Math.max(0, end - SNIPPET_MAX_CHARS)
  end = Math.min(text.length, start + SNIPPET_MAX_CHARS)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

/**
 * 相关度的近似值（**不是** bm25，只是 Mock 的占位）：
 * 命中次数越多越相关，并用篇幅做长度归一 —— 让"短笔记里反复出现"排在"长笔记里提了一次"前面。
 * 同一篇笔记的所有命中共享同一个分数，因此篇内自然按行号升序（契约要求的次级排序）。
 */
export function mockSearchScore(occurrences: number, textLength: number): number {
  return Math.round((occurrences * 1000) / (1 + textLength / 500))
}

/** 在内存文件表里做一次全文检索，返回契约形状的结果。 */
export function mockSearch(files: Map<string, MockNote>, query: string, limit: number): SearchResult {
  const started = Date.now()
  const trimmed = query.trim()
  // 空查询：宿主也返回空结果（前端本就不该发这个请求，这里再兜一层，两边语义一致）
  if (trimmed === '') return { query, hits: [], total: 0, elapsedMs: 0 }

  const needle = trimmed.toLowerCase()
  const hits: SearchHit[] = []
  // total 是**全部**命中数（含被"每篇 5 条"截掉的那些），与契约里"可能大于 hits.length"一致
  let total = 0

  for (const note of files.values()) {
    if (!isMarkdown(note.relPath)) continue

    const lower = note.text.toLowerCase()
    let occurrences = 0
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
      occurrences += 1
    }
    if (occurrences === 0) continue

    const score = mockSearchScore(occurrences, note.text.length)
    const lines = note.text.split('\n')
    let taken = 0
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      const at = line.toLowerCase().indexOf(needle)
      if (at === -1) continue
      total += 1
      if (taken >= MOCK_HITS_PER_NOTE) continue
      taken += 1
      hits.push({
        relPath: note.relPath,
        line: index + 1,
        snippet: mockSnippet(line, at, needle.length),
        score,
      })
    }
  }

  hits.sort(
    (a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath) || a.line - b.line,
  )
  const capped =
    Number.isFinite(limit) && limit > 0 ? hits.slice(0, Math.floor(limit)) : hits
  return { query, hits: capped, total, elapsedMs: Math.max(0, Date.now() - started) }
}

// ---------------------------------------------------------------------------
// Mock 的导出支持（`asset_read_base64` / `export_write_html`）
//
// 权威实现在 Rust 侧（`src-tauri/src/assets.rs`、`src-tauri/src/export.rs`），这里只是
// "形状与校验口径的镜像"：浏览器预览（`pnpm dev`）不写真实文件，UI 层测试也只需要
// 拿到契约形状的数据。**扩展名白名单与大小上限刻意与宿主保持一致** —— 两边漂移的话，
// 测试会绿得毫无意义。
// ---------------------------------------------------------------------------

/** Mock 里"扩展名 → MIME"的白名单（与 `ALLOWED_IMAGE_EXTENSIONS` 逐字对齐）。 */

/**
 * `search_query` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function searchQuery(host: MockHost, a: Record<string, unknown>): Promise<unknown> {
  const { files } = host
          const query = String(a.query ?? '')
          const limit = a.limit === undefined ? 50 : Number(a.limit)
          return mockSearch(files, query, limit)
}
