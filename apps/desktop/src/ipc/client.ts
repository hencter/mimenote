/**
 * IPC 客户端：组件与 store 访问宿主能力的**唯一**通道。
 *
 * 设计要点（见 ADR-0003）：
 * - 通过可替换的 {@link IpcAdapter} 隔离运行时（Tauri / Mock / 测试替身）；
 * - 所有错误归一化为 {@link MimenoteError}，调用方只处理一种错误类型；
 * - 方法名与 Rust 命令名一致，参数使用 camelCase。
 */

import { MimenoteError } from './types'
import type {
  AssetGrant,
  DocumentStats,
  EntryMeta,
  GraphData,
  IndexStatus,
  NoteContent,
  NoteLinks,
  NoteTags,
  RenameOutcome,
  SearchResult,
  SnippetFile,
  TagNotes,
  TagSummary,
  TrashRecord,
  VaultInfo,
  VaultSnapshot,
  VersionInfo,
  WriteOutcome,
} from './types'

/** 传输适配器。 */
export interface IpcAdapter {
  /** 适配器标识（日志/状态栏用）。 */
  readonly kind: 'tauri' | 'mock' | 'test'
  invoke<T>(method: string, args?: Record<string, unknown>): Promise<T>
}

let adapter: IpcAdapter | null = null

/** 安装适配器（bootstrap 或测试中调用）。 */
export function setIpcAdapter(next: IpcAdapter): void {
  adapter = next
}

/** 读取当前适配器；未安装时抛 `INTERNAL`。 */
export function getIpcAdapter(): IpcAdapter {
  if (adapter === null) {
    throw new MimenoteError({
      code: 'INTERNAL',
      message: 'IPC 适配器尚未初始化（bootstrap 未执行）',
      detail: null,
      currentMtimeMs: null,
    })
  }
  return adapter
}

/** 当前适配器种类（未初始化时返回 null）。 */
export function currentAdapterKind(): IpcAdapter['kind'] | null {
  return adapter?.kind ?? null
}

async function call<T>(method: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await getIpcAdapter().invoke<T>(method, args)
  } catch (cause) {
    throw MimenoteError.from(cause)
  }
}

/**
 * 是否为 Tauri 运行时。
 *
 * 注意：依赖 `window.__TAURI_INTERNALS__`（Tauri 2 注入），而不是 userAgent。
 */
export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 宿主命令集合。 */
export const ipc = {
  /** 打开 Vault：一次返回概要 + 完整条目表（避免二次扫描）。 */
  vaultOpen: (path: string) => call<VaultSnapshot>('vault_open', { path }),
  vaultInfo: () => call<VaultInfo | null>('vault_info'),
  vaultSnapshot: () => call<VaultSnapshot>('vault_snapshot'),
  vaultClose: () => call<void>('vault_close'),

  noteRead: (relPath: string) => call<NoteContent>('note_read', { relPath }),
  noteWrite: (relPath: string, text: string, baseMtimeMs: number | null, force = false) =>
    call<WriteOutcome>('note_write', { relPath, text, baseMtimeMs, force }),
  noteCreate: (parentRel: string, title: string) =>
    call<NoteContent>('note_create', { parentRel, title }),
  noteDelete: (relPath: string, confirm: boolean) =>
    call<TrashRecord>('note_delete', { relPath, confirm }),
  noteStats: (relPath: string) => call<DocumentStats>('note_stats', { relPath }),
  /**
   * 重命名笔记（同目录改名）并改写全库指向它的链接。
   *
   * `newTitle` 不带扩展名；`updateLinks=false` 时只改名、不动任何链接。
   */
  noteRename: (relPath: string, newTitle: string, updateLinks = true) =>
    call<RenameOutcome>('note_rename', { relPath, newTitle, updateLinks }),

  /** 命令行指定的 Vault（`mimenote.exe <目录>`）；无则返回 null。 */
  startupVault: () => call<string | null>('startup_vault'),

  /** 链接索引状态。 */
  indexStatus: () => call<IndexStatus>('index_status'),
  /** 某篇笔记的出链与反向链接。 */
  noteLinks: (relPath: string) => call<NoteLinks>('note_links', { relPath }),

  /** 某篇笔记的标签与 frontmatter 属性。 */
  noteTags: (relPath: string) => call<NoteTags>('note_tags', { relPath }),
  /** 全库标签概览（按笔记数降序）。 */
  tagsList: () => call<TagSummary[]>('tags_list'),
  /** 某个标签下的笔记（`key` 为归一化键）。 */
  tagNotes: (key: string) => call<TagNotes>('tag_notes', { key }),

  /**
   * 为本地图片换取**逐文件**读取授权（ADR-0007）。
   *
   * 传 Vault 相对路径，拿回磁盘绝对路径；返回里只含**通过 `path_guard` 校验**的条目
   * （越界、符号链接逃逸、非图片扩展名都会被跳过）。一次传一整篇笔记的图片，
   * 避免"每张图一次 IPC"。
   */
  assetAuthorize: (relPaths: readonly string[]) =>
    call<AssetGrant[]>('asset_authorize', { relPaths: [...relPaths] }),

  /**
   * 全文搜索（宿主侧 SQLite FTS5 索引）。
   *
   * 语义（与 Rust 侧一致）：
   * - 大小写不敏感、**子串**匹配；`query` 为空时宿主返回空结果，
   *   但前端本就不该发这个请求（见 `features/palette/use-search.ts`）；
   * - `hits` 已按 `score` 降序排好，上限 `limit` 条；`total` 是命中总数，可能大于 `hits.length`。
   */
  searchQuery: (query: string, limit = 50) => call<SearchResult>('search_query', { query, limit }),

  /**
   * 知识图谱的节点与边（一次拿全库，供卡片画布使用）。
   *
   * 数据来自链接索引，不做文件 IO；索引未就绪时返回空集（面板会显示"索引构建中"）。
   * 节点数超过宿主上限时只返回度数最高的一部分，并把 `truncated` 置为 true。
   */
  graphData: () => call<GraphData>('graph_data'),

  snippetsList: () => call<SnippetFile[]>('snippets_list'),
  versionInfo: () => call<VersionInfo>('version_info'),
} as const

/** 便于测试构造最小条目。 */
export function makeEntry(partial: Partial<EntryMeta> & Pick<EntryMeta, 'relPath'>): EntryMeta {
  const name = partial.relPath.split('/').pop() ?? partial.relPath
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : null
  return {
    relPath: partial.relPath,
    name: partial.name ?? name,
    isDir: partial.isDir ?? false,
    sizeBytes: partial.sizeBytes ?? 0,
    mtimeMs: partial.mtimeMs ?? 0,
    ext: partial.ext ?? (partial.isDir === true ? null : ext),
  }
}
