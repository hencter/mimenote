//! 打开一个 Vault 之后的文件与索引会话。
//!
//! 界面只调用这里：扫描、读取、带 mtime 令牌的原子保存、全文搜索、出链与反链
//! 都走 `mn-core` / `mn-index`，本模块不依赖 GPUI。

use std::path::{Path, PathBuf};

use mn_core::atomic::{mtime_ms, path_mtime_ms, read_text, write_atomic};
use mn_core::frontmatter::FrontmatterValue;
use mn_core::scanner::{scan, EntryMeta, ScanOptions};
use mn_core::trash::{list_trash, move_to_trash, restore_from_trash, TrashRecord};
use mn_core::{
    frontmatter_body, parse_frontmatter, text_stats, Error, Result, VaultRoot,
    DEFAULT_MAX_READ_BYTES,
};
use mn_index::rename::{rename_note, RenameReport};
use mn_index::search::{SearchIndex, SearchOutcome};
use mn_index::{build_indexes, BuildOptions, LinkIndex, NoteLinks};

/// 从磁盘读出的一篇笔记。`mtime_ms` 是下一次保存要交回的令牌。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteDocument {
    pub rel_path: String,
    pub text: String,
    pub size_bytes: u64,
    pub mtime_ms: u64,
}

/// 当前笔记在侧栏 / 状态栏要显示的事实：属性、标签、反链、字数。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NotePanelData {
    pub words: usize,
    pub chars: usize,
    pub lines: usize,
    pub tags: Vec<String>,
    pub properties: Vec<(String, String)>,
    pub backlinks: Vec<String>,
}

/// 一个 Vault 的扫描结果、链接索引和全文索引。
pub struct VaultSession {
    root: VaultRoot,
    entries: Vec<EntryMeta>,
    links: LinkIndex,
    search_index: SearchIndex,
}

impl VaultSession {
    /// 打开 `path` 指向的目录，扫描 Markdown，并建好链接与全文索引。
    pub fn open(path: &Path) -> Result<Self> {
        let root = VaultRoot::open(path)?;
        let report = scan(root.path(), &ScanOptions::default())?;
        let search_index = SearchIndex::open_in_memory()?;
        let (links, outcome) = build_indexes(
            root.path(),
            &report.entries,
            &BuildOptions::default(),
            None,
            Some(&search_index),
            |_, _| {},
        );
        if let Some(built) = outcome.search.as_ref() {
            if built.aborted {
                return Err(Error::io(
                    root.path(),
                    std::io::Error::other("全文搜索索引没有提交"),
                ));
            }
            if let Some(error) = built.error.as_ref() {
                return Err(Error::io(root.path(), std::io::Error::other(error.clone())));
            }
        }
        Ok(Self {
            root,
            entries: report.entries,
            links,
            search_index,
        })
    }

    pub fn vault_name(&self) -> String {
        self.root.name()
    }

    pub fn root_path(&self) -> &Path {
        self.root.path()
    }

    pub fn entries(&self) -> &[EntryMeta] {
        &self.entries
    }

    /// 扫描到的 Markdown 笔记（含 `.md` / `.markdown`），顺序与扫描一致。
    pub fn notes(&self) -> Vec<&EntryMeta> {
        self.entries
            .iter()
            .filter(|entry| is_markdown(entry))
            .collect()
    }

    /// 读一篇笔记的原文和当前 mtime 令牌。
    pub fn read(&self, rel: &str) -> Result<NoteDocument> {
        let rel = normalize_rel(rel);
        let path = self.root.resolve_existing(&rel)?;
        let text = read_text(&path, DEFAULT_MAX_READ_BYTES)?;
        let meta = std::fs::metadata(&path).map_err(|error| Error::io(&path, error))?;
        if meta.is_dir() {
            return Err(Error::IsDirectory(rel));
        }
        Ok(NoteDocument {
            rel_path: rel,
            text,
            size_bytes: meta.len(),
            mtime_ms: mtime_ms(&meta).unwrap_or(0),
        })
    }

    /// 用 mtime 令牌保存。
    ///
    /// 令牌与磁盘上的 mtime 不一致时返回 `mn_core::Error::Conflict`，并且不调用原子写，
    /// 文件字节保持原样。这与桌面宿主 `note_write` 的临界区是同一条规则。
    /// `base_mtime_ms == None` 表示调用方已经确认覆盖。
    pub fn save(
        &mut self,
        rel: &str,
        text: &str,
        base_mtime_ms: Option<u64>,
    ) -> Result<NoteDocument> {
        let rel = normalize_rel(rel);
        let path = self.root.resolve_for_write(&rel)?;
        if path.is_dir() {
            return Err(Error::IsDirectory(rel));
        }
        if let Some(base) = base_mtime_ms {
            if let Some(current) = path_mtime_ms(&path)? {
                if current != base {
                    return Err(Error::Conflict {
                        current_mtime_ms: current,
                    });
                }
            }
        }

        write_atomic(&path, text.as_bytes())?;
        self.links.upsert(&rel, text);
        self.search_index.upsert_note(&rel, text)?;

        let meta = std::fs::metadata(&path).map_err(|error| Error::io(&path, error))?;
        let document = NoteDocument {
            rel_path: rel.clone(),
            text: text.to_string(),
            size_bytes: meta.len(),
            mtime_ms: mtime_ms(&meta).unwrap_or(0),
        };
        if let Some(entry) = self.entries.iter_mut().find(|entry| entry.rel_path == rel) {
            entry.size_bytes = document.size_bytes;
            entry.mtime_ms = Some(document.mtime_ms);
        } else {
            self.entries.push(EntryMeta {
                rel_path: rel,
                name: file_name_of(&document.rel_path),
                is_dir: false,
                size_bytes: document.size_bytes,
                mtime_ms: Some(document.mtime_ms),
                ext: ext_of(&document.rel_path),
            });
        }
        Ok(document)
    }

    pub fn search(&self, query: &str) -> Result<SearchOutcome> {
        self.search_index.search(query, 50)
    }

    /// 出链与反链，解析规则来自 `mn-index` 的 [`LinkIndex`]。
    pub fn note_links(&mut self, rel: &str) -> NoteLinks {
        self.links.note_links(&normalize_rel(rel))
    }

    /// 属性、标签、反链和字数。标签与反链来自 `mn-index`，属性来自 `mn-core` 的 frontmatter。
    pub fn panel(&mut self, rel: &str, text: &str) -> NotePanelData {
        let rel = normalize_rel(rel);
        let body = frontmatter_body(text);
        let stats = text_stats::stats(body);
        let tags = self
            .links
            .tags_of(&rel)
            .into_iter()
            .map(|tag| tag.tag)
            .collect();
        let properties = parse_frontmatter(text)
            .map(|frontmatter| {
                frontmatter
                    .fields
                    .into_iter()
                    .map(|field| (field.key, format_value(&field.value)))
                    .collect()
            })
            .unwrap_or_default();
        let backlinks = self
            .links
            .note_links(&rel)
            .backlinks
            .into_iter()
            .map(|link| link.from_rel_path)
            .collect();
        NotePanelData {
            words: stats.words,
            chars: stats.chars,
            lines: stats.lines,
            tags,
            properties,
            backlinks,
        }
    }

    /// 在库根新建一篇 Markdown。已有同名文件时返回 `ALREADY_EXISTS`，不覆盖。
    pub fn create_note(&mut self, title: &str) -> Result<NoteDocument> {
        let rel = note_rel_from_title(title)?;
        let path = self.root.resolve_for_write(&rel)?;
        if path.exists() {
            return Err(Error::AlreadyExists(rel));
        }
        let text = format!("# {}\n", display_name(file_name_of(&rel).as_str()));
        write_atomic(&path, text.as_bytes())?;
        self.links.upsert(&rel, &text);
        self.search_index.upsert_note(&rel, &text)?;
        self.refresh_entries()?;
        self.read(&rel)
    }

    /// 同目录改名，并让 `mn-index` 改写全库链接。
    pub fn rename_note(&mut self, rel: &str, new_title: &str) -> Result<RenameReport> {
        let report = rename_note(
            &self.root,
            &mut self.links,
            rel,
            new_title,
            true,
            Some(&self.search_index),
        )?;
        self.refresh_entries()?;
        Ok(report)
    }

    /// 移入 `.mimenote/trash`，并从链接、标签、搜索索引里去掉。
    pub fn trash_note(&mut self, rel: &str) -> Result<TrashRecord> {
        let rel = normalize_rel(rel);
        let record = move_to_trash(&self.root, &rel)?;
        self.links.remove(&rel);
        let _ = self.search_index.remove_note(&rel);
        self.refresh_entries()?;
        Ok(record)
    }

    pub fn trash(&self) -> Result<Vec<TrashRecord>> {
        list_trash(&self.root)
    }

    /// 按台账恢复到原位置，并重新收录正文。目标已存在时保持回收站原样。
    pub fn restore_note(&mut self, id: &str) -> Result<String> {
        let outcome = restore_from_trash(&self.root, id)?;
        let rel = outcome.restored_rel_path.clone();
        if !outcome.record.is_dir {
            if let Ok(document) = self.read(&rel) {
                self.links.upsert(&document.rel_path, &document.text);
                let _ = self
                    .search_index
                    .upsert_note(&document.rel_path, &document.text);
            }
        }
        self.refresh_entries()?;
        Ok(rel)
    }

    fn refresh_entries(&mut self) -> Result<()> {
        let report = scan(self.root.path(), &ScanOptions::default())?;
        self.entries = report.entries;
        Ok(())
    }
}

/// 界面上的笔记名：去掉 `.md` / `.markdown`，路径本身不变。
pub fn display_name(name: &str) -> String {
    for ext in [".markdown", ".md"] {
        if name.len() > ext.len() && name[name.len() - ext.len()..].eq_ignore_ascii_case(ext) {
            return name[..name.len() - ext.len()].to_string();
        }
    }
    name.to_string()
}

pub(crate) fn is_markdown(entry: &EntryMeta) -> bool {
    !entry.is_dir && matches!(entry.ext.as_deref(), Some("md" | "markdown"))
}

fn normalize_rel(rel: &str) -> String {
    rel.replace('\\', "/")
}

fn file_name_of(rel: &str) -> String {
    rel.rsplit('/').next().unwrap_or(rel).to_string()
}

fn ext_of(rel: &str) -> Option<String> {
    PathBuf::from(file_name_of(rel))
        .extension()
        .map(|ext| ext.to_string_lossy().to_lowercase())
}

fn note_rel_from_title(title: &str) -> Result<String> {
    let title = title.trim();
    if title.is_empty() {
        return Err(Error::invalid(title, "笔记名不能为空"));
    }
    if title.contains('/') || title.contains('\\') {
        return Err(Error::invalid(title, "笔记名不能包含路径分隔符"));
    }
    let rel = if title.len() > 3 && title[title.len() - 3..].eq_ignore_ascii_case(".md")
        || title.len() > 9 && title[title.len() - 9..].eq_ignore_ascii_case(".markdown")
    {
        title.to_string()
    } else {
        format!("{title}.md")
    };
    mn_core::path_guard::validate_relative_path(&rel)?;
    Ok(rel)
}

fn format_value(value: &FrontmatterValue) -> String {
    match value {
        FrontmatterValue::Scalar(text) | FrontmatterValue::Number(text) => text.clone(),
        FrontmatterValue::Bool(flag) => if *flag { "是" } else { "否" }.to_string(),
        FrontmatterValue::Null => "空".to_string(),
        FrontmatterValue::List(items) => items.join("、"),
        FrontmatterValue::Map(fields) => fields
            .iter()
            .map(|field| format!("{}={}", field.key, format_value(&field.value)))
            .collect::<Vec<_>>()
            .join("，"),
        FrontmatterValue::MapList(items) => format!("{} 项", items.len()),
    }
}
