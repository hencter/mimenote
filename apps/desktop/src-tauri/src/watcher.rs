//! Vault 外部改动监听（ADR-0016）。
//!
//! Windows 上 `notify` 走 `ReadDirectoryChangesW`，事件由内核推给我们。这一层只做四件事：
//!
//! 1. **判断"这条事件是不是新闻"**：磁盘上的状态与**条目表**（宿主对磁盘的认知）不一致才算。
//!    这一条同时解决了"自己写的文件不能被当成外部改动"—— 保存/新建/改名之后条目表立刻被更新，
//!    于是随后到达的、我们自己引起的事件在条目表里对得上，直接被丢掉（见 [`is_news`]）；
//! 2. **去抖 + 合并**（[`Debouncer`]）：同步盘一次落几百个文件是常态，绝不能变成几百次重扫；
//! 3. **忽略噪声**：`.mimenote/` 内部（缓存库每轮构建都在写）、原子写的临时文件、
//!    扫描器本来就跳过的路径（`.git`/`node_modules`/隐藏项……）；
//! 4. **生命周期**：句柄与去抖线程都挂在 [`WatcherHandle`] 上，换 Vault / 关闭 Vault 时
//!    随 `AppState::set_vault` / `clear_vault` 一起停掉（副作用可逆）。
//!
//! 刻意**不在这里**重扫目录、也不碰索引：宿主只负责"发现了外部改动"这一件事，
//! 重扫与索引重建走既有的 `vault_snapshot` → `indexer::spawn_build`（后台、可取消）。
//! 这样"外部改动"与用户按重扫走的是同一条链路，不存在第二套扫描口径。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use notify::{Event, EventKind, RecursiveMode, Watcher};
use serde::Serialize;

use mn_core::scanner::ScanOptions;
use mn_core::VaultRoot;

use crate::state::AppState;

/// 外部改动事件名（前端监听；与 `mn://index-status` 同一风格）。
pub const VAULT_CHANGED_EVENT: &str = "mn://vault-changed";

/// 静默期：最后一次事件之后安静这么久才刷新。
///
/// 取 500ms 是一个折中：比人类的"手工改一个文件"慢不了多少（不会有可感的延迟），
/// 又足以把"同步盘一次落几百个文件"压成一次。抖动大的网络盘仍可能超时被切开，
/// 但 [`MAX_WAIT_MS`] 之后的重扫会把剩下的部分补齐（重扫本身是幂等的）。
pub const QUIET_MS: u64 = 500;

/// 硬上限：风暴不停时也不能无限推迟刷新（连续写入超过它就先把已攒下的一批发出去）。
pub const MAX_WAIT_MS: u64 = 2_000;

/// 一次事件里最多带多少条相对路径（超出的只计数）。
///
/// 上限的作用是给 IPC 报文一个硬边界：1 万文件的同步风暴若把 1 万条路径塞进 JSON，
/// 报文是几百 KB 级别，而接收方（前端）其实并不需要它们 —— 它只要知道"现在该重扫了"，
/// 并用重扫回来的 mtime 判断当前笔记是否要重载。
pub const MAX_PATHS: usize = 256;

/// 去抖线程最长睡这么久就醒来查一次停止标记（保证 `stop()` 的等待有界）。
const THREAD_TICK_MS: u64 = 50;

/// 会话内一律忽略的目录（缓存库、回收站、片段都在里面）。
const INTERNAL_DIR: &str = ".mimenote";

/// 推给前端的事件载荷（`src/state/vault-store.ts` 手工镜像，字段名不可偏离）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultChanged {
    /// 这一次合并里**被判为新闻**的相对路径（字典序，最多 [`MAX_PATHS`] 条）。
    pub paths: Vec<String>,
    /// 是否有路径因为 [`MAX_PATHS`] 被截掉。
    pub truncated: bool,
    /// 去抖窗口里一共收到多少条事件路径（含重复，含后来被判为"不是新闻"的部分）。
    pub changes: usize,
    /// 判定时刻（毫秒时间戳）。
    pub detected_at_ms: u64,
}

/// 事件出口。
///
/// 抽成 trait 是为了让宿主的两条真实路径都能测：生产环境是 [`TauriSink`]（推给前端），
/// 测试里是一个把载荷塞进 channel 的回调 —— watcher 本身不知道 Tauri 的存在。
pub trait EventSink: Send + Sync {
    fn emit(&self, payload: VaultChanged);
}

impl<F> EventSink for F
where
    F: Fn(VaultChanged) + Send + Sync,
{
    fn emit(&self, payload: VaultChanged) {
        (self)(payload);
    }
}

/// 生产环境的出口：把事件交给 Tauri 推给前端。
pub struct TauriSink(tauri::AppHandle);

impl TauriSink {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self(app)
    }
}

impl EventSink for TauriSink {
    fn emit(&self, payload: VaultChanged) {
        use tauri::Emitter;
        // 事件只是"通知"，发不出去不影响监听本身（窗口关了就没人接，属正常）
        if let Err(error) = self.0.emit(VAULT_CHANGED_EVENT, payload) {
            log::debug!("外部改动事件发送失败：{error}");
        }
    }
}

// ---------------------------------------------------------------------------
// 路径判定（纯函数，可单测）
// ---------------------------------------------------------------------------

/// 把绝对路径归一化成"正斜杠、无 `\\?\` 前缀、无尾斜杠"的形式。
fn normalize(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/");
    // canonicalize 在 Windows 上会加上扩展长度前缀（`\\?\D:\…`）—— 那是"同一路径的另一种写法"，
    // 而 notify 回传的路径是否带它取决于后端与入参，因此两边都先削掉再比。
    let trimmed = match raw.strip_prefix("//?/") {
        Some(rest) => rest,
        None => raw.as_str(),
    };
    trimmed.trim_end_matches('/').to_string()
}

/// 绝对路径 → Vault 相对路径（POSIX 风格）。
///
/// 不用 `strip_prefix`：Windows 路径不区分大小写，而 canonicalize 拿到的根与事件里的路径
/// 可能在盘符大小写、`\\?\` 前缀上不一致；比较必须是 ASCII 大小写不敏感的前缀比较。
/// 返回 `None` 表示"不在这个 Vault 里"（含 Vault 根自身，条目表里没有它）。
pub fn rel_of(root: &Path, path: &Path) -> Option<String> {
    let root = normalize(root);
    let full = normalize(path);
    if root.is_empty() || full.len() <= root.len() {
        return None;
    }
    if !full.as_bytes()[..root.len()].eq_ignore_ascii_case(root.as_bytes()) {
        return None;
    }
    let rest = full[root.len()..].strip_prefix('/')?;
    let rest = rest.trim_end_matches('/');
    if rest.is_empty() {
        return None;
    }
    Some(rest.to_string())
}

/// 名字是否被扫描器忽略（不区分大小写列表）。
fn is_ignored(name: &str, list: &[String]) -> bool {
    list.iter().any(|item| item.eq_ignore_ascii_case(name))
}

/// 扫描器**根本不会收录**的路径（用它自己的口径判断）。
///
/// 为什么值得单独判一次：`.git` 里一次 `git fetch`、`node_modules` 里一次 `pnpm install`
/// 都是成百上千次写。这些路径永远进不了条目表，也永远不该触发重扫 —— 不在这里挡掉，
/// 去抖只能把它们合并成"一次"重扫，而不是"零次"。
fn scanner_would_skip(options: &ScanOptions, rel: &str, is_dir: bool) -> bool {
    let segments: Vec<&str> = rel.split('/').collect();
    let (dirs, last) = segments.split_at(segments.len() - 1);
    let hidden = |name: &str| !options.include_hidden && name.starts_with('.');
    if dirs
        .iter()
        .any(|name| hidden(name) || is_ignored(name, &options.ignore_dir_names))
    {
        return true;
    }
    let name = last.first().copied().unwrap_or(rel);
    if hidden(name) {
        return true;
    }
    if is_dir {
        return is_ignored(name, &options.ignore_dir_names);
    }
    is_ignored(name, &options.ignore_file_names)
}

/// 便宜且与状态无关的过滤（跑在 notify 的回调线程上，不能碰锁）。
fn is_cheap_ignored(rel: &str) -> bool {
    let first = rel.split('/').next().unwrap_or(rel);
    if first.eq_ignore_ascii_case(INTERNAL_DIR) {
        return true;
    }
    // 原子写的临时文件（`mn_core::atomic::TEMP_PREFIX` = `.mimenote-`）：
    // 每一次保存/新建/附件落盘都会在**同目录**先写一个 `.mimenote-xxxx.tmp` 再 rename。
    // 它是纯实现细节，不该被任何人看见 —— 更不该变成一次重扫。
    let name = rel.rsplit('/').next().unwrap_or(rel);
    name.starts_with(mn_core::atomic::TEMP_PREFIX)
}

/// 磁盘上的状态与条目表不一致 = "这条事件是新闻"（磁盘上真的变了，而宿主还不知道）。
///
/// 这是**排除自己写入**的核心信号：宿主每一次成功写入都会立刻更新条目表
/// （`note_write` / `note_create` / 改名 / 搬迁 / 附件落盘都走 `VaultCtx::upsert`），
/// 于是我们自己引起的事件在条目表里 `(mtime, size)` 对得上 → 丢掉。
/// 反过来，别人改了同一个文件 → mtime/size 不同 → 保留。
///
/// 已知边界（与 ADR-0004 同一取舍）：同一毫秒内写入且字节数完全相同的外部改动会被漏判。
fn is_news(state: &AppState, rel: &str) -> bool {
    // 条目表是"打开 Vault 时扫一次 + 之后增量更新"的快照，所以这里取的是会话认知
    let Ok((root, options, entry)) = state.with_vault(|ctx| {
        Ok((
            ctx.root.path().to_path_buf(),
            ctx.options.clone(),
            ctx.entries.get(rel).cloned(),
        ))
    }) else {
        // 没有打开的 Vault（关闭过程中的残留事件）：不上报
        return false;
    };

    let meta = std::fs::metadata(root.join(rel));
    let is_dir = match meta.as_ref() {
        Ok(meta) => meta.is_dir(),
        // 读不到就当它不存在（正在被改名/删除的文件经常这样）
        Err(_) => false,
    };
    if scanner_would_skip(&options, rel, is_dir) {
        return false;
    }

    match (entry, meta) {
        // 宿主知道自己写过它：磁盘与认知一致 → 是我们自己写的
        (Some(entry), Ok(meta)) => {
            if entry.is_dir != meta.is_dir() {
                return true;
            }
            if entry.is_dir {
                return false;
            }
            entry.mtime_ms != mn_core::atomic::mtime_ms(&meta) || entry.size_bytes != meta.len()
        }
        // 条目表里有、磁盘上却读不到 → 认知不可靠了（外部删除最常见），按新闻处理
        (Some(_), Err(_)) => true,
        // 条目表里没有、磁盘上有 → 外部新增
        (None, Ok(_)) => true,
        // 两边都没有 → 不是新闻（例如我们自己刚刚搬走/删掉的路径）
        (None, Err(_)) => false,
    }
}

// ---------------------------------------------------------------------------
// 去抖 + 合并（纯逻辑：时钟由调用方注入，因此可以确定性地单测）
// ---------------------------------------------------------------------------

/// 去抖器：把"一阵子的路径"合并成一次刷新。
///
/// 两条规则：
/// * **静默期**（[`Debouncer::new`] 的 `quiet_ms`）：最后一次事件之后安静这么久就到期；
/// * **硬上限**（`max_wait_ms`）：从第一条事件算起最多等这么久 —— 否则持续不断的小改动
///   （大文件正在被另一个程序慢慢写）会让刷新永远推迟下去。
#[derive(Debug)]
pub struct Debouncer {
    quiet_ms: u64,
    max_wait_ms: u64,
    paths: BTreeSet<String>,
    changes: usize,
    truncated: bool,
    first_at_ms: u64,
    last_at_ms: u64,
}

impl Debouncer {
    pub fn new(quiet_ms: u64, max_wait_ms: u64) -> Self {
        Self {
            quiet_ms,
            max_wait_ms,
            paths: BTreeSet::new(),
            changes: 0,
            truncated: false,
            first_at_ms: 0,
            last_at_ms: 0,
        }
    }

    /// 记一条事件路径。
    pub fn push(&mut self, rel: impl Into<String>, now_ms: u64) {
        if self.changes == 0 {
            self.first_at_ms = now_ms;
        }
        self.changes += 1;
        self.last_at_ms = now_ms;
        let rel = rel.into();
        if self.paths.len() < MAX_PATHS {
            self.paths.insert(rel);
        } else if !self.paths.contains(&rel) {
            // 路径集合有硬上限：报文不能因为一次风暴而变成几百 KB
            self.truncated = true;
        }
    }

    /// 还有没有攒着没发的内容。
    pub fn is_idle(&self) -> bool {
        self.changes == 0
    }

    /// 下一次必须醒来的时刻（`None` = 没事可等）。
    pub fn deadline_ms(&self) -> Option<u64> {
        if self.is_idle() {
            return None;
        }
        Some(self.last_at_ms.saturating_add(self.quiet_ms))
    }

    /// 到点了就取走这一轮（`None` = 还没到）。
    pub fn take_if_due(&mut self, now_ms: u64) -> Option<VaultChanged> {
        if self.is_idle() {
            return None;
        }
        let quiet_done = now_ms >= self.last_at_ms.saturating_add(self.quiet_ms);
        let waited_too_long = now_ms >= self.first_at_ms.saturating_add(self.max_wait_ms);
        if !quiet_done && !waited_too_long {
            return None;
        }
        self.take(now_ms)
    }

    /// 不管到没到点都取走（停止前冲刷用）。
    pub fn take(&mut self, now_ms: u64) -> Option<VaultChanged> {
        if self.is_idle() {
            return None;
        }
        let payload = VaultChanged {
            paths: std::mem::take(&mut self.paths).into_iter().collect(),
            truncated: self.truncated,
            changes: self.changes,
            detected_at_ms: now_ms,
        };
        self.paths = BTreeSet::new();
        self.changes = 0;
        self.truncated = false;
        Some(payload)
    }
}

/// 把一轮攒下的路径按"是不是新闻"过一遍；一条都不剩就返回 `None`（不打扰前端）。
///
/// 判定放在**刷新时**而不是事件到达时：宿主的写入是"先落盘、再更新条目表"，
/// 若在事件到达的瞬间判定，就可能与那次 `VaultCtx::upsert` 撞在一起，
/// 把一次保存误判成外部改动。
fn keep_news(state: &AppState, pending: VaultChanged) -> Option<VaultChanged> {
    let paths: Vec<String> = pending
        .paths
        .into_iter()
        .filter(|rel| is_news(state, rel))
        .collect();
    if paths.is_empty() {
        return None;
    }
    Some(VaultChanged { paths, ..pending })
}

// ---------------------------------------------------------------------------
// 监听句柄
// ---------------------------------------------------------------------------

/// 一个正在运行的监听：OS 句柄 + 去抖线程。
pub struct WatcherHandle {
    root: PathBuf,
    stop: Arc<AtomicBool>,
    /// **持有它就是持有 OS 句柄**；置 `None` = 放开监听（notify 的线程随之退出）。
    watcher: Option<notify::RecommendedWatcher>,
    thread: Option<JoinHandle<()>>,
}

impl WatcherHandle {
    /// 正在监听的 Vault 根。
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 停掉监听（幂等）：置停止标记 → 放开 OS 句柄 → 等去抖线程退出。
    ///
    /// 返回 `false` 表示线程是**异常退出**的（panic），调用方记一条日志即可 ——
    /// 监听线程里的任何 panic 都不该把宿主一起带走，但也不能被静悄悄地咽掉。
    ///
    /// 调用方**绝不能**在持有 `AppState::vault` 写锁时调用它：去抖线程可能正卡在
    /// `is_news` 的读锁上，而这里会 join 它（自锁死）。
    pub fn stop(&mut self) -> bool {
        self.stop.store(true, Ordering::Relaxed);
        self.watcher = None;
        match self.thread.take() {
            Some(thread) => thread.join().is_ok(),
            None => true,
        }
    }
}

impl Drop for WatcherHandle {
    fn drop(&mut self) {
        // 副作用必须可逆：句柄被丢掉时监听一定跟着停（架构 §2 规则 6）
        let _ = self.stop();
    }
}

/// 启动监听（失败时返回错误，由调用方降级：没有监听仍然能手动重扫）。
pub fn start(
    root: &VaultRoot,
    state: Arc<AppState>,
    sink: Arc<dyn EventSink>,
) -> notify::Result<WatcherHandle> {
    let (tx, rx) = mpsc::channel::<String>();
    let stop = Arc::new(AtomicBool::new(false));

    let filter_root = root.path().to_path_buf();
    let callback_stop = Arc::clone(&stop);
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
        let event = match event {
            Ok(event) => event,
            Err(error) => {
                // 监听错误（目录被删掉、网络盘断开、句柄耗尽……）绝不能 panic：
                // 记一条日志、忽略这一次，下一次事件照常处理
                log::debug!("文件监听错误（忽略）：{error}");
                return;
            }
        };
        if callback_stop.load(Ordering::Relaxed) {
            return;
        }
        // 读文件不是改动。少了这一条，重扫自己（读全库文件）就会触发下一轮重扫 —— 死循环。
        if matches!(event.kind, EventKind::Access(_)) {
            return;
        }
        for path in &event.paths {
            if let Some(rel) = rel_of(&filter_root, path) {
                if !is_cheap_ignored(&rel) {
                    let _ = tx.send(rel);
                }
            }
        }
    })?;

    watcher.watch(root.path(), RecursiveMode::Recursive)?;

    let thread_stop = Arc::clone(&stop);
    let thread = std::thread::Builder::new()
        .name("mn-vault-watch".to_string())
        .spawn(move || {
            let stop = thread_stop;
            let mut debouncer = Debouncer::new(QUIET_MS, MAX_WAIT_MS);
            loop {
                if stop.load(Ordering::Relaxed) {
                    return;
                }
                let now = now_ms();
                // 有内容可等就等到该刷新的那一刻，否则睡一小觉（好让停止标记及时生效）
                let wait = debouncer
                    .deadline_ms()
                    .map(|deadline| deadline.saturating_sub(now))
                    .unwrap_or(THREAD_TICK_MS)
                    .min(THREAD_TICK_MS);
                match rx.recv_timeout(Duration::from_millis(wait)) {
                    Ok(rel) => debouncer.push(rel, now_ms()),
                    Err(RecvTimeoutError::Timeout) => {
                        let Some(pending) = debouncer.take_if_due(now_ms()) else {
                            continue;
                        };
                        flush(&state, sink.as_ref(), pending, &stop);
                    }
                    // 句柄被放开（停止/换 Vault）→ 去抖线程收工
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
        })?;

    log::info!(
        "已开始监听 Vault 外部改动：{}（静默期 {}ms，硬上限 {}ms）",
        root.display(),
        QUIET_MS,
        MAX_WAIT_MS
    );

    Ok(WatcherHandle {
        root: root.path().to_path_buf(),
        stop,
        watcher: Some(watcher),
        thread: Some(thread),
    })
}

fn flush(state: &AppState, sink: &dyn EventSink, pending: VaultChanged, stop: &AtomicBool) {
    let Some(payload) = keep_news(state, pending) else {
        return;
    };
    if stop.load(Ordering::Relaxed) {
        return;
    }
    log::info!(
        "检测到外部改动：{} 条路径（上报 {} 条{}）",
        payload.changes,
        payload.paths.len(),
        if payload.truncated {
            "，已截断"
        } else {
            ""
        }
    );
    sink.emit(payload);
}

fn now_ms() -> u64 {
    mn_core::atomic::now_ms()
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::mpsc::Receiver;

    use mn_core::atomic::write_atomic;
    use mn_core::scanner::{scan, EntryMeta};

    use crate::state::VaultCtx;

    // -- 采集器：把宿主推出的事件收进 channel（测试用的 EventSink） --------------

    fn sink_with_channel() -> (Arc<dyn EventSink>, Receiver<VaultChanged>) {
        let (tx, rx) = mpsc::channel();
        let sink: Arc<dyn EventSink> = Arc::new(move |payload: VaultChanged| {
            let _ = tx.send(payload);
        });
        (sink, rx)
    }

    /// 打开一个真实临时目录作为 Vault（走 `set_vault`，因此 watcher 会被真的启动 ——
    /// 前提是调用方已经 `attach_runtime`）。
    fn open_vault(state: &Arc<AppState>, root: &VaultRoot) {
        let options = ScanOptions::default();
        let report = scan(root.path(), &options).expect("扫描临时 Vault");
        state.set_vault(VaultCtx::new(root.clone(), options, report));
    }

    /// 等一个满足条件的事件。
    ///
    /// **确定性做法**：轮询 + 足够长的超时，而不是"睡固定时长再看一眼"。
    /// 文件系统事件是内核异步投递的，固定 sleep 在慢机器上一定会偶发失败。
    fn wait_for_event(
        rx: &Receiver<VaultChanged>,
        timeout_ms: u64,
        predicate: impl Fn(&VaultChanged) -> bool,
    ) -> Option<VaultChanged> {
        let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
        while std::time::Instant::now() < deadline {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            match rx.recv_timeout(left.min(Duration::from_millis(200))) {
                Ok(payload) => {
                    if predicate(&payload) {
                        return Some(payload);
                    }
                }
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => return None,
            }
        }
        None
    }

    /// 断言"接下来这段时间内没有事件"。
    ///
    /// ⚠️ 这条断言只在**同一用例里先证过监听活着**之后才有意义（否则"监听没启动"会伪装成通过）。
    /// 因此所有用到它的用例都先做一次正例（外部写 → 必须收到事件）。
    fn expect_no_event(rx: &Receiver<VaultChanged>, quiet_ms: u64) {
        // 静默期 + 一点余量：去抖窗口还没走完时断言"没有事件"是没有意义的
        if let Ok(payload) = rx.recv_timeout(Duration::from_millis(QUIET_MS + quiet_ms)) {
            panic!("不该有事件，却收到了：{payload:?}");
        }
    }

    /// 模拟宿主的写入路径：原子写 + **立刻更新条目表**（`commands::note_write` 的同一顺序）。
    fn write_like_host(state: &Arc<AppState>, root: &VaultRoot, rel: &str, text: &str) {
        let path = root.path().join(rel);
        write_atomic(&path, text.as_bytes()).expect("原子写");
        let meta = std::fs::metadata(&path).expect("读回元数据");
        let entry = EntryMeta {
            rel_path: rel.to_string(),
            name: rel.rsplit('/').next().unwrap_or(rel).to_string(),
            is_dir: false,
            size_bytes: meta.len(),
            mtime_ms: mn_core::atomic::mtime_ms(&meta),
            ext: Some("md".to_string()),
        };
        state.update_vault(|ctx| ctx.upsert(entry));
    }

    // -- 纯逻辑：路径换算 --------------------------------------------------------

    #[test]
    fn rel_of_handles_windows_path_shapes() {
        let root = Path::new(r"\\?\D:\笔记\Vault");
        assert_eq!(
            rel_of(root, Path::new(r"D:\笔记\Vault\子\甲.md")).as_deref(),
            Some("子/甲.md"),
            "扩展长度前缀与大小写都不该影响换算"
        );
        assert_eq!(
            rel_of(Path::new(r"D:\Vault"), Path::new(r"d:\vault\甲.md")).as_deref(),
            Some("甲.md"),
            "Windows 路径大小写不敏感"
        );
        // Vault 根自身：条目表里没有它，也就没什么可判断的
        assert_eq!(rel_of(root, Path::new(r"D:\笔记\Vault")), None);
        assert_eq!(rel_of(root, Path::new(r"D:\笔记\Vault\")), None);
        // 段边界：`Vault2` 以 `Vault` 开头，但它不是 `Vault` 里的东西
        assert_eq!(
            rel_of(Path::new(r"D:\Vault"), Path::new(r"D:\Vault2\甲.md")),
            None
        );
        assert_eq!(rel_of(root, Path::new(r"C:\别的\甲.md")), None);
    }

    #[test]
    fn cheap_filters_drop_internal_dir_and_atomic_temp_files() {
        assert!(is_cheap_ignored(".mimenote/cache/search.db"));
        assert!(is_cheap_ignored(".mimenote/trash/甲.md"));
        assert!(
            is_cheap_ignored(".MIMENOTE/cache/search.db"),
            "大小写不敏感"
        );
        assert!(
            is_cheap_ignored("笔记/.mimenote-abc123.tmp"),
            "原子写的临时文件必须被忽略（否则每次保存都要重扫）"
        );
        assert!(!is_cheap_ignored("笔记/甲.md"));
        assert!(
            !is_cheap_ignored("mimenote/甲.md"),
            "只是名字像，不是内部目录"
        );
    }

    #[test]
    fn scanner_skip_rules_mirror_the_scan_options() {
        let options = ScanOptions::default();
        assert!(scanner_would_skip(
            &options,
            "node_modules/foo/index.js",
            false
        ));
        assert!(scanner_would_skip(&options, ".git/HEAD", false));
        assert!(
            scanner_would_skip(&options, "子/.git/HEAD", false),
            "层级里任意一段都算"
        );
        assert!(scanner_would_skip(&options, "node_modules", true));
        assert!(scanner_would_skip(&options, "笔记/.隐藏.md", false));
        assert!(scanner_would_skip(&options, "笔记/Thumbs.db", false));
        assert!(!scanner_would_skip(&options, "笔记/甲.md", false));
        assert!(!scanner_would_skip(&options, "笔记/子/甲.md", false));
    }

    // -- 纯逻辑：去抖与合并 ------------------------------------------------------

    #[test]
    fn debounce_waits_for_the_quiet_period() {
        let mut debouncer = Debouncer::new(500, 2_000);
        assert!(debouncer.is_idle());
        assert_eq!(debouncer.deadline_ms(), None);
        assert_eq!(debouncer.take_if_due(1_000), None);

        debouncer.push("甲.md", 1_000);
        assert_eq!(debouncer.deadline_ms(), Some(1_500));
        assert_eq!(debouncer.take_if_due(1_499), None, "静默期没走完不刷新");
        let payload = debouncer.take_if_due(1_500).expect("到点刷新");
        assert_eq!(payload.paths, vec!["甲.md".to_string()]);
        assert_eq!(payload.changes, 1);
        assert!(!payload.truncated);
        assert!(debouncer.is_idle(), "取走之后必须清空");
    }

    #[test]
    fn a_storm_of_writes_becomes_exactly_one_refresh() {
        // 同步盘一次落 300 个文件：**必须**合并成一次，而不是 300 次重扫
        let mut debouncer = Debouncer::new(500, 2_000);
        for index in 0..300 {
            debouncer.push(format!("同步/{index:03}.md"), 1_000 + index as u64);
        }
        // 最后一条在 1299ms，静默期到 1799ms 才算完
        assert_eq!(debouncer.take_if_due(1_700), None);
        let payload = debouncer.take_if_due(1_799).expect("风暴合并成一次");
        assert_eq!(payload.changes, 300, "条数如实报告");
        assert_eq!(payload.paths.len(), MAX_PATHS, "路径集合有硬上限");
        assert!(payload.truncated);
        assert!(debouncer.is_idle());
        assert_eq!(debouncer.take(2_000), None);
    }

    #[test]
    fn repeated_paths_are_deduplicated() {
        let mut debouncer = Debouncer::new(100, 1_000);
        for _ in 0..5 {
            debouncer.push("甲.md", 10);
        }
        let payload = debouncer.take(200).unwrap();
        assert_eq!(payload.paths, vec!["甲.md".to_string()], "同一路径只留一份");
        assert_eq!(payload.changes, 5);
        assert!(!payload.truncated, "重复不算截断");
    }

    #[test]
    fn a_never_ending_stream_still_flushes_at_the_hard_cap() {
        // 大文件正在被另一个程序慢慢写：事件一直不停，绝不能无限推迟刷新
        let mut debouncer = Debouncer::new(500, 2_000);
        for step in 0..40 {
            let now = 1_000 + step * 100;
            debouncer.push("大文件.md", now);
            if let Some(payload) = debouncer.take_if_due(now) {
                assert!(now >= 3_000, "硬上限之前不该刷新（实际 {now}）");
                assert_eq!(payload.paths, vec!["大文件.md".to_string()]);
                return;
            }
        }
        panic!("一直有事件时必须被硬上限截断，而不是永远等下去");
    }

    // -- 真实 watcher：临时目录 + 真事件 ----------------------------------------

    /// 「是不是新闻」的全部规则（纯逻辑，不依赖任何时间）：
    /// 磁盘状态与条目表一致 → 不是；不一致 → 是。
    #[test]
    fn is_news_compares_disk_against_the_entry_table() {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        std::fs::write(root.path().join("甲.md"), "# 甲\n").unwrap();
        std::fs::write(root.path().join("乙.md"), "# 乙\n").unwrap();

        let state = Arc::new(AppState::default());
        // 没有打开的 Vault（关闭过程中的残留事件）：一律不上报
        assert!(!is_news(&state, "甲.md"));

        open_vault(&state, &root);
        assert!(!is_news(&state, "甲.md"), "与条目表一致 → 不是新闻");
        assert!(!is_news(&state, "幻影.md"), "两边都没有 → 不是新闻");
        // 外部新增：磁盘上有、条目表里没有
        std::fs::write(root.path().join("外部新建.md"), "# 外部\n").unwrap();
        assert!(is_news(&state, "外部新建.md"), "外部新增 → 是新闻");

        // 宿主自己的写入（原子写 + 条目表更新）→ 不是新闻
        write_like_host(&state, &root, "甲.md", "# 我自己写的\n");
        assert!(!is_news(&state, "甲.md"), "自己写的 → 不是新闻");
        assert!(
            !is_news(&state, "甲.md"),
            "再问一次答案必须一样（判定不能有副作用）"
        );

        // 外部改写 → 是新闻（这里字节数不同，不依赖 mtime 的毫秒粒度）
        std::fs::write(root.path().join("甲.md"), "# 别人写的，更长一些\n").unwrap();
        assert!(is_news(&state, "甲.md"), "外部改写 → 是新闻");

        // 外部删除 → 是新闻
        std::fs::remove_file(root.path().join("乙.md")).unwrap();
        assert!(is_news(&state, "乙.md"), "外部删除 → 是新闻");

        // 噪声：`.mimenote/` 内部、原子写的临时文件、扫描器本来就跳过的路径 ——
        // 即使磁盘上真的存在，也不该触发重扫（重扫也看不见它们）
        let cache = root.path().join(".mimenote/cache/search.db");
        std::fs::create_dir_all(cache.parent().unwrap()).unwrap();
        std::fs::write(&cache, b"cache-db").unwrap();
        assert!(!is_news(&state, ".mimenote/cache/search.db"));
        std::fs::create_dir_all(root.path().join("node_modules/pkg")).unwrap();
        std::fs::write(root.path().join("node_modules/pkg/index.js"), b"x").unwrap();
        assert!(!is_news(&state, "node_modules/pkg/index.js"));
        std::fs::write(root.path().join("Thumbs.db"), b"x").unwrap();
        assert!(!is_news(&state, "Thumbs.db"));
        std::fs::write(root.path().join(".mimenote-abc123.tmp"), b"x").unwrap();
        assert!(!is_news(&state, ".mimenote-abc123.tmp"), "原子写的临时文件");
    }

    #[test]
    fn external_writes_are_reported() {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        std::fs::write(root.path().join("甲.md"), "# 甲\n").unwrap();

        let state = Arc::new(AppState::default());
        let (sink, rx) = sink_with_channel();
        state.attach_runtime(sink, Arc::downgrade(&state));
        open_vault(&state, &root);

        // 外部新增一个文件 → 必须上报
        std::fs::write(root.path().join("外部新建.md"), "# 外部\n").unwrap();
        let payload = wait_for_event(&rx, 10_000, |payload| {
            payload.paths.iter().any(|rel| rel == "外部新建.md")
        })
        .expect("外部新增必须被上报");
        assert!(payload.changes >= 1);

        // 外部修改已收录的笔记 → 也必须上报（内容长度不同，不依赖 mtime 的毫秒粒度）
        std::fs::write(root.path().join("甲.md"), "# 甲被外面改过了\n").unwrap();
        wait_for_event(&rx, 10_000, |payload| {
            payload.paths.iter().any(|rel| rel == "甲.md")
        })
        .expect("外部修改必须被上报");

        state.clear_vault();
    }

    #[test]
    fn our_own_atomic_write_is_not_an_external_change() {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        std::fs::write(root.path().join("甲.md"), "# 甲\n").unwrap();

        let state = Arc::new(AppState::default());
        let (sink, rx) = sink_with_channel();
        state.attach_runtime(sink, Arc::downgrade(&state));
        open_vault(&state, &root);

        // ① 先证明监听是活的（否则下面的"没有事件"是假通过）
        std::fs::write(root.path().join("甲.md"), "# 外面的改动（更长一些）\n").unwrap();
        wait_for_event(&rx, 10_000, |payload| {
            payload.paths.iter().any(|rel| rel == "甲.md")
        })
        .expect("先证监听活着");
        // 让这一轮彻底走完（去抖窗口 + 上报），后面的断言才只反映"我们自己写的"
        expect_no_event(&rx, 300);

        // ② 走宿主的写入路径：原子写 + 更新条目表。事件（临时文件 + rename 到目标）
        //    必须一个都不上报 —— 否则用户每保存一次都会看到一次重扫
        write_like_host(&state, &root, "甲.md", "# 我自己写的\n");
        expect_no_event(&rx, 1_500);

        // ③ 反例：外部再改一次（字节数不同）→ 必须重新上报。
        //    这一条同时说明 ② 的"安静"来自条目表对账，而不是监听坏了。
        std::fs::write(root.path().join("甲.md"), "# 外面又改了一次，更长\n").unwrap();
        wait_for_event(&rx, 10_000, |payload| {
            payload.paths.iter().any(|rel| rel == "甲.md")
        })
        .expect("外部改动必须仍然被上报");

        state.clear_vault();
    }

    #[test]
    fn the_internal_dir_is_never_reported() {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        std::fs::write(root.path().join("甲.md"), "# 甲\n").unwrap();
        std::fs::create_dir_all(root.path().join(".mimenote/cache")).unwrap();

        let state = Arc::new(AppState::default());
        let (sink, rx) = sink_with_channel();
        state.attach_runtime(sink, Arc::downgrade(&state));
        open_vault(&state, &root);

        // 证明监听活着
        std::fs::write(root.path().join("乙.md"), "# 乙\n").unwrap();
        wait_for_event(&rx, 10_000, |payload| {
            payload.paths.iter().any(|rel| rel == "乙.md")
        })
        .expect("先证监听活着");
        expect_no_event(&rx, 300);

        // 缓存库每轮构建都在写它 —— 这些事件一条都不该冒出来
        std::fs::create_dir_all(root.path().join(".mimenote/cache")).unwrap();
        std::fs::create_dir_all(root.path().join(".mimenote/trash")).unwrap();
        std::fs::write(root.path().join(".mimenote/cache/search.db"), b"cache-db").unwrap();
        std::fs::write(root.path().join(".mimenote/trash/甲.md"), b"trash").unwrap();
        // 原子写的临时文件同理
        std::fs::write(root.path().join(".mimenote-abc123.tmp"), b"tmp").unwrap();
        expect_no_event(&rx, 1_500);

        state.clear_vault();
    }

    #[test]
    fn switching_the_vault_stops_the_old_watcher() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let root_a = VaultRoot::open(first.path()).unwrap();
        let root_b = VaultRoot::open(second.path()).unwrap();
        std::fs::write(root_a.path().join("甲.md"), "# 甲\n").unwrap();
        std::fs::write(root_b.path().join("乙.md"), "# 乙\n").unwrap();

        let state = Arc::new(AppState::default());
        let (sink, rx) = sink_with_channel();
        state.attach_runtime(sink, Arc::downgrade(&state));

        // A：先证监听活着
        open_vault(&state, &root_a);
        std::fs::write(root_a.path().join("新的一篇.md"), "# 新\n").unwrap();
        wait_for_event(&rx, 10_000, |payload| {
            payload.paths.iter().any(|rel| rel == "新的一篇.md")
        })
        .expect("换 Vault 之前 A 的监听应当是活的");

        // 换到 B：**同一个 B 的监听要活着**，而 A 从此不再有回调
        open_vault(&state, &root_b);
        std::fs::write(root_b.path().join("乙之外.md"), "# 乙之外\n").unwrap();
        wait_for_event(&rx, 10_000, |payload| {
            payload.paths.iter().any(|rel| rel == "乙之外.md")
        })
        .expect("换 Vault 之后 B 的监听必须被启动");
        expect_no_event(&rx, 300);

        std::fs::write(root_a.path().join("甲又变了.md"), "# 不该有人听见\n").unwrap();
        expect_no_event(&rx, 1_500);

        state.clear_vault();
    }

    #[test]
    fn rescanning_the_same_vault_does_not_restart_the_watcher() {
        // 重扫（vault_snapshot）也会走 `set_vault`：同一根必须**保留**监听，
        // 否则每重扫一次就会有一个"事件无人接收"的窗口
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        std::fs::write(root.path().join("甲.md"), "# 甲\n").unwrap();

        let state = Arc::new(AppState::default());
        let (sink, rx) = sink_with_channel();
        state.attach_runtime(sink, Arc::downgrade(&state));
        open_vault(&state, &root);
        open_vault(&state, &root);
        open_vault(&state, &root);

        std::fs::write(root.path().join("重扫之后新建.md"), "# 新\n").unwrap();
        wait_for_event(&rx, 10_000, |payload| {
            payload.paths.iter().any(|rel| rel == "重扫之后新建.md")
        })
        .expect("重扫之后监听必须照常工作");

        state.clear_vault();
    }

    #[test]
    fn closing_the_vault_stops_the_watcher() {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        std::fs::write(root.path().join("甲.md"), "# 甲\n").unwrap();

        let state = Arc::new(AppState::default());
        let (sink, rx) = sink_with_channel();
        state.attach_runtime(sink, Arc::downgrade(&state));
        open_vault(&state, &root);

        std::fs::write(root.path().join("闭库之前.md"), "# 甲\n").unwrap();
        wait_for_event(&rx, 10_000, |payload| {
            payload.paths.iter().any(|rel| rel == "闭库之前.md")
        })
        .expect("关闭之前监听是活的");

        state.clear_vault();
        expect_no_event(&rx, 300);
        std::fs::write(root.path().join("闭库之后.md"), "# 不该有人听见\n").unwrap();
        expect_no_event(&rx, 1_500);
    }

    #[test]
    fn deleting_the_vault_directory_does_not_kill_the_watcher_thread() {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        std::fs::write(root.path().join("甲.md"), "# 甲\n").unwrap();

        let state = Arc::new(AppState::default());
        let (sink, _rx) = sink_with_channel();
        state.attach_runtime(sink, Arc::downgrade(&state));
        open_vault(&state, &root);

        // Vault 被整个删掉（用户点了"关闭 Vault"之外的路径：同步盘把目录搬走了、
        // 或者用户在资源管理器里删了它）。监听回调会收到错误事件，去抖线程还会去 stat 一堆
        // 不存在的路径 —— 两者都**不允许** panic（panic 会让 stop() 的 join 返回 Err）。
        std::fs::remove_dir_all(root.path()).unwrap();
        std::thread::sleep(Duration::from_millis(300));

        let clean = state.stop_watcher_for_test();
        assert!(
            clean,
            "Vault 目录被删掉时监听线程必须正常收尾，而不是 panic"
        );
    }

    // -- 基准（默认忽略；`--release --ignored --nocapture` 手动跑）----------------

    /// 造一个"1 万笔记 + 100 目录"的真实 Vault。
    fn build_big_vault(root: &Path, notes: usize, dirs: usize) -> usize {
        for index in 0..dirs {
            std::fs::create_dir_all(root.join(format!("目录{:02}", index % 100))).unwrap();
        }
        for index in 0..notes {
            let dir = format!("目录{:02}", index % dirs);
            let path = root.join(&dir).join(format!("笔记{index:05}.md"));
            std::fs::write(
                path,
                format!(
                    "# 笔记 {index}\n\n正文见 [[笔记{:05}]] 与 #标签{}。\n",
                    (index + 1) % notes,
                    index % 7
                ),
            )
            .unwrap();
        }
        notes
    }

    /// 一次外部改动从"落盘"到"事件推给前端"的耗时，以及它触发的重扫 + 索引构建成本。
    ///
    /// 运行：`cargo test -p mimenote --release -- --ignored --nocapture bench_watch_latency`
    #[test]
    #[ignore = "基准：真实创建 1 万个文件"]
    fn bench_watch_latency_on_a_ten_thousand_note_vault() {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        let notes = build_big_vault(root.path(), 10_000, 100);

        let state = Arc::new(AppState::default());
        let (sink, rx) = sink_with_channel();
        state.attach_runtime(sink, Arc::downgrade(&state));

        // 第一轮：整库建索引（把缓存库写出来，之后才能测"复用"那一档）
        let options = ScanOptions::default();
        let report = scan(root.path(), &options).unwrap();
        println!("[bench] 扫描 {notes} 篇：{} ms", report.scan_ms);
        let search = mn_index::SearchIndex::open(&crate::indexer::search_db_path(&root)).unwrap();
        let started = std::time::Instant::now();
        let (_, outcome) = mn_index::build_indexes(
            root.path(),
            &report.entries,
            &mn_index::BuildOptions::default(),
            None,
            Some(&search),
            |_, _| {},
        );
        println!(
            "[bench] 首轮整库建索引：{} ms",
            started.elapsed().as_millis()
        );
        drop(search);
        drop(outcome);
        state.set_vault(VaultCtx::new(
            root.clone(),
            ScanOptions::default(),
            scan(root.path(), &options).unwrap(),
        ));

        // 外部改动：改一篇笔记 → 等事件
        let target = root.path().join("目录00/笔记00000.md");
        let mut samples = Vec::new();
        for round in 0..3 {
            let started = std::time::Instant::now();
            std::fs::write(
                &target,
                format!("# 外部第 {round} 次改动，这一行更长一些\n"),
            )
            .unwrap();
            let payload = wait_for_event(&rx, 10_000, |payload| {
                payload.paths.iter().any(|rel| rel == "目录00/笔记00000.md")
            })
            .expect("外部改动必须被上报");
            let elapsed = started.elapsed().as_millis();
            samples.push(elapsed);
            println!(
                "[bench] 第 {round} 次：落盘 → 事件 {elapsed} ms（changes={}）",
                payload.changes
            );
        }
        println!("[bench] 落盘 → 事件：{samples:?} ms（静默期 {QUIET_MS} ms）");

        // 这次外部改动触发的重扫 + 增量索引构建（前端收到事件后走的正是这条路）
        let started = std::time::Instant::now();
        let report = scan(root.path(), &options).unwrap();
        let scan_ms = started.elapsed().as_millis();
        let search = mn_index::SearchIndex::open(&crate::indexer::search_db_path(&root)).unwrap();
        let started = std::time::Instant::now();
        let (_, outcome) = mn_index::build_indexes(
            root.path(),
            &report.entries,
            &mn_index::BuildOptions::default(),
            None,
            Some(&search),
            |_, _| {},
        );
        let build_ms = started.elapsed().as_millis();
        println!(
            "[bench] 重扫 {scan_ms} ms + 索引构建 {build_ms} ms（复用 {} 篇，indexed {}）",
            outcome.reused_notes, outcome.indexed
        );
        println!(
            "[bench] 一次外部改动的端到端（宿主侧）：约 {} ms",
            samples.iter().min().copied().unwrap_or(0) + scan_ms + build_ms
        );
        state.clear_vault();
    }

    /// watcher 的常驻开销：打印阶段标记，由外部脚本在这几个时刻采样句柄/内存。
    ///
    /// 四个阶段是刻意的：`idle → vault → watching → stopped` ——
    /// 只有 `vault → watching` 那一段的增量才是**监听自己的**开销；
    /// `idle → vault` 那一段是 Vault 上下文（1 万条目的条目表），不该算在监听头上。
    ///
    /// 运行：`cargo test -p mimenote --release -- --ignored --nocapture bench_watcher_overhead`
    #[test]
    #[ignore = "基准：需要外部脚本采样（见 docs/adr/0016 的实测一节）"]
    fn bench_watcher_resident_overhead_phases() {
        let dir = tempfile::tempdir().unwrap();
        let root = VaultRoot::open(dir.path()).unwrap();
        build_big_vault(root.path(), 10_000, 100);

        let state = Arc::new(AppState::default());

        println!("PHASE=idle pid={}", std::process::id());
        std::thread::sleep(Duration::from_secs(3));

        // 打开 Vault 但**不接线事件出口** → 有 1 万条目的条目表，却没有监听
        open_vault(&state, &root);
        assert!(!state.is_watching());
        println!("PHASE=vault pid={}", std::process::id());
        std::thread::sleep(Duration::from_secs(3));

        // 接上线：条目表不动，这一段增量全是监听的
        let (sink, _rx) = sink_with_channel();
        state.attach_runtime(sink, Arc::downgrade(&state));
        open_vault(&state, &root);
        assert!(state.is_watching());
        println!("PHASE=watching pid={}", std::process::id());
        std::thread::sleep(Duration::from_secs(3));

        state.stop_watcher();
        println!("PHASE=stopped pid={}", std::process::id());
        std::thread::sleep(Duration::from_secs(3));
    }
}
