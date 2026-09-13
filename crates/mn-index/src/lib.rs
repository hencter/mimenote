//! # mn-index
//!
//! Mimenote 的**索引层**：把"哪些笔记链接了哪些笔记"变成可查询的结构。
//!
//! 设计取舍（见 `docs/architecture.md`）：
//!
//! * 索引是**可从文件重建的缓存** —— 删掉它最多损失性能，不损失内容（ADR-0002）；
//! * 第一版是**内存索引**：启动后在后台线程构建，随保存/新建/删除增量更新。
//!   全文搜索（SQLite FTS5）会落在同一层，IPC 契约保持不变，前端无感；
//! * **不在启动时同步解析全库**：1 万篇笔记 ≈ 秒级，必须放到后台并报告进度，
//!   否则冷启动预算（≤1.5s）立刻爆掉；
//! * 解析只做"从文本里找链接"（`mn_core::links`），不依赖 Markdown AST，
//!   因此可以快速、可预测地增量更新；
//! * 标签（`#标签` / frontmatter `tags`，见 [`tags::TagIndex`]）与链接共用同一次
//!   `upsert`/`remove`：同一份文本顺手算出来，不做第二次 IO，也不会出现两者不同步。

pub mod rename;
pub mod tags;

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use serde::Serialize;

use mn_core::atomic::read_text;
use mn_core::links::{extract_links, join_relative, normalize_target, LinkKind, LinkRef};
use mn_core::scanner::EntryMeta;
use mn_core::tags::TagRef;

use tags::{TagIndex, TagSummary};

/// 单篇笔记参与索引的大小上限（超过则跳过，避免大文件拖慢构建）。
pub const MAX_INDEX_BYTES: u64 = 4 * 1024 * 1024;

/// 一条出链（已尝试解析到具体笔记）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLink {
    pub kind: LinkKind,
    /// 原始目标（已剥离锚点）。
    pub raw_target: String,
    /// UI 展示文本：别名 > 目标 > `#锚点`。
    pub display: String,
    pub alias: Option<String>,
    pub anchor: Option<String>,
    pub line: u32,
    /// 解析到的笔记相对路径（`None` = 未解析，即"悬空链接"）。
    pub resolved_rel_path: Option<String>,
    /// 同名多篇 → 存在歧义（已按规则挑选一个）。
    pub ambiguous: bool,
}

/// 一条反向链接：谁指向了当前笔记。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklinkRef {
    pub from_rel_path: String,
    pub display: String,
    pub anchor: Option<String>,
    pub line: u32,
    pub kind: LinkKind,
}

/// 某篇笔记的链接情况。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteLinks {
    pub rel_path: String,
    pub outbound: Vec<ResolvedLink>,
    pub backlinks: Vec<BacklinkRef>,
    /// 出链中无法解析的数量（悬空链接）。
    pub unresolved_count: usize,
}

/// 索引概况。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
    /// 已索引的笔记数。
    pub files: usize,
    /// 出链总数。
    pub links: usize,
    /// 已解析的出链数。
    pub resolved: usize,
    /// 悬空链接数。
    pub unresolved: usize,
    /// 反向链接条目数。
    pub backlink_entries: usize,
    /// 存在歧义（同名多篇）的链接数。
    pub ambiguous: usize,
    /// 不同标签的个数（概览里的行数）。
    pub tags: usize,
}

/// 链接索引。
#[derive(Debug, Default)]
pub struct LinkIndex {
    /// 真实相对路径（含扩展名）→ 该文件的出链（原始抽取结果）。
    files: HashMap<String, Vec<LinkRef>>,
    /// 归一化路径键（**小写、无扩展名**，与 `mn_core::links::normalize_target` 一致）
    /// → 真实相对路径。必须与链接目标用同一套归一化，否则"按路径解析"永远匹配不上。
    by_path: HashMap<String, String>,
    /// 小写文件名主干 → 相对路径列表（支持 `[[只写文件名]]`）。
    by_stem: HashMap<String, Vec<String>>,
    /// 目标相对路径 → 指向它的链接（惰性重建的缓存）。
    backlinks: HashMap<String, Vec<BacklinkRef>>,
    /// `backlinks` 是否需要重建。
    dirty: bool,
    /// 标签数据：与链接同源同生命周期，只在 [`Self::upsert`] / [`Self::remove`] 里更新。
    tags: TagIndex,
}

impl LinkIndex {
    pub fn new() -> Self {
        Self {
            dirty: false,
            ..Self::default()
        }
    }

    /// 清空（切换 Vault 时调用）。
    pub fn clear(&mut self) {
        self.files.clear();
        self.by_path.clear();
        self.by_stem.clear();
        self.backlinks.clear();
        self.tags.clear();
        self.dirty = false;
    }

    /// 新增/更新一篇笔记的出链与标签。
    pub fn upsert(&mut self, rel_path: &str, text: &str) {
        self.remove(rel_path);

        let rel = rel_path.replace('\\', "/");
        let links = extract_links(text);
        // 标签与链接同一份文本、同一个时机算出来：不额外读文件，也不可能不同步
        self.tags.upsert(&rel, text);

        self.by_path.insert(normalize_target(&rel), rel.clone());
        if let Some(stem) = stem_of(&rel) {
            self.by_stem
                .entry(stem.to_lowercase())
                .or_default()
                .push(rel.clone());
        }
        self.files.insert(rel, links);
        self.dirty = true;
    }

    /// 移除一篇笔记（删除/重扫时调用）：链接与标签一起清掉。
    pub fn remove(&mut self, rel_path: &str) {
        let rel = rel_path.replace('\\', "/");
        // 标签数据独立于链接数据，必须无条件清理 —— 否则删掉笔记后标签面板里还留着它
        self.tags.remove(&rel);
        if self.files.remove(&rel).is_none() {
            return;
        }
        self.by_path.remove(&normalize_target(&rel));
        if let Some(stem) = stem_of(&rel) {
            let key = stem.to_lowercase();
            if let Some(list) = self.by_stem.get_mut(&key) {
                list.retain(|candidate| candidate != &rel);
                if list.is_empty() {
                    self.by_stem.remove(&key);
                }
            }
        }
        self.dirty = true;
    }

    /// 是否已索引某篇笔记。
    pub fn contains(&self, rel_path: &str) -> bool {
        self.files.contains_key(&rel_path.replace('\\', "/"))
    }

    /// 列出某个目录下的所有后代笔记（删除目录时用）。
    pub fn paths_under(&self, prefix: &str) -> Vec<String> {
        let prefix = prefix.replace('\\', "/");
        self.files
            .keys()
            .filter(|path| path.starts_with(&prefix))
            .cloned()
            .collect()
    }

    /// 已索引的笔记数。
    pub fn len(&self) -> usize {
        self.files.len()
    }

    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }

    /// 查询某篇笔记的出链与反向链接。
    pub fn note_links(&mut self, rel_path: &str) -> NoteLinks {
        let rel = rel_path.replace('\\', "/");
        self.ensure_backlinks();

        let outbound: Vec<ResolvedLink> = self
            .files
            .get(&rel)
            .map(|links| {
                links
                    .iter()
                    .map(|link| self.resolve_link(&rel, link))
                    .collect()
            })
            .unwrap_or_default();

        let backlinks = self.backlinks.get(&rel).cloned().unwrap_or_default();
        let unresolved_count = outbound
            .iter()
            .filter(|link| link.resolved_rel_path.is_none())
            .count();

        NoteLinks {
            rel_path: rel,
            outbound,
            backlinks,
            unresolved_count,
        }
    }

    /// 某篇笔记的反向链接（不含出链）。
    pub fn backlinks_of(&mut self, rel_path: &str) -> Vec<BacklinkRef> {
        self.ensure_backlinks();
        self.backlinks
            .get(&rel_path.replace('\\', "/"))
            .cloned()
            .unwrap_or_default()
    }

    /// 用索引的解析规则把一个链接目标解析成具体笔记（`None` = 悬空）。
    ///
    /// 重命名改写必须与索引看到**同一套**规则：否则会出现"反链面板能解析、
    /// 改写后却悬空"这种最难查的不一致。
    pub fn resolve(&self, from_rel: &str, raw_target: &str) -> Option<String> {
        self.resolve_target(from_rel, raw_target).0
    }

    /// 所有出链解析到 `target_rel` 的笔记（重命名改写"候选集"的唯一来源）。
    ///
    /// 与 [`Self::backlinks_of`] 的差别：这里**包含自引用** —— `甲.md` 里的 `[[甲]]`
    /// 在改名后必须跟着改；而反链面板刻意不含自引用（那是 UI 噪音）。
    /// 纯锚点链接（`[[#小节]]`、`[x](#锚点)`）指向文件自身、改名后依然成立，不算在内。
    pub fn referrers_of(&self, target_rel: &str) -> Vec<String> {
        let target = target_rel.replace('\\', "/");
        let mut out: Vec<String> = Vec::new();
        for (from_rel, refs) in &self.files {
            let hit = refs.iter().any(|link| {
                !link.raw_target.trim().is_empty()
                    && self.resolve_target(from_rel, &link.raw_target).0.as_deref()
                        == Some(target.as_str())
            });
            if hit {
                out.push(from_rel.clone());
            }
        }
        // HashMap 的遍历顺序不稳定；排序后调用方（改写计划的日志与结果）才是可复现的
        out.sort();
        out
    }

    /// 索引概况。
    pub fn stats(&mut self) -> IndexStats {
        self.ensure_backlinks();

        let mut links = 0usize;
        let mut resolved = 0usize;
        let mut ambiguous = 0usize;

        for (rel, refs) in &self.files {
            for reference in refs {
                links += 1;
                let link = self.resolve_link(rel, reference);
                if link.resolved_rel_path.is_some() {
                    resolved += 1;
                }
                if link.ambiguous {
                    ambiguous += 1;
                }
            }
        }

        IndexStats {
            files: self.files.len(),
            links,
            resolved,
            unresolved: links - resolved,
            backlink_entries: self.backlinks.values().map(|list| list.len()).sum(),
            ambiguous,
            tags: self.tags.key_count(),
        }
    }

    // -- 标签（数据由 `upsert`/`remove` 顺带维护，这里只做查询） -------------------

    /// 某篇笔记的标签（保序：frontmatter 在前、正文在后）。未收录 → 空。
    ///
    /// 注意"未收录"与"收录了但没有标签"都返回空：调用方若要区分，用 [`Self::contains`]。
    pub fn tags_of(&self, rel_path: &str) -> Vec<TagRef> {
        self.tags.tags_of(rel_path)
    }

    /// 全库标签概览（`count` 降序 → `key` 升序）。
    pub fn tag_summary(&self) -> Vec<TagSummary> {
        self.tags.summary()
    }

    /// 某个标签下的笔记（字典序）。`key` 传原始写法（含 `#`、任意大小写）也能命中。
    pub fn notes_with_tag(&self, key: &str) -> Vec<String> {
        self.tags.notes_of(key)
    }

    /// 不同标签的个数。
    pub fn tag_count(&self) -> usize {
        self.tags.key_count()
    }

    /// 把一条原始链接解析成具体笔记。
    fn resolve_link(&self, from_rel: &str, link: &LinkRef) -> ResolvedLink {
        let (resolved_rel_path, ambiguous) = self.resolve_target(from_rel, &link.raw_target);
        let display = match (&link.alias, link.raw_target.is_empty(), &link.anchor) {
            (Some(alias), _, _) => alias.clone(),
            (None, false, _) => link.raw_target.clone(),
            (None, true, Some(anchor)) => format!("#{anchor}"),
            (None, true, None) => String::new(),
        };

        ResolvedLink {
            kind: link.kind,
            raw_target: link.raw_target.clone(),
            display,
            alias: link.alias.clone(),
            anchor: link.anchor.clone(),
            line: link.line,
            resolved_rel_path,
            ambiguous,
        }
    }

    /// 解析规则（与 Obsidian 保持一致的直觉）：
    ///
    /// 1. 目标带目录：先按"相对当前文件所在目录"找，再按"相对 Vault 根"找，
    ///    最后退化到"路径后缀匹配"；
    /// 2. 目标只有文件名：按**文件名主干**匹配全库（同名多篇时：同目录优先 → 路径更短优先 → 字典序）；
    /// 3. 找不到 → `None`（悬空链接，UI 会标红，未来可一键创建）。
    fn resolve_target(&self, from_rel: &str, raw_target: &str) -> (Option<String>, bool) {
        let key = normalize_target(raw_target);
        if key.is_empty() {
            // `[[#小节]]`：指向自身
            let self_path = self.by_path.get(&normalize_target(from_rel)).cloned();
            return (self_path, false);
        }

        if key.contains('/') {
            // 先按"相对当前文件所在目录"找（Markdown 链接的常见写法），再按"相对 Vault 根"找
            let from_dir = parent_of(&from_rel.replace('\\', "/"));
            let candidates = [join_relative(&from_dir, &key), join_relative("", &key)];
            for candidate in candidates.into_iter().flatten() {
                if let Some(real) = self.by_path.get(&candidate) {
                    return (Some(real.clone()), false);
                }
            }
            // 后缀匹配：用户常写 `[[子目录/笔记]]` 而实际在更深一层
            let suffix = format!("/{key}");
            let matches: Vec<String> = self
                .by_path
                .iter()
                .filter(|(normalized, _)| normalized.ends_with(&suffix))
                .map(|(_, real)| real.clone())
                .collect();
            return pick_candidate(matches, from_rel);
        }

        // 只有文件名（或主干）
        let stem_key = stem_of(&key).unwrap_or(key.clone()).to_lowercase();
        let mut matches = self.by_stem.get(&stem_key).cloned().unwrap_or_default();

        if matches.is_empty() {
            // 兜底：当作路径后缀（例如目标是 `某目录/笔记` 但被上面的分支漏掉）
            let suffix = format!("/{key}");
            matches = self
                .by_path
                .iter()
                .filter(|(normalized, _)| *normalized == &key || normalized.ends_with(&suffix))
                .map(|(_, real)| real.clone())
                .collect();
        }

        pick_candidate(matches, from_rel)
    }

    /// 重建反向链接缓存（惰性）。
    fn ensure_backlinks(&mut self) {
        if !self.dirty {
            return;
        }

        let mut backlinks: HashMap<String, Vec<BacklinkRef>> = HashMap::new();
        for (from_rel, refs) in &self.files {
            for reference in refs {
                let (resolved, _) = self.resolve_target(from_rel, &reference.raw_target);
                let Some(target) = resolved else { continue };
                // 自引用（`[[#小节]]`、`[x](#锚点)`）不算反向链接，否则面板里全是噪音
                if &target == from_rel {
                    continue;
                }
                let display = match (&reference.alias, reference.raw_target.is_empty()) {
                    (Some(alias), _) => alias.clone(),
                    (None, false) => reference.raw_target.clone(),
                    (None, true) => from_rel.clone(),
                };
                backlinks.entry(target).or_default().push(BacklinkRef {
                    from_rel_path: from_rel.clone(),
                    display,
                    anchor: reference.anchor.clone(),
                    line: reference.line,
                    kind: reference.kind,
                });
            }
        }

        // 稳定排序：先按来源路径，再按行号 —— 面板展示才不会是随机的
        for list in backlinks.values_mut() {
            list.sort_by(|a, b| {
                a.from_rel_path
                    .cmp(&b.from_rel_path)
                    .then_with(|| a.line.cmp(&b.line))
            });
        }

        self.backlinks = backlinks;
        self.dirty = false;
    }
}

/// 在候选里挑一个：同目录优先 → 路径更短优先 → 字典序。返回是否"存在歧义"。
fn pick_candidate(mut matches: Vec<String>, from_rel: &str) -> (Option<String>, bool) {
    matches.sort();
    matches.dedup();
    match matches.len() {
        0 => (None, false),
        1 => (matches.into_iter().next(), false),
        _ => {
            let from_dir = parent_of(from_rel);
            let mut best: Option<&String> = None;
            for candidate in &matches {
                let better = match best {
                    None => true,
                    Some(current) => {
                        let candidate_same_dir =
                            !from_dir.is_empty() && parent_of(candidate) == from_dir;
                        let current_same_dir =
                            !from_dir.is_empty() && parent_of(current) == from_dir;
                        match (candidate_same_dir, current_same_dir) {
                            (true, false) => true,
                            (false, true) => false,
                            _ => {
                                let by_len =
                                    candidate.chars().count().cmp(&current.chars().count());
                                if by_len == std::cmp::Ordering::Equal {
                                    candidate < current
                                } else {
                                    by_len == std::cmp::Ordering::Less
                                }
                            }
                        }
                    }
                };
                if better {
                    best = Some(candidate);
                }
            }
            (best.cloned(), true)
        }
    }
}

fn parent_of(rel_path: &str) -> String {
    match rel_path.rfind('/') {
        Some(index) => rel_path[..index].to_string(),
        None => String::new(),
    }
}

/// 文件名主干：`a/b/Note.md` → `Note`。
fn stem_of(rel_path: &str) -> Option<String> {
    let name = rel_path.rsplit('/').next()?;
    match name.rfind('.') {
        Some(0) | None => Some(name.to_string()),
        Some(index) => Some(name[..index].to_string()),
    }
}

/// 索引构建选项。
#[derive(Debug, Clone)]
pub struct BuildOptions {
    /// 参与索引的扩展名（小写，不含点）。
    pub note_extensions: Vec<String>,
    /// 单文件大小上限。
    pub max_bytes: u64,
    /// 每处理多少个文件回调一次进度。
    pub progress_every: usize,
}

impl Default for BuildOptions {
    fn default() -> Self {
        Self {
            note_extensions: ["md", "markdown"].iter().map(|s| s.to_string()).collect(),
            max_bytes: MAX_INDEX_BYTES,
            progress_every: 50,
        }
    }
}

/// 构建结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuildOutcome {
    /// 已索引的笔记数。
    pub indexed: usize,
    /// 跳过的条目数（非笔记、过大、读失败）。
    pub skipped: usize,
    /// 参与索引的候选总数。
    pub total: usize,
    /// 耗时（毫秒）。
    pub duration_ms: u64,
    /// 是否被取消（例如用户切换了 Vault）。
    pub cancelled: bool,
}

/// 从磁盘构建索引。
///
/// `cancel` 用于在切换 Vault / 关闭应用时中断（每处理一个文件检查一次）。
/// `progress` 每 `options.progress_every` 个文件回调一次 `(已处理, 总数)`。
///
/// 返回 `(索引, 结果)`。
pub fn build_index(
    root: &Path,
    entries: &[EntryMeta],
    options: &BuildOptions,
    cancel: Option<&AtomicBool>,
    mut progress: impl FnMut(usize, usize),
) -> (LinkIndex, BuildOutcome) {
    let started = Instant::now();
    let notes: Vec<&EntryMeta> = entries
        .iter()
        .filter(|entry| !entry.is_dir && is_note(entry, &options.note_extensions))
        .collect();
    let total = notes.len();

    let mut index = LinkIndex::new();
    let mut indexed = 0usize;
    let mut skipped = 0usize;
    let mut cancelled = false;

    for (position, entry) in notes.iter().enumerate() {
        if cancel.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
            cancelled = true;
            break;
        }

        let path = root.join(entry.rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
        match read_text(&path, options.max_bytes) {
            Ok(text) => {
                index.upsert(&entry.rel_path, &text);
                indexed += 1;
            }
            Err(error) => {
                // 单个文件读失败（被删、权限、非 UTF-8、过大）不应中断整轮索引
                log::debug!("索引跳过 {}：{error}", entry.rel_path);
                skipped += 1;
            }
        }

        if options.progress_every > 0 && position % options.progress_every == 0 {
            progress(position + 1, total);
        }
    }

    progress(indexed, total);

    (
        index,
        BuildOutcome {
            indexed,
            skipped,
            total,
            duration_ms: started.elapsed().as_millis() as u64,
            cancelled,
        },
    )
}

fn is_note(entry: &EntryMeta, extensions: &[String]) -> bool {
    entry.ext.as_deref().is_some_and(|ext| {
        extensions
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(ext))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(rel: &str) -> EntryMeta {
        EntryMeta {
            rel_path: rel.to_string(),
            name: rel.rsplit('/').next().unwrap().to_string(),
            is_dir: false,
            size_bytes: 10,
            mtime_ms: Some(1),
            ext: Some("md".to_string()),
        }
    }

    fn index_of(files: &[(&str, &str)]) -> LinkIndex {
        let mut index = LinkIndex::new();
        for (rel, text) in files {
            index.upsert(rel, text);
        }
        index
    }

    #[test]
    fn resolves_wikilink_by_file_stem() {
        let mut index = index_of(&[("笔记/甲.md", "看 [[乙]]"), ("笔记/乙.md", "# 乙")]);
        let links = index.note_links("笔记/甲.md");
        assert_eq!(links.outbound.len(), 1);
        assert_eq!(
            links.outbound[0].resolved_rel_path.as_deref(),
            Some("笔记/乙.md")
        );
        assert!(!links.outbound[0].ambiguous);
        assert_eq!(links.unresolved_count, 0);
    }

    #[test]
    fn resolves_markdown_link_relative_to_current_file() {
        let mut index = index_of(&[
            ("笔记/甲.md", "[看这里](../别的/丙.md)"),
            ("别的/丙.md", "# 丙"),
        ]);
        let links = index.note_links("笔记/甲.md");
        assert_eq!(
            links.outbound[0].resolved_rel_path.as_deref(),
            Some("别的/丙.md"),
            "Markdown 链接按相对当前文件解析"
        );
    }

    #[test]
    fn dangling_link_is_reported_unresolved() {
        let mut index = index_of(&[("甲.md", "[[还不存在的笔记]]")]);
        let links = index.note_links("甲.md");
        assert_eq!(links.outbound[0].resolved_rel_path, None);
        assert_eq!(links.unresolved_count, 1);
    }

    #[test]
    fn same_directory_wins_when_names_collide() {
        let mut index = index_of(&[
            ("a/甲.md", "[[同名]]"),
            ("a/同名.md", "A"),
            ("b/同名.md", "B"),
            ("c/d/同名.md", "C"),
        ]);
        let links = index.note_links("a/甲.md");
        assert_eq!(
            links.outbound[0].resolved_rel_path.as_deref(),
            Some("a/同名.md")
        );
        assert!(links.outbound[0].ambiguous, "应当标记为存在歧义");
    }

    #[test]
    fn shortest_path_wins_without_same_directory_match() {
        let mut index = index_of(&[
            ("x/甲.md", "[[同名]]"),
            ("b/同名.md", "B"),
            ("c/d/同名.md", "C"),
        ]);
        let links = index.note_links("x/甲.md");
        assert_eq!(
            links.outbound[0].resolved_rel_path.as_deref(),
            Some("b/同名.md")
        );
        assert!(links.outbound[0].ambiguous);
    }

    #[test]
    fn path_link_matches_suffix() {
        let mut index = index_of(&[
            ("甲.md", "[[项目/设计]]"),
            ("很深的目录/项目/设计.md", "# 设计"),
        ]);
        let links = index.note_links("甲.md");
        assert_eq!(
            links.outbound[0].resolved_rel_path.as_deref(),
            Some("很深的目录/项目/设计.md")
        );
    }

    #[test]
    fn case_insensitive_matching() {
        let mut index = index_of(&[("甲.md", "[[note]]"), ("Note.md", "# Note")]);
        let links = index.note_links("甲.md");
        assert_eq!(
            links.outbound[0].resolved_rel_path.as_deref(),
            Some("Note.md")
        );
    }

    #[test]
    fn backlinks_are_collected_and_sorted() {
        let mut index = index_of(&[
            ("甲.md", "指向 [[乙]]"),
            ("丙.md", "也指向 [[乙]]\n第二行 [[乙|别名]]"),
            ("乙.md", "# 乙"),
        ]);
        let backlinks = index.backlinks_of("乙.md");
        assert_eq!(backlinks.len(), 3);
        assert_eq!(backlinks[0].from_rel_path, "丙.md");
        assert_eq!(backlinks[0].line, 1);
        assert_eq!(backlinks[1].from_rel_path, "丙.md");
        assert_eq!(backlinks[1].display, "别名");
        assert_eq!(backlinks[2].from_rel_path, "甲.md");
    }

    #[test]
    fn updating_a_file_replaces_its_links() {
        let mut index = index_of(&[("甲.md", "[[乙]]"), ("乙.md", ""), ("丙.md", "")]);
        assert_eq!(index.backlinks_of("乙.md").len(), 1);

        index.upsert("甲.md", "改成 [[丙]]");
        assert!(index.backlinks_of("乙.md").is_empty(), "旧链接必须消失");
        assert_eq!(index.backlinks_of("丙.md").len(), 1);
    }

    #[test]
    fn removing_a_file_clears_its_outgoing_and_incoming() {
        let mut index = index_of(&[("甲.md", "[[乙]]"), ("乙.md", "[[甲]]")]);
        assert_eq!(index.backlinks_of("甲.md").len(), 1);

        index.remove("乙.md");
        assert_eq!(index.len(), 1);
        assert!(
            index.backlinks_of("甲.md").is_empty(),
            "乙的链接应随文件一起消失"
        );
    }

    #[test]
    fn self_anchor_link_points_to_itself() {
        let mut index = index_of(&[("甲.md", "见 [[#小节]]")]);
        let links = index.note_links("甲.md");
        assert_eq!(
            links.outbound[0].resolved_rel_path.as_deref(),
            Some("甲.md")
        );
        assert_eq!(links.outbound[0].display, "#小节");
    }

    #[test]
    fn embeds_count_as_backlinks() {
        let mut index = index_of(&[("甲.md", "![[乙]]"), ("乙.md", "")]);
        assert_eq!(index.backlinks_of("乙.md").len(), 1);
        assert_eq!(index.backlinks_of("乙.md")[0].kind, LinkKind::Embed);
    }

    #[test]
    fn stats_report_resolution_ratio() {
        let mut index = index_of(&[("甲.md", "[[乙]] [[不存在]] [[乙|重复]]"), ("乙.md", "")]);
        let stats = index.stats();
        assert_eq!(stats.files, 2);
        assert_eq!(stats.links, 3);
        assert_eq!(stats.resolved, 2);
        assert_eq!(stats.unresolved, 1);
        assert_eq!(stats.backlink_entries, 2);
    }

    #[test]
    fn clears_completely() {
        let mut index = index_of(&[("甲.md", "[[乙]]"), ("乙.md", "")]);
        index.clear();
        assert!(index.is_empty());
        assert_eq!(index.stats().links, 0);
        assert!(index.backlinks_of("乙.md").is_empty());
    }

    #[test]
    fn tags_follow_upsert_and_remove() {
        // 标签与链接共用同一个 upsert/remove：同一次写入里两者都必须更新
        let mut index = index_of(&[("笔记/甲.md", "正文 #甲 与 [[乙]]\n"), ("乙.md", "#乙\n")]);

        assert_eq!(index.tags_of("笔记/甲.md").len(), 1);
        assert_eq!(index.tag_count(), 2);
        assert_eq!(index.notes_with_tag("#甲"), vec!["笔记/甲.md".to_string()]);
        assert_eq!(index.stats().tags, 2);
        assert_eq!(index.stats().links, 1, "标签不影响链接统计");

        // 保存后改了标签 → 旧键消失、新键立刻可查（"编辑笔记加标签，面板立刻能看到"的前提）
        index.upsert("笔记/甲.md", "换成了 #新标签\n");
        assert!(
            index.notes_with_tag("甲").is_empty(),
            "旧标签必须随重算一起消失"
        );
        assert_eq!(
            index.notes_with_tag("新标签"),
            vec!["笔记/甲.md".to_string()]
        );

        // 删除 → 标签与链接一起清掉
        index.remove("笔记/甲.md");
        assert!(index.tags_of("笔记/甲.md").is_empty());
        assert!(index.notes_with_tag("新标签").is_empty());
        assert_eq!(index.tag_count(), 1, "只剩 乙.md 的 #乙");
        assert_eq!(index.stats().links, 0);

        // 重扫（clear）后标签也清空，不会留下上一轮 Vault 的标签
        index.clear();
        assert_eq!(index.tag_count(), 0);
        assert!(index.tag_summary().is_empty());
    }

    #[test]
    fn build_index_collects_tags_from_disk() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("甲.md"),
            "---\ntags: [项目/甲]\n---\n\n正文 #行内\n",
        )
        .unwrap();
        std::fs::write(dir.path().join("乙.md"), "正文 #行内 与 #其它\n").unwrap();
        std::fs::write(dir.path().join("图.png"), "binary").unwrap();

        let entries = vec![note("甲.md"), note("乙.md")];
        let (index, _) = build_index(
            dir.path(),
            &entries,
            &BuildOptions::default(),
            None,
            |_done, _total| {},
        );

        let summary = index.tag_summary();
        assert_eq!(summary.len(), 3, "项目/甲、行内、其它：{summary:?}");
        let shared = summary.iter().find(|item| item.key == "行内").unwrap();
        assert_eq!(shared.count, 2, "两篇都有 #行内");
        assert_eq!(
            index.notes_with_tag("行内"),
            vec!["乙.md".to_string(), "甲.md".to_string()],
            "按路径字典序"
        );
        assert_eq!(index.tags_of("甲.md")[0].tag, "项目/甲");
    }

    #[test]
    fn builds_from_disk_and_reports_outcome() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("甲.md"), "# 甲\n\n[[乙]]\n").unwrap();
        std::fs::write(dir.path().join("乙.md"), "# 乙\n\n[[丙]]\n").unwrap();
        std::fs::write(dir.path().join("图.png"), "binary").unwrap();

        let entries = vec![note("甲.md"), note("乙.md")];
        let (mut index, outcome) = build_index(
            dir.path(),
            &entries,
            &BuildOptions::default(),
            None,
            |_done, _total| {},
        );

        assert_eq!(outcome.indexed, 2);
        assert!(!outcome.cancelled);
        assert_eq!(index.len(), 2);
        assert_eq!(index.backlinks_of("乙.md").len(), 1);
        // 丙 不存在 → 悬空
        let stats = index.stats();
        assert_eq!(stats.links, 2);
        assert_eq!(stats.resolved, 1);
        assert_eq!(stats.unresolved, 1);
    }

    /// 性能基准：1 万笔记的索引构建耗时（链接 + 标签在同一次解析里算出来）。
    ///
    /// 运行：`cargo test -p mn-index --release -- --ignored --nocapture bench_build_index_10k_notes`
    ///
    /// 同时分别打印 `extract_links` / `extract_tags` 各自跑 1 万遍的耗时 ——
    /// 那是"给索引加标签"这件事的真实增量成本（扫描本身的预算见 mn-core 的 bench）。
    #[test]
    #[ignore]
    fn bench_build_index_10k_notes() {
        let dir = tempfile::tempdir().unwrap();
        let body = "---\ntags: [项目/甲, 乙]\n---\n\n正文 #行内 与 [[另一篇]] 结束\n";
        for d in 0..100 {
            let sub = dir.path().join(format!("dir{d:03}"));
            std::fs::create_dir_all(&sub).unwrap();
            for f in 0..100 {
                std::fs::write(sub.join(format!("note{f:03}.md")), body).unwrap();
            }
        }
        let entries: Vec<EntryMeta> = (0..100)
            .flat_map(|d| (0..100).map(move |f| note(&format!("dir{d:03}/note{f:03}.md"))))
            .collect();

        let (mut index, outcome) = build_index(
            dir.path(),
            &entries,
            &BuildOptions::default(),
            None,
            |_done, _total| {},
        );

        let started = Instant::now();
        let mut links = 0usize;
        for _ in 0..10_000 {
            links += extract_links(body).len();
        }
        let links_ms = started.elapsed().as_millis();

        let started = Instant::now();
        let mut tags = 0usize;
        for _ in 0..10_000 {
            tags += mn_core::extract_tags(body).len();
        }
        let tags_ms = started.elapsed().as_millis();

        let stats = index.stats();
        eprintln!(
            "build_index 1 万笔记：{} ms（索引 {} 篇 / {} 链接 / {} 反链 / {} 个标签）\n\
             纯解析 1 万遍：extract_links {} ms（{} 条），extract_tags {} ms（{} 条）",
            outcome.duration_ms,
            outcome.indexed,
            stats.links,
            stats.backlink_entries,
            stats.tags,
            links_ms,
            links,
            tags_ms,
            tags
        );
        // 建索引含 1 万次小文件读 + fsync 之后的元数据，放宽到 8s 只用来挡住"灾难性回退"
        assert!(
            outcome.duration_ms <= 8_000,
            "索引构建耗时超回归阈值：{}ms",
            outcome.duration_ms
        );
    }

    #[test]
    fn build_can_be_cancelled() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..20 {
            std::fs::write(dir.path().join(format!("n{i}.md")), "# x").unwrap();
        }
        let entries: Vec<EntryMeta> = (0..20).map(|i| note(&format!("n{i}.md"))).collect();
        let cancel = AtomicBool::new(true); // 一开始就取消

        let (index, outcome) = build_index(
            dir.path(),
            &entries,
            &BuildOptions::default(),
            Some(&cancel),
            |_done, _total| {},
        );
        assert!(outcome.cancelled);
        assert_eq!(index.len(), 0);
    }
}
