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
use mn_core::trash::{move_to_trash, TrashRecord};
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
}
