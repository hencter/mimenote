//! 会话状态：当前打开的 Vault 及其缓存快照。
//!
//! 设计要点：
//!
//! * 扫描结果**缓存一次**，后续创建/删除/保存只做增量更新 —— 1 万笔记下避免每次操作
//!   都重扫目录（见 architecture.md §3.2）；
//! * 写操作由 [`AppState::write_guard`] 串行化，保证"检查 mtime → 写入"是原子的
//!   （见 ADR-0004）；
//! * 所有锁都是 `std::sync` 的短临界区锁，**不跨 await 持有**。

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard, RwLock, RwLockWriteGuard, Weak};

use mn_core::scanner::{EntryMeta, ScanOptions, ScanReport};
use mn_core::{Error, Result, VaultRoot};
use mn_index::{LinkIndex, SearchIndex};

use crate::indexer::IndexStatus;
use crate::watcher::{EventSink, WatcherHandle};

/// 全文搜索索引在"找不到原因"时用的路径标签（错误信息里给用户看的位置）。
const SEARCH_LABEL: &str = ".mimenote/cache/search.db";

/// 全文搜索索引的会话状态。
///
/// 三态是刻意的：**未就绪**（正在构建）、**可用**、**不可用**（只读 Vault、磁盘满……）。
/// 后两者的区别是"要不要把原因显示给用户"，所以原因串必须留着 —— 只写日志的话，
/// 用户只会看到"搜索没有结果"，而不是"索引建不起来"。
#[derive(Default)]
pub enum SearchSlot {
    /// 尚未构建（刚打开 Vault、正在构建、或还没打开）。
    #[default]
    Building,
    /// 可用。
    Ready(SearchIndex),
    /// 打不开（原因面向用户可显示）。
    Failed(String),
}

impl SearchSlot {
    fn index(&self) -> Result<&SearchIndex> {
        match self {
            Self::Ready(index) => Ok(index),
            Self::Building => Err(Error::io(
                SEARCH_LABEL,
                std::io::Error::other("全文搜索索引正在构建，请稍候重试"),
            )),
            Self::Failed(reason) => Err(Error::io(
                SEARCH_LABEL,
                std::io::Error::other(reason.clone()),
            )),
        }
    }
}

/// 已打开的 Vault 上下文。
#[derive(Debug)]
pub struct VaultCtx {
    pub root: VaultRoot,
    pub options: ScanOptions,
    /// 相对路径 → 元信息（增量更新的真相）。
    pub entries: HashMap<String, EntryMeta>,
    /// 扫描顺序（首次渲染用，保持稳定）。
    pub order: Vec<String>,
    pub note_count: usize,
    pub folder_count: usize,
    pub truncated: bool,
    pub skipped: usize,
    pub scan_ms: u64,
}

impl VaultCtx {
    /// 由扫描结果构建上下文。
    pub fn new(root: VaultRoot, options: ScanOptions, report: ScanReport) -> Self {
        let mut entries = HashMap::with_capacity(report.entries.len());
        let mut order = Vec::with_capacity(report.entries.len());
        for entry in report.entries {
            order.push(entry.rel_path.clone());
            entries.insert(entry.rel_path.clone(), entry);
        }
        Self {
            root,
            options,
            entries,
            order,
            note_count: report.note_count,
            folder_count: report.folder_count,
            truncated: report.truncated,
            skipped: report.skipped,
            scan_ms: report.scan_ms,
        }
    }

    /// 按扫描顺序产出条目（克隆，供 IPC 返回；10k 条量级为一次性成本）。
    pub fn entries_in_order(&self) -> Vec<EntryMeta> {
        self.order
            .iter()
            .filter_map(|rel| self.entries.get(rel).cloned())
            .collect()
    }

    /// 新增或更新一条（保存、新建后调用）。
    pub fn upsert(&mut self, entry: EntryMeta) {
        let rel = entry.rel_path.clone();
        let was_note = self
            .entries
            .get(&rel)
            .map(|old| is_note(old, &self.options))
            .unwrap_or(false);
        let is_dir = entry.is_dir;
        let now_note = is_note(&entry, &self.options);
        if !was_note && now_note {
            self.note_count += 1;
        }
        if was_note && !now_note {
            self.note_count = self.note_count.saturating_sub(1);
        }
        if self.entries.insert(rel.clone(), entry).is_none() {
            self.order.push(rel.clone());
            if is_dir {
                self.folder_count += 1;
            }
        }
    }

    /// 某个目录自身 + 它的所有后代（路径字典序）。
    ///
    /// 目录搬迁用它整棵子树一起换路径：`remove` 会连后代一起摘掉，只补回目录本身会让
    /// 子树里每一篇笔记都从条目表里消失（前端文件树空一片，而磁盘上它们好好的）。
    pub fn paths_under(&self, rel_path: &str) -> Vec<String> {
        let dir = rel_path.trim_end_matches('/');
        let prefix = format!("{dir}/");
        let mut out: Vec<String> = self
            .entries
            .keys()
            .filter(|key| key.as_str() == dir || key.starts_with(&prefix))
            .cloned()
            .collect();
        out.sort();
        out
    }

    /// 删除一条（**目录会连同其所有后代一起移除**）。
    pub fn remove(&mut self, rel_path: &str) {
        let prefix = format!("{rel_path}/");
        let doomed: Vec<String> = self
            .entries
            .keys()
            .filter(|k| k.as_str() == rel_path || k.starts_with(&prefix))
            .cloned()
            .collect();
        for key in doomed {
            if let Some(entry) = self.entries.remove(&key) {
                if is_note(&entry, &self.options) {
                    self.note_count = self.note_count.saturating_sub(1);
                }
                if entry.is_dir {
                    self.folder_count = self.folder_count.saturating_sub(1);
                }
            }
            self.order.retain(|k| k != &key);
        }
    }
}

fn is_note(entry: &EntryMeta, options: &ScanOptions) -> bool {
    !entry.is_dir
        && entry.ext.as_deref().is_some_and(|ext| {
            options
                .note_extensions
                .iter()
                .any(|n| n.eq_ignore_ascii_case(ext))
        })
}

/// 应用全局状态。
#[derive(Default)]
pub struct AppState {
    vault: RwLock<Option<VaultCtx>>,
    write_lock: Mutex<()>,
    /// 命令行指定的 Vault（`mimenote.exe <目录>`），供前端启动时自动打开。
    startup_vault: Option<String>,
    /// 链接索引（M2）。索引是缓存，可从文件重建。
    index: RwLock<LinkIndex>,
    /// 全文搜索索引（M2，SQLite FTS5）。`Connection` 不是 `Sync`，所以只能用 `Mutex`。
    search: Mutex<SearchSlot>,
    /// 索引构建状态（推送给前端显示进度）。
    index_status: RwLock<IndexStatus>,
    /// 正在进行的构建任务的取消句柄。
    index_cancel: Mutex<Option<Arc<AtomicBool>>>,
    /// 构建互斥量：同一时刻只允许一轮索引构建在跑（理由见 [`AppState::build_guard`]）。
    build_lock: Mutex<()>,
    /// 正在监听外部改动的 watcher（换 Vault / 关闭 Vault 时停掉，见 ADR-0016）。
    watcher: Mutex<Option<WatcherHandle>>,
    /// 事件出口（生产环境是 Tauri 的 `AppHandle`；测试里是一个 channel）。
    sink: Mutex<Option<Arc<dyn EventSink>>>,
    /// 自身的弱引用。
    ///
    /// 为什么需要它：Vault 的换/关发生在 [`AppState::set_vault`] / [`AppState::clear_vault`]，
    /// 它们只有 `&self`，而 watcher 的去抖线程要长期持有会话状态（去查条目表判断
    /// "这条事件是不是我们自己写的"）。宿主启动时（`lib.rs` 的 setup）把 `Arc` 降级成 `Weak`
    /// 存进来，换 Vault 时再 upgrade 出来。
    /// 用 `Weak` 而不是 `Arc`：监听线程不该让会话状态永远活着。
    weak_self: Mutex<Weak<AppState>>,
}

impl AppState {
    /// 带启动参数构造（`startup_vault` 必须是已校验的目录）。
    pub fn with_startup_vault(startup_vault: Option<String>) -> Self {
        Self {
            startup_vault,
            ..Self::default()
        }
    }

    /// 命令行指定的 Vault 路径（面向用户展示的绝对路径）。
    pub fn startup_vault(&self) -> Option<&str> {
        self.startup_vault.as_deref()
    }

    /// 取索引的写锁（查询反向链接时会惰性重建缓存，因此需要写权限）。
    pub fn index_write(&self) -> RwLockWriteGuard<'_, LinkIndex> {
        self.index.write().unwrap_or_else(|e| e.into_inner())
    }

    /// 索引状态快照。
    pub fn index_status_snapshot(&self) -> IndexStatus {
        *self.index_status.read().unwrap_or_else(|e| e.into_inner())
    }

    /// 更新索引状态。
    pub fn set_index_status(&self, status: IndexStatus) {
        let mut guard = self.index_status.write().unwrap_or_else(|e| e.into_inner());
        *guard = status;
    }

    /// 记录当前构建任务的取消句柄。
    pub fn set_index_cancel(&self, flag: Option<Arc<AtomicBool>>) {
        let mut guard = self.index_cancel.lock().unwrap_or_else(|e| e.into_inner());
        *guard = flag;
    }

    /// 清除取消句柄。
    pub fn clear_index_cancel(&self) {
        self.set_index_cancel(None);
    }

    /// 请求取消正在进行的索引构建（幂等）。
    pub fn cancel_index_build(&self) {
        let guard = self.index_cancel.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(flag) = guard.as_ref() {
            flag.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    }

    /// 只读访问当前 Vault；未打开时返回 `VAULT_NOT_SET`。
    pub fn with_vault<T>(&self, f: impl FnOnce(&VaultCtx) -> Result<T>) -> Result<T> {
        let guard = self.vault.read().unwrap_or_else(|e| e.into_inner());
        match guard.as_ref() {
            Some(ctx) => f(ctx),
            None => Err(Error::VaultNotSet),
        }
    }

    /// 取当前 Vault 根（克隆，可安全跨线程/跨 await）。
    pub fn vault_root(&self) -> Result<VaultRoot> {
        self.with_vault(|ctx| Ok(ctx.root.clone()))
    }

    /// 是否已打开 Vault。
    pub fn is_open(&self) -> bool {
        self.vault
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }

    /// 替换当前 Vault。
    ///
    /// **watcher 的生命周期挂在这里**：这是"当前 Vault 换了一个"的唯一入口
    /// （打开新 Vault 与重扫都会走到它），换根 = 停旧监听 + 起新监听；
    /// 同一个根（重扫）则原样保留 —— 重启监听会留下一个"事件无人接收"的窗口。
    pub fn set_vault(&self, ctx: VaultCtx) {
        let root = ctx.root.clone();
        {
            let mut guard = self.vault.write().unwrap_or_else(|e| e.into_inner());
            *guard = Some(ctx);
            // ⚠️ 必须先放锁再同步 watcher：`sync_watcher` 可能 join 去抖线程，
            // 而那个线程会去读 `vault`（`is_news`），持着写锁 join 就是自锁死。
        }
        self.sync_watcher(&root);
    }

    /// 增量更新当前 Vault。
    pub fn update_vault(&self, f: impl FnOnce(&mut VaultCtx)) {
        let mut guard = self.vault.write().unwrap_or_else(|e| e.into_inner());
        if let Some(ctx) = guard.as_mut() {
            f(ctx);
        }
    }

    /// 关闭 Vault。
    pub fn clear_vault(&self) {
        // 先停监听（它读的是"当前 Vault"的条目表），再清上下文
        self.stop_watcher();
        let mut guard = self.vault.write().unwrap_or_else(|e| e.into_inner());
        *guard = None;
    }

    // -- 外部改动监听（ADR-0016）------------------------------------------------

    /// 接线宿主运行时：事件出口 + 自身的弱引用（`lib.rs` 的 `setup` 调用一次）。
    pub fn attach_runtime(&self, sink: Arc<dyn EventSink>, weak_self: Weak<AppState>) {
        *self.sink.lock().unwrap_or_else(|e| e.into_inner()) = Some(sink);
        *self.weak_self.lock().unwrap_or_else(|e| e.into_inner()) = weak_self;
    }

    /// 当前是否正在监听外部改动（排障与测试用；界面上可见的是行为本身与日志）。
    pub fn is_watching(&self) -> bool {
        self.watcher
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }

    /// 停掉监听（幂等）。
    pub fn stop_watcher(&self) {
        let mut guard = self.watcher.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut handle) = guard.take() {
            if !handle.stop() {
                // 监听线程异常退出：监听已经不可信，但应用照常可用（手动重扫仍在）
                log::warn!("文件监听线程异常退出（外部改动将不再自动同步）");
            }
        }
    }

    /// 测试用：停掉监听并如实报告线程是否正常收尾。
    #[cfg(test)]
    pub fn stop_watcher_for_test(&self) -> bool {
        let mut guard = self.watcher.lock().unwrap_or_else(|e| e.into_inner());
        match guard.take() {
            Some(mut handle) => handle.stop(),
            None => true,
        }
    }

    /// 让监听与当前 Vault 对齐（换根就换监听，同根保持原样）。
    ///
    /// 失败一律降级：没有监听时用户仍可手动重扫（`Ctrl+Alt+R`），
    /// 绝不能因为"监听起不来"就让打开 Vault 失败。
    fn sync_watcher(&self, root: &VaultRoot) {
        let mut guard = self.watcher.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = guard.as_ref() {
            if existing.root() == root.path() {
                return;
            }
        }
        if let Some(mut old) = guard.take() {
            let clean = old.stop();
            log::debug!("已停掉旧 Vault 的文件监听（线程正常收尾：{clean}）");
        }

        let sink = self.sink.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let Some(sink) = sink else {
            // 没有事件出口（单测 / 非 Tauri 宿主）：功能优雅缺席，不报错
            log::debug!("未接线事件出口，跳过文件监听");
            return;
        };
        let Some(state) = self
            .weak_self
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .upgrade()
        else {
            log::debug!("会话状态已释放，跳过文件监听");
            return;
        };

        match crate::watcher::start(root, state, sink) {
            Ok(handle) => *guard = Some(handle),
            Err(error) => log::warn!(
                "无法监听 Vault 外部改动（{}）：外部修改需要手动重扫（Ctrl+Alt+R）",
                error
            ),
        }
    }

    /// 取写锁：保证"校验 mtime → 原子写"是临界区，避免并发写互相覆盖。
    pub fn write_guard(&self) -> MutexGuard<'_, ()> {
        self.write_lock.lock().unwrap_or_else(|e| e.into_inner())
    }

    // -- 索引构建 ---------------------------------------------------------------

    /// 取"构建互斥量"：**整个后台构建期间持有**，保证同一时刻只有一轮构建在跑。
    ///
    /// 为什么需要它：`vault_open` 可能被并发调用（dev 下 React StrictMode 会把打开跑两遍，
    /// 用户快速切换 Vault 也一样）。两轮构建同时写同一个搜索缓存库，轻则一方 `SQLITE_BUSY`
    /// 让搜索降级成"不可用"，重则互相删库/建库。
    ///
    /// 这里选择的做法是**后到的构建等前一轮退出**（而不是排队并发）：`spawn_build` 开头已经
    /// 给上一轮置了取消标记，而取消是每个文件检查一次的协作式取消，所以等待时间最多一个文件的
    /// 解析耗时。等待发生在 `spawn_blocking` 线程上，不占主线程、也不阻塞 IPC。
    pub fn build_guard(&self) -> MutexGuard<'_, ()> {
        self.build_lock.lock().unwrap_or_else(|e| e.into_inner())
    }

    // -- 全文搜索索引 -----------------------------------------------------------

    /// 用搜索索引跑一段**只读**操作；未就绪/不可用时返回 `IO` 错误（原因可显示）。
    pub fn with_search<T>(&self, f: impl FnOnce(&SearchIndex) -> Result<T>) -> Result<T> {
        let guard = self.search.lock().unwrap_or_else(|e| e.into_inner());
        f(guard.index()?)
    }

    /// 用搜索索引跑一段**写**操作；未就绪/不可用时返回 `None`。
    ///
    /// 增量更新用这个：索引还没建好时静默跳过即可（下一轮全量构建会把内容补上），
    /// 不该因为"搜索还没准备好"就让一次保存失败或者刷一堆日志。
    pub fn try_search<T>(&self, f: impl FnOnce(&SearchIndex) -> Result<T>) -> Option<Result<T>> {
        let guard = self.search.lock().unwrap_or_else(|e| e.into_inner());
        guard.index().ok().map(f)
    }

    /// 安装构建好的搜索索引（替换旧连接）。
    pub fn install_search(&self, index: SearchIndex) {
        let mut guard = self.search.lock().unwrap_or_else(|e| e.into_inner());
        *guard = SearchSlot::Ready(index);
    }

    /// 记录"搜索不可用"及其原因。
    pub fn fail_search(&self, reason: impl Into<String>) {
        let mut guard = self.search.lock().unwrap_or_else(|e| e.into_inner());
        *guard = SearchSlot::Failed(reason.into());
    }

    /// 清空搜索索引状态（关闭 Vault / 重扫前）。
    pub fn clear_search(&self) {
        let mut guard = self.search.lock().unwrap_or_else(|e| e.into_inner());
        *guard = SearchSlot::Building;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(rel: &str, is_dir: bool, ext: Option<&str>) -> EntryMeta {
        EntryMeta {
            rel_path: rel.to_string(),
            name: rel.rsplit('/').next().unwrap().to_string(),
            is_dir,
            size_bytes: 1,
            mtime_ms: Some(1),
            ext: ext.map(|s| s.to_string()),
        }
    }

    fn ctx_with(entries: Vec<EntryMeta>) -> VaultCtx {
        let options = ScanOptions::default();
        let note_count = entries.iter().filter(|e| is_note(e, &options)).count();
        let folder_count = entries.iter().filter(|e| e.is_dir).count();
        let order = entries.iter().map(|e| e.rel_path.clone()).collect();
        let map = entries
            .into_iter()
            .map(|e| (e.rel_path.clone(), e))
            .collect();
        VaultCtx {
            root: VaultRoot::open(std::env::temp_dir()).unwrap(),
            options,
            entries: map,
            order,
            note_count,
            folder_count,
            truncated: false,
            skipped: 0,
            scan_ms: 1,
        }
    }

    #[test]
    fn counts_notes_and_folders_on_upsert_and_remove() {
        let mut ctx = ctx_with(vec![
            entry("notes", true, None),
            entry("notes/a.md", false, Some("md")),
        ]);
        assert_eq!(ctx.note_count, 1);
        assert_eq!(ctx.folder_count, 1);

        ctx.upsert(entry("notes/b.md", false, Some("md")));
        assert_eq!(ctx.note_count, 2);

        // 非笔记不计入笔记数
        ctx.upsert(entry("notes/pic.png", false, Some("png")));
        assert_eq!(ctx.note_count, 2);

        // 删除目录连带后代
        ctx.remove("notes");
        assert_eq!(ctx.note_count, 0);
        assert_eq!(ctx.folder_count, 0);
        assert!(ctx.entries.is_empty());
        assert!(ctx.order.is_empty());
    }

    #[test]
    fn state_reports_vault_not_set() {
        let state = AppState::default();
        assert!(!state.is_open());
        let err = state.vault_root().unwrap_err();
        assert_eq!(err.code(), mn_core::ErrorCode::VaultNotSet);
    }

    #[test]
    fn state_open_close_cycle() {
        let state = AppState::default();
        state.set_vault(ctx_with(vec![entry("a.md", false, Some("md"))]));
        assert!(state.is_open());
        assert_eq!(
            state.vault_root().unwrap().name(),
            std::env::temp_dir().file_name().unwrap().to_string_lossy()
        );

        state.update_vault(|ctx| ctx.upsert(entry("b.md", false, Some("md"))));
        assert_eq!(state.with_vault(|c| Ok(c.note_count)).unwrap(), 2);

        state.clear_vault();
        assert!(!state.is_open());
    }

    #[test]
    fn write_guard_serializes_sections() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let state = Arc::new(AppState::default());
        let inside = Arc::new(AtomicUsize::new(0));
        let max_seen = Arc::new(AtomicUsize::new(0));

        let mut handles = Vec::new();
        for _ in 0..8 {
            let state = Arc::clone(&state);
            let inside = Arc::clone(&inside);
            let max_seen = Arc::clone(&max_seen);
            handles.push(std::thread::spawn(move || {
                for _ in 0..50 {
                    let _guard = state.write_guard();
                    let now = inside.fetch_add(1, Ordering::SeqCst) + 1;
                    max_seen.fetch_max(now, Ordering::SeqCst);
                    std::thread::yield_now();
                    inside.fetch_sub(1, Ordering::SeqCst);
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(max_seen.load(Ordering::SeqCst), 1, "写临界区不可并发进入");
    }

    #[test]
    fn build_guard_serializes_whole_builds() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let state = Arc::new(AppState::default());
        let inside = Arc::new(AtomicUsize::new(0));
        let max_seen = Arc::new(AtomicUsize::new(0));

        let mut handles = Vec::new();
        for _ in 0..4 {
            let state = Arc::clone(&state);
            let inside = Arc::clone(&inside);
            let max_seen = Arc::clone(&max_seen);
            handles.push(std::thread::spawn(move || {
                for _ in 0..20 {
                    let _guard = state.build_guard();
                    let now = inside.fetch_add(1, Ordering::SeqCst) + 1;
                    max_seen.fetch_max(now, Ordering::SeqCst);
                    std::thread::yield_now();
                    inside.fetch_sub(1, Ordering::SeqCst);
                }
            }));
        }
        for handle in handles {
            handle.join().unwrap();
        }
        assert_eq!(
            max_seen.load(Ordering::SeqCst),
            1,
            "两轮构建不能同时在跑（会同时写同一个搜索缓存库）"
        );
    }

    #[test]
    fn startup_vault_is_exposed_only_when_provided() {
        let state = AppState::default();
        assert_eq!(state.startup_vault(), None);

        let state = AppState::with_startup_vault(Some("C:/vault".to_string()));
        assert_eq!(state.startup_vault(), Some("C:/vault"));
        // 启动参数不等于"已打开 Vault"
        assert!(!state.is_open());
    }

    #[test]
    fn the_watcher_needs_an_event_sink_and_degrades_without_one() {
        // 单测（以及任何没有 Tauri 事件出口的宿主）在 `set_vault` 时不该去起监听：
        // 功能优雅缺席，而不是报错 —— 手动重扫那条路始终有效。
        let state = AppState::default();
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        let report = mn_core::scanner::scan(root.path(), &ScanOptions::default()).unwrap();

        state.set_vault(VaultCtx::new(root, ScanOptions::default(), report));
        assert!(!state.is_watching(), "没有事件出口时不启动监听");

        // 关库是幂等的：没有监听时也不该 panic
        state.clear_vault();
        state.clear_vault();
        assert!(!state.is_watching());
    }
}
