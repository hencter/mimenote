/**
 * IPC 契约的 TypeScript 镜像。
 *
 * ⚠️ 这些类型必须与 Rust 侧结构逐字段一致（见 `docs/architecture.md` §3.1）：
 * - `mn_core::scanner::EntryMeta`
 * - `mimenote_lib::commands::{VaultInfo, VaultSnapshot, NoteContent, WriteOutcome, SnippetFile, VersionInfo}`
 * - `mn_core::trash::TrashRecord`
 * - `mimenote_lib::error::IpcError`
 *
 * 字段名一律 camelCase（Rust 侧 `#[serde(rename_all = "camelCase")]`）。
 */

/** 文件树条目（扁平表中的一个元素）。 */
export interface EntryMeta {
  /** Vault 相对路径，统一 `/` 分隔。 */
  relPath: string
  /** 文件名（不含路径）。 */
  name: string
  isDir: boolean
  /** 字节数；目录为 0。 */
  sizeBytes: number
  /** mtime（毫秒）；不可得为 null。 */
  mtimeMs: number | null
  /** 小写扩展名（不含点）；目录为 null。 */
  ext: string | null
}

/** Vault 概要。 */
export interface VaultInfo {
  rootPath: string
  name: string
  entryCount: number
  noteCount: number
  folderCount: number
  truncated: boolean
  skipped: number
  scanMs: number
}

/** 打开/重扫时下发的完整扁平条目表。 */
export interface VaultSnapshot {
  rootPath: string
  /** Vault 目录名。 */
  name: string
  entries: EntryMeta[]
  noteCount: number
  folderCount: number
  truncated: boolean
  /** 因权限等原因被跳过的条目数。 */
  skipped: number
  scanMs: number
  generatedAtMs: number
}

/** 笔记原文。`text` 未解释 BOM / 换行（由 `domain/eol.ts` 处理）。 */
export interface NoteContent {
  relPath: string
  text: string
  sizeBytes: number
  /** 版本令牌，保存时必须回传。 */
  mtimeMs: number
}

/** 保存结果。 */
export interface WriteOutcome {
  relPath: string
  mtimeMs: number
  sizeBytes: number
  /** 实际写入耗时（毫秒，含 fsync）。 */
  writtenInMs: number
}

/** 回收站记录。 */
export interface TrashRecord {
  id: string
  originalRelPath: string
  storedRelPath: string
  deletedAtMs: number
  sizeBytes: number
  isDir: boolean
}

/** 用户 CSS 片段。 */
export interface SnippetFile {
  name: string
  css: string
  sizeBytes: number
}

/** 版本信息。 */
export interface VersionInfo {
  app: string
  core: string
  tauri: string
}

/** 文本统计（`mn_core::text_stats::TextStats`）。 */
export interface TextStats {
  chars: number
  charsNoWhitespace: number
  words: number
  cjkChars: number
  lines: number
  readingMinutes: number
}

/** 磁盘上某个文档的真实统计（`mimenote_lib::commands::DocumentStats`）。 */
export interface DocumentStats {
  relPath: string
  sizeBytes: number
  mtimeMs: number
  stats: TextStats
}

/** 链接类型（`mn_core::links::LinkKind`）。 */
export type LinkKind = 'wiki' | 'embed' | 'markdown'

/** 一条出链（`mn_index::ResolvedLink`）。 */
export interface ResolvedLink {
  kind: LinkKind
  /** 原始目标（已剥离锚点）。 */
  rawTarget: string
  /** 展示文本：别名 > 目标 > `#锚点`。 */
  display: string
  alias: string | null
  anchor: string | null
  /** 1 起的行号。 */
  line: number
  /** 解析到的笔记相对路径；`null` = 悬空链接。 */
  resolvedRelPath: string | null
  /** 同名多篇（已按规则挑了一个）。 */
  ambiguous: boolean
}

/** 一条反向链接（`mn_index::BacklinkRef`）。 */
export interface BacklinkRef {
  fromRelPath: string
  display: string
  anchor: string | null
  line: number
  kind: LinkKind
}

/** 某篇笔记的链接情况（`mn_index::NoteLinks`）。 */
export interface NoteLinks {
  relPath: string
  outbound: ResolvedLink[]
  backlinks: BacklinkRef[]
  unresolvedCount: number
}

/** 标签来源（`mn_core::tags::TagSource`）。 */
export type TagSource = 'frontmatter' | 'inline'

/** 抽取到的一个标签（`mn_core::tags::TagRef`）。 */
export interface TagRef {
  /** 显示写法：**不含**开头的 `#`，保留原有大小写与层级。 */
  tag: string
  source: TagSource
  /** 1 起的行号。 */
  line: number
}

/**
 * frontmatter 字段值（`mn_core::frontmatter::FrontmatterValue`）。
 *
 * 内部标签枚举（`kind` 判别），与 Rust 侧 serde 形状逐字一致：数字**保留原始文本**，
 * 不做类型推断（`1.50` 就是 `"1.50"`）。
 */
export type FrontmatterValue =
  | { kind: 'scalar'; value: string }
  | { kind: 'list'; value: string[] }
  | { kind: 'bool'; value: boolean }
  | { kind: 'number'; value: string }
  | { kind: 'null' }

/** frontmatter 的一个字段（`mn_core::frontmatter::FrontmatterField`，保序）。 */
export interface FrontmatterField {
  key: string
  value: FrontmatterValue
  /** 1 起的绝对行号（首行 `---` 是第 1 行）。 */
  line: number
}

/** 某篇笔记的标签与属性（`mimenote_lib::commands::NoteTags`）。 */
export interface NoteTags {
  relPath: string
  /** frontmatter 与正文行内标签（frontmatter 在前，已按归一化键去重）。 */
  tags: TagRef[]
  /** frontmatter 字段（保序）；没有 frontmatter 时为空数组。 */
  frontmatter: FrontmatterField[]
}

/** 全库标签概览中的一项（`mimenote_lib::commands::TagSummaryDto`）。 */
export interface TagSummary {
  /** 归一化后的键（小写、去首尾 `/`）。 */
  key: string
  /** 首次出现的原始写法（带大小写与层级）。 */
  tag: string
  /** 含该标签的笔记数。 */
  count: number
}

/** 某个标签下的笔记（`mimenote_lib::commands::TagNotes`）。 */
export interface TagNotes {
  key: string
  /** 笔记相对路径（字典序）。 */
  notes: string[]
}

/** 一张本地图片的读取授权（`mimenote_lib::assets::AssetGrant`，见 ADR-0007）。 */
export interface AssetGrant {
  /** 图片的 Vault 相对路径（与请求里的写法一致，POSIX）。 */
  relPath: string
  /** 磁盘上的绝对路径（前端交给 `convertAssetUrl` 变成 asset URL）。 */
  absolutePath: string
  sizeBytes: number
}

/** 一条搜索命中（`mimenote_lib::commands::SearchHit`）。 */
export interface SearchHit {
  relPath: string
  /** 命中的行号（1 起）。 */
  line: number
  /** 命中行的纯文本片段（已裁剪到一行、约 120 字符以内，不含 Markdown 语法）。 */
  snippet: string
  /** 相关性分数（越大越相关，仅用于排序，不展示给用户）。 */
  score: number
}

/** 搜索结果（`mimenote_lib::commands::SearchResult`）。 */
export interface SearchResult {
  /** 原样回显查询串（丢弃过期响应时用于比对）。 */
  query: string
  /** 命中列表（已按 score 降序、同分按 relPath/line 升序；最多 `limit` 条）。 */
  hits: SearchHit[]
  /** 命中总数（可能大于 `hits.length`）。 */
  total: number
  elapsedMs: number
}

/** 重命名时被改写了链接的某个文件（`mimenote_lib::commands::RenameLinkUpdate`）。 */
export interface RenameLinkUpdate {
  relPath: string
  /** 该文件内被改写的链接条数。 */
  count: number
}

/** 重命名结果（`mimenote_lib::commands::RenameOutcome`）。 */
export interface RenameOutcome {
  oldRelPath: string
  newRelPath: string
  /** 改名后磁盘上的 mtime（新的版本令牌）。 */
  newMtimeMs: number
  /** 被改写了链接的文件（按 relPath 排序）。 */
  updatedLinks: RenameLinkUpdate[]
  /** 改写链接总数（= `updatedLinks` 的 count 之和）。 */
  updatedLinkCount: number
  elapsedMs: number
}

/** 索引阶段（`mimenote_lib::indexer::IndexPhase`）。 */
export type IndexPhase = 'idle' | 'building' | 'ready' | 'cancelled' | 'failed'

/** 索引状态（`mimenote_lib::indexer::IndexStatus`）。 */
export interface IndexStatus {
  phase: IndexPhase
  indexed: number
  total: number
  durationMs: number
  links: number
}

/**
 * 稳定错误码（与 `mn_core::ErrorCode` 一一对应）。
 *
 * UI **只按** code 分支，不解析 message。
 */
export type ErrorCode =
  | 'VAULT_NOT_SET'
  | 'PATH_INVALID'
  | 'PATH_ESCAPE'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'NOT_A_DIRECTORY'
  | 'IS_DIRECTORY'
  | 'TOO_LARGE'
  | 'CONFLICT'
  | 'CONFIRMATION_REQUIRED'
  | 'IO'
  | 'NOT_UTF8'
  /** 宿主内部错误（面板/painc/适配器未初始化等）。 */
  | 'INTERNAL'
  /** 用户取消（例如关闭了文件夹选择框）。 */
  | 'CANCELLED'
  /** 无法识别的错误（兜底，不应用于分支）。 */
  | 'UNKNOWN'

const KNOWN_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'VAULT_NOT_SET',
  'PATH_INVALID',
  'PATH_ESCAPE',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'NOT_A_DIRECTORY',
  'IS_DIRECTORY',
  'TOO_LARGE',
  'CONFLICT',
  'CONFIRMATION_REQUIRED',
  'IO',
  'NOT_UTF8',
  'INTERNAL',
  'CANCELLED',
])

/** Rust `IpcError` 的序列化形态。 */
export interface IpcErrorPayload {
  code: string
  message: string
  detail: string | null
  currentMtimeMs: number | null
}

/** 面向 UI 的统一错误类型。 */
export class MimenoteError extends Error {
  override readonly name = 'MimenoteError'
  readonly code: ErrorCode
  readonly detail: string | null
  /** `CONFLICT` 时磁盘上的当前 mtime。 */
  readonly currentMtimeMs: number | null

  constructor(payload: IpcErrorPayload) {
    super(payload.message)
    this.code = (KNOWN_CODES.has(payload.code) ? payload.code : 'UNKNOWN') as ErrorCode
    this.detail = payload.detail ?? null
    this.currentMtimeMs = payload.currentMtimeMs ?? null
  }

  /** 是否为"文件被外部修改"冲突。 */
  get isConflict(): boolean {
    return this.code === 'CONFLICT'
  }

  /** 把任意抛出物归一化为 `MimenoteError`（IPC 层唯一的错误入口）。 */
  static from(cause: unknown): MimenoteError {
    if (cause instanceof MimenoteError) return cause
    if (isIpcErrorPayload(cause)) return new MimenoteError(cause)
    if (cause instanceof Error) {
      return new MimenoteError({
        code: 'UNKNOWN',
        message: cause.message,
        detail: cause.stack ?? null,
        currentMtimeMs: null,
      })
    }
    return new MimenoteError({
      code: 'UNKNOWN',
      message: typeof cause === 'string' ? cause : JSON.stringify(cause),
      detail: null,
      currentMtimeMs: null,
    })
  }

  /** 是否值得重试（目前仅用于 UI 提示文案）。 */
  get isRetryable(): boolean {
    return this.code === 'IO' || this.code === 'INTERNAL' || this.code === 'UNKNOWN'
  }
}

function isIpcErrorPayload(value: unknown): value is IpcErrorPayload {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.code === 'string' && typeof candidate.message === 'string'
}

/** 面向用户的错误文案（集中管理，避免散落在各组件）。 */
export function describeError(error: MimenoteError, context?: string): string {
  const prefix = context ? `${context}：` : ''
  switch (error.code) {
    case 'VAULT_NOT_SET':
      return `${prefix}尚未打开 Vault`
    case 'CONFLICT':
      return `${prefix}文件已被外部修改，请选择覆盖保存或重新加载`
    case 'CONFIRMATION_REQUIRED':
      return `${prefix}该操作需要二次确认`
    case 'PATH_INVALID':
    case 'PATH_ESCAPE':
      return `${prefix}路径不合法或被拒绝（已阻止越界访问）`
    case 'NOT_FOUND':
      return `${prefix}文件不存在（可能已被外部删除或移动）`
    case 'ALREADY_EXISTS':
      return `${prefix}目标已存在`
    case 'NOT_A_DIRECTORY':
      return `${prefix}目标不是目录`
    case 'IS_DIRECTORY':
      return `${prefix}目标是目录，不能作为笔记打开`
    case 'TOO_LARGE':
      return `${prefix}文件过大，已超过安全读取上限`
    case 'NOT_UTF8':
      return `${prefix}文件不是 UTF-8 文本，暂不支持编辑`
    case 'CANCELLED':
      return `${prefix}已取消`
    case 'IO':
      return `${prefix}磁盘读写失败：${error.message}`
    default:
      return `${prefix}${error.message}`
  }
}
