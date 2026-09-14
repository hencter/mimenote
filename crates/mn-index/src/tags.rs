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

    /// 组合过滤：**含 `any` 里任意一个**（`any` 为空 = 全部笔记）**且不含 `none` 里任何一个**。
    ///
    /// 为什么把这件事放到索引层而不是让前端一个个标签问：
    /// "有 A 且没有 B" 这类查询在前端只能拆成"取 A 的笔记集合、再取 B 的、相减" ——
    /// 一次查询 N 次 IPC，而层级标签还要把 `父` 展开成"父 + 每个后代"（真实 Vault 里
    /// 一个父标签挂 200 个子标签就是 201 次往返）。这里一次遍历就出结果。
    ///
    /// `include_children = true` 时，`父` 也匹配 `父/子`、`父/子/孙`（分隔符按 `/` 切段比较，
    /// 因此 `父老`、`父辈` **不**算后代 —— 与 `TagRename` 的口径一致）。
    ///
    /// 返回**字典序**的路径列表（契约：同样的查询每次结果一致，前端不需要再排一次）。
    pub fn filter_notes(
        &self,
        any: &[String],
        none: &[String],
        include_children: bool,
    ) -> Vec<String> {
        let any_keys: Vec<String> = any
            .iter()
            .map(|key| normalize_tag(key))
            .filter(|key| !key.is_empty())
            .collect();
        let none_keys: Vec<String> = none
            .iter()
            .map(|key| normalize_tag(key))
            .filter(|key| !key.is_empty())
            .collect();

        // 命中集合：`any` 为空 = 全库；否则是各键（含后代）笔记集合的并集
        let mut matched: BTreeSet<String> = if any_keys.is_empty() {
            self.by_note
                .iter()
                .filter(|(_, tags)| !tags.is_empty())
                .map(|(note, _)| note.clone())
                .collect()
        } else {
            let mut set = BTreeSet::new();
            for key in &any_keys {
                set.extend(self.notes_under(key, include_children));
            }
            set
        };

        // 排除：`none` 的每一个键（含后代）整体减掉
        for key in &none_keys {
            for note in self.notes_under(key, include_children) {
                matched.remove(&note);
            }
        }

        matched.into_iter().collect()
    }

    /// 某个键（可选含后代）下的笔记。
    ///
    /// `by_key` 是 `BTreeMap`，所以"前缀扫描"是一次 range + take_while：
    /// 命中区间是 `[key, key + '/')` 这一段连续键，不必遍历全库所有标签。
    fn notes_under(&self, key: &str, include_children: bool) -> Vec<String> {
        let Some(notes) = self.by_key.get(key) else {
            // 键本身不存在时，仍可能有它的后代（`父` 从未被直接写过、只写过 `父/子`）
            return if include_children {
                self.child_notes(key)
            } else {
                Vec::new()
            };
        };
        let mut out: Vec<String> = notes.iter().cloned().collect();
        if include_children {
            out.extend(self.child_notes(key));
        }
        out
    }

    /// 键的所有**后代**（`key/…`）下的笔记。
    fn child_notes(&self, key: &str) -> Vec<String> {
        let prefix = format!("{key}/");
        let mut out = Vec::new();
        // `range` 从 `prefix` 起：所有以它开头的键都紧跟在后面（BTreeMap 是字典序）
        for (child_key, notes) in self.by_key.range(prefix.clone()..) {
            if !child_key.starts_with(&prefix) {
                break;
            }
            out.extend(notes.iter().cloned());
        }
        out
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

    // -- 组合过滤（含 / 不含，可带后代）-----------------------------------------

    /// 测试夹具：一张覆盖"层级 + 排除"的小图。
    ///
    /// ```text
    /// 项目/甲.md      #项目   #项目/前端
    /// 项目/乙.md      #项目/后端
    /// 归档/甲.md      #归档   #项目      （同时有 项目 与 归档，用来验证排除）
    /// 其它.md         #其它
    /// 无标签.md       （没有标签）
    /// 父老.md         #父老      （用来验证"按 / 切段"，不是字符串前缀）
    /// 深层.md         #父/子/孙
    /// ```
    fn filter_fixture() -> TagIndex {
        index_of(&[
            ("项目/甲.md", "# 甲\n\n#项目 #项目/前端\n"),
            ("项目/乙.md", "# 乙\n\n#项目/后端\n"),
            ("归档/甲.md", "# 旧\n\n#归档 #项目\n"),
            ("其它.md", "# 其它\n\n#其它\n"),
            ("无标签.md", "# 没有标签\n"),
            ("父老.md", "# 父老\n\n#父老\n"),
            ("深层.md", "# 深层\n\n#父/子/孙\n"),
        ])
    }

    #[test]
    fn filter_without_any_tag_returns_every_note_that_has_tags() {
        let index = filter_fixture();
        let all = index.filter_notes(&[], &[], false);
        // 没有标签的那篇**不进**结果集（它不属于任何标签视图）
        assert!(!all.contains(&"无标签.md".to_string()));
        assert_eq!(all.len(), 6);
        // 字典序（契约：同一查询结果稳定，前端不必再排一次）
        assert_eq!(all, {
            let mut sorted = all.clone();
            sorted.sort();
            sorted
        });
    }

    #[test]
    fn filter_any_is_a_union_and_none_subtracts() {
        let index = filter_fixture();

        // 含 项目 或 其它（**严格等于**：只写了 `#项目/后端` 的那篇不算"有 项目"）
        let any = index.filter_notes(&["项目".into(), "其它".into()], &[], false);
        assert_eq!(
            any,
            vec![
                "其它.md".to_string(),
                "归档/甲.md".into(),
                "项目/甲.md".into()
            ]
        );

        // 含 项目 但**不含** 归档 —— 这条就是"有 A 且没有 B"
        let none = index.filter_notes(&["项目".into()], &["归档".into()], false);
        assert_eq!(none, vec!["项目/甲.md".to_string()]);
    }

    #[test]
    fn filter_can_include_descendants_and_respects_segment_boundaries() {
        let index = filter_fixture();

        // 只看 `项目` 本身（严格等于）：两篇子标签的都不算
        let strict = index.filter_notes(&["项目".into()], &[], false);
        assert_eq!(strict, vec!["归档/甲.md".to_string(), "项目/甲.md".into()]);

        // 含后代：`项目/前端`、`项目/后端` 都进来。
        // 顺序按**码点**：`乙`(U+4E59) < `甲`(U+7532)，所以 `项目/乙` 排在 `项目/甲` 前面 ——
        // 这正是"字典序"的字面含义，前端不会再排一次（契约写在 `filter_notes` 的文档里）。
        let with_children = index.filter_notes(&["项目".into()], &[], true);
        assert_eq!(
            with_children,
            vec![
                "归档/甲.md".to_string(),
                "项目/乙.md".into(),
                "项目/甲.md".into()
            ]
        );

        // `父` 从未被直接写过，只写过 `父/子/孙`：含后代时仍然能命中
        assert_eq!(
            index.filter_notes(&["父".into()], &[], true),
            vec!["深层.md".to_string()]
        );
        assert!(index.filter_notes(&["父".into()], &[], false).is_empty());

        // 按 `/` 切段比较：`父老` 不是 `父` 的后代
        let children = index.filter_notes(&["父".into()], &[], true);
        assert!(!children.contains(&"父老.md".to_string()));
    }

    #[test]
    fn filter_excludes_descendants_and_tolerates_raw_spellings() {
        let index = filter_fixture();

        // 排除时同样支持"含后代"
        let without_project = index.filter_notes(&[], &["项目".into()], true);
        assert_eq!(
            without_project,
            vec!["其它.md".to_string(), "深层.md".into(), "父老.md".into()]
        );

        // 传原始写法（大小写、带 `#`）也能命中：与其它标签接口同一把尺子
        assert_eq!(
            index.filter_notes(&["#项目".into()], &["归档".into()], false),
            vec!["项目/甲.md".to_string()]
        );
        // ⚠️ 层级语义的坑：只写 `#项目/后端` 的笔记**不算**"有 `#项目`"（严格等于），
        // 而界面上「含子标签」默认开着，所以用户看到的是"含后代"的那一档
        assert_eq!(index.filter_notes(&["#项目".into()], &[], true).len(), 3);

        // 空键与纯 `#` 一律忽略（不是"匹配所有"，也不是报错）
        assert_eq!(
            index
                .filter_notes(&["".into(), "#".into()], &[], false)
                .len(),
            6
        );
        assert_eq!(
            index
                .filter_notes(&["项目".into()], &["".into()], false)
                .len(),
            2
        );
    }

    #[test]
    fn filter_on_missing_tags_returns_nothing() {
        let index = filter_fixture();
        assert!(index
            .filter_notes(&["不存在的标签".into()], &[], true)
            .is_empty());
        // 排除一个不存在的键什么都不减
        assert_eq!(
            index
                .filter_notes(&["项目".into()], &["不存在".into()], true)
                .len(),
            3
        );
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
