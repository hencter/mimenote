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
use std::sync::{Mutex, MutexGuard, RwLock};

use mn_core::scanner::{EntryMeta, ScanOptions, ScanReport};
use mn_core::{Error, Result, VaultRoot};

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
}

impl AppState {
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
    pub fn set_vault(&self, ctx: VaultCtx) {
        let mut guard = self.vault.write().unwrap_or_else(|e| e.into_inner());
        *guard = Some(ctx);
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
        let mut guard = self.vault.write().unwrap_or_else(|e| e.into_inner());
        *guard = None;
    }

    /// 取写锁：保证"校验 mtime → 原子写"是临界区，避免并发写互相覆盖。
    pub fn write_guard(&self) -> MutexGuard<'_, ()> {
        self.write_lock.lock().unwrap_or_else(|e| e.into_inner())
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
}
