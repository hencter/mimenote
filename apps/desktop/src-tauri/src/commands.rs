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

fn file_name_of(rel: &str) -> String {
    rel.rsplit('/').next().unwrap_or(rel).to_string()
}

fn ext_of(rel: &str) -> Option<String> {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    name.rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .filter(|ext| !ext.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
