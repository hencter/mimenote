//! **改名与移动共用一条链路**：把文件换个位置，再把全库指向它的链接改成新目标。
//!
//! 为什么落在索引层而不是宿主（`docs/architecture.md` §2 第 3 条）：改写必须与索引的
//! 解析规则**完全一致** —— 判断"这条链接是不是指向它"用的是 [`LinkIndex`] 的消歧规则，
//! 两边一旦分家就会出现"反链面板能解析、改写后反而悬空"；而且"谁指向旧路径"只有索引
//! 知道，只能按候选集去读文件（1 万笔记场景**绝不**全库读文件）。
//!
//! 同目录改名（[`rename_note`]）与跨目录移动（[`move_note`]）的差别只有两处：
//!
//! * 移动的目标目录由调用方给（可以是一个还不存在的目录），改名则固定在原目录；
//! * 移动会把文件的**目录上下文**一起换掉，因此链接一律改写成"相对新位置的路径"
//!   （`[[乙]]` 会变成 `[[子/乙]]`）—— 裸名链接的解析带"同目录优先"的消歧规则，
//!   文件换了目录之后同一条裸名链接可能落到**另一篇**同名笔记上。
//!   同目录改名没有这个问题，所以那边保持"最小 diff"的既有行为不变。
//!
//! 目录上下文一换，**被搬走那篇自身的相对路径链接**（`![](../附件/图.png)`、`[甲](乙.md)`）
//! 也随之失效 —— 这一支同样只在移动时参与，因为它判定的正是"旧目录 ≠ 新目录"：
//! 靠**纯路径算术**（`旧目录 + 原目标` 换算成 Vault 根相对路径，再用新目录重新表达），
//! 因此不需要"Vault 里到底有哪些文件"的完整条目表（索引只收录 Markdown，图片/PDF 拿不到），
//! 也不会把链接改成指向别处的同名文件；目标本来就不存在时，改写后依然忠实表达
//! "相对于这篇笔记"的原意（见 [`relocated_relative_target`]）。
//! 放行的形态（带 scheme、协议相对、Vault 根绝对、纯锚点、裸名 wikilink、代码块/行内代码里的
//! 伪链接）见 [`is_position_relative_target`] 与 [`new_target_for_link`]；**已知没做**的形态见
//! `docs/adr/0012-move-rewrites-relative-links.md` 的代价表。
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

use mn_core::atomic::{move_file, read_text, write_atomic, MoveMethod};
use mn_core::links::{
    extract_links_with_spans, is_position_relative_target, join_relative, normalize_target,
    replace_link_target, LinkSpan,
};
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

/// 改名 / 移动的新旧相对路径。
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
/// 规则（**只支持同目录改名**）：
///
/// * `new_title` 不含扩展名（前端偶尔会连 `.md` 一起传，容忍并剥掉）、不含路径分隔符、
///   不含首尾空白；扩展名一律沿用原文件（`.md` / `.markdown` 原样保留大小写）；
/// * 目录重命名与跨目录移动不走这里：标题里出现分隔符直接判 `PATH_INVALID`
///   （换目录请用 [`move_targets`]）；
/// * 文件名合法性（Windows 禁用字符、保留名、尾随点/空格）复用路径防护的段级校验。
pub fn rename_targets(old_rel_path: &str, new_title: &str) -> Result<RenameTargets> {
    let old_rel = old_rel_path.trim().replace('\\', "/");
    validate_relative_path(&old_rel)?;

    let stem = title_stem(new_title)?;
    let (dir, name) = split_dir(&old_rel);
    let new_rel = join_rel(dir, &format!("{stem}{}", extension_of(name)));
    validate_relative_path(&new_rel)?;

    Ok(RenameTargets { old_rel, new_rel })
}

/// 校验移动入参并算出新旧相对路径。
///
/// * `target_parent_rel` 是**目标父目录**（相对 Vault 根；空串 = Vault 根，反斜杠分隔也接受）。
///   该目录可以还不存在 —— "移动到新建目录"是正常需求（键盘路径下用户直接输入目录名），
///   创建由 [`move_note`] 负责；这里只做**语法**校验（越界、保留名、尾随点等）；
/// * `new_title` 为 `None` 时沿用原文件名（拖拽就是这种情况：只换目录，不改名）；
/// * 新旧路径相同（拖回原目录）不算错误，由 [`move_note`] 当无操作处理。
pub fn move_targets(
    old_rel_path: &str,
    target_parent_rel: &str,
    new_title: Option<&str>,
) -> Result<RenameTargets> {
    let old_rel = old_rel_path.trim().replace('\\', "/");
    validate_relative_path(&old_rel)?;

    let parent = normalize_dir(target_parent_rel)?;
    let (_, name) = split_dir(&old_rel);
    // 不改名时**整个文件名原样沿用**（而不是"主干 + 扩展名"再拼一遍）：
    // `图.png` 这种名字的主干会被 `strip_extension` 原样返回，拼回去就变成 `图.png.png`。
    let new_name = match new_title {
        Some(title) => format!("{}{}", title_stem(title)?, extension_of(name)),
        None => name.to_string(),
    };
    let new_rel = join_rel(&parent, &new_name);
    validate_relative_path(&new_rel)?;

    Ok(RenameTargets { old_rel, new_rel })
}

/// 把用户输入的新文件名校验成**主干**（不含扩展名）。
fn title_stem(new_title: &str) -> Result<&str> {
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
            "新名字不能包含路径分隔符（换目录请用目标目录参数）",
        ));
    }
    let stem = strip_note_extension(title);
    if stem.trim_matches([' ', '.']).is_empty() {
        return Err(Error::invalid(title, "新名字不能只由点或空格组成"));
    }
    Ok(stem)
}

/// 目标目录的规范化形式：去首尾 `/`、统一分隔符；空串表示 Vault 根（不做段级校验）。
fn normalize_dir(target_parent_rel: &str) -> Result<String> {
    let normalized = target_parent_rel.trim().replace('\\', "/");
    let trimmed = normalized.trim_matches('/');
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    validate_relative_path(trimmed)?;
    Ok(trimmed.to_string())
}

/// 目录与文件名的拼接（空目录 = Vault 根）。
fn join_rel(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

/// 执行"同目录改名 + 全库链接精确改写"，并把 [`LinkIndex`] 同步到新状态。
///
/// 调用方（宿主）只负责：拿写锁、把参数从 IPC 搬过来。业务判断全在这里。
///
/// `search` 是全文搜索索引（可选）：给了就顺带把路径搬过去、并把被改写文件的新文本重新入库。
/// 搜索是不可重建的**派生**数据里最不重要的那一份，因此它的失败只记日志、不影响改名结果。
pub fn rename_note(
    root: &VaultRoot,
    index: &mut LinkIndex,
    old_rel_path: &str,
    new_title: &str,
    update_links: bool,
    search: Option<&SearchIndex>,
) -> Result<RenameReport> {
    let targets = rename_targets(old_rel_path, new_title)?;
    relocate_note(
        root,
        index,
        targets,
        update_links,
        search,
        RelocateOptions::rename(),
    )
}

/// 执行"跨目录移动（可顺带改名）+ 全库链接精确改写"。
///
/// 与 [`rename_note`] 共用同一条链路，差别只在两点（见模块文档）：目标目录可以不存在
/// （会创建），以及链接一律改写成相对新位置的路径。
///
/// 目标目录里已有同名文件时返回 `ALREADY_EXISTS`，**绝不覆盖**；移到自己所在目录
/// （新旧路径相同）是无操作，照常返回新旧路径与磁盘现状。
pub fn move_note(
    root: &VaultRoot,
    index: &mut LinkIndex,
    old_rel_path: &str,
    target_parent_rel: &str,
    new_title: Option<&str>,
    update_links: bool,
    search: Option<&SearchIndex>,
) -> Result<RenameReport> {
    let targets = move_targets(old_rel_path, target_parent_rel, new_title)?;
    relocate_note(
        root,
        index,
        targets,
        update_links,
        search,
        RelocateOptions::move_to(),
    )
}

/// 一次"搬家"的可选行为（改名与移动的差异都收在这里，避免到处传布尔开关）。
#[derive(Debug, Clone, Copy)]
struct RelocateOptions {
    /// 链接一律写成相对新位置的路径（见模块文档：移动会让裸名链接的消歧结果漂移）。
    always_relative: bool,
    /// 目标父目录不存在时创建（移动允许落到一个新目录；改名不需要）。
    create_parent: bool,
}

impl RelocateOptions {
    fn rename() -> Self {
        Self {
            always_relative: false,
            create_parent: false,
        }
    }

    fn move_to() -> Self {
        Self {
            always_relative: true,
            create_parent: true,
        }
    }
}

/// 改名与移动的**共同主体**。
///
/// 阶段顺序是刻意的：
///
/// 1. **先算改写计划**：此时索引里还是旧路径，才能用同一套解析规则找出"谁指向它"；
/// 2. **再搬文件**：同卷 `rename` 原子、不留半截文件；跨卷时退回"复制 + 删源"
///    （见 `mn_core::atomic::move_file`）；
/// 3. **再写回**被改写的文件（逐个 `write_atomic`）；
/// 4. **最后同步索引**：旧路径移除、新路径写入、被改写文件逐个 upsert —— 反链面板
///    不必等重扫就能立刻正确。
///
/// 部分失败：某个被改写文件写失败时**不回滚搬家**（文件已经换位置了，回滚只会制造更大的
/// 不一致），只记日志并把它排除出 `updated_links`。只有当搬家本身失败才返回错误。
fn relocate_note(
    root: &VaultRoot,
    index: &mut LinkIndex,
    targets: RenameTargets,
    update_links: bool,
    search: Option<&SearchIndex>,
    options: RelocateOptions,
) -> Result<RenameReport> {
    let started = Instant::now();
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

    // 目标父目录还不存在时创建（移动允许落到新目录；键盘路径下用户就是直接输入目录名）
    if options.create_parent {
        ensure_parent_dir(root, &new_rel)?;
    }

    let new_path = root.resolve_for_write(&new_rel)?;
    if occupied_by_other(&old_path, &new_path) {
        return Err(Error::AlreadyExists(new_rel));
    }

    // 1) 计划（只读候选集文件，不落盘）
    let plan = if update_links {
        plan_rewrites(root, index, &old_rel, &new_rel, options.always_relative)
    } else {
        Vec::new()
    };

    // 计划阶段可能读了若干文件；搬家前的最后一刻再确认目标没被外部创建 ——
    // Windows 上 `fs::rename` 是"替换已存在目标"语义，宁可在这里保守拦一次。
    if occupied_by_other(&old_path, &new_path) {
        return Err(Error::AlreadyExists(new_rel));
    }

    // 2) 搬家：优先原子 rename；跨卷（Vault 内的联接目录指向另一个卷）退回"复制 + 删源"
    match move_file(&old_path, &new_path).map_err(|e| relocate_error(e, &new_rel))? {
        MoveMethod::Rename => {}
        MoveMethod::CopyAndDelete => log::warn!(
            "跨卷搬迁（{old_rel} → {new_rel}）：rename 不可用，已退回复制 + 删除源（中途崩溃可能留下两份）"
        ),
    }

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

/// 搬家失败时把错误翻译成用户能据以行动的语义。
///
/// 为什么单拎出"已存在"：它是**唯一**一个必须保持原样的错误码 —— UI 按错误码分支，
/// 把"目标重名"说成"磁盘读写失败"会让用户去查一个根本不存在的磁盘问题
/// （见 `apps/desktop/src/ipc/types.ts` 的 `describeError`）。
fn relocate_error(error: Error, new_rel: &str) -> Error {
    match error.code() {
        mn_core::ErrorCode::AlreadyExists => Error::AlreadyExists(new_rel.to_string()),
        _ => error,
    }
}

/// 目标父目录不存在时创建。
///
/// `resolve_for_write` 已经做过越界与符号链接检查，这里只补"路径存在但是个文件"的语义 ——
/// 那种情况下 `create_dir_all` 给的系统错误码很难读。
fn ensure_parent_dir(root: &VaultRoot, new_rel: &str) -> Result<()> {
    let parent = parent_of(new_rel);
    if parent.is_empty() {
        return Ok(());
    }
    let dir = root.resolve_for_write(&parent)?;
    if dir.exists() {
        return if dir.is_dir() {
            Ok(())
        } else {
            Err(Error::NotADirectory(parent))
        };
    }
    std::fs::create_dir_all(&dir).map_err(|e| Error::io(&dir, e))
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
    /// 一律写成"相对新位置的路径"，**不看**原目标是不是裸名（跨目录移动用）。
    ///
    /// 为什么移动必须这么做：裸名链接靠文件名主干 + "同目录优先"消歧，文件换目录后
    /// 同一条 `[[乙]]` 可能落到**另一篇**同名笔记上 —— 那是静默的错误指向，
    /// 比"链接文本变长"严重得多。同目录改名没有这个问题，保持最小 diff。
    always_relative: bool,
}

/// 一条链接的改写"坐标系"（见 [`plan_rewrites`] 的构造处）。
struct RewriteFrame<'a> {
    /// 文本**当前**所在的相对路径（索引解析、读文件都用它）。
    from_rel: &'a str,
    /// 这段文本**改写前**所在的目录。
    old_dir: &'a str,
    /// 这段文本**改写后**所在的目录 —— 新目标一律相对它表达。
    ///
    /// 为什么必须区分：被搬到别处的正文，若还按旧目录写相对路径，从新位置解析时就会错位
    /// （越深越离谱，甚至跑出 Vault 根）。其余文件原地不动，两者天然相同。
    new_dir: &'a str,
}

impl RewriteFrame<'_> {
    /// 这段文本是否被搬到了**别的目录**。
    ///
    /// `old_dir == new_dir`（同目录改名、移到自己所在目录）时，正文里任何相对路径的含义
    /// 都一字不变 —— 一个字符都不该动，这是"不产生无意义 diff"的判据。
    fn relocated(&self) -> bool {
        self.old_dir != self.new_dir
    }
}

/// 只读地算出改写计划：**只碰候选集**（出链解析到旧路径的那些文件 + 被搬走的那一篇自身）。
fn plan_rewrites(
    root: &VaultRoot,
    index: &LinkIndex,
    old_rel: &str,
    new_rel: &str,
    always_relative: bool,
) -> Vec<PlannedRewrite> {
    // 主干取的是**新文件名去掉末尾 `.md`/`.markdown`**，而不是 `stem_of`（后者在最后一个
    // 点处切分，会把 `v1.2.md` 的主干算成 `v1`）。
    let style = TargetStyle {
        new_rel_no_ext: strip_extension(new_rel),
        new_stem: strip_extension(file_name_of(new_rel)),
        new_ext: extension_of(file_name_of(new_rel)),
        always_relative,
    };

    // 候选集两部分：指向被搬走那篇的笔记（索引知道是谁），以及**被搬走的那篇自身**。
    // 后者必须显式加进来：它正文里的相对路径链接（图片、PDF、同级笔记）在索引里根本
    // 查不到归属 —— 索引只收录 Markdown，靠"谁指向它"反查是不可能的。
    let mut sources = index.referrers_of(old_rel);
    if is_note_path(old_rel) && !sources.iter().any(|from| from == old_rel) {
        sources.push(old_rel.to_string());
    }

    let mut planned = Vec::new();
    for from_rel in sources {
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
        let old_dir = parent_of(&from_rel);
        // 被搬走的那篇：正文改写后落在新目录；其余文件原地不动
        let new_dir = if from_rel == old_rel {
            parent_of(new_rel)
        } else {
            old_dir.clone()
        };
        let frame = RewriteFrame {
            from_rel: &from_rel,
            old_dir: &old_dir,
            new_dir: &new_dir,
        };
        let (new_text, count) = rewrite_text(index, &text, &frame, old_rel, &style);
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

/// 一篇待改写的文件里、某一行上的一条候选链接。
#[derive(Debug, Clone)]
struct PendingLink {
    /// 原始目标（已剥离锚点）。
    raw_target: String,
    span: LinkSpan,
    /// 这条链接按索引规则指向**被搬走的那篇**（必须与反链面板看到的一致）。
    points_at_moved: bool,
}

/// 改写一篇文件里所有需要动的链接，返回（新文本，改写条数）。
fn rewrite_text(
    index: &LinkIndex,
    text: &str,
    frame: &RewriteFrame<'_>,
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
    let mut by_line: HashMap<u32, Vec<PendingLink>> = HashMap::new();
    for (link, span) in extract_links_with_spans(body) {
        // `[[#小节]]` 这类纯锚点链接指的是文件自身，改名后依旧成立，不需要改（也改不了）
        if link.raw_target.trim().is_empty() {
            continue;
        }
        // 用索引的解析规则判断"这条链接是不是指向它"：必须与反链面板看到的一致
        if index.resolve(frame.from_rel, &link.raw_target).as_deref() == Some(old_rel) {
            by_line.entry(span.line).or_default().push(PendingLink {
                raw_target: link.raw_target,
                span,
                points_at_moved: true,
            });
            continue;
        }
        // 被搬走的那篇自身还要看"相对路径链接"：它们的含义随这篇笔记所在目录变化。
        // 其余文件只在"指向被搬走那篇"时才需要动，因此这条分支在它们那里恒为空
        //（`old_dir == new_dir`）。
        if frame.relocated() {
            by_line.entry(span.line).or_default().push(PendingLink {
                raw_target: link.raw_target,
                span,
                points_at_moved: false,
            });
        }
    }
    if by_line.is_empty() {
        return (text.to_string(), 0);
    }

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
        // 同一行多条链接：从后往前替换，前面的 span 才不会因长度变化而失效
        for item in items.iter().rev() {
            let Some(target) = new_target_for_link(index, item, &line, frame, style) else {
                continue;
            };
            // 目标文本一字不变 → 不改：同级目录互换、同目录改名后的自链接都属于这类，
            // 写盘只会白白制造一个 diff（还会让 mtime/master 版本令牌无谓地跳一次）。
            if target == item.raw_target {
                continue;
            }
            match replace_verified(&line, &item.span, &target) {
                Some(replaced) => {
                    line = replaced;
                    count += 1;
                }
                None => log::warn!(
                    "重命名改写跳过 {from_rel} 第 {line_no} 行的链接（`{raw}` → `{target}` 无法安全替换）",
                    from_rel = frame.from_rel,
                    raw = item.raw_target,
                ),
            }
        }
        out.push_str(&line);
        out.push_str(ending);
    }

    if count == 0 {
        // 一条都没改成（全部无法安全替换，或本来就不需要改）→ 原样返回，绝不写出"半改写"的文件
        return (text.to_string(), 0);
    }
    (format!("{bom}{out}"), count)
}

/// 一条候选链接改写后的目标文本；`None` = 这条**放行**（不改）。
fn new_target_for_link(
    index: &LinkIndex,
    item: &PendingLink,
    line: &str,
    frame: &RewriteFrame<'_>,
    style: &TargetStyle<'_>,
) -> Option<String> {
    if item.points_at_moved {
        return Some(new_target_for(
            &item.raw_target,
            line,
            &item.span,
            frame.new_dir,
            style,
        ));
    }

    // 走到这里 = 正在改写被搬走的那篇自身，且这条链接不指向它自己
    let wiki = is_wiki_syntax(line, &item.span);
    if wiki && !item.raw_target.contains('/') {
        // 裸名 wikilink（`[[乙]]`、`![[图.png]]`）由索引按"文件名主干 + 同目录优先"解析，
        // 它写的不是路径：按路径改写会制造无意义 diff，也不在本次范围内（漂移风险见 ADR）
        return None;
    }
    relocated_relative_target(index, &item.raw_target, wiki, frame)
}

/// 被搬走的那篇笔记正文里的一条链接，在新目录里应该怎么写。
///
/// **纯路径算术，不做存在性检查**：`旧目录 + 原目标` 换算成 Vault 根相对路径，再用新目录
/// 重新表达。这样既不需要"Vault 里到底有哪些文件"的完整条目表（索引只收录 Markdown，
/// 图片/PDF 的全集拿不到），也不会把链接改成指向别处的同名文件；即便目标本来就不存在，
/// 改写后依然忠实表达"相对于这篇笔记"的原意 —— 那正是作者写下相对路径时的意思。
fn relocated_relative_target(
    index: &LinkIndex,
    raw: &str,
    wiki: bool,
    frame: &RewriteFrame<'_>,
) -> Option<String> {
    // 目录没变（同目录改名、移到自己所在目录）→ 含义一字不变，一个字符都不该动
    if !frame.relocated() {
        return None;
    }
    if !is_position_relative_target(raw) {
        return None;
    }
    // 反斜杠目标不做算术：本层的路径运算只认 POSIX `/`，而 Markdown 里 `\` 又是转义字符
    //（`\.` 与 `\附` 的语义不同）。宁可少改，也不要把一个地址改坏。
    if raw.contains('\\') {
        return None;
    }
    let vault_rel = join_relative(frame.old_dir, raw)?;

    if wiki {
        // wikilink 的目标由索引按"相对当前目录 → 相对根 → 路径后缀"三级规则解析，
        // 它的含义**未必**等于"旧目录 + 目标"这条算术假设。索引明明解析到别处时宁可不动：
        // 那种链接本来能解析，按算术改写反而会把它弄悬空（Markdown 形式没有这个问题 ——
        // 阅读视图按 URL 语义相对当前笔记解析，算术就是它的口径）。
        if let Some(resolved) = index.resolve(frame.from_rel, raw) {
            if normalize_target(&resolved) != normalize_target(&vault_rel) {
                return None;
            }
        }
    }

    let target = relative_posix(frame.new_dir, &vault_rel);
    // 换算结果与原文一字不差（例如把 `项目/` 与 `日记/` 两个同级目录互换）→ 不写盘
    (target != raw).then_some(target)
}

/// 算出新目标文本（保持用户原有的写法风格，最小 diff）：
///
/// * 原目标含路径（`/`、`./`、`../`）→ 用**相对链接所在文本落点**的 POSIX 相对路径（去扩展名）；
///   跨目录移动（[`TargetStyle::always_relative`]）时**所有**链接都走这一支：
///   同目录的参照点天然退化成裸文件名（`relative_posix("a", "a/乙") == "乙"`），
///   于是"改到别的目录"这件事在文本上一定看得出来，也不会被消歧规则 reinterpret；
/// * `new_dir` 是这段文本**改写后**所在的目录（见 [`RewriteFrame`]）：被搬走的那篇自身
///   也要按新目录表达，否则写出来的路径从新位置解析时就是错的；
/// * 原目标不含 `/`（裸名）且不是移动 → 只用**新文件名主干**；
/// * 原目标显式写了 `.md` / `.markdown`（且是 Markdown 形式）→ 保留扩展名写法；
/// * `[[x]]` 形式不加扩展名（`[[x.md]]` 不是惯例）。
fn new_target_for(
    raw_target: &str,
    line: &str,
    span: &LinkSpan,
    new_dir: &str,
    style: &TargetStyle<'_>,
) -> String {
    let mut target = if style.always_relative || normalize_target(raw_target).contains('/') {
        relative_posix(new_dir, style.new_rel_no_ext)
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

/// 这篇文件看起来是不是 Markdown 笔记（只有笔记的正文才按 Markdown 改写）。
///
/// 为什么必须判：`relocate_note` 也负责搬图片/PDF 这类非笔记文件 —— 把 png 的字节当文本
/// 改写是纯粹的破坏（非 UTF-8 会读失败，但 UTF-8 的 `.txt`/`.json` 不会）。
fn is_note_path(rel: &str) -> bool {
    has_note_extension(file_name_of(rel))
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

    // -- 跨目录移动（move_note） --------------------------------------------

    #[test]
    fn move_targets_accepts_a_root_empty_string_and_rejects_hazards() {
        // 目标目录为空串 = Vault 根
        assert_eq!(
            move_targets("别的/乙.md", "", None).unwrap().new_rel,
            "乙.md"
        );
        // 首尾 `/` 与反斜杠都容忍（拖拽/对话框给的都是"目录"写法）
        assert_eq!(
            move_targets("别的/乙.md", "/归档/", None).unwrap().new_rel,
            "归档/乙.md"
        );
        // 前导 `/` 当作"从 Vault 根起算"而不是绝对路径：它**永远逃不出**根，
        // 而"回到根目录"是用户嘴边的需求（`..` 才是必须拦的越界写法）
        assert_eq!(
            move_targets("别的/乙.md", "/abs/路径", None)
                .unwrap()
                .new_rel,
            "abs/路径/乙.md"
        );
        assert_eq!(
            move_targets("别的/乙.md", "归\\档", None).unwrap().new_rel,
            "归/档/乙.md",
            "反斜杠分隔的多段目标目录也接受（与其它命令一致）"
        );
        // 顺带改名：扩展名沿用原文件
        assert_eq!(
            move_targets("别的/乙.markdown", "归档", Some("丙.md"))
                .unwrap()
                .new_rel,
            "归档/丙.markdown"
        );
        // 不改名时文件名逐字沿用（`图.png` 不能被拼成 `图.png.png`）
        assert_eq!(
            move_targets("附件/图.png", "素材", None).unwrap().new_rel,
            "素材/图.png"
        );
        // 同目录同名 = 新旧一致（由 move_note 当无操作处理）
        assert_eq!(
            move_targets("别的/乙.md", "别的", None).unwrap(),
            RenameTargets {
                old_rel: "别的/乙.md".to_string(),
                new_rel: "别的/乙.md".to_string()
            }
        );

        for (target, title) in [
            ("../外面", None),
            ("归档/../外面", None),
            ("归\\档", Some("丙/丁")),
            ("归\\档", Some("")),
            ("归\\档", Some(" 丙 ")),
            ("con", None),
            ("归档/", Some("...")),
            ("C:/Windows", None),
            ("C:\\Windows", None),
        ] {
            assert_eq!(
                move_targets("别的/乙.md", target, title)
                    .unwrap_err()
                    .code(),
                ErrorCode::PathInvalid,
                "应拒绝：target={target:?} title={title:?}"
            );
        }
        // `move_targets` 只做**语法**校验：源是否存在由 `move_note` 落到文件系统上判断
        assert_eq!(
            move_targets("不存在.md", "归档", None).unwrap().new_rel,
            "归档/不存在.md"
        );
    }

    #[test]
    fn moves_across_directories_and_rewrites_links_as_relative_paths() {
        let (dir, root, mut index) = vault(&[
            ("笔记/甲.md", "见 [[乙]] 结束\n"),
            ("别的/丙.md", "[[别的/乙]]\n"),
            ("深/层/引用.md", "[看](../../别的/乙.md)\n"),
            ("别的/乙.md", "# 乙\n"),
        ]);

        let report = move_note(&root, &mut index, "别的/乙.md", "归档", None, true, None).unwrap();

        assert_eq!(report.old_rel_path, "别的/乙.md");
        assert_eq!(report.new_rel_path, "归档/乙.md");
        assert!(dir.path().join("归档").join("乙.md").exists());
        assert!(
            !dir.path().join("别的").join("乙.md").exists(),
            "源必须消失"
        );
        assert_eq!(report.updated_link_count, 3);

        // 跨目录 → 一律写成"相对新位置的路径"：裸名会让消歧规则把链接指到别处
        assert_eq!(read(dir.path(), "笔记/甲.md"), "见 [[../归档/乙]] 结束\n");
        assert_eq!(
            read(dir.path(), "别的/丙.md"),
            "[[../归档/乙]]\n",
            "同目录改名才保留裸名；换目录之后裸名不再唯一"
        );
        assert_eq!(
            read(dir.path(), "深/层/引用.md"),
            "[看](../../归档/乙.md)\n"
        );

        // 索引立刻切到新路径（反链面板不必等重扫）
        assert!(!index.contains("别的/乙.md"));
        assert!(index.contains("归档/乙.md"));
        let backlinks = index.note_links("归档/乙.md").backlinks;
        assert_eq!(backlinks.len(), 3);
        assert_eq!(
            index.stats().unresolved,
            0,
            "改写后的三条链接都必须仍然解析得到"
        );
    }

    #[test]
    fn move_keeps_the_bare_name_when_the_referrer_lands_in_the_new_directory() {
        let (dir, root, mut index) = vault(&[("归档/丙.md", "[[乙]]\n"), ("别的/乙.md", "# 乙\n")]);
        move_note(&root, &mut index, "别的/乙.md", "归档", None, true, None).unwrap();

        // 相对路径换算在同目录时本来就退化成裸文件名 —— 不必为它写特例
        assert_eq!(read(dir.path(), "归档/丙.md"), "[[乙]]\n");
    }

    #[test]
    fn move_keeps_alias_anchor_embed_and_markdown_extension_style() {
        let (dir, root, mut index) = vault(&[
            (
                "笔记/甲.md",
                "[[乙|别名]] 与 [[乙#小节]] 与 ![[乙^块]] 与 [文本](乙.md)\n",
            ),
            ("别的/乙.md", "# 乙\n"),
        ]);
        let report = move_note(&root, &mut index, "别的/乙.md", "归档", None, true, None).unwrap();

        assert_eq!(
            read(dir.path(), "笔记/甲.md"),
            "[[../归档/乙|别名]] 与 [[../归档/乙#小节]] 与 ![[../归档/乙^块]] 与 [文本](../归档/乙.md)\n"
        );
        assert_eq!(report.updated_links, vec![entry("笔记/甲.md", 4)]);
    }

    #[test]
    fn move_leaves_code_blocks_inline_code_escapes_and_lookalikes_untouched() {
        let original = "# 标题\n\n```text\n[[甲]]\n```\n\n行内 `[[甲]]` 结束\n\n转义 \\[[甲]] 与相似名 [[甲虫]]\n\n真的 [[甲]]\n";
        let (dir, root, mut index) = vault(&[
            ("笔记/甲.md", original),
            ("笔记/甲虫.md", "# 甲虫\n"),
            ("笔记/引用.md", "见 [[甲]] 与 [[甲虫]]\n"),
        ]);

        let report = move_note(&root, &mut index, "笔记/甲.md", "归档", None, true, None).unwrap();

        // 被移动文件自身一字不动：代码块、行内代码、转义、`[[甲虫]]` 本来就不该动，
        // 而它自己的自链接 `[[甲]]` 也**不需要**动 —— 正文改写后落在 `归档/`，
        // 按新位置表达的裸名就是 `甲`，与原文一字不差（旧写法会写成 `../归档/甲`，
        // 那种"从新位置解析时靠 `..` 绕回来"的路径不但更长，深目录里还会直接跑出 Vault 根）
        assert_eq!(read(dir.path(), "归档/甲.md"), original);
        // `[[甲虫]]` 不是它，不能被连带改写
        assert_eq!(
            read(dir.path(), "笔记/引用.md"),
            "见 [[../归档/甲]] 与 [[甲虫]]\n"
        );
        assert_eq!(
            report.updated_links,
            vec![entry("笔记/引用.md", 1)],
            "自链接没变 → 被移动文件不出现在结果里（前端因此不会做无谓的重载）"
        );
        assert_eq!(report.updated_link_count, 1);
        assert_eq!(
            index.stats().unresolved,
            0,
            "`[[甲]]` 换目录后仍然解析到自己"
        );
    }

    #[test]
    fn move_reports_the_moved_note_itself_with_its_old_path() {
        // 被移动的笔记自身也有链接要改（同级笔记留在原地）→ 它的条目按**旧路径**上报，
        // 前端要在"搬家前的坐标系"里认出"我正在编辑的这一篇也被改写了，得重新读取"
        let (dir, root, mut index) = vault(&[
            ("笔记/甲.md", "见 [乙](乙.md) 与 [[乙]]\n"),
            ("笔记/乙.md", "# 乙\n"),
        ]);

        let report = move_note(&root, &mut index, "笔记/甲.md", "归档", None, true, None).unwrap();

        assert_eq!(
            read(dir.path(), "归档/甲.md"),
            "见 [乙](../笔记/乙.md) 与 [[乙]]\n",
            "Markdown 形式的目标按路径换算成新位置的相对路径"
        );
        assert_eq!(report.updated_links, vec![entry("笔记/甲.md", 1)]);
        assert_eq!(report.updated_link_count, 1);
        assert!(index.contains("归档/甲.md"));
        let links = index.note_links("归档/甲.md");
        assert_eq!(
            links.outbound[0].resolved_rel_path.as_deref(),
            Some("笔记/乙.md"),
            "索引里这条出链必须仍然指向原来那篇"
        );
    }

    #[test]
    fn move_to_a_directory_that_does_not_exist_yet_creates_it() {
        let (dir, root, mut index) = vault(&[("笔记/甲.md", "# 甲\n")]);
        let report = move_note(
            &root,
            &mut index,
            "笔记/甲.md",
            "新建/更深",
            None,
            true,
            None,
        )
        .unwrap();

        assert_eq!(report.new_rel_path, "新建/更深/甲.md");
        assert!(dir.path().join("新建").join("更深").join("甲.md").exists());
        assert!(index.contains("新建/更深/甲.md"));
    }

    #[test]
    fn move_to_a_path_that_is_really_a_file_is_rejected() {
        let (dir, root, mut index) = vault(&[("笔记/甲.md", "# 甲\n"), ("目标.md", "x")]);
        // 目标目录的位置上是个文件：必须是 NOT_A_DIRECTORY（不是笼统的 IO）
        assert!(dir.path().join("目标.md").is_file());
        assert_eq!(
            move_note(&root, &mut index, "笔记/甲.md", "目标.md", None, true, None)
                .unwrap_err()
                .code(),
            ErrorCode::NotADirectory
        );
        assert!(
            dir.path().join("笔记").join("甲.md").exists(),
            "失败不许动源"
        );
    }

    #[test]
    fn move_refuses_to_overwrite_and_changes_nothing() {
        let (dir, root, mut index) = vault(&[
            ("笔记/甲.md", "[[乙]]\n"),
            ("笔记/乙.md", "# 乙\n"),
            ("归档/乙.md", "# 归档里的乙\n"),
        ]);
        let error =
            move_note(&root, &mut index, "笔记/乙.md", "归档", None, true, None).unwrap_err();

        assert_eq!(error.code(), ErrorCode::AlreadyExists);
        assert_eq!(read(dir.path(), "归档/乙.md"), "# 归档里的乙\n", "绝不覆盖");
        assert!(dir.path().join("笔记").join("乙.md").exists());
        assert_eq!(read(dir.path(), "笔记/甲.md"), "[[乙]]\n", "链接不许被动过");
    }

    #[test]
    fn move_to_the_same_directory_is_a_no_op() {
        let (dir, root, mut index) = vault(&[("笔记/甲.md", "[[乙]]\n"), ("笔记/乙.md", "")]);
        let before = std::fs::metadata(dir.path().join("笔记/乙.md"))
            .unwrap()
            .modified()
            .unwrap();

        let report = move_note(&root, &mut index, "笔记/乙.md", "笔记", None, true, None).unwrap();

        assert_eq!(report.new_rel_path, "笔记/乙.md");
        assert!(report.updated_links.is_empty());
        assert_eq!(report.updated_link_count, 0);
        assert_eq!(read(dir.path(), "笔记/甲.md"), "[[乙]]\n");
        assert_eq!(
            std::fs::metadata(dir.path().join("笔记/乙.md"))
                .unwrap()
                .modified()
                .unwrap(),
            before,
            "无操作时连 mtime 都不该变（说明根本没写）"
        );
    }

    #[test]
    fn move_rejects_missing_source_out_of_bounds_path_and_directory() {
        let (dir, root, mut index) = vault(&[("别/乙.md", ""), ("目录/里面的.md", "")]);
        assert_eq!(
            move_note(&root, &mut index, "不存在.md", "归档", None, true, None)
                .unwrap_err()
                .code(),
            ErrorCode::NotFound
        );
        assert_eq!(
            move_note(&root, &mut index, "../外面.md", "归档", None, true, None)
                .unwrap_err()
                .code(),
            ErrorCode::PathInvalid
        );
        assert_eq!(
            move_note(&root, &mut index, "目录", "归档", None, true, None)
                .unwrap_err()
                .code(),
            ErrorCode::IsDirectory,
            "目录移动不在本轮范围"
        );
        assert!(dir.path().join("目录").is_dir(), "被拒绝时目录必须原样留着");
    }

    #[test]
    fn move_with_a_new_title_renames_and_relocates_in_one_step() {
        let (dir, root, mut index) = vault(&[("笔记/甲.md", "[[乙|别名]]\n"), ("笔记/乙.md", "")]);
        let report = move_note(
            &root,
            &mut index,
            "笔记/乙.md",
            "归档",
            Some("丙"),
            true,
            None,
        )
        .unwrap();

        assert_eq!(report.new_rel_path, "归档/丙.md");
        assert!(dir.path().join("归档").join("丙.md").exists());
        assert_eq!(read(dir.path(), "笔记/甲.md"), "[[../归档/丙|别名]]\n");
        assert!(index.contains("归档/丙.md"));
        assert!(!index.contains("笔记/乙.md"));
    }

    #[test]
    fn move_preserves_bom_and_crlf() {
        let (dir, root, mut index) = vault(&[
            (
                "笔记/甲.md",
                "\u{feff}# 标题\r\n[[乙]] 与 [x](乙.md)\r\n行三\r\n",
            ),
            ("别的/乙.md", "\u{feff}# 乙\r\n"),
        ]);
        let report = move_note(&root, &mut index, "别的/乙.md", "归档", None, true, None).unwrap();

        assert_eq!(
            read(dir.path(), "笔记/甲.md"),
            "\u{feff}# 标题\r\n[[../归档/乙]] 与 [x](../归档/乙.md)\r\n行三\r\n"
        );
        let bytes = std::fs::read(dir.path().join("笔记").join("甲.md")).unwrap();
        assert_eq!(&bytes[..3], &[0xEF, 0xBB, 0xBF], "BOM 必须原样保留");
        // 被移动的文件自身逐字节搬过去（内容一个字都不改）
        assert_eq!(read(dir.path(), "归档/乙.md"), "\u{feff}# 乙\r\n");
        assert_eq!(report.updated_link_count, 2);
    }

    #[test]
    fn move_with_update_links_false_only_relocates_the_file() {
        let (dir, root, mut index) = vault(&[("笔记/甲.md", "[[乙]]\n"), ("笔记/乙.md", "")]);
        let report = move_note(&root, &mut index, "笔记/乙.md", "归档", None, false, None).unwrap();

        assert_eq!(report.new_rel_path, "归档/乙.md");
        assert!(report.updated_links.is_empty());
        assert_eq!(read(dir.path(), "笔记/甲.md"), "[[乙]]\n");
        assert!(index.contains("归档/乙.md"));
        assert!(!index.contains("笔记/乙.md"));
    }

    #[test]
    fn move_takes_the_search_index_along() {
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

        move_note(
            &root,
            &mut index,
            "笔记/乙.md",
            "归档",
            None,
            true,
            Some(&search),
        )
        .unwrap();

        assert_eq!(paths_hit(&search, "第一行"), vec!["归档/乙.md".to_string()]);
        // 被改写的来源笔记正文变了（`[[乙]]` → `[[../归档/乙]]`），搜索里必须是新文本
        assert!(!paths_hit(&search, "乙").is_empty());
        assert_eq!(paths_hit(&search, "../归档/乙").len(), 1);
    }

    #[test]
    fn moving_a_non_note_does_not_pollute_the_index() {
        let (dir, root, mut index) =
            vault(&[("附件/图.png", "not utf8 也照样移动"), ("甲.md", "")]);
        let report = move_note(&root, &mut index, "附件/图.png", "素材", None, true, None).unwrap();

        assert_eq!(report.new_rel_path, "素材/图.png");
        assert!(dir.path().join("素材").join("图.png").exists());
        assert!(!index.contains("附件/图.png"));
        assert!(
            !index.contains("素材/图.png"),
            "索引本来不收录附件，移动也不该把它收进来"
        );
        assert_eq!(index.len(), 1, "索引里只剩那篇笔记");
    }

    #[test]
    fn move_without_a_vault_root_sized_source_is_not_special_cased() {
        // 源是空串 → 路径校验必须先拦下（不是走到文件系统再报 IO）
        let (_dir, root, mut index) = vault(&[("甲.md", "")]);
        assert_eq!(
            move_note(&root, &mut index, "", "归档", None, true, None)
                .unwrap_err()
                .code(),
            ErrorCode::PathInvalid
        );
    }

    // -- 被移动笔记**自身正文**里的相对路径链接 ------------------------------

    #[test]
    fn move_rewrites_the_moved_notes_own_relative_image_link() {
        // `附件/` 在 Vault 根，`项目/` 与 `日夜/` 同层：`../附件/图.png` 从**同层**目录
        // 换个名字依旧成立，只有落点深度变了才需要重写。
        let (dir, root, mut index) = vault(&[
            ("项目/设计文档.md", "![图](../附件/图.png)\n"),
            ("附件/图.png", "png"),
        ]);
        let report = move_note(
            &root,
            &mut index,
            "项目/设计文档.md",
            "日记/2026",
            None,
            true,
            None,
        )
        .unwrap();

        assert_eq!(report.new_rel_path, "日记/2026/设计文档.md");
        // 旧目录 `项目` → Vault 根相对路径 `附件/图.png` → 用新目录 `日记/2026` 重新表达
        assert_eq!(
            read(dir.path(), "日记/2026/设计文档.md"),
            "![图](../../附件/图.png)\n"
        );
        assert_eq!(report.updated_links, vec![entry("项目/设计文档.md", 1)]);
    }

    #[test]
    fn move_into_a_sibling_directory_rewrites_nothing() {
        // 同级目录互换位置时，指向"另一条兄弟路径"的相对写法恰好不变 → 一个字符都不该动
        //（也不该写盘）。注意只有**含义**不变才成立：`../附件/图.png` 从 `项目/` 与 `日记/`
        // 出发都是 `附件/图.png`，而 `[乙](乙.md)` 指的是 `项目/乙.md`，换目录就得改。
        let (dir, root, mut index) = vault(&[
            (
                "项目/设计文档.md",
                "![图](../附件/图.png) 与 ![二](../附件/子/图.png)\n",
            ),
            ("附件/图.png", "png"),
            ("附件/子/图.png", "png"),
        ]);
        let before = std::fs::metadata(dir.path().join("项目").join("设计文档.md"))
            .unwrap()
            .modified()
            .unwrap();

        let report = move_note(
            &root,
            &mut index,
            "项目/设计文档.md",
            "日记",
            None,
            true,
            None,
        )
        .unwrap();

        assert_eq!(
            read(dir.path(), "日记/设计文档.md"),
            "![图](../附件/图.png) 与 ![二](../附件/子/图.png)\n"
        );
        assert!(report.updated_links.is_empty());
        assert_eq!(report.updated_link_count, 0);
        assert_eq!(
            std::fs::metadata(dir.path().join("日记").join("设计文档.md"))
                .unwrap()
                .modified()
                .unwrap(),
            before,
            "没东西要改时连 mtime 都不该变（说明根本没写）"
        );
    }

    #[test]
    fn move_rewrites_own_links_towards_the_root_and_into_a_subdirectory() {
        // 方向一：深层 → Vault 根
        let (dir, root, mut index) = vault(&[
            (
                "项目/深层/设计.md",
                "[图](../附件/图.png) 与 [乙](../../笔记/乙.md)\n",
            ),
            ("附件/图.png", "png"),
            ("笔记/乙.md", "# 乙\n"),
        ]);
        let report =
            move_note(&root, &mut index, "项目/深层/设计.md", "", None, true, None).unwrap();

        assert_eq!(report.new_rel_path, "设计.md");
        assert_eq!(
            read(dir.path(), "设计.md"),
            "[图](项目/附件/图.png) 与 [乙](笔记/乙.md)\n",
            "落到根目录后路径是「从根起算」的写法，不再有 `..`"
        );

        // 方向二：Vault 根 → 子目录
        let (dir, root, mut index) = vault(&[
            ("设计.md", "[图](附件/图.png) 与 [乙](笔记/乙.md)\n"),
            ("附件/图.png", "png"),
            ("笔记/乙.md", "# 乙\n"),
        ]);
        let report =
            move_note(&root, &mut index, "设计.md", "项目/深层", None, true, None).unwrap();

        assert_eq!(report.new_rel_path, "项目/深层/设计.md");
        assert_eq!(
            read(dir.path(), "项目/深层/设计.md"),
            "[图](../../附件/图.png) 与 [乙](../../笔记/乙.md)\n"
        );
    }

    #[test]
    fn move_leaves_own_links_that_do_not_follow_the_note_untouched() {
        let original = concat!(
            "![根绝对](/附件/图.png)\n",
            "![外链](https://example.com/图.png)\n",
            "![邮件](mailto:a@b.c)\n",
            "![内联](data:image/png;base64,AAAA)\n",
            "![资源](asset://localhost/附件/图.png)\n",
            "![协议相对](//example.com/图.png)\n",
            "[锚点](#小节)\n",
            "[[乙]]\n",
            "行内 `![](../附件/图.png)` 与真链接 ![图](../附件/图.png)\n",
            "\n```text\n![代码块](../附件/图.png)\n```\n",
            // 转义掉开头的 `[` 之后整段都不是链接；而 `\![x](y)` 仍然是**链接**（只是不再是
            // 图片）—— 抽取器与渲染器在这一点上一致，所以那种写法会被照常改写
            "\n\\[不是链接](../附件/图.png) 与 \\[[不是 wikilink]]\n",
        );
        let (dir, root, mut index) = vault(&[
            ("项目/设计.md", original),
            ("项目/乙.md", "# 乙\n"),
            ("附件/图.png", "png"),
        ]);
        let report = move_note(
            &root,
            &mut index,
            "项目/设计.md",
            "日记/2026",
            None,
            true,
            None,
        )
        .unwrap();

        assert_eq!(
            read(dir.path(), "日记/2026/设计.md"),
            original.replace(
                "真链接 ![图](../附件/图.png)",
                "真链接 ![图](../../附件/图.png)"
            ),
            "只有正文里那条真链接被改写；scheme/协议相对/根绝对/锚点/裸名 wikilink/代码/转义一律放行"
        );
        assert_eq!(report.updated_links, vec![entry("项目/设计.md", 1)]);
        assert_eq!(report.updated_link_count, 1);
    }
    #[test]
    fn move_keeps_angle_brackets_and_titles_in_the_moved_notes_own_links() {
        let (dir, root, mut index) = vault(&[
            (
                "项目/设计.md",
                "![图](<../附件/图 1.png>) 与 [文档](../笔记/乙.md \"标题\") 与 ![a](../附件/图.png '单引号')\n",
            ),
            ("附件/图 1.png", "png"),
            ("附件/图.png", "png"),
            ("笔记/乙.md", "# 乙\n"),
        ]);
        let report = move_note(
            &root,
            &mut index,
            "项目/设计.md",
            "日记/2026",
            None,
            true,
            None,
        )
        .unwrap();

        assert_eq!(
            read(dir.path(), "日记/2026/设计.md"),
            "![图](<../../附件/图 1.png>) 与 [文档](../../笔记/乙.md \"标题\") 与 ![a](../../附件/图.png '单引号')\n",
            "尖括号只换里面、`\"title\"` 原样留着"
        );
        assert_eq!(report.updated_link_count, 3);
    }

    #[test]
    fn move_skips_own_link_forms_we_cannot_rewrite_safely() {
        // 这三种形态**故意不改**（见 ADR-0012 的代价表）：
        // * 引用式定义的 URL 行 —— 抽取器不认识它（索引里也不算链接），另写一份解析器迟早与它分家；
        // * 反斜杠分隔的目标 —— Markdown 里 `\` 是转义字符，`..\附件\图.png` 的语义有歧义；
        // * 越出 Vault 根的目标（`../../外面/图.png`）—— 无法用 Vault 根相对路径表达。
        let original = concat!(
            "[引用式]: ../附件/图.png\n",
            "见 [图][引用式] 与 [带反斜杠](..\\附件\\图.png) 与 ![外面](../../外面/图.png)\n",
        );
        let (dir, root, mut index) = vault(&[("项目/设计.md", original), ("附件/图.png", "png")]);
        let report = move_note(
            &root,
            &mut index,
            "项目/设计.md",
            "日记/2026",
            None,
            true,
            None,
        )
        .unwrap();

        assert_eq!(
            read(dir.path(), "日记/2026/设计.md"),
            original,
            "改不了的形态宁可原样留着，也不写出一个必然悬空的链接"
        );
        assert!(report.updated_links.is_empty());
        assert_eq!(report.updated_link_count, 0);
    }

    #[test]
    fn move_preserves_bom_and_crlf_while_rewriting_own_links() {
        let (dir, root, mut index) = vault(&[
            (
                "项目/设计.md",
                "\u{feff}# 标题\r\n![图](../附件/图.png)\r\n[乙](乙.md)\r\n行尾空格  \r\n",
            ),
            ("附件/图.png", "png"),
            ("项目/乙.md", "# 乙\n"),
        ]);
        let report = move_note(
            &root,
            &mut index,
            "项目/设计.md",
            "日记/2026",
            None,
            true,
            None,
        )
        .unwrap();

        assert_eq!(
            read(dir.path(), "日记/2026/设计.md"),
            "\u{feff}# 标题\r\n![图](../../附件/图.png)\r\n[乙](../../项目/乙.md)\r\n行尾空格  \r\n"
        );
        let bytes = std::fs::read(dir.path().join("日记").join("2026").join("设计.md")).unwrap();
        assert_eq!(&bytes[..3], &[0xEF, 0xBB, 0xBF], "BOM 必须原样保留");
        assert_eq!(report.updated_link_count, 2);
    }

    #[test]
    fn move_updates_the_index_outbound_target_of_the_moved_note() {
        let (_dir, root, mut index) = vault(&[
            ("项目/设计.md", "[乙](../笔记/乙.md)\n"),
            ("笔记/乙.md", "# 乙\n"),
        ]);
        let report = move_note(
            &root,
            &mut index,
            "项目/设计.md",
            "日记/2026",
            None,
            true,
            None,
        )
        .unwrap();

        // 索引跟着正文一起走：出链目标必须是改写后的新路径，而且仍然解析得到原来那篇
        let links = index.note_links("日记/2026/设计.md");
        assert_eq!(links.outbound.len(), 1);
        assert_eq!(links.outbound[0].raw_target, "../../笔记/乙.md");
        assert_eq!(
            links.outbound[0].resolved_rel_path.as_deref(),
            Some("笔记/乙.md")
        );
        assert_eq!(links.unresolved_count, 0);
        assert_eq!(index.backlinks_of("笔记/乙.md").len(), 1);
        assert_eq!(report.updated_links, vec![entry("项目/设计.md", 1)]);
    }

    #[test]
    fn rename_does_not_touch_the_notes_own_relative_links() {
        // 同目录改名：目录没变 → 正文里任何相对路径的含义都不变（`always_relative` 只管
        // "指向被改名那篇"的链接），因此不该产生任何 diff
        let (dir, root, mut index) = vault(&[
            ("项目/设计.md", "![图](../附件/图.png) 与 [乙](乙.md)\n"),
            ("项目/乙.md", "# 乙\n"),
            ("附件/图.png", "png"),
        ]);
        let before = std::fs::metadata(dir.path().join("项目").join("设计.md"))
            .unwrap()
            .modified()
            .unwrap();

        let report = rename_note(&root, &mut index, "项目/设计.md", "方案", true, None).unwrap();

        assert_eq!(report.new_rel_path, "项目/方案.md");
        assert_eq!(
            read(dir.path(), "项目/方案.md"),
            "![图](../附件/图.png) 与 [乙](乙.md)\n"
        );
        assert!(report.updated_links.is_empty());
        assert_eq!(
            std::fs::metadata(dir.path().join("项目").join("方案.md"))
                .unwrap()
                .modified()
                .unwrap(),
            before
        );
    }

    #[test]
    fn move_carries_path_form_wikilinks_but_leaves_bare_names_alone() {
        // 含 `/` 的 wikilink 写的就是**路径**：索引对这类目标按"相对当前目录 → 相对根 →
        // 路径后缀"解析（`mn_index` 的 `resolve_target`），所以它与相对路径一样随位置漂移；
        // 不含 `/` 的裸名由"文件名主干 + 同目录优先"解析，属于另一套规则，本次不动。
        let (dir, root, mut index) = vault(&[
            (
                "项目/设计.md",
                "[[子/篇.md]] 与 ![[附件/图.png]] 与 [[乙]] 与 [[笔记/乙]]\n",
            ),
            ("项目/子/篇.md", "# 篇\n"),
            ("项目/乙.md", "# 乙\n"),
            ("笔记/乙.md", "# 根目录的乙\n"),
            ("附件/图.png", "png"),
        ]);
        let report = move_note(
            &root,
            &mut index,
            "项目/设计.md",
            "日记/2026",
            None,
            true,
            None,
        )
        .unwrap();

        assert_eq!(
            read(dir.path(), "日记/2026/设计.md"),
            "[[../../项目/子/篇.md]] 与 ![[../../项目/附件/图.png]] 与 [[乙]] 与 [[笔记/乙]]\n"
        );
        assert_eq!(report.updated_link_count, 2);
        // 索引必须仍然把那两条路径形式的链接解析到原来那篇笔记/原来那个位置
        let links = index.note_links("日记/2026/设计.md");
        assert_eq!(
            links.outbound[0].resolved_rel_path.as_deref(),
            Some("项目/子/篇.md")
        );
        assert_eq!(
            links.outbound[1].resolved_rel_path, None,
            "嵌入的图片本来就不在索引里（只收录 Markdown）"
        );
        assert_eq!(
            links.outbound[2].raw_target, "乙",
            "裸名 wikilink 一字不动 —— 代价是它的解析结果会漂移"
        );
        assert_eq!(
            links.outbound[2].resolved_rel_path.as_deref(),
            Some("笔记/乙.md"),
            "搬家前它指向同目录的 `项目/乙.md`，搬家后按「同目录优先 → 路径更短 → 字典序」落到了另一篇同名笔记上（ADR-0012 已记的已知限制）"
        );
        assert_eq!(links.unresolved_count, 1);
    }

    #[test]
    fn move_leaves_path_wikilinks_the_index_resolved_by_another_rule() {
        // `[[笔记/乙]]` 在 `项目/` 里靠"相对 Vault 根"这一级兜底解析成功 —— 它的含义
        // **不是**"项目/笔记/乙"，按算术改写成 `../../笔记/乙` 反而会把它弄悬空，因此放行
        let (dir, root, mut index) =
            vault(&[("项目/设计.md", "[[笔记/乙]]\n"), ("笔记/乙.md", "# 乙\n")]);
        let report = move_note(
            &root,
            &mut index,
            "项目/设计.md",
            "日记/2026",
            None,
            true,
            None,
        )
        .unwrap();

        assert_eq!(read(dir.path(), "日记/2026/设计.md"), "[[笔记/乙]]\n");
        assert!(report.updated_links.is_empty());
        assert_eq!(
            index.note_links("日记/2026/设计.md").outbound[0]
                .resolved_rel_path
                .as_deref(),
            Some("笔记/乙.md"),
            "放行之后它照旧解析得到（根相对这一级不随位置变）"
        );
    }

    #[test]
    fn deep_move_keeps_the_moved_notes_self_links_resolvable() {
        // 回归：正文改写后落在新目录，自链接必须按**新位置**表达。若按旧目录写
        //（`../../../归档/甲`），从新位置解析时会直接跑出 Vault 根 → 链接悬空。
        let (dir, root, mut index) = vault(&[("深/层/项目/甲.md", "[[甲]] 与 [自己](甲.md)\n")]);
        let report = move_note(
            &root,
            &mut index,
            "深/层/项目/甲.md",
            "归档",
            None,
            true,
            None,
        )
        .unwrap();

        assert_eq!(report.new_rel_path, "归档/甲.md");
        assert_eq!(
            read(dir.path(), "归档/甲.md"),
            "[[甲]] 与 [自己](甲.md)\n",
            "从新位置看，裸名就是这两条链接最自然的写法（与原文一字不差 → 不改）"
        );
        let links = index.note_links("归档/甲.md");
        assert_eq!(links.unresolved_count, 0, "两条自链接都必须解析得到自己");
        for link in &links.outbound {
            assert_eq!(link.resolved_rel_path.as_deref(), Some("归档/甲.md"));
        }
    }

    #[test]
    fn moving_a_non_note_never_rewrites_its_bytes() {
        // 改写只对 Markdown 笔记做：`.txt`/`.json`/图片里长得像链接的文本一律不碰
        //（非 UTF-8 会读失败，但 UTF-8 的文本文件不会 —— 只能靠扩展名判断）
        let (dir, root, mut index) = vault(&[
            ("素材/清单.txt", "见 [图](../附件/图.png)\n"),
            ("甲.md", ""),
        ]);
        let report = move_note(
            &root,
            &mut index,
            "素材/清单.txt",
            "归档/深层",
            None,
            true,
            None,
        )
        .unwrap();

        assert_eq!(report.new_rel_path, "归档/深层/清单.txt");
        assert_eq!(
            read(dir.path(), "归档/深层/清单.txt"),
            "见 [图](../附件/图.png)\n"
        );
        assert!(report.updated_links.is_empty());
    }
}
