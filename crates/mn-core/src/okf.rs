//! # OKF bundle 合规检查（Google Open Knowledge Format v0.2）
//!
//! 检查的是**一个目录**（bundle），不是单篇笔记：输入是 `(Vault 相对路径, 全文)` 列表，
//! 输出是逐条问题 + 整包是否合规。纯函数，不碰文件 —— 宿主命令与 CLI 共用同一份。
//!
//! 判据来源（v0.2 规范， additive，`type` 是唯一永远必填的键）：
//!
//! | 检查 | 级别 | 说明 |
//! | --- | --- | --- |
//! | 非保留 `.md` 缺 frontmatter / 解析不出 / 缺 `type` / `type` 为空 | Error | §11 合规的前两条；
//! | `index.md` 里一条可点链接都没有 | Warning | §8 要求 index 枚举内容，没有链接的 index 起不到渐进披露的作用；
//! | `log.md` | — | 可选（§7），不存在不算问题，存在也不校验"最新在前"（那是风格，不是合规）；
//! | 未知 `type` | — | **不是问题**：消费者必须容忍未知类型（规范原话）；
//! | 链接目标在包里找不到 | Error | §11 要求链接可达。判据是近似的（见 [`resolve_target`]）：
//! | | | 裸名按"文件名主干/全名"全库找（与宿主消歧的第一近似），相对路径按当前目录拼；
//! | | | 外链（带 scheme）、纯锚点、图片嵌入一律跳过 —— 它们本来就不指向概念；
//! | | | **悬空 wikilink 在 OKF 里就是不合规**（与本应用平时容忍悬空是两回事，
//! | | | 见下面的"房间里的大象"）；
//! | `okf_version` | — | 只认不验：根 `index.md` 声明了就信任（ BEST-effort 原则）；
//! | 保留文件名大小写 | — | `INDEX.md` 不算保留（规范按字面文件名），同样要求 `type`；
//!
//! ## 房间里的大象：悬空链接
//!
//! 本应用的日常语义里 `[[还没写的]]` 是"待建概念"，点一下就创建；但 OKF 合规要求
//! 所有链接可达 —— 同一个写法，两种语境下对错相反。所以检查器的定位是
//! "**发布前**的门禁"（发静态站点 / 交给 agent 消费之前跑一遍），而不是写作时的
//! 实时标红。调用方（CLI `okf check`、将来的导出前检查）负责选对时机。

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::frontmatter::parse as parse_frontmatter;
use crate::links::{extract_links, is_markdown_target, join_relative, LinkKind};

/// 保留文件名（OKF 规范字面量，大小写敏感）。
const INDEX_FILE: &str = "index.md";
const LOG_FILE: &str = "log.md";

/// 问题级别。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OkfSeverity {
    Error,
    Warning,
}

/// 一条合规问题。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OkfIssue {
    /// Vault 相对路径（POSIX 分隔）。
    pub rel_path: String,
    /// 1 起的行号（与文件无关的问题填 1）。
    pub line: u32,
    pub severity: OkfSeverity,
    pub kind: OkfIssueKind,
    /// 给人看的一句话（中文，含"怎么修"的方向）。
    pub message: String,
}

/// 问题种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OkfIssueKind {
    /// 非保留文件缺 frontmatter / 解析不出 / 缺 `type` / `type` 为空。
    MissingType,
    /// `index.md` 里没有可点链接。
    IndexWithoutLinks,
    /// 链接目标在包里找不到。
    DanglingLink,
}

/// 一次检查的结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OkfReport {
    /// 文件总数（只计 `.md`）。
    pub files: usize,
    /// 问题（按路径、行号排序，确定性输出）。
    pub issues: Vec<OkfIssue>,
    /// 是否合规：一条 Error 都没有（冗余字段，给 `--json` 的消费者省一次遍历）。
    pub conformant: bool,
}

impl OkfReport {
    /// Error 的条数（Warning 不计入合规判定，但照样列出来）。
    pub fn error_count(&self) -> usize {
        self.issues
            .iter()
            .filter(|issue| issue.severity == OkfSeverity::Error)
            .count()
    }
}

/// 检查一个 bundle（`(Vault 相对路径, 全文)` 列表，调用方负责列目录、读文件）。
///
/// 路径口径：POSIX 分隔，与 [`crate::scanner`] 一致；大小写按原样比对
/// （OKF 的 Concept ID 是路径，跨平台大小写问题由调用方在列目录时统一）。
pub fn check_bundle(files: &[(String, String)]) -> OkfReport {
    let notes: Vec<(&str, &str)> = files
        .iter()
        .filter(|(rel, _)| is_note_path(rel))
        .map(|(rel, text)| (rel.as_str(), text.as_str()))
        .collect();

    // 全库文件名索引（裸名解析用）：主干小写 → 路径们。
    let mut by_stem: HashMap<String, Vec<&str>> = HashMap::new();
    let mut by_path: HashSet<&str> = HashSet::new();
    for (rel, _) in &notes {
        by_path.insert(*rel);
        if let Some(stem) = file_stem(rel) {
            by_stem.entry(stem.to_lowercase()).or_default().push(rel);
        }
        by_stem.entry((*rel).to_lowercase()).or_default().push(rel);
    }

    let mut issues: Vec<OkfIssue> = Vec::new();
    for (rel, text) in &notes {
        let file_name = rel.rsplit('/').next().unwrap_or(rel);
        check_concept(rel, text, file_name, &mut issues);
        check_links(rel, text, &by_path, &by_stem, &mut issues);
    }

    issues.sort_by(|a, b| {
        (a.rel_path.clone(), a.line, kind_order(a.kind)).cmp(&(
            b.rel_path.clone(),
            b.line,
            kind_order(b.kind),
        ))
    });
    let conformant = !issues
        .iter()
        .any(|issue| issue.severity == OkfSeverity::Error);
    OkfReport {
        files: notes.len(),
        issues,
        conformant,
    }
}

fn kind_order(kind: OkfIssueKind) -> u8 {
    match kind {
        OkfIssueKind::MissingType => 0,
        OkfIssueKind::DanglingLink => 1,
        OkfIssueKind::IndexWithoutLinks => 2,
    }
}

/// 是否是笔记（`.md` / `.markdown`，大小写不敏感；目录/附件不算）。
fn is_note_path(rel: &str) -> bool {
    let lower = rel.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown")
}

/// 文件名主干（去扩展名；`index.md` → `index`）。
fn file_stem(rel: &str) -> Option<String> {
    let name = rel.rsplit('/').next()?;
    let stem = name
        .strip_suffix(".markdown")
        .or_else(|| name.strip_suffix(".md"))
        .or_else(|| name.strip_suffix(".MARKDOWN"))
        .or_else(|| name.strip_suffix(".MD"))?;
    Some(stem.to_string())
}

/// 概念文档检查：frontmatter + `type`（保留文件只查 index 结构）。
fn check_concept(rel: &str, text: &str, file_name: &str, issues: &mut Vec<OkfIssue>) {
    if file_name == INDEX_FILE {
        check_index(rel, text, issues);
        return;
    }
    if file_name == LOG_FILE {
        return;
    }
    match parse_frontmatter(text) {
        None => issues.push(OkfIssue {
            rel_path: rel.to_string(),
            line: 1,
            severity: OkfSeverity::Error,
            kind: OkfIssueKind::MissingType,
            message: "没有合法的 frontmatter（OKF 要求每个概念都有 `type` 字段）".to_string(),
        }),
        Some(frontmatter) => {
            let ok = frontmatter
                .get("type")
                .and_then(|value| value.as_str())
                .is_some_and(|value| !value.trim().is_empty());
            if !ok {
                issues.push(OkfIssue {
                    rel_path: rel.to_string(),
                    line: 1,
                    severity: OkfSeverity::Error,
                    kind: OkfIssueKind::MissingType,
                    message: "缺 `type` 字段（OKF 唯一必填的键）".to_string(),
                });
            }
        }
    }
}

/// `index.md` 轻量检查：没有可点链接就起不到渐进披露的作用（Warning）。
fn check_index(rel: &str, text: &str, issues: &mut Vec<OkfIssue>) {
    // frontmatter 跳过（根 index 允许带 `okf_version`，但那不是内容）
    let body = crate::frontmatter::body(text);
    let has_link = body.contains("](") || body.contains("[[");
    if !has_link {
        issues.push(OkfIssue {
            rel_path: rel.to_string(),
            line: 1,
            severity: OkfSeverity::Warning,
            kind: OkfIssueKind::IndexWithoutLinks,
            message: "index.md 里没有可点链接（渐进披露要求它枚举目录内容）".to_string(),
        });
    }
}

/// 链接可达检查（近似口径，见模块文档）。
fn check_links(
    rel: &str,
    text: &str,
    by_path: &HashSet<&str>,
    by_stem: &HashMap<String, Vec<&str>>,
    issues: &mut Vec<OkfIssue>,
) {
    let parent = rel.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");
    for link in extract_links(text) {
        // 只查"指向概念"的链接：嵌入的是附件、外链与纯锚点本来就不指向概念
        if link.kind == LinkKind::Embed {
            continue;
        }
        let raw = link.raw_target.trim();
        if raw.is_empty() || raw.starts_with('#') || raw.starts_with('^') || has_scheme(raw) {
            continue;
        }
        if !is_markdown_target(raw) {
            continue;
        }
        if resolve_target(parent, raw, by_path, by_stem).is_none() {
            issues.push(OkfIssue {
                rel_path: rel.to_string(),
                line: link.line,
                severity: OkfSeverity::Error,
                kind: OkfIssueKind::DanglingLink,
                message: format!("链接目标在包里找不到：{raw}"),
            });
        }
    }
}

/// 目标是否带 URI scheme（`http:`、`mailto:`……；与 `links::has_scheme` 同口径，
/// 那里是私有的，这里按"第一个 `/` 之前找冒号"复述一遍）。
fn has_scheme(target: &str) -> bool {
    let head = match target.find('/') {
        Some(index) => &target[..index],
        None => target,
    };
    let Some((scheme, _)) = head.split_once(':') else {
        return false;
    };
    let mut chars = scheme.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|current| current.is_ascii_alphanumeric() || matches!(current, '+' | '-' | '.'))
}

/// 近似解析：相对当前目录拼 → 全路径后缀 → 文件名主干/全名。
///
/// 带 `/` 的目标**不**按"当前目录 + 目标"拼接（`[[开发者手册/索引与搜索]]`
/// 这种写法在 OKF/Obsidian 口径里是"包内路径"，不是相对路径）：
/// 先试全路径与后缀，再退到主干。裸名才走"相对当前目录"那一档
/// （`[[设计文档]]` 在 `项目/` 里优先指同目录那篇，与宿主消歧的第一近似一致）。
fn resolve_target(
    parent: &str,
    raw: &str,
    by_path: &HashSet<&str>,
    by_stem: &HashMap<String, Vec<&str>>,
) -> Option<String> {
    let normalized = raw.trim().replace('\\', "/");
    let has_slash = normalized.contains('/');
    // 1. 裸名：先试"相对当前目录"（同目录优先）
    if !has_slash {
        if let Some(joined) = join_relative(parent, &normalized) {
            for candidate in [
                joined.clone(),
                format!("{joined}.md"),
                format!("{joined}.markdown"),
            ] {
                if by_path.contains(candidate.as_str()) {
                    return Some(candidate);
                }
            }
        }
    }
    // 2. 全路径 / 后缀（`a/b` 命中 `x/a/b.md`，大小写不敏感比对需要分配，包很小，直接做）
    let lowered = normalized.to_lowercase();
    let with_ext: Vec<String> = if lowered.ends_with(".md") || lowered.ends_with(".markdown") {
        vec![lowered.clone()]
    } else {
        vec![
            lowered.clone(),
            format!("{lowered}.md"),
            format!("{lowered}.markdown"),
        ]
    };
    // 收集候选时保留确定性顺序：按包内路径排序取第一条
    let mut suffix_hits: Vec<&str> = Vec::new();
    // by_path 是集合：迭代顺序不确定，先排好
    let mut sorted_paths: Vec<&&str> = by_path.iter().collect();
    sorted_paths.sort_unstable();
    for path in sorted_paths {
        let lower_path = path.to_lowercase();
        if with_ext.iter().any(|candidate| {
            &lower_path == candidate || lower_path.ends_with(&format!("/{candidate}"))
        }) {
            suffix_hits.push(path);
        }
    }
    if let Some(first) = suffix_hits.first() {
        return Some((*first).to_string());
    }
    // 3. 文件名主干 / 全名（`[[设计文档]]`、`[[设计文档.md]]` 同义）
    if let Some(hits) = by_stem.get(&lowered) {
        if let Some(first) = hits.first() {
            return Some((*first).to_string());
        }
    }
    let stem = normalized
        .rsplit('/')
        .next()
        .unwrap_or(&normalized)
        .strip_suffix(".markdown")
        .or_else(|| {
            normalized
                .rsplit('/')
                .next()
                .unwrap_or(&normalized)
                .strip_suffix(".md")
        })
        .unwrap_or(&normalized)
        .to_lowercase();
    by_stem
        .get(&stem)
        .and_then(|hits| hits.first())
        .map(|hit| (*hit).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundle(files: &[(&str, &str)]) -> OkfReport {
        check_bundle(
            &files
                .iter()
                .map(|(rel, text)| (rel.to_string(), text.to_string()))
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn conformant_bundle_passes() {
        let report = bundle(&[
            (
                "index.md",
                "---\nokf_version: \"0.2\"\n---\n\n# 索引\n\n- [甲](甲.md)\n",
            ),
            (
                "甲.md",
                "---\ntype: Reference\ntitle: 甲\ntags: [a]\n---\n\n见 [[乙]]。\n",
            ),
            ("子/乙.md", "---\ntype: Playbook\n---\n\n回链 [[甲]]。\n"),
        ]);
        assert!(report.conformant, "合规包不该有问题：{report:?}");
        assert_eq!(report.files, 3);
    }

    #[test]
    fn missing_type_is_an_error() {
        let report = bundle(&[
            ("甲.md", "# 没块\n"),
            ("乙.md", "---\ntitle: 没 type\n---\n"),
            ("丙.md", "---\ntype: \"\"\n---\n"),
            ("丁.md", "---\ntype: Note\n---\n"),
        ]);
        assert!(!report.conformant);
        assert_eq!(report.error_count(), 3);
        let paths: Vec<&str> = report
            .issues
            .iter()
            .map(|issue| issue.rel_path.as_str())
            .collect();
        // 按路径字节序排过（丁.md 有 type，不在里面）
        assert_eq!(paths, vec!["丙.md", "乙.md", "甲.md"]);
    }

    #[test]
    fn dangling_links_are_errors_but_embeds_and_external_are_skipped() {
        let report = bundle(&[
            (
                "甲.md",
                "---\ntype: Note\n---\n\n见 [[丢了]] 与 [外](https://x.com/a.md) 与 ![图](a.png) 与 [[#锚]]。\n",
            ),
            ("乙.md", "---\ntype: Note\n---\n\n见 [[甲]]。\n"),
        ]);
        assert!(!report.conformant);
        assert_eq!(report.issues.len(), 1);
        assert_eq!(report.issues[0].kind, OkfIssueKind::DanglingLink);
        assert!(report.issues[0].message.contains("丢了"));
    }

    #[test]
    fn unknown_types_and_log_files_are_fine() {
        let report = bundle(&[
            ("甲.md", "---\ntype: 自创类型\n---\n"),
            ("log.md", "随便写什么\n"),
        ]);
        assert!(
            report.conformant,
            "未知类型与 log.md 都不该算问题：{report:?}"
        );
    }

    #[test]
    fn index_without_links_warns_but_stays_conformant() {
        let report = bundle(&[("index.md", "# 光杆索引\n\n一句话。\n")]);
        assert!(report.conformant);
        assert_eq!(report.issues.len(), 1);
        assert_eq!(report.issues[0].kind, OkfIssueKind::IndexWithoutLinks);
    }

    #[test]
    fn non_markdown_files_are_ignored() {
        let report = bundle(&[
            ("图.png", "binary"),
            ("index.md", "- [甲](甲.md)\n"),
            ("甲.md", "---\ntype: Note\n---\n"),
        ]);
        assert!(report.conformant);
        assert_eq!(report.files, 2);
    }

    #[test]
    fn slash_targets_resolve_as_bundle_paths_not_relative_joins() {
        // `[[开发者手册/索引与搜索]]` 是"包内路径"，不能按"当前目录 + 目标"拼接
        // （拼出来是 `开发者手册/开发者手册/索引与搜索`，永远找不到）
        let report = bundle(&[
            (
                "开发者手册/架构总览.md",
                "---\ntype: Reference\n---\n\n见 [[开发者手册/索引与搜索]] 与 [[架构总览]]。\n",
            ),
            ("开发者手册/索引与搜索.md", "---\ntype: Reference\n---\n"),
        ]);
        assert!(report.conformant, "{report:?}");
    }
}
