//! 标签索引：正文 `#标签` 与 frontmatter `tags` 的反向索引。
//!
//! 与链接索引（[`crate::LinkIndex`]）**同源同生命周期**：同一份文本、同一个
//! `upsert`/`remove` 顺手算出来 —— 因此保存、新建、删除、重命名、全库重建这几条写路径
//! 都不需要为标签再读一次文件（标签和链接一样只需要 `&str`）。
//!
//! 两个刻意的选择：
//!
//! * 反向索引用 `BTreeMap<键, BTreeSet<路径>>`：面板要的是"该标签下的笔记（字典序）"，
//!   有序集合天然满足；删除是 O(log n) 的精确删除，不必遍历全库；
//! * 每篇笔记的标签里**预先算好归一化键**（[`IndexedTag::key`]）：键只算一次，
//!   `remove` 才能精确清理反向索引，概览也不必反复归一化（`normalize_tag` 会分配字符串）。

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::Serialize;

use mn_core::tags::{extract_tags, normalize_tag, TagRef};

/// 全库标签概览的一项。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagSummary {
    /// 归一化后的键（小写、去首尾 `/`）。判同只认它。
    pub key: String,
    /// 显示写法：该键**首次出现**的那一条原始写法（保留大小写与层级）。
    pub tag: String,
    /// 含该标签的**笔记数**（不是出现次数：同一篇里写两次仍然算一篇）。
    pub count: u32,
}

/// 一篇笔记里的一条标签：原始抽取结果 + 预先算好的归一化键。
#[derive(Debug, Clone, PartialEq, Eq)]
struct IndexedTag {
    key: String,
    tag: TagRef,
}

/// 标签索引。
#[derive(Debug, Default)]
pub struct TagIndex {
    /// 笔记相对路径 → 该笔记的标签（**保序**：frontmatter 在前、正文在后，抽取器已去重）。
    by_note: HashMap<String, Vec<IndexedTag>>,
    /// 归一化键 → 含该标签的笔记（有序集合）。
    by_key: BTreeMap<String, BTreeSet<String>>,
}

impl TagIndex {
    /// 清空（切换 Vault / 重扫前调用）。
    pub fn clear(&mut self) {
        self.by_note.clear();
        self.by_key.clear();
    }

    /// 重算一篇笔记的标签（由 [`crate::LinkIndex::upsert`] 调用）。
    pub fn upsert(&mut self, rel_path: &str, text: &str) {
        self.replace(rel_path, extract_tags(text));
    }

    /// 用**已经抽取好的标签**重算一篇笔记的标签。
    ///
    /// 为什么需要它（ADR-0014）：跨会话复用把每篇的标签落进了缓存库，装回内存时手上只有
    /// `TagRef` 而没有正文。归一化键、空键过滤、反向索引的记账规则必须与 [`Self::upsert`]
    /// **完全一致**，否则"复用回来的标签"与"重读文件算出来的标签"会分家 ——
    /// 所以两者共用这同一段代码，而不是在别处照着再写一遍。
    pub fn replace(&mut self, rel_path: &str, tags: Vec<TagRef>) {
        self.remove(rel_path);

        let rel = rel_path.replace('\\', "/");
        let tags: Vec<IndexedTag> = tags
            .into_iter()
            .filter_map(|tag| {
                let key = normalize_tag(&tag.tag);
                // 空键（`#`、只有空白/`/`）不进索引：它没有任何匹配意义，只会在概览里留空行
                (!key.is_empty()).then_some(IndexedTag { key, tag })
            })
            .collect();

        if tags.is_empty() {
            // 没有标签的笔记**不留空条目**：省内存，也让"索引里有没有这篇"的语义更干净
            return;
        }

        for entry in &tags {
            self.by_key
                .entry(entry.key.clone())
                .or_default()
                .insert(rel.clone());
        }
        self.by_note.insert(rel, tags);
    }

    /// 移除一篇笔记的标签（由 [`crate::LinkIndex::remove`] 调用）。
    pub fn remove(&mut self, rel_path: &str) {
        let rel = rel_path.replace('\\', "/");
        let Some(tags) = self.by_note.remove(&rel) else {
            return;
        };

        for entry in tags {
            if let Some(notes) = self.by_key.get_mut(&entry.key) {
                notes.remove(&rel);
                // 最后一个持有者消失 → 整个键从概览里消失（不留 count = 0 的空标签）
                if notes.is_empty() {
                    self.by_key.remove(&entry.key);
                }
            }
        }
    }

    /// 某篇笔记的标签（未收录 → 空）。
    pub fn tags_of(&self, rel_path: &str) -> Vec<TagRef> {
        self.by_note
            .get(&rel_path.replace('\\', "/"))
            .map(|tags| tags.iter().map(|entry| entry.tag.clone()).collect())
            .unwrap_or_default()
    }

    /// 某个标签下的笔记（字典序）。`key` 传原始写法也可以（内部先归一化）。
    pub fn notes_of(&self, key: &str) -> Vec<String> {
        let key = normalize_tag(key);
        if key.is_empty() {
            return Vec::new();
        }
        self.by_key
            .get(&key)
            .map(|notes| notes.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// 全库标签概览：`count` 降序 → `key` 字典序升序。
    pub fn summary(&self) -> Vec<TagSummary> {
        let mut out: Vec<TagSummary> = self
            .by_key
            .iter()
            .map(|(key, notes)| TagSummary {
                key: key.clone(),
                tag: self.display_of(key, notes),
                count: notes.len() as u32,
            })
            .collect();
        // 并列时按 key 升序：概览的每一行位置都可复现，不随 HashMap/BTreeMap 实现而变
        out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.key.cmp(&b.key)));
        out
    }

    /// 该键的显示写法：**路径字典序最靠前**的那一篇里，这个键第一次出现的原始写法。
    ///
    /// 按路径而不是按插入顺序 —— 重扫、改名、后来才加入更靠前的路径，结果都保持稳定。
    fn display_of(&self, key: &str, notes: &BTreeSet<String>) -> String {
        for note in notes {
            if let Some(entry) = self
                .by_note
                .get(note)
                .and_then(|tags| tags.iter().find(|entry| entry.key == key))
            {
                return entry.tag.tag.clone();
            }
        }
        // 走不到这里（`by_key` 里的每个键至少有一条笔记）；兜底显示键本身
        key.to_string()
    }

    /// 收录了标签的笔记数（日志用）。
    pub fn note_count(&self) -> usize {
        self.by_note.len()
    }

    /// 不同标签的个数（日志用）。
    pub fn key_count(&self) -> usize {
        self.by_key.len()
    }

    /// 标签条目总数（同一篇里 `#甲` 与 `#乙` 算两条）。
    pub fn entry_count(&self) -> usize {
        self.by_note.values().map(|tags| tags.len()).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mn_core::tags::TagSource;

    fn index_of(files: &[(&str, &str)]) -> TagIndex {
        let mut index = TagIndex::default();
        for (rel, text) in files {
            index.upsert(rel, text);
        }
        index
    }

    fn keys_of(index: &TagIndex, rel: &str) -> Vec<String> {
        index.tags_of(rel).into_iter().map(|tag| tag.tag).collect()
    }

    #[test]
    fn indexes_frontmatter_and_inline_tags_with_source_and_line() {
        let index = index_of(&[(
            "甲.md",
            "---\ntitle: 甲\ntags: [笔记/甲, 乙]\n---\n\n正文 #丙 与 #丁\n",
        )]);

        let tags = index.tags_of("甲.md");
        assert_eq!(
            tags.iter().map(|t| t.tag.as_str()).collect::<Vec<_>>(),
            vec!["笔记/甲", "乙", "丙", "丁"],
            "frontmatter 在前、正文在后，保序"
        );
        assert_eq!(tags[0].source, TagSource::Frontmatter);
        assert_eq!(tags[2].source, TagSource::Inline);
        assert_eq!(tags[2].line, 6, "面板要显示行号");
        assert_eq!(index.key_count(), 4);
        assert_eq!(index.entry_count(), 4);
        assert_eq!(index.note_count(), 1);
    }

    #[test]
    fn normalizes_case_and_keeps_first_writing() {
        let index = index_of(&[
            ("a.md", "正文 #rust\n"),
            ("b.md", "正文 #Rust 与 #其它\n"),
            ("c.md", "正文 #RUST\n"),
        ]);

        // `#Rust` / `#rust` / `#RUST` 是同一个键，含它的笔记有 3 篇
        let summary = index.summary();
        assert_eq!(summary.len(), 2);
        let rust = summary.iter().find(|item| item.key == "rust").unwrap();
        assert_eq!(rust.count, 3, "count 是笔记数，不是出现次数");
        assert_eq!(rust.tag, "rust", "显示写法取路径字典序最靠前那篇的原始写法");
        assert_eq!(rust.key, "rust");

        // 同一篇里 frontmatter 在前 → 它的写法胜出（抽取器的顺序就是显示顺序）
        let frontmatter_first =
            index_of(&[("甲.md", "---\ntags: [大写的Rust]\n---\n正文 #大写的rust\n")]);
        assert_eq!(frontmatter_first.summary()[0].tag, "大写的Rust");
        assert_eq!(
            frontmatter_first.tags_of("甲.md").len(),
            1,
            "大小写不同是同一个键"
        );

        // 传原始写法（甚至带 `#`）都能命中
        assert_eq!(
            index.notes_of("#RUST"),
            vec!["a.md".to_string(), "b.md".to_string(), "c.md".to_string()],
            "notes 必须是字典序"
        );
        assert_eq!(index.notes_of("不存在的标签"), Vec::<String>::new());
        assert_eq!(index.notes_of(""), Vec::<String>::new());
    }

    #[test]
    fn upsert_replaces_previous_tags() {
        let mut index = index_of(&[("甲.md", "#旧的 与 #保留\n")]);
        assert_eq!(keys_of(&index, "甲.md"), vec!["旧的", "保留"]);
        assert_eq!(index.notes_of("旧的"), vec!["甲.md".to_string()]);

        index.upsert("甲.md", "#新的\n");
        assert_eq!(keys_of(&index, "甲.md"), vec!["新的"]);
        assert!(
            index.summary().iter().all(|item| item.key != "旧的"),
            "旧标签必须随重算一起消失（不留 count = 0 的空标签）"
        );
        assert!(index.notes_of("保留").is_empty());
    }

    #[test]
    fn remove_cleans_both_directions() {
        let mut index = index_of(&[("甲.md", "#共享\n"), ("乙.md", "#共享 与 #独有\n")]);
        assert_eq!(index.notes_of("共享").len(), 2);

        index.remove("甲.md");
        assert!(index.tags_of("甲.md").is_empty());
        assert_eq!(index.notes_of("共享"), vec!["乙.md".to_string()]);
        assert_eq!(index.note_count(), 1);

        index.remove("乙.md");
        assert!(index.summary().is_empty(), "没有笔记持有标签时键应当消失");
        assert!(index.notes_of("共享").is_empty());
        // 幂等：重复删除不能 panic
        index.remove("乙.md");
        index.remove("从来没收录过的.md");
    }

    #[test]
    fn summary_sorts_by_count_then_key() {
        let index = index_of(&[
            ("a.md", "#多\n"),
            ("b.md", "#多 与 #少\n"),
            ("c.md", "#多\n"),
        ]);
        let summary = index.summary();
        assert_eq!(summary.len(), 2);
        assert_eq!(summary[0].key, "多");
        assert_eq!(summary[0].count, 3);
        assert_eq!(summary[1].key, "少");
        assert_eq!(summary[1].count, 1);

        // 并列时按 key 字典序升序
        let tie = index_of(&[("a.md", "#beta 与 #alpha\n"), ("b.md", "#乙 与 #甲\n")]);
        assert_eq!(
            tie.summary()
                .iter()
                .map(|item| item.key.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha", "beta", "乙", "甲"],
            "同 count 时按 key 升序；键是 UTF-8 字节序，所以 乙(U+4E59) 在 甲(U+7532) 之前"
        );
    }

    #[test]
    fn empty_and_invalid_tags_are_skipped() {
        let index = index_of(&[("甲.md", "# 标题\n\n#123 不是标签\n\n正文 #真\n")]);
        assert_eq!(keys_of(&index, "甲.md"), vec!["真"]);
        assert_eq!(index.key_count(), 1);

        // 没有任何标签的笔记不进 by_note（也就不会出现在概览里）
        let blank = index_of(&[("甲.md", "纯正文，没有标签\n")]);
        assert!(blank.tags_of("甲.md").is_empty());
        assert_eq!(blank.note_count(), 0);
        assert!(blank.summary().is_empty());
    }

    #[test]
    fn clear_drops_everything() {
        let mut index = index_of(&[("甲.md", "#甲\n"), ("乙.md", "#乙\n")]);
        index.clear();
        assert_eq!(index.note_count(), 0);
        assert_eq!(index.key_count(), 0);
        assert_eq!(index.entry_count(), 0);
        assert!(index.summary().is_empty());
        assert!(index.tags_of("甲.md").is_empty());
    }

    #[test]
    fn backslash_paths_are_normalized_like_the_link_index() {
        let index = index_of(&[(r"笔记\甲.md", "#甲\n")]);
        assert_eq!(keys_of(&index, "笔记/甲.md"), vec!["甲"]);
        assert_eq!(index.notes_of("甲"), vec!["笔记/甲.md".to_string()]);
    }
}
