/**
 * IPC 契约的 TypeScript 镜像。
 *
 * ⚠️ 这些类型必须与 Rust 侧结构逐字段一致（见 `docs/architecture.md` §3.1；
 * 由 `scripts/check-ipc.mjs` 逐字段自动校验，新 DTO 要登记进它的 `DTO_MANIFEST`）：
 * - `mn_core::scanner::EntryMeta`
 * - `mimenote_lib::commands::{vault, notes, tags, trash, search, system}` 各领域模块的 DTO
 * - `mimenote_lib::assets::{AssetGrant, AssetBytes}`
 * - `mimenote_lib::attachments::{AttachmentInput, AttachmentSaved}`
 * - `mimenote_lib::export::ExportWriteOutcome`
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

/**
 * frontmatter 标签增删的结果（`mimenote_lib::commands::SetTagsOutcome`）。
 *
 * 与 {@link WriteOutcome} 的区别是三个"只有它才有"的输出：`changed`（幂等标志）、
 * `tags`（写入后磁盘上真实的标签）与 `text`（写入后的整篇文本）。
 */
export interface SetTagsOutcome {
  relPath: string
  /** 新的版本令牌；**没有实际改动时与请求里的 `baseMtimeMs` 相同**。 */
  mtimeMs: number
  sizeBytes: number
  /** 实际写入耗时（毫秒，含 fsync）；幂等请求为 0。 */
  writtenInMs: number
  /** 是否真的写了盘（`false` = 结果与磁盘上的完全一致，一个字节都没动）。 */
  changed: boolean
  /** 写入后**磁盘上真实的** frontmatter 标签（保留用户写法、去重、保序）。 */
  tags: string[]
  /**
   * 写入后的整篇文本（原始文本，未解释 BOM/换行）。
   *
   * 带回整篇是为了让编辑器内存**一次往返**就能对齐磁盘：再 `note_read` 一次会在
   * "读完到写回"之间多开一个竞态窗口（用户此刻敲的字用的是旧文本）。
   */
  text: string
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

/**
 * 回收站列表里的一条：台账记录 + **它现在还在不在**。
 *
 * `present === false` 是"孤儿记录"（台账还在，但 `.mimenote/trash` 里那个文件已经没了 ——
 * 用户手工清理过，或同步盘搬走了）。界面必须如实区分"可以恢复"与"东西已经没了"，
 * 而不是让用户点下去才吃到 `NOT_FOUND`。
 */
export interface TrashEntry extends TrashRecord {
  present: boolean
}

/** `note_restore` 的结果。 */
export interface RestoreSummary {
  id: string
  originalRelPath: string
  /** 实际恢复到哪个 Vault 相对路径（「恢复为…」时与 `originalRelPath` 不同）。 */
  restoredRelPath: string
  isDir: boolean
  /** 为了放回它新建了哪些目录（自浅到深）—— 界面要能说清"顺手建了 2 个目录"。 */
  createdDirs: string[]
  restoredToOriginalPlace: boolean
  /**
   * 宿主要求前端调一次静默重扫。
   *
   * 目录恢复会置 `true`（一个目录可能带几百个文件，逐条构造条目等于把扫描口径抄第二遍），
   * 单篇恢复读回失败时也会置 `true` 作为兜底。
   */
  needsRescan: boolean
}

/** `tag_filter` 的结果：含 any 里任意一个、不含 none 里任何一个的那些笔记。 */
export interface TagFilterResult {
  /** 命中的笔记（Vault 相对路径，**字典序**）。 */
  paths: string[]
  /** 命中数（= `paths.length`）。 */
  matched: number
  /** 这个索引里"有标签的笔记"总数（空态文案用："这个 Vault 还没有带标签的笔记"）。 */
  tagged: number
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

/** 一次标签重命名/合并里被真正改写的某篇笔记（`mimenote_lib::commands::TagRenameFile`）。 */
export interface TagRenameFile {
  relPath: string
  /** frontmatter 里被改写的条数（含合并时被去掉的重复项）。 */
  frontmatterEdits: number
  /** 正文里被换成新写法的 `#标签` 处数。 */
  inlineEdits: number
  /** 正文里因合并被去掉的重复提及处数。 */
  inlineRemoved: number
}

/**
 * 一篇笔记被跳过（没改）的**原因**（`mimenote_lib::commands::TagSkipReason`）。
 *
 * 它不是 `ErrorCode`：一次操作会碰几十上百个文件，每篇的处境都不同 ——
 * 用错误码表达等于把"部分成功"折叠成"失败"，界面也就无法如实说出
 * "改了 12 篇，3 篇因为磁盘被外部改动没改"。
 */
export type TagSkipReason = 'external-change' | 'unreadable' | 'write-failed'

/** 一篇被跳过的笔记（`mimenote_lib::commands::TagRenameSkip`）。 */
export interface TagRenameSkip {
  relPath: string
  /** 稳定原因（界面按它分组给出一句人话）。 */
  reason: TagSkipReason
  /** 宿主侧的具体原因（例如"读取失败：文件不存在"）。 */
  message: string
}

/**
 * 标签重命名 / 合并的结果（`mimenote_lib::commands::TagRenameOutcome`）。
 *
 * 与 {@link SetTagsOutcome} 最大的区别是**没有 `text`**：这次动的是几十上百篇，
 * 把它们的全文塞进报文既没有用处也会撑爆大 Vault。需要"编辑器内存对齐磁盘"的只有
 * 当前打开的那一篇，前端按 `edited` 里的路径自己重读一次即可。
 */
export interface TagRenameOutcome {
  /** 源标签的归一化键。 */
  from: string
  /** 目标标签的归一化键。 */
  to: string
  /** 用户输入的源写法（回显用）。 */
  fromDisplay: string
  /** 用户输入的新写法（回显用）。 */
  toDisplay: string
  /** 是否连带层级子标签（`父` → `母` 时 `父/子` → `母/子`）。 */
  includeChildren: boolean
  /** 是否是"只查询、不落盘"的预演（对话框里那句"这会改 N 篇笔记"）。 */
  dryRun: boolean
  /** 标签索引给出的候选笔记数（含最终"无需改动"的那些）。 */
  candidates: number
  /** 被真正改写（预演时是"将会被改写"）的笔记，按路径字典序。 */
  edited: TagRenameFile[]
  /** 被跳过的笔记 + 原因，按路径字典序。 */
  skipped: TagRenameSkip[]
  /** 候选里不需要改的笔记数（上一轮已经改过、或索引比磁盘旧一拍）。 */
  unchanged: number
  frontmatterEdits: number
  inlineEdits: number
  inlineRemoved: number
  elapsedMs: number
}

/** 一张本地图片的读取授权（`mimenote_lib::assets::AssetGrant`，见 ADR-0007）。 */
export interface AssetGrant {
  /** 图片的 Vault 相对路径（与请求里的写法一致，POSIX）。 */
  relPath: string
  /** 磁盘上的绝对路径（前端交给 `convertAssetUrl` 变成 asset URL）。 */
  absolutePath: string
  sizeBytes: number
}

/**
 * 一张本地图片的内容（`mimenote_lib::assets::AssetBytes`，导出内嵌用）。
 *
 * 与 {@link AssetGrant} 是同一个授权面的两个出口：授权返回"能读的绝对路径"（预览用 asset 协议），
 * 这里直接返回**字节**（导出把图片写成 `data:` URL，见 `features/export/`）。
 */
export interface AssetBytes {
  /** 图片的 Vault 相对路径（与请求里的写法一致，POSIX）。 */
  relPath: string
  /** MIME 类型（由扩展名决定，如 `image/png`）。 */
  mime: string
  /** **标准 base64**（RFC 4648，含 `=` 填充）的内容。 */
  dataBase64: string
  /** 原始字节数（不是 base64 之后的长度）。 */
  sizeBytes: number
}

/**
 * 待写入的一张附件（`mimenote_lib::attachments::AttachmentInput`）。
 *
 * 为什么传**字节**而不是磁盘路径：WebView 里拿到的 `File` / `ClipboardEvent` 只有字节，
 * 没有可用的本地路径；而"让宿主按前端给的路径去复制文件"等于开一条任意文件读取通道
 * （理由见 ADR-0013）。
 */
export interface AttachmentInput {
  /** 落盘用的文件名（含扩展名；命名规则见 `domain/attachments.ts`）。 */
  name: string
  /** **标准 base64**（RFC 4648，含 `=` 填充）的原始字节。 */
  dataBase64: string
}

/**
 * 落盘成功的一张附件（`mimenote_lib::attachments::AttachmentSaved`）。
 *
 * `relPath` 是**去重之后**的最终路径（宿主绝不覆盖同名文件），前端据此插入链接。
 */
export interface AttachmentSaved {
  /** Vault 相对路径（POSIX），例如 `附件/粘贴图片 2025-01-01 123456.png`。 */
  relPath: string
  /** **原始字节数**（不是 base64 之后的长度）。 */
  sizeBytes: number
}

/** 导出落盘结果（`mimenote_lib::export::ExportWriteOutcome`）。 */
export interface ExportWriteOutcome {
  /** 实际写入的绝对路径（原样回显用户在保存对话框里选的路径）。 */
  absolutePath: string
  sizeBytes: number
  /** 实际写入耗时（毫秒，含 fsync）。 */
  writtenInMs: number
}

// ---------------------------------------------------------------------------
// 整库导出静态站点（ADR-0019）
//
// 形状的由来：Markdown→HTML 的**唯一一份**渲染管线在前端（`domain/markdown.ts`），
// 链接解析的**唯一一份**规则在链接索引（`mn-index`）。因此整库导出天然是三段：
// **宿主出计划**（谁指向谁、每篇落在哪个 URL）→ **前端渲染** → **宿主批量落盘**。
// 这一组类型就是那三段之间唯一的契约。
// ---------------------------------------------------------------------------

/**
 * 一份笔记在站点里的位置（`mn_index::site::SitePage`）。
 *
 * `urlPath` 是**已编码**的站内路径（CJK 与 `#` 都会变成百分号编码），而 `pagePath` 是
 * 磁盘上的真实相对路径（保留原文件名）—— 两者故意分开：磁盘上要能直接双击打开，
 * href 里要能安全地放进 `<a href>`。
 */
export interface SitePage {
  /** 源笔记的 Vault 相对路径。 */
  relPath: string
  /** 站内相对路径（`项目/设计.html`）。 */
  pagePath: string
  /** 编码后的站内路径（`%E9%A1%B9%E7%9B%AE/%E8%AE%BE%E8%AE%A1.html`）。 */
  urlPath: string
  /** 页面标题（frontmatter `title` 优先，其次文件名主干 —— 与图谱卡片同口径）。 */
  title: string
  /** 该篇的标签（去重后按归一化键排序，值是首次出现的写法）。 */
  tags: string[]
  /** 出链（按正文出现顺序）。 */
  links: SiteLink[]
  /** 指向本篇的来源笔记（相对路径，已排序）—— 页面底部的反向链接用它。 */
  backlinks: string[]
}

/**
 * 页面里的一条 wikilink 解析结果（`mn_index::site::SiteLink`）。
 *
 * `target` 与前端渲染出的 `data-target` **逐字一致**，前端据此查表把 `href` 贴上去 ——
 * 于是"链接怎么解析"这条规则只有索引那一份，前端不复制。
 */
export interface SiteLink {
  /** 原文里写的目标（`[[目标|别名#锚点]]` 里取 `目标` 那一段）。 */
  target: string
  anchor: string | null
  /** 相对本页的 href（已编码、含片段）；`null` = 悬空链接（目标还不存在）。 */
  href: string | null
  /** 显示文本（别名优先）。 */
  display: string
}

/** 页面被改名（同名笔记映射到同一个 `.html` 时，只有一份能占住原名）。 */
export interface SiteRename {
  relPath: string
  pagePath: string
}

/** 计划统计（进度与结果摘要都用它）。 */
export interface SiteStats {
  notes: number
  pages: number
  links: number
  /** 悬空链接条数（指向不存在的笔记）。 */
  dangling: number
  assets: number
  renamed: SiteRename[]
}

/** 目标目录里**我们上次写的**标记文件内容（`mimenote-export.json`）。 */
export interface SitePreviousExport {
  exportedAtMs: number
  files: string[]
  vaultName: string
}

/** 整库导出计划（`mn_index::site::SitePlan`）。 */
export interface SitePlan {
  vaultName: string
  /** 传了输出目录时回显它（规范化后的绝对路径）；没传 = `null`。 */
  outputDir: string | null
  /** 目标目录里已有的上次导出（按它的文件清单算"这次没写、上次写过"的残留）。 */
  previous: SitePreviousExport | null
  pages: SitePage[]
  stats: SiteStats
  /** 计划里用到的图片（Vault 相对路径）——**只作为提示**，真正的清单来自前端渲染时的收集。 */
  assets: string[]
}

/** 一次批量操作里被跳过的一项（与 `TagRenameSkip` 同一套"如实汇报"口径）。 */
export interface SiteSkip {
  relPath: string
  /**
   * 原因：`not-found` / `unreadable` / `not-utf8` / `too-large` /
   * `unsupported-type` / `path-escape`。
   */
  reason: string
  message: string
}

/** 批量读原文的结果（`mimenote_lib::commands::NotesBatch`）。 */
export interface NotesBatch {
  items: NoteContent[]
  skipped: SiteSkip[]
}

/** 要写进站点的一个文件。 */
export interface SiteFile {
  /** 站内相对路径（`index.html`、`assets/site.css`、`mimenote-export.json`）。 */
  relPath: string
  text: string
}

/** 站点文件落盘结果。 */
export interface SiteWriteOutcome {
  outputDir: string
  files: number
  bytes: number
  writtenInMs: number
  /** 本次新建的目录（站内相对路径，自浅到深）。 */
  createdDirs: string[]
}

/** 要复制进站点的一张图。 */
export interface SiteAssetInput {
  vaultRelPath: string
}

/** 图片复制结果。 */
export interface SiteAssetOutcome {
  copied: number
  bytes: number
  createdDirs: string[]
  skipped: SiteSkip[]
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

/** 图谱里的一个笔记节点（`mn_index::graph::GraphNode`）。 */
export interface GraphNode {
  relPath: string
  /** 展示标题：frontmatter 的 `title` 优先，否则文件名主干。 */
  title: string
  /** 所在目录（POSIX，Vault 根为 `''`）——画布按它把卡片分组到文件夹容器里。 */
  folder: string
  /** 该笔记的标签（原始写法，可能被截断到前若干个）。 */
  tags: string[]
  /** 出链条数（按去重后的边计数）。 */
  outDegree: number
  /** 入链条数（悬空边不计入任何节点）。 */
  inDegree: number
}

/** 图谱里的一条边（`mn_index::graph::GraphEdge`，按 `(from, to)` 去重后带 `count`）。 */
export interface GraphEdge {
  fromRelPath: string
  /** 目标笔记；`null` = 悬空链接（目标还不存在）。 */
  toRelPath: string | null
  /**
   * 链接的**原始目标写法**（已剥离锚点）：`[[还不存在的笔记]]` → `还不存在的笔记`。
   *
   * 悬空边只能靠它显示"指向谁"；解析成功时它同样有意义（用户写的可能和解析结果不同）。
   * 一对 `(from, to)` 去重合并时取**第一条**链接的写法。
   */
  toRawTarget: string
  kind: LinkKind
  /** 同一对笔记之间的链接条数。 */
  count: number
}

/** 一次图谱查询的结果（`mimenote_lib::commands::GraphData`）。 */
export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** 节点数超过上限时只返回度数最高的一部分（前端据此给出提示）。 */
  truncated: boolean
  elapsedMs: number
}

/** 重命名/移动时被改写了链接的某个文件（`mimenote_lib::commands::RenameLinkUpdate`）。 */
export interface RenameLinkUpdate {
  relPath: string
  /** 该文件内被改写的链接条数。 */
  count: number
}

/**
 * 重命名 / 移动结果（`mimenote_lib::commands::RenameOutcome`）。
 *
 * `note_rename` / `note_move` / `dir_rename` / `dir_move` **共用**这一种形状：四者在宿主里是
 * 同一条链路（换位置 + 改写全库链接 + 增量同步索引），前端因此只需一套状态收尾。
 *
 * 目录搬迁（`dirRename` / `dirMove`）时 `oldRelPath` / `newRelPath` 是**目录**路径，
 * `newMtimeMs` 恒为 `0` —— 目录不是版本令牌的载体（ADR-0004 的令牌是**文件** mtime），
 * 前端对目录作用域的搬迁只换路径、不重设令牌。
 */
export interface RenameOutcome {
  oldRelPath: string
  newRelPath: string
  /** 改名后磁盘上的 mtime（新的版本令牌）；目录搬迁时为 0。 */
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
  /**
   * 这一轮**没有读文件**、直接复用落盘索引的笔记数（ADR-0014）。
   *
   * `reusedNotes === indexed` 就是"Vault 没变，一次文件读都没发生"。
   */
  reusedNotes: number
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
  /** 附件类型/载荷不被接受（非图片扩展名、空载荷、非法 base64）—— 宿主 `attachments.rs` 新增。 */
  | 'UNSUPPORTED_MEDIA'
  /**
   * 链接索引还没就绪（正在构建）—— 整库导出（ADR-0019）新增。
   *
   * 为什么不借 `IO`：`describeError` 会把 `IO` 翻成"磁盘读写失败"，而真实情况是
   * "索引还在构建，等一下就好"。那句话比不说还糟：用户会去查磁盘。
   */
  | 'INDEX_NOT_READY'
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
  'UNSUPPORTED_MEDIA',
  'INDEX_NOT_READY',
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
      // 带上宿主/适配器给的具体数字：`TOO_LARGE` 现在同时服务"读太大"与"要存的附件太大"，
      // 一句写死的"安全读取上限"在附件场景里既不准、也丢掉了"到底超了多少"这个唯一有用的信息
      return `${prefix}超过大小上限：${error.message}`
    case 'NOT_UTF8':
      return `${prefix}文件不是 UTF-8 文本，暂不支持编辑`
    case 'UNSUPPORTED_MEDIA':
      // 宿主已经在 message 里点名了是哪个文件、为什么被拒，这里只补一句"该放什么"
      return `${prefix}只接受图片附件（png / jpg / jpeg / gif / webp / avif / bmp / svg / ico）：${error.message}`
    case 'CANCELLED':
      return `${prefix}已取消`
    case 'INDEX_NOT_READY':
      // 宿主已经在 message 里写清了进度（"索引正在构建 3000/4267"），这里只补一句"要做什么"
      return `${prefix}链接索引还在构建，稍等一下再试${error.message.trim() === '' ? '' : `：${error.message}`}`
    case 'IO':
      return `${prefix}磁盘读写失败：${error.message}`
    default:
      return `${prefix}${error.message}`
  }
}

/**
 * 面向用户的文案，但**优先用宿主自己写的那句话**（拿不到才退回 {@link describeError}）。
 *
 * 为什么需要它：`describeError` 是按错误码翻译的，遇到 `PATH_INVALID` 会统一翻成
 * "路径不合法或被拒绝（已阻止越界访问）"—— 那句话对"文件树里拖拽越界"是对的，但对
 * **有具体业务理由**的拒绝就是错的：整库导出把输出目录选在 Vault 里、把标签挂到它自己下面，
 * 宿主写的都是"为什么不行、该怎么做"（"输出目录不能放在 Vault 里面：…"），
 * 一翻译就只剩"路径不合法"，用户完全不知道该怎么办。
 *
 * 判定规则只有一条：**宿主的 message 非空就用它**（宿主的错误信息本来就是写给用户看的中文；
 * 真正面向开发者的细节在 `detail` 里）。空 message 才说明这是"合成"出来的错误，
 * 那时按错误码翻译更靠谱。
 */
export function describeHostReason(error: MimenoteError, context?: string): string {
  const message = error.message.trim()
  if (message !== '') return context === undefined ? message : `${context}：${message}`
  return describeError(error, context)
}
