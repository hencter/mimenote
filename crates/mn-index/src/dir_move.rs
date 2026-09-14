//! **目录重命名 / 目录移动**：把整棵子树换个位置，再改写全库指向子树里每一篇的链接。
//!
//! 为什么不新写一套改写逻辑：一次"目录搬迁"本质上是"子树里每篇笔记按新前缀 relocate
//! （[`crate::rename`] 的候选集、span 改写、保真纪律原样复用）+ 改写全库指向它们的链接"。
//! 另写一套的话，两边的 Markdown 形态支持度一定会漂移（表现为"单篇移动改对了、目录移动没改"），
//! 而那种缺陷只有用户撞上才会发现。因此这里只补**目录特有的那部分**：
//!
//! ## 1. 为什么搬的是整棵目录，而不是"逐篇 relocate"
//!
//! 同卷内 `fs::rename` 一次系统调用就把整棵树搬完（与子树大小无关，见
//! [`mn_core::atomic::move_dir`]），而且**整体成败** —— 逐篇搬要 N 次系统调用，中途失败
//! 还会留下"半棵子树"。跨卷（Vault 里有联接目录指向另一个卷）时退回递归复制 + 删源。
//!
//! ## 2. 链接改写的核心：**前缀映射 + 与单篇移动同一条路径算术**
//!
//! 对候选集里的每一篇，逐条链接算一次：
//!
//! 1. 这条链接**原本指向谁**（`LinkIndex::resolve`，与反链面板/索引完全同一套规则）；
//!    指向的东西在子树里 → 把它的路径按 `旧前缀 → 新前缀` 映射；
//! 2. 否则把"相对于本文件旧目录"的目标路径换算成 Vault 根相对路径，同样过一遍前缀映射
//!    （这一步覆盖图片、PDF、以及**指向子树之外的相对链接**）；
//! 3. 用与单篇移动**同一个** [`crate::rename::new_target_for`]（同一个 `TargetStyle`）
//!    把映射结果表达成本文件**改写后**目录下的写法；结果与原文一字不差就不写盘。
//!
//! 这个组合自然给出两种直觉上不同的行为，而且都不需要特例：
//!
//! * 源文件**在子树里**（跟着一起搬）：源与目标的相对位置不变 ⇒ 换算结果与原文一字不差
//!   ⇒ 一个字符都不动（子树内部的相对链接保持最小 diff，mtime 也不跳）；
//! * 源文件**在子树外**（原地不动）：换算结果必然变化 ⇒ 链接改成指向新位置。
//!
//! 反过来说：**不要**用"把链接文本里的旧目录名替换成新的"这种纯文本做法 —— 源文件跟着搬时
//! 那个文本是相对路径（`[[../子/甲]]`），替换只会写出悬空链接。
//!
//! ## 3. 裸名 wikilink：按"加不加目录前缀"重新表达
//!
//! 单篇移动刻意不碰裸名（`[[乙]]`）：它按文件名主干解析，改写成路径反而更长。目录搬迁
//! **必须**碰那些原本指向子树里的裸名 —— 子树一换名字，同一条 `[[乙]]` 就可能落到全库
//! 另一篇同名笔记上（静默的错误指向，比"链接变长"严重得多）。规则是"加不加目录前缀"而不是
//! "一律改成相对路径"：源与目标一起搬、还在同一层时写出来仍是裸名（`[[乙]]` 在 `项目/`
//! 与 `归档/` 里含义相同 ⇒ 最小 diff），只有真的需要区分时才带上一段目录。
//!
//! ## 4. 顺序与原子性（与 [`crate::rename`] 同一纪律）
//!
//! 1. 先算**全部**改写计划（此时索引里还是旧路径，才能用同一套解析规则找候选集）；
//! 2. 再搬整棵目录（同卷一次原子 rename）；
//! 3. 再逐个写回被改写的文件（`write_atomic`）；
//! 4. 最后同步索引与全文搜索（旧路径消失、新路径立刻可查）。
//!
//! 部分失败：某个被改写文件写失败**不回滚搬迁**（目录已经在新位置了，回滚只会制造更大的
//! 不一致），只记日志并把它排除出 `updated_links`；只有搬迁本身失败才返回错误 —— 那时
//! 磁盘上一个字节都没动过。

use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;

use mn_core::atomic::{move_dir, read_text, write_atomic, MoveMethod};
use mn_core::links::{
    extract_links_with_spans, is_position_relative_target, join_relative, normalize_target,
    replace_link_target, LinkSpan,
};
use mn_core::path_guard::VaultRoot;
use mn_core::{Error, Result};

use crate::rename::{
    dir_move_targets, dir_rename_targets, new_target_for, target_style, LinkUpdate, RenameReport,
    RenameTargets,
};
use crate::{path_inside, remap_prefix, LinkIndex, SearchIndex};

/// 改写时单个文件的读取上限。与 `rename.rs` 同一口径（刻意不复用 `MAX_INDEX_BYTES`：
/// 那是"索引要不要收录"的门槛，而改写要尽可能完整）。
const MAX_REWRITE_BYTES: u64 = mn_core::DEFAULT_MAX_READ_BYTES;

/// UTF-8 BOM。必须原样保留，否则"改一次链接 = 首行 diff"。
const BOM: char = '\u{feff}';

/// Vault 的内部工作目录（回收站、缓存库、用户片段都在里面）。
///
/// 不允许把它卷进一次搬迁：日志/缓存天然带 mtime 变化，搬完缓存库自己就成了过期数据；
/// 而且用户根本看不到它（扫描器直接忽略），不存在"整理进 `.mimenote`"这种需求。
const META_DIR: &str = ".mimenote";

/// 目录移动的入参校验（多一条"不许搬进自己"）。
///
/// 为什么这条必须在这里拦：文件系统层面它确实会失败，但错误是"系统找不到指定的路径"这种
/// 用户无法据以行动的话；而它恰恰是拖拽最容易犯的错（把 `项目` 拖到 `项目/子项目` 上）。
/// 两侧都做这条判断：前端 [`apps/desktop/src/domain/drag.ts`] 负责"根本不让它落"，
/// 宿主负责"谁来都不许"。
pub fn move_targets(
    old_rel_path: &str,
    target_parent_rel: &str,
    new_name: Option<&str>,
) -> Result<RenameTargets> {
    let targets = dir_move_targets(old_rel_path, target_parent_rel, new_name)?;
    // "目标父目录就是它自己"= 父目录没变 = 无操作：折叠成新旧一致，让搬迁本体当无操作处理
    //（与单篇移动"移到自己所在目录 = 无操作"完全一致，而不是报一个用户看不懂的"不能搬进自己"）
    if targets.new_rel == targets.old_rel || is_into_itself(&targets.old_rel, &targets.new_rel) {
        return Ok(RenameTargets {
            old_rel: targets.old_rel.clone(),
            new_rel: targets.old_rel,
        });
    }
    reject_self_nesting(&targets.old_rel, &targets.new_rel)?;
    reject_meta_dir(&targets.old_rel, &targets.new_rel)?;
    Ok(targets)
}

/// 执行"目录重命名 + 整棵子树的链接改写"。
///
/// 出参复用 [`RenameReport`]：一次目录搬迁要交代的仍然是"旧路径 / 新路径 / 被改写的文件与条数"，
/// 宿主因此不需要为它发明第二种契约形状（前端也只多一处"替换整棵子树"的状态收尾）。
/// 唯一的字段语义差别是 `mtime_ms` —— 目录不是版本令牌的载体（ADR-0004 的令牌是**文件** mtime），
/// 因此如实报 `0`，而不是塞一个会被误用的数字。
pub fn rename_dir(
    root: &VaultRoot,
    index: &mut LinkIndex,
    old_rel_path: &str,
    new_name: &str,
    update_links: bool,
    search: Option<&SearchIndex>,
) -> Result<RenameReport> {
    let targets = dir_rename_targets(old_rel_path, new_name)?;
    reject_meta_dir(&targets.old_rel, &targets.new_rel)?;
    relocate_dir(root, index, targets, update_links, search)
}

/// 执行"目录移动 + 整棵子树的链接改写"（`new_name` 为 `None` 时沿用目录名）。
///
/// 目标父目录不存在时会创建；目标位置已有同名目录 → `ALREADY_EXISTS`（**绝不合并**）。
pub fn move_dir_tree(
    root: &VaultRoot,
    index: &mut LinkIndex,
    old_rel_path: &str,
    target_parent_rel: &str,
    new_name: Option<&str>,
    update_links: bool,
    search: Option<&SearchIndex>,
) -> Result<RenameReport> {
    let targets = move_targets(old_rel_path, target_parent_rel, new_name)?;
    relocate_dir(root, index, targets, update_links, search)
}

/// 把目录搬进自己（或自己的后代）必须被拒绝。
///
/// "搬到同一处"（`target_parent` 就是它自己，或新旧路径完全相同）不算错：那是无操作，
/// 由 [`relocate_dir`] 照常返回 —— 与单篇移动"移到自己所在目录 = 无操作"完全一致。
fn reject_self_nesting(old_rel: &str, new_rel: &str) -> Result<()> {
    if new_rel != old_rel && !is_into_itself(old_rel, new_rel) && path_inside(new_rel, old_rel) {
        return Err(Error::invalid(
            new_rel,
            format!("不能把目录搬到它自己或它的子目录里（{old_rel}）"),
        ));
    }
    Ok(())
}

/// `new_rel` 是不是"把 `old_rel` 放进 `old_rel` 自己里面"（`项目` → `项目/项目`）。
///
/// 这种写法只有一个来源：用户在「移动到…」里填了目录自己（或拖到它自己的行上）。
/// 它与真正的"搬进子目录"必须分开：前者是**无操作**（父目录没变），后者才是错误。
fn is_into_itself(old_rel: &str, new_rel: &str) -> bool {
    let name = old_rel.rsplit('/').next().unwrap_or(old_rel);
    new_rel == format!("{old_rel}/{name}")
}

/// 内部工作目录不参与搬迁（理由见 [`META_DIR`]）。
fn reject_meta_dir(old_rel: &str, new_rel: &str) -> Result<()> {
    // 注意两侧都要判：`.mimenote` 自己不是"它自己的后代"（`path_inside` 是严格包含），
    // 所以要单独比对一次相等
    let touches = old_rel == META_DIR
        || new_rel == META_DIR
        || path_inside(old_rel, META_DIR)
        || path_inside(new_rel, META_DIR);
    if touches {
        return Err(Error::invalid(
            new_rel,
            format!("{META_DIR} 是应用的内部目录，不能重命名或移动"),
        ));
    }
    Ok(())
}

/// 搬迁的**唯一主体**：算计划 → 搬树 → 写回 → 同步索引。
fn relocate_dir(
    root: &VaultRoot,
    index: &mut LinkIndex,
    targets: RenameTargets,
    update_links: bool,
    search: Option<&SearchIndex>,
) -> Result<RenameReport> {
    let started = Instant::now();
    let old_rel = targets.old_rel;
    let new_rel = targets.new_rel;

    let old_path = root.resolve_existing(&old_rel)?;
    let metadata = std::fs::metadata(&old_path).map_err(|e| Error::io(&old_path, e))?;
    if !metadata.is_dir() {
        return Err(Error::NotADirectory(old_rel));
    }

    if old_rel == new_rel {
        // 名字没变：什么都不用做（也顺手避开各平台"rename 到自身路径"的语义差异）
        return Ok(RenameReport {
            old_rel_path: old_rel,
            new_rel_path: new_rel,
            mtime_ms: mn_core::atomic::mtime_ms(&metadata).unwrap_or(0),
            size_bytes: 0,
            updated_links: Vec::new(),
            updated_link_count: 0,
            elapsed_ms: started.elapsed().as_millis() as u64,
        });
    }

    let new_path = root.resolve_for_write(&new_rel)?;
    if occupied(&new_path) {
        // **绝不覆盖、也绝不合并**：拖拽的目标末级目录通常是已存在的文件夹，
        // 若放行就等于把两棵子树悄悄合并到一起（不可逆，且没有任何提示）
        return Err(Error::AlreadyExists(new_rel));
    }
    ensure_new_parent(root, &new_rel)?;

    // 1) 计划（只读候选集文件，不落盘）
    let planning = Instant::now();
    let plan = if update_links {
        plan_dir_rewrites(root, index, &old_rel, &new_rel)
    } else {
        Vec::new()
    };
    let plan_ms = planning.elapsed().as_millis() as u64;

    // 目录遍历等 IO 可能耗时；搬树前的最后一刻再确认目标没被外部创建 ——
    // Windows 上 `rename` 到已存在的目录是失败，但在别的平台语义不同，宁可在这里保守拦一次
    if occupied(&new_path) {
        return Err(Error::AlreadyExists(new_rel));
    }

    // 2) 搬整棵目录：同卷一次原子 rename；跨卷退回递归复制 + 删源
    let moving = Instant::now();
    match move_dir(&old_path, &new_path).map_err(|e| relocate_error(e, &new_rel))? {
        MoveMethod::Rename => {}
        MoveMethod::CopyAndDelete => log::warn!(
            "目录跨卷搬迁（{old_rel} → {new_rel}）：rename 不可用，已退回复制 + 删除源（中途崩溃可能留下两份）"
        ),
    }
    let move_ms = moving.elapsed().as_millis() as u64;

    // 3) 写回被改写的文件（子树里的那部分落在**新路径**上）
    let writing = Instant::now();
    let mut updated_links: Vec<LinkUpdate> = Vec::new();
    let mut updated_link_count = 0u32;
    for item in &plan {
        let rel_after = remap_prefix(&item.rel_path, &old_rel, &new_rel)
            .unwrap_or_else(|| item.rel_path.clone());
        let path = match root.resolve_for_write(&rel_after) {
            Ok(path) => path,
            Err(error) => {
                log::warn!("目录搬迁改写跳过 {rel_after}：{error}");
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
            }
            Err(error) => {
                // 不回滚搬迁：只把这一篇排除出结果（它的链接暂留旧目标，用户会看到悬空链接）
                log::warn!("目录搬迁改写失败（已跳过，不回滚搬迁）：{rel_after}：{error}");
            }
        }
    }
    updated_links.sort_by(|left, right| left.rel_path.cmp(&right.rel_path));
    let write_ms = writing.elapsed().as_millis() as u64;

    // 4) 索引与全文搜索同步：旧路径消失、新路径立刻可查，不必等重扫
    let syncing = Instant::now();
    sync_indexes(root, index, search, &plan, &old_rel, &new_rel);
    let sync_ms = syncing.elapsed().as_millis() as u64;

    let elapsed_ms = started.elapsed().as_millis() as u64;
    log::info!(
        "目录搬迁：{old_rel} → {new_rel}（改写 {} 个文件 / {} 条链接，耗时 {elapsed_ms}ms；\
         计划 {plan_ms}ms / 搬树 {move_ms}ms / 写回 {write_ms}ms / 索引 {sync_ms}ms）",
        updated_links.len(),
        updated_link_count
    );

    Ok(RenameReport {
        old_rel_path: old_rel,
        new_rel_path: new_rel,
        mtime_ms: 0,
        size_bytes: 0,
        updated_links,
        updated_link_count,
        elapsed_ms,
    })
}

/// 搬家失败时的错误翻译（与单篇搬迁同一口径：`ALREADY_EXISTS` 必须原样透给 UI）。
fn relocate_error(error: Error, new_rel: &str) -> Error {
    match error.code() {
        mn_core::ErrorCode::AlreadyExists => Error::AlreadyExists(new_rel.to_string()),
        _ => error,
    }
}

/// 目标位置是否**已经**被占用（目录搬迁不接受覆盖，因此不看"是不是同一个东西"）。
fn occupied(new_path: &Path) -> bool {
    new_path.exists()
}

/// 目标位置的上一级目录不存在时创建（"移动到新建目录"是键盘路径下的正常需求）。
fn ensure_new_parent(root: &VaultRoot, new_rel: &str) -> Result<()> {
    let parent = match new_rel.rfind('/') {
        Some(index) => new_rel[..index].to_string(),
        None => return Ok(()),
    };
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

/// 一条待落盘的改写（与 `rename.rs` 同构：`rel_path` 是**改写前**的口径）。
#[derive(Debug, Clone)]
struct PlannedRewrite {
    rel_path: String,
    new_text: String,
    count: u32,
}

/// 一批源文件的改写坐标系（把 `rename.rs` 的 `RewriteFrame` 换成"整棵子树"）。
struct DirFrame<'a> {
    /// 被改写的那篇（改写前的路径）。
    from_rel: &'a str,
    /// 它改写后落在哪里。
    to_rel: String,
    /// 搬迁的旧前缀。
    old_prefix: &'a str,
    /// 搬迁的新前缀。
    new_prefix: &'a str,
}

impl DirFrame<'_> {
    /// 一条链接改成什么；`None` = 放行（一个字符都不动）。
    ///
    /// 判定顺序是刻意的：**先看这条链接原来指向谁**（索引规则），再看它的含义是否随搬迁变化。
    /// 反过来（先看文本像不像路径）会把 `[[乙]]` 这类裸名整个漏掉 —— 而它恰恰是最需要处理的一类。
    ///
    /// 三条分支各管一类，互不重叠：
    ///
    /// | 这条链接原本指向 | 新目标 |
    /// | --- | --- |
    /// | 子树里的某篇（索引解析得到，**或**按 Vault 根口径写的前缀路径） | 前缀映射后的真身 |
    /// | 子树之外，但本文件自己也在搬 | 同一处按**新目录**重新表达（`../附件/图.png` 会多一层） |
    /// | 子树之外、本文件又没搬 | 一个字都不动（相对关系没变，写盘只会制造无意义的 diff） |
    ///
    /// 第一行的"或"是有意的：`[[项目/乙]]` 这种**根口径**写法在索引里可能靠"相对 Vault 根"
    /// 那一级才解析成功，也可能压根解析不到（那篇还没建）。两种情况下"把前缀换掉"都对
    ///（前者指向搬迁后的真身，后者保持悬空，但保住"指向新目录下那一篇"的意思）。
    fn target_for(
        &self,
        index: &LinkIndex,
        raw: &str,
        wiki: bool,
        line: &str,
        span: &LinkSpan,
    ) -> Option<String> {
        if !is_position_relative_target(raw) {
            return None;
        }
        // 反斜杠目标不做算术：本层的路径运算只认 POSIX `/`，而 Markdown 里 `\` 是转义字符
        //（`\.` 与 `\附` 语义不同）。宁可少改，也不要把一个地址改坏（与 ADR-0012 同一取舍）
        if raw.contains('\\') {
            return None;
        }
        let bare = !normalize_target(raw).contains('/');
        let _ = wiki;

        // 第一步：**这条链接原本指向哪一篇**，以及它搬迁后落在哪里。
        //
        // "索引解析到的目标 + 前缀映射"是最高优先级的一支：它既覆盖"子树里的某篇笔记"
        //（搬迁后的真身），也覆盖"按 Vault 根口径写的前缀路径"（`[[项目/乙]]`；解析成功与否
        // 都不影响结论 —— 没解析到说明这篇还没建，搬迁后它依然悬空，但"指向新目录下那一篇"
        // 的意思必须跟着走）。
        //
        // 兜底用**相对本文件旧目录**的路径算术：它覆盖图片/PDF（索引不收录），以及
        // 指向子树**之外**的相对链接（`../附件/图.png`、`[乙](乙.md)`）—— 那些链接的落点是
        // 由本文件的位置定义的，本文件换了一层目录就得重新表达。
        let landing = match index.resolve(self.from_rel, raw) {
            Some(resolved) => {
                // 索引解析到的目标**不在**子树里时，它就是这条链接此刻的真实含义，必须与
                // 路径算术的落点一致；不一致（`[[项目/甲]]` 写在 `项目/子/丙.md` 里，索引按
                // "同目录优先"解析到了别处）就放行不动 —— 与 ADR-0012 对单篇移动的处置一致。
                if !self.inside(&resolved) && !self.index_agrees(index, raw, &resolved) {
                    return None;
                }
                remap_prefix(&resolved, self.old_prefix, self.new_prefix)
                    .or_else(|| self.relative_of(raw))
            }
            // 索引解析不到（悬空链接、图片、附件）：按 Vault 根口径写的路径先做前缀映射，
            // 落不到前缀上就退回"相对本文件旧目录"
            None => self.relocate(raw).or_else(|| self.relative_of(raw)),
        };
        let landing = landing?;

        // 裸名（`[[乙]]`）不是路径，它由索引按"文件名主干 + 同目录优先"解析：一旦新目标不再与
        // 本文件同层，就必须写成路径形式，否则 `[[乙]]` 会被全库**另一篇**同名笔记抢走 ——
        // 那正是目录搬迁最需要防的静默错误指向。其余形态保持用户原来的写法风格。
        //
        // 单段相对写法（`[乙](乙.md)`）同理：它写的是"相对本文件所在目录"，本文件换了目录之后
        // 同一个字面目标指向的是**另一篇**同名文件，必须重新表达（由 `new_target_for` 的
        // 相对路径那一支完成）。
        let style = target_style(&landing, bare);
        let form = new_target_for(raw, line, span, &self.new_dir(), &style);
        // 最后一道校验：改写后的写法**按新坐标必须真的解析得到** `landing`。索引的解析有三条
        // 路径（相对当前目录 → 相对 Vault 根 → **路径后缀**），只有前两条随源文件一起平移。
        // 一条原本靠后缀兜住才能解析的链接（`[[子/丙]]` 写在 `项目/甲.md` 里，靠"后缀 ∩
        // 全库唯一"命中），在子树换名字之后就不再唯一 —— 保持原文会让它变成悬空链接，
        // 所以必须改写成相对写法（`[[工程/子/丙]]`）。
        if !bare && !self.resolves_after_move(raw, &form, &landing) {
            let relative_style = target_style(&landing, true);
            let relative_form = new_target_for(raw, line, span, &self.new_dir(), &relative_style);
            if relative_form == raw || !self.resolves_after_move(raw, &relative_form, &landing) {
                // 换成相对写法也解析不到：宁可保持原样（悬空的观感与搬迁前一致），
                // 也不写出一个必然悬空的链接
                return None;
            }
            return Some(relative_form);
        }
        (form != raw).then_some(form)
    }

    /// `form` 在**搬迁之后**能不能解析到 `landing`。
    ///
    /// 判定按索引三条解析规则的**前两条**做（相对当前目录 → 相对 Vault 根），第三条
    /// （路径后缀）刻意**不算**：它靠"全库唯一"成立，而子树改名恰好会打破这种唯一性 ——
    /// 那种链接必须被改写成前两条里的某一种，否则搬迁后就悬空了。
    fn resolves_after_move(&self, raw: &str, form: &str, landing: &str) -> bool {
        let relative = if raw.contains('/') { form } else { raw };
        let key = normalize_target(relative);
        if key.is_empty() {
            return false;
        }
        let candidates = [
            join_relative(&self.new_dir(), &key),
            join_relative("", &key),
        ];
        candidates
            .into_iter()
            .flatten()
            .any(|candidate| path_key(&candidate) == path_key(landing))
    }

    /// `raw` 按"相对本文件**旧**目录"换算出的 Vault 根相对路径。
    fn relative_of(&self, raw: &str) -> Option<String> {
        Some(fold_relative(&join_relative(&self.old_dir_of_self(), raw)?))
    }

    /// 把 `raw` 当成 Vault 根相对路径做一次搬迁前缀映射（落不到前缀上 → `None`）。
    fn relocate(&self, raw: &str) -> Option<String> {
        let key = raw.trim().replace('\\', "/");
        let key = key.trim_start_matches('/');
        // 只对**本来就带旧前缀**的写法有意义：`[[项目/乙]]` 在 `项目` 被搬走之后应该变成
        // `[[归档/项目/乙]]`（搬迁前那条链接是悬空的，搬迁后**依然悬空**，但"指向新目录下
        // 那一篇"的意思被保住了）。反过来，一个与旧前缀无关的相对路径（`c/笔记`）绝不能
        // 因为"它拼出来的 Vault 根路径恰好落在旧前缀下"而被牵连改动。
        if !path_inside(&fold_relative(key), self.old_prefix) {
            return None;
        }
        remap_prefix(&fold_relative(key), self.old_prefix, self.new_prefix)
    }

    /// 索引解析到的目标，与"把 `raw` 当成 Vault 根相对路径"是不是同一篇。
    ///
    /// 用索引的解析规则反查一次比对比字符串更稳：`..` 这类相对走位在折叠之前不该被丢掉，
    /// 而索引自己最清楚 `别的/../工程/乙` 指的是哪一篇。
    fn index_agrees(&self, index: &LinkIndex, raw: &str, resolved: &str) -> bool {
        let folded = fold_relative(raw.trim_start_matches('/'));
        if folded.is_empty() {
            return true;
        }
        index.resolve(self.from_rel, &folded).as_deref() == Some(resolved)
    }

    /// 某个路径是不是落在被搬迁的子树里。
    fn inside(&self, rel: &str) -> bool {
        path_inside(rel, self.old_prefix)
    }

    /// 本文件改写前所在的目录。
    fn old_dir_of_self(&self) -> String {
        self.new_dir_of(self.from_rel)
    }

    /// 本文件改写后所在的目录（未搬迁时与 [`Self::old_dir_of_self`] 相同）。
    fn new_dir(&self) -> String {
        self.new_dir_of(&self.to_rel)
    }

    fn new_dir_of(&self, rel: &str) -> String {
        match rel.rfind('/') {
            Some(index) => rel[..index].to_string(),
            None => String::new(),
        }
    }
}

/// 把一条"Vault 根相对"的路径折叠成规范形式（消掉 `.` 与 `..`）。
///
/// 为什么必须折叠：`join_relative` 只在**已经给了一个目录**时才会把 `..` 消化掉
///（`join_relative("别的", "../../项目/乙")` → `项目/乙`，而 `join_relative("", "../../项目/乙")`
/// 会原样返回）。不折叠的话，那种路径永远匹配不上搬迁前缀，于是"深层目录里用 `../../` 写的
/// 引用"会被整个漏掉 —— 正是要靠这条改写的那一类。
fn fold_relative(rel: &str) -> String {
    // 已经越出 Vault 根的路径（`..` 多于层级）原样返回：它本来就在 Vault 之外，
    // 交给上层的 `join_relative` 判定去放行
    join_relative("", rel).unwrap_or_else(|| rel.to_string())
}

/// 真实路径的比较键：去掉 `.md`/`.markdown` 后缀（大小写保留）。
///
/// 刻意**不**复用 `normalize_target`：那个函数还会把大小写一起抹平，而"解析到了另一篇"
/// 恰恰是要拦住的事。
fn path_key(rel: &str) -> &str {
    let trimmed = rel.trim_end_matches('/');
    for suffix in [".markdown", ".md", ".MD", ".Markdown"] {
        if let Some(stripped) = trimmed.strip_suffix(suffix) {
            return stripped;
        }
    }
    trimmed
}

/// 只读地算出改写计划：**只碰候选集**（出链解析到子树内的文件 + 子树里那些笔记自身）。
fn plan_dir_rewrites(
    root: &VaultRoot,
    index: &LinkIndex,
    old_rel: &str,
    new_rel: &str,
) -> Vec<PlannedRewrite> {
    let mut sources = referrers_into(index, old_rel);
    // 子树里每一篇**自身的正文**也要看：它正文里的相对路径（图片、同级笔记、指向子树之外
    // 的链接）在搬家之后可能会错位。索引里查不到"谁指向图片"，只能显式把这些文件加进来。
    for note in index.paths_under(old_rel) {
        if !sources.contains(&note) {
            sources.push(note);
        }
    }
    sources.sort();

    let mut planned = Vec::new();
    for from_rel in sources {
        let path = match root.resolve_existing(&from_rel) {
            Ok(path) => path,
            Err(error) => {
                log::warn!("目录搬迁改写跳过 {from_rel}：{error}");
                continue;
            }
        };
        let text = match read_text(&path, MAX_REWRITE_BYTES) {
            Ok(text) => text,
            Err(error) => {
                log::warn!("目录搬迁改写跳过 {from_rel}：{error}");
                continue;
            }
        };
        let to_rel = remap_prefix(&from_rel, old_rel, new_rel).unwrap_or_else(|| from_rel.clone());
        let frame = DirFrame {
            from_rel: &from_rel,
            to_rel,
            old_prefix: old_rel,
            new_prefix: new_rel,
        };
        let (new_text, count) = rewrite_dir_text(index, &text, &frame);
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

/// 全库里"有链接指向子树内某一篇"的文件（**一趟线性遍历**，与反链面板同一套解析规则）。
///
/// 为什么不用 `LinkIndex::referrers_of` 逐篇问：那是 O(笔记数 × 子树篇数)，1000 篇的目录
/// 就是千万级字符串比较。这里每条出链解析一次，成本与全库出链数同阶（毫秒级）。
/// 前提与单篇改名完全一致：**索引已经建好**（构建中搬迁会漏掉尚未收录的引用者）。
fn referrers_into(index: &LinkIndex, old_rel: &str) -> Vec<String> {
    let mut out: Vec<String> = index
        .paths()
        .into_iter()
        .filter(|from_rel| {
            index.raw_targets(from_rel).into_iter().any(|raw| {
                index
                    .resolve(from_rel, raw)
                    .is_some_and(|target| path_inside(&target, old_rel))
            })
        })
        .collect();
    out.sort();
    out
}

/// 改写一篇文件里所有与这次搬迁有关的链接，返回（新文本，改写条数）。
fn rewrite_dir_text(index: &LinkIndex, text: &str, frame: &DirFrame<'_>) -> (String, u32) {
    // BOM 摘出去单独处理：正文里不出现它，写回时再补上
    let (bom, body) = match text.strip_prefix(BOM) {
        Some(rest) => (BOM.to_string(), rest),
        None => (String::new(), text),
    };

    // 整篇一次抽取：围栏代码块的开关状态要跨行保持（逐行抽取会把代码块里的 `[[x]]` 改掉）
    let mut by_line: HashMap<u32, Vec<(String, LinkSpan)>> = HashMap::new();
    for (link, span) in extract_links_with_spans(body) {
        // `[[#小节]]` 这类纯锚点链接指的是文件自身，搬迁后依旧成立（也改不了）
        if link.raw_target.trim().is_empty() {
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
        for (raw, span) in items.iter().rev() {
            let wiki = is_wiki_syntax(&line, span);
            let computed = frame.target_for(index, raw, wiki, &line, span);
            let Some(target) = computed else {
                continue;
            };
            match replace_verified(&line, span, &target) {
                Some(replaced) => {
                    line = replaced;
                    count += 1;
                }
                None => log::warn!(
                    "目录搬迁改写跳过 {from} 第 {line_no} 行的链接（`{raw}` → `{target}` 无法安全替换）",
                    from = frame.from_rel,
                ),
            }
        }
        out.push_str(&line);
        out.push_str(ending);
    }

    if count == 0 {
        // 一条都没改成 → 原样返回，绝不写出"半改写"的文件
        return (text.to_string(), 0);
    }
    (format!("{bom}{out}"), count)
}

/// 替换目标文本并**回读校验**（含空格时自动补 `<>`；补不上就跳过）。
fn replace_verified(line: &str, span: &LinkSpan, new_target: &str) -> Option<String> {
    for candidate in [new_target.to_string(), format!("<{new_target}>")] {
        if let Some(replaced) = replace_link_target(line, span, &candidate) {
            let hit = extract_links_with_spans(&replaced)
                .into_iter()
                .any(|(link, found)| {
                    found.char_start == span.char_start && link.raw_target == candidate
                });
            if hit {
                return Some(replaced);
            }
        }
    }
    None
}

/// 目标是否写成了 `[[..]]`（`![[..]]` 也算）。只有 wikilink 才走"裸名也许仍成立"那条分支。
fn is_wiki_syntax(line: &str, span: &LinkSpan) -> bool {
    let chars: Vec<char> = line.chars().collect();
    match chars.get(span.char_start) {
        Some('[') => chars.get(span.char_start + 1) == Some(&'['),
        Some('!') => chars.get(span.char_start + 2) == Some(&'['),
        _ => false,
    }
}

/// 拆出行内容与行尾（`\r\n` / `\n` 原样保留）。
fn split_line_ending(raw: &str) -> (&str, &str) {
    if let Some(body) = raw.strip_suffix("\r\n") {
        (body, "\r\n")
    } else if let Some(body) = raw.strip_suffix('\n') {
        (body, "\n")
    } else {
        (raw, "")
    }
}

// ---------------------------------------------------------------------------
// 索引 / 全文搜索同步
// ---------------------------------------------------------------------------

/// 把链接索引与全文搜索索引整体搬到新前缀（**不整库重建**）。
///
/// 顺序（ADR-0014 的三条不变量）：
///
/// 1. `LinkIndex::remove` 先清掉内存记账与**库里这一篇的链接/标签落盘数据**；
/// 2. `SearchIndex::remove_note` 再清掉搜索的行、判定键，以及这棵子树在库里的**全部**残留；
/// 3. 最后 `LinkIndex::upsert` + `SearchIndex::upsert_note` 把新路径重新写进去。
///
/// 为什么第 2 步必须在第 3 步之前、而且必须用 `remove_note`（而不是只删 `lines`）：
/// 判定键（`notes_meta`）一旦留下，下一次打开就会拿一个对得上的键去复用一个已经不存在的
/// 路径 —— 属于"看不见的过期数据"。`remove_note` 是唯一把"行 + 判定键 + 链接/标签数据"
/// 一起清的入口。
fn sync_indexes(
    root: &VaultRoot,
    index: &mut LinkIndex,
    search: Option<&SearchIndex>,
    plan: &[PlannedRewrite],
    old_rel: &str,
    new_rel: &str,
) {
    let planned: HashMap<&str, &str> = plan
        .iter()
        .map(|item| (item.rel_path.as_str(), item.new_text.as_str()))
        .collect();

    // 新旧路径逐条算好再动索引：`paths_under` 读的是内存记账，边改边读会漏掉后半截
    let moves: Vec<(String, String)> = index
        .paths_under(old_rel)
        .into_iter()
        .filter_map(|note| remap_prefix(&note, old_rel, new_rel).map(|moved| (note, moved)))
        .collect();

    for (note, _) in &moves {
        index.remove(note);
        if let Some(search) = search {
            if let Err(error) = search.remove_note(note) {
                log::warn!("全文搜索索引删除失败（{note}）：{error}");
            }
        }
    }

    for (note, moved) in moves {
        // 被改写过的用计划里的文本（与磁盘上刚写下的逐字相同）；其余现读一次。
        // 读失败不中断整轮：这一篇从索引里消失，下一次重扫会自愈（索引是可重建的缓存）
        let text = match planned.get(note.as_str()) {
            Some(text) => (*text).to_string(),
            None => match root
                .resolve_for_write(&moved)
                .map_err(|error| error.to_string())
                .and_then(|path| read_text(&path, MAX_REWRITE_BYTES).map_err(|e| e.to_string()))
            {
                Ok(text) => text,
                Err(error) => {
                    log::warn!("目录搬迁后读取 {moved} 失败，它暂时不在索引里：{error}");
                    continue;
                }
            },
        };
        index.upsert(&moved, &text);
        if let Some(search) = search {
            if let Err(error) = search.upsert_note(&moved, &text) {
                log::warn!("全文搜索索引写入失败（{moved}）：{error}");
            }
        }
    }

    // 子树**之外**被改写的引用者也要重新入库：它们的路径没变，但正文里的链接目标变了。
    // 漏掉这一步的表现是"反链面板还指着旧路径、链接面板显示悬空"，而磁盘上其实已经改好了
    //（索引是可重建的缓存，下一次重扫会自愈 —— 但"等到重扫才正确"不是能接受的默认体验）。
    for item in plan {
        if remap_prefix(&item.rel_path, old_rel, new_rel).is_some() {
            continue; // 子树里的那部分已经在上面处理过
        }
        index.upsert(&item.rel_path, &item.new_text);
        if let Some(search) = search {
            if let Err(error) = search.upsert_note(&item.rel_path, &item.new_text) {
                log::warn!("全文搜索索引写入失败（{}）：{error}", item.rel_path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rename::LinkUpdate;
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

    /// 磁盘上的原文。
    fn read(dir: &Path, rel: &str) -> String {
        let path = path_of(dir, rel);
        std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("读不到 {rel}（{path:?}）：{error}"))
    }

    fn exists(dir: &Path, rel: &str) -> bool {
        path_of(dir, rel).exists()
    }

    fn path_of(dir: &Path, rel: &str) -> std::path::PathBuf {
        dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR))
    }

    fn entry(rel: &str, count: u32) -> LinkUpdate {
        LinkUpdate {
            rel_path: rel.to_string(),
            count,
        }
    }

    #[test]
    fn renames_a_directory_and_rewrites_every_link_into_it() {
        let (dir, root, mut index) = vault(&[
            ("项目/甲.md", "# 甲\n\n见 [[乙]] 与 [[子/丙]]。\n"),
            ("项目/乙.md", "# 乙\n"),
            ("项目/子/丙.md", "# 丙\n\n回到 [[../乙]] 与 [[../甲]]。\n"),
            ("别的/引用.md", "见 [[项目/乙]] 与 [[项目/甲|别名]]。\n"),
            ("深层/更/远.md", "见 [[../../项目/乙]]。\n"),
            ("附件/图.png", "png"),
        ]);

        let report = rename_dir(&root, &mut index, "项目", "工程", true, None).unwrap();

        assert_eq!(report.old_rel_path, "项目");
        assert_eq!(report.new_rel_path, "工程");
        assert!(exists(dir.path(), "工程/甲.md"));
        assert!(!exists(dir.path(), "项目/甲.md"), "旧目录必须整体消失");
        assert_eq!(
            report.updated_link_count, 3,
            "`别的/` 两条 + `深层/更/远.md` 一条（子树内部按新位置等价 ⇒ 不写盘）"
        );

        // 同目录的裸名链接在改名前后含义相同 → 一字不动（最小 diff）
        assert_eq!(
            read(dir.path(), "工程/甲.md"),
            "# 甲\n\n见 [[乙]] 与 [[子/丙]]。\n"
        );
        // 子树内部的相对链接同样一字不动（源与目标一起搬）
        assert_eq!(
            read(dir.path(), "工程/子/丙.md"),
            "# 丙\n\n回到 [[../乙]] 与 [[../甲]]。\n",
            "`[[项目/甲]]` 与 `[[../甲]]` 指同一篇（本文件也在搬，按新位置表达）"
        );
        // 子树之外的引用：路径形式改成新前缀，裸名带上目录段
        assert_eq!(
            read(dir.path(), "别的/引用.md"),
            "见 [[../工程/乙]] 与 [[../工程/甲|别名]]。\n"
        );
        assert_eq!(
            read(dir.path(), "深层/更/远.md"),
            "见 [[../../工程/乙]]。\n"
        );

        // 索引：旧路径消失、新路径可查、反链跟着走
        assert!(!index.contains("项目/乙.md"));
        assert!(index.contains("工程/乙.md"));
        assert_eq!(index.paths_under("项目").len(), 0);
        assert_eq!(index.paths_under("工程").len(), 3);
        assert_eq!(
            index.stats().unresolved,
            0,
            "改写后的链接必须仍然全部解析得到；实际：{:?} / {:?}",
            index.note_links("别的/引用.md").outbound,
            index.note_links("深层/更/远.md").outbound,
        );
    }

    #[test]
    fn directory_rename_accepts_chinese_names_and_case_changes() {
        let (dir, root, mut index) = vault(&[
            ("资料/子/笔记.md", "# 笔记\n"),
            ("甲.md", "[[资料/子/笔记]]\n"),
        ]);

        rename_dir(&root, &mut index, "资料/子", "笔记本", true, None).unwrap();
        assert!(exists(dir.path(), "资料/笔记本/笔记.md"));
        assert_eq!(read(dir.path(), "甲.md"), "[[资料/笔记本/笔记]]\n");

        // 只改大小写：Windows/macOS 上是同一个目录，必须放行，且路径口径要跟着变
        let report = rename_dir(&root, &mut index, "资料/笔记本", "NoteBook", true, None).unwrap();
        assert_eq!(report.new_rel_path, "资料/NoteBook");
        let names: Vec<String> = std::fs::read_dir(dir.path().join("资料"))
            .unwrap()
            .map(|item| item.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names.contains(&"NoteBook".to_string()), "实际：{names:?}");
        assert!(index.contains("资料/NoteBook/笔记.md"));
        assert!(
            !index.contains("资料/笔记本/笔记.md"),
            "旧路径必须从索引里消失"
        );
    }

    #[test]
    fn directory_rename_keeps_bom_crlf_and_untouched_links_intact() {
        let original = "# 标题\r\n\r\n```text\r\n[[项目/乙]]\r\n```\r\n\r\n行内 `[[项目/乙]]` 与真链接 [[项目/乙]]\r\n";
        let (dir, root, mut index) = vault(&[("甲.md", "\u{feff}"), ("项目/乙.md", "# 乙\n")]);
        // 换成一段**真的带 BOM + CRLF** 的正文（`vault` 只按给定文本原样落盘）
        std::fs::write(
            dir.path().join("甲.md"),
            format!("\u{feff}{original}").as_bytes(),
        )
        .unwrap();
        index.upsert("甲.md", &format!("\u{feff}{original}"));

        let report = rename_dir(&root, &mut index, "项目", "归档", true, None).unwrap();

        let expected = format!(
            "\u{feff}{}",
            original.replace("真链接 [[项目/乙]]", "真链接 [[归档/乙]]")
        );
        assert_eq!(
            read(dir.path(), "甲.md"),
            expected,
            "只有正文里那条真链接被改写"
        );
        assert_eq!(report.updated_links, vec![entry("甲.md", 1)]);
        let bytes = std::fs::read(dir.path().join("甲.md")).unwrap();
        assert_eq!(&bytes[..3], &[0xEF, 0xBB, 0xBF], "BOM 必须原样保留");
    }

    // -- 目录移动 -------------------------------------------------------------

    #[test]
    fn moves_a_directory_into_another_directory_and_into_the_root() {
        let (dir, root, mut index) = vault(&[
            ("项目/甲.md", "# 甲\n"),
            ("归档/说明.md", "见 [[项目/甲]]。\n"),
        ]);

        let report = move_dir_tree(&root, &mut index, "项目", "归档", None, true, None).unwrap();
        assert_eq!(report.new_rel_path, "归档/项目");
        assert!(exists(dir.path(), "归档/项目/甲.md"));
        assert_eq!(read(dir.path(), "归档/说明.md"), "见 [[项目/甲]]。\n");
        assert!(index.contains("归档/项目/甲.md"));

        // 再移到 Vault 根：链接的写法要跟着变成「从根起算」
        let report = move_dir_tree(&root, &mut index, "归档/项目", "", None, true, None).unwrap();
        assert_eq!(report.new_rel_path, "项目");
        assert!(exists(dir.path(), "项目/甲.md"));
        assert_eq!(read(dir.path(), "归档/说明.md"), "见 [[../项目/甲]]。\n");
    }

    #[test]
    fn moves_a_directory_into_a_newly_created_directory() {
        let (dir, root, mut index) = vault(&[("项目/甲.md", "# 甲\n"), ("乙.md", "[[项目/甲]]\n")]);

        let report =
            move_dir_tree(&root, &mut index, "项目", "归档/2026", None, true, None).unwrap();

        assert_eq!(report.new_rel_path, "归档/2026/项目");
        assert!(exists(dir.path(), "归档/2026/项目/甲.md"));
        assert_eq!(read(dir.path(), "乙.md"), "[[归档/2026/项目/甲]]\n");
        assert!(index.contains("归档/2026/项目/甲.md"));
    }

    #[test]
    fn moves_a_directory_with_a_new_name_in_one_step() {
        let (dir, root, mut index) = vault(&[("项目/甲.md", "# 甲\n"), ("乙.md", "[[项目/甲]]\n")]);

        let report =
            move_dir_tree(&root, &mut index, "项目", "归档", Some("工程"), true, None).unwrap();

        assert_eq!(report.new_rel_path, "归档/工程");
        assert!(exists(dir.path(), "归档/工程/甲.md"));
        assert_eq!(read(dir.path(), "乙.md"), "[[归档/工程/甲]]\n");
    }

    #[test]
    fn refuses_to_move_a_directory_into_itself_or_its_descendants() {
        let (dir, root, mut index) = vault(&[
            ("项目/甲.md", "# 甲\n"),
            ("项目/子/丙.md", "# 丙\n"),
            ("乙.md", "[[项目/甲]]\n"),
        ]);

        for target in ["项目/子", "项目/子/更深"] {
            let error =
                move_dir_tree(&root, &mut index, "项目", target, None, true, None).unwrap_err();
            assert_eq!(
                error.code(),
                ErrorCode::PathInvalid,
                "应拒绝把目录搬到 {target}（它的后代）"
            );
            assert!(
                error.to_string().contains("子目录"),
                "原因要能读懂：{error}"
            );
        }
        // "目标父目录就是它自己"不算错误：那是无操作（父目录没变），与单篇移动同一口径
        let same = move_dir_tree(&root, &mut index, "项目", "项目", None, true, None).unwrap();
        assert_eq!(same.old_rel_path, same.new_rel_path);

        assert!(exists(dir.path(), "项目/甲.md"), "被拒绝时磁盘必须原封不动");
        assert!(exists(dir.path(), "项目/子/丙.md"));
        assert_eq!(read(dir.path(), "乙.md"), "[[项目/甲]]\n", "链接不许被动过");
        // 语法层也要拦（`dir_move::move_targets` 是各入口共用的校验门）
        assert_eq!(
            move_targets("项目", "项目/子", None).unwrap_err().code(),
            ErrorCode::PathInvalid
        );
    }

    #[test]
    fn refuses_to_overwrite_or_merge_into_an_existing_directory() {
        let (dir, root, mut index) = vault(&[
            ("项目/甲.md", "# 甲\n"),
            ("项目/子/丙.md", "# 丙\n"),
            ("归档/项目/甲.md", "# 归档里的甲\n"),
            ("乙.md", "[[项目/甲]]\n"),
        ]);

        let error = move_dir_tree(&root, &mut index, "项目", "归档", None, true, None).unwrap_err();
        assert_eq!(error.code(), ErrorCode::AlreadyExists);
        assert_eq!(
            read(dir.path(), "归档/项目/甲.md"),
            "# 归档里的甲\n",
            "绝不覆盖，也绝不把两棵子树合并"
        );
        assert!(exists(dir.path(), "项目/甲.md"));
        assert_eq!(read(dir.path(), "乙.md"), "[[项目/甲]]\n");
    }

    #[test]
    fn reports_missing_source_and_non_directory_source() {
        let (dir, root, mut index) = vault(&[("甲.md", "# 甲\n")]);

        assert_eq!(
            move_dir_tree(&root, &mut index, "不存在", "归档", None, true, None)
                .unwrap_err()
                .code(),
            ErrorCode::NotFound
        );
        assert_eq!(
            move_dir_tree(&root, &mut index, "甲.md", "归档", None, true, None)
                .unwrap_err()
                .code(),
            ErrorCode::NotADirectory,
            "源是文件时必须明确说「不是目录」，而不是走到系统调用再报 IO"
        );
        assert!(exists(dir.path(), "甲.md"));
    }

    #[test]
    fn rejects_out_of_bounds_paths_before_touching_the_filesystem() {
        let (_dir, root, mut index) = vault(&[("甲.md", "# 甲\n")]);

        for bad in ["../外面", "归档/../外面", "C:/Windows"] {
            assert_eq!(
                move_dir_tree(&root, &mut index, bad, "归档", None, true, None)
                    .unwrap_err()
                    .code(),
                ErrorCode::PathInvalid,
                "应拒绝越界源路径：{bad}"
            );
        }
        for target in ["../外面", "归档/../外面"] {
            assert_eq!(
                move_dir_tree(&root, &mut index, "不存在", target, None, true, None)
                    .unwrap_err()
                    .code(),
                ErrorCode::PathInvalid,
                "应拒绝越界目标目录：{target}"
            );
        }
        assert_eq!(
            move_dir_tree(&root, &mut index, "内部/.mimenote", "", None, true, None)
                .unwrap_err()
                .code(),
            ErrorCode::PathInvalid,
            "内部工作目录不参与搬迁"
        );
    }

    #[test]
    fn moving_to_the_same_parent_is_a_no_op() {
        let (dir, root, mut index) = vault(&[("项目/甲.md", "# 甲\n"), ("乙.md", "[[项目/甲]]\n")]);
        let before = std::fs::metadata(dir.path().join("项目").join("甲.md"))
            .unwrap()
            .modified()
            .unwrap();

        let report = move_dir_tree(&root, &mut index, "项目", "项目", None, true, None).unwrap();

        assert_eq!(report.old_rel_path, report.new_rel_path);
        assert!(report.updated_links.is_empty());
        assert_eq!(read(dir.path(), "乙.md"), "[[项目/甲]]\n");
        assert_eq!(
            std::fs::metadata(dir.path().join("项目").join("甲.md"))
                .unwrap()
                .modified()
                .unwrap(),
            before,
            "无操作时连 mtime 都不该变"
        );
    }

    #[test]
    fn moves_an_empty_directory() {
        let (dir, root, mut index) = vault(&[("甲.md", "# 甲\n")]);
        std::fs::create_dir_all(dir.path().join("空目录").join("更空")).unwrap();

        let report = move_dir_tree(&root, &mut index, "空目录", "归档", None, true, None).unwrap();

        assert_eq!(report.new_rel_path, "归档/空目录");
        assert!(dir.path().join("归档").join("空目录").join("更空").is_dir());
        assert!(!exists(dir.path(), "空目录"));
        assert!(report.updated_links.is_empty(), "没有链接要改，也不该写盘");
        assert_eq!(report.updated_link_count, 0);
    }

    #[test]
    fn moves_a_directory_with_a_single_note_and_a_single_backlink() {
        let (dir, root, mut index) = vault(&[
            ("项目/只有一篇.md", "# 唯一\n"),
            ("甲.md", "见 [[只有一篇]]。\n"),
        ]);

        let report = move_dir_tree(&root, &mut index, "项目", "归档", None, true, None).unwrap();

        assert_eq!(report.updated_links, vec![entry("甲.md", 1)]);
        assert_eq!(read(dir.path(), "甲.md"), "见 [[归档/项目/只有一篇]]。\n");
    }

    #[test]
    fn moves_a_deeply_nested_directory_and_keeps_deep_links_aligned() {
        let (dir, root, mut index) = vault(&[
            ("甲.md", "见 [[a/b/c/笔记]] 与 [[c/笔记]]。\n"),
            ("a/b/c/笔记.md", "# 笔记\n\n回看 [[../../../../甲]]。\n"),
            ("a/b/c/更深/尾部.md", "# 尾部\n"),
        ]);

        let report = move_dir_tree(&root, &mut index, "a/b/c", "x/y/z", None, true, None).unwrap();

        assert_eq!(report.new_rel_path, "x/y/z/c");
        assert!(exists(dir.path(), "x/y/z/c/笔记.md"));
        assert!(exists(dir.path(), "x/y/z/c/更深/尾部.md"));
        // 子树内部的相对路径一字不动（两篇一起搬）
        assert_eq!(
            read(dir.path(), "x/y/z/c/笔记.md"),
            "# 笔记\n\n回看 [[../../../../甲]]。\n"
        );
        // 外部引用：路径形式改前缀
        assert_eq!(
            read(dir.path(), "甲.md"),
            "见 [[x/y/z/c/笔记]] 与 [[x/y/z/c/笔记]]。\n",
            "两条都指向搬迁后的那一篇：索引的**路径后缀**规则把 `[[c/笔记]]` 也解析到了 `a/b/c/笔记`"
        );
        assert!(index.contains("x/y/z/c/笔记.md"));
        assert!(!index.contains("a/b/c/笔记.md"));
    }

    #[test]
    fn rewrites_relative_paths_of_notes_inside_the_subtree() {
        // 结合 ADR-0012 的机制：被搬走的每一篇**自身**的相对路径也要按新目录重算
        let (dir, root, mut index) = vault(&[
            (
                "素材/设计.md",
                "![图](../附件/图.png) 与 [根文件](/根.md) 与 [[同级]]\n",
            ),
            ("素材/同级.md", "# 同级\n"),
            ("附件/图.png", "png"),
            ("根.md", "# 根\n"),
        ]);

        let report =
            move_dir_tree(&root, &mut index, "素材", "归档/深层", None, true, None).unwrap();

        assert_eq!(report.new_rel_path, "归档/深层/素材");
        assert_eq!(
            read(dir.path(), "归档/深层/素材/设计.md"),
            "![图](../../../附件/图.png) 与 [根文件](/根.md) 与 [[同级]]\n",
            "相对路径按新目录重算（多了一层 `..`）；根绝对路径与同层裸名不动"
        );
        assert_eq!(report.updated_links, vec![entry("素材/设计.md", 1)]);
    }

    #[test]
    fn relative_links_inside_the_subtree_survive_a_move_to_a_sibling_directory() {
        // 搬到**同层的另一个目录**（`项目` → `归档/项目`）时：同层的笔记引用（`[乙](乙.md)`）
        // 一字不改；只有指向 Vault 根的相对写法要补一个 `..`（因为深了一层）
        let (dir, root, mut index) = vault(&[
            ("项目/设计.md", "![图](../附件/图.png) 与 [乙](乙.md)\n"),
            ("项目/乙.md", "# 乙\n"),
            ("附件/图.png", "png"),
        ]);

        let report = move_dir_tree(&root, &mut index, "项目", "归档", None, true, None).unwrap();

        assert_eq!(
            read(dir.path(), "归档/项目/设计.md"),
            "![图](../../附件/图.png) 与 [乙](乙.md)\n",
            "同层笔记引用不随搬迁变化（源与目标一起搬）；指向 Vault 根的相对写法必须重算"
        );
        assert_eq!(report.updated_links, vec![entry("项目/设计.md", 1)]);
    }

    #[test]
    fn a_note_whose_move_changes_nothing_stays_byte_identical() {
        // 反例对照：整个 `项目/` 只是原地改名（深度不变）时，正文里一个字符都不该动
        let (dir, root, mut index) = vault(&[
            ("项目/设计.md", "![图](../附件/图.png) 与 [乙](乙.md)\n"),
            ("项目/乙.md", "# 乙\n"),
            ("附件/图.png", "png"),
        ]);
        let before = std::fs::metadata(dir.path().join("项目").join("设计.md"))
            .unwrap()
            .modified()
            .unwrap();

        rename_dir(&root, &mut index, "项目", "工程", true, None).unwrap();

        assert_eq!(
            read(dir.path(), "工程/设计.md"),
            "![图](../附件/图.png) 与 [乙](乙.md)\n"
        );
        assert_eq!(
            std::fs::metadata(dir.path().join("工程").join("设计.md"))
                .unwrap()
                .modified()
                .unwrap(),
            before,
            "没东西要改时连 mtime 都不该变（说明根本没写盘）"
        );
    }

    #[test]
    fn subtree_notes_can_link_back_out_of_the_subtree_after_the_move() {
        let (dir, root, mut index) = vault(&[
            ("笔记/外部.md", "# 外部\n"),
            ("项目/子/内部.md", "[外](../../笔记/外部.md)\n"),
            ("项目/子/配套.md", "# 配套\n"),
        ]);

        let report = move_dir_tree(&root, &mut index, "项目", "归档", None, true, None).unwrap();

        assert_eq!(
            read(dir.path(), "归档/项目/子/内部.md"),
            "[外](../../../笔记/外部.md)\n",
            "`项目/子` 深了 3 层（归档/项目/子）⇒ 指向 Vault 根的相对写法是 3 个 `..`"
        );
        assert_eq!(report.updated_links, vec![entry("项目/子/内部.md", 1)]);

        // 再往深处搬一层：这时又多一个 `..`，而且索引里的出链必须仍然指向原来那篇
        move_dir_tree(
            &root,
            &mut index,
            "归档/项目",
            "归档/更/深",
            None,
            true,
            None,
        )
        .unwrap();
        assert_eq!(
            read(dir.path(), "归档/更/深/项目/子/内部.md"),
            "[外](../../../../../笔记/外部.md)\n"
        );
        assert_eq!(
            index.note_links("归档/更/深/项目/子/内部.md").outbound[0]
                .resolved_rel_path
                .as_deref(),
            Some("笔记/外部.md"),
            "索引里这条出链仍然指向原来那篇"
        );
    }

    #[test]
    fn a_note_that_only_has_its_path_changed_is_not_rewritten() {
        // 内容与相对关系都没变 → 不进 `updated_links`（前端因此不会做无谓的重载）
        let (dir, root, mut index) = vault(&[
            ("项目/甲.md", "# 甲\n\n没有链接。\n"),
            ("乙.md", "[[项目/甲]]\n"),
        ]);
        let before = std::fs::metadata(dir.path().join("项目").join("甲.md"))
            .unwrap()
            .modified()
            .unwrap();

        rename_dir(&root, &mut index, "项目", "工程", true, None).unwrap();

        assert_eq!(
            std::fs::metadata(dir.path().join("工程").join("甲.md"))
                .unwrap()
                .modified()
                .unwrap(),
            before,
            "只有路径变了的笔记不该被写盘"
        );
    }

    #[test]
    fn update_links_false_only_moves_the_directory() {
        let (dir, root, mut index) = vault(&[("项目/甲.md", "# 甲\n"), ("乙.md", "[[项目/甲]]\n")]);

        let report = rename_dir(&root, &mut index, "项目", "工程", false, None).unwrap();

        assert_eq!(report.new_rel_path, "工程");
        assert!(exists(dir.path(), "工程/甲.md"));
        assert!(report.updated_links.is_empty());
        assert_eq!(
            read(dir.path(), "乙.md"),
            "[[项目/甲]]\n",
            "明确关掉时不许碰别的文件"
        );
        assert!(index.contains("工程/甲.md"));
        assert!(!index.contains("项目/甲.md"));
    }

    #[test]
    fn keeps_the_search_index_in_step() {
        let (_dir, root, mut index) = vault(&[
            ("项目/甲.md", "第一行\n命中这一行\n"),
            ("乙.md", "[[项目/甲]] 也有命中\n"),
        ]);
        let search = crate::SearchIndex::open_in_memory().unwrap();
        search.begin_rebuild().unwrap();
        search
            .add_note("项目/甲.md", "第一行\n命中这一行\n")
            .unwrap();
        search.add_note("乙.md", "[[项目/甲]] 也有命中\n").unwrap();
        search.finish_rebuild().unwrap();

        let report = rename_dir(&root, &mut index, "项目", "工程", true, Some(&search)).unwrap();

        assert_eq!(
            paths_hit(&search, "第一行"),
            vec!["工程/甲.md".to_string()],
            "路径搬过去了：旧路径搜不到、新路径搜得到"
        );
        // 被改写的文件正文变了：搜索里看到的必须是**新文本**，旧链接文本不许留下
        //（查询词带 `/` 时 FTS5 的分词行为不稳定，所以这里用不带 `/` 的片段）
        assert_eq!(report.updated_links, vec![entry("乙.md", 1)]);
        assert_eq!(
            paths_hit(&search, "工程"),
            vec!["乙.md".to_string()],
            "改写后的链接文本必须已经进库"
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

    // -- 目标写法（纯函数） ---------------------------------------------------

    #[test]
    fn dir_targets_validate_input() {
        assert_eq!(
            dir_rename_targets("a/乙", "丙").unwrap().new_rel,
            "a/丙",
            "目录名不做主干/扩展名拆分"
        );
        assert_eq!(
            dir_rename_targets("a\\乙", "丙").unwrap().old_rel,
            "a/乙",
            "反斜杠分隔的旧路径也接受（与其它命令一致）"
        );
        assert_eq!(
            dir_move_targets("别的/乙", "", None).unwrap().new_rel,
            "乙",
            "空串 = Vault 根"
        );
        assert_eq!(
            dir_move_targets("别的/乙", "/归档/", None).unwrap().new_rel,
            "归档/乙",
            "首尾 `/` 与反斜杠都容忍"
        );
        assert_eq!(
            dir_move_targets("别的/乙", "归档", Some("v1.2"))
                .unwrap()
                .new_rel,
            "归档/v1.2",
            "目录名里的点不能当扩展名切掉"
        );

        for (old, name) in [
            ("a/乙", ""),
            ("a/乙", "   "),
            ("a/乙", " 丙 "),
            ("a/乙", ".."),
            ("a/乙", "con"),
            ("a/乙", "丙:丁"),
            ("", "丙"),
            ("../乙", "丙"),
            ("/abs/乙", "丙"),
        ] {
            assert_eq!(
                dir_rename_targets(old, name).unwrap_err().code(),
                ErrorCode::PathInvalid,
                "应拒绝：old={old:?} name={name:?}"
            );
        }
        for target in ["../外面", "归档/../外面", "C:/Windows"] {
            assert_eq!(
                dir_move_targets("别的/乙", target, None)
                    .unwrap_err()
                    .code(),
                ErrorCode::PathInvalid,
                "应拒绝目标目录：{target}"
            );
        }
    }

    // -- 基准（默认忽略） -----------------------------------------------------

    /// 搬迁一个 1000 篇笔记的目录要多久（`cargo test -p mn-index --release -- --ignored --nocapture`）。
    ///
    /// 刻意不设阈值：这台机器上的数字只用来**说明瓶颈在哪**（搬树 / 改写 / 索引同步三段各占多少），
    /// 阈值会随机器与杀毒软件漂移到"要么永远绿、要么随机红"。
    #[test]
    #[ignore = "基准：手动运行，输出耗时分解"]
    fn bench_move_directory_with_1000_notes() {
        let dir = tempfile::tempdir().unwrap();
        let root_rel = "项目";
        let mut files: Vec<(String, String)> = Vec::new();
        for index in 0..1000 {
            let bucket = index % 20;
            let rel = format!("{root_rel}/子{bucket:02}/笔记{index:04}.md");
            // 一半的笔记带一条指向子树内另一篇的链接（制造真实的改写压力）
            let text = if index % 2 == 0 {
                let target = (index + 1) % 1000;
                format!("# 笔记{index:04}\n\n见 [[笔记{target:04}]]。\n")
            } else {
                format!("# 笔记{index:04}\n\n没有链接。\n")
            };
            files.push((rel, text));
        }
        // 子树之外再放 200 篇引用它们中的一部分
        for index in 0..200 {
            files.push((
                format!("外部/引用{index:04}.md"),
                format!("# 引用{index}\n\n见 [[笔记{index:04}]]。\n"),
            ));
        }
        for (rel, text) in &files {
            let path = dir
                .path()
                .join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, text.as_bytes()).unwrap();
        }

        let root = VaultRoot::open(dir.path()).unwrap();
        let build_started = Instant::now();
        let entries = scan(root.path(), &ScanOptions::default()).unwrap();
        let scan_ms = build_started.elapsed().as_millis();
        let (mut index, _) = build_index(
            root.path(),
            &entries.entries,
            &BuildOptions::default(),
            None,
            |_a, _b| {},
        );
        println!(
            "扫描 {} 条目 / 索引 {} 篇：{} ms",
            entries.entries.len(),
            index.len(),
            scan_ms
        );

        let report = move_dir_tree(&root, &mut index, root_rel, "归档", None, true, None).unwrap();

        println!(
            "搬迁 1000 篇目录：总耗时 {} ms（改写 {} 个文件 / {} 条链接，其中子树内 {} 篇）",
            report.elapsed_ms,
            report.updated_links.len(),
            report.updated_link_count,
            report
                .updated_links
                .iter()
                .filter(|item| path_inside(&item.rel_path, root_rel))
                .count()
        );
        assert_eq!(report.new_rel_path, "归档/项目");
        assert!(index.contains("归档/项目/子00/笔记0000.md"));
        assert!(!index.contains("项目/子00/笔记0000.md"));
    }
    /// 更贴近典型 Vault 的一档：1000 篇目录，但只有 50 篇被外部引用、内部几乎不自链。
    ///
    /// 为什么单独一档：改写成本与**被引用的篇数**成正比，而不是与子树大小成正比
    ///（搬树本身是常数级的）。两档一起看才能说清"到底什么在花时间"。
    #[test]
    #[ignore = "基准：手动运行，输出耗时分解"]
    fn bench_move_directory_with_few_cross_links() {
        let dir = tempfile::tempdir().unwrap();
        let mut files: Vec<(String, String)> = Vec::new();
        for index in 0..1000 {
            files.push((
                format!("项目/子{:02}/笔记{index:04}.md", index % 20),
                format!("# 笔记{index:04}\n\n正文。\n"),
            ));
        }
        for index in 0..50 {
            files.push((
                format!("外部/引用{index:04}.md"),
                format!("# 引用{index}\n\n见 [[笔记{:04}]]。\n", index * 19),
            ));
        }
        for (rel, text) in &files {
            let path = dir
                .path()
                .join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, text.as_bytes()).unwrap();
        }

        let root = VaultRoot::open(dir.path()).unwrap();
        let entries = scan(root.path(), &ScanOptions::default()).unwrap();
        let (mut index, _) = build_index(
            root.path(),
            &entries.entries,
            &BuildOptions::default(),
            None,
            |_a, _b| {},
        );
        let report = move_dir_tree(&root, &mut index, "项目", "归档", None, true, None).unwrap();
        println!(
            "搬迁 1000 篇目录（只有 50 篇被引用）：总耗时 {} ms（改写 {} 个文件 / {} 条链接）",
            report.elapsed_ms,
            report.updated_links.len(),
            report.updated_link_count
        );
        assert!(index.contains("归档/项目/子00/笔记0000.md"));
    }

    /// 把"搬迁本体"的四段分别计时。
    ///
    /// 为什么要有它：`elapsed_ms` 只给总数，而"这几秒到底花在哪"才是决定要不要做进度与优化的依据。
    #[test]
    #[ignore = "基准：手动运行，输出耗时分解"]
    fn bench_move_directory_phase_breakdown() {
        let dir = tempfile::tempdir().unwrap();
        for index in 0..1000 {
            let rel = format!("项目/子{:02}/笔记{index:04}.md", index % 20);
            let path = dir
                .path()
                .join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, format!("# 笔记{index:04}\n\n正文。\n")).unwrap();
        }
        for index in 0..50 {
            let rel = format!("外部/引用{index:04}.md");
            let path = dir
                .path()
                .join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(
                &path,
                format!("# 引用{index}\n\n见 [[笔记{:04}]]。\n", index * 19),
            )
            .unwrap();
        }

        let root = VaultRoot::open(dir.path()).unwrap();
        let entries = scan(root.path(), &ScanOptions::default()).unwrap();
        let (mut index, _) = build_index(
            root.path(),
            &entries.entries,
            &BuildOptions::default(),
            None,
            |_a, _b| {},
        );

        let whole = Instant::now();
        let plan_started = Instant::now();
        let plan = plan_dir_rewrites(&root, &index, "项目", "归档");
        let plan_ms = plan_started.elapsed().as_millis();
        let move_started = Instant::now();
        mn_core::atomic::move_dir(
            &root.resolve_existing("项目").unwrap(),
            &root.resolve_for_write("归档").unwrap(),
        )
        .unwrap();
        let move_ms = move_started.elapsed().as_millis();
        let write_started = Instant::now();
        for item in &plan {
            let rel_after = remap_prefix(&item.rel_path, "项目", "归档")
                .unwrap_or_else(|| item.rel_path.clone());
            write_atomic(
                &root.resolve_for_write(&rel_after).unwrap(),
                item.new_text.as_bytes(),
            )
            .unwrap();
        }
        let write_ms = write_started.elapsed().as_millis();
        let sync_started = Instant::now();
        sync_indexes(&root, &mut index, None, &plan, "项目", "归档");
        let sync_ms = sync_started.elapsed().as_millis();
        println!(
            "分段：计划 {plan_ms}ms / 搬树 {move_ms}ms / 写回 {write_ms}ms（{} 个文件）/ 索引 {sync_ms}ms / 合计 {}ms",
            plan.len(),
            whole.elapsed().as_millis()
        );
    }
}
