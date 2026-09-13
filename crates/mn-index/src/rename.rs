//! 重命名的**链接精确改写**：改名之后，把全库指向旧路径的链接改成新目标。
//!
//! 为什么落在索引层而不是宿主（`docs/architecture.md` §2 第 3 条）：改写必须与索引的
//! 解析规则**完全一致** —— 判断"这条链接是不是指向它"用的是 [`LinkIndex`] 的消歧规则，
//! 两边一旦分家就会出现"反链面板能解析、改写后反而悬空"；而且"谁指向旧路径"只有索引
//! 知道，只能按候选集去读文件（1 万笔记场景**绝不**全库读文件）。
//!
//! 保真纪律（与保存链路同一条）：
//!
//! * BOM（`\u{feff}`）与换行风格（CRLF/LF）**原样保留** —— 处理时把 BOM 摘掉、写回时补上，
//!   正文按 `split_inclusive('\n')` 逐行处理并保留原行尾；
//! * 围栏代码块 / 行内代码 / 被转义的链接一律不动（`extract_links_with_spans` 已跳过，
//!   这里再补一层"回读校验"，见 [`replace_verified`]）；
//! * 同一行多条链接**从后往前**替换，前面的 span 才不会因长度变化而失效。

use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;

use mn_core::atomic::{read_text, write_atomic};
use mn_core::links::{extract_links_with_spans, normalize_target, replace_link_target, LinkSpan};
use mn_core::path_guard::{validate_relative_path, VaultRoot};
use mn_core::{Error, Result};

use crate::{parent_of, LinkIndex, SearchIndex};

/// 改写时单个文件的读取上限。
///
/// 刻意**不**复用 [`crate::MAX_INDEX_BYTES`]（4 MiB）：那是"索引要不要收录"的门槛，
/// 而改写要尽可能完整 —— 已经进了索引的文件不该因为体积大就留下指向旧名字的链接。
const MAX_REWRITE_BYTES: u64 = mn_core::DEFAULT_MAX_READ_BYTES;

/// UTF-8 BOM。它必须被原样保留，否则"改一次链接 = 首行 diff"。
const BOM: char = '\u{feff}';

/// 重命名的新旧相对路径（本轮范围：**同目录**、只换文件名）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenameTargets {
    /// 规范化（`/` 分隔）后的旧相对路径。
    pub old_rel: String,
    /// 新相对路径，扩展名沿用原文件。
    pub new_rel: String,
}

/// 某个文件里被改写掉的链接条数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkUpdate {
    /// 被改写的文件（路径口径见 [`RenameReport::updated_links`]）。
    pub rel_path: String,
    pub count: u32,
}

/// 一次重命名的完整结果（宿主据此拼 IPC DTO）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenameReport {
    pub old_rel_path: String,
    pub new_rel_path: String,
    /// 改名后磁盘上的 mtime 毫秒值（新的版本令牌）。
    pub mtime_ms: u64,
    /// 改名后的大小（宿主用它增量更新条目表，不重新扫描）。
    pub size_bytes: u64,
    /// 被改写了链接的文件，按 `rel_path` 字典序。
    ///
    /// **路径口径**：被改名的笔记**自身**若含自链接（`甲.md` 里的 `[[甲]]`），它的条目用
    /// **旧路径**报告 —— 前端要在"改名前的坐标系"里判断"我正在编辑的这一篇也被改写了，
    /// 得重新读取"（见 `app/actions.ts` 的 `rewritten.has(outcome.oldRelPath)`）。
    /// 其余文件的路径改名前后一致，两种口径没有区别。
    pub updated_links: Vec<LinkUpdate>,
    /// 被改写链接的总条数（`updated_links` 的 `count` 之和）。
    pub updated_link_count: u32,
    /// 整轮操作耗时（毫秒）。
    pub elapsed_ms: u64,
}

/// 校验重命名入参并算出新旧相对路径。
///
/// 规则（本轮**只支持同目录改名**）：
///
/// * `new_title` 不含扩展名（前端偶尔会连 `.md` 一起传，容忍并剥掉）、不含路径分隔符、
///   不含首尾空白；扩展名一律沿用原文件（`.md` / `.markdown` 原样保留大小写）；
/// * 目录重命名与跨目录移动不在本轮范围：标题里出现分隔符直接判 `PATH_INVALID`；
/// * 文件名合法性（Windows 禁用字符、保留名、尾随点/空格）复用路径防护的段级校验。
pub fn rename_targets(old_rel_path: &str, new_title: &str) -> Result<RenameTargets> {
    let old_rel = old_rel_path.trim().replace('\\', "/");
    validate_relative_path(&old_rel)?;

    if new_title != new_title.trim() {
        return Err(Error::invalid(new_title, "新名字不能带首尾空白"));
    }
    let title = new_title.trim();
    if title.is_empty() {
        return Err(Error::invalid(new_title, "新名字为空"));
    }
    if title.contains('/') || title.contains('\\') {
        return Err(Error::invalid(
            title,
            "新名字不能包含路径分隔符（本轮只支持同目录改名）",
        ));
    }
    let stem = strip_note_extension(title);
    if stem.trim_matches([' ', '.']).is_empty() {
        return Err(Error::invalid(title, "新名字不能只由点或空格组成"));
    }

    let (dir, name) = split_dir(&old_rel);
    let new_name = format!("{stem}{}", extension_of(name));
    let new_rel = if dir.is_empty() {
        new_name
    } else {
        format!("{dir}/{new_name}")
    };
    validate_relative_path(&new_rel)?;

    Ok(RenameTargets { old_rel, new_rel })
}

/// 执行"同目录改名 + 全库链接精确改写"，并把 [`LinkIndex`] 同步到新状态。
///
/// 调用方（宿主）只负责：拿写锁、把参数从 IPC 搬过来。业务判断全在这里。
///
/// `search` 是全文搜索索引（可选）：给了就顺带把路径搬过去、并把被改写文件的新文本重新入库。
/// 搜索是不可重建的**派生**数据里最不重要的那一份，因此它的失败只记日志、不影响改名结果。
///
/// 阶段顺序是刻意的：
///
/// 1. **先算改写计划**：此时索引里还是旧名字，才能用同一套解析规则找出"谁指向它"；
/// 2. **再改名**：`fs::rename`，同目录 → 原子，不留半截文件；
/// 3. **再写回**被改写的文件（逐个 `write_atomic`）；
/// 4. **最后同步索引**：旧路径移除、新路径写入、被改写文件逐个 upsert —— 反链面板
///    不必等重扫就能立刻正确。
///
/// 部分失败：某个被改写文件写失败时**不回滚改名**（文件名已经改了，回滚只会制造更大的
/// 不一致），只记日志并把它排除出 `updated_links`。只有当改名本身失败才返回错误。
pub fn rename_note(
    root: &VaultRoot,
    index: &mut LinkIndex,
    old_rel_path: &str,
    new_title: &str,
    update_links: bool,
    search: Option<&SearchIndex>,
) -> Result<RenameReport> {
    let started = Instant::now();
    let targets = rename_targets(old_rel_path, new_title)?;
    let old_rel = targets.old_rel;
    let new_rel = targets.new_rel;

    let old_path = root.resolve_existing(&old_rel)?;
    let old_meta = std::fs::metadata(&old_path).map_err(|e| Error::io(&old_path, e))?;
    if old_meta.is_dir() {
        // 目录重命名（连同整棵子树的链接改写）是另一件事，本轮明确不做
        return Err(Error::IsDirectory(old_rel));
    }

    if old_rel == new_rel {
        // 名字没变：什么都不用做（也顺手避开各平台"rename 到自身路径"的语义差异）
        return Ok(RenameReport {
            old_rel_path: old_rel,
            new_rel_path: new_rel,
            mtime_ms: mn_core::atomic::mtime_ms(&old_meta).unwrap_or(0),
            size_bytes: old_meta.len(),
            updated_links: Vec::new(),
            updated_link_count: 0,
            elapsed_ms: started.elapsed().as_millis() as u64,
        });
    }

    let new_path = root.resolve_for_write(&new_rel)?;
    if occupied_by_other(&old_path, &new_path) {
        return Err(Error::AlreadyExists(new_rel));
    }

    // 1) 计划（只读候选集文件，不落盘）
    let plan = if update_links {
        plan_rewrites(root, index, &old_rel, &new_rel)
    } else {
        Vec::new()
    };

    // 计划阶段可能读了若干文件；改名前的最后一刻再确认目标没被外部创建 ——
    // Windows 上 `fs::rename` 是"替换已存在目标"语义，宁可在这里保守拦一次。
    if occupied_by_other(&old_path, &new_path) {
        return Err(Error::AlreadyExists(new_rel));
    }

    // 2) 改名：同目录 rename 是原子的
    std::fs::rename(&old_path, &new_path).map_err(|e| Error::io(&new_path, e))?;

    // 全文搜索：把行搬到新路径（`rel_path` 不是 FTS 列，所以不必重建索引）
    if let Some(search) = search {
        if let Err(error) = search.rename_note(&old_rel, &new_rel) {
            log::warn!("全文搜索索引改名失败（{old_rel} → {new_rel}）：{error}");
        }
    }

    // 3) 写回被改写的文件
    let mut updated_links: Vec<LinkUpdate> = Vec::new();
    let mut updated_link_count = 0u32;
    for item in &plan {
        // 被改名文件自身的改写要落到**新路径**上
        let rel_after = if item.rel_path == old_rel {
            new_rel.clone()
        } else {
            item.rel_path.clone()
        };
        let path = match root.resolve_for_write(&rel_after) {
            Ok(path) => path,
            Err(error) => {
                log::warn!("重命名改写跳过 {rel_after}：{error}");
                continue;
            }
        };
        match write_atomic(&path, item.new_text.as_bytes()) {
            Ok(()) => {
                updated_links.push(LinkUpdate {
                    rel_path: item.rel_path.clone(),
                    count: item.count,
                });
                updated_link_count += item.count;
                index.upsert(&rel_after, &item.new_text);
                // 被改写的文件正文变了（链接目标变了），全文搜索的行要跟着重写
                if let Some(search) = search {
                    if let Err(error) = search.upsert_note(&rel_after, &item.new_text) {
                        log::warn!("全文搜索索引更新失败（{rel_after}）：{error}");
                    }
                }
            }
            Err(error) => {
                // 不回滚改名：只把这一篇排除出结果（前端会照常显示改名成功）
                log::warn!("重命名改写失败（已跳过，不回滚改名）：{rel_after}：{error}");
            }
        }
    }
    updated_links.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));

    // 4) 索引同步：旧路径必须消失、新路径立刻可查。
    //    收录范围保持不变：原路径本来就不在索引里（附件、超大文件……）时不要因为改名把它塞进去，
    //    否则 `[[图2]]` 这类裸名链接会被一个 png 劫持。
    let was_indexed = index.contains(&old_rel);
    index.remove(&old_rel);
    if was_indexed {
        let renamed_text = read_text(&new_path, MAX_REWRITE_BYTES).unwrap_or_else(|error| {
            log::warn!("改名后读取 {new_rel} 失败，索引退回按计划文本更新：{error}");
            plan.iter()
                .find(|item| item.rel_path == old_rel)
                .map(|item| item.new_text.clone())
                .unwrap_or_default()
        });
        index.upsert(&new_rel, &renamed_text);
    }

    // 5) 版本令牌与大小取"全部改写之后"的磁盘状态：被改名文件自身也可能在上一步被改写，
    //    在那之前取值会让前端拿到过期的基线（下一次保存必报 CONFLICT）。
    let new_meta = std::fs::metadata(&new_path).map_err(|e| Error::io(&new_path, e))?;
    let mtime_ms = mn_core::atomic::mtime_ms(&new_meta).unwrap_or(0);
    let size_bytes = new_meta.len();

    let elapsed_ms = started.elapsed().as_millis() as u64;
    log::info!(
        "重命名：{old_rel} → {new_rel}（改写 {} 个文件 / {} 条链接，耗时 {elapsed_ms}ms）",
        updated_links.len(),
        updated_link_count
    );

    Ok(RenameReport {
        old_rel_path: old_rel,
        new_rel_path: new_rel,
        mtime_ms,
        size_bytes,
        updated_links,
        updated_link_count,
        elapsed_ms,
    })
}

// ---------------------------------------------------------------------------
// 改写计划
// ---------------------------------------------------------------------------

/// 一条待落盘的改写。
#[derive(Debug, Clone)]
struct PlannedRewrite {
    /// 改写前的相对路径。
    rel_path: String,
    /// 改写后的完整文本（BOM 与行尾原样保留）。
    new_text: String,
    /// 该文件里被改写的链接条数。
    count: u32,
}

/// "新目标怎么写"的全部描述（归拢成一处，避免到处传六个参数）。
struct TargetStyle<'a> {
    /// 新目标相对路径（去扩展名）—— 路径形式的链接用它做相对路径换算。
    new_rel_no_ext: &'a str,
    /// 新文件名主干。
    new_stem: &'a str,
    /// 新文件扩展名（含点；无扩展名时为空串）。
    new_ext: &'a str,
}

/// 只读地算出改写计划：**只碰候选集**（出链解析到旧路径的那些文件）。
fn plan_rewrites(
    root: &VaultRoot,
    index: &LinkIndex,
    old_rel: &str,
    new_rel: &str,
) -> Vec<PlannedRewrite> {
    // 主干取的是**新文件名去掉末尾 `.md`/`.markdown`**，而不是 `stem_of`（后者在最后一个
    // 点处切分，会把 `v1.2.md` 的主干算成 `v1`）。
    let style = TargetStyle {
        new_rel_no_ext: strip_extension(new_rel),
        new_stem: strip_extension(file_name_of(new_rel)),
        new_ext: extension_of(file_name_of(new_rel)),
    };

    let mut planned = Vec::new();
    for from_rel in index.referrers_of(old_rel) {
        let path = match root.resolve_existing(&from_rel) {
            Ok(path) => path,
            Err(error) => {
                log::warn!("重命名改写跳过 {from_rel}：{error}");
                continue;
            }
        };
        let text = match read_text(&path, MAX_REWRITE_BYTES) {
            Ok(text) => text,
            Err(error) => {
                log::warn!("重命名改写跳过 {from_rel}：{error}");
                continue;
            }
        };
        let (new_text, count) = rewrite_text(index, &text, &from_rel, old_rel, &style);
        if count > 0 {
            planned.push(PlannedRewrite {
                rel_path: from_rel,
                new_text,
                count,
            });
        }
    }
    planned
}

/// 改写一篇文件里所有指向旧路径的链接，返回（新文本，改写条数）。
fn rewrite_text(
    index: &LinkIndex,
    text: &str,
    from_rel: &str,
    old_rel: &str,
    style: &TargetStyle<'_>,
) -> (String, u32) {
    // BOM 摘出去单独处理：正文里不出现它，写回时再补上
    let (bom, body) = match text.strip_prefix(BOM) {
        Some(rest) => (BOM.to_string(), rest),
        None => (String::new(), text),
    };

    // 必须**整篇一次**抽取：围栏代码块的开关状态要跨行保持 —— 逐行抽取会把代码块里的
    // `[[x]]` 当成真链接改掉（那正是要避免的事）。
    let mut by_line: HashMap<u32, Vec<(String, LinkSpan)>> = HashMap::new();
    for (link, span) in extract_links_with_spans(body) {
        // `[[#小节]]` 这类纯锚点链接指的是文件自身，改名后依旧成立，不需要改（也改不了）
        if link.raw_target.trim().is_empty() {
            continue;
        }
        // 用索引的解析规则判断"这条链接是不是指向它"：必须与反链面板看到的一致
        if index.resolve(from_rel, &link.raw_target).as_deref() != Some(old_rel) {
            continue;
        }
        by_line
            .entry(span.line)
            .or_default()
            .push((link.raw_target, span));
    }
    if by_line.is_empty() {
        return (text.to_string(), 0);
    }

    let from_dir = parent_of(from_rel);
    let mut out = String::with_capacity(body.len() + 16);
    let mut count = 0u32;

    for (position, raw_line) in body.split_inclusive('\n').enumerate() {
        let line_no = (position + 1) as u32;
        let Some(items) = by_line.get(&line_no) else {
            out.push_str(raw_line);
            continue;
        };

        let (content, ending) = split_line_ending(raw_line);
        let mut line = content.to_string();
        // 同一行多条链接：从后往前替换，前面的 span 才不会失效
        for (raw_target, span) in items.iter().rev() {
            let target = new_target_for(raw_target, &line, span, &from_dir, style);
            match replace_verified(&line, span, &target) {
                Some(replaced) => {
                    line = replaced;
                    count += 1;
                }
                None => log::warn!(
                    "重命名改写跳过 {from_rel} 第 {line_no} 行的链接（`{raw_target}` → `{target}` 无法安全替换）"
                ),
            }
        }
        out.push_str(&line);
        out.push_str(ending);
    }

    if count == 0 {
        // 一条都没改成（全部无法安全替换）→ 原样返回，绝不写出"半改写"的文件
        return (text.to_string(), 0);
    }
    (format!("{bom}{out}"), count)
}

/// 算出新目标文本（保持用户原有的写法风格，最小 diff）：
///
/// * 原目标不含 `/`（裸名）→ 只用**新文件名主干**；
/// * 原目标含路径（`/`、`./`、`../`）→ 用**相对链接所在文件目录**的 POSIX 相对路径（去扩展名）；
/// * 原目标显式写了 `.md` / `.markdown`（且是 Markdown 形式）→ 保留扩展名写法；
/// * `[[x]]` 形式不加扩展名（`[[x.md]]` 不是惯例）。
fn new_target_for(
    raw_target: &str,
    line: &str,
    span: &LinkSpan,
    from_dir: &str,
    style: &TargetStyle<'_>,
) -> String {
    let mut target = if normalize_target(raw_target).contains('/') {
        relative_posix(from_dir, style.new_rel_no_ext)
    } else {
        style.new_stem.to_string()
    };
    if !is_wiki_syntax(line, span) && has_note_extension(raw_target) && !style.new_ext.is_empty() {
        target.push_str(style.new_ext);
    }
    target
}

/// 替换目标文本并**回读校验**：换完之后，这个位置上必须还是一条目标恰好等于
/// `new_target` 的链接。
///
/// 为什么需要校验：新目标含空格时，没加 `<>` 的 Markdown 链接会被解析截断
/// （`[x](新 名.md)` 只认到 `新`），而 `replace_link_target` 只负责替换目标区、
/// 不会自己补尖括号。于是这里先试原样、再试 `<>` 包裹，取第一个能通过校验的。
/// 两个都过不了（例如文件名里含 `#`/`^`，wikilink 语法根本无法表达）就返回 `None`，
/// 由调用方**跳过并记日志**，而不是写出一个必然悬空的链接。
fn replace_verified(line: &str, span: &LinkSpan, new_target: &str) -> Option<String> {
    for candidate in [new_target.to_string(), format!("<{new_target}>")] {
        if let Some(replaced) = replace_link_target(line, span, &candidate) {
            if still_points_at(&replaced, span, new_target) {
                return Some(replaced);
            }
        }
    }
    None
}

/// 替换后该位置上是否是一条解析结果为 `expected` 的链接。
fn still_points_at(line: &str, span: &LinkSpan, expected: &str) -> bool {
    extract_links_with_spans(line)
        .into_iter()
        .any(|(link, found)| found.char_start == span.char_start && link.raw_target == expected)
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/// 从 `from_dir` 到 `to_rel` 的 POSIX 相对路径（用 `..` 走位，带 `/` 分隔）。
fn relative_posix(from_dir: &str, to_rel: &str) -> String {
    let from: Vec<&str> = from_dir
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    let to: Vec<&str> = to_rel.split('/').filter(|part| !part.is_empty()).collect();
    let common = from
        .iter()
        .zip(to.iter())
        .take_while(|(a, b)| a == b)
        .count();

    let mut parts: Vec<&str> = Vec::new();
    parts.extend(std::iter::repeat_n("..", from.len() - common));
    parts.extend(to[common..].iter().copied());
    parts.join("/")
}

/// 目标是否写成了 `[[..]]`（`![[..]]` 也算）—— 只有 Markdown 形式才沿用扩展名写法。
fn is_wiki_syntax(line: &str, span: &LinkSpan) -> bool {
    let chars: Vec<char> = line.chars().collect();
    match chars.get(span.char_start) {
        Some('[') => chars.get(span.char_start + 1) == Some(&'['),
        Some('!') => chars.get(span.char_start + 2) == Some(&'['),
        _ => false,
    }
}

/// 原目标是否显式写了 `.md` / `.markdown` 后缀。
fn has_note_extension(raw: &str) -> bool {
    let lowered = raw.trim().to_ascii_lowercase();
    lowered.ends_with(".md") || lowered.ends_with(".markdown")
}

/// 拆出行内容与行尾（`\r\n` / `\n` 原样保留；没有行尾时返回空串）。
fn split_line_ending(raw: &str) -> (&str, &str) {
    if let Some(body) = raw.strip_suffix("\r\n") {
        (body, "\r\n")
    } else if let Some(body) = raw.strip_suffix('\n') {
        (body, "\n")
    } else {
        (raw, "")
    }
}

/// 目录与文件名：`a/b/c.md` → `("a/b", "c.md")`。
fn split_dir(rel: &str) -> (&str, &str) {
    match rel.rfind('/') {
        Some(index) => (&rel[..index], &rel[index + 1..]),
        None => ("", rel),
    }
}

/// 文件名部分：`a/b/c.md` → `c.md`。
fn file_name_of(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap_or(rel)
}

/// 扩展名（含点）；没有扩展名与 dotfile（`.gitignore`）都返回空串。
fn extension_of(name: &str) -> &str {
    match name.rfind('.') {
        Some(index) if index > 0 => &name[index..],
        _ => "",
    }
}

/// 去掉末尾的 `.md` / `.markdown`（其余点保留：`v1.2.md` → `v1.2`）。
fn strip_extension(rel: &str) -> &str {
    let lowered = rel.to_ascii_lowercase();
    if lowered.ends_with(".markdown") {
        &rel[..rel.len() - ".markdown".len()]
    } else if lowered.ends_with(".md") {
        &rel[..rel.len() - ".md".len()]
    } else {
        rel
    }
}

/// 用户传的标题可能连扩展名一起带（`新名.md`）；真扩展名一律以**原文件**为准。
fn strip_note_extension(title: &str) -> &str {
    let lowered = title.to_ascii_lowercase();
    if lowered.ends_with(".markdown") {
        &title[..title.len() - ".markdown".len()]
    } else if lowered.ends_with(".md") {
        &title[..title.len() - ".md".len()]
    } else {
        title
    }
}

/// 目标路径是否被**别的文件**占用。
///
/// 仅大小写差异（Windows/macOS 大小写不敏感）是同一个文件，必须放行 ——
/// 所以不能用字符串比较，要比 canonicalize 之后的真实路径。
fn occupied_by_other(old_path: &Path, new_path: &Path) -> bool {
    if !new_path.exists() {
        return false;
    }
    match (old_path.canonicalize(), new_path.canonicalize()) {
        (Ok(current), Ok(target)) => current != target,
        // 拿不到真实路径时保守判为占用（宁可报"已存在"，也不覆盖别人的文件）
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{build_index, BuildOptions};
    use mn_core::scanner::{scan, ScanOptions};
    use mn_core::ErrorCode;

    /// 建一个临时 Vault：写盘 → 扫描 → 建索引（与 App 启动时走的是同一条路）。
    fn vault(files: &[(&str, &str)]) -> (tempfile::TempDir, VaultRoot, LinkIndex) {
        let dir = tempfile::tempdir().unwrap();
        for (rel, text) in files {
            let path = dir
                .path()
                .join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(&path, text.as_bytes()).unwrap();
        }
        let root = VaultRoot::open(dir.path()).unwrap();
        let report = scan(root.path(), &ScanOptions::default()).unwrap();
        let (index, _) = build_index(
            root.path(),
            &report.entries,
            &BuildOptions::default(),
            None,
            |_done, _total| {},
        );
        (dir, root, index)
    }

    fn read(dir: &Path, rel: &str) -> String {
        std::fs::read_to_string(dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR))).unwrap()
    }

    fn entry(rel: &str, count: u32) -> LinkUpdate {
        LinkUpdate {
            rel_path: rel.to_string(),
            count,
        }
    }

    // -- 目标文本规则 -------------------------------------------------------

    #[test]
    fn rewrites_bare_name_link_and_syncs_index() {
        let (dir, root, mut index) = vault(&[("甲.md", "见 [[乙]] 结束\n"), ("乙.md", "# 乙\n")]);
        let report = rename_note(&root, &mut index, "乙.md", "丙", true, None).unwrap();

        assert_eq!(report.old_rel_path, "乙.md");
        assert_eq!(report.new_rel_path, "丙.md");
        assert_eq!(report.updated_links, vec![entry("甲.md", 1)]);
        assert_eq!(report.updated_link_count, 1);
        assert_eq!(
            report.size_bytes,
            "# 乙\n".len() as u64,
            "改名后的大小要能直接喂给条目表"
        );
        assert!(report.mtime_ms > 0);
        assert!(report.elapsed_ms <= 60_000);
        assert_eq!(read(dir.path(), "甲.md"), "见 [[丙]] 结束\n");
        assert!(dir.path().join("丙.md").exists());
        assert!(!dir.path().join("乙.md").exists());

        // 索引必须立刻正确：旧路径消失、新路径可查、反链跟着走（不必等重扫）
        assert!(!index.contains("乙.md"));
        assert!(index.contains("丙.md"));
        assert!(index.backlinks_of("乙.md").is_empty());
        let backlinks = index.note_links("丙.md").backlinks;
        assert_eq!(backlinks.len(), 1);
        assert_eq!(backlinks[0].from_rel_path, "甲.md");
    }

    #[test]
    fn rewrites_path_targets_as_posix_relative_paths() {
        let (dir, root, mut index) = vault(&[
            ("笔记/甲.md", "[看这里](../别的/乙.md)\n"),
            ("别的/丙.md", "[[别的/乙]]\n"),
            ("深/层/引用.md", "[[别的/乙]]\n"),
            ("别的/乙.md", "# 乙\n"),
        ]);
        let report = rename_note(&root, &mut index, "别的/乙.md", "新名", true, None).unwrap();

        assert_eq!(report.new_rel_path, "别的/新名.md");
        assert_eq!(
            read(dir.path(), "笔记/甲.md"),
            "[看这里](../别的/新名.md)\n"
        );
        // 同目录的相对路径就是裸文件名（最小 diff），跨目录才走 `..`
        assert_eq!(read(dir.path(), "别的/丙.md"), "[[新名]]\n");
        assert_eq!(read(dir.path(), "深/层/引用.md"), "[[../../别的/新名]]\n");
        assert_eq!(report.updated_link_count, 3);

        let paths: Vec<String> = report
            .updated_links
            .iter()
            .map(|item| item.rel_path.clone())
            .collect();
        let mut sorted = paths.clone();
        sorted.sort();
        assert_eq!(paths, sorted, "updated_links 必须按 rel_path 字典序");
        assert_eq!(paths.len(), 3);
    }

    #[test]
    fn keeps_alias_anchor_and_markdown_extension_style() {
        let (dir, root, mut index) = vault(&[
            (
                "甲.md",
                "[[乙|别名]] 与 [[乙#小节]] 与 ![[乙^块]] 与 [文本](乙.md) 与 [[乙.md]]\n",
            ),
            ("乙.md", "# 乙\n"),
        ]);
        let report = rename_note(&root, &mut index, "乙.md", "丙", true, None).unwrap();

        assert_eq!(
            read(dir.path(), "甲.md"),
            "[[丙|别名]] 与 [[丙#小节]] 与 ![[丙^块]] 与 [文本](丙.md) 与 [[丙]]\n"
        );
        assert_eq!(report.updated_links, vec![entry("甲.md", 5)]);
        assert_eq!(report.updated_link_count, 5);
    }

    #[test]
    fn rewrites_all_links_on_one_line_from_right_to_left() {
        let (dir, root, mut index) = vault(&[
            ("甲.md", "[[乙]] 与 [乙](乙.md) 与 [[乙|别名]]\n"),
            ("乙.md", ""),
        ]);
        let report = rename_note(&root, &mut index, "乙.md", "更长的新名字", true, None).unwrap();

        assert_eq!(
            read(dir.path(), "甲.md"),
            "[[更长的新名字]] 与 [乙](更长的新名字.md) 与 [[更长的新名字|别名]]\n"
        );
        assert_eq!(report.updated_link_count, 3);
    }

    #[test]
    fn wraps_markdown_target_in_angle_brackets_when_needed() {
        let (dir, root, mut index) = vault(&[
            ("甲.md", "[x](子/乙.md) 与 [y](<子/乙.md>)\n"),
            ("子/乙.md", ""),
        ]);
        let report = rename_note(&root, &mut index, "子/乙.md", "丙 丁", true, None).unwrap();

        assert_eq!(
            read(dir.path(), "甲.md"),
            "[x](<子/丙 丁.md>) 与 [y](<子/丙 丁.md>)\n",
            "含空格的目标必须带 `<>`，否则解析会在空格处截断"
        );
        assert_eq!(report.updated_link_count, 2);
    }

    #[test]
    fn keeps_dots_inside_the_new_file_name() {
        let (dir, root, mut index) =
            vault(&[("甲.md", "[[乙]] 与 [x](子/乙.md)\n"), ("子/乙.md", "")]);
        let report = rename_note(&root, &mut index, "子/乙.md", "v1.2", true, None).unwrap();

        assert_eq!(report.new_rel_path, "子/v1.2.md");
        assert_eq!(
            read(dir.path(), "甲.md"),
            "[[v1.2]] 与 [x](子/v1.2.md)\n",
            "主干是「去掉末尾 .md 的文件名」，不是「最后一个点之前的部分」"
        );
    }

    #[test]
    fn skips_targets_that_wikilink_syntax_cannot_express() {
        let (dir, root, mut index) = vault(&[("甲.md", "[[乙]]\n"), ("乙.md", "")]);
        let report = rename_note(&root, &mut index, "乙.md", "丙#丁", true, None).unwrap();

        assert_eq!(report.new_rel_path, "丙#丁.md");
        assert!(
            report.updated_links.is_empty(),
            "改不成就不改：绝不写出一个必然悬空的链接"
        );
        assert_eq!(report.updated_link_count, 0);
        assert_eq!(read(dir.path(), "甲.md"), "[[乙]]\n");
    }

    // -- 不该动的东西 -------------------------------------------------------

    #[test]
    fn leaves_code_blocks_inline_code_and_escapes_untouched() {
        let original = "# 标题\n\n```text\n[[乙]]\n```\n\n~~~\n[乙](乙.md)\n~~~\n\n行内 `[[乙]]` 与 `[x](乙.md)` 结束\n\n转义 \\[[乙]] 也保留\n\n真的 [[乙]]\n";
        let (dir, root, mut index) = vault(&[("甲.md", original), ("乙.md", "")]);
        let report = rename_note(&root, &mut index, "乙.md", "丙", true, None).unwrap();

        let expected = original.replace("真的 [[乙]]", "真的 [[丙]]");
        assert_eq!(read(dir.path(), "甲.md"), expected);
        assert_eq!(report.updated_link_count, 1, "只有正文里那一条是真链接");
    }

    #[test]
    fn does_not_touch_links_that_only_look_similar() {
        let (dir, root, mut index) = vault(&[
            ("甲.md", "自指 [[甲]] 与 [[甲虫]] 与 [[甲虫.md]]\n"),
            ("甲虫.md", "# 甲虫\n"),
        ]);
        let report = rename_note(&root, &mut index, "甲.md", "甲新", true, None).unwrap();

        assert_eq!(
            read(dir.path(), "甲新.md"),
            "自指 [[甲新]] 与 [[甲虫]] 与 [[甲虫.md]]\n"
        );
        // 被改名文件自身的自链接：条目按**旧路径**报告（前端要在改名前的坐标系里识别它）
        assert_eq!(report.updated_links, vec![entry("甲.md", 1)]);
        assert_eq!(report.new_rel_path, "甲新.md");
        // mtime 必须是**改写之后**的磁盘状态，否则前端刚拿到手就已经过期
        let disk_mtime = mn_core::atomic::path_mtime_ms(&dir.path().join("甲新.md"))
            .unwrap()
            .unwrap();
        assert_eq!(report.mtime_ms, disk_mtime, "自链接改写后 mtime 必须重新取");
        let links = index.note_links("甲新.md");
        assert_eq!(
            links.outbound[0].resolved_rel_path.as_deref(),
            Some("甲新.md"),
            "自链接改名后仍然指向自己（索引必须用改写后的文本重建）"
        );
        assert_eq!(
            links.outbound[1].resolved_rel_path.as_deref(),
            Some("甲虫.md")
        );
        assert_eq!(links.unresolved_count, 0);
        assert!(index.contains("甲虫.md"));
    }

    // -- 保真 ---------------------------------------------------------------

    #[test]
    fn preserves_crlf_line_endings() {
        let (dir, root, mut index) = vault(&[
            ("甲.md", "行一\r\n[[乙]] 与 [x](乙.md)\r\n行三\r\n"),
            ("乙.md", ""),
        ]);
        let report = rename_note(&root, &mut index, "乙.md", "丙", true, None).unwrap();

        assert_eq!(
            read(dir.path(), "甲.md"),
            "行一\r\n[[丙]] 与 [x](丙.md)\r\n行三\r\n"
        );
        assert_eq!(report.updated_link_count, 2);
    }

    #[test]
    fn preserves_utf8_bom() {
        let (dir, root, mut index) =
            vault(&[("甲.md", "\u{feff}# 标题\r\n[[乙]]\r\n"), ("乙.md", "")]);
        rename_note(&root, &mut index, "乙.md", "丙", true, None).unwrap();

        assert_eq!(read(dir.path(), "甲.md"), "\u{feff}# 标题\r\n[[丙]]\r\n");
        let bytes = std::fs::read(dir.path().join("甲.md")).unwrap();
        assert_eq!(&bytes[..3], &[0xEF, 0xBB, 0xBF], "BOM 必须原样保留");
    }

    #[test]
    fn keeps_bom_and_lf_when_there_is_no_bom() {
        let (dir, root, mut index) = vault(&[("甲.md", "# 标题\n[[乙]]\n"), ("乙.md", "")]);
        rename_note(&root, &mut index, "乙.md", "丙", true, None).unwrap();

        let bytes = std::fs::read(dir.path().join("甲.md")).unwrap();
        assert_eq!(bytes, "# 标题\n[[丙]]\n".as_bytes());
    }

    // -- 改名本身 -----------------------------------------------------------

    #[test]
    fn rejects_missing_source_and_directory() {
        let (dir, root, mut index) = vault(&[("乙.md", ""), ("目录/里面的.md", "")]);
        assert_eq!(
            rename_note(&root, &mut index, "不存在.md", "丙", true, None)
                .unwrap_err()
                .code(),
            ErrorCode::NotFound
        );
        assert_eq!(
            rename_note(&root, &mut index, "目录", "丙", true, None)
                .unwrap_err()
                .code(),
            ErrorCode::IsDirectory
        );
        assert!(dir.path().join("目录").is_dir(), "目录必须原样留着");
    }

    #[test]
    fn rejects_existing_target_without_touching_anything() {
        let (dir, root, mut index) =
            vault(&[("甲.md", "[[乙]]\n"), ("乙.md", ""), ("目标.md", "")]);
        let error = rename_note(&root, &mut index, "乙.md", "目标", true, None).unwrap_err();

        assert_eq!(error.code(), ErrorCode::AlreadyExists);
        assert!(dir.path().join("乙.md").exists(), "失败时源文件不能被动过");
        assert_eq!(
            read(dir.path(), "甲.md"),
            "[[乙]]\n",
            "失败时链接不能被动过"
        );
    }

    #[test]
    fn allows_case_only_rename() {
        let (dir, root, mut index) = vault(&[("Note.md", "# Note\n[[Note]]\n")]);
        let report = rename_note(&root, &mut index, "Note.md", "note", true, None).unwrap();

        assert_eq!(report.new_rel_path, "note.md");
        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|item| item.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names.contains(&"note.md".to_string()), "实际：{names:?}");
        assert!(!names.contains(&"Note.md".to_string()), "实际：{names:?}");
        assert_eq!(read(dir.path(), "note.md"), "# Note\n[[note]]\n");
        assert!(index.contains("note.md"));
        assert!(!index.contains("Note.md"), "旧路径必须从索引里消失");
    }

    #[test]
    fn renaming_to_the_same_title_is_a_no_op() {
        let (dir, root, mut index) = vault(&[("乙.md", "# 乙\n")]);
        let report = rename_note(&root, &mut index, "乙.md", "乙", true, None).unwrap();

        assert_eq!(report.old_rel_path, "乙.md");
        assert_eq!(report.new_rel_path, "乙.md");
        assert!(report.updated_links.is_empty());
        assert_eq!(report.updated_link_count, 0);
        assert!(dir.path().join("乙.md").exists());
    }

    #[test]
    fn update_links_false_only_renames_the_file() {
        let (dir, root, mut index) = vault(&[("甲.md", "[[乙]]\n"), ("乙.md", "# 乙\n")]);
        let report = rename_note(&root, &mut index, "乙.md", "丙", false, None).unwrap();

        assert_eq!(report.new_rel_path, "丙.md");
        assert!(report.updated_links.is_empty());
        assert_eq!(report.updated_link_count, 0);
        assert_eq!(
            read(dir.path(), "甲.md"),
            "[[乙]]\n",
            "明确关掉链接更新时，不许碰任何其他文件"
        );
        assert!(index.contains("丙.md"));
        assert!(!index.contains("乙.md"));
        // 链接就此悬空 —— 这是用户明确选择的结果，索引如实标记
        let stats = index.stats();
        assert_eq!(stats.links, 1);
        assert_eq!(stats.unresolved, 1);
    }

    #[test]
    fn renaming_a_non_note_does_not_pollute_the_index() {
        let (dir, root, mut index) =
            vault(&[("附件/图.png", "not utf8 也照样改名"), ("甲.md", "")]);
        let report = rename_note(&root, &mut index, "附件/图.png", "图2", true, None).unwrap();

        assert_eq!(report.new_rel_path, "附件/图2.png");
        assert!(dir.path().join("附件").join("图2.png").exists());
        assert!(!index.contains("附件/图.png"));
        assert!(
            !index.contains("附件/图2.png"),
            "索引本来不收录附件，改名也不该把它收进来（否则 [[图2]] 会被劫持）"
        );
        assert_eq!(index.len(), 1, "索引里只剩那篇笔记");
    }

    #[test]
    fn rename_keeps_the_search_index_in_step() {
        let (_dir, root, mut index) = vault(&[
            ("笔记/乙.md", "第一行\n命中这一行\n"),
            ("笔记/甲.md", "[[乙]] 也有命中\n"),
        ]);
        let search = crate::SearchIndex::open_in_memory().unwrap();
        search.begin_rebuild().unwrap();
        search
            .add_note("笔记/乙.md", "第一行\n命中这一行\n")
            .unwrap();
        search.add_note("笔记/甲.md", "[[乙]] 也有命中\n").unwrap();
        search.finish_rebuild().unwrap();

        rename_note(&root, &mut index, "笔记/乙.md", "丙", true, Some(&search)).unwrap();

        // 路径搬过去了：旧路径搜不到、新路径搜得到
        assert_eq!(paths_hit(&search, "第一行"), vec!["笔记/丙.md".to_string()]);
        // 被改写的文件（`[[乙]]` → `[[丙]]`）正文变了：搜索里看到的必须是**新文本**
        assert_eq!(paths_hit(&search, "丙"), vec!["笔记/甲.md".to_string()]);
        assert!(
            paths_hit(&search, "乙").is_empty(),
            "旧链接文本不该留在搜索索引里"
        );
    }

    fn paths_hit(search: &crate::SearchIndex, query: &str) -> Vec<String> {
        search
            .search(query, 50)
            .unwrap()
            .hits
            .into_iter()
            .map(|hit| hit.rel_path)
            .collect()
    }

    #[test]
    fn rename_targets_validates_input() {
        assert_eq!(rename_targets("a/乙.md", "丙").unwrap().new_rel, "a/丙.md");
        assert_eq!(
            rename_targets("a\\乙.md", "丙").unwrap().old_rel,
            "a/乙.md",
            "反斜杠分隔的旧路径也接受（与其它命令一致）"
        );
        // 扩展名一律沿用原文件；标题里误带的扩展名被剥掉
        assert_eq!(
            rename_targets("a/乙.markdown", "丙").unwrap().new_rel,
            "a/丙.markdown"
        );
        assert_eq!(rename_targets("a/乙.MD", "丙").unwrap().new_rel, "a/丙.MD");
        assert_eq!(
            rename_targets("a/乙.md", "丙.md").unwrap().new_rel,
            "a/丙.md"
        );

        for (old, title) in [
            ("a/乙.md", ""),
            ("a/乙.md", "   "),
            ("a/乙.md", " 丙 "),
            ("a/乙.md", "丙\n"),
            ("a/乙.md", "子/丙"),
            ("a/乙.md", "子\\丙"),
            ("a/乙.md", "..\\丙"),
            ("a/乙.md", "..."),
            ("a/乙.md", "con"),
            ("a/乙.md", "丙:丁"),
            ("a/乙.md", "丙?丁"),
            ("", "丙"),
            ("../乙.md", "丙"),
            ("/abs/乙.md", "丙"),
        ] {
            assert_eq!(
                rename_targets(old, title).unwrap_err().code(),
                ErrorCode::PathInvalid,
                "应拒绝：old={old:?} title={title:?}"
            );
        }
    }

    #[test]
    fn relative_posix_walks_up_and_down() {
        assert_eq!(relative_posix("", "a/b.md"), "a/b.md");
        assert_eq!(relative_posix("a", "a/b.md"), "b.md");
        assert_eq!(relative_posix("a/b", "a/c.md"), "../c.md");
        assert_eq!(relative_posix("a/b/c", "x.md"), "../../../x.md");
        assert_eq!(relative_posix("a", "b/c.md"), "../b/c.md");
    }
}
