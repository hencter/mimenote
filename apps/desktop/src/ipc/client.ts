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
  AssetBytes,
  AssetGrant,
  AttachmentInput,
  AttachmentSaved,
  DocumentStats,
  EntryMeta,
  ExportWriteOutcome,
  GraphData,
  IndexStatus,
  NoteContent,
  NoteLinks,
  NoteTags,
  RenameOutcome,
  RestoreSummary,
  SearchResult,
  SetTagsOutcome,
  SnippetFile,
  TagFilterResult,
  TagNotes,
  TagRenameOutcome,
  TagSummary,
  TrashEntry,
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
  /** 列出回收站（最近的排最前，含"东西还在不在"）。 */
  trashList: () => call<TrashEntry[]>('trash_list'),
  /**
   * 把回收站里的一条恢复回来。
   *
   * 不传 `targetRelPath` 就恢复到**当初的位置**；传了就恢复到那里（界面上的「恢复为…」，
   * 原位置已被别人占用时的出路）。目标已存在时返回 `ALREADY_EXISTS`，**绝不覆盖**。
   */
  noteRestore: (id: string, targetRelPath?: string) =>
    call<RestoreSummary>('note_restore', { id, targetRelPath: targetRelPath ?? null }),
  noteStats: (relPath: string) => call<DocumentStats>('note_stats', { relPath }),
  /**
   * 重命名笔记（同目录改名）并改写全库指向它的链接。
   *
   * `newTitle` 不带扩展名；`updateLinks=false` 时只改名、不动任何链接。
   */
  noteRename: (relPath: string, newTitle: string, updateLinks = true) =>
    call<RenameOutcome>('note_rename', { relPath, newTitle, updateLinks }),

  /**
   * 跨目录移动笔记（拖拽整理 / 命令面板的「移动到…」）。
   *
   * - `targetParentRel` 是**目标父目录**（`''` = Vault 根）；目录不存在时由宿主创建；
   * - `newTitle` 为 `null` 时沿用原文件名（拖拽就是这种情况）；
   * - `updateLinks=false` 时只搬文件、不动任何链接（默认改写全库指向它的链接，
   *   跨目录时写成"相对新位置的路径"）。
   *
   * 出参复用 {@link RenameOutcome}：宿主不为"换个位置"发明第二套形状，
   * 前端因此能复用同一套状态收尾。目标目录已有同名文件 → `ALREADY_EXISTS`（不覆盖）。
   */
  noteMove: (
    relPath: string,
    targetParentRel: string,
    newTitle: string | null = null,
    updateLinks = true,
  ) =>
    call<RenameOutcome>('note_move', { relPath, targetParentRel, newTitle, updateLinks }),

  /**
   * 重命名**目录**（连同整棵子树）：磁盘上换名字 + 全库指向子树里每一篇的链接精确改写。
   *
   * 与 `noteRename` 共用同一种出参（{@link RenameOutcome}），差别只有两点：`oldRelPath` /
   * `newRelPath` 是目录路径，`newMtimeMs` 恒为 `0`（目录不是版本令牌的载体）。
   * 目标位置已有同名目录 → `ALREADY_EXISTS`（**绝不覆盖、也绝不合并**两棵子树）。
   */
  dirRename: (relPath: string, newTitle: string, updateLinks = true) =>
    call<RenameOutcome>('dir_rename', { relPath, newTitle, updateLinks }),

  /**
   * 移动**目录**（连同整棵子树）：整棵子树的路径跟着变 + 全库链接精确改写。
   *
   * 入参口径与 {@link ipc.noteMove} 完全一致（`targetParentRel` 是目标父目录，`''` = Vault 根，
   * 不存在时创建；`newTitle` 为 `null` 时沿用目录名 —— 拖拽就是这种情况）。
   * **把目录移进它自己或它的后代**会被宿主拒绝（`PATH_INVALID`）；前端在落点判定里就拦掉它。
   */
  dirMove: (
    relPath: string,
    targetParentRel: string,
    newTitle: string | null = null,
    updateLinks = true,
  ) =>
    call<RenameOutcome>('dir_move', { relPath, targetParentRel, newTitle, updateLinks }),

  /** 命令行指定的 Vault（`mimenote.exe <目录>`）；无则返回 null。 */
  startupVault: () => call<string | null>('startup_vault'),

  /** 链接索引状态。 */
  indexStatus: () => call<IndexStatus>('index_status'),
  /** 某篇笔记的出链与反向链接。 */
  noteLinks: (relPath: string) => call<NoteLinks>('note_links', { relPath }),

  /** 某篇笔记的标签与 frontmatter 属性。 */
  noteTags: (relPath: string) => call<NoteTags>('note_tags', { relPath }),
  /**
   * 在笔记的 frontmatter 上**加/删标签**（标签面板的写入口，见 ADR-0006 的后续修订）。
   *
   * - 传的是**增与删**，不是"新的完整列表"：面板上的列表可能比磁盘旧一拍，
   *   传"想要什么"会在这种情况下静默丢掉别的标签；
   * - `baseMtimeMs` 是**必填**的版本令牌：磁盘被外部改过 → `CONFLICT`（附 `currentMtimeMs`），
   *   与 `note_write` 同一套语义，**绝不静默覆盖**（ADR-0004）；
   * - 幂等：结果与磁盘一致时 `changed === false`，不写盘、不动 mtime、不重建索引。
   */
  noteSetTags: (relPath: string, add: readonly string[], remove: readonly string[], baseMtimeMs: number) =>
    call<SetTagsOutcome>('note_set_tags', {
      relPath,
      add: [...add],
      remove: [...remove],
      baseMtimeMs,
    }),
  /** 全库标签概览（按笔记数降序）。 */
  tagsList: () => call<TagSummary[]>('tags_list'),
  /** 某个标签下的笔记（`key` 为归一化键）。 */
  tagNotes: (key: string) => call<TagNotes>('tag_notes', { key }),
  /**
   * 组合过滤：含 `any` 里任意一个（空数组 = 全部有标签的笔记）且**不含** `none` 里任何一个。
   *
   * 一次往返出结果 —— 层级标签的"含子标签"与"有 A 且没有 B"都由宿主在索引上算
   * （前端逐个标签问会变成 N 次 IPC，见 `commands.rs` 里 `tag_filter` 的文档）。
   * `includeChildren` 打开时 `父` 也匹配 `父/子`、`父/子/孙`（按 `/` 切段比较）。
   */
  tagFilter: (any: readonly string[], none: readonly string[], includeChildren: boolean) =>
    call<TagFilterResult>('tag_filter', { any: [...any], none: [...none], includeChildren }),

  /**
   * **标签重命名 / 合并**：把全库所有笔记里的 `from` 换成 `to`。
   *
   * 与 {@link ipc.noteSetTags} 的区别不只是"批量"：这个动作**会改正文**里的行内
   * `#标签`（重命名不改正文就是假的），因此它走的是宿主里 `mn_core::tags::rename_tags`
   * 那一份判定（跳过代码块/行内代码/HTML 注释/frontmatter 区块，与抽取器同源）。
   *
   * - `dryRun: true` 走**完全一样**的候选集与判定，只是不落盘 —— 对话框据此先说出
   *   "这会改 N 篇笔记"，那句话与真正执行时改的篇数同源；
   * - `includeChildren` 缺省 `true`：`父` 改名时把 `父/子` 一起带成 `母/子`；
   * - 结果里 `edited` 与 `skipped` 分开列（跳过原因见 {@link TagSkipReason}），
   *   单篇写失败不会中断整批；重试幂等（已经改过的文件在新一轮里"无需改动"）；
   * - 没有 `baseMtimeMs`：它动的不是"用户正在编辑的这一篇"而是全库，逐篇的版本令牌
   *   由宿主用条目表里的 `(mtime,size)` 与磁盘对账（对不上 → 该篇跳过并如实报告）。
   */
  tagRename: (
    from: string,
    to: string,
    options: { includeChildren?: boolean; dryRun?: boolean } = {},
  ) =>
    call<TagRenameOutcome>('tag_rename', {
      from,
      to,
      includeChildren: options.includeChildren ?? true,
      dryRun: options.dryRun ?? false,
    }),

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
   * 把本地图片读成 base64（导出时内嵌成 `data:` URL）。
   *
   * 与 `assetAuthorize` 共用同一套路径校验与扩展名白名单，区别只是"给绝对路径"还是"给字节"。
   * 返回里只含**成功读到**的条目：越界、符号链接逃逸、非图片、不存在、超过单张/单批上限的
   * 都会被宿主跳过 —— 调用方把没返回的图片渲染成占位文字即可。
   */
  assetReadBase64: (relPaths: readonly string[]) =>
    call<AssetBytes[]>('asset_read_base64', { relPaths: [...relPaths] }),

  /**
   * 把一批图片写进 Vault 的附件目录（粘贴 / 拖入的落点，见 ADR-0013）。
   *
   * - `dirRel` 是**附件目录**（`''` = Vault 根；不存在时由宿主创建）；
   * - `files` 是"文件名 + base64 字节"；命名与扩展名推断在前端完成
   *   （`domain/attachments.ts`，因为它要知道 MIME 与用户可见的文件名）；
   * - 返回值是**去重之后**的最终路径（宿主绝不覆盖同名文件），按请求顺序对应；
   * - 宿主的硬性限制：只接受图片扩展名、单张 ≤ 8 MiB、一批 ≤ 32 MiB、一次 ≤ 32 张，
   *   目标路径一律过 `path_guard`。失败时**整批都不落盘**（错误码见 `UNSUPPORTED_MEDIA`
   *   / `TOO_LARGE` / `PATH_INVALID`）。
   */
  attachmentSave: (dirRel: string, files: readonly AttachmentInput[]) =>
    call<AttachmentSaved[]>('attachment_save', { dirRel, files: [...files] }),

  /**
   * 把导出好的 HTML 写到**用户在系统保存对话框里选定的绝对路径**。
   *
   * 这是宿主里唯一允许写 Vault 之外路径的写命令，因此它只接受 `.html` / `.htm`
   * （避免变成"任意文件写入"的后门），大小上限 32 MiB。
   */
  exportWriteHtml: (path: string, html: string) =>
    call<ExportWriteOutcome>('export_write_html', { path, html }),

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
