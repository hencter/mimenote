//! IPC 命令：`mn-core` 能力的最小暴露面。
//!
//! 每个命令都遵守 ADR-0003 的契约：
//!
//! * `async fn` + `spawn_blocking`（文件 IO 绝不在主线程）；
//! * 参数与返回值均为 camelCase DTO；
//! * 失败返回 [`IpcError`]（稳定错误码）。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, State};

use mn_core::atomic::{read_text, write_atomic};
use mn_core::path_guard::sanitize_file_stem;
use mn_core::scanner::{scan, EntryMeta, ScanOptions};
use mn_core::trash::{list_trash, move_to_trash, restore_as, restore_from_trash, TrashRecord};
use mn_core::{Error, VaultRoot};
use mn_index::graph::GraphData;
use mn_index::rename::{LinkUpdate, RenameReport};
use mn_index::tags::TagSummary;
use mn_index::NoteLinks;

use crate::error::IpcError;
use crate::indexer::{self, IndexStatus};
use crate::state::{AppState, VaultCtx};

/// 单个 Markdown 文件的读取上限。
const MAX_READ_BYTES: u64 = mn_core::DEFAULT_MAX_READ_BYTES;
/// 单个 CSS 片段的大小上限。
const MAX_SNIPPET_BYTES: u64 = 512 * 1024;

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

/// Vault 概要信息。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    /// 面向用户展示的绝对根路径。
    pub root_path: String,
    /// Vault 目录名。
    pub name: String,
    /// 条目总数（含目录）。
    pub entry_count: usize,
    /// Markdown 笔记数。
    pub note_count: usize,
    /// 目录数。
    pub folder_count: usize,
    /// 是否因条目上限而截断。
    pub truncated: bool,
    /// 因权限等原因被跳过的条目数。
    pub skipped: usize,
    /// 本次扫描耗时（毫秒）。
    pub scan_ms: u64,
}

/// 完整的扁平条目表（仅在打开/重扫时下发）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSnapshot {
    pub root_path: String,
    /// Vault 目录名。
    pub name: String,
    pub entries: Vec<EntryMeta>,
    pub note_count: usize,
    pub folder_count: usize,
    pub truncated: bool,
    /// 因权限等原因被跳过的条目数。
    pub skipped: usize,
    pub scan_ms: u64,
    pub generated_at_ms: u64,
}

/// 笔记内容。`text` 是**原始文本**（BOM/换行风格由前端领域层解释）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteContent {
    pub rel_path: String,
    pub text: String,
    pub size_bytes: u64,
    /// 版本令牌：保存时必须回传（见 ADR-0004）。
    pub mtime_ms: u64,
}

/// 写入结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteOutcome {
    pub rel_path: String,
    /// 写入后的新版本令牌。
    pub mtime_ms: u64,
    pub size_bytes: u64,
    /// 实际写入耗时（毫秒，含 fsync），状态栏展示用。
    pub written_in_ms: u64,
}

/// frontmatter 标签增删的结果（`note_set_tags`）。
///
/// 为什么不复用 [`WriteOutcome`]：这个方法有两个"只有它才有"的输出 —— **写入后的标签列表**
/// 与**幂等标志**。前者让前端能如实告诉用户"这条标签来自 `tag:` 字段、没被删掉"，
/// 后者区分"真的改了文件"与"本来就一样"（后者不写盘、不动 mtime、不重建索引）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetTagsOutcome {
    pub rel_path: String,
    /// 新的版本令牌；**没有实际改动时与请求里的 `baseMtimeMs` 相同**。
    pub mtime_ms: u64,
    pub size_bytes: u64,
    /// 实际写入耗时（毫秒，含 fsync）；幂等请求为 0。
    pub written_in_ms: u64,
    /// 是否真的写了盘（`false` = 新的标签列表与磁盘上的完全一致，一个字节都没动）。
    pub changed: bool,
    /// 写入后**磁盘上真实的** frontmatter 标签（保留用户写法、去重、保序）。
    pub tags: Vec<String>,
    /// 写入后的整篇文本。
    ///
    /// 为什么要把它一起带回去（而不是让前端再 `note_read` 一次）：前端必须把编辑器内存对齐到
    /// 磁盘，否则下一次自动保存会把刚加的标签覆盖掉；再读一次会在"读完到写回"之间多开一个
    /// 竞态窗口（用户此刻敲的字用的是旧文本）。一次往返里把"磁盘现在是什么"讲清楚最安全。
    pub text: String,
}

/// 一次标签重命名/合并里**被真正改写**的一篇笔记。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagRenameFile {
    pub rel_path: String,
    /// frontmatter 里被改写的条数（含合并时被去掉的重复项）。
    pub frontmatter_edits: u32,
    /// 正文里被换成新写法的 `#标签` 个数。
    pub inline_edits: u32,
    /// 正文里因合并被去掉的重复提及数。
    pub inline_removed: u32,
}

/// 一篇笔记被跳过（没改）的原因。
///
/// **这不是错误码**（刻意与 [`mn_core::ErrorCode`] 分开）：一次操作会碰几十上百个文件，
/// 每个文件各自的处境不同 —— 用错误码表达等于把"部分成功"强行折叠成"失败"，
/// 前端也就无法如实说出"改了 12 篇，3 篇因为磁盘被外部改动没改"。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TagSkipReason {
    /// 这一篇在计划之后、落笔之前被外部改过（条目表里的 `(mtime,size)` 与磁盘不一致）。
    ExternalChange,
    /// 读不到（已被外部删掉、不是 UTF-8、超过读取上限、权限不足……名目在 `message` 里）。
    Unreadable,
    /// 读到了、也算出了新文本，但写盘失败（只读 Vault、磁盘满、被占用）。
    WriteFailed,
}

/// 一篇被跳过的笔记。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagRenameSkip {
    pub rel_path: String,
    /// 稳定原因（前端按它分组给出人话）。
    pub reason: TagSkipReason,
    /// 面向用户的一句话（宿主侧的真实原因，例如"读取失败：文件不存在"）。
    pub message: String,
}

/// 标签重命名 / 合并的结果。
///
/// 为什么不像 `note_set_tags` 那样带 `text`：这次动的是**几十上百篇**，把它们的全文
/// 一起塞进 IPC 报文既没有用处（前端不显示别人的正文），也不安全（大 Vault 会撑爆报文）。
/// 需要"编辑器内存对齐磁盘"的只有当前打开的那一篇，前端按 `edited` 里的路径自己重读一次即可。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagRenameOutcome {
    /// 源标签的**归一化键**（与索引、面板高亮同一把尺子）。
    pub from: String,
    /// 目标标签的**归一化键**。
    pub to: String,
    /// 用户输入的源写法（回显用）。
    pub from_display: String,
    /// 用户输入的新写法（回显用）。
    pub to_display: String,
    /// 是否连带层级子标签（`父` → `母` 时 `父/子` → `母/子`）。
    pub include_children: bool,
    /// 是否是"只查询、不落盘"的预演（对话框里那句"这会改 N 篇笔记"）。
    pub dry_run: bool,
    /// 标签索引给出的候选笔记数（含最终"无需改动"的那些）。
    pub candidates: u32,
    /// 被真正改写的笔记（按路径字典序）；预演时是"将会被改写"的那些。
    pub edited: Vec<TagRenameFile>,
    /// 被跳过的笔记 + 原因（按路径字典序）。
    pub skipped: Vec<TagRenameSkip>,
    /// 候选里**不需要改**的笔记数（读盘后发现旧写法已经不在里面了 —— 多半是上一次重试
    /// 已经改过它，或者索引比磁盘旧一拍）。不计入 `edited`/`skipped`。
    pub unchanged: u32,
    /// 被改写的 frontmatter 条数合计。
    pub frontmatter_edits: u32,
    /// 被改写的正文行内标签处数合计。
    pub inline_edits: u32,
    /// 被去掉的重复提及处数合计（合并）。
    pub inline_removed: u32,
    /// 整条命令的实测耗时（毫秒）。
    pub elapsed_ms: u64,
}

/// 重命名时被改写了链接的某个文件。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameLinkUpdate {
    pub rel_path: String,
    /// 该文件里被改写的链接条数。
    pub count: u32,
}

impl From<LinkUpdate> for RenameLinkUpdate {
    fn from(update: LinkUpdate) -> Self {
        Self {
            rel_path: update.rel_path,
            count: update.count,
        }
    }
}

/// 重命名结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameOutcome {
    pub old_rel_path: String,
    pub new_rel_path: String,
    /// 改名后的新版本令牌（口径与 `NoteContent.mtimeMs` 一致）。
    ///
    /// 类型刻意跟随现有 DTO 用 `u64`（JSON 里同样是数字，前端镜像为 `number` 即可）。
    pub new_mtime_ms: u64,
    /// 被改写了链接的文件，按 `relPath` 字典序。
    ///
    /// 被改名的笔记**自身**若含自链接，它的条目用**旧路径**报告 —— 前端要在"改名前的
    /// 坐标系"里判断"我正在编辑的这一篇也被改写了"（见 `app/actions.ts`）。
    pub updated_links: Vec<RenameLinkUpdate>,
    /// 被改写链接的总数（`updated_links` 的 count 之和）。
    pub updated_link_count: u32,
    /// 整条命令的实测耗时（毫秒）。
    pub elapsed_ms: u64,
}

/// 用户 CSS 片段。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetFile {
    pub name: String,
    pub css: String,
    pub size_bytes: u64,
}

/// 版本信息（关于面板用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub app: &'static str,
    pub core: &'static str,
    pub tauri: &'static str,
}

/// 磁盘上某个文档的真实统计（与编辑器内的即时统计互为校验）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentStats {
    pub rel_path: String,
    pub size_bytes: u64,
    pub mtime_ms: u64,
    pub stats: mn_core::TextStats,
}

/// 某篇笔记的标签与 frontmatter 属性。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteTags {
    pub rel_path: String,
    /// frontmatter 与正文行内标签（frontmatter 在前，已按归一化键去重）。
    pub tags: Vec<mn_core::TagRef>,
    /// frontmatter 字段（保序）。**没有 frontmatter 时是空数组，不是 `null`**。
    pub frontmatter: Vec<mn_core::frontmatter::FrontmatterField>,
}

/// 全库标签概览中的一项。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagSummaryDto {
    /// 归一化后的键（小写、去首尾 `/`）。
    pub key: String,
    /// 首次出现的原始写法（保留大小写与层级）。
    pub tag: String,
    /// 含该标签的笔记数。
    pub count: u32,
}

impl From<TagSummary> for TagSummaryDto {
    fn from(summary: TagSummary) -> Self {
        Self {
            key: summary.key,
            tag: summary.tag,
            count: summary.count,
        }
    }
}

/// 某个标签下的笔记。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagNotes {
    /// **归一化后**的键（前端拿到的永远是索引里那个键，便于高亮当前展开项）。
    pub key: String,
    /// 笔记相对路径（字典序）。
    pub notes: Vec<String>,
}

/// 全文搜索的一条命中（行级）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub rel_path: String,
    /// 行号（1 起）。
    pub line: u32,
    /// 命中所在一行的裁剪版（单行、纯文本、约 120 字符以内）。
    pub snippet: String,
    /// 相关性分数（**越大越相关**，仅用于排序；前端不要再排一次）。
    pub score: f64,
}

impl From<mn_index::search::SearchHit> for SearchHit {
    fn from(hit: mn_index::search::SearchHit) -> Self {
        Self {
            rel_path: hit.rel_path,
            line: hit.line,
            snippet: hit.snippet,
            score: hit.score,
        }
    }
}

/// 全文搜索结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    /// 原样回显用户输入。
    pub query: String,
    /// 命中（已按 `score` 降序 → `relPath` → `line` 排好，最多 `limit` 条）。
    pub hits: Vec<SearchHit>,
    /// 命中总数（可能大于 `hits.len()`）。
    pub total: u32,
    /// 实际耗时（毫秒）。
    pub elapsed_ms: u64,
}

// ---------------------------------------------------------------------------
// 后台执行器
// ---------------------------------------------------------------------------

/// 把阻塞 IO 移出主线程。
async fn run_blocking<T, F>(task: F) -> Result<T, IpcError>
where
    F: FnOnce() -> mn_core::Result<T> + Send + 'static,
    T: Send + 'static,
{
    let joined = tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| IpcError::internal(format!("后台任务执行失败：{e}")))?;
    joined.map_err(IpcError::from)
}

// ---------------------------------------------------------------------------
// Vault 生命周期
// ---------------------------------------------------------------------------

/// 打开 Vault：校验路径 → 扫描 → 缓存快照。
///
/// **一次调用同时返回概要信息与完整条目表**：避免"先 open 再 snapshot"造成二次全量扫描
/// （1 万笔记下这是 800ms 级别的浪费，见 architecture.md §3.2）。
#[tauri::command]
pub async fn vault_open(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    path: String,
) -> Result<VaultSnapshot, IpcError> {
    let (root, options, report) = run_blocking(move || {
        let root = VaultRoot::open(&path)?;
        let options = ScanOptions::default();
        let report = scan(root.path(), &options)?;
        Ok((root, options, report))
    })
    .await?;

    let snapshot = snapshot_from(&root, &report);

    log::info!(
        "打开 Vault：{}（{} 条目 / {} 笔记 / {} 目录，扫描 {}ms，跳过 {}）",
        snapshot.root_path,
        snapshot.entries.len(),
        snapshot.note_count,
        snapshot.folder_count,
        snapshot.scan_ms,
        snapshot.skipped
    );

    // 索引是缓存：先清空，再在后台线程重建（不阻塞打开 Vault 的返回）
    let entries_for_index = report.entries.clone();
    let root_for_index = root.clone();
    state.set_vault(VaultCtx::new(root, options, report));
    indexer::reset(&state);
    indexer::spawn_build(
        Arc::clone(state.inner()),
        app,
        root_for_index,
        entries_for_index,
    );

    Ok(snapshot)
}

/// 当前会话的 Vault 概要（不重扫；未打开返回 `null`）。
#[tauri::command]
pub fn vault_info(state: State<'_, Arc<AppState>>) -> Result<Option<VaultInfo>, IpcError> {
    if !state.is_open() {
        return Ok(None);
    }
    let info = state.with_vault(|ctx| {
        Ok(VaultInfo {
            root_path: ctx.root.display(),
            name: ctx.root.name(),
            entry_count: ctx.entries.len(),
            note_count: ctx.note_count,
            folder_count: ctx.folder_count,
            truncated: ctx.truncated,
            skipped: ctx.skipped,
            scan_ms: ctx.scan_ms,
        })
    })?;
    Ok(Some(info))
}

/// 重新扫描（用户在外部增删了大量文件时使用）。
#[tauri::command]
pub async fn vault_snapshot(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<VaultSnapshot, IpcError> {
    let root = state.vault_root()?;
    let options = state.with_vault(|ctx| Ok(ctx.options.clone()))?;
    let scan_options = options.clone();
    let scan_root = root.clone();
    let report = run_blocking(move || scan(scan_root.path(), &scan_options)).await?;

    let snapshot = snapshot_from(&root, &report);
    let entries_for_index = report.entries.clone();
    let root_for_index = root.clone();
    state.set_vault(VaultCtx::new(root, options, report));
    // 文件可能在外部被大量改动，索引整轮重建（同样在后台）
    indexer::reset(&state);
    indexer::spawn_build(
        Arc::clone(state.inner()),
        app,
        root_for_index,
        entries_for_index,
    );
    log::info!(
        "重扫完成：{} 条目（{}ms）",
        snapshot.entries.len(),
        snapshot.scan_ms
    );
    Ok(snapshot)
}

/// 关闭 Vault（保留窗口，回到选择界面）。
#[tauri::command]
pub fn vault_close(state: State<'_, Arc<AppState>>) -> Result<(), IpcError> {
    indexer::reset(&state);
    state.clear_vault();
    log::info!("已关闭 Vault");
    Ok(())
}

/// 命令行指定的 Vault 路径（`mimenote.exe <目录>`）。
///
/// 前端在启动时优先打开它；返回 `null` 表示没有（例如双击启动），
/// 此时回退到"上次打开的 Vault"。
#[tauri::command]
pub fn startup_vault(state: State<'_, Arc<AppState>>) -> Option<String> {
    state.startup_vault().map(|path| path.to_string())
}

// ---------------------------------------------------------------------------
// 笔记读写
// ---------------------------------------------------------------------------

/// 读取笔记原文。
#[tauri::command]
pub async fn note_read(
    state: State<'_, Arc<AppState>>,
    rel_path: String,
) -> Result<NoteContent, IpcError> {
    let root = state.vault_root()?;
    let rel = rel_path.clone();
    let (text, size_bytes, mtime_ms) = run_blocking(move || {
        let path = root.resolve_existing(&rel)?;
        let meta = std::fs::metadata(&path).map_err(|e| Error::io(&path, e))?;
        if meta.is_dir() {
            return Err(Error::IsDirectory(rel));
        }
        let text = read_text(&path, MAX_READ_BYTES)?;
        Ok((
            text,
            meta.len(),
            mn_core::atomic::mtime_ms(&meta).unwrap_or(0),
        ))
    })
    .await?;

    Ok(NoteContent {
        rel_path,
        text,
        size_bytes,
        mtime_ms,
    })
}

/// 一次批量读取的结果（契约 `NotesBatch`）。
///
/// 为什么要有"批量"而不是让前端循环调 [`note_read`]：整库导出要把**每一篇笔记**的正文拿到
/// 前端去渲染（几千次 IPC 往返是不可接受的开销，而且每次往返都要重新取一次 Vault 锁）。
/// 出参是 `NoteContent`（与 [`note_read`] 同一个类型），前端不需要第二套正文模型。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesBatch {
    /// 读成功的笔记（按请求顺序）。
    pub items: Vec<NoteContent>,
    /// 读失败的笔记 + 原因（按请求顺序）。**单篇失败不整批失败**：
    /// 导出 4267 篇时不能因为一篇被删/非 UTF-8 就让另外 4266 篇白跑。
    pub skipped: Vec<crate::site_export::SiteSkip>,
}

/// 单批最多读几篇。
///
/// 上限的意义与其它批量命令一致：让**一次 IPC 的报文体积**有硬边界。一篇笔记渲染前是纯文本，
/// 64 篇在正常笔记上不到 1 MB，而 4267 篇一次性发过来是几十 MB —— 那已经是一次内存事故。
/// 超限返回 `PATH_INVALID`（与"路径不合法"同码：请求本身的形状不对，而不是某一篇读不到）。
const MAX_BATCH_NOTES: usize = 64;

/// 批量读取笔记原文（整库导出用；口径与 [`note_read`] 逐字相同）。
///
/// 逐篇独立失败：每篇各自的处境（已被删、非 UTF-8、超过读取上限、权限不足）都不该影响别人。
/// 入参超过 [`MAX_BATCH_NOTES`] 条 → `PATH_INVALID`；空数组返回空结果（**不报错**）。
#[tauri::command]
pub async fn notes_read_batch(
    state: State<'_, Arc<AppState>>,
    rel_paths: Vec<String>,
) -> Result<NotesBatch, IpcError> {
    check_batch_size(rel_paths.len())?;
    if rel_paths.is_empty() {
        return Ok(NotesBatch {
            items: Vec::new(),
            skipped: Vec::new(),
        });
    }

    let root = state.vault_root()?;
    run_blocking(move || Ok(read_notes_batch(&root, &rel_paths))).await
}

/// 批量读取的数量上限校验（与 Tauri 无关，可单测）。
fn check_batch_size(count: usize) -> Result<(), IpcError> {
    if count > MAX_BATCH_NOTES {
        return Err(Error::invalid(
            format!("{count} 篇"),
            format!("一次最多批量读取 {MAX_BATCH_NOTES} 篇笔记"),
        )
        .into());
    }
    Ok(())
}

/// [`notes_read_batch`] 的主体（与 Tauri 无关，可单测）。
fn read_notes_batch(root: &VaultRoot, rel_paths: &[String]) -> NotesBatch {
    let mut items = Vec::with_capacity(rel_paths.len());
    let mut skipped = Vec::new();

    for rel in rel_paths {
        match read_note_for_export(root, rel) {
            Ok(content) => items.push(content),
            Err(error) => skipped.push(crate::site_export::SiteSkip::new(
                rel,
                crate::site_export::SiteSkipReason::from_read_error(&error),
                error.to_string(),
            )),
        }
    }

    NotesBatch { items, skipped }
}

/// 读一篇笔记的原文 + 条目表要的形状。
///
/// 与 [`note_read`] 是**同一套口径**（同一个 `resolve_existing`、同一个 `MAX_READ_BYTES`、
/// 同一个"是目录就拒绝"、同一个 mtime 令牌）。没有把 `note_read` 改造成调用它，是为了
/// 不给那条既有路径引入任何行为变化（`note_read` 是编辑器每次打开笔记都要走的路径）。
fn read_note_for_export(root: &VaultRoot, rel: &str) -> mn_core::Result<NoteContent> {
    let path = root.resolve_existing(rel)?;
    let meta = std::fs::metadata(&path).map_err(|e| Error::io(&path, e))?;
    if meta.is_dir() {
        return Err(Error::IsDirectory(rel.to_string()));
    }
    let text = read_text(&path, MAX_READ_BYTES)?;
    Ok(NoteContent {
        rel_path: rel.to_string(),
        text,
        size_bytes: meta.len(),
        mtime_ms: mn_core::atomic::mtime_ms(&meta).unwrap_or(0),
    })
}

/// 保存笔记：mtime 令牌校验 → 原子写 → 增量更新缓存。
///
/// `force = true` 表示用户在冲突横幅里明确选择了「覆盖保存」。
#[tauri::command]
pub async fn note_write(
    state: State<'_, Arc<AppState>>,
    rel_path: String,
    text: String,
    base_mtime_ms: Option<u64>,
    force: bool,
) -> Result<WriteOutcome, IpcError> {
    let root = state.vault_root()?;
    let app = Arc::clone(state.inner());
    let rel = rel_path.clone();

    let (size_bytes, mtime_ms, written_in_ms) = run_blocking(move || {
        // 写锁：把「读取当前 mtime → 比对 → 原子写」变成临界区，
        // 避免两次并发保存互相覆盖（见 ADR-0004）。
        let _write_guard = app.write_guard();

        let path = root.resolve_for_write(&rel)?;
        if path.is_dir() {
            return Err(Error::IsDirectory(rel));
        }
        if let Some(base) = base_mtime_ms {
            let current = mn_core::atomic::path_mtime_ms(&path)?;
            if !force {
                if let Some(cur) = current {
                    if cur != base {
                        return Err(Error::Conflict {
                            current_mtime_ms: cur,
                        });
                    }
                }
            }
        }

        let started = Instant::now();
        write_atomic(&path, text.as_bytes())?;
        let written = started.elapsed().as_millis() as u64;

        // 链接索引增量更新：与写在同一个后台任务里完成，避免为索引再复制一份正文
        indexer::update_note(&app, &rel, &text);

        let meta = std::fs::metadata(&path).map_err(|e| Error::io(&path, e))?;
        Ok((
            meta.len(),
            mn_core::atomic::mtime_ms(&meta).unwrap_or(0),
            written,
        ))
    })
    .await?;

    state.update_vault(|ctx| {
        ctx.upsert(EntryMeta {
            rel_path: rel_path.clone(),
            name: file_name_of(&rel_path),
            is_dir: false,
            size_bytes,
            mtime_ms: Some(mtime_ms),
            ext: ext_of(&rel_path),
        })
    });
    // 链接索引在写入后台任务里已增量更新（见上面的 indexer::update_note）

    log::debug!("保存 {rel_path}（{size_bytes} 字节，写入 {written_in_ms}ms）");
    Ok(WriteOutcome {
        rel_path,
        mtime_ms,
        size_bytes,
        written_in_ms,
    })
}

/// 在笔记的 frontmatter 上**加/删标签**（标签面板的写入口）。
///
/// ## 为什么是宿主命令，而不是"前端读原文 → 改 → note_write"
///
/// ADR-0006 §3 的原话是"改标签走 `note_read → set_tags → note_write`、不开新写路径"。
/// 这里**没有**开新写路径：本命令内部就是那三步，而且与 `note_write` 共用**同一把写锁、
/// 同一次 mtime 令牌校验、同一个 `write_atomic`、同一处索引增量更新**——ADR-0004 的保护一条不少。
/// 之所以把这三步搬进宿主，是因为"改哪一行、写成什么形态（标量/行内数组/块数组/补区块）"
/// 全在 `mn_core::frontmatter`，让前端用 TypeScript 再实现一遍最小 diff，等于把判同与保真
/// 纪律复制成两份（正是 ADR-0006 第 2 条最反对的事）。
///
/// ## 入参是"增"与"删"，不是"新的完整列表"
///
/// 前端面板上的列表可能比磁盘旧一拍（索引/面板刷新有延迟）。传"想要什么"会在这种情况下
/// **静默丢掉别的标签**；传"加什么、删什么"则由宿主基于**它刚刚读到的文本**算结果，
/// 旧一拍的最坏后果只是"重复加了一个已存在的"（幂等，不写盘）。
///
/// ## 冲突
///
/// `base_mtime_ms` 是**必填**的版本令牌：与 `note_write` 一样在写锁内重新 `stat` 比对，
/// 不一致返回 `CONFLICT` + `currentMtimeMs`，**绝不静默覆盖**外部改动（ADR-0004）。
#[tauri::command]
pub async fn note_set_tags(
    state: State<'_, Arc<AppState>>,
    rel_path: String,
    add: Vec<String>,
    remove: Vec<String>,
    base_mtime_ms: u64,
) -> Result<SetTagsOutcome, IpcError> {
    let app = Arc::clone(state.inner());
    let rel = rel_path.clone();

    let outcome =
        run_blocking(move || note_set_tags_in(&app, &rel, &add, &remove, base_mtime_ms)).await?;

    // 条目缓存跟着走（大小与 mtime 变了）——与 note_write 同一收尾
    if outcome.changed {
        state.update_vault(|ctx| {
            ctx.upsert(EntryMeta {
                rel_path: outcome.rel_path.clone(),
                name: file_name_of(&outcome.rel_path),
                is_dir: false,
                size_bytes: outcome.size_bytes,
                mtime_ms: Some(outcome.mtime_ms),
                ext: ext_of(&outcome.rel_path),
            })
        });
    }

    Ok(outcome)
}

/// 新建笔记：唯一命名，写入初始标题。
#[tauri::command]
pub async fn note_create(
    state: State<'_, Arc<AppState>>,
    parent_rel: String,
    title: String,
) -> Result<NoteContent, IpcError> {
    let root = state.vault_root()?;
    let (entry, note) = run_blocking(move || create_note(&root, &parent_rel, &title)).await?;
    state.update_vault(|ctx| ctx.upsert(entry));
    indexer::update_note(&state, &note.rel_path, &note.text);
    log::info!("新建笔记：{}", note.rel_path);
    Ok(note)
}

/// 重命名笔记：同目录改名 + 全库指向它的链接精确改写。
///
/// `update_links` 缺省 `true`（`false` = 只改名、不碰任何其他文件）。
///
/// 宿主在这里只做三件事：拿状态、把结果搬成 DTO、增量更新条目缓存 ——
/// 改名与改写规则全在 `mn_index::rename`（见 `docs/architecture.md` §2 第 3 条）。
#[tauri::command]
pub async fn note_rename(
    state: State<'_, Arc<AppState>>,
    rel_path: String,
    new_title: String,
    update_links: Option<bool>,
) -> Result<RenameOutcome, IpcError> {
    let started = Instant::now();
    let app = Arc::clone(state.inner());
    let rel = rel_path;
    let update = update_links.unwrap_or(true);

    let report = run_blocking(move || rename_note_in(&app, &rel, &new_title, update)).await?;

    // 条目缓存增量更新：换掉旧路径（笔记数不变），不重扫目录
    apply_renamed_entry(&state, &report);

    let outcome = rename_outcome_from(report, started.elapsed().as_millis() as u64);
    log::info!(
        "重命名：{} → {}（改写 {} 个文件 / {} 条链接，耗时 {}ms）",
        outcome.old_rel_path,
        outcome.new_rel_path,
        outcome.updated_links.len(),
        outcome.updated_link_count,
        outcome.elapsed_ms
    );
    Ok(outcome)
}

/// 跨目录移动笔记（拖拽整理 / 命令面板的「移动到…」）。
///
/// 出参**复用 [`RenameOutcome`]**：宿主不为"换个位置"发明第二套契约形状，前端于是能复用
/// 同一套状态收尾（条目表换路径、正在编辑的文档换路径、标签页对账、链接面板刷新）。
///
/// 入参口径：
///
/// * `rel_path` —— 要移动的笔记（相对 Vault 根的 POSIX 路径）；
/// * `target_parent_rel` —— **目标父目录**（空串 = Vault 根；反斜杠与首尾 `/` 都容忍）。
///   目录还不存在时会创建 —— "移动到新目录"是键盘路径下的正常需求；
/// * `new_title` —— `None` 时沿用原文件名（拖拽就是这种情况：只换目录）；
///   给了就顺带改名（扩展名沿用原文件）；
/// * `update_links` —— 缺省 `true`：改写全库指向它的链接。跨目录时链接一律写成
///   **相对新位置的路径**（见 `mn_index::rename` 的模块文档：裸名链接会被"同目录优先"
///   的消歧规则重新解释，换目录后可能指向另一篇同名笔记）。
///
/// 错误码：
///
/// * 目标目录已有同名文件 → `ALREADY_EXISTS`（**绝不覆盖**，也不改一个字节）；
/// * 移到自己所在目录（新旧路径相同）→ 成功返回、无任何副作用；
/// * 源不存在 → `NOT_FOUND`；源是目录 → `IS_DIRECTORY`（目录移动仍推迟）；
/// * 越界/非法目录名 → `PATH_INVALID` / `PATH_ESCAPE`。
///
/// 与 `note_rename` 共用同一把写锁与同一份索引：移动与链接改写必须在"没有并发写"的
/// 临界区里完成（ADR-0004），否则移动瞬间可能撞上一次自动保存。
#[tauri::command]
pub async fn note_move(
    state: State<'_, Arc<AppState>>,
    rel_path: String,
    target_parent_rel: String,
    new_title: Option<String>,
    update_links: Option<bool>,
) -> Result<RenameOutcome, IpcError> {
    let started = Instant::now();
    let app = Arc::clone(state.inner());
    let rel = rel_path;
    let target = target_parent_rel;
    let update = update_links.unwrap_or(true);

    let report =
        run_blocking(move || move_note_in(&app, &rel, &target, new_title.as_deref(), update))
            .await?;

    // 条目缓存增量更新：换掉旧路径（笔记数不变），并把**这次新建的目录**补进条目表
    apply_renamed_entry(&state, &report);
    register_moved_dirs(&state, &report.new_rel_path);

    let outcome = rename_outcome_from(report, started.elapsed().as_millis() as u64);
    log::info!(
        "移动：{} → {}（改写 {} 个文件 / {} 条链接，耗时 {}ms）",
        outcome.old_rel_path,
        outcome.new_rel_path,
        outcome.updated_links.len(),
        outcome.updated_link_count,
        outcome.elapsed_ms
    );
    Ok(outcome)
}

/// 重命名**目录**（连同整棵子树）：磁盘上换名字 + 全库指向子树里每一篇的链接精确改写。
///
/// 出参**复用 [`RenameOutcome`]**（与 `note_rename` / `note_move` 同一形状）：一次目录搬迁要
/// 交代的仍然是"旧路径 / 新路径 / 被改写的文件与条数"，前端因此能复用同一套状态收尾
/// （条目表换整棵子树、正在编辑的文档换路径、标签页对账、链接面板刷新）。
/// 唯一的字段语义差别是 `newMtimeMs` —— 目录不是版本令牌的载体（ADR-0004 的令牌是**文件**
/// mtime），这里如实返回 `0`，前端对目录作用域的搬迁不会拿它当令牌用。
///
/// 入参口径与 [`note_rename`] 一致（`new_title` 不带扩展名；前端偶尔连路径一起传时取末段）。
///
/// 错误码：
///
/// * 目标位置已有同名目录 → `ALREADY_EXISTS`（**绝不覆盖、也绝不合并**两棵子树）；
/// * 源不存在 → `NOT_FOUND`；源是文件 → `NOT_A_DIRECTORY`；
/// * 越界/非法名字 → `PATH_INVALID` / `PATH_ESCAPE`；`.mimenote` 内部目录一律拒绝。
#[tauri::command]
pub async fn dir_rename(
    state: State<'_, Arc<AppState>>,
    rel_path: String,
    new_title: String,
    update_links: Option<bool>,
) -> Result<RenameOutcome, IpcError> {
    let started = Instant::now();
    let app = Arc::clone(state.inner());
    let rel = rel_path;
    let update = update_links.unwrap_or(true);

    let report = run_blocking(move || rename_dir_in(&app, &rel, &new_title, update)).await?;

    apply_renamed_dir(&state, &report);
    let outcome = rename_outcome_from(report, started.elapsed().as_millis() as u64);
    log::info!(
        "目录改名：{} → {}（改写 {} 个文件 / {} 条链接，耗时 {}ms）",
        outcome.old_rel_path,
        outcome.new_rel_path,
        outcome.updated_links.len(),
        outcome.updated_link_count,
        outcome.elapsed_ms
    );
    Ok(outcome)
}

/// 移动**目录**（连同整棵子树）：整棵子树的路径跟着变 + 全库链接精确改写。
///
/// 入参口径与 [`note_move`] 一致：`target_parent_rel` 是**目标父目录**（空串 = Vault 根；
/// 不存在时创建），`new_title` 为 `None` 时沿用目录名（拖拽就是这种情况）。
///
/// 与拖拽的关系：文件夹拖到文件夹上 = 移进那个文件夹；拖到树的空白区域 = 移到 Vault 根。
/// 前端还会拦"拖进自己的后代"并给出原因，宿主这里同样兜底拒绝（`PATH_INVALID`）——
/// 文件系统层面那种操作只会给一句"系统找不到指定的路径"，用户无法据以行动。
#[tauri::command]
pub async fn dir_move(
    state: State<'_, Arc<AppState>>,
    rel_path: String,
    target_parent_rel: String,
    new_title: Option<String>,
    update_links: Option<bool>,
) -> Result<RenameOutcome, IpcError> {
    let started = Instant::now();
    let app = Arc::clone(state.inner());
    let rel = rel_path;
    let target = target_parent_rel;
    let update = update_links.unwrap_or(true);

    let report =
        run_blocking(move || move_dir_in(&app, &rel, &target, new_title.as_deref(), update))
            .await?;

    apply_renamed_dir(&state, &report);
    register_moved_dirs(&state, &report.new_rel_path);
    let outcome = rename_outcome_from(report, started.elapsed().as_millis() as u64);
    log::info!(
        "目录移动：{} → {}（改写 {} 个文件 / {} 条链接，耗时 {}ms）",
        outcome.old_rel_path,
        outcome.new_rel_path,
        outcome.updated_links.len(),
        outcome.updated_link_count,
        outcome.elapsed_ms
    );
    Ok(outcome)
}

/// 删除笔记/目录（移入回收站）。必须 `confirm = true`。
#[tauri::command]
pub async fn note_delete(
    state: State<'_, Arc<AppState>>,
    rel_path: String,
    confirm: bool,
) -> Result<TrashRecord, IpcError> {
    if !confirm {
        return Err(Error::ConfirmationRequired.into());
    }
    let root = state.vault_root()?;
    let rel = rel_path.clone();
    let record = run_blocking(move || move_to_trash(&root, &rel)).await?;
    state.update_vault(|ctx| ctx.remove(&record.original_rel_path));
    indexer::remove_note(&state, &record.original_rel_path);
    log::info!(
        "删除到回收站：{} -> {}",
        record.original_rel_path,
        record.stored_rel_path
    );
    Ok(record)
}

// ---------------------------------------------------------------------------
// 回收站（删除之后还能拿回来）
// ---------------------------------------------------------------------------

/// 回收站里的一条：台账记录 + **它现在还在不在**。
///
/// 为什么要多一个 `present`：台账是追加写入的，用户在文件管理器里清理过 `.mimenote/trash`
/// （或者同步盘把它搬走了）之后，台账里仍留着指向不存在文件的记录。界面必须能如实区分
/// "可以恢复"与"东西已经没了"，而不是点下去才报 `NOT_FOUND`。
///
/// 扁平结构（`TrashRecord` 的字段 + 一个 `present`）而不是嵌套：出参要在前端手工镜像，
/// 少一层就少一处能写歪的地方。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    pub id: String,
    pub original_rel_path: String,
    pub stored_rel_path: String,
    pub deleted_at_ms: u64,
    pub size_bytes: u64,
    pub is_dir: bool,
    /// 回收站里那个文件还在不在（`false` = 台账里的孤儿记录，只能从列表里去掉）。
    pub present: bool,
}

/// 列出回收站（按删除时间倒序：最近删的最可能要找回来）。
#[tauri::command]
pub async fn trash_list(state: State<'_, Arc<AppState>>) -> Result<Vec<TrashEntry>, IpcError> {
    let app = Arc::clone(state.inner());
    let entries = run_blocking(move || trash_list_in(&app)).await?;
    Ok(entries)
}

/// [`trash_list`] 的主体（可单测）。
fn trash_list_in(state: &AppState) -> Result<Vec<TrashEntry>, Error> {
    let root = state.vault_root()?;
    let mut entries: Vec<TrashEntry> = list_trash(&root)?
        .into_iter()
        .map(|record| {
            // 台账里有、回收站里没有 = 孤儿记录（用户手工清理过，或同步盘搬走了）
            let present = root
                .resolve_existing(&record.stored_rel_path)
                .map(|path| path.exists())
                .unwrap_or(false);
            TrashEntry {
                id: record.id,
                original_rel_path: record.original_rel_path,
                stored_rel_path: record.stored_rel_path,
                deleted_at_ms: record.deleted_at_ms,
                size_bytes: record.size_bytes,
                is_dir: record.is_dir,
                present,
            }
        })
        .collect();
    // 最近删的排最前（`Reverse` 让"降序"写成一次 key 提取，而不是比较器里手工调换两侧）
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.deleted_at_ms));
    Ok(entries)
}

/// 把回收站里的一条恢复回来。
///
/// 不传 `target_rel_path` 时恢复到**当初的位置**（[`restore_from_trash`]）；传了就恢复到那个位置
/// （[`restore_as`]，也就是界面上的「恢复为…」—— 原位置已经被别的笔记占用时的出路）。
///
/// **绝不覆盖**：目标位置已经有东西就返回 `ALREADY_EXISTS`，记录与文件都原样留在回收站里
/// （理由见 `mn_core::trash` 的文档：用户可能已经把一篇新笔记写到了那个名字上）。
///
/// 恢复之后的索引与条目表：
///
/// * **单篇**：就地补条目 + `indexer::update_note`，与 `note_create` 是同一条收尾 ——
///   文件树、标签、搜索、图谱立刻一致，不需要重扫；
/// * **整目录**：**不做**逐条猜。一个目录可能带几百个文件，逐个构造 `EntryMeta` 就等于把
///   扫描器的口径抄第二遍（扩展名、忽略规则、大小统计任何一处漂移都是"恢复之后树里少几篇"）。
///   出参里带 `needs_rescan = true`，由前端调既有的静默重扫（`vault_snapshot`）——
///   与外部改动走同一条链路（ADR-0016），代价是一次复用缓存的增量构建。
#[tauri::command]
pub async fn note_restore(
    state: State<'_, Arc<AppState>>,
    id: String,
    target_rel_path: Option<String>,
) -> Result<RestoreSummary, IpcError> {
    let app = Arc::clone(state.inner());
    let summary =
        run_blocking(move || note_restore_in(&app, &id, target_rel_path.as_deref())).await?;
    Ok(summary)
}

/// [`note_restore`] 的主体（可单测）。
fn note_restore_in(
    state: &AppState,
    id: &str,
    target_rel_path: Option<&str>,
) -> Result<RestoreSummary, Error> {
    let root = state.vault_root()?;
    let outcome = match target_rel_path {
        Some(target_rel) => restore_as(&root, id, target_rel)?,
        None => restore_from_trash(&root, id)?,
    };

    let mut needs_rescan = false;
    if outcome.record.is_dir {
        // 目录：让扫描器说话（见上面的文档）
        needs_rescan = true;
    } else if let Some((entry, text)) = read_restored_entry(state, &outcome.restored_rel_path) {
        state.update_vault(|ctx| ctx.upsert(entry));
        indexer::update_note(state, &outcome.restored_rel_path, &text);
    } else {
        // 读回来失败（刚好被别的程序删掉/锁住）：文件确实已经搬回来了，索引下一轮会补
        needs_rescan = true;
    }

    log::info!(
        "从回收站恢复：{} → {}（{}）",
        outcome.record.stored_rel_path,
        outcome.restored_rel_path,
        if outcome.is_original_place() {
            "原位置"
        } else {
            "指定位置"
        }
    );

    Ok(RestoreSummary {
        id: outcome.record.id.clone(),
        original_rel_path: outcome.record.original_rel_path.clone(),
        restored_rel_path: outcome.restored_rel_path.clone(),
        is_dir: outcome.record.is_dir,
        created_dirs: outcome.created_dirs.clone(),
        restored_to_original_place: outcome.is_original_place(),
        needs_rescan,
    })
}

/// 读取刚恢复回来的那一篇，给出条目表要的形状。
///
/// 与扫描器同一份口径的字段（`name`/`ext`/`size`/`mtime`）直接取自文件系统；
/// 读不到（被删、不可读、太大）时返回 `None` —— 调用方据此退回重扫。
fn read_restored_entry(state: &AppState, rel_path: &str) -> Option<(EntryMeta, String)> {
    let root = state.with_vault(|ctx| Ok(ctx.root.clone())).ok()?;
    let path = root.resolve_existing(rel_path).ok()?;
    let meta = std::fs::symlink_metadata(&path).ok()?;
    if meta.is_dir() {
        return None;
    }
    let text = read_text(&path, MAX_READ_BYTES).ok()?;
    let entry = EntryMeta {
        rel_path: rel_path.replace('\\', "/"),
        name: file_name_of(rel_path),
        is_dir: false,
        size_bytes: meta.len(),
        mtime_ms: mn_core::atomic::mtime_ms(&meta),
        ext: ext_of(rel_path),
    };
    Some((entry, text))
}

/// [`note_restore`] 的出参（`RestoreOutcome` 里那部分台账细节不必给前端看）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSummary {
    pub id: String,
    pub original_rel_path: String,
    pub restored_rel_path: String,
    pub is_dir: bool,
    /// 为了放回它新建了哪些目录（自浅到深）—— 界面要能说清"顺手建了 2 个目录"。
    pub created_dirs: Vec<String>,
    pub restored_to_original_place: bool,
    /// 前端收到 `true` 时要调一次静默重扫（目录恢复，或读回单篇失败时的兜底）。
    pub needs_rescan: bool,
}

// ---------------------------------------------------------------------------
// 链接索引
// ---------------------------------------------------------------------------

/// 索引进度与概况。
#[tauri::command]
pub fn index_status(state: State<'_, Arc<AppState>>) -> IndexStatus {
    indexer::status(&state)
}

/// 查询某篇笔记的出链与反向链接。
///
/// 反向链接缓存是惰性重建的（可能涉及全库解析），因此放到后台线程执行。
#[tauri::command]
pub async fn note_links(
    state: State<'_, Arc<AppState>>,
    rel_path: String,
) -> Result<NoteLinks, IpcError> {
    let app = Arc::clone(state.inner());
    let rel = rel_path.clone();
    let links: NoteLinks = run_blocking(move || Ok(indexer::note_links(&app, &rel))).await?;
    Ok(links)
}

// ---------------------------------------------------------------------------
// 知识图谱（节点 + 链接边一次下发，供前端画卡片画布）
// ---------------------------------------------------------------------------

/// 图谱节点上限（节点数超过它只返回度数最高的一部分，并置 `truncated = true`）。
///
/// 上限定在宿主/索引层（而不是前端）是为了让一次 IPC 的**报文体积有硬上限**：
/// 1 万笔记全量下发是几百 KB 量级的 JSON，而这是"打开图谱面板就会调一次"的路径。
const MAX_GRAPH_NODES: usize = mn_index::graph::MAX_GRAPH_NODES;

/// 知识图谱数据：**节点 + 链接边一次性交给前端**（前端据此画可平移缩放的卡片画布）。
///
/// 契约与口径（`src/ipc/types.ts` 手工镜像，字段名不可偏离）：
///
/// * 数据**全部来自索引**，本命令零文件 IO；遍历索引、去重、排序、截断走 `spawn_blocking`（ADR-0003）；
/// * 边按 `(from, to)` 去重，`count` 是合并后的链接条数；悬空链接 `toRelPath = null`，
///   此时 `toRawTarget` 是画布上唯一能显示"指向谁"的信息（解析成功时它同样保留用户写法）；
/// * `nodes` 按 `relPath` 字典序，`edges` 按 `fromRelPath → toRelPath（null 排最后）→ kind`，
///   前端**不做二次排序**；
/// * 节点数超过 [`MAX_GRAPH_NODES`] → 只返回度数（in + out）最高的那部分并置 `truncated = true`
///   （此时节点的度数仍是**全图**度数，可能大于它在 `edges` 里能看到的线数，见 `mn_index::graph`）；
/// * 索引未就绪/为空 → 空图谱（**不报错**），前端按 `index_status` 显示"索引构建中"；
/// * Vault 未打开 → `VAULT_NOT_SET`（与其它命令一致）。
#[tauri::command]
pub async fn graph_data(state: State<'_, Arc<AppState>>) -> Result<GraphData, IpcError> {
    let app = Arc::clone(state.inner());
    run_blocking(move || graph_data_in(&app, MAX_GRAPH_NODES)).await
}

/// 以某一篇笔记为中心的**自我中心子图**（ego graph，ADR-0021）。
///
/// 为什么要有它、而不是在前端拿 `graph_data` 的结果自己筛：`graph_data` 会在大 Vault 上按度数
/// **截断**（上限 `MAX_GRAPH_NODES`），从那批数据里做 BFS 拿到的"邻居"可能根本不完整 ——
/// 用户看到的是"这篇笔记只连着 3 篇"，而真相是"另外 7 篇被截断掉了"。邻接只有索引知道，
/// 所以 BFS 在宿主里做（纯内存索引，仍然零文件 IO）。
///
/// 契约（`src/ipc/types.ts` 手工镜像同一份 `GraphData`，字段名不可偏离）：
///
/// * 形状与 `graph_data` **完全一样**：`{ nodes, edges, truncated, elapsedMs }`，
///   两级视图共用同一个 DTO，因此卡片绘制/手工位置/命中测试都不用分支；
/// * 节点/边的口径（`(from, to)` 去重并累加 `count`、度数、`title`/`tags`/`folder`、排序）
///   与 `graph_data` **逐条相同** —— 用的是 `mn_index::graph` 里同一段组装代码；
/// * `depth` 是**双向**跳数（出链与反链都算一跳），归一化到 1..=5，缺省 1；
/// * `maxNodes` 缺省 80、上限 300；超出时按"离起点近优先 → 同层度数降序 → 路径字典序"取，
///   并置 `truncated = true`（**不静默截断**：界面要能如实说出"只显示了最近的一部分"）；
/// * 起点**永远**在结果里（哪怕它一条链接都没有）；
/// * 起点不在索引里（含索引还在构建）→ 空结果 + `truncated = false`，**不报错**：
///   前端据此显示"这篇笔记还没有进入索引"，而不是弹一条红色错误；
/// * Vault 未打开 → `VAULT_NOT_SET`（与其它命令一致）。
#[tauri::command]
pub async fn graph_ego(
    state: State<'_, Arc<AppState>>,
    rel_path: String,
    depth: Option<u32>,
    max_nodes: Option<usize>,
) -> Result<GraphData, IpcError> {
    let app = Arc::clone(state.inner());
    // 缺省值取自 `mn_index::graph`（与归一化范围同一处定义）：宿主不另写一份 1 / 80 ——
    // 否则"前端不传 depth 时走几跳"这个问题会有两个答案，取决于读的是哪份代码。
    // 越界的值不在这里夹：归一化只有一处（`ego_graph`），免得两层各夹一个不同的范围。
    let depth = depth.unwrap_or(mn_index::graph::DEFAULT_EGO_DEPTH);
    let max_nodes = max_nodes.unwrap_or(mn_index::graph::DEFAULT_EGO_MAX_NODES);
    run_blocking(move || graph_ego_in(&app, &rel_path, depth, max_nodes)).await
}

// ---------------------------------------------------------------------------
// 标签与 frontmatter 属性
// ---------------------------------------------------------------------------

/// 某篇笔记的标签与 frontmatter 属性。
///
/// 标签走**索引**（与全库概览同一份数据，编辑保存后由 `note_write` 顺带更新）；
/// frontmatter 字段**现读现解析** —— 索引只保存标签，不保存所有属性，而属性面板要的是
/// 这篇文件的完整字段（所以这里仍要读一次文件，顺便也把 `NOT_FOUND` 语义定死）。
#[tauri::command]
pub async fn note_tags(
    state: State<'_, Arc<AppState>>,
    rel_path: String,
) -> Result<NoteTags, IpcError> {
    let root = state.vault_root()?;
    let app = Arc::clone(state.inner());
    let rel = rel_path.clone();
    run_blocking(move || note_tags_in(&root, &app, &rel)).await
}

/// 全库标签概览（笔记数降序 → 键字典序）。
#[tauri::command]
pub async fn tags_list(state: State<'_, Arc<AppState>>) -> Result<Vec<TagSummaryDto>, IpcError> {
    let app = Arc::clone(state.inner());
    run_blocking(move || Ok(tags_list_in(&app))).await
}

/// 某个标签下的笔记（`key` 传原始写法或归一化键都行）。
#[tauri::command]
pub async fn tag_notes(state: State<'_, Arc<AppState>>, key: String) -> Result<TagNotes, IpcError> {
    let app = Arc::clone(state.inner());
    let query = key.clone();
    run_blocking(move || tag_notes_in(&app, &query)).await
}

/// 组合过滤的结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagFilterResult {
    /// 命中的笔记（Vault 相对路径，**字典序**）。
    pub paths: Vec<String>,
    /// 命中数（= `paths.len()`，单独给出来是因为前端要显示"M / 共 N 篇"里的 M）。
    pub matched: usize,
    /// 这一轮索引里"有标签的笔记"总数（显示 N 用）。
    pub tagged: usize,
}

/// 组合过滤：**含 `any` 里任意一个**（`any` 为空 = 全部有标签的笔记）**且不含 `none` 里任何一个**。
///
/// ## 为什么放到宿主一次算，而不是让前端一个个标签问
///
/// "有 A 且没有 B"在前端只能拆成两次查询再相减；而**层级标签**还要把 `父` 展开成
/// "父 + 每个后代各一次查询" —— 真实 Vault 里一个父标签挂 200 个子标签就是 201 次 IPC
/// （自己的实现里踩到过：`tag_notes` 不支持层级参数）。这里一次遍历索引就出结果，
/// 前端只需要一次往返。
///
/// `include_children` 打开时 `父` 也匹配 `父/子`、`父/子/孙`（按 `/` 切段比较，
/// 所以 `父老`、`父辈` **不**算后代 —— 与 `tag_rename` 的层级口径一致）。
///
/// 空串与纯 `#` 一律忽略（不是"匹配所有"，也不是报错）：它们没有匹配意义，
/// 只会在界面上留一个点了没反应的胶囊。
#[tauri::command]
pub fn tag_filter(
    state: State<'_, Arc<AppState>>,
    any: Vec<String>,
    none: Vec<String>,
    include_children: bool,
) -> TagFilterResult {
    tag_filter_in(&state, &any, &none, include_children)
}

/// [`tag_filter`] 的主体（可单测；纯内存索引，不碰文件）。
fn tag_filter_in(
    state: &AppState,
    any: &[String],
    none: &[String],
    include_children: bool,
) -> TagFilterResult {
    let index = state.index_write();
    let paths = index.filter_tags(any, none, include_children);
    let tagged = index.tagged_note_count();
    TagFilterResult {
        matched: paths.len(),
        paths,
        tagged,
    }
}

/// **标签重命名 / 合并**：把全库所有笔记里的 `甲` 换成 `乙`。
///
/// ## 为什么不复用 `note_set_tags` 逐篇调用
///
/// 重命名要改的是**正文行内标签**（`note_set_tags` 刻意只改 frontmatter，见 ADR-0006），
/// 而且必须"要么全改、要么说清楚哪几篇没改"——逐篇调用会让"改了 30 篇之后第 31 篇失败"
/// 变成一个没有出处的中断。因此这里由宿主一次做完：
///
/// ```text
/// 候选集（标签索引里所有命中的笔记，复用既有索引，不重新扫全库）
///   逐篇：写锁 → 对照条目表检查磁盘有没有被外部改过 → 读盘 → mn_core::tags::rename_tags
///         → 没变就跳过（幂等）→ atomic 写 → indexer::update_note（标签/搜索/图谱同一处增量同步）
/// ```
///
/// ## 为什么先查询再确认（`dry_run`）
///
/// 这个动作的代价与影响面都写在用户看不到的地方（"改 N 篇笔记"），`dry_run = true` 走**完全
/// 一样的候选集与判定**，只是不落盘 —— 于是对话框能先说出"这会改 12 篇笔记"，
/// 而且那句话与真正执行时改的篇数**同源**（不是估的）。
///
/// ## 如实汇报，绝不"部分成功却报告成功"
///
/// 结果里 `edited` / `skipped` 分开列，跳过原因分三类（[`TagSkipReason`]）。
/// 单篇写失败不会中断整批（用户重试即可），重试是幂等的：已经改过的文件在新一轮里
/// 读盘后"旧写法已经不在"，于是既不改也不报错（计入 `unchanged`）。
///
/// ## 冲突语义
///
/// 这一条**没有** `baseMtimeMs` 入参：它动的不是"用户正在编辑的这一篇"，而是全库。
/// 逐篇的版本令牌来自**条目表里的 `(mtime,size)`**（ADR-0016 判定"磁盘上有没有新闻"用的
/// 就是这份对账口径）—— 与磁盘对不上就跳过该篇并如实报告"磁盘被外部改动"，
/// 而不是拿一份可能已经过时的正文去覆盖。前端在调用前仍会先 `saveNow`（把当前笔记落盘），
/// 否则当前这篇会被自己的未保存内容挡住。
#[tauri::command]
pub async fn tag_rename(
    state: State<'_, Arc<AppState>>,
    from: String,
    to: String,
    include_children: Option<bool>,
    dry_run: Option<bool>,
) -> Result<TagRenameOutcome, IpcError> {
    let app = Arc::clone(state.inner());
    // 这里不能再用 `run_blocking`（它要求主体返回 `mn_core::Result`）：主体要回报
    // `INDEX_NOT_READY`（宿主侧才有的码），因此直接走 `spawn_blocking`（ADR-0003 的口径不变）
    tauri::async_runtime::spawn_blocking(move || {
        tag_rename_in(
            &app,
            &from,
            &to,
            include_children.unwrap_or(true),
            dry_run.unwrap_or(false),
        )
    })
    .await
    .map_err(|error| IpcError::internal(format!("标签改名任务失败：{error}")))?
}

/// **标签的层级编辑**：把 `甲` 挂到某个父标签下（`父/甲`），或提回顶层（`甲`）。
///
/// ## 为什么是一个独立命令，而不是让前端拼好新名字去调 `tag_rename`
///
/// 层级编辑只有两种形态，但**非法组合比合法组合多**：挂到自己下面、挂到自己的后代下面
/// （会造出 `甲/…/甲` 这种改不完的层级）、父标签里写了空段、以及"已经在那里了"。
/// 这些判定必须在写盘之前就拦住，而且要与写盘无关地单测 —— 所以规则在
/// [`mn_core::tag_move_target`]（纯函数，3 条测试），这里只做三件事：
///
/// 1. 算出目标键，把非法移动翻成 [`Error::invalid`]（稳定错误码 `PATH_INVALID`，
///    与重命名里"新名字为空"同一档）；
/// 2. **目标键已被别的标签占用时拒绝**：那是"合并"，不是"移动"。用户点的是"移到…"，
///    静默把它并掉会让人以为只是换了个位置，而实际丢了一个标签的独立性 ——
///    错误信息直接把他引到「重命名」那条路上去；
/// 3. 委托给 [`tag_rename_in`] —— **不新增第二套写路径**：同一把写锁、同一份
///    `(mtime,size)` 对账、同一个 `write_atomic`、同一处索引增量同步、同一份跳过清单口径。
///    出参因此就是 [`TagRenameOutcome`]：前端连"这会改 N 篇 / 哪几篇没改"的结果界面都能复用。
///
/// `include_children` 缺省 `true`：移动一个父标签时，它下面的子标签跟着走
/// （`甲` → `母/甲` 时 `甲/子` → `母/甲/子`），与重命名的口径一致。
#[tauri::command]
pub async fn tag_move(
    state: State<'_, Arc<AppState>>,
    key: String,
    parent: String,
    include_children: Option<bool>,
    dry_run: Option<bool>,
) -> Result<TagRenameOutcome, IpcError> {
    let app = Arc::clone(state.inner());
    // 与 `tag_rename` 同因：主体会回报 `INDEX_NOT_READY`，所以直接走 `spawn_blocking`
    tauri::async_runtime::spawn_blocking(move || {
        tag_move_in(
            &app,
            &key,
            &parent,
            include_children.unwrap_or(true),
            dry_run.unwrap_or(false),
        )
    })
    .await
    .map_err(|error| IpcError::internal(format!("标签移动任务失败：{error}")))?
}

/// [`tag_move`] 的主体（可单测）。
fn tag_move_in(
    state: &AppState,
    key: &str,
    parent: &str,
    include_children: bool,
    dry_run: bool,
) -> Result<TagRenameOutcome, IpcError> {
    if !state.is_open() {
        return Err(Error::VaultNotSet.into());
    }
    let target =
        mn_core::tag_move_target(key, parent).map_err(|reason| Error::invalid(key, reason))?;

    // 目标键已经被别的标签占用 → 那是"合并"。只有拿着全库概览的这里判得了
    // （纯函数刻意不管这件事，见 `tag_move_target` 的文档）。
    let from_key = mn_core::normalize_tag(key);
    if indexer::status(state).phase == indexer::IndexPhase::Ready {
        let taken = indexer::tag_summary(state)
            .into_iter()
            .any(|summary| summary.key == target && summary.key != from_key);
        if taken {
            return Err(Error::invalid(
                key,
                format!("「{target}」已经是一个标签了；要合并请用「重命名」"),
            )
            .into());
        }
    }

    tag_rename_in(state, key, &target, include_children, dry_run)
}

// ---------------------------------------------------------------------------
// 全文搜索
// ---------------------------------------------------------------------------

/// 默认返回条数。
const DEFAULT_SEARCH_LIMIT: u32 = 50;
/// 单次返回条数上限（再多也没有意义：前端是列表，不是导出）。
const MAX_SEARCH_LIMIT: u32 = 200;

/// 把入参的 `limit` 归一化到 [1, 200]（缺省 50）。
fn search_limit(limit: Option<u32>) -> u32 {
    limit
        .unwrap_or(DEFAULT_SEARCH_LIMIT)
        .clamp(1, MAX_SEARCH_LIMIT)
}

/// 全文搜索（SQLite FTS5）。
///
/// 参数与结果形状是不可偏离的 IPC 契约（`src/ipc/types.ts` 手工镜像）。
#[tauri::command]
pub async fn search_query(
    state: State<'_, Arc<AppState>>,
    query: String,
    limit: Option<u32>,
) -> Result<SearchResult, IpcError> {
    let app = Arc::clone(state.inner());
    // 主体在 `search_query_in`（与 Tauri 无关，可单测）；查询不走主线程（ADR-0003）
    run_blocking(move || search_query_in(&app, &query, limit)).await
}

// ---------------------------------------------------------------------------
// 定制化：Vault CSS 片段
// ---------------------------------------------------------------------------

/// 列出 Vault 内 `.mimenote/snippets/*.css`。
#[tauri::command]
pub async fn snippets_list(state: State<'_, Arc<AppState>>) -> Result<Vec<SnippetFile>, IpcError> {
    let root = state.vault_root()?;
    run_blocking(move || list_snippets(&root)).await
}

/// 关于面板信息。
///
/// 前端在 bootstrap 阶段会调用一次作为**启动握手**：宿主日志里出现本行，
/// 说明 WebView 已渲染、JS 已执行、IPC 通道可用（CSP 与能力声明都没问题）。
#[tauri::command]
pub fn version_info() -> VersionInfo {
    let info = VersionInfo {
        app: env!("CARGO_PKG_VERSION"),
        core: mn_core::VERSION,
        tauri: tauri::VERSION,
    };
    log::info!(
        "IPC 握手成功：app {} / mn-core {} / tauri {}",
        info.app,
        info.core,
        info.tauri
    );
    info
}

/// 读取磁盘上某个文档的真实统计（字数/行数/阅读时长）。
///
/// 编辑器内的即时统计走前端本地计算（每次按键都要刷新，不能付 IPC 往返成本）；
/// 本命令提供**磁盘真实值**，两者互为校验，也让 `mn-core::text_stats`
/// 成为后续索引层的唯一权威实现。
#[tauri::command]
pub async fn note_stats(
    state: State<'_, Arc<AppState>>,
    rel_path: String,
) -> Result<DocumentStats, IpcError> {
    let root = state.vault_root()?;
    let rel = rel_path.clone();
    run_blocking(move || {
        let path = root.resolve_existing(&rel)?;
        let meta = std::fs::metadata(&path).map_err(|e| Error::io(&path, e))?;
        if meta.is_dir() {
            return Err(Error::IsDirectory(rel));
        }
        let text = read_text(&path, MAX_READ_BYTES)?;
        Ok(DocumentStats {
            rel_path: rel,
            size_bytes: meta.len(),
            mtime_ms: mn_core::atomic::mtime_ms(&meta).unwrap_or(0),
            stats: mn_core::text_stats::stats(&text),
        })
    })
    .await
}

fn snapshot_from(root: &VaultRoot, report: &mn_core::scanner::ScanReport) -> VaultSnapshot {
    VaultSnapshot {
        root_path: root.display(),
        name: root.name(),
        entries: report.entries.clone(),
        note_count: report.note_count,
        folder_count: report.folder_count,
        truncated: report.truncated,
        skipped: report.skipped,
        scan_ms: report.scan_ms,
        generated_at_ms: mn_core::atomic::now_ms(),
    }
}

// ---------------------------------------------------------------------------
// 内部实现（与 Tauri 无关，可单测）
// ---------------------------------------------------------------------------

fn create_note(
    root: &VaultRoot,
    parent_rel: &str,
    title: &str,
) -> mn_core::Result<(EntryMeta, NoteContent)> {
    let parent = parent_rel.trim().replace('\\', "/");
    let parent = parent.trim_matches('/').to_string();

    if !parent.is_empty() {
        let dir = root.resolve_existing(&parent)?;
        if !dir.is_dir() {
            return Err(Error::NotADirectory(parent));
        }
    }

    let stem = sanitize_file_stem(title);
    let (rel, path) = unique_note_path(root, &parent, &stem)?;

    // 有标题就写入一行 H1 作为初始内容；标题为空（或全是空白）时留空文件
    let trimmed = title.trim();
    let body = if trimmed.is_empty() {
        String::new()
    } else {
        format!("# {trimmed}\n")
    };

    write_atomic(&path, body.as_bytes())?;
    let meta = std::fs::metadata(&path).map_err(|e| Error::io(&path, e))?;
    let mtime_ms = mn_core::atomic::mtime_ms(&meta).unwrap_or(0);

    let entry = EntryMeta {
        rel_path: rel.clone(),
        name: file_name_of(&rel),
        is_dir: false,
        size_bytes: meta.len(),
        mtime_ms: Some(mtime_ms),
        ext: Some("md".to_string()),
    };
    let note = NoteContent {
        rel_path: rel,
        text: body.clone(),
        size_bytes: meta.len(),
        mtime_ms,
    };
    Ok((entry, note))
}

/// 在 `parent` 下为 `stem` 找一个不冲突的 `.md` 路径。
fn unique_note_path(
    root: &VaultRoot,
    parent: &str,
    stem: &str,
) -> mn_core::Result<(String, PathBuf)> {
    for attempt in 0..1000usize {
        let file_name = if attempt == 0 {
            format!("{stem}.md")
        } else {
            format!("{stem} {attempt}.md")
        };
        let rel = if parent.is_empty() {
            file_name.clone()
        } else {
            format!("{parent}/{file_name}")
        };
        let path = root.resolve_for_write(&rel)?;
        if !path.exists() {
            return Ok((rel, path));
        }
    }
    Err(Error::AlreadyExists(format!(
        "{stem}.md 的重名尝试超过 1000 次"
    )))
}

/// 重命名命令的主体（与 Tauri 无关，可单测）。
///
/// 与保存共用同一把写锁：改名与链接改写必须在"没有并发写"的临界区里完成（ADR-0004），
/// 否则改名瞬间可能撞上一次自动保存，把刚改好的链接又写回旧名字。
fn rename_note_in(
    state: &AppState,
    rel_path: &str,
    new_title: &str,
    update_links: bool,
) -> mn_core::Result<RenameReport> {
    let root = state.vault_root()?;
    let _write_guard = state.write_guard();
    let mut index = state.index_write();
    // 链接索引由 mn-index 在同一临界区里增量同步（旧路径移除、新路径 upsert）
    // 全文搜索索引同理：路径搬过去、被改写文件的新文本重新入库；未就绪时只走链接索引
    match state.try_search(|search| {
        mn_index::rename::rename_note(
            &root,
            &mut index,
            rel_path,
            new_title,
            update_links,
            Some(search),
        )
    }) {
        Some(result) => result,
        None => mn_index::rename::rename_note(
            &root,
            &mut index,
            rel_path,
            new_title,
            update_links,
            None,
        ),
    }
}

/// 目录改名命令的主体（与 Tauri 无关，可单测）。
///
/// 与 `rename_note_in` 共用同一把写锁、同一份索引、同一套全文搜索降级：目录搬迁在这三层上
/// 与单篇搬迁没有任何区别，只是候选集从"一篇"变成"整棵子树"。
fn rename_dir_in(
    state: &AppState,
    rel_path: &str,
    new_title: &str,
    update_links: bool,
) -> mn_core::Result<RenameReport> {
    let root = state.vault_root()?;
    let _write_guard = state.write_guard();
    let mut index = state.index_write();
    match state.try_search(|search| {
        mn_index::dir_move::rename_dir(
            &root,
            &mut index,
            rel_path,
            new_title,
            update_links,
            Some(search),
        )
    }) {
        Some(result) => result,
        None => mn_index::dir_move::rename_dir(
            &root,
            &mut index,
            rel_path,
            new_title,
            update_links,
            None,
        ),
    }
}

/// 目录移动命令的主体（与 Tauri 无关，可单测）。
fn move_dir_in(
    state: &AppState,
    rel_path: &str,
    target_parent_rel: &str,
    new_title: Option<&str>,
    update_links: bool,
) -> mn_core::Result<RenameReport> {
    let root = state.vault_root()?;
    let _write_guard = state.write_guard();
    let mut index = state.index_write();
    match state.try_search(|search| {
        mn_index::dir_move::move_dir_tree(
            &root,
            &mut index,
            rel_path,
            target_parent_rel,
            new_title,
            update_links,
            Some(search),
        )
    }) {
        Some(result) => result,
        None => mn_index::dir_move::move_dir_tree(
            &root,
            &mut index,
            rel_path,
            target_parent_rel,
            new_title,
            update_links,
            None,
        ),
    }
}

/// 移动命令的主体（与 Tauri 无关，可单测）。
///
/// 与 `rename_note_in` 是同一条链路的两个入口：写锁、索引同步、全文搜索降级都一致 ——
/// "换个位置"和"换个名字"在这三层上没有任何区别（见 `mn_index::rename` 的模块文档）。
fn move_note_in(
    state: &AppState,
    rel_path: &str,
    target_parent_rel: &str,
    new_title: Option<&str>,
    update_links: bool,
) -> mn_core::Result<RenameReport> {
    let root = state.vault_root()?;
    let _write_guard = state.write_guard();
    let mut index = state.index_write();
    match state.try_search(|search| {
        mn_index::rename::move_note(
            &root,
            &mut index,
            rel_path,
            target_parent_rel,
            new_title,
            update_links,
            Some(search),
        )
    }) {
        Some(result) => result,
        None => mn_index::rename::move_note(
            &root,
            &mut index,
            rel_path,
            target_parent_rel,
            new_title,
            update_links,
            None,
        ),
    }
}

/// 改名成功后增量更新条目缓存（纯内存，不重扫目录）。
fn apply_renamed_entry(state: &AppState, report: &RenameReport) {
    let old_rel = report.old_rel_path.clone();
    let new_rel = report.new_rel_path.clone();
    let mtime_ms = report.mtime_ms;
    let size_bytes = report.size_bytes;
    state.update_vault(|ctx| {
        // 先删后加：笔记数净变化为 0，目录计数不受影响
        ctx.remove(&old_rel);
        ctx.upsert(EntryMeta {
            rel_path: new_rel.clone(),
            name: file_name_of(&new_rel),
            is_dir: false,
            size_bytes,
            mtime_ms: Some(mtime_ms),
            ext: ext_of(&new_rel),
        });
    });
}

/// 目录搬迁成功后就地替换**整棵子树**的条目（纯内存，不重扫目录）。
///
/// 为什么必须整棵子树一起换：`VaultCtx::remove` 会连同后代一起摘掉，只补回目录本身会让
/// 子树里每一篇笔记都从条目表里消失 —— 前端文件树会空一片（而磁盘上它们好好的）。
/// 逐条按 `新前缀 + 旧路径的后半段` 重写路径（复用 `mn_index::remap_prefix`，与链接改写
/// 同一份前缀映射），其余字段（size/mtime/ext）原样保留，条目形状与扫描口径因此不会漂移。
fn apply_renamed_dir(state: &AppState, report: &RenameReport) {
    let old_rel = report.old_rel_path.clone();
    let new_rel = report.new_rel_path.clone();
    state.update_vault(|ctx| {
        // `remove` 会连后代一起摘掉，所以先把整棵子树的条目**取出来**（含目录自身），再换路径入表
        let doomed: Vec<EntryMeta> = ctx
            .paths_under(&old_rel)
            .into_iter()
            .filter_map(|rel| ctx.entries.get(&rel).cloned())
            .collect();
        ctx.remove(&old_rel);
        for entry in doomed {
            let Some(rel_path) = mn_index::remap_prefix(&entry.rel_path, &old_rel, &new_rel) else {
                continue;
            };
            ctx.upsert(EntryMeta {
                name: file_name_of(&rel_path),
                rel_path,
                ..entry
            });
        }
    });
}

/// 把 `new_rel` 的父目录（含缺失的祖先）补进条目缓存。
///
/// 为什么必须做：移动到**新建目录**时磁盘上多了几层目录，而条目缓存是"打开 Vault 时扫一次"
/// 的快照。缺了父目录条目，前端 `domain/tree` 会把这篇笔记当成"父目录缺失"而**提升成根节点**
/// —— 文件树里的表现是"笔记跑到了最外层，新建的目录看不见"，比报错更难查。
/// 自顶向下入表，父目录一定先于子目录存在（`VaultCtx::upsert` 只加不排序，顺序由前端树重建决定）。
///
/// `pub(crate)`：附件写入（`attachments.rs`）也要把新建的附件目录补进同一条缓存 ——
/// 目录条目的形状只允许有一处定义，不能再写第二遍。
pub(crate) fn register_moved_dirs(state: &AppState, new_rel: &str) {
    let Some(index) = new_rel.rfind('/') else {
        return;
    };
    let dir = &new_rel[..index];
    if dir.is_empty() {
        return;
    }
    state.update_vault(|ctx| {
        let mut accumulated = String::new();
        for segment in dir.split('/') {
            if accumulated.is_empty() {
                accumulated.push_str(segment);
            } else {
                accumulated.push('/');
                accumulated.push_str(segment);
            }
            if ctx.entries.contains_key(&accumulated) {
                continue;
            }
            ctx.upsert(EntryMeta {
                rel_path: accumulated.clone(),
                name: segment.to_string(),
                is_dir: true,
                size_bytes: 0,
                // 目录的 mtime 在扫描口径里本来就是 `None`（见 mn-core::scanner）
                mtime_ms: None,
                ext: None,
            });
        }
    });
}

/// `mn-index` 的结果 → IPC DTO（宿主唯一的"搬运"职责）。
fn rename_outcome_from(report: RenameReport, elapsed_ms: u64) -> RenameOutcome {
    RenameOutcome {
        old_rel_path: report.old_rel_path,
        new_rel_path: report.new_rel_path,
        new_mtime_ms: report.mtime_ms,
        updated_links: report
            .updated_links
            .into_iter()
            .map(RenameLinkUpdate::from)
            .collect(),
        updated_link_count: report.updated_link_count,
        elapsed_ms,
    }
}

/// `search_query` 的主体（与 Tauri 无关，可单测）。
///
/// * `query` trim 后为空 → 直接返回空结果（**不查库**：前端清空输入框时不该打一次 IPC）；
/// * 没打开 Vault → `VAULT_NOT_SET`（明确区分"没库"和"没有结果"）；
/// * 索引未就绪/不可用 → `IO` 错误，message 里带原因（"正在构建" / "Vault 只读"…）。
fn search_query_in(
    state: &AppState,
    query: &str,
    limit: Option<u32>,
) -> mn_core::Result<SearchResult> {
    let started = Instant::now();
    let query = query.to_string();

    if query.trim().is_empty() {
        return Ok(SearchResult {
            query,
            hits: Vec::new(),
            total: 0,
            elapsed_ms: started.elapsed().as_millis() as u64,
        });
    }
    if !state.is_open() {
        return Err(Error::VaultNotSet);
    }

    let outcome = indexer::search(state, &query, search_limit(limit))?;
    Ok(SearchResult {
        query,
        hits: outcome.hits.into_iter().map(SearchHit::from).collect(),
        total: outcome.total,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// `note_tags` 的主体（与 Tauri 无关，可单测）。
fn note_tags_in(root: &VaultRoot, state: &AppState, rel_path: &str) -> mn_core::Result<NoteTags> {
    let path = root.resolve_existing(rel_path)?;
    let meta = std::fs::metadata(&path).map_err(|e| Error::io(&path, e))?;
    if meta.is_dir() {
        return Err(Error::IsDirectory(rel_path.to_string()));
    }
    let text = read_text(&path, MAX_READ_BYTES)?;

    // 索引里有就用索引的（与全库概览严格一致）；索引还没收录（构建中、超大被跳过、
    // 非笔记）才现算 —— 否则面板会显示"这篇没有标签"，那是错的。
    let tags = indexer::tags_of(state, rel_path).unwrap_or_else(|| mn_core::extract_tags(&text));
    let frontmatter = mn_core::parse_frontmatter(&text)
        .map(|frontmatter| frontmatter.fields)
        .unwrap_or_default();

    Ok(NoteTags {
        rel_path: rel_path.to_string(),
        tags,
        frontmatter,
    })
}

/// `note_set_tags` 的主体（与 Tauri 无关，可单测）。
///
/// 一次临界区里做完五件事（顺序不能换）：
///
/// 1. **写锁**：与 `note_write` / `rename_note_in` 同一把 —— "读当前 mtime → 读文本 → 改 → 写"
///    必须在没有并发写的窗口里完成，否则并发的自动保存会以旧文本覆盖掉刚改出来的标签；
/// 2. **令牌比对**：磁盘 mtime 与前端给的 `base_mtime_ms` 不一致 → `CONFLICT`（附当前 mtime），
///    一个字节都不写（ADR-0004：绝不静默覆盖外部改动）；
/// 3. 读**磁盘上的最新文本**（不是前端内存里的那份），既有标签从这里取；
/// 4. 结果列表 = `mn_core::tags::apply_tag_edits(既有, add, remove)`（判同只有 `normalize_tag` 一份）；
/// 5. 新文本与旧文本**逐字节相同就整个跳过**：不写盘、不动 mtime、不重建索引 ——
///    "加一个已经存在的标签"必须是彻底的幂等，而不是制造一次无意义的 diff 与一次索引重建。
///
/// 写入走 `mn_core::atomic::write_atomic`（原子替换），并复用 `indexer::update_note`
/// 让标签/搜索/图谱三份索引在同一处增量同步（ADR-0006 影响一节：文本派生数据只有一个入口）。
fn note_set_tags_in(
    state: &AppState,
    rel_path: &str,
    add: &[String],
    remove: &[String],
    base_mtime_ms: u64,
) -> mn_core::Result<SetTagsOutcome> {
    let root = state.vault_root()?;
    let _write_guard = state.write_guard();

    let path = root.resolve_existing(rel_path)?;
    if path.is_dir() {
        return Err(Error::IsDirectory(rel_path.to_string()));
    }

    let current = mn_core::atomic::path_mtime_ms(&path)?;
    if let Some(cur) = current {
        if cur != base_mtime_ms {
            return Err(Error::Conflict {
                current_mtime_ms: cur,
            });
        }
    }

    let text = read_text(&path, MAX_READ_BYTES)?;
    // **面板显示的**（两个字段合并）与**能改的**（`set_tags` 真正会写的那个字段）是两份列表：
    // 用合并列表去改写会把 `tag:` 字段里的标签复制进 `tags:`，还会让它永远删不掉 ——
    // 详见 `mn_core::frontmatter::editable_tags` 的文档
    let merged = mn_core::parse_frontmatter(&text)
        .map(|frontmatter| frontmatter.tags)
        .unwrap_or_default();
    let size_bytes = text.len() as u64;
    let unchanged = |tags: Vec<String>| SetTagsOutcome {
        rel_path: rel_path.to_string(),
        mtime_ms: base_mtime_ms,
        size_bytes,
        written_in_ms: 0,
        changed: false,
        tags,
        text: text.clone(),
    };

    // 既不增也不删 = 一次纯查询：不写盘、不重建索引（连算一遍新文本都不必）
    if add.is_empty() && remove.is_empty() {
        return Ok(unchanged(merged));
    }

    let editable = mn_core::editable_tags(&text);
    let wanted = mn_core::apply_tag_edits(&editable, add, remove);
    let updated = mn_core::set_tags_or_create(&text, &wanted);

    if updated == text {
        // 幂等：一个字节都不动（含 mtime 与索引）
        return Ok(unchanged(merged));
    }

    let started = Instant::now();
    write_atomic(&path, updated.as_bytes())?;
    let written_in_ms = started.elapsed().as_millis() as u64;

    // 标签/链接/搜索/图谱：与 `note_write` 完全同一处增量更新
    indexer::update_note(state, rel_path, &updated);

    let meta = std::fs::metadata(&path).map_err(|e| Error::io(&path, e))?;
    let tags = mn_core::parse_frontmatter(&updated)
        .map(|frontmatter| frontmatter.tags)
        .unwrap_or_default();

    log::debug!(
        "改写 {rel_path} 的标签（{} 个，{} 字节，写入 {written_in_ms}ms）",
        tags.len(),
        updated.len()
    );

    Ok(SetTagsOutcome {
        rel_path: rel_path.to_string(),
        mtime_ms: mn_core::atomic::mtime_ms(&meta).unwrap_or(base_mtime_ms),
        size_bytes: meta.len(),
        written_in_ms,
        changed: true,
        tags,
        text: updated,
    })
}

/// `tags_list` 的主体（与 Tauri 无关，可单测）。
fn tags_list_in(state: &AppState) -> Vec<TagSummaryDto> {
    indexer::tag_summary(state)
        .into_iter()
        .map(TagSummaryDto::from)
        .collect()
}
/// `tag_notes` 的主体（与 Tauri 无关，可单测）：空键 → `PATH_INVALID`。
fn tag_notes_in(state: &AppState, key: &str) -> mn_core::Result<TagNotes> {
    // 空键（`""`、`"#"`、只有空白）归一化后是空串，等于"查询所有空标签"：明确拒绝，
    // 别让它悄悄返回一个空列表（那会让 UI 以为"这个标签下没有笔记"）
    let normalized = mn_core::normalize_tag(key);
    if normalized.is_empty() {
        return Err(Error::invalid(key, "标签键为空"));
    }

    Ok(TagNotes {
        notes: indexer::notes_with_tag(state, &normalized),
        key: normalized,
    })
}

/// `tag_rename` 的主体（与 Tauri 无关，可单测）。
///
/// 编排纪律（顺序与理由）：
///
/// 1. **映射先归一化**（`TagRename::new`）：空输入 → `PATH_INVALID`（复用既有稳定码，
///    不开新码），不区分"源为空"还是"目标为空" —— 两者都是"这次改名没有意义"；
/// 2. **候选集来自标签索引**，不重新扫全库：索引的倒排表就是"哪些笔记用了这个键"，
///    1 万笔记的 Vault 里改一个标签只读它真正出现的那几十篇（`tag_summary` 筛出范围内的键
///    → `notes_with_tag` 取并集）。索引没就绪时**明确报错**而不是"改了 0 篇"：
///    后者会让用户以为改完了；
/// 3. **逐篇一个短临界区**（不是整批一把锁）：每个文件的"读 → 改写 → 原子写"必须在
///    没有并发写的窗口里完成（ADR-0004），但把几百个文件圈进一把锁会让自动保存停摆数秒。
///    锁外还叠一层"条目表 vs 磁盘"的对账，挡住**外部**改动（见 `plan_mismatch`）；
/// 4. **一篇一汇报**：写失败只记进 `skipped`，继续下一篇（用户重试即可，重试幂等）；
/// 5. **索引与条目表同步**：写入成功的每一篇都走 `indexer::update_note`
///    （标签/搜索/图谱同一处增量更新，ADR-0006 影响一节），条目表在循环之后一次性更新。
///
/// 返回值是 [`IpcError`] 而不是 `mn_core::Error`：这一条路径上有一个错误码只有宿主层才有
/// （`INDEX_NOT_READY`，见 `error.rs`）。索引没就绪时从前借 `IO` 上报，而前端会把 `IO`
/// 翻成"磁盘读写失败：…" —— 用户于是去查磁盘，而正确的动作是"稍后重试"。
/// 错误码是**跨 IPC 的稳定契约**，不该用一个意思相反的词去凑。
fn tag_rename_in(
    state: &AppState,
    from: &str,
    to: &str,
    include_children: bool,
    dry_run: bool,
) -> Result<TagRenameOutcome, IpcError> {
    let started = Instant::now();

    if !state.is_open() {
        return Err(Error::VaultNotSet.into());
    }
    let Some(mapping) = mn_core::TagRename::new(from, to, include_children) else {
        return Err(Error::invalid(from, "标签名称为空，无法改名").into());
    };

    // 候选集依赖索引：索引没建好时返回 0 篇会被理解成"这个标签不存在"，
    // 那是**错的信息**。索引是缓存、随时会就绪，让用户等一下比给他一个假答案好。
    // 错误码用 `INDEX_NOT_READY` 而不是 `IO`：见本函数的文档注释。
    if indexer::status(state).phase != indexer::IndexPhase::Ready {
        return Err(IpcError::index_not_ready("标签索引正在构建，请稍后重试"));
    }

    let root = state.vault_root()?;
    let candidates = tag_rename_candidates(state, &mapping);

    let mut outcome = TagRenameOutcome {
        from: mapping.from_key().to_string(),
        to: mapping.to_key(),
        from_display: from.to_string(),
        to_display: mapping.to_display().to_string(),
        include_children,
        dry_run,
        candidates: candidates.len() as u32,
        edited: Vec::new(),
        skipped: Vec::new(),
        unchanged: 0,
        frontmatter_edits: 0,
        inline_edits: 0,
        inline_removed: 0,
        elapsed_ms: 0,
    };
    // 写入成功之后要回写的条目表条目（循环里只收集，循环后一次性 update_vault）
    let mut touched_entries: Vec<EntryMeta> = Vec::new();

    for rel in candidates {
        let path = match root.resolve_existing(&rel) {
            Ok(path) => path,
            Err(error) => {
                outcome.skipped.push(TagRenameSkip {
                    rel_path: rel.clone(),
                    reason: TagSkipReason::Unreadable,
                    message: format!("无法定位：{error}"),
                });
                continue;
            }
        };

        // 写锁 + 重新 stat：这里做的是"计划时的磁盘状态 vs 现在的磁盘状态"，
        // 与 `note_write` 的令牌校验是同一个思路，只是令牌来自条目表而非编辑器
        let written = {
            let _write_guard = state.write_guard();

            if let Some(message) = plan_mismatch(state, &path, &rel) {
                outcome.skipped.push(TagRenameSkip {
                    rel_path: rel.clone(),
                    reason: TagSkipReason::ExternalChange,
                    message,
                });
                continue;
            }

            let text = match read_text(&path, MAX_READ_BYTES) {
                Ok(text) => text,
                Err(error) => {
                    outcome.skipped.push(TagRenameSkip {
                        rel_path: rel.clone(),
                        reason: TagSkipReason::Unreadable,
                        message: format!("读取失败：{error}"),
                    });
                    continue;
                }
            };

            let Some(rewrite) = mn_core::rename_tags(&text, &mapping) else {
                // 候选来自索引、磁盘却已经没有旧写法：多半是上一轮重试已经改过它。
                // 不改、不报错、也不算"跳过"（没有需要解释的事情）
                outcome.unchanged += 1;
                continue;
            };

            let counts = TagRenameFile {
                rel_path: rel.clone(),
                frontmatter_edits: rewrite.frontmatter_edits,
                inline_edits: rewrite.inline_edits,
                inline_removed: rewrite.inline_removed,
            };

            if dry_run {
                // 预演：只算不写（候选集与判定与真跑完全一致，所以篇数是可信的）
                Some((rewrite, counts, 0u64, 0u64))
            } else {
                match write_atomic(&path, rewrite.text.as_bytes()) {
                    Ok(()) => {
                        indexer::update_note(state, &rel, &rewrite.text);
                        let meta = std::fs::metadata(&path).ok();
                        let size_bytes = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                        let mtime_ms = meta
                            .as_ref()
                            .and_then(mn_core::atomic::mtime_ms)
                            .unwrap_or(0);
                        Some((rewrite, counts, size_bytes, mtime_ms))
                    }
                    Err(error) => {
                        outcome.skipped.push(TagRenameSkip {
                            rel_path: rel.clone(),
                            reason: TagSkipReason::WriteFailed,
                            message: format!("写入失败：{error}"),
                        });
                        None
                    }
                }
            }
        };

        let Some((rewrite, counts, size_bytes, mtime_ms)) = written else {
            continue;
        };

        if !dry_run {
            touched_entries.push(EntryMeta {
                rel_path: rel.clone(),
                name: file_name_of(&rel),
                is_dir: false,
                size_bytes,
                mtime_ms: Some(mtime_ms),
                ext: ext_of(&rel),
            });
        }
        outcome.frontmatter_edits += rewrite.frontmatter_edits;
        outcome.inline_edits += rewrite.inline_edits;
        outcome.inline_removed += rewrite.inline_removed;
        outcome.edited.push(counts);
    }

    if !touched_entries.is_empty() {
        state.update_vault(|ctx| {
            for entry in touched_entries {
                ctx.upsert(entry);
            }
        });
    }

    outcome.elapsed_ms = started.elapsed().as_millis() as u64;
    log::info!(
        "标签{}：{} → {}（候选 {} 篇，改 {} 篇 / 跳过 {} 篇 / 无需改 {} 篇，{} 处 frontmatter + {} 处正文{}，耗时 {}ms）",
        if dry_run { "改名预演" } else { "改名" },
        outcome.from,
        outcome.to,
        outcome.candidates,
        outcome.edited.len(),
        outcome.skipped.len(),
        outcome.unchanged,
        outcome.frontmatter_edits,
        outcome.inline_edits,
        if outcome.inline_removed > 0 {
            format!("，合并去掉 {} 处重复", outcome.inline_removed)
        } else {
            String::new()
        },
        outcome.elapsed_ms
    );

    Ok(outcome)
}

/// 这次改名会碰到的笔记（路径字典序）。
///
/// 从标签索引的概览里取出**落在改名范围内**的键，再把它们的笔记并起来。范围内的键可能很多
/// （改 `父` 时它的每一个子标签都在范围内），但每个键上的笔记集合是现成的
/// （`notes_with_tag`），所以这一步与"有多少篇笔记"无关，只与"有多少个命中的标签"有关。
/// 用 `BTreeSet` 去重并保序，结果可复现（测试与日志都依赖这一点）。
fn tag_rename_candidates(state: &AppState, mapping: &mn_core::TagRename) -> Vec<String> {
    let mut out = std::collections::BTreeSet::new();
    for summary in indexer::tag_summary(state) {
        if !mapping.covers_key(&summary.key) {
            continue;
        }
        for rel in indexer::notes_with_tag(state, &summary.key) {
            out.insert(rel);
        }
    }
    out.into_iter().collect()
}

/// 计划时记下的磁盘状态与**现在**的磁盘状态对不上 → 返回一句面向用户的说明。
///
/// 判据用的是条目表里的 `(mtime,size)`：那是宿主对"磁盘上是什么"的既有认知
/// （打开/重扫/自己写盘/监听发现外部改动时都会更新，见 ADR-0016），也与索引跨会话复用
/// 用的是同一份判定键。对不上意味着"在我们做计划的这段时间里，这篇被应用之外的东西改过"——
/// 此时再拿刚读到的正文去改写，等于把对方的改动当成背景，用户重试一次就好。
///
/// 为什么 `mtime` 之外还要比 `size`：毫秒 mtime 有"同一毫秒内改动漏检"的固有窗口
/// （ADR-0004 的取舍），字节数是几乎免费的第二道判据 —— 两者都对得上才放行。
/// 条目表里没有这一篇、或它连 mtime 都拿不到时**放行**：拿不到证据就不该拦，
/// 拦住一个本来能改的文件比多改一次更难解释。
fn plan_mismatch(state: &AppState, path: &std::path::Path, rel: &str) -> Option<String> {
    let (expected_mtime, expected_size) = state
        .with_vault(|ctx| {
            Ok(ctx
                .entries
                .get(rel)
                .map(|entry| (entry.mtime_ms, entry.size_bytes)))
        })
        .ok()
        .flatten()?;

    // stat 失败（文件被删/权限不足）交给后面的读取去如实报错，这里不抢那份责任
    let meta = std::fs::metadata(path).ok()?;
    let current_mtime = mn_core::atomic::mtime_ms(&meta);

    if let Some(expected) = expected_mtime {
        if current_mtime != Some(expected) {
            return Some(format!(
                "磁盘被外部改动（条目表记为 {expected}ms，磁盘上是 {}ms），请重试",
                current_mtime.unwrap_or(0)
            ));
        }
    }
    if meta.len() != expected_size {
        return Some(format!(
            "磁盘被外部改动（条目表记为 {expected_size} 字节，磁盘上是 {} 字节），请重试",
            meta.len()
        ));
    }
    None
}

/// `graph_data` 的主体（与 Tauri 无关，可单测）。
///
/// 只做三件事：确认 Vault 已打开（否则 `VAULT_NOT_SET`）、取索引、记一条 debug 日志。
///
/// **索引为空不算错误**：那通常意味着后台索引正在构建，前端应当显示"索引构建中"
/// 而不是弹错误 —— 与 `note_tags`/`tags_list` 在索引未就绪时返回空是同一个姿态。
/// 组装规则全在 `mn_index::graph`（宿主不放业务逻辑，见 architecture.md §2 第 3 条）。
fn graph_data_in(state: &AppState, max_nodes: usize) -> mn_core::Result<GraphData> {
    if !state.is_open() {
        return Err(Error::VaultNotSet);
    }
    let data = indexer::graph_data(state, max_nodes);
    log::debug!(
        "图谱数据：{} 节点 / {} 边（截断 {}），组装 {}ms",
        data.nodes.len(),
        data.edges.len(),
        data.truncated,
        data.elapsed_ms
    );
    Ok(data)
}

/// `graph_ego` 的主体（与 Tauri 无关，可单测）。
///
/// 与 [`graph_data_in`] 同一姿态：只确认 Vault 已打开（否则 `VAULT_NOT_SET`）、取索引、
/// 记一条 debug 日志；组装与筛选全在 `mn_index::graph`（宿主不放业务逻辑）。
///
/// **起点不在索引里不算错误**：那通常意味着后台索引还没收录这一篇（刚打开 Vault 就是这种
/// 情形），前端据此显示"这篇笔记还没有进入索引"，比弹一条红色提示有用得多 ——
/// 与"索引为空时 `graph_data` 返回空图谱"是同一个口径。
///
/// 这里直接取索引而不是像全图那样经 `indexer::graph_data` 转发：那一层是给"全图 + 多处复用"
/// 准备的壳，自我中心子图只有这一个调用点，再包一层只会多一个改一处忘一处的地方。
fn graph_ego_in(
    state: &AppState,
    rel_path: &str,
    depth: u32,
    max_nodes: usize,
) -> mn_core::Result<GraphData> {
    if !state.is_open() {
        return Err(Error::VaultNotSet);
    }
    let data = state.index_write().ego_graph(rel_path, depth, max_nodes);
    log::debug!(
        "自我中心图谱：{rel_path} 双向 {depth} 跳 → {} 节点 / {} 边（截断 {}），组装 {}ms",
        data.nodes.len(),
        data.edges.len(),
        data.truncated,
        data.elapsed_ms
    );
    Ok(data)
}

fn list_snippets(root: &VaultRoot) -> mn_core::Result<Vec<SnippetFile>> {
    let dir = root.path().join(".mimenote").join("snippets");
    let mut out = Vec::new();
    if !dir.is_dir() {
        return Ok(out);
    }
    for item in std::fs::read_dir(&dir)
        .map_err(|e| Error::io(&dir, e))?
        .flatten()
    {
        let name = item.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || !name.to_ascii_lowercase().ends_with(".css") {
            continue;
        }
        let path = item.path();
        let meta = std::fs::metadata(&path).map_err(|e| Error::io(&path, e))?;
        if !meta.is_file() {
            continue;
        }
        if meta.len() > MAX_SNIPPET_BYTES {
            log::warn!("跳过过大的 CSS 片段：{name}（{} 字节）", meta.len());
            continue;
        }
        let css = read_text(&path, MAX_SNIPPET_BYTES)?;
        out.push(SnippetFile {
            name,
            css,
            size_bytes: meta.len(),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// 条目缓存里"文件名"的口径（`rel` 的最后一段）。
///
/// `pub(crate)`：附件写入复用同一处实现 —— 增量更新条目时的形状必须与扫描结果一致。
pub(crate) fn file_name_of(rel: &str) -> String {
    rel.rsplit('/').next().unwrap_or(rel).to_string()
}

/// 条目缓存里"小写扩展名"的口径（无扩展名 → `None`；`pub(crate)` 的理由同上）。
pub(crate) fn ext_of(rel: &str) -> Option<String> {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    name.rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .filter(|ext| !ext.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use mn_index::SearchIndex;

    fn setup() -> (tempfile::TempDir, VaultRoot) {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        std::fs::create_dir_all(dir.path().join("notes")).unwrap();
        (dir, root)
    }

    #[test]
    fn creates_note_with_title_and_unique_names() {
        let (_dir, root) = setup();
        let (entry, note) = create_note(&root, "", "我的第一篇").unwrap();
        assert_eq!(entry.rel_path, "我的第一篇.md");
        assert_eq!(note.text, "# 我的第一篇\n");
        assert_eq!(entry.ext.as_deref(), Some("md"));
        assert!(entry.mtime_ms.is_some());

        let (entry2, _) = create_note(&root, "", "我的第一篇").unwrap();
        // 重名从「 1」开始（与 mock 适配器、Obsidian 的习惯一致）
        assert_eq!(entry2.rel_path, "我的第一篇 1.md", "重名必须自动避让");
        let (entry3, _) = create_note(&root, "", "我的第一篇").unwrap();
        assert_eq!(entry3.rel_path, "我的第一篇 2.md");
    }

    #[test]
    fn creates_note_inside_existing_folder_and_sanitizes_title() {
        let (dir, root) = setup();
        let (entry, _) = create_note(&root, "notes", "关于/安全: 测试").unwrap();
        assert!(entry.rel_path.starts_with("notes/"));
        assert!(
            !entry.rel_path.contains(':'),
            "文件名不得含 Windows 禁用字符"
        );
        assert!(dir.path().join("notes").join(entry.name.clone()).exists());
    }

    #[test]
    fn rejects_missing_or_non_directory_parent() {
        let (_dir, root) = setup();
        assert_eq!(
            create_note(&root, "nope", "x").unwrap_err().code(),
            mn_core::ErrorCode::NotFound
        );
        std::fs::write(root.path().join("file.md"), "x").unwrap();
        assert_eq!(
            create_note(&root, "file.md", "x").unwrap_err().code(),
            mn_core::ErrorCode::NotADirectory
        );
    }

    #[test]
    fn empty_title_gets_fallback_name() {
        let (_dir, root) = setup();
        let (entry, note) = create_note(&root, "", "   ").unwrap();
        assert_eq!(entry.rel_path, "未命名.md");
        assert_eq!(note.text, "", "空标题不写占位标题行");
    }

    // -- 重命名（note_rename） ----------------------------------------------

    /// 建一个"已打开 Vault + 已建索引"的应用状态（与 App 启动链路一致）。
    fn state_with(files: &[(&str, &str)]) -> (tempfile::TempDir, AppState) {
        let dir = tempfile::tempdir().unwrap();
        for (rel, text) in files {
            let path = dir
                .path()
                .join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(&path, text).unwrap();
        }
        let root = VaultRoot::open(dir.path()).unwrap();
        let options = ScanOptions::default();
        let report = scan(root.path(), &options).unwrap();
        let entries = report.entries.clone();
        let (index, _) = mn_index::build_index(
            root.path(),
            &entries,
            &mn_index::BuildOptions::default(),
            None,
            |_done, _total| {},
        );

        let state = AppState::default();
        state.set_vault(VaultCtx::new(root, options, report));
        *state.index_write() = index;
        // 索引阶段：真实链路里 `indexer::spawn_build` 建完会置 `Ready`。
        // `tag_rename` 用"索引是否就绪"回答"候选集能不能信"，所以这里必须如实置一次
        state.set_index_status(indexer::IndexStatus {
            phase: indexer::IndexPhase::Ready,
            indexed: files.len(),
            total: files.len(),
            ..Default::default()
        });

        // 全文搜索索引：与构建路径一样，从同一批文本喂进去（测试用内存库，不留文件）
        let search = SearchIndex::open_in_memory().unwrap();
        search.begin_rebuild().unwrap();
        for (rel, text) in files {
            search.add_note(rel, text).unwrap();
        }
        search.finish_rebuild().unwrap();
        state.install_search(search);
        (dir, state)
    }

    fn read_file(dir: &std::path::Path, rel: &str) -> String {
        std::fs::read_to_string(dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR))).unwrap()
    }

    #[test]
    fn rename_rejects_invalid_titles() {
        let (dir, state) = state_with(&[("笔记/甲.md", "[[乙]]\n"), ("笔记/乙.md", "# 乙\n")]);

        for title in [
            "", "   ", " 乙 ", "乙\n", "子/乙", "子\\乙", "..\\乙", "...", "con", "丙:丁",
        ] {
            let error = rename_note_in(&state, "笔记/乙.md", title, true).unwrap_err();
            assert_eq!(
                error.code(),
                mn_core::ErrorCode::PathInvalid,
                "应拒绝标题：{title:?}"
            );
        }

        // 校验失败必须是"什么都没发生"
        assert!(dir.path().join("笔记").join("乙.md").exists());
        assert_eq!(read_file(dir.path(), "笔记/甲.md"), "[[乙]]\n");
    }

    #[test]
    fn rename_reports_missing_directory_and_existing_target() {
        let (dir, state) = state_with(&[("乙.md", "# 乙\n"), ("目标.md", "")]);
        std::fs::create_dir_all(dir.path().join("某个目录")).unwrap();

        assert_eq!(
            rename_note_in(&state, "不存在.md", "新名", true)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::NotFound
        );
        assert_eq!(
            rename_note_in(&state, "某个目录", "新名", true)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::IsDirectory,
            "目录重命名不在本轮范围"
        );
        assert_eq!(
            rename_note_in(&state, "乙.md", "目标", true)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::AlreadyExists
        );
        assert!(dir.path().join("乙.md").exists(), "失败时源文件不能被动过");
    }

    #[test]
    fn rename_without_vault_is_rejected() {
        let state = AppState::default();
        assert_eq!(
            rename_note_in(&state, "乙.md", "丙", true)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::VaultNotSet
        );
    }

    #[test]
    fn rename_rewrites_backlinks_and_updates_caches() {
        let (dir, state) = state_with(&[
            ("笔记/甲.md", "见 [[乙]] 与 [x](乙.md)\n"),
            ("笔记/层级/丙.md", "[[笔记/乙]]\n"),
            ("笔记/乙.md", "# 乙\n"),
        ]);

        let report = rename_note_in(&state, "笔记/乙.md", "戊", true).unwrap();
        assert_eq!(report.old_rel_path, "笔记/乙.md");
        assert_eq!(report.new_rel_path, "笔记/戊.md");
        assert_eq!(report.updated_link_count, 3);
        assert_eq!(report.updated_links.len(), 2);
        assert_eq!(
            read_file(dir.path(), "笔记/甲.md"),
            "见 [[戊]] 与 [x](戊.md)\n"
        );
        assert_eq!(read_file(dir.path(), "笔记/层级/丙.md"), "[[../戊]]\n");
        assert!(report.mtime_ms > 0);

        // 条目缓存 + 索引都在同一条命令里同步好了
        apply_renamed_entry(&state, &report);
        state
            .with_vault(|ctx| {
                assert!(!ctx.entries.contains_key("笔记/乙.md"));
                assert!(ctx.entries.contains_key("笔记/戊.md"));
                assert_eq!(ctx.entries["笔记/戊.md"].name, "戊.md");
                assert_eq!(ctx.entries["笔记/戊.md"].ext.as_deref(), Some("md"));
                assert_eq!(ctx.note_count, 3, "改名不改变笔记数");
                assert!(ctx.order.contains(&"笔记/戊.md".to_string()));
                Ok(())
            })
            .unwrap();

        let mut index = state.index_write();
        assert!(!index.contains("笔记/乙.md"), "旧路径必须从索引里消失");
        assert!(index.contains("笔记/戊.md"));
        // 甲.md 里两条链接 + 丙.md 里一条 = 3 条反链
        assert_eq!(index.backlinks_of("笔记/戊.md").len(), 3);
    }

    #[test]
    fn rename_with_update_links_false_touches_no_other_file() {
        let (dir, state) = state_with(&[("甲.md", "[[乙]]\n"), ("乙.md", "# 乙\n")]);
        let before = std::fs::metadata(dir.path().join("甲.md"))
            .unwrap()
            .modified()
            .unwrap();

        let report = rename_note_in(&state, "乙.md", "丙", false).unwrap();

        assert_eq!(report.new_rel_path, "丙.md");
        assert!(report.updated_links.is_empty());
        assert_eq!(report.updated_link_count, 0);
        assert_eq!(read_file(dir.path(), "甲.md"), "[[乙]]\n");
        assert_eq!(
            std::fs::metadata(dir.path().join("甲.md"))
                .unwrap()
                .modified()
                .unwrap(),
            before,
            "不更新链接时连 mtime 都不该变（说明根本没写）"
        );
        assert!(dir.path().join("丙.md").exists());
        assert!(!dir.path().join("乙.md").exists());
        // 索引也必须切到新路径，而不是留下旧路径的幽灵条目
        assert!(!state.index_write().contains("乙.md"));
        assert!(state.index_write().contains("丙.md"));
    }

    // -- 跨目录移动（note_move） ------------------------------------------------

    #[test]
    fn move_relocates_the_file_and_updates_every_cache() {
        let (dir, state) = state_with(&[
            ("笔记/甲.md", "见 [[乙]] 与 [x](乙.md)\n"),
            ("别的/乙.md", "# 乙\n"),
        ]);

        let report = move_note_in(&state, "别的/乙.md", "归档", None, true).unwrap();
        assert_eq!(report.old_rel_path, "别的/乙.md");
        assert_eq!(report.new_rel_path, "归档/乙.md");
        assert_eq!(report.updated_link_count, 2);
        assert!(dir.path().join("归档").join("乙.md").exists());
        assert!(!dir.path().join("别的").join("乙.md").exists());

        // 链接改写成"相对新位置的路径"（裸名会被同目录优先的消歧规则重新解释）
        assert_eq!(
            read_file(dir.path(), "笔记/甲.md"),
            "见 [[../归档/乙]] 与 [x](../归档/乙.md)\n"
        );

        // 条目缓存：换路径 + 新建目录入表（否则前端树会把笔记提升成根节点）
        apply_renamed_entry(&state, &report);
        register_moved_dirs(&state, &report.new_rel_path);
        state
            .with_vault(|ctx| {
                assert!(!ctx.entries.contains_key("别的/乙.md"));
                assert_eq!(ctx.entries["归档/乙.md"].name, "乙.md");
                assert_eq!(ctx.entries["归档/乙.md"].ext.as_deref(), Some("md"));
                assert!(ctx.entries["归档"].is_dir, "新建的目标目录必须在条目表里");
                assert_eq!(ctx.folder_count, 3, "笔记 + 别的 + 新建的归档");
                assert_eq!(ctx.note_count, 2);
                assert!(ctx.order.contains(&"归档".to_string()));
                Ok(())
            })
            .unwrap();

        // 索引：旧路径消失、新路径可查、反链跟着走
        let mut index = state.index_write();
        assert!(!index.contains("别的/乙.md"));
        assert!(index.contains("归档/乙.md"));
        assert_eq!(index.backlinks_of("归档/乙.md").len(), 2);
    }

    #[test]
    fn move_to_a_brand_new_directory_creates_it_and_registers_the_entry() {
        let (dir, state) = state_with(&[("笔记/甲.md", "# 甲\n")]);
        let report = move_note_in(&state, "笔记/甲.md", "归档/2026", None, true).unwrap();

        apply_renamed_entry(&state, &report);
        register_moved_dirs(&state, &report.new_rel_path);

        assert!(dir.path().join("归档").join("2026").join("甲.md").exists());
        state
            .with_vault(|ctx| {
                assert!(ctx.entries["归档"].is_dir);
                assert!(ctx.entries["归档/2026"].is_dir, "缺失的祖先目录要一起补上");
                assert_eq!(ctx.folder_count, 3, "笔记 + 归档 + 归档/2026");
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn move_never_overwrites_an_existing_file() {
        let (dir, state) = state_with(&[
            ("笔记/甲.md", "[[乙]]\n"),
            ("笔记/乙.md", "# 笔记里的乙\n"),
            ("归档/乙.md", "# 归档里的乙\n"),
        ]);

        let error = move_note_in(&state, "笔记/乙.md", "归档", None, true).unwrap_err();
        assert_eq!(error.code(), mn_core::ErrorCode::AlreadyExists);
        // 跨 IPC 的错误码必须与前端 `ErrorCode` 逐字一致（UI 只按 code 分支）
        assert_eq!(IpcError::from(error).code, "ALREADY_EXISTS");
        assert_eq!(read_file(dir.path(), "归档/乙.md"), "# 归档里的乙\n");
        assert!(dir.path().join("笔记").join("乙.md").exists());
        assert_eq!(read_file(dir.path(), "笔记/甲.md"), "[[乙]]\n");
    }

    #[test]
    fn move_to_the_same_directory_is_a_no_op() {
        let (dir, state) = state_with(&[("笔记/甲.md", "[[乙]]\n"), ("笔记/乙.md", "")]);
        let before = std::fs::metadata(dir.path().join("笔记/乙.md"))
            .unwrap()
            .modified()
            .unwrap();

        let report = move_note_in(&state, "笔记/乙.md", "笔记", None, true).unwrap();

        assert_eq!(report.new_rel_path, "笔记/乙.md");
        assert_eq!(report.updated_link_count, 0);
        assert_eq!(read_file(dir.path(), "笔记/甲.md"), "[[乙]]\n");
        assert_eq!(
            std::fs::metadata(dir.path().join("笔记/乙.md"))
                .unwrap()
                .modified()
                .unwrap(),
            before,
            "无操作时不该写盘"
        );
    }

    #[test]
    fn move_reports_missing_source_directory_target_and_unopened_vault() {
        let (dir, state) = state_with(&[("笔记/甲.md", ""), ("目录/里面的.md", "")]);
        std::fs::write(dir.path().join("占位.md"), "x").unwrap();

        assert_eq!(
            move_note_in(&state, "不存在.md", "归档", None, true)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::NotFound
        );
        assert_eq!(
            move_note_in(&state, "目录", "归档", None, true)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::IsDirectory,
            "目录移动仍推迟"
        );
        assert_eq!(
            move_note_in(&state, "笔记/甲.md", "占位.md", None, true)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::NotADirectory
        );
        assert_eq!(
            move_note_in(&state, "笔记/甲.md", "../外面", None, true)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::PathInvalid
        );

        let closed = AppState::default();
        assert_eq!(
            move_note_in(&closed, "笔记/甲.md", "归档", None, true)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::VaultNotSet
        );
    }

    #[test]
    fn move_with_a_new_title_and_search_index_stays_in_step() {
        let (_dir, state) = state_with(&[
            ("笔记/甲.md", "[[乙|别名]]\n"),
            ("笔记/乙.md", "第一行 关键词\n"),
        ]);

        let report = move_note_in(&state, "笔记/乙.md", "归档", Some("丙"), true).unwrap();
        assert_eq!(report.new_rel_path, "归档/丙.md");

        // 全文搜索：路径搬过去了，被改写的来源笔记也换了新文本
        let hits = search_query_in(&state, "关键词", None).unwrap().hits;
        assert_eq!(hits[0].rel_path, "归档/丙.md");
        assert_eq!(
            search_query_in(&state, "归档/丙", None).unwrap().total,
            1,
            "来源笔记里的链接文本也必须是改写后的"
        );
    }

    #[test]
    fn move_outcome_reuses_the_rename_contract() {
        let (_dir, state) = state_with(&[("笔记/甲.md", "[[乙]]\n"), ("笔记/乙.md", "")]);
        let report = move_note_in(&state, "笔记/乙.md", "归档", None, true).unwrap();
        let outcome = rename_outcome_from(report, 3);

        assert_eq!(outcome.old_rel_path, "笔记/乙.md");
        assert_eq!(outcome.new_rel_path, "归档/乙.md");
        assert_eq!(outcome.updated_links.len(), 1);
        assert_eq!(outcome.updated_links[0].rel_path, "笔记/甲.md");
        assert_eq!(outcome.updated_links[0].count, 1);
        assert_eq!(outcome.elapsed_ms, 3);

        let json = serde_json::to_string(&outcome).unwrap();
        for key in [
            "oldRelPath",
            "newRelPath",
            "newMtimeMs",
            "updatedLinks",
            "updatedLinkCount",
            "elapsedMs",
        ] {
            assert!(
                json.contains(&format!("\"{key}\"")),
                "note_move 复用 RenameOutcome，字段名必须一致：缺少 {key}：{json}"
            );
        }
    }

    // -- 目录重命名 / 目录移动（dir_rename / dir_move） --------------------------

    #[test]
    fn dir_rename_moves_the_whole_subtree_and_updates_the_entry_cache() {
        let (dir, state) = state_with(&[
            ("项目/甲.md", "# 甲\n"),
            ("项目/子/丙.md", "# 丙\n"),
            ("别的/引用.md", "见 [[项目/甲]] 与 [[项目/子/丙]]。\n"),
        ]);

        let report = rename_dir_in(&state, "项目", "工程", true).unwrap();
        assert_eq!(report.old_rel_path, "项目");
        assert_eq!(report.new_rel_path, "工程");
        assert_eq!(report.updated_link_count, 2);

        apply_renamed_dir(&state, &report);

        // 磁盘：整棵子树搬过去了
        assert!(dir.path().join("工程").join("甲.md").exists());
        assert!(dir.path().join("工程").join("子").join("丙.md").exists());
        assert!(!dir.path().join("项目").exists());
        assert_eq!(
            read_file(dir.path(), "别的/引用.md"),
            "见 [[../工程/甲]] 与 [[../工程/子/丙]]。\n"
        );

        // 条目缓存：**整棵子树**换路径，一篇都不能少（少一篇 = 文件树空一片）
        let state_ref = &state;
        state_ref
            .with_vault(|ctx| {
                let paths = ctx.paths_under("工程");
                assert_eq!(
                paths,
                vec![
                    "工程/子".to_string(),
                    "工程/子/丙.md".to_string(),
                    "工程/甲.md".to_string()
                ],
                "`工程` 自身的目录条目由 `register_moved_dirs` 补上（它把 `new_rel` 的祖先链补齐）"
            );
                assert!(ctx.paths_under("项目").is_empty());
                assert_eq!(ctx.note_count, 3, "笔记数不变");
                assert_eq!(ctx.folder_count, 2, "目录数不变（项目 → 工程）");
                Ok(())
            })
            .unwrap();

        // 索引：旧路径消失、新路径可查
        let index = state_ref.index_write();
        assert!(index.contains("工程/甲.md"));
        assert!(!index.contains("项目/甲.md"));
    }

    #[test]
    fn dir_move_into_another_directory_and_into_the_root() {
        let (dir, state) = state_with(&[
            ("项目/甲.md", "# 甲\n"),
            ("归档/说明.md", "见 [[项目/甲]]。\n"),
        ]);

        let report = move_dir_in(&state, "项目", "归档", None, true).unwrap();
        assert_eq!(report.new_rel_path, "归档/项目");
        apply_renamed_dir(&state, &report);
        register_moved_dirs(&state, &report.new_rel_path);
        assert!(dir.path().join("归档").join("项目").join("甲.md").exists());

        // 再移到 Vault 根：链接写法跟着变成"从根起算"
        let report = move_dir_in(&state, "归档/项目", "", None, true).unwrap();
        assert_eq!(report.new_rel_path, "项目");
        apply_renamed_dir(&state, &report);
        assert_eq!(
            read_file(dir.path(), "归档/说明.md"),
            "见 [[../项目/甲]]。\n"
        );
        assert!(state
            .vault_root()
            .unwrap()
            .resolve_existing("项目/甲.md")
            .is_ok());
    }

    #[test]
    fn dir_move_refuses_self_nesting_duplicate_target_and_missing_source() {
        let (dir, state) = state_with(&[
            ("项目/甲.md", "# 甲\n"),
            ("项目/子/丙.md", "# 丙\n"),
            ("归档/项目/甲.md", "# 归档里的甲\n"),
        ]);

        // 拖/输到自己的后代上：必须给一句能读懂的原因（不是系统的"找不到路径"）
        let error = move_dir_in(&state, "项目", "项目/子", None, true).unwrap_err();
        assert_eq!(error.code(), mn_core::ErrorCode::PathInvalid);
        assert!(error.to_string().contains("子目录"), "实际：{error}");

        // 目标同名目录：绝不覆盖、也绝不合并
        let error = move_dir_in(&state, "项目", "归档", None, true).unwrap_err();
        assert_eq!(error.code(), mn_core::ErrorCode::AlreadyExists);
        assert_eq!(read_file(dir.path(), "归档/项目/甲.md"), "# 归档里的甲\n");
        assert!(dir.path().join("项目").join("甲.md").exists());

        // 源不存在 / 源是文件
        assert_eq!(
            move_dir_in(&state, "不存在", "归档", None, true)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::NotFound
        );
        assert_eq!(
            move_dir_in(&state, "项目/甲.md", "归档", None, true)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::NotADirectory
        );

        // 内部工作目录不参与搬迁
        std::fs::create_dir_all(dir.path().join(".mimenote")).unwrap();
        assert_eq!(
            move_dir_in(&state, ".mimenote", "归档", None, true)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::PathInvalid
        );
    }

    #[test]
    fn dir_move_reuses_the_rename_contract() {
        let (_dir, state) =
            state_with(&[("项目/甲.md", "[[子/丙]]\n"), ("项目/子/丙.md", "# 丙\n")]);
        let report = move_dir_in(&state, "项目", "归档", None, true).unwrap();
        let outcome = rename_outcome_from(report, 7);

        assert_eq!(outcome.old_rel_path, "项目");
        assert_eq!(outcome.new_rel_path, "归档/项目");
        assert_eq!(outcome.new_mtime_ms, 0, "目录不是版本令牌的载体，如实报 0");
        assert_eq!(outcome.elapsed_ms, 7);

        let json = serde_json::to_string(&outcome).unwrap();
        for key in [
            "oldRelPath",
            "newRelPath",
            "newMtimeMs",
            "updatedLinks",
            "updatedLinkCount",
            "elapsedMs",
        ] {
            assert!(
                json.contains(&format!("\"{key}\"")),
                "dir_move 复用 RenameOutcome，字段名必须一致：缺少 {key}：{json}"
            );
        }
    }

    #[test]
    fn dir_rename_without_vault_is_rejected() {
        let state = AppState::default();
        assert_eq!(
            rename_dir_in(&state, "项目", "工程", true)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::VaultNotSet
        );
        assert_eq!(
            move_dir_in(&state, "项目", "归档", None, true)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::VaultNotSet
        );
    }

    // -- 标签与 frontmatter（note_tags / tags_list / tag_notes） -----------------

    // -- 改标签（note_set_tags） -------------------------------------------------

    /// 一个"什么形态都有一点"的笔记：BOM + CRLF + 注释 + 未知键 + 块数组标签 + 行内标签。
    const TAGGED: &str = "\u{feff}---\r\ntitle: 示例\r\ntags:\r\n  - 甲\r\ndraft: false # 未完成\r\ncover: 图.png\r\n---\r\n# 标题\r\n\r\n正文 #行内\r\n";

    fn owned(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_string()).collect()
    }

    /// 磁盘上的当前令牌（前端面板拿到的就是这个值，来自 `note_read`）。
    ///
    /// 令牌是**必填**的：这里刻意不给"0 表示不校验"的后门，否则"绝不静默覆盖"就成了摆设。
    fn token_of(dir: &std::path::Path, rel: &str) -> u64 {
        let path = dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        mn_core::atomic::path_mtime_ms(&path).unwrap().unwrap_or(0)
    }

    #[test]
    fn set_tags_adds_and_removes_with_a_minimal_diff() {
        let (dir, state) = state_with(&[("笔记/甲.md", TAGGED)]);

        let added = note_set_tags_in(
            &state,
            "笔记/甲.md",
            &owned(&["乙"]),
            &[],
            token_of(dir.path(), "笔记/甲.md"),
        )
        .unwrap();
        assert!(added.changed);
        assert_eq!(added.tags, owned(&["甲", "乙"]));
        let on_disk = read_file(dir.path(), "笔记/甲.md");
        assert_eq!(
            on_disk,
            TAGGED.replace("  - 甲\r\n", "  - 甲\r\n  - 乙\r\n"),
            "只该多出一个项行"
        );
        assert!(on_disk.starts_with('\u{feff}'), "BOM 必须保留");
        assert!(
            on_disk.contains("draft: false # 未完成"),
            "行尾注释必须保留"
        );
        assert!(on_disk.contains("cover: 图.png"), "未知键必须保留");
        assert!(on_disk.contains("# 标题"), "正文一个字节不动");

        // 索引增量同步：标签索引、全库概览、搜索索引都跟着变了（不需要重扫）
        assert_eq!(
            indexer::tags_of(&state, "笔记/甲.md")
                .unwrap()
                .iter()
                .map(|tag| tag.tag.clone())
                .collect::<Vec<String>>(),
            owned(&["甲", "乙", "行内"])
        );
        assert!(tags_list_in(&state).iter().any(|item| item.key == "乙"));
        assert!(
            state
                .try_search(|search| search.search("乙", 10))
                .map(|result| result
                    .unwrap()
                    .hits
                    .iter()
                    .any(|hit| hit.rel_path == "笔记/甲.md"))
                .unwrap_or(false),
            "搜索索引也应能命中新写入的标签"
        );

        // 删掉：磁盘逐字节回到原样
        let removed =
            note_set_tags_in(&state, "笔记/甲.md", &[], &owned(&["乙"]), added.mtime_ms).unwrap();
        assert!(removed.changed);
        assert_eq!(removed.tags, owned(&["甲"]));
        assert_eq!(read_file(dir.path(), "笔记/甲.md"), TAGGED);
    }

    #[test]
    fn set_tags_refuses_on_a_stale_token_and_never_overwrites() {
        let (dir, state) = state_with(&[("甲.md", "---\ntags: [甲]\n---\n正文\n")]);
        let stale = token_of(dir.path(), "甲.md") + 1;

        let error = note_set_tags_in(&state, "甲.md", &owned(&["乙"]), &[], stale).unwrap_err();
        assert_eq!(error.code(), mn_core::ErrorCode::Conflict);
        assert!(matches!(
            error,
            Error::Conflict {
                current_mtime_ms
            } if current_mtime_ms > 0
        ));
        // 一个字节都没写
        assert_eq!(
            read_file(dir.path(), "甲.md"),
            "---\ntags: [甲]\n---\n正文\n"
        );
    }

    #[test]
    fn set_tags_is_idempotent_and_writes_nothing_for_an_existing_tag() {
        let (dir, state) = state_with(&[("甲.md", "---\ntags: [Rust]\n---\n正文\n")]);
        let base = token_of(dir.path(), "甲.md");

        // 加一个**已经存在**的标签（写法不同、判同后是同一个）→ 不写盘、mtime 不变
        let outcome = note_set_tags_in(&state, "甲.md", &owned(&["#rust"]), &[], base).unwrap();
        assert!(!outcome.changed, "幂等请求不该产生无意义的 diff");
        assert_eq!(outcome.written_in_ms, 0);
        assert_eq!(outcome.mtime_ms, base, "没有实际写入就不该动令牌");
        assert_eq!(outcome.tags, owned(&["Rust"]), "写法保留首次出现的那份");
        assert_eq!(
            read_file(dir.path(), "甲.md"),
            "---\ntags: [Rust]\n---\n正文\n"
        );

        // 空请求同理：什么都不做
        let empty = note_set_tags_in(&state, "甲.md", &[], &[], base).unwrap();
        assert!(!empty.changed);
        assert_eq!(empty.tags, owned(&["Rust"]));
    }

    #[test]
    fn set_tags_creates_frontmatter_when_the_note_has_none() {
        let (dir, state) = state_with(&[("裸.md", "# 只有正文\n\n正文里的 #行内。\n")]);

        let outcome = note_set_tags_in(
            &state,
            "裸.md",
            &owned(&["新"]),
            &[],
            token_of(dir.path(), "裸.md"),
        )
        .unwrap();
        assert!(outcome.changed);
        assert_eq!(outcome.tags, owned(&["新"]));
        assert_eq!(
            read_file(dir.path(), "裸.md"),
            "---\ntags: [新]\n---\n# 只有正文\n\n正文里的 #行内。\n"
        );
        assert_eq!(
            outcome.text, "---\ntags: [新]\n---\n# 只有正文\n\n正文里的 #行内。\n",
            "出参里的 text 必须就是磁盘上的那份（前端据此对齐编辑器内存）"
        );

        // 删掉最后一个标签：**保留** `tags` 字段写成空列表（不删 key，见 ADR-0006 后续修订）
        let back =
            note_set_tags_in(&state, "裸.md", &[], &owned(&["新"]), outcome.mtime_ms).unwrap();
        assert!(back.changed);
        assert!(back.tags.is_empty());
        assert_eq!(
            read_file(dir.path(), "裸.md"),
            "---\ntags: []\n---\n# 只有正文\n\n正文里的 #行内。\n"
        );
        // 正文里的行内标签从头到尾没被碰过
        assert_eq!(
            indexer::tags_of(&state, "裸.md")
                .unwrap()
                .iter()
                .filter(|tag| tag.source == mn_core::TagSource::Inline)
                .map(|tag| tag.tag.clone())
                .collect::<Vec<String>>(),
            owned(&["行内"])
        );
    }

    #[test]
    fn set_tags_handles_scalar_tags_and_quotes_unsafe_values() {
        let (dir, state) = state_with(&[("甲.md", "---\r\ntags: 甲\r\n---\r\n正文\r\n")]);

        // 标量 + 一个 → 仍是标量（沿用既有写法）
        let one = note_set_tags_in(
            &state,
            "甲.md",
            &owned(&["乙"]),
            &[],
            token_of(dir.path(), "甲.md"),
        )
        .unwrap();
        let disk = read_file(dir.path(), "甲.md");
        assert_eq!(disk, "---\r\ntags: [甲, 乙]\r\n---\r\n正文\r\n");
        assert!(disk.contains("\r\n"), "CRLF 保真");

        // 带空格 / 层级 / 中文：写出去必须能原样读回来
        let unsafe_tags = note_set_tags_in(
            &state,
            "甲.md",
            &owned(&["带 空格", "父/子", "中文标签"]),
            &[],
            one.mtime_ms,
        )
        .unwrap();
        assert_eq!(
            unsafe_tags.tags,
            owned(&["甲", "乙", "带 空格", "父/子", "中文标签"]),
            "含空格的标签必须被引号保护后原样读回"
        );
        assert!(read_file(dir.path(), "甲.md").contains("'带 空格'"));

        // 删到一个不剩 → 保留字段、写成空列表（而不是把 key 删掉）
        let none = note_set_tags_in(
            &state,
            "甲.md",
            &[],
            &owned(&["甲", "#乙", "带 空格", "父/子", "中文标签"]),
            unsafe_tags.mtime_ms,
        )
        .unwrap();
        assert_eq!(none.tags, Vec::<String>::new());
        assert_eq!(
            read_file(dir.path(), "甲.md"),
            "---\r\ntags: []\r\n---\r\n正文\r\n"
        );
    }

    #[test]
    fn set_tags_only_touches_the_field_it_owns() {
        // 同时存在 `tag` 与 `tags`：写入目标永远是 `tags`（`set_tags` 的既有口径）。
        // 因此"只被 `tag` 字段提供"的标签删不掉 —— 这是已知边界，钉住它以免被误认为随机行为
        let (dir, state) = state_with(&[("甲.md", "---\ntag: 单数\ntags: [甲]\n---\n正文\n")]);

        let existing =
            note_set_tags_in(&state, "甲.md", &[], &[], token_of(dir.path(), "甲.md")).unwrap();
        assert_eq!(
            existing.tags,
            owned(&["单数", "甲"]),
            "两个字段合并后才是面板看到的列表"
        );

        let outcome =
            note_set_tags_in(&state, "甲.md", &[], &owned(&["单数"]), existing.mtime_ms).unwrap();
        assert!(!outcome.changed, "没有可写的改动");
        assert_eq!(outcome.tags, owned(&["单数", "甲"]), "`tag: 单数` 仍然在");
        assert_eq!(
            read_file(dir.path(), "甲.md"),
            "---\ntag: 单数\ntags: [甲]\n---\n正文\n"
        );

        // 加标签则照常工作（结果写进 `tags`，不会与 `tag` 字段打架）
        let added =
            note_set_tags_in(&state, "甲.md", &owned(&["乙"]), &[], outcome.mtime_ms).unwrap();
        assert_eq!(added.tags, owned(&["单数", "甲", "乙"]));
        assert_eq!(
            read_file(dir.path(), "甲.md"),
            "---\ntag: 单数\ntags: [甲, 乙]\n---\n正文\n"
        );
    }

    #[test]
    fn set_tags_works_on_the_singular_tag_field_and_on_an_empty_request() {
        // 只有 `tag:`（单数）的笔记：写入目标就是它（`set_tags` 的既有口径）
        let (dir, state) = state_with(&[("甲.md", "---\ntag: 旧\n---\n正文\n")]);
        let added = note_set_tags_in(
            &state,
            "甲.md",
            &owned(&["新"]),
            &[],
            token_of(dir.path(), "甲.md"),
        )
        .unwrap();
        assert_eq!(added.tags, owned(&["旧", "新"]));
        assert_eq!(
            read_file(dir.path(), "甲.md"),
            "---\ntag: [旧, 新]\n---\n正文\n"
        );

        // 删到一个不剩：保留字段、写成空列表（不删 key）
        let back =
            note_set_tags_in(&state, "甲.md", &[], &owned(&["旧", "新"]), added.mtime_ms).unwrap();
        assert!(back.tags.is_empty());
        assert_eq!(read_file(dir.path(), "甲.md"), "---\ntag: []\n---\n正文\n");

        // 既不增也不删 = 纯查询：不改一个字节（`tags: 甲, 乙` 这种标量形态最容易被顺手"规范化"）
        let (plain_dir, plain_state) = state_with(&[("乙.md", "---\ntags: 甲, 乙\n---\n正文\n")]);
        let query = note_set_tags_in(
            &plain_state,
            "乙.md",
            &[],
            &[],
            token_of(plain_dir.path(), "乙.md"),
        )
        .unwrap();
        assert!(!query.changed);
        assert_eq!(query.tags, owned(&["甲", "乙"]));
        assert_eq!(
            read_file(plain_dir.path(), "乙.md"),
            "---\ntags: 甲, 乙\n---\n正文\n"
        );
    }

    #[test]
    fn set_tags_reports_missing_file_directory_and_unopened_vault() {
        let (_dir, state) = state_with(&[("甲.md", "正文\n")]);
        assert_eq!(
            note_set_tags_in(&state, "不存在.md", &owned(&["甲"]), &[], 0)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::NotFound
        );
        std::fs::create_dir_all(_dir.path().join("目录")).unwrap();
        assert_eq!(
            note_set_tags_in(&state, "目录", &owned(&["甲"]), &[], 0)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::IsDirectory
        );
        // Vault 未打开
        let closed = AppState::default();
        assert_eq!(
            note_set_tags_in(&closed, "甲.md", &owned(&["甲"]), &[], 0)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::VaultNotSet
        );
    }

    /// 只读文件 / 只读 Vault：写盘失败必须是**可解释的错误**，且磁盘内容一字不改。
    ///
    /// 只在 Windows 上跑：`write_atomic` 的收尾是 `MoveFileEx(REPLACE_EXISTING)`，
    /// 目标只读时它必然失败；POSIX 的 `rename` 只看目录权限、会把只读文件照样换掉，
    /// 在那边这个用例会**假失败**（用例本身没错，是平台语义不同）。
    #[cfg(windows)]
    #[test]
    // `set_readonly(false)` 在 Unix 上语义不同（会让文件对所有人可写），但这一段本来就只跑在
    // Windows 上：这里恢复只读位只是为了**让临时目录能被清理**，不是产品行为
    #[allow(clippy::permissions_set_readonly_false)]
    fn set_tags_reports_io_instead_of_silently_failing_on_a_read_only_file() {
        let (dir, state) = state_with(&[("只读.md", "---\ntags: [甲]\n---\n正文\n")]);
        let path = dir.path().join("只读.md");
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&path, permissions).unwrap();

        let error = note_set_tags_in(
            &state,
            "只读.md",
            &owned(&["乙"]),
            &[],
            token_of(dir.path(), "只读.md"),
        )
        .unwrap_err();
        assert_eq!(
            error.code(),
            mn_core::ErrorCode::Io,
            "写失败要报 IO，不能假装成功"
        );

        // 收尾：把只读位摘掉再断言内容（否则临时目录清理会失败）
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(false);
        std::fs::set_permissions(&path, permissions).unwrap();
        assert_eq!(
            read_file(dir.path(), "只读.md"),
            "---\ntags: [甲]\n---\n正文\n"
        );
        // 索引也不该被这次失败的写入污染
        assert_eq!(
            indexer::tags_of(&state, "只读.md")
                .unwrap()
                .iter()
                .map(|tag| tag.tag.clone())
                .collect::<Vec<String>>(),
            owned(&["甲"])
        );
    }

    #[test]
    fn note_tags_returns_index_tags_and_frontmatter_fields() {
        let (_dir, state) = state_with(&[(
            "笔记/甲.md",
            "---\ntitle: 甲\ntags: [项目/甲]\n---\n\n正文 #行内\n",
        )]);
        let root = state.vault_root().unwrap();

        let result = note_tags_in(&root, &state, "笔记/甲.md").unwrap();
        assert_eq!(result.rel_path, "笔记/甲.md");
        assert_eq!(
            result
                .tags
                .iter()
                .map(|tag| (tag.tag.as_str(), tag.line))
                .collect::<Vec<_>>(),
            vec![("项目/甲", 3), ("行内", 6)],
            "frontmatter 在前、正文在后，行号是全文绝对行号"
        );
        assert_eq!(result.tags[0].source, mn_core::TagSource::Frontmatter);
        assert_eq!(result.tags[1].source, mn_core::TagSource::Inline);

        let keys: Vec<&str> = result
            .frontmatter
            .iter()
            .map(|field| field.key.as_str())
            .collect();
        assert_eq!(keys, vec!["title", "tags"], "字段保序");
        assert_eq!(result.frontmatter[0].line, 2);
        assert_eq!(
            result.frontmatter[0].value.as_str(),
            Some("甲"),
            "标量值已去引号"
        );
        assert_eq!(
            result.frontmatter[1].value.as_list(),
            Some(["项目/甲".to_string()].as_slice())
        );
    }

    #[test]
    fn note_tags_without_frontmatter_uses_empty_array_not_null() {
        let (_dir, state) = state_with(&[("甲.md", "正文 #甲\n")]);
        let root = state.vault_root().unwrap();

        let result = note_tags_in(&root, &state, "甲.md").unwrap();
        assert!(result.frontmatter.is_empty());

        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"relPath\":\"甲.md\""), "实际：{json}");
        assert!(json.contains("\"frontmatter\":[]"), "必须是空数组：{json}");
        assert!(json.contains("\"tags\":[{"), "实际：{json}");
        assert!(json.contains("\"source\":\"inline\""), "实际：{json}");
        assert!(json.contains("\"line\":1"), "实际：{json}");
    }

    #[test]
    fn note_tags_reports_missing_file_and_directory() {
        let (dir, state) = state_with(&[("甲.md", "#甲\n")]);
        let root = state.vault_root().unwrap();
        std::fs::create_dir_all(dir.path().join("某个目录")).unwrap();

        assert_eq!(
            note_tags_in(&root, &state, "不存在.md").unwrap_err().code(),
            mn_core::ErrorCode::NotFound
        );
        assert_eq!(
            note_tags_in(&root, &state, "某个目录").unwrap_err().code(),
            mn_core::ErrorCode::IsDirectory
        );
    }

    #[test]
    fn note_tags_computes_from_text_when_note_is_not_indexed() {
        // 附件之类不在索引里；标签仍要现算出来，而不是显示成"没有标签"
        let (dir, state) = state_with(&[("甲.md", "#甲\n")]);
        let root = state.vault_root().unwrap();
        std::fs::write(dir.path().join("附件.md"), "正文 #现算\n").unwrap();

        let result = note_tags_in(&root, &state, "附件.md").unwrap();
        assert_eq!(
            result
                .tags
                .iter()
                .map(|tag| tag.tag.as_str())
                .collect::<Vec<_>>(),
            vec!["现算"]
        );
    }

    #[test]
    fn tags_list_orders_by_count_then_key() {
        let (_dir, state) = state_with(&[
            ("a.md", "正文 #共享 与 #独有\n"),
            ("b.md", "---\ntags: [共享]\n---\n正文\n"),
            ("c.md", "正文 #共享\n"),
        ]);

        let summary = tags_list_in(&state);
        assert_eq!(summary.len(), 2);
        assert_eq!(summary[0].key, "共享");
        assert_eq!(summary[0].count, 3, "count 是笔记数");
        assert_eq!(summary[1].key, "独有");
        assert_eq!(summary[1].count, 1);

        let json = serde_json::to_string(&summary).unwrap();
        for key in ["\"key\"", "\"tag\"", "\"count\""] {
            assert!(json.contains(key), "缺少字段 {key}：{json}");
        }
        assert!(!json.contains("keyCount"), "字段名必须是 camelCase：{json}");
    }

    #[test]
    fn tag_notes_normalizes_input_and_rejects_empty_key() {
        let (_dir, state) = state_with(&[("b.md", "正文 #Rust\n"), ("a.md", "正文 #rust\n")]);

        // 传原始写法（带 `#`、任意大小写）也能命中，返回的 key 是归一化后的键
        let result = tag_notes_in(&state, "#RUST").unwrap();
        assert_eq!(result.key, "rust");
        assert_eq!(
            result.notes,
            vec!["a.md".to_string(), "b.md".to_string()],
            "字典序"
        );
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"key\":\"rust\""), "实际：{json}");
        assert!(json.contains("\"notes\":["), "实际：{json}");

        // 不存在的标签 → 空列表（不是错误）
        assert!(tag_notes_in(&state, "没有这个标签")
            .unwrap()
            .notes
            .is_empty());

        // 空键 → PATH_INVALID
        for key in ["", "   ", "#", "/"] {
            assert_eq!(
                tag_notes_in(&state, key).unwrap_err().code(),
                mn_core::ErrorCode::PathInvalid,
                "应拒绝空键：{key:?}"
            );
        }
    }

    #[test]
    fn tags_follow_save_rename_and_delete() {
        let (dir, state) = state_with(&[("笔记/甲.md", "正文，还没有标签\n")]);
        assert!(tags_list_in(&state).is_empty());

        // 保存 = 落盘 + 增量更新索引（note_write 里正是这两步），之后标签立刻可见
        let saved = "正文 #新标签\n";
        std::fs::write(dir.path().join("笔记").join("甲.md"), saved).unwrap();
        indexer::update_note(&state, "笔记/甲.md", saved);
        assert_eq!(tags_list_in(&state)[0].key, "新标签");
        assert_eq!(
            tag_notes_in(&state, "新标签").unwrap().notes,
            vec!["笔记/甲.md".to_string()],
            "编辑笔记加标签，面板立刻能看到"
        );

        // 重命名（mn-index 的 rename 走的是同一对 remove/upsert）后标签跟着换路径
        let report = rename_note_in(&state, "笔记/甲.md", "乙", true).unwrap();
        assert_eq!(report.new_rel_path, "笔记/乙.md");
        assert_eq!(
            tag_notes_in(&state, "新标签").unwrap().notes,
            vec!["笔记/乙.md".to_string()],
            "标签必须跟着新路径"
        );

        // 删除 → 标签一起清掉，概览里不留空标签
        indexer::remove_note(&state, "笔记/乙.md");
        assert!(tags_list_in(&state).is_empty());
        assert!(tag_notes_in(&state, "新标签").unwrap().notes.is_empty());
    }

    // -- 标签重命名 / 合并（tag_rename） -----------------------------------------

    /// 全库改写：frontmatter 与正文一起改，条目表与索引一起同步，逐篇如实汇报。
    #[test]
    fn tag_rename_rewrites_the_whole_vault_and_reports_every_file() {
        let (dir, state) = state_with(&[
            ("甲.md", "---\ntags: [旧, 别的]\n---\n\n正文 #旧 与 #旧。\n"),
            ("目录/乙.md", "---\ntag: 旧\n---\n\n#旧 收尾\n"),
            ("丙.md", "---\ntags: [无关]\n---\n\n正文 #无关\n"),
            // 代码块与行内代码里的 `#旧` 不是标签：一个字都不能动
            ("丁.md", "```\n#旧\n```\n\n`#旧` 与 #旧\n"),
        ]);

        let outcome = tag_rename_in(&state, "旧", "新", false, false).unwrap();

        assert_eq!(outcome.from, "旧");
        assert_eq!(outcome.to, "新");
        assert!(!outcome.dry_run);
        assert_eq!(outcome.candidates, 3, "丁 也是候选（正文里有真标签）");
        assert_eq!(outcome.skipped.len(), 0);
        assert_eq!(outcome.unchanged, 0);
        assert_eq!(
            outcome
                .edited
                .iter()
                .map(|file| file.rel_path.as_str())
                .collect::<Vec<_>>(),
            vec!["丁.md", "甲.md", "目录/乙.md"],
            "字典序（`目录/乙.md` 的 UTF-8 字节序在 `甲.md` 之后）"
        );
        assert_eq!(outcome.frontmatter_edits, 2);
        assert_eq!(outcome.inline_edits, 4);

        // 磁盘：frontmatter 两个字段都改、正文行内也改，且代码块/行内代码原样
        assert_eq!(
            read_file(dir.path(), "甲.md"),
            "---\ntags: [新, 别的]\n---\n\n正文 #新 与 #新。\n"
        );
        assert_eq!(
            read_file(dir.path(), "目录/乙.md"),
            "---\ntag: 新\n---\n\n#新 收尾\n"
        );
        assert_eq!(
            read_file(dir.path(), "丙.md"),
            "---\ntags: [无关]\n---\n\n正文 #无关\n"
        );
        assert_eq!(
            read_file(dir.path(), "丁.md"),
            "```\n#旧\n```\n\n`#旧` 与 #新\n"
        );

        // 索引与条目表跟着走（复用既有增量路径，不需要重扫）
        assert!(
            tag_notes_in(&state, "旧").unwrap().notes.is_empty(),
            "旧标签必须从索引里消失"
        );
        assert_eq!(
            tag_notes_in(&state, "新").unwrap().notes,
            vec![
                "丁.md".to_string(),
                "甲.md".to_string(),
                "目录/乙.md".to_string()
            ]
        );
        let summary = tags_list_in(&state);
        assert!(
            summary.iter().any(|item| item.key == "新"),
            "全库概览跟着变"
        );
        assert!(summary.iter().all(|item| item.key != "旧"));
        // 条目表里的 (size, mtime) 更新成了磁盘上的真实值（下一次对账/外部改动监听都依赖它）
        let (size, mtime) = state
            .with_vault(|ctx| {
                let entry = ctx.entries.get("甲.md").unwrap();
                Ok((entry.size_bytes, entry.mtime_ms))
            })
            .unwrap();
        assert_eq!(size, read_file(dir.path(), "甲.md").len() as u64);
        assert_eq!(
            mtime,
            Some(token_of(dir.path(), "甲.md")),
            "条目表必须与磁盘对齐，否则下一次改名会把这一篇误判成「磁盘被外部改动」"
        );

        // 搜索索引也在同一处增量更新（正文变了，全文搜索必须搜得到新内容）
        let hits = state
            .with_search(|search| Ok(search.search("新", 10).unwrap().total))
            .unwrap();
        assert!(
            hits >= 4,
            "改写后的正文与字段都要能被搜到（实际 {hits} 行）"
        );
    }

    /// 层级：`父` → `母` 把子标签一起带走；`include_children=false` 时不带。
    #[test]
    fn tag_rename_can_carry_hierarchical_children() {
        let text = "---\ntags: [父, 父/子]\n---\n\n#父 与 #父/子 与 #父老\n";
        let (dir, state) = state_with(&[("甲.md", text), ("乙.md", "#父\n")]);

        let carried = tag_rename_in(&state, "父", "母", true, false).unwrap();
        assert_eq!(carried.candidates, 2);
        assert_eq!(
            read_file(dir.path(), "甲.md"),
            "---\ntags: [母, 母/子]\n---\n\n#母 与 #母/子 与 #父老\n",
            "`父老` 不能被误伤"
        );
        assert_eq!(read_file(dir.path(), "乙.md"), "#母\n");

        // 不带子标签：只剩整条等于 `父` 的那些（`父/子` 留在原地）
        let (dir2, state2) = state_with(&[("甲.md", text)]);
        let flat = tag_rename_in(&state2, "父", "母", false, false).unwrap();
        assert_eq!(flat.inline_edits, 1);
        assert_eq!(
            read_file(dir2.path(), "甲.md"),
            "---\ntags: [母, 父/子]\n---\n\n#母 与 #父/子 与 #父老\n"
        );
    }

    /// 合并：目标已经在同一篇里出现 → 不留重复项（frontmatter 列表与正文提及都算）。
    #[test]
    fn tag_rename_merges_without_leaving_duplicates() {
        let (dir, state) =
            state_with(&[("甲.md", "---\ntags: [甲, 乙]\n---\n\n正文 #甲 与 #乙。\n")]);
        let outcome = tag_rename_in(&state, "甲", "乙", false, false).unwrap();

        assert_eq!(
            read_file(dir.path(), "甲.md"),
            "---\ntags: [乙]\n---\n\n正文 与 #乙。\n"
        );
        assert_eq!(
            outcome.frontmatter_edits, 2,
            "一条被换写法、一条因为与目标重复被去掉"
        );
        assert_eq!(outcome.inline_removed, 1);
        assert_eq!(
            tag_notes_in(&state, "乙").unwrap().notes,
            vec!["甲.md".to_string()]
        );
        assert!(tag_notes_in(&state, "甲").unwrap().notes.is_empty());
    }

    /// 预演（`dry_run`）走完全一样的判定，但一个字节都不写、索引也不动。
    #[test]
    fn tag_rename_dry_run_counts_without_writing() {
        let (dir, state) = state_with(&[
            ("甲.md", "---\ntags: [旧]\n---\n\n正文 #旧\n"),
            ("乙.md", "#旧 与 #旧\n"),
            ("丙.md", "没有标签\n"),
        ]);

        let preview = tag_rename_in(&state, "旧", "新", true, true).unwrap();
        assert!(preview.dry_run);
        assert_eq!(preview.edited.len(), 2, "预演报的就是真跑会改的篇数");
        assert_eq!(preview.inline_edits, 3);
        assert_eq!(
            read_file(dir.path(), "甲.md"),
            "---\ntags: [旧]\n---\n\n正文 #旧\n",
            "预演不落盘"
        );
        assert_eq!(read_file(dir.path(), "乙.md"), "#旧 与 #旧\n");
        // 索引与条目表也不动（预演不是一次写操作）
        assert_eq!(
            tag_notes_in(&state, "旧").unwrap().notes,
            vec!["乙.md".to_string(), "甲.md".to_string()]
        );
        assert!(tag_notes_in(&state, "新").unwrap().notes.is_empty());
    }

    /// 重试幂等：第二次跑"没有需要改的"，既不改文件也不报错（`unchanged` 里如实计数）。
    #[test]
    fn tag_rename_retry_is_idempotent() {
        let before = "---\ntags: [旧]\n---\n\n正文 #旧\n";
        let (dir, state) = state_with(&[("甲.md", before)]);

        let first = tag_rename_in(&state, "旧", "新", false, false).unwrap();
        assert_eq!(first.edited.len(), 1);
        let after_first = read_file(dir.path(), "甲.md");
        let mtime_after_first = token_of(dir.path(), "甲.md");

        // 第二次：索引已经跟着第一次更新了 → 候选集是空的（连读文件都不必）
        let second = tag_rename_in(&state, "旧", "新", false, false).unwrap();
        assert!(second.edited.is_empty(), "已经改过的不再改第二遍");
        assert_eq!(second.candidates, 0, "索引里已经没有旧写法了");
        assert_eq!(after_first, read_file(dir.path(), "甲.md"));
        assert_eq!(
            mtime_after_first,
            token_of(dir.path(), "甲.md"),
            "一个字节都没写（连 mtime 都不该动）"
        );

        // 索引比磁盘旧一拍（外部改过、监听还没对账）时，候选集里仍然有这一篇 ——
        // 但真正的判据是**磁盘上的文本**，所以它只会被计入 `unchanged`，不会白写一次
        indexer::update_note(&state, "甲.md", before);
        let third = tag_rename_in(&state, "旧", "新", false, false).unwrap();
        assert_eq!(third.candidates, 1);
        assert_eq!(third.unchanged, 1);
        assert!(third.edited.is_empty());
        assert_eq!(mtime_after_first, token_of(dir.path(), "甲.md"));
    }

    /// 磁盘被外部改动过的那些：跳过并**如实说明原因**，其余照改。
    #[test]
    fn tag_rename_skips_files_changed_outside_the_app() {
        let (dir, state) = state_with(&[
            ("稳.md", "---\ntags: [旧]\n---\n\n正文 #旧\n"),
            ("被外部改.md", "---\ntags: [旧]\n---\n\n正文 #旧\n"),
        ]);

        // 让条目表与磁盘对不上：这就是"宿主的认知过时了"的判据（ADR-0016 同一份对账口径）。
        // 不用真的去 sleep 等 mtime 跳一格 —— 那个写法在毫秒级 mtime 上并不稳定
        state.update_vault(|ctx| {
            if let Some(entry) = ctx.entries.get_mut("被外部改.md") {
                entry.mtime_ms = Some(1);
            }
        });

        let outcome = tag_rename_in(&state, "旧", "新", false, false).unwrap();

        assert_eq!(
            outcome
                .edited
                .iter()
                .map(|file| file.rel_path.as_str())
                .collect::<Vec<_>>(),
            vec!["稳.md"]
        );
        assert_eq!(outcome.skipped.len(), 1);
        assert_eq!(outcome.skipped[0].rel_path, "被外部改.md");
        assert_eq!(outcome.skipped[0].reason, TagSkipReason::ExternalChange);
        assert!(
            outcome.skipped[0].message.contains("磁盘被外部改动"),
            "跳过必须带上能读懂的原因：{}",
            outcome.skipped[0].message
        );

        // 绝不静默覆盖：被跳过的那一篇一个字节都没动
        assert_eq!(
            read_file(dir.path(), "被外部改.md"),
            "---\ntags: [旧]\n---\n\n正文 #旧\n"
        );
        assert_eq!(
            read_file(dir.path(), "稳.md"),
            "---\ntags: [新]\n---\n\n正文 #新\n"
        );
        // 序列化形状（前端按 kebab-case 的稳定原因分组）
        let json = serde_json::to_string(&outcome).unwrap();
        assert!(
            json.contains("\"reason\":\"external-change\""),
            "实际：{json}"
        );
        assert!(json.contains("\"dryRun\":false"), "实际：{json}");

        // 字节数对不上也算"磁盘被外部改过"：mtime 是毫秒级、有漏检窗口，字节数是第二道判据
        let (dir2, state2) = state_with(&[("乙.md", "---\ntags: [旧]\n---\n正文\n")]);
        state2.update_vault(|ctx| {
            if let Some(entry) = ctx.entries.get_mut("乙.md") {
                entry.size_bytes += 7;
            }
        });
        let by_size = tag_rename_in(&state2, "旧", "新", false, false).unwrap();
        assert_eq!(by_size.skipped.len(), 1);
        assert_eq!(by_size.skipped[0].reason, TagSkipReason::ExternalChange);
        assert!(
            by_size.skipped[0].message.contains("字节"),
            "跳过原因要说清是哪一项对不上：{}",
            by_size.skipped[0].message
        );
        assert_eq!(
            read_file(dir2.path(), "乙.md"),
            "---\ntags: [旧]\n---\n正文\n"
        );
    }

    /// 单篇写失败不能把整批弄成"半截还不说"：只记一条跳过、其余照改。
    ///
    /// 与 `set_tags_reports_io_instead_of_silently_failing_on_a_read_only_file` 同一平台口径：
    /// `write_atomic` 的收尾在 Windows 上是 `MoveFileEx(REPLACE_EXISTING)`，目标只读时必然失败。
    #[cfg(windows)]
    #[test]
    #[allow(clippy::permissions_set_readonly_false)]
    fn tag_rename_reports_a_failed_write_and_keeps_going() {
        let (dir, state) = state_with(&[
            ("只读.md", "---\ntags: [旧]\n---\n正文\n"),
            ("别的.md", "---\ntags: [旧]\n---\n正文\n"),
        ]);
        let path = dir.path().join("只读.md");
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&path, permissions).unwrap();

        let outcome = tag_rename_in(&state, "旧", "新", false, false).unwrap();

        // 收尾：摘掉只读位（否则临时目录清理会失败）
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(false);
        std::fs::set_permissions(&path, permissions).unwrap();

        assert_eq!(outcome.edited.len(), 1, "另一个文件照改");
        assert_eq!(outcome.edited[0].rel_path, "别的.md");
        assert_eq!(outcome.skipped.len(), 1);
        assert_eq!(outcome.skipped[0].rel_path, "只读.md");
        assert_eq!(outcome.skipped[0].reason, TagSkipReason::WriteFailed);
        assert!(outcome.skipped[0].message.contains("写入失败"));
        assert_eq!(
            read_file(dir.path(), "只读.md"),
            "---\ntags: [旧]\n---\n正文\n"
        );
        // 写失败的那篇不能被同步进索引（索引必须与磁盘一致）
        assert_eq!(
            indexer::tags_of(&state, "只读.md")
                .unwrap()
                .iter()
                .map(|tag| tag.tag.clone())
                .collect::<Vec<String>>(),
            owned(&["旧"])
        );
    }

    /// 入参与前置条件：空名、Vault 未打开、索引没就绪。
    #[test]
    fn tag_rename_validates_its_inputs_and_needs_a_ready_index() {
        let (_dir, state) = state_with(&[("甲.md", "#旧\n")]);

        for (from, to) in [
            ("", "新"),
            ("   ", "新"),
            ("#", "新"),
            ("旧", ""),
            ("旧", " # "),
        ] {
            assert_eq!(
                tag_rename_in(&state, from, to, true, false)
                    .unwrap_err()
                    .code,
                mn_core::ErrorCode::PathInvalid.as_str(),
                "应当拒绝：{from:?} → {to:?}"
            );
        }

        // 索引还在构建：明确报错，而不是回答"改了 0 篇"（那是一句假答案）。
        // 错误码是宿主侧新增的 `INDEX_NOT_READY`（从前借 `IO`，见 `tag_rename_in` 的文档）
        state.set_index_status(indexer::IndexStatus::default());
        let building = tag_rename_in(&state, "旧", "新", true, false).unwrap_err();
        assert_eq!(building.code, "INDEX_NOT_READY");
        assert!(building.message.contains("正在构建"), "实际：{building}");

        // Vault 未打开
        let closed = AppState::default();
        assert_eq!(
            tag_rename_in(&closed, "旧", "新", true, false)
                .unwrap_err()
                .code,
            mn_core::ErrorCode::VaultNotSet.as_str()
        );
    }

    // -- 全文搜索（search_query） -----------------------------------------------

    #[test]
    fn search_limit_is_clamped() {
        assert_eq!(search_limit(None), 50, "缺省 50");
        assert_eq!(search_limit(Some(7)), 7);
        assert_eq!(search_limit(Some(0)), 1, "0 条没有意义，抬到 1");
        assert_eq!(search_limit(Some(9999)), 200, "上限 200");
    }

    #[test]
    fn search_returns_hits_with_camel_case_fields() {
        let (_dir, state) = state_with(&[
            ("笔记/甲.md", "第一行\n这里有 关键词 出现\n"),
            ("笔记/乙.md", "关键词 也在标题里\n"),
        ]);

        let result = search_query_in(&state, "关键词", None).unwrap();
        assert_eq!(result.query, "关键词", "原样回显");
        assert_eq!(result.total, 2);
        assert_eq!(result.hits.len(), 2);

        // 命中行号正确（顺序由 score 决定，这里只核对集合）
        let mut pairs: Vec<(&str, u32)> = result
            .hits
            .iter()
            .map(|hit| (hit.rel_path.as_str(), hit.line))
            .collect();
        pairs.sort_unstable();
        assert_eq!(
            pairs,
            vec![("笔记/乙.md", 1), ("笔记/甲.md", 2)],
            "行号是文件里的绝对行号（乙 U+4E59 在 甲 U+7532 之前）"
        );

        // 排序规则（契约）：score 降序 → relPath 升序 → line 升序，前端不再排一次
        for pair in result.hits.windows(2) {
            let (first, second) = (&pair[0], &pair[1]);
            let ordered = (second.score < first.score)
                || (second.score == first.score
                    && (first.rel_path.as_str(), first.line)
                        <= (second.rel_path.as_str(), second.line));
            assert!(ordered, "排序不稳定：{first:?} / {second:?}");
        }
        assert!(
            result.hits[0].snippet.contains("关键词"),
            "{:?}",
            result.hits[0]
        );
        assert!(!result.hits[0].snippet.contains('\n'), "snippet 必须是单行");

        let json = serde_json::to_string(&result).unwrap();
        for key in [
            "\"query\"",
            "\"hits\"",
            "\"total\"",
            "\"elapsedMs\"",
            "\"relPath\"",
            "\"line\"",
            "\"snippet\"",
            "\"score\"",
        ] {
            assert!(json.contains(key), "缺少字段 {key}：{json}");
        }
        assert!(!json.contains("rel_path"), "字段名必须是 camelCase：{json}");
    }

    #[test]
    fn search_snippets_are_cropped_around_the_match() {
        let long = format!("{}关键词{}", "前".repeat(200), "后".repeat(200));
        let (_dir, state) = state_with(&[("长行.md", &format!("开头\n{long}\n结尾\n"))]);

        let result = search_query_in(&state, "关键词", None).unwrap();
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].line, 2);
        assert!(result.hits[0].snippet.contains("关键词"));
        assert!(result.hits[0].snippet.chars().count() <= 120);
    }

    #[test]
    fn search_with_empty_query_never_touches_the_index() {
        // 故意不装搜索索引：空查询必须照样成功（"清空输入框"不该报错、也不该查库）
        let (dir, state) = state_with(&[("甲.md", "内容\n")]);
        state.clear_search();
        assert!(
            search_query_in(&state, "内容", None).is_err(),
            "非空查询该报错"
        );
        for query in ["", "   ", "\n\t"] {
            let result = search_query_in(&state, query, None).unwrap();
            assert!(result.hits.is_empty(), "查询 {query:?}");
            assert_eq!(result.total, 0);
        }
        let _ = dir;
    }

    #[test]
    fn search_reports_unavailable_index_with_reason() {
        let (_dir, state) = state_with(&[("甲.md", "内容\n")]);

        // 正在构建
        state.clear_search();
        let error = search_query_in(&state, "内容", None).unwrap_err();
        assert_eq!(error.code(), mn_core::ErrorCode::Io);
        assert!(error.to_string().contains("正在构建"), "{error}");

        // 建库失败（只读 Vault / 磁盘满）：把**原因**带给用户，而不是伪装成"没有结果"
        state.fail_search("Vault 只读，无法写入 .mimenote/cache");
        let error = search_query_in(&state, "内容", None).unwrap_err();
        assert_eq!(error.code(), mn_core::ErrorCode::Io);
        assert!(error.to_string().contains("只读"), "{error}");
    }

    #[test]
    fn search_without_vault_is_rejected_but_empty_query_is_fine() {
        let state = AppState::default();
        state.clear_search();
        assert_eq!(
            search_query_in(&state, "内容", None).unwrap_err().code(),
            mn_core::ErrorCode::VaultNotSet
        );
        assert_eq!(search_query_in(&state, "  ", None).unwrap().total, 0);
    }

    #[test]
    fn unavailable_cache_directory_degrades_instead_of_failing() {
        // 在 `.mimenote/cache` 的位置放一个**文件** → 建库必然失败（与"Vault 只读"同一条路径）
        let (dir, state) = state_with(&[("甲.md", "内容\n")]);
        std::fs::create_dir_all(dir.path().join(".mimenote")).unwrap();
        std::fs::write(dir.path().join(".mimenote").join("cache"), "占位").unwrap();

        let root = state.vault_root().unwrap();
        state.clear_search();
        // 打开失败 → 记原因、返回 None（不 panic、不返回半成品索引）
        let opened = SearchIndex::open_for_rebuild(&indexer::search_db_path(&root));
        assert!(opened.is_err(), "父路径是文件，必然打不开");
        state.fail_search(opened.unwrap_err().to_string());

        let error = search_query_in(&state, "内容", None).unwrap_err();
        assert_eq!(error.code(), mn_core::ErrorCode::Io);
        assert!(error.to_string().contains("SQLite") || error.to_string().contains("IO"));
    }

    #[test]
    fn search_index_follows_save_rename_and_delete() {
        let (dir, state) = state_with(&[("笔记/甲.md", "旧内容\n")]);
        assert_eq!(search_query_in(&state, "旧内容", None).unwrap().total, 1);

        // 保存 = 落盘 + 增量更新索引（note_write 里就是这两步）
        let saved = "新内容 与 关键词\n";
        std::fs::write(dir.path().join("笔记").join("甲.md"), saved).unwrap();
        indexer::update_note(&state, "笔记/甲.md", saved);
        assert_eq!(search_query_in(&state, "旧内容", None).unwrap().total, 0);
        assert_eq!(search_query_in(&state, "关键词", None).unwrap().total, 1);

        // 改名 → 搜索里的路径跟着走
        rename_note_in(&state, "笔记/甲.md", "乙", true).unwrap();
        let hits = search_query_in(&state, "关键词", None).unwrap().hits;
        assert_eq!(hits[0].rel_path, "笔记/乙.md");

        // 删除 → 搜不到了
        indexer::remove_note(&state, "笔记/乙.md");
        assert_eq!(search_query_in(&state, "关键词", None).unwrap().total, 0);
    }

    #[test]
    fn search_reports_line_and_snippet_for_chinese_queries() {
        let (_dir, state) = state_with(&[("日记.md", "今天天气很好\n\n明天要下雨\n")]);

        let result = search_query_in(&state, "天气", None).unwrap();
        assert_eq!(result.total, 1);
        assert_eq!(result.hits[0].line, 1);
        assert!(result.hits[0].snippet.contains("天气"));
    }

    #[test]
    fn hostile_search_queries_do_not_error() {
        let (_dir, state) = state_with(&[("甲.md", "alpha beta\nOR 也是词\n")]);
        for query in [
            "a\"b(c)", "-x", "OR", "NEAR", "*", "(", ")", "^", "\"", "a:b",
        ] {
            assert!(
                search_query_in(&state, query, None).is_ok(),
                "查询 {query:?} 不该报错"
            );
        }
    }

    #[test]
    fn rename_outcome_serializes_to_the_frontend_contract() {
        let (_dir, state) = state_with(&[("笔记/甲.md", "[[乙]]\n"), ("笔记/乙.md", "")]);
        let report = rename_note_in(&state, "笔记/乙.md", "丙", true).unwrap();
        let outcome = rename_outcome_from(report, 7);

        assert_eq!(outcome.old_rel_path, "笔记/乙.md");
        assert_eq!(outcome.new_rel_path, "笔记/丙.md");
        assert_eq!(outcome.updated_link_count, 1);
        assert_eq!(outcome.elapsed_ms, 7);
        assert!(outcome.new_mtime_ms > 0);
        assert_eq!(outcome.updated_links.len(), 1);

        let json = serde_json::to_string(&outcome).unwrap();
        for key in [
            "oldRelPath",
            "newRelPath",
            "newMtimeMs",
            "updatedLinks",
            "updatedLinkCount",
            "elapsedMs",
            "relPath",
            "count",
        ] {
            assert!(
                json.contains(&format!("\"{key}\"")),
                "缺少字段 {key}：{json}"
            );
        }
        assert!(json.contains("\"relPath\":\"笔记/甲.md\""), "实际：{json}");
        assert!(json.contains("\"count\":1"), "实际：{json}");
        assert!(json.contains("\"elapsedMs\":7"), "实际：{json}");
        assert!(
            !json.contains("old_rel_path"),
            "字段名必须是 camelCase：{json}"
        );
    }

    #[test]
    fn lists_only_css_snippets() {
        let (dir, root) = setup();
        let snippet_dir = dir.path().join(".mimenote/snippets");
        std::fs::create_dir_all(&snippet_dir).unwrap();
        std::fs::write(snippet_dir.join("b.css"), "body{color:red}").unwrap();
        std::fs::write(snippet_dir.join("a.css"), "/* a */").unwrap();
        std::fs::write(snippet_dir.join("readme.md"), "# not css").unwrap();
        std::fs::write(snippet_dir.join(".hidden.css"), "x").unwrap();

        let snippets = list_snippets(&root).unwrap();
        assert_eq!(snippets.len(), 2);
        assert_eq!(snippets[0].name, "a.css");
        assert_eq!(snippets[1].css, "body{color:red}");
    }

    #[test]
    fn missing_snippet_dir_is_empty_not_error() {
        let (_dir, root) = setup();
        assert!(list_snippets(&root).unwrap().is_empty());
    }

    #[test]
    fn helper_path_parsing() {
        assert_eq!(file_name_of("a/b/c.md"), "c.md");
        assert_eq!(ext_of("a/b/c.MD"), Some("md".to_string()));
        assert_eq!(ext_of("a/b/README"), None);
        assert_eq!(ext_of("a/b/.gitignore"), Some("gitignore".to_string()));
    }

    // -- 知识图谱（graph_data） -------------------------------------------------

    #[test]
    fn graph_without_vault_is_rejected() {
        let state = AppState::default();
        let error = graph_data_in(&state, MAX_GRAPH_NODES).unwrap_err();
        assert_eq!(error.code(), mn_core::ErrorCode::VaultNotSet);
        assert_eq!(
            IpcError::from(error).code,
            "VAULT_NOT_SET",
            "跨 IPC 的错误码必须与其它命令一致"
        );
    }

    #[test]
    fn graph_data_returns_the_canvas_contract() {
        let (_dir, state) = state_with(&[
            (
                "项目/设计.md",
                "---\ntitle: 设计文档\ntags: [项目]\n---\n\n见 [[路线图]] 与 [[还不存在]]\n",
            ),
            ("项目/路线图.md", "# 路线图\n"),
        ]);

        let data = graph_data_in(&state, MAX_GRAPH_NODES).unwrap();
        assert!(!data.truncated);
        assert_eq!(
            data.nodes
                .iter()
                .map(|node| node.rel_path.as_str())
                .collect::<Vec<_>>(),
            vec!["项目/设计.md", "项目/路线图.md"],
            "节点按 relPath 字典序（前端不二次排序）"
        );

        let design = &data.nodes[0];
        assert_eq!(design.title, "设计文档", "frontmatter 的 title 优先");
        assert_eq!(design.folder, "项目");
        assert_eq!(design.tags, vec!["项目".to_string()]);
        assert_eq!(design.out_degree, 2, "→路线图 + 悬空");
        assert_eq!(design.in_degree, 0);

        let roadmap = &data.nodes[1];
        assert_eq!(
            roadmap.title, "路线图",
            "没有 frontmatter title → 文件名主干"
        );
        assert_eq!(roadmap.in_degree, 1);
        assert_eq!(roadmap.out_degree, 0);

        assert_eq!(data.edges.len(), 2);
        assert_eq!(data.edges[0].from_rel_path, "项目/设计.md");
        assert_eq!(data.edges[0].to_rel_path.as_deref(), Some("项目/路线图.md"));
        assert_eq!(data.edges[0].to_raw_target, "路线图");
        assert_eq!(data.edges[0].count, 1);
        assert_eq!(data.edges[1].to_rel_path, None, "悬空边排在最后");
        assert_eq!(
            data.edges[1].to_raw_target, "还不存在",
            "悬空边靠原始写法显示'指向谁'"
        );

        // JSON 字段名必须与前端类型逐字一致（camelCase，一个 snake_case 都不能有）
        let json = serde_json::to_string(&data).unwrap();
        for key in [
            "\"nodes\"",
            "\"edges\"",
            "\"truncated\"",
            "\"elapsedMs\"",
            "\"relPath\"",
            "\"title\"",
            "\"folder\"",
            "\"tags\"",
            "\"outDegree\"",
            "\"inDegree\"",
            "\"fromRelPath\"",
            "\"toRelPath\"",
            "\"toRawTarget\"",
            "\"kind\"",
            "\"count\"",
        ] {
            assert!(json.contains(key), "缺少字段 {key}：{json}");
        }
        assert!(
            json.contains("\"toRelPath\":null"),
            "悬空链接是 null：{json}"
        );
        assert!(
            json.contains("\"toRawTarget\":\"还不存在\""),
            "悬空边的原始写法：{json}"
        );
        assert!(json.contains("\"kind\":\"wiki\""), "实际：{json}");
        assert!(json.contains("\"outDegree\":2"), "实际：{json}");
        for snake in [
            "rel_path",
            "out_degree",
            "in_degree",
            "from_rel_path",
            "to_rel_path",
            "to_raw_target",
            "elapsed_ms",
        ] {
            assert!(!json.contains(snake), "不该出现 snake_case {snake}：{json}");
        }
    }

    #[test]
    fn graph_is_empty_not_an_error_while_the_index_is_building() {
        let (_dir, state) = state_with(&[("甲.md", "[[乙]]\n"), ("乙.md", "# 乙\n")]);
        // 打开 Vault 后索引在后台重建（indexer::reset 就是 clear + 状态归零）
        indexer::reset(&state);

        let data = graph_data_in(&state, MAX_GRAPH_NODES).unwrap();
        assert!(data.nodes.is_empty(), "索引还没收录任何笔记");
        assert!(data.edges.is_empty());
        assert!(!data.truncated, "空索引不算'被截断'");
    }

    #[test]
    fn graph_ego_without_vault_is_rejected() {
        // 与 graph_data 同一个错误码口径：Vault 未打开是**调用方**的错误，不是"索引里没有这篇"
        let state = AppState::default();
        let error = graph_ego_in(&state, "甲.md", 1, 80).unwrap_err();
        assert_eq!(error.code(), mn_core::ErrorCode::VaultNotSet);
        assert_eq!(IpcError::from(error).code, "VAULT_NOT_SET");
    }

    #[test]
    fn graph_ego_serializes_to_the_frontend_contract() {
        let (_dir, state) = state_with(&[
            (
                "中心.md",
                "---\ntitle: 中心\ntags: [项目]\n---\n\n[[邻.md]] 与 [[还没有]]\n",
            ),
            ("邻.md", "见 [[中心]]\n"),
            ("无关.md", "谁都不认识\n"),
        ]);

        // 双向一跳：出链（邻.md）与反链都在（邻.md 也指回中心），无关.md 不出现
        let data = graph_ego_in(&state, "中心.md", 1, 80).unwrap();
        assert_eq!(
            data.nodes
                .iter()
                .map(|node| node.rel_path.as_str())
                .collect::<Vec<_>>(),
            vec!["中心.md", "邻.md"],
            "节点按 relPath 字典序（前端不二次排序）"
        );
        assert!(!data.truncated);
        assert_eq!(
            data.edges.len(),
            3,
            "中心→邻、邻→中心（双向都在），外加起点自己那条悬空边"
        );
        assert_eq!(
            data.nodes[0].out_degree, 2,
            "度数是全图口径（与 graph_data 逐字相同）"
        );

        // 起点不在索引里：空结果 + truncated=false，**不报错**（前端据此显示"还没进入索引"）
        let missing = graph_ego_in(&state, "还没进索引.md", 1, 80).unwrap();
        assert!(missing.nodes.is_empty());
        assert!(missing.edges.is_empty());
        assert!(!missing.truncated);

        // JSON 字段名必须与前端类型逐字一致（camelCase，一个 snake_case 都不能有）
        let json = serde_json::to_string(&data).unwrap();
        for key in [
            "\"nodes\"",
            "\"edges\"",
            "\"truncated\"",
            "\"elapsedMs\"",
            "\"relPath\"",
            "\"title\"",
            "\"folder\"",
            "\"tags\"",
            "\"outDegree\"",
            "\"inDegree\"",
            "\"fromRelPath\"",
            "\"toRelPath\"",
            "\"toRawTarget\"",
            "\"kind\"",
            "\"count\"",
        ] {
            assert!(json.contains(key), "缺少字段 {key}：{json}");
        }
        assert!(
            json.contains("\"toRelPath\":null"),
            "悬空链接是 null：{json}"
        );
        assert!(json.contains("\"outDegree\":2"), "实际：{json}");
        for snake in [
            "rel_path",
            "out_degree",
            "in_degree",
            "from_rel_path",
            "to_rel_path",
            "to_raw_target",
            "elapsed_ms",
            "max_nodes",
        ] {
            assert!(!json.contains(snake), "不该出现 snake_case {snake}：{json}");
        }
    }

    #[test]
    fn graph_follows_save_rename_and_delete() {
        let (dir, state) = state_with(&[("甲.md", "[[乙]]\n"), ("乙.md", "# 乙\n")]);
        let before = graph_data_in(&state, MAX_GRAPH_NODES).unwrap();
        assert_eq!(before.edges[0].to_rel_path.as_deref(), Some("乙.md"));

        // 保存：链接改成还不存在的目标 → 变成悬空边（toRelPath = null）
        let saved = "[[丙]]\n";
        std::fs::write(dir.path().join("甲.md"), saved).unwrap();
        indexer::update_note(&state, "甲.md", saved);
        let after_save = graph_data_in(&state, MAX_GRAPH_NODES).unwrap();
        assert_eq!(after_save.edges[0].to_rel_path, None);
        assert_eq!(
            after_save.edges[0].to_raw_target, "丙",
            "悬空边仍然带着用户写的目标名（画布上要显示它）"
        );
        assert_eq!(
            after_save
                .nodes
                .iter()
                .find(|node| node.rel_path == "乙.md")
                .unwrap()
                .in_degree,
            0,
            "乙 已经没人指向它了"
        );

        // 改名：节点路径与指向它的链接一起跟上（改写走的是同一份索引）
        rename_note_in(&state, "乙.md", "戊", true).unwrap();
        let after_rename = graph_data_in(&state, MAX_GRAPH_NODES).unwrap();
        assert!(after_rename
            .nodes
            .iter()
            .any(|node| node.rel_path == "戊.md"));
        assert!(!after_rename
            .nodes
            .iter()
            .any(|node| node.rel_path == "乙.md"));

        // 删除：节点消失；甲 指向不存在目标的悬空边不受影响
        indexer::remove_note(&state, "戊.md");
        let after_delete = graph_data_in(&state, MAX_GRAPH_NODES).unwrap();
        assert_eq!(after_delete.nodes.len(), 1);
        assert_eq!(after_delete.edges.len(), 1);
        assert_eq!(after_delete.edges[0].to_rel_path, None);
    }

    #[test]
    fn graph_truncates_from_the_host_entry_point() {
        let (_dir, state) = state_with(&[
            ("a.md", "[[b]] [[c]]\n"),
            ("b.md", ""),
            ("c.md", ""),
            ("d.md", ""),
        ]);

        let data = graph_data_in(&state, 3).unwrap();
        assert!(data.truncated);
        assert_eq!(
            data.nodes
                .iter()
                .map(|node| node.rel_path.as_str())
                .collect::<Vec<_>>(),
            vec!["a.md", "b.md", "c.md"],
            "度数最高的 a（2）+ 并列的 b/c（各 1，按路径定序）"
        );
        assert_eq!(data.edges.len(), 2, "指向被丢弃的 d.md 的边一起过滤");
        assert_eq!(
            data.nodes[0].out_degree, 2,
            "度数仍是全图度数（见 mn_index::graph 模块文档）"
        );
    }

    /// 合成一套 1 万笔记 / 100 目录的索引：每篇 frontmatter（title + 2 个标签）+ 2 条出链。
    ///
    /// `dangling_every = 0` → 所有链接都能解析；否则每 N 篇多一条指向**不存在笔记**的链接
    /// （悬空链接在真实 Vault 里很常见：先写下 `[[还没写的笔记]]`）。
    /// 第二个返回值是待解析的 `(from, target)` 列表 —— 供基准里**单独**测一遍解析成本。
    fn synthetic_graph_index(
        dangling_every: usize,
    ) -> (mn_index::LinkIndex, Vec<(String, String)>) {
        let mut index = mn_index::LinkIndex::new();
        let mut pairs: Vec<(String, String)> = Vec::new();
        for d in 0..100usize {
            for f in 0..100usize {
                let i = d * 100 + f;
                let rel = format!("dir{d:03}/note{i:04}.md");
                let mut text = format!(
                    "---\ntitle: 笔记 {i}\ntags: [标签{}, 标签{}]\n---\n\n第 {i} 篇的正文。\n\n",
                    i % 50,
                    i % 200,
                );
                for target in [(i + 1) % 10_000, (i + 7) % 10_000] {
                    let target = format!("note{target:04}");
                    text.push_str(&format!("[[{target}]] 与 "));
                    pairs.push((rel.clone(), target));
                }
                if dangling_every > 0 && i % dangling_every == 0 {
                    let target = format!("不存在{i}");
                    text.push_str(&format!("[[{target}]]\n"));
                    pairs.push((rel.clone(), target));
                }
                index.upsert(&rel, &text);
            }
        }
        (index, pairs)
    }

    /// 性能基准：1 万笔记的图谱组装耗时与 **IPC 报文体积**。
    ///
    /// 运行：`cargo test -p mimenote --release -- --ignored --nocapture bench_graph_data_10k_notes`
    ///
    /// 为什么需要它：`graph_data` 是第一个"把全库一次性交给前端"的命令，报文体积与耗时必须有
    /// 真实数字（前端画布据此决定虚拟化与降级策略）。索引直接**在内存里 upsert**出来，不碰磁盘 ——
    /// 测到的就是这条命令本身的成本，不含索引构建与文件 IO。
    ///
    /// 两套数据（A 无悬空 / B 5% 悬空）是为了**归因**：悬空目标会走
    /// `mn_index` 的 `by_path` 后缀兜底扫描（O(全库路径数)），这正是图谱最贵的一类输入。
    #[test]
    #[ignore]
    fn bench_graph_data_10k_notes() {
        let building = Instant::now();
        let (resolvable, resolvable_pairs) = synthetic_graph_index(0);
        let (with_dangling, dangling_pairs) = synthetic_graph_index(20);
        let build_ms = building.elapsed().as_millis();

        eprintln!("图谱 1 万笔记（两套索引在内存里 upsert 共 {build_ms} ms）：");
        report_graph_bench("A 全部可解析", &resolvable, &resolvable_pairs);
        let (truncated, full) =
            report_graph_bench("B 5% 笔记多一条悬空链接", &with_dangling, &dangling_pairs);

        assert!(truncated.truncated);
        assert_eq!(truncated.nodes.len(), mn_index::graph::MAX_GRAPH_NODES);
        assert!(!full.truncated);
        assert_eq!(full.nodes.len(), 10_000);
        assert_eq!(full.edges.len(), 20_500, "2 万条可解析 + 500 条悬空合并");
    }

    /// 打印一套数据的「解析归因 + 组装耗时 + 报文体积」。
    fn report_graph_bench(
        label: &str,
        index: &mn_index::LinkIndex,
        pairs: &[(String, String)],
    ) -> (mn_index::GraphData, mn_index::GraphData) {
        // 归因：单独把这批链接解析一遍（与图谱内部用的是同一个 resolve_target）
        let started = Instant::now();
        let mut resolved = 0usize;
        for (from, target) in pairs {
            resolved += usize::from(index.resolve(from, target).is_some());
        }
        let resolve_ms = started.elapsed().as_millis();

        let started = Instant::now();
        let truncated = index.graph_data(mn_index::graph::MAX_GRAPH_NODES);
        let truncated_ms = started.elapsed().as_millis();
        let truncated_kb = serde_json::to_string(&truncated).unwrap().len() as f64 / 1024.0;

        let started = Instant::now();
        let full = index.graph_data(usize::MAX);
        let full_ms = started.elapsed().as_millis();
        let full_kb = serde_json::to_string(&full).unwrap().len() as f64 / 1024.0;

        eprintln!(
            "{label}：{} 条链接（解析成功 {resolved}），单独解析 {resolve_ms} ms\n\
             \x20 截断（上限 3000）：{} 节点 / {} 边，组装 {truncated_ms} ms，JSON {truncated_kb:.0} KB\n\
             \x20 全量（上限 1 万）：{} 节点 / {} 边，组装 {full_ms} ms，JSON {full_kb:.0} KB",
            pairs.len(),
            truncated.nodes.len(),
            truncated.edges.len(),
            full.nodes.len(),
            full.edges.len(),
        );
        (truncated, full)
    }

    // -- 标签的层级编辑（tag_move）---------------------------------------------

    /// 层级编辑的契约：挂到父标签下、提回顶层、以及四种非法移动。
    ///
    /// 这一条同时钉住"复用了重命名那条写路径"：改完之后 frontmatter **与正文行内**都要变
    /// （只改一处就等于没改），子标签要跟着走，而"目标键被占用"必须被拒（那是合并，不是移动）。
    #[test]
    fn tag_move_nests_promotes_and_refuses_invalid_moves() {
        let (dir, state) = state_with(&[
            // 刻意带 frontmatter：移动/重命名只会改**已有**的字段（不会凭空建区块，
            // 那是"加标签"的 `set_tags_or_create` 才做的事），所以两种写法都要覆盖到
            ("甲.md", "---\ntags: [甲]\n---\n\n正文 #甲 与 #甲/子\n"),
            ("乙.md", "# 乙\n\n正文 #乙\n"),
        ]);

        // 挂到 `父` 下：frontmatter 与正文行内一起改，子标签跟着走
        let outcome = tag_move_in(&state, "甲", "父", true, false).unwrap();
        assert_eq!(outcome.from, "甲");
        assert_eq!(outcome.to, "父/甲");
        let moved = read_file(dir.path(), "甲.md");
        assert!(
            moved.contains("tags: [父/甲]"),
            "frontmatter 也要改：{moved}"
        );
        assert!(moved.contains("#父/甲/子"), "子标签跟着走：{moved}");

        // 提回顶层：`父/甲` → `甲`（末段保留），子标签同样跟着回来
        let promoted = tag_move_in(&state, "父/甲", "", true, false).unwrap();
        assert_eq!(promoted.to, "甲");
        assert_eq!(
            read_file(dir.path(), "甲.md"),
            "---\ntags: [甲]\n---\n\n正文 #甲 与 #甲/子\n"
        );

        // 非法移动：挂到自己 / 挂到自己的后代 / 空标签 / 已经在那里
        for (key, parent, reason) in [
            ("甲", "甲", "不能把标签挂到它自己下面"),
            (
                "甲",
                "甲/子",
                "不能把标签挂到它自己的子标签下面（会造出改不完的层级）",
            ),
            ("   ", "父", "标签名称为空，无法调整层级"),
            ("甲", "", "它已经在那个父标签下面了"),
        ] {
            let error = tag_move_in(&state, key, parent, true, false).unwrap_err();
            assert_eq!(error.code, mn_core::ErrorCode::PathInvalid.as_str());
            assert!(error.message.contains(reason), "{key}: {error}");
        }

        // **目标键已被占用 = 合并**：拒绝，并把人引到「重命名」那条路（绝不静默并掉）
        let (dir2, state2) =
            state_with(&[("乙.md", "# 乙\n\n#乙\n"), ("丁.md", "# 丁\n\n#父/乙\n")]);
        let error = tag_move_in(&state2, "乙", "父", true, false).unwrap_err();
        assert_eq!(error.code, mn_core::ErrorCode::PathInvalid.as_str());
        assert!(error.message.contains("已经是一个标签了"), "{error}");
        assert_eq!(
            read_file(dir2.path(), "乙.md"),
            "# 乙\n\n#乙\n",
            "被拒时一个字节都不改"
        );
        // 同一篇同时有 `乙` 与 `父/乙` 时也一样（判据是"目标键存在"，与哪一篇无关）
        assert_eq!(read_file(dir2.path(), "丁.md"), "# 丁\n\n#父/乙\n");
    }

    /// 预演（`dry_run`）只算不写：与真正执行时的候选集**同源**。
    #[test]
    fn tag_move_preview_does_not_touch_disk() {
        let (dir, state) = state_with(&[("甲.md", "---\ntags: [甲]\n---\n\n正文 #甲\n")]);
        let outcome = tag_move_in(&state, "甲", "父", true, true).unwrap();
        assert!(outcome.dry_run);
        assert_eq!(outcome.to, "父/甲");
        assert_eq!(outcome.candidates, 1, "预演也要如实说出会影响几篇");
        assert_eq!(
            read_file(dir.path(), "甲.md"),
            "---\ntags: [甲]\n---\n\n正文 #甲\n",
            "预演不落盘"
        );

        // 预演之后再执行：候选集与结果一致（同一条判定）
        let applied = tag_move_in(&state, "甲", "父", true, false).unwrap();
        assert_eq!(applied.to, outcome.to);
        assert_eq!(applied.candidates, outcome.candidates);
        assert!(read_file(dir.path(), "甲.md").contains("tags: [父/甲]"));
    }

    // -- 标签组合过滤（tag_filter）---------------------------------------------

    /// 组合过滤的契约：并集、排除、层级、以及"共 N 篇"的口径。
    #[test]
    fn tag_filter_combines_any_none_and_children() {
        let (_dir, state) = state_with(&[
            ("项目/甲.md", "# 甲\n\n#项目 #项目/前端\n"),
            ("项目/乙.md", "# 乙\n\n#项目/后端\n"),
            ("归档/旧.md", "# 旧\n\n#归档 #项目\n"),
            ("其它.md", "# 其它\n\n#其它\n"),
            ("无标签.md", "# 没有标签\n"),
        ]);

        // 含 项目（严格等于）：只有那两篇同时写了 `#项目` 的
        let strict = tag_filter_in(&state, &["项目".into()], &[], false);
        assert_eq!(
            strict.paths,
            vec!["归档/旧.md".to_string(), "项目/甲.md".into()]
        );
        assert_eq!(strict.matched, 2);
        assert_eq!(strict.tagged, 4, "有标签的笔记共 4 篇（无标签那篇不算）");

        // 含 项目 的后代（界面上「含子标签」默认开的那一档）
        let with_children = tag_filter_in(&state, &["项目".into()], &[], true);
        assert_eq!(with_children.matched, 3, "`#项目/后端` 也要算进来");

        // 有 项目 且**没有** 归档 —— 本轮新增的那一类查询
        let excluded = tag_filter_in(&state, &["项目".into()], &["归档".into()], true);
        assert_eq!(
            excluded.paths,
            vec!["项目/乙.md".to_string(), "项目/甲.md".into()]
        );

        // `any` 为空 = 全部有标签的笔记；只排除（"没有归档的笔记"）
        let all = tag_filter_in(&state, &[], &[], false);
        assert_eq!(all.matched, 4);
        let without_archive = tag_filter_in(&state, &[], &["归档".into()], false);
        assert_eq!(without_archive.matched, 3);

        // 空串与纯 `#` 忽略（不是"匹配所有"）
        let ignored = tag_filter_in(&state, &["".into(), "#".into()], &[], false);
        assert_eq!(ignored.matched, 4, "空键被忽略 → 等价于 any 为空");

        // 原始写法（大小写、带 `#`）与归一化键同一把尺子
        let raw = tag_filter_in(&state, &["#项目".into()], &[], false);
        assert_eq!(raw.matched, strict.matched);
    }

    // -- 回收站（trash_list / note_restore）------------------------------------
    #[test]
    fn trash_list_reports_records_whose_file_is_gone() {
        let (dir, state) = state_with(&[("笔记/甲.md", "# 甲\n")]);
        let root = state.vault_root().unwrap();
        let record = move_to_trash(&root, "笔记/甲.md").unwrap();

        let entries = trash_list_in(&state).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, record.id);
        assert!(entries[0].present, "刚删进回收站，文件当然在");
        assert_eq!(entries[0].original_rel_path, "笔记/甲.md");
        assert!(!entries[0].is_dir);

        // 用户在文件管理器里清掉了回收站：台账还在，但东西没了 —— 界面要能如实区分
        let stored = dir.path().join(
            record
                .stored_rel_path
                .replace('/', std::path::MAIN_SEPARATOR_STR),
        );
        std::fs::remove_file(&stored).unwrap();

        let entries = trash_list_in(&state).unwrap();
        assert_eq!(
            entries.len(),
            1,
            "孤儿记录仍然要列出来（用户可以据此知道发生了什么）"
        );
        assert!(!entries[0].present, "东西没了就必须说没了");
    }

    #[test]
    fn trash_list_is_sorted_by_deletion_time_desc() {
        let (_dir, state) = state_with(&[("a.md", "a"), ("b.md", "b")]);
        let root = state.vault_root().unwrap();
        let first = move_to_trash(&root, "a.md").unwrap();
        let second = move_to_trash(&root, "b.md").unwrap();

        let entries = trash_list_in(&state).unwrap();
        assert_eq!(entries.len(), 2);
        // 最近删的排最前（`deleted_at_ms` 可能同毫秒，所以只断言"第二新的不早于第一旧的"）
        assert!(entries[0].deleted_at_ms >= entries[1].deleted_at_ms);
        assert!(
            entries.iter().any(|entry| entry.id == first.id)
                && entries.iter().any(|entry| entry.id == second.id)
        );
    }

    #[test]
    fn restore_puts_the_note_back_and_syncs_tree_and_index() {
        let (dir, state) = state_with(&[
            ("笔记/甲.md", "# 甲\n\n#标签甲 与 [[乙]]\n"),
            ("笔记/乙.md", "# 乙\n"),
        ]);
        let root = state.vault_root().unwrap();
        let record = move_to_trash(&root, "笔记/甲.md").unwrap();
        // 删除之后条目与索引里都不该有它（`note_delete` 的收尾）
        state.update_vault(|ctx| ctx.remove("笔记/甲.md"));
        indexer::remove_note(&state, "笔记/甲.md");

        let summary = note_restore_in(&state, &record.id, None).unwrap();
        assert_eq!(summary.restored_rel_path, "笔记/甲.md");
        assert!(summary.restored_to_original_place);
        assert!(!summary.is_dir);
        assert!(!summary.needs_rescan, "单篇恢复要就地同步，不需要重扫");
        assert!(summary.created_dirs.is_empty());

        // 磁盘、条目表、索引（标签）三处都要回来
        assert_eq!(
            read_file(dir.path(), "笔记/甲.md"),
            "# 甲\n\n#标签甲 与 [[乙]]\n"
        );
        assert!(state
            .with_vault(|ctx| Ok(ctx.entries.contains_key("笔记/甲.md")))
            .unwrap());
        let tags = indexer::tags_of(&state, "笔记/甲.md").unwrap_or_default();
        assert!(
            tags.iter().any(|tag| tag.tag == "标签甲"),
            "恢复之后标签索引要认识这篇（否则标签面板与图谱还是缺一块）"
        );
        // 台账里不该再有它
        assert!(trash_list_in(&state).unwrap().is_empty());
    }

    #[test]
    fn restore_refuses_to_overwrite_and_keeps_the_record() {
        let (dir, state) = state_with(&[("a.md", "旧内容")]);
        let root = state.vault_root().unwrap();
        let record = move_to_trash(&root, "a.md").unwrap();
        // 用户已经把一篇新笔记写到了同一个名字上
        std::fs::write(dir.path().join("a.md"), "新内容").unwrap();

        let error = note_restore_in(&state, &record.id, None).unwrap_err();
        assert_eq!(error.code(), mn_core::ErrorCode::AlreadyExists);
        assert_eq!(read_file(dir.path(), "a.md"), "新内容", "绝不覆盖占位者");
        assert_eq!(
            trash_list_in(&state).unwrap().len(),
            1,
            "失败之后记录要留着，让用户换名字再来"
        );

        // 出路：「恢复为…」
        let summary = note_restore_in(&state, &record.id, Some("恢复/a.md")).unwrap();
        assert_eq!(summary.restored_rel_path, "恢复/a.md");
        assert!(!summary.restored_to_original_place);
        assert_eq!(summary.created_dirs, vec!["恢复".to_string()]);
        assert_eq!(read_file(dir.path(), "恢复/a.md"), "旧内容");
        assert_eq!(
            read_file(dir.path(), "a.md"),
            "新内容",
            "占位者仍然原样不动"
        );
    }

    #[test]
    fn restoring_a_directory_asks_the_caller_to_rescan() {
        let (dir, state) = state_with(&[("folder/a.md", "a\n"), ("folder/sub/b.md", "b\n")]);
        let root = state.vault_root().unwrap();
        let record = move_to_trash(&root, "folder").unwrap();
        assert!(record.is_dir);

        let summary = note_restore_in(&state, &record.id, None).unwrap();
        assert!(summary.is_dir);
        assert!(
            summary.needs_rescan,
            "目录恢复要交给扫描器：逐条猜 EntryMeta 会把扫描口径抄第二遍"
        );
        assert_eq!(read_file(dir.path(), "folder/sub/b.md"), "b\n");
    }

    #[test]
    fn restoring_an_unknown_id_is_not_found() {
        let (_dir, state) = state_with(&[("a.md", "a")]);
        assert_eq!(
            note_restore_in(&state, "不存在的-id", None)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::NotFound
        );
    }

    // -- 批量读取（整库导出的入口）----------------------------------------------

    #[test]
    fn notes_read_batch_reports_skips_with_reasons() {
        let (dir, state) = state_with(&[("甲.md", "# 甲\n正文\n"), ("乙.md", "乙\n")]);
        // 非 UTF-8 的那一篇（`read_text` 会拒）
        std::fs::write(dir.path().join("坏.md"), [0xff, 0xfe, 0x00]).unwrap();
        // 目录：路径存在，但不是笔记
        std::fs::create_dir_all(dir.path().join("目录.md")).unwrap();

        let batch = read_notes_batch(
            &state.vault_root().unwrap(),
            &[
                "甲.md".to_string(),
                "不存在.md".to_string(),
                "坏.md".to_string(),
                "目录.md".to_string(),
                "乙.md".to_string(),
            ],
        );

        // 单篇失败不影响别人：前面的成功项照样在 `items` 里，顺序保持
        assert_eq!(
            batch
                .items
                .iter()
                .map(|item| item.rel_path.as_str())
                .collect::<Vec<_>>(),
            vec!["甲.md", "乙.md"]
        );
        assert_eq!(batch.items[0].text, "# 甲\n正文\n");
        assert_eq!(batch.items[0].size_bytes, "# 甲\n正文\n".len() as u64);
        assert!(
            batch.items[0].mtime_ms > 0,
            "版本令牌要一起带回来（与 note_read 同一口径）"
        );

        // 四个原因值就是前端分支的依据，逐条钉住
        assert_eq!(
            batch
                .skipped
                .iter()
                .map(|skip| skip.reason)
                .collect::<Vec<_>>(),
            vec![
                crate::site_export::SiteSkipReason::NotFound,
                crate::site_export::SiteSkipReason::NotUtf8,
                crate::site_export::SiteSkipReason::Unreadable,
            ]
        );
        let json = serde_json::to_string(&NotesBatch {
            items: Vec::new(),
            skipped: batch.skipped.clone(),
        })
        .unwrap();
        for reason in ["\"not-found\"", "\"not-utf8\"", "\"unreadable\""] {
            assert!(json.contains(reason), "缺少 {reason}：{json}");
        }
        assert!(json.contains("\"skipped\""), "实际：{json}");

        // 空数组不是错误（前端第一次调用可能还没有清单）
        let empty = read_notes_batch(&state.vault_root().unwrap(), &[]);
        assert!(empty.items.is_empty() && empty.skipped.is_empty());
    }

    #[test]
    fn notes_read_batch_rejects_oversized_batches() {
        let (_dir, _state) = state_with(&[("甲.md", "正文\n")]);

        // 超过 64 篇 → PATH_INVALID（请求的形状不对，而不是某一篇读不到）。
        // 这条上限的意义是让一次 IPC 的报文体积有硬边界
        assert_eq!(MAX_BATCH_NOTES, 64);
        let too_many: Vec<String> = (0..MAX_BATCH_NOTES + 1)
            .map(|index| format!("笔记{index}.md"))
            .collect();
        let error = check_batch_size(too_many.len()).unwrap_err();
        assert_eq!(error.code, "PATH_INVALID");
        assert!(
            error.message.contains("64"),
            "说明要写清上限：{}",
            error.message
        );

        // 边界：正好 64 篇放行（由命令函数自己判，这里直接验判定函数）
        assert!(check_batch_size(MAX_BATCH_NOTES).is_ok());
        assert!(check_batch_size(0).is_ok());
    }
}
