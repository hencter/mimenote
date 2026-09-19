//! 标签领域：frontmatter 标签增删 / 概览 / 组合过滤 / 重命名与合并 / 层级移动。
//!
//! 判同与保真纪律只有一份，在 `mn-core`（frontmatter 解析、最小 diff、CRLF/BOM 保真）；
//! 宿主只做"令牌校验 → 读盘 → 改写 → 原子写 → 索引增量同步"的编排与错误映射。

use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use tauri::State;

use mn_core::atomic::{read_text, write_atomic};
use mn_core::scanner::EntryMeta;
use mn_core::{Error, VaultRoot};
use mn_index::tags::TagSummary;

use crate::error::IpcError;
use crate::indexer;
use crate::state::AppState;

use super::{ext_of, file_name_of, run_blocking, MAX_READ_BYTES};

/// frontmatter 标签增删的结果（`note_set_tags`）。
///
/// 为什么不复用 [`WriteOutcome`]：这个方法有两个"只有它才有"的输出 —— **写入后的标签列表**
/// 与**幂等标志**。前者让前端能如实告诉用户"这条标签来自 `tag:` 字段、没被删掉"，
/// 后者区分"真的改了文件"与"本来就一样"（后者不写盘、不动 mtime、不重建索引）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetTagsOutcome {
    pub rel_path: String,
    /// 新的版本令牌；**没有实际改动时与请求里的 `baseMtimeMs` 相同**。
    pub mtime_ms: u64,
    pub size_bytes: u64,
    /// 实际写入耗时（毫秒，含 fsync）；幂等请求为 0。
    pub written_in_ms: u64,
    /// 是否真的写了盘（`false` = 新的标签列表与磁盘上的完全一致，一个字节都没动）。
    pub changed: bool,
    /// 写入后**磁盘上真实的** frontmatter 标签（保留用户写法、去重、保序）。
    pub tags: Vec<String>,
    /// 写入后的整篇文本。
    ///
    /// 为什么要把它一起带回去（而不是让前端再 `note_read` 一次）：前端必须把编辑器内存对齐到
    /// 磁盘，否则下一次自动保存会把刚加的标签覆盖掉；再读一次会在"读完到写回"之间多开一个
    /// 竞态窗口（用户此刻敲的字用的是旧文本）。一次往返里把"磁盘现在是什么"讲清楚最安全。
    pub text: String,
}

/// 一次标签重命名/合并里**被真正改写**的一篇笔记。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagRenameFile {
    pub rel_path: String,
    /// frontmatter 里被改写的条数（含合并时被去掉的重复项）。
    pub frontmatter_edits: u32,
    /// 正文里被换成新写法的 `#标签` 个数。
    pub inline_edits: u32,
    /// 正文里因合并被去掉的重复提及数。
    pub inline_removed: u32,
}

/// 一篇笔记被跳过（没改）的原因。
///
/// **这不是错误码**（刻意与 [`mn_core::ErrorCode`] 分开）：一次操作会碰几十上百个文件，
/// 每个文件各自的处境不同 —— 用错误码表达等于把"部分成功"强行折叠成"失败"，
/// 前端也就无法如实说出"改了 12 篇，3 篇因为磁盘被外部改动没改"。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TagSkipReason {
    /// 这一篇在计划之后、落笔之前被外部改过（条目表里的 `(mtime,size)` 与磁盘不一致）。
    ExternalChange,
    /// 读不到（已被外部删掉、不是 UTF-8、超过读取上限、权限不足……名目在 `message` 里）。
    Unreadable,
    /// 读到了、也算出了新文本，但写盘失败（只读 Vault、磁盘满、被占用）。
    WriteFailed,
}

/// 一篇被跳过的笔记。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagRenameSkip {
    pub rel_path: String,
    /// 稳定原因（前端按它分组给出人话）。
    pub reason: TagSkipReason,
    /// 面向用户的一句话（宿主侧的真实原因，例如"读取失败：文件不存在"）。
    pub message: String,
}

/// 标签重命名 / 合并的结果。
///
/// 为什么不像 `note_set_tags` 那样带 `text`：这次动的是**几十上百篇**，把它们的全文
/// 一起塞进 IPC 报文既没有用处（前端不显示别人的正文），也不安全（大 Vault 会撑爆报文）。
/// 需要"编辑器内存对齐磁盘"的只有当前打开的那一篇，前端按 `edited` 里的路径自己重读一次即可。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagRenameOutcome {
    /// 源标签的**归一化键**（与索引、面板高亮同一把尺子）。
    pub from: String,
    /// 目标标签的**归一化键**。
    pub to: String,
    /// 用户输入的源写法（回显用）。
    pub from_display: String,
    /// 用户输入的新写法（回显用）。
    pub to_display: String,
    /// 是否连带层级子标签（`父` → `母` 时 `父/子` → `母/子`）。
    pub include_children: bool,
    /// 是否是"只查询、不落盘"的预演（对话框里那句"这会改 N 篇笔记"）。
    pub dry_run: bool,
    /// 标签索引给出的候选笔记数（含最终"无需改动"的那些）。
    pub candidates: u32,
    /// 被真正改写的笔记（按路径字典序）；预演时是"将会被改写"的那些。
    pub edited: Vec<TagRenameFile>,
    /// 被跳过的笔记 + 原因（按路径字典序）。
    pub skipped: Vec<TagRenameSkip>,
    /// 候选里**不需要改**的笔记数（读盘后发现旧写法已经不在里面了 —— 多半是上一次重试
    /// 已经改过它，或者索引比磁盘旧一拍）。不计入 `edited`/`skipped`。
    pub unchanged: u32,
    /// 被改写的 frontmatter 条数合计。
    pub frontmatter_edits: u32,
    /// 被改写的正文行内标签处数合计。
    pub inline_edits: u32,
    /// 被去掉的重复提及处数合计（合并）。
    pub inline_removed: u32,
    /// 整条命令的实测耗时（毫秒）。
    pub elapsed_ms: u64,
}

/// 某篇笔记的标签与 frontmatter 属性。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteTags {
    pub rel_path: String,
    /// frontmatter 与正文行内标签（frontmatter 在前，已按归一化键去重）。
    pub tags: Vec<mn_core::TagRef>,
    /// frontmatter 字段（保序）。**没有 frontmatter 时是空数组，不是 `null`**。
    pub frontmatter: Vec<mn_core::frontmatter::FrontmatterField>,
}

/// 全库标签概览中的一项。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagSummaryDto {
    /// 归一化后的键（小写、去首尾 `/`）。
    pub key: String,
    /// 首次出现的原始写法（保留大小写与层级）。
    pub tag: String,
    /// 含该标签的笔记数。
    pub count: u32,
}

impl From<TagSummary> for TagSummaryDto {
    fn from(summary: TagSummary) -> Self {
        Self {
            key: summary.key,
            tag: summary.tag,
            count: summary.count,
        }
    }
}

/// 某个标签下的笔记。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagNotes {
    /// **归一化后**的键（前端拿到的永远是索引里那个键，便于高亮当前展开项）。
    pub key: String,
    /// 笔记相对路径（字典序）。
    pub notes: Vec<String>,
}

// ---------------------------------------------------------------------------
// 标签与 frontmatter 属性
// ---------------------------------------------------------------------------

/// 在笔记的 frontmatter 上**加/删标签**（标签面板的写入口）。
///
/// ## 为什么是宿主命令，而不是"前端读原文 → 改 → note_write"
///
/// ADR-0006 §3 的原话是"改标签走 `note_read → set_tags → note_write`、不开新写路径"。
/// 这里**没有**开新写路径：本命令内部就是那三步，而且与 `note_write` 共用**同一把写锁、
/// 同一次 mtime 令牌校验、同一个 `write_atomic`、同一处索引增量更新**——ADR-0004 的保护一条不少。
/// 之所以把这三步搬进宿主，是因为"改哪一行、写成什么形态（标量/行内数组/块数组/补区块）"
/// 全在 `mn_core::frontmatter`，让前端用 TypeScript 再实现一遍最小 diff，等于把判同与保真
/// 纪律复制成两份（正是 ADR-0006 第 2 条最反对的事）。
///
/// ## 入参是"增"与"删"，不是"新的完整列表"
///
/// 前端面板上的列表可能比磁盘旧一拍（索引/面板刷新有延迟）。传"想要什么"会在这种情况下
/// **静默丢掉别的标签**；传"加什么、删什么"则由宿主基于**它刚刚读到的文本**算结果，
/// 旧一拍的最坏后果只是"重复加了一个已存在的"（幂等，不写盘）。
///
/// ## 冲突
///
/// `base_mtime_ms` 是**必填**的版本令牌：与 `note_write` 一样在写锁内重新 `stat` 比对，
/// 不一致返回 `CONFLICT` + `currentMtimeMs`，**绝不静默覆盖**外部改动（ADR-0004）。
#[tauri::command]
pub async fn note_set_tags(
    state: State<'_, Arc<AppState>>,
    rel_path: String,
    add: Vec<String>,
    remove: Vec<String>,
    base_mtime_ms: u64,
) -> Result<SetTagsOutcome, IpcError> {
    let app = Arc::clone(state.inner());
    let rel = rel_path.clone();

    let outcome =
        run_blocking(move || note_set_tags_in(&app, &rel, &add, &remove, base_mtime_ms)).await?;

    // 条目缓存跟着走（大小与 mtime 变了）——与 note_write 同一收尾
    if outcome.changed {
        state.update_vault(|ctx| {
            ctx.upsert(EntryMeta {
                rel_path: outcome.rel_path.clone(),
                name: file_name_of(&outcome.rel_path),
                is_dir: false,
                size_bytes: outcome.size_bytes,
                mtime_ms: Some(outcome.mtime_ms),
                ext: ext_of(&outcome.rel_path),
            })
        });
    }

    Ok(outcome)
}

/// 某篇笔记的标签与 frontmatter 属性。
///
/// 标签走**索引**（与全库概览同一份数据，编辑保存后由 `note_write` 顺带更新）；
/// frontmatter 字段**现读现解析** —— 索引只保存标签，不保存所有属性，而属性面板要的是
/// 这篇文件的完整字段（所以这里仍要读一次文件，顺便也把 `NOT_FOUND` 语义定死）。
#[tauri::command]
pub async fn note_tags(
    state: State<'_, Arc<AppState>>,
    rel_path: String,
) -> Result<NoteTags, IpcError> {
    let root = state.vault_root()?;
    let app = Arc::clone(state.inner());
    let rel = rel_path.clone();
    run_blocking(move || note_tags_in(&root, &app, &rel)).await
}

/// 全库标签概览（笔记数降序 → 键字典序）。
#[tauri::command]
pub async fn tags_list(state: State<'_, Arc<AppState>>) -> Result<Vec<TagSummaryDto>, IpcError> {
    let app = Arc::clone(state.inner());
    run_blocking(move || Ok(tags_list_in(&app))).await
}

/// 某个标签下的笔记（`key` 传原始写法或归一化键都行）。
#[tauri::command]
pub async fn tag_notes(state: State<'_, Arc<AppState>>, key: String) -> Result<TagNotes, IpcError> {
    let app = Arc::clone(state.inner());
    let query = key.clone();
    run_blocking(move || tag_notes_in(&app, &query)).await
}

/// 组合过滤的结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagFilterResult {
    /// 命中的笔记（Vault 相对路径，**字典序**）。
    pub paths: Vec<String>,
    /// 命中数（= `paths.len()`，单独给出来是因为前端要显示"M / 共 N 篇"里的 M）。
    pub matched: usize,
    /// 这一轮索引里"有标签的笔记"总数（显示 N 用）。
    pub tagged: usize,
}

/// 组合过滤：**含 `any` 里任意一个**（`any` 为空 = 全部有标签的笔记）**且不含 `none` 里任何一个**。
///
/// ## 为什么放到宿主一次算，而不是让前端一个个标签问
///
/// "有 A 且没有 B"在前端只能拆成两次查询再相减；而**层级标签**还要把 `父` 展开成
/// "父 + 每个后代各一次查询" —— 真实 Vault 里一个父标签挂 200 个子标签就是 201 次 IPC
/// （自己的实现里踩到过：`tag_notes` 不支持层级参数）。这里一次遍历索引就出结果，
/// 前端只需要一次往返。
///
/// `include_children` 打开时 `父` 也匹配 `父/子`、`父/子/孙`（按 `/` 切段比较，
/// 所以 `父老`、`父辈` **不**算后代 —— 与 `tag_rename` 的层级口径一致）。
///
/// 空串与纯 `#` 一律忽略（不是"匹配所有"，也不是报错）：它们没有匹配意义，
/// 只会在界面上留一个点了没反应的胶囊。
#[tauri::command]
pub fn tag_filter(
    state: State<'_, Arc<AppState>>,
    any: Vec<String>,
    none: Vec<String>,
    include_children: bool,
) -> TagFilterResult {
    tag_filter_in(&state, &any, &none, include_children)
}

/// [`tag_filter`] 的主体（可单测；纯内存索引，不碰文件）。
fn tag_filter_in(
    state: &AppState,
    any: &[String],
    none: &[String],
    include_children: bool,
) -> TagFilterResult {
    let index = state.index_write();
    let paths = index.filter_tags(any, none, include_children);
    let tagged = index.tagged_note_count();
    TagFilterResult {
        matched: paths.len(),
        paths,
        tagged,
    }
}

/// **标签重命名 / 合并**：把全库所有笔记里的 `甲` 换成 `乙`。
///
/// ## 为什么不复用 `note_set_tags` 逐篇调用
///
/// 重命名要改的是**正文行内标签**（`note_set_tags` 刻意只改 frontmatter，见 ADR-0006），
/// 而且必须"要么全改、要么说清楚哪几篇没改"——逐篇调用会让"改了 30 篇之后第 31 篇失败"
/// 变成一个没有出处的中断。因此这里由宿主一次做完：
///
/// ```text
/// 候选集（标签索引里所有命中的笔记，复用既有索引，不重新扫全库）
///   逐篇：写锁 → 对照条目表检查磁盘有没有被外部改过 → 读盘 → mn_core::tags::rename_tags
///         → 没变就跳过（幂等）→ atomic 写 → indexer::update_note（标签/搜索/图谱同一处增量同步）
/// ```
///
/// ## 为什么先查询再确认（`dry_run`）
///
/// 这个动作的代价与影响面都写在用户看不到的地方（"改 N 篇笔记"），`dry_run = true` 走**完全
/// 一样的候选集与判定**，只是不落盘 —— 于是对话框能先说出"这会改 12 篇笔记"，
/// 而且那句话与真正执行时改的篇数**同源**（不是估的）。
///
/// ## 如实汇报，绝不"部分成功却报告成功"
///
/// 结果里 `edited` / `skipped` 分开列，跳过原因分三类（[`TagSkipReason`]）。
/// 单篇写失败不会中断整批（用户重试即可），重试是幂等的：已经改过的文件在新一轮里
/// 读盘后"旧写法已经不在"，于是既不改也不报错（计入 `unchanged`）。
///
/// ## 冲突语义
///
/// 这一条**没有** `baseMtimeMs` 入参：它动的不是"用户正在编辑的这一篇"，而是全库。
/// 逐篇的版本令牌来自**条目表里的 `(mtime,size)`**（ADR-0016 判定"磁盘上有没有新闻"用的
/// 就是这份对账口径）—— 与磁盘对不上就跳过该篇并如实报告"磁盘被外部改动"，
/// 而不是拿一份可能已经过时的正文去覆盖。前端在调用前仍会先 `saveNow`（把当前笔记落盘），
/// 否则当前这篇会被自己的未保存内容挡住。
#[tauri::command]
pub async fn tag_rename(
    state: State<'_, Arc<AppState>>,
    from: String,
    to: String,
    include_children: Option<bool>,
    dry_run: Option<bool>,
) -> Result<TagRenameOutcome, IpcError> {
    let app = Arc::clone(state.inner());
    // 这里不能再用 `run_blocking`（它要求主体返回 `mn_core::Result`）：主体要回报
    // `INDEX_NOT_READY`（宿主侧才有的码），因此直接走 `spawn_blocking`（ADR-0003 的口径不变）
    tauri::async_runtime::spawn_blocking(move || {
        tag_rename_in(
            &app,
            &from,
            &to,
            include_children.unwrap_or(true),
            dry_run.unwrap_or(false),
        )
    })
    .await
    .map_err(|error| IpcError::internal(format!("标签改名任务失败：{error}")))?
}

/// **标签的层级编辑**：把 `甲` 挂到某个父标签下（`父/甲`），或提回顶层（`甲`）。
///
/// ## 为什么是一个独立命令，而不是让前端拼好新名字去调 `tag_rename`
///
/// 层级编辑只有两种形态，但**非法组合比合法组合多**：挂到自己下面、挂到自己的后代下面
/// （会造出 `甲/…/甲` 这种改不完的层级）、父标签里写了空段、以及"已经在那里了"。
/// 这些判定必须在写盘之前就拦住，而且要与写盘无关地单测 —— 所以规则在
/// [`mn_core::tag_move_target`]（纯函数，3 条测试），这里只做三件事：
///
/// 1. 算出目标键，把非法移动翻成 [`Error::invalid`]（稳定错误码 `PATH_INVALID`，
///    与重命名里"新名字为空"同一档）；
/// 2. **目标键已被别的标签占用时拒绝**：那是"合并"，不是"移动"。用户点的是"移到…"，
///    静默把它并掉会让人以为只是换了个位置，而实际丢了一个标签的独立性 ——
///    错误信息直接把他引到「重命名」那条路上去；
/// 3. 委托给 [`tag_rename_in`] —— **不新增第二套写路径**：同一把写锁、同一份
///    `(mtime,size)` 对账、同一个 `write_atomic`、同一处索引增量同步、同一份跳过清单口径。
///    出参因此就是 [`TagRenameOutcome`]：前端连"这会改 N 篇 / 哪几篇没改"的结果界面都能复用。
///
/// `include_children` 缺省 `true`：移动一个父标签时，它下面的子标签跟着走
/// （`甲` → `母/甲` 时 `甲/子` → `母/甲/子`），与重命名的口径一致。
#[tauri::command]
pub async fn tag_move(
    state: State<'_, Arc<AppState>>,
    key: String,
    parent: String,
    include_children: Option<bool>,
    dry_run: Option<bool>,
) -> Result<TagRenameOutcome, IpcError> {
    let app = Arc::clone(state.inner());
    // 与 `tag_rename` 同因：主体会回报 `INDEX_NOT_READY`，所以直接走 `spawn_blocking`
    tauri::async_runtime::spawn_blocking(move || {
        tag_move_in(
            &app,
            &key,
            &parent,
            include_children.unwrap_or(true),
            dry_run.unwrap_or(false),
        )
    })
    .await
    .map_err(|error| IpcError::internal(format!("标签移动任务失败：{error}")))?
}

/// [`tag_move`] 的主体（可单测）。
fn tag_move_in(
    state: &AppState,
    key: &str,
    parent: &str,
    include_children: bool,
    dry_run: bool,
) -> Result<TagRenameOutcome, IpcError> {
    if !state.is_open() {
        return Err(Error::VaultNotSet.into());
    }
    let target =
        mn_core::tag_move_target(key, parent).map_err(|reason| Error::invalid(key, reason))?;

    // 目标键已经被别的标签占用 → 那是"合并"。只有拿着全库概览的这里判得了
    // （纯函数刻意不管这件事，见 `tag_move_target` 的文档）。
    let from_key = mn_core::normalize_tag(key);
    if indexer::status(state).phase == indexer::IndexPhase::Ready {
        let taken = indexer::tag_summary(state)
            .into_iter()
            .any(|summary| summary.key == target && summary.key != from_key);
        if taken {
            return Err(Error::invalid(
                key,
                format!("「{target}」已经是一个标签了；要合并请用「重命名」"),
            )
            .into());
        }
    }

    tag_rename_in(state, key, &target, include_children, dry_run)
}

fn note_tags_in(root: &VaultRoot, state: &AppState, rel_path: &str) -> mn_core::Result<NoteTags> {
    let path = root.resolve_existing(rel_path)?;
    let meta = std::fs::metadata(&path).map_err(|e| Error::io(&path, e))?;
    if meta.is_dir() {
        return Err(Error::IsDirectory(rel_path.to_string()));
    }
    let text = read_text(&path, MAX_READ_BYTES)?;

    // 索引里有就用索引的（与全库概览严格一致）；索引还没收录（构建中、超大被跳过、
    // 非笔记）才现算 —— 否则面板会显示"这篇没有标签"，那是错的。
    let tags = indexer::tags_of(state, rel_path).unwrap_or_else(|| mn_core::extract_tags(&text));
    let frontmatter = mn_core::parse_frontmatter(&text)
        .map(|frontmatter| frontmatter.fields)
        .unwrap_or_default();

    Ok(NoteTags {
        rel_path: rel_path.to_string(),
        tags,
        frontmatter,
    })
}

/// `note_set_tags` 的主体（与 Tauri 无关，可单测）。
///
/// 一次临界区里做完五件事（顺序不能换）：
///
/// 1. **写锁**：与 `note_write` / `rename_note_in` 同一把 —— "读当前 mtime → 读文本 → 改 → 写"
///    必须在没有并发写的窗口里完成，否则并发的自动保存会以旧文本覆盖掉刚改出来的标签；
/// 2. **令牌比对**：磁盘 mtime 与前端给的 `base_mtime_ms` 不一致 → `CONFLICT`（附当前 mtime），
///    一个字节都不写（ADR-0004：绝不静默覆盖外部改动）；
/// 3. 读**磁盘上的最新文本**（不是前端内存里的那份），既有标签从这里取；
/// 4. 结果列表 = `mn_core::tags::apply_tag_edits(既有, add, remove)`（判同只有 `normalize_tag` 一份）；
/// 5. 新文本与旧文本**逐字节相同就整个跳过**：不写盘、不动 mtime、不重建索引 ——
///    "加一个已经存在的标签"必须是彻底的幂等，而不是制造一次无意义的 diff 与一次索引重建。
///
/// 写入走 `mn_core::atomic::write_atomic`（原子替换），并复用 `indexer::update_note`
/// 让标签/搜索/图谱三份索引在同一处增量同步（ADR-0006 影响一节：文本派生数据只有一个入口）。
fn note_set_tags_in(
    state: &AppState,
    rel_path: &str,
    add: &[String],
    remove: &[String],
    base_mtime_ms: u64,
) -> mn_core::Result<SetTagsOutcome> {
    let root = state.vault_root()?;
    let _write_guard = state.write_guard();

    let path = root.resolve_existing(rel_path)?;
    if path.is_dir() {
        return Err(Error::IsDirectory(rel_path.to_string()));
    }

    let current = mn_core::atomic::path_mtime_ms(&path)?;
    if let Some(cur) = current {
        if cur != base_mtime_ms {
            return Err(Error::Conflict {
                current_mtime_ms: cur,
            });
        }
    }

    let text = read_text(&path, MAX_READ_BYTES)?;
    // **面板显示的**（两个字段合并）与**能改的**（`set_tags` 真正会写的那个字段）是两份列表：
    // 用合并列表去改写会把 `tag:` 字段里的标签复制进 `tags:`，还会让它永远删不掉 ——
    // 详见 `mn_core::frontmatter::editable_tags` 的文档
    let merged = mn_core::parse_frontmatter(&text)
        .map(|frontmatter| frontmatter.tags)
        .unwrap_or_default();
    let size_bytes = text.len() as u64;
    let unchanged = |tags: Vec<String>| SetTagsOutcome {
        rel_path: rel_path.to_string(),
        mtime_ms: base_mtime_ms,
        size_bytes,
        written_in_ms: 0,
        changed: false,
        tags,
        text: text.clone(),
    };

    // 既不增也不删 = 一次纯查询：不写盘、不重建索引（连算一遍新文本都不必）
    if add.is_empty() && remove.is_empty() {
        return Ok(unchanged(merged));
    }

    let editable = mn_core::editable_tags(&text);
    let wanted = mn_core::apply_tag_edits(&editable, add, remove);
    let updated = mn_core::set_tags_or_create(&text, &wanted);

    if updated == text {
        // 幂等：一个字节都不动（含 mtime 与索引）
        return Ok(unchanged(merged));
    }

    let started = Instant::now();
    write_atomic(&path, updated.as_bytes())?;
    let written_in_ms = started.elapsed().as_millis() as u64;

    // 标签/链接/搜索/图谱：与 `note_write` 完全同一处增量更新
    indexer::update_note(state, rel_path, &updated);

    let meta = std::fs::metadata(&path).map_err(|e| Error::io(&path, e))?;
    let tags = mn_core::parse_frontmatter(&updated)
        .map(|frontmatter| frontmatter.tags)
        .unwrap_or_default();

    log::debug!(
        "改写 {rel_path} 的标签（{} 个，{} 字节，写入 {written_in_ms}ms）",
        tags.len(),
        updated.len()
    );

    Ok(SetTagsOutcome {
        rel_path: rel_path.to_string(),
        mtime_ms: mn_core::atomic::mtime_ms(&meta).unwrap_or(base_mtime_ms),
        size_bytes: meta.len(),
        written_in_ms,
        changed: true,
        tags,
        text: updated,
    })
}

/// `tags_list` 的主体（与 Tauri 无关，可单测）。
fn tags_list_in(state: &AppState) -> Vec<TagSummaryDto> {
    indexer::tag_summary(state)
        .into_iter()
        .map(TagSummaryDto::from)
        .collect()
}
/// `tag_notes` 的主体（与 Tauri 无关，可单测）：空键 → `PATH_INVALID`。
fn tag_notes_in(state: &AppState, key: &str) -> mn_core::Result<TagNotes> {
    // 空键（`""`、`"#"`、只有空白）归一化后是空串，等于"查询所有空标签"：明确拒绝，
    // 别让它悄悄返回一个空列表（那会让 UI 以为"这个标签下没有笔记"）
    let normalized = mn_core::normalize_tag(key);
    if normalized.is_empty() {
        return Err(Error::invalid(key, "标签键为空"));
    }

    Ok(TagNotes {
        notes: indexer::notes_with_tag(state, &normalized),
        key: normalized,
    })
}

/// `tag_rename` 的主体（与 Tauri 无关，可单测）。
///
/// 编排纪律（顺序与理由）：
///
/// 1. **映射先归一化**（`TagRename::new`）：空输入 → `PATH_INVALID`（复用既有稳定码，
///    不开新码），不区分"源为空"还是"目标为空" —— 两者都是"这次改名没有意义"；
/// 2. **候选集来自标签索引**，不重新扫全库：索引的倒排表就是"哪些笔记用了这个键"，
///    1 万笔记的 Vault 里改一个标签只读它真正出现的那几十篇（`tag_summary` 筛出范围内的键
///    → `notes_with_tag` 取并集）。索引没就绪时**明确报错**而不是"改了 0 篇"：
///    后者会让用户以为改完了；
/// 3. **逐篇一个短临界区**（不是整批一把锁）：每个文件的"读 → 改写 → 原子写"必须在
///    没有并发写的窗口里完成（ADR-0004），但把几百个文件圈进一把锁会让自动保存停摆数秒。
///    锁外还叠一层"条目表 vs 磁盘"的对账，挡住**外部**改动（见 `plan_mismatch`）；
/// 4. **一篇一汇报**：写失败只记进 `skipped`，继续下一篇（用户重试即可，重试幂等）；
/// 5. **索引与条目表同步**：写入成功的每一篇都走 `indexer::update_note`
///    （标签/搜索/图谱同一处增量更新，ADR-0006 影响一节），条目表在循环之后一次性更新。
///
/// 返回值是 [`IpcError`] 而不是 `mn_core::Error`：这一条路径上有一个错误码只有宿主层才有
/// （`INDEX_NOT_READY`，见 `error.rs`）。索引没就绪时从前借 `IO` 上报，而前端会把 `IO`
/// 翻成"磁盘读写失败：…" —— 用户于是去查磁盘，而正确的动作是"稍后重试"。
/// 错误码是**跨 IPC 的稳定契约**，不该用一个意思相反的词去凑。
fn tag_rename_in(
    state: &AppState,
    from: &str,
    to: &str,
    include_children: bool,
    dry_run: bool,
) -> Result<TagRenameOutcome, IpcError> {
    let started = Instant::now();

    if !state.is_open() {
        return Err(Error::VaultNotSet.into());
    }
    let Some(mapping) = mn_core::TagRename::new(from, to, include_children) else {
        return Err(Error::invalid(from, "标签名称为空，无法改名").into());
    };

    // 候选集依赖索引：索引没建好时返回 0 篇会被理解成"这个标签不存在"，
    // 那是**错的信息**。索引是缓存、随时会就绪，让用户等一下比给他一个假答案好。
    // 错误码用 `INDEX_NOT_READY` 而不是 `IO`：见本函数的文档注释。
    if indexer::status(state).phase != indexer::IndexPhase::Ready {
        return Err(IpcError::index_not_ready("标签索引正在构建，请稍后重试"));
    }

    let root = state.vault_root()?;
    let candidates = tag_rename_candidates(state, &mapping);

    let mut outcome = TagRenameOutcome {
        from: mapping.from_key().to_string(),
        to: mapping.to_key(),
        from_display: from.to_string(),
        to_display: mapping.to_display().to_string(),
        include_children,
        dry_run,
        candidates: candidates.len() as u32,
        edited: Vec::new(),
        skipped: Vec::new(),
        unchanged: 0,
        frontmatter_edits: 0,
        inline_edits: 0,
        inline_removed: 0,
        elapsed_ms: 0,
    };
    // 写入成功之后要回写的条目表条目（循环里只收集，循环后一次性 update_vault）
    let mut touched_entries: Vec<EntryMeta> = Vec::new();

    for rel in candidates {
        let path = match root.resolve_existing(&rel) {
            Ok(path) => path,
            Err(error) => {
                outcome.skipped.push(TagRenameSkip {
                    rel_path: rel.clone(),
                    reason: TagSkipReason::Unreadable,
                    message: format!("无法定位：{error}"),
                });
                continue;
            }
        };

        // 写锁 + 重新 stat：这里做的是"计划时的磁盘状态 vs 现在的磁盘状态"，
        // 与 `note_write` 的令牌校验是同一个思路，只是令牌来自条目表而非编辑器
        let written = {
            let _write_guard = state.write_guard();

            if let Some(message) = plan_mismatch(state, &path, &rel) {
                outcome.skipped.push(TagRenameSkip {
                    rel_path: rel.clone(),
                    reason: TagSkipReason::ExternalChange,
                    message,
                });
                continue;
            }

            let text = match read_text(&path, MAX_READ_BYTES) {
                Ok(text) => text,
                Err(error) => {
                    outcome.skipped.push(TagRenameSkip {
                        rel_path: rel.clone(),
                        reason: TagSkipReason::Unreadable,
                        message: format!("读取失败：{error}"),
                    });
                    continue;
                }
            };

            let Some(rewrite) = mn_core::rename_tags(&text, &mapping) else {
                // 候选来自索引、磁盘却已经没有旧写法：多半是上一轮重试已经改过它。
                // 不改、不报错、也不算"跳过"（没有需要解释的事情）
                outcome.unchanged += 1;
                continue;
            };

            let counts = TagRenameFile {
                rel_path: rel.clone(),
                frontmatter_edits: rewrite.frontmatter_edits,
                inline_edits: rewrite.inline_edits,
                inline_removed: rewrite.inline_removed,
            };

            if dry_run {
                // 预演：只算不写（候选集与判定与真跑完全一致，所以篇数是可信的）
                Some((rewrite, counts, 0u64, 0u64))
            } else {
                match write_atomic(&path, rewrite.text.as_bytes()) {
                    Ok(()) => {
                        indexer::update_note(state, &rel, &rewrite.text);
                        let meta = std::fs::metadata(&path).ok();
                        let size_bytes = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                        let mtime_ms = meta
                            .as_ref()
                            .and_then(mn_core::atomic::mtime_ms)
                            .unwrap_or(0);
                        Some((rewrite, counts, size_bytes, mtime_ms))
                    }
                    Err(error) => {
                        outcome.skipped.push(TagRenameSkip {
                            rel_path: rel.clone(),
                            reason: TagSkipReason::WriteFailed,
                            message: format!("写入失败：{error}"),
                        });
                        None
                    }
                }
            }
        };

        let Some((rewrite, counts, size_bytes, mtime_ms)) = written else {
            continue;
        };

        if !dry_run {
            touched_entries.push(EntryMeta {
                rel_path: rel.clone(),
                name: file_name_of(&rel),
                is_dir: false,
                size_bytes,
                mtime_ms: Some(mtime_ms),
                ext: ext_of(&rel),
            });
        }
        outcome.frontmatter_edits += rewrite.frontmatter_edits;
        outcome.inline_edits += rewrite.inline_edits;
        outcome.inline_removed += rewrite.inline_removed;
        outcome.edited.push(counts);
    }

    if !touched_entries.is_empty() {
        state.update_vault(|ctx| {
            for entry in touched_entries {
                ctx.upsert(entry);
            }
        });
    }

    outcome.elapsed_ms = started.elapsed().as_millis() as u64;
    log::info!(
        "标签{}：{} → {}（候选 {} 篇，改 {} 篇 / 跳过 {} 篇 / 无需改 {} 篇，{} 处 frontmatter + {} 处正文{}，耗时 {}ms）",
        if dry_run { "改名预演" } else { "改名" },
        outcome.from,
        outcome.to,
        outcome.candidates,
        outcome.edited.len(),
        outcome.skipped.len(),
        outcome.unchanged,
        outcome.frontmatter_edits,
        outcome.inline_edits,
        if outcome.inline_removed > 0 {
            format!("，合并去掉 {} 处重复", outcome.inline_removed)
        } else {
            String::new()
        },
        outcome.elapsed_ms
    );

    Ok(outcome)
}

/// 这次改名会碰到的笔记（路径字典序）。
///
/// 从标签索引的概览里取出**落在改名范围内**的键，再把它们的笔记并起来。范围内的键可能很多
/// （改 `父` 时它的每一个子标签都在范围内），但每个键上的笔记集合是现成的
/// （`notes_with_tag`），所以这一步与"有多少篇笔记"无关，只与"有多少个命中的标签"有关。
/// 用 `BTreeSet` 去重并保序，结果可复现（测试与日志都依赖这一点）。
fn tag_rename_candidates(state: &AppState, mapping: &mn_core::TagRename) -> Vec<String> {
    let mut out = std::collections::BTreeSet::new();
    for summary in indexer::tag_summary(state) {
        if !mapping.covers_key(&summary.key) {
            continue;
        }
        for rel in indexer::notes_with_tag(state, &summary.key) {
            out.insert(rel);
        }
    }
    out.into_iter().collect()
}

/// 计划时记下的磁盘状态与**现在**的磁盘状态对不上 → 返回一句面向用户的说明。
///
/// 判据用的是条目表里的 `(mtime,size)`：那是宿主对"磁盘上是什么"的既有认知
/// （打开/重扫/自己写盘/监听发现外部改动时都会更新，见 ADR-0016），也与索引跨会话复用
/// 用的是同一份判定键。对不上意味着"在我们做计划的这段时间里，这篇被应用之外的东西改过"——
/// 此时再拿刚读到的正文去改写，等于把对方的改动当成背景，用户重试一次就好。
///
/// 为什么 `mtime` 之外还要比 `size`：毫秒 mtime 有"同一毫秒内改动漏检"的固有窗口
/// （ADR-0004 的取舍），字节数是几乎免费的第二道判据 —— 两者都对得上才放行。
/// 条目表里没有这一篇、或它连 mtime 都拿不到时**放行**：拿不到证据就不该拦，
/// 拦住一个本来能改的文件比多改一次更难解释。
fn plan_mismatch(state: &AppState, path: &std::path::Path, rel: &str) -> Option<String> {
    let (expected_mtime, expected_size) = state
        .with_vault(|ctx| {
            Ok(ctx
                .entries
                .get(rel)
                .map(|entry| (entry.mtime_ms, entry.size_bytes)))
        })
        .ok()
        .flatten()?;

    // stat 失败（文件被删/权限不足）交给后面的读取去如实报错，这里不抢那份责任
    let meta = std::fs::metadata(path).ok()?;
    let current_mtime = mn_core::atomic::mtime_ms(&meta);

    if let Some(expected) = expected_mtime {
        if current_mtime != Some(expected) {
            return Some(format!(
                "磁盘被外部改动（条目表记为 {expected}ms，磁盘上是 {}ms），请重试",
                current_mtime.unwrap_or(0)
            ));
        }
    }
    if meta.len() != expected_size {
        return Some(format!(
            "磁盘被外部改动（条目表记为 {expected_size} 字节，磁盘上是 {} 字节），请重试",
            meta.len()
        ));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::notes::rename_note_in;
    use crate::commands::testkit::*;

    /// 一个"什么形态都有一点"的笔记：BOM + CRLF + 注释 + 未知键 + 块数组标签 + 行内标签。
    const TAGGED: &str = "\u{feff}---\r\ntitle: 示例\r\ntags:\r\n  - 甲\r\ndraft: false # 未完成\r\ncover: 图.png\r\n---\r\n# 标题\r\n\r\n正文 #行内\r\n";

    #[test]
    fn set_tags_adds_and_removes_with_a_minimal_diff() {
        let (dir, state) = state_with(&[("笔记/甲.md", TAGGED)]);

        let added = note_set_tags_in(
            &state,
            "笔记/甲.md",
            &owned(&["乙"]),
            &[],
            token_of(dir.path(), "笔记/甲.md"),
        )
        .unwrap();
        assert!(added.changed);
        assert_eq!(added.tags, owned(&["甲", "乙"]));
        let on_disk = read_file(dir.path(), "笔记/甲.md");
        assert_eq!(
            on_disk,
            TAGGED.replace("  - 甲\r\n", "  - 甲\r\n  - 乙\r\n"),
            "只该多出一个项行"
        );
        assert!(on_disk.starts_with('\u{feff}'), "BOM 必须保留");
        assert!(
            on_disk.contains("draft: false # 未完成"),
            "行尾注释必须保留"
        );
        assert!(on_disk.contains("cover: 图.png"), "未知键必须保留");
        assert!(on_disk.contains("# 标题"), "正文一个字节不动");

        // 索引增量同步：标签索引、全库概览、搜索索引都跟着变了（不需要重扫）
        assert_eq!(
            indexer::tags_of(&state, "笔记/甲.md")
                .unwrap()
                .iter()
                .map(|tag| tag.tag.clone())
                .collect::<Vec<String>>(),
            owned(&["甲", "乙", "行内"])
        );
        assert!(tags_list_in(&state).iter().any(|item| item.key == "乙"));
        assert!(
            state
                .try_search(|search| search.search("乙", 10))
                .map(|result| result
                    .unwrap()
                    .hits
                    .iter()
                    .any(|hit| hit.rel_path == "笔记/甲.md"))
                .unwrap_or(false),
            "搜索索引也应能命中新写入的标签"
        );

        // 删掉：磁盘逐字节回到原样
        let removed =
            note_set_tags_in(&state, "笔记/甲.md", &[], &owned(&["乙"]), added.mtime_ms).unwrap();
        assert!(removed.changed);
        assert_eq!(removed.tags, owned(&["甲"]));
        assert_eq!(read_file(dir.path(), "笔记/甲.md"), TAGGED);
    }

    #[test]
    fn set_tags_refuses_on_a_stale_token_and_never_overwrites() {
        let (dir, state) = state_with(&[("甲.md", "---\ntags: [甲]\n---\n正文\n")]);
        let stale = token_of(dir.path(), "甲.md") + 1;

        let error = note_set_tags_in(&state, "甲.md", &owned(&["乙"]), &[], stale).unwrap_err();
        assert_eq!(error.code(), mn_core::ErrorCode::Conflict);
        assert!(matches!(
            error,
            Error::Conflict {
                current_mtime_ms
            } if current_mtime_ms > 0
        ));
        // 一个字节都没写
        assert_eq!(
            read_file(dir.path(), "甲.md"),
            "---\ntags: [甲]\n---\n正文\n"
        );
    }

    #[test]
    fn set_tags_is_idempotent_and_writes_nothing_for_an_existing_tag() {
        let (dir, state) = state_with(&[("甲.md", "---\ntags: [Rust]\n---\n正文\n")]);
        let base = token_of(dir.path(), "甲.md");

        // 加一个**已经存在**的标签（写法不同、判同后是同一个）→ 不写盘、mtime 不变
        let outcome = note_set_tags_in(&state, "甲.md", &owned(&["#rust"]), &[], base).unwrap();
        assert!(!outcome.changed, "幂等请求不该产生无意义的 diff");
        assert_eq!(outcome.written_in_ms, 0);
        assert_eq!(outcome.mtime_ms, base, "没有实际写入就不该动令牌");
        assert_eq!(outcome.tags, owned(&["Rust"]), "写法保留首次出现的那份");
        assert_eq!(
            read_file(dir.path(), "甲.md"),
            "---\ntags: [Rust]\n---\n正文\n"
        );

        // 空请求同理：什么都不做
        let empty = note_set_tags_in(&state, "甲.md", &[], &[], base).unwrap();
        assert!(!empty.changed);
        assert_eq!(empty.tags, owned(&["Rust"]));
    }

    #[test]
    fn set_tags_creates_frontmatter_when_the_note_has_none() {
        let (dir, state) = state_with(&[("裸.md", "# 只有正文\n\n正文里的 #行内。\n")]);

        let outcome = note_set_tags_in(
            &state,
            "裸.md",
            &owned(&["新"]),
            &[],
            token_of(dir.path(), "裸.md"),
        )
        .unwrap();
        assert!(outcome.changed);
        assert_eq!(outcome.tags, owned(&["新"]));
        assert_eq!(
            read_file(dir.path(), "裸.md"),
            "---\ntags: [新]\n---\n# 只有正文\n\n正文里的 #行内。\n"
        );
        assert_eq!(
            outcome.text, "---\ntags: [新]\n---\n# 只有正文\n\n正文里的 #行内。\n",
            "出参里的 text 必须就是磁盘上的那份（前端据此对齐编辑器内存）"
        );

        // 删掉最后一个标签：**保留** `tags` 字段写成空列表（不删 key，见 ADR-0006 后续修订）
        let back =
            note_set_tags_in(&state, "裸.md", &[], &owned(&["新"]), outcome.mtime_ms).unwrap();
        assert!(back.changed);
        assert!(back.tags.is_empty());
        assert_eq!(
            read_file(dir.path(), "裸.md"),
            "---\ntags: []\n---\n# 只有正文\n\n正文里的 #行内。\n"
        );
        // 正文里的行内标签从头到尾没被碰过
        assert_eq!(
            indexer::tags_of(&state, "裸.md")
                .unwrap()
                .iter()
                .filter(|tag| tag.source == mn_core::TagSource::Inline)
                .map(|tag| tag.tag.clone())
                .collect::<Vec<String>>(),
            owned(&["行内"])
        );
    }

    #[test]
    fn set_tags_handles_scalar_tags_and_quotes_unsafe_values() {
        let (dir, state) = state_with(&[("甲.md", "---\r\ntags: 甲\r\n---\r\n正文\r\n")]);

        // 标量 + 一个 → 仍是标量（沿用既有写法）
        let one = note_set_tags_in(
            &state,
            "甲.md",
            &owned(&["乙"]),
            &[],
            token_of(dir.path(), "甲.md"),
        )
        .unwrap();
        let disk = read_file(dir.path(), "甲.md");
        assert_eq!(disk, "---\r\ntags: [甲, 乙]\r\n---\r\n正文\r\n");
        assert!(disk.contains("\r\n"), "CRLF 保真");

        // 带空格 / 层级 / 中文：写出去必须能原样读回来
        let unsafe_tags = note_set_tags_in(
            &state,
            "甲.md",
            &owned(&["带 空格", "父/子", "中文标签"]),
            &[],
            one.mtime_ms,
        )
        .unwrap();
        assert_eq!(
            unsafe_tags.tags,
            owned(&["甲", "乙", "带 空格", "父/子", "中文标签"]),
            "含空格的标签必须被引号保护后原样读回"
        );
        assert!(read_file(dir.path(), "甲.md").contains("'带 空格'"));

        // 删到一个不剩 → 保留字段、写成空列表（而不是把 key 删掉）
        let none = note_set_tags_in(
            &state,
            "甲.md",
            &[],
            &owned(&["甲", "#乙", "带 空格", "父/子", "中文标签"]),
            unsafe_tags.mtime_ms,
        )
        .unwrap();
        assert_eq!(none.tags, Vec::<String>::new());
        assert_eq!(
            read_file(dir.path(), "甲.md"),
            "---\r\ntags: []\r\n---\r\n正文\r\n"
        );
    }

    #[test]
    fn set_tags_only_touches_the_field_it_owns() {
        // 同时存在 `tag` 与 `tags`：写入目标永远是 `tags`（`set_tags` 的既有口径）。
        // 因此"只被 `tag` 字段提供"的标签删不掉 —— 这是已知边界，钉住它以免被误认为随机行为
        let (dir, state) = state_with(&[("甲.md", "---\ntag: 单数\ntags: [甲]\n---\n正文\n")]);

        let existing =
            note_set_tags_in(&state, "甲.md", &[], &[], token_of(dir.path(), "甲.md")).unwrap();
        assert_eq!(
            existing.tags,
            owned(&["单数", "甲"]),
            "两个字段合并后才是面板看到的列表"
        );

        let outcome =
            note_set_tags_in(&state, "甲.md", &[], &owned(&["单数"]), existing.mtime_ms).unwrap();
        assert!(!outcome.changed, "没有可写的改动");
        assert_eq!(outcome.tags, owned(&["单数", "甲"]), "`tag: 单数` 仍然在");
        assert_eq!(
            read_file(dir.path(), "甲.md"),
            "---\ntag: 单数\ntags: [甲]\n---\n正文\n"
        );

        // 加标签则照常工作（结果写进 `tags`，不会与 `tag` 字段打架）
        let added =
            note_set_tags_in(&state, "甲.md", &owned(&["乙"]), &[], outcome.mtime_ms).unwrap();
        assert_eq!(added.tags, owned(&["单数", "甲", "乙"]));
        assert_eq!(
            read_file(dir.path(), "甲.md"),
            "---\ntag: 单数\ntags: [甲, 乙]\n---\n正文\n"
        );
    }

    #[test]
    fn set_tags_works_on_the_singular_tag_field_and_on_an_empty_request() {
        // 只有 `tag:`（单数）的笔记：写入目标就是它（`set_tags` 的既有口径）
        let (dir, state) = state_with(&[("甲.md", "---\ntag: 旧\n---\n正文\n")]);
        let added = note_set_tags_in(
            &state,
            "甲.md",
            &owned(&["新"]),
            &[],
            token_of(dir.path(), "甲.md"),
        )
        .unwrap();
        assert_eq!(added.tags, owned(&["旧", "新"]));
        assert_eq!(
            read_file(dir.path(), "甲.md"),
            "---\ntag: [旧, 新]\n---\n正文\n"
        );

        // 删到一个不剩：保留字段、写成空列表（不删 key）
        let back =
            note_set_tags_in(&state, "甲.md", &[], &owned(&["旧", "新"]), added.mtime_ms).unwrap();
        assert!(back.tags.is_empty());
        assert_eq!(read_file(dir.path(), "甲.md"), "---\ntag: []\n---\n正文\n");

        // 既不增也不删 = 纯查询：不改一个字节（`tags: 甲, 乙` 这种标量形态最容易被顺手"规范化"）
        let (plain_dir, plain_state) = state_with(&[("乙.md", "---\ntags: 甲, 乙\n---\n正文\n")]);
        let query = note_set_tags_in(
            &plain_state,
            "乙.md",
            &[],
            &[],
            token_of(plain_dir.path(), "乙.md"),
        )
        .unwrap();
        assert!(!query.changed);
        assert_eq!(query.tags, owned(&["甲", "乙"]));
        assert_eq!(
            read_file(plain_dir.path(), "乙.md"),
            "---\ntags: 甲, 乙\n---\n正文\n"
        );
    }

    #[test]
    fn set_tags_reports_missing_file_directory_and_unopened_vault() {
        let (_dir, state) = state_with(&[("甲.md", "正文\n")]);
        assert_eq!(
            note_set_tags_in(&state, "不存在.md", &owned(&["甲"]), &[], 0)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::NotFound
        );
        std::fs::create_dir_all(_dir.path().join("目录")).unwrap();
        assert_eq!(
            note_set_tags_in(&state, "目录", &owned(&["甲"]), &[], 0)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::IsDirectory
        );
        // Vault 未打开
        let closed = AppState::default();
        assert_eq!(
            note_set_tags_in(&closed, "甲.md", &owned(&["甲"]), &[], 0)
                .unwrap_err()
                .code(),
            mn_core::ErrorCode::VaultNotSet
        );
    }

    /// 只读文件 / 只读 Vault：写盘失败必须是**可解释的错误**，且磁盘内容一字不改。
    ///
    /// 只在 Windows 上跑：`write_atomic` 的收尾是 `MoveFileEx(REPLACE_EXISTING)`，
    /// 目标只读时它必然失败；POSIX 的 `rename` 只看目录权限、会把只读文件照样换掉，
    /// 在那边这个用例会**假失败**（用例本身没错，是平台语义不同）。
    #[cfg(windows)]
    #[test]
    // `set_readonly(false)` 在 Unix 上语义不同（会让文件对所有人可写），但这一段本来就只跑在
    // Windows 上：这里恢复只读位只是为了**让临时目录能被清理**，不是产品行为
    #[allow(clippy::permissions_set_readonly_false)]
    fn set_tags_reports_io_instead_of_silently_failing_on_a_read_only_file() {
        let (dir, state) = state_with(&[("只读.md", "---\ntags: [甲]\n---\n正文\n")]);
        let path = dir.path().join("只读.md");
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&path, permissions).unwrap();

        let error = note_set_tags_in(
            &state,
            "只读.md",
            &owned(&["乙"]),
            &[],
            token_of(dir.path(), "只读.md"),
        )
        .unwrap_err();
        assert_eq!(
            error.code(),
            mn_core::ErrorCode::Io,
            "写失败要报 IO，不能假装成功"
        );

        // 收尾：把只读位摘掉再断言内容（否则临时目录清理会失败）
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(false);
        std::fs::set_permissions(&path, permissions).unwrap();
        assert_eq!(
            read_file(dir.path(), "只读.md"),
            "---\ntags: [甲]\n---\n正文\n"
        );
        // 索引也不该被这次失败的写入污染
        assert_eq!(
            indexer::tags_of(&state, "只读.md")
                .unwrap()
                .iter()
                .map(|tag| tag.tag.clone())
                .collect::<Vec<String>>(),
            owned(&["甲"])
        );
    }

    #[test]
    fn note_tags_returns_index_tags_and_frontmatter_fields() {
        let (_dir, state) = state_with(&[(
            "笔记/甲.md",
            "---\ntitle: 甲\ntags: [项目/甲]\n---\n\n正文 #行内\n",
        )]);
        let root = state.vault_root().unwrap();

        let result = note_tags_in(&root, &state, "笔记/甲.md").unwrap();
        assert_eq!(result.rel_path, "笔记/甲.md");
        assert_eq!(
            result
                .tags
                .iter()
                .map(|tag| (tag.tag.as_str(), tag.line))
                .collect::<Vec<_>>(),
            vec![("项目/甲", 3), ("行内", 6)],
            "frontmatter 在前、正文在后，行号是全文绝对行号"
        );
        assert_eq!(result.tags[0].source, mn_core::TagSource::Frontmatter);
        assert_eq!(result.tags[1].source, mn_core::TagSource::Inline);

        let keys: Vec<&str> = result
            .frontmatter
            .iter()
            .map(|field| field.key.as_str())
            .collect();
        assert_eq!(keys, vec!["title", "tags"], "字段保序");
        assert_eq!(result.frontmatter[0].line, 2);
        assert_eq!(
            result.frontmatter[0].value.as_str(),
            Some("甲"),
            "标量值已去引号"
        );
        assert_eq!(
            result.frontmatter[1].value.as_list(),
            Some(["项目/甲".to_string()].as_slice())
        );
    }

    #[test]
    fn note_tags_without_frontmatter_uses_empty_array_not_null() {
        let (_dir, state) = state_with(&[("甲.md", "正文 #甲\n")]);
        let root = state.vault_root().unwrap();

        let result = note_tags_in(&root, &state, "甲.md").unwrap();
        assert!(result.frontmatter.is_empty());

        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"relPath\":\"甲.md\""), "实际：{json}");
        assert!(json.contains("\"frontmatter\":[]"), "必须是空数组：{json}");
        assert!(json.contains("\"tags\":[{"), "实际：{json}");
        assert!(json.contains("\"source\":\"inline\""), "实际：{json}");
        assert!(json.contains("\"line\":1"), "实际：{json}");
    }

    #[test]
    fn note_tags_reports_missing_file_and_directory() {
        let (dir, state) = state_with(&[("甲.md", "#甲\n")]);
        let root = state.vault_root().unwrap();
        std::fs::create_dir_all(dir.path().join("某个目录")).unwrap();

        assert_eq!(
            note_tags_in(&root, &state, "不存在.md").unwrap_err().code(),
            mn_core::ErrorCode::NotFound
        );
        assert_eq!(
            note_tags_in(&root, &state, "某个目录").unwrap_err().code(),
            mn_core::ErrorCode::IsDirectory
        );
    }

    #[test]
    fn note_tags_computes_from_text_when_note_is_not_indexed() {
        // 附件之类不在索引里；标签仍要现算出来，而不是显示成"没有标签"
        let (dir, state) = state_with(&[("甲.md", "#甲\n")]);
        let root = state.vault_root().unwrap();
        std::fs::write(dir.path().join("附件.md"), "正文 #现算\n").unwrap();

        let result = note_tags_in(&root, &state, "附件.md").unwrap();
        assert_eq!(
            result
                .tags
                .iter()
                .map(|tag| tag.tag.as_str())
                .collect::<Vec<_>>(),
            vec!["现算"]
        );
    }

    #[test]
    fn tags_list_orders_by_count_then_key() {
        let (_dir, state) = state_with(&[
            ("a.md", "正文 #共享 与 #独有\n"),
            ("b.md", "---\ntags: [共享]\n---\n正文\n"),
            ("c.md", "正文 #共享\n"),
        ]);

        let summary = tags_list_in(&state);
        assert_eq!(summary.len(), 2);
        assert_eq!(summary[0].key, "共享");
        assert_eq!(summary[0].count, 3, "count 是笔记数");
        assert_eq!(summary[1].key, "独有");
        assert_eq!(summary[1].count, 1);

        let json = serde_json::to_string(&summary).unwrap();
        for key in ["\"key\"", "\"tag\"", "\"count\""] {
            assert!(json.contains(key), "缺少字段 {key}：{json}");
        }
        assert!(!json.contains("keyCount"), "字段名必须是 camelCase：{json}");
    }

    #[test]
    fn tag_notes_normalizes_input_and_rejects_empty_key() {
        let (_dir, state) = state_with(&[("b.md", "正文 #Rust\n"), ("a.md", "正文 #rust\n")]);

        // 传原始写法（带 `#`、任意大小写）也能命中，返回的 key 是归一化后的键
        let result = tag_notes_in(&state, "#RUST").unwrap();
        assert_eq!(result.key, "rust");
        assert_eq!(
            result.notes,
            vec!["a.md".to_string(), "b.md".to_string()],
            "字典序"
        );
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"key\":\"rust\""), "实际：{json}");
        assert!(json.contains("\"notes\":["), "实际：{json}");

        // 不存在的标签 → 空列表（不是错误）
        assert!(tag_notes_in(&state, "没有这个标签")
            .unwrap()
            .notes
            .is_empty());

        // 空键 → PATH_INVALID
        for key in ["", "   ", "#", "/"] {
            assert_eq!(
                tag_notes_in(&state, key).unwrap_err().code(),
                mn_core::ErrorCode::PathInvalid,
                "应拒绝空键：{key:?}"
            );
        }
    }

    #[test]
    fn tags_follow_save_rename_and_delete() {
        let (dir, state) = state_with(&[("笔记/甲.md", "正文，还没有标签\n")]);
        assert!(tags_list_in(&state).is_empty());

        // 保存 = 落盘 + 增量更新索引（note_write 里正是这两步），之后标签立刻可见
        let saved = "正文 #新标签\n";
        std::fs::write(dir.path().join("笔记").join("甲.md"), saved).unwrap();
        indexer::update_note(&state, "笔记/甲.md", saved);
        assert_eq!(tags_list_in(&state)[0].key, "新标签");
        assert_eq!(
            tag_notes_in(&state, "新标签").unwrap().notes,
            vec!["笔记/甲.md".to_string()],
            "编辑笔记加标签，面板立刻能看到"
        );

        // 重命名（mn-index 的 rename 走的是同一对 remove/upsert）后标签跟着换路径
        let report = rename_note_in(&state, "笔记/甲.md", "乙", true).unwrap();
        assert_eq!(report.new_rel_path, "笔记/乙.md");
        assert_eq!(
            tag_notes_in(&state, "新标签").unwrap().notes,
            vec!["笔记/乙.md".to_string()],
            "标签必须跟着新路径"
        );

        // 删除 → 标签一起清掉，概览里不留空标签
        indexer::remove_note(&state, "笔记/乙.md");
        assert!(tags_list_in(&state).is_empty());
        assert!(tag_notes_in(&state, "新标签").unwrap().notes.is_empty());
    }

    // -- 标签重命名 / 合并（tag_rename） -----------------------------------------

    /// 全库改写：frontmatter 与正文一起改，条目表与索引一起同步，逐篇如实汇报。
    #[test]
    fn tag_rename_rewrites_the_whole_vault_and_reports_every_file() {
        let (dir, state) = state_with(&[
            ("甲.md", "---\ntags: [旧, 别的]\n---\n\n正文 #旧 与 #旧。\n"),
            ("目录/乙.md", "---\ntag: 旧\n---\n\n#旧 收尾\n"),
            ("丙.md", "---\ntags: [无关]\n---\n\n正文 #无关\n"),
            // 代码块与行内代码里的 `#旧` 不是标签：一个字都不能动
            ("丁.md", "```\n#旧\n```\n\n`#旧` 与 #旧\n"),
        ]);

        let outcome = tag_rename_in(&state, "旧", "新", false, false).unwrap();

        assert_eq!(outcome.from, "旧");
        assert_eq!(outcome.to, "新");
        assert!(!outcome.dry_run);
        assert_eq!(outcome.candidates, 3, "丁 也是候选（正文里有真标签）");
        assert_eq!(outcome.skipped.len(), 0);
        assert_eq!(outcome.unchanged, 0);
        assert_eq!(
            outcome
                .edited
                .iter()
                .map(|file| file.rel_path.as_str())
                .collect::<Vec<_>>(),
            vec!["丁.md", "甲.md", "目录/乙.md"],
            "字典序（`目录/乙.md` 的 UTF-8 字节序在 `甲.md` 之后）"
        );
        assert_eq!(outcome.frontmatter_edits, 2);
        assert_eq!(outcome.inline_edits, 4);

        // 磁盘：frontmatter 两个字段都改、正文行内也改，且代码块/行内代码原样
        assert_eq!(
            read_file(dir.path(), "甲.md"),
            "---\ntags: [新, 别的]\n---\n\n正文 #新 与 #新。\n"
        );
        assert_eq!(
            read_file(dir.path(), "目录/乙.md"),
            "---\ntag: 新\n---\n\n#新 收尾\n"
        );
        assert_eq!(
            read_file(dir.path(), "丙.md"),
            "---\ntags: [无关]\n---\n\n正文 #无关\n"
        );
        assert_eq!(
            read_file(dir.path(), "丁.md"),
            "```\n#旧\n```\n\n`#旧` 与 #新\n"
        );

        // 索引与条目表跟着走（复用既有增量路径，不需要重扫）
        assert!(
            tag_notes_in(&state, "旧").unwrap().notes.is_empty(),
            "旧标签必须从索引里消失"
        );
        assert_eq!(
            tag_notes_in(&state, "新").unwrap().notes,
            vec![
                "丁.md".to_string(),
                "甲.md".to_string(),
                "目录/乙.md".to_string()
            ]
        );
        let summary = tags_list_in(&state);
        assert!(
            summary.iter().any(|item| item.key == "新"),
            "全库概览跟着变"
        );
        assert!(summary.iter().all(|item| item.key != "旧"));
        // 条目表里的 (size, mtime) 更新成了磁盘上的真实值（下一次对账/外部改动监听都依赖它）
        let (size, mtime) = state
            .with_vault(|ctx| {
                let entry = ctx.entries.get("甲.md").unwrap();
                Ok((entry.size_bytes, entry.mtime_ms))
            })
            .unwrap();
        assert_eq!(size, read_file(dir.path(), "甲.md").len() as u64);
        assert_eq!(
            mtime,
            Some(token_of(dir.path(), "甲.md")),
            "条目表必须与磁盘对齐，否则下一次改名会把这一篇误判成「磁盘被外部改动」"
        );

        // 搜索索引也在同一处增量更新（正文变了，全文搜索必须搜得到新内容）
        let hits = state
            .with_search(|search| Ok(search.search("新", 10).unwrap().total))
            .unwrap();
        assert!(
            hits >= 4,
            "改写后的正文与字段都要能被搜到（实际 {hits} 行）"
        );
    }

    /// 层级：`父` → `母` 把子标签一起带走；`include_children=false` 时不带。
    #[test]
    fn tag_rename_can_carry_hierarchical_children() {
        let text = "---\ntags: [父, 父/子]\n---\n\n#父 与 #父/子 与 #父老\n";
        let (dir, state) = state_with(&[("甲.md", text), ("乙.md", "#父\n")]);

        let carried = tag_rename_in(&state, "父", "母", true, false).unwrap();
        assert_eq!(carried.candidates, 2);
        assert_eq!(
            read_file(dir.path(), "甲.md"),
            "---\ntags: [母, 母/子]\n---\n\n#母 与 #母/子 与 #父老\n",
            "`父老` 不能被误伤"
        );
        assert_eq!(read_file(dir.path(), "乙.md"), "#母\n");

        // 不带子标签：只剩整条等于 `父` 的那些（`父/子` 留在原地）
        let (dir2, state2) = state_with(&[("甲.md", text)]);
        let flat = tag_rename_in(&state2, "父", "母", false, false).unwrap();
        assert_eq!(flat.inline_edits, 1);
        assert_eq!(
            read_file(dir2.path(), "甲.md"),
            "---\ntags: [母, 父/子]\n---\n\n#母 与 #父/子 与 #父老\n"
        );
    }

    /// 合并：目标已经在同一篇里出现 → 不留重复项（frontmatter 列表与正文提及都算）。
    #[test]
    fn tag_rename_merges_without_leaving_duplicates() {
        let (dir, state) =
            state_with(&[("甲.md", "---\ntags: [甲, 乙]\n---\n\n正文 #甲 与 #乙。\n")]);
        let outcome = tag_rename_in(&state, "甲", "乙", false, false).unwrap();

        assert_eq!(
            read_file(dir.path(), "甲.md"),
            "---\ntags: [乙]\n---\n\n正文 与 #乙。\n"
        );
        assert_eq!(
            outcome.frontmatter_edits, 2,
            "一条被换写法、一条因为与目标重复被去掉"
        );
        assert_eq!(outcome.inline_removed, 1);
        assert_eq!(
            tag_notes_in(&state, "乙").unwrap().notes,
            vec!["甲.md".to_string()]
        );
        assert!(tag_notes_in(&state, "甲").unwrap().notes.is_empty());
    }

    /// 预演（`dry_run`）走完全一样的判定，但一个字节都不写、索引也不动。
    #[test]
    fn tag_rename_dry_run_counts_without_writing() {
        let (dir, state) = state_with(&[
            ("甲.md", "---\ntags: [旧]\n---\n\n正文 #旧\n"),
            ("乙.md", "#旧 与 #旧\n"),
            ("丙.md", "没有标签\n"),
        ]);

        let preview = tag_rename_in(&state, "旧", "新", true, true).unwrap();
        assert!(preview.dry_run);
        assert_eq!(preview.edited.len(), 2, "预演报的就是真跑会改的篇数");
        assert_eq!(preview.inline_edits, 3);
        assert_eq!(
            read_file(dir.path(), "甲.md"),
            "---\ntags: [旧]\n---\n\n正文 #旧\n",
            "预演不落盘"
        );
        assert_eq!(read_file(dir.path(), "乙.md"), "#旧 与 #旧\n");
        // 索引与条目表也不动（预演不是一次写操作）
        assert_eq!(
            tag_notes_in(&state, "旧").unwrap().notes,
            vec!["乙.md".to_string(), "甲.md".to_string()]
        );
        assert!(tag_notes_in(&state, "新").unwrap().notes.is_empty());
    }

    /// 重试幂等：第二次跑"没有需要改的"，既不改文件也不报错（`unchanged` 里如实计数）。
    #[test]
    fn tag_rename_retry_is_idempotent() {
        let before = "---\ntags: [旧]\n---\n\n正文 #旧\n";
        let (dir, state) = state_with(&[("甲.md", before)]);

        let first = tag_rename_in(&state, "旧", "新", false, false).unwrap();
        assert_eq!(first.edited.len(), 1);
        let after_first = read_file(dir.path(), "甲.md");
        let mtime_after_first = token_of(dir.path(), "甲.md");

        // 第二次：索引已经跟着第一次更新了 → 候选集是空的（连读文件都不必）
        let second = tag_rename_in(&state, "旧", "新", false, false).unwrap();
        assert!(second.edited.is_empty(), "已经改过的不再改第二遍");
        assert_eq!(second.candidates, 0, "索引里已经没有旧写法了");
        assert_eq!(after_first, read_file(dir.path(), "甲.md"));
        assert_eq!(
            mtime_after_first,
            token_of(dir.path(), "甲.md"),
            "一个字节都没写（连 mtime 都不该动）"
        );

        // 索引比磁盘旧一拍（外部改过、监听还没对账）时，候选集里仍然有这一篇 ——
        // 但真正的判据是**磁盘上的文本**，所以它只会被计入 `unchanged`，不会白写一次
        indexer::update_note(&state, "甲.md", before);
        let third = tag_rename_in(&state, "旧", "新", false, false).unwrap();
        assert_eq!(third.candidates, 1);
        assert_eq!(third.unchanged, 1);
        assert!(third.edited.is_empty());
        assert_eq!(mtime_after_first, token_of(dir.path(), "甲.md"));
    }

    /// 磁盘被外部改动过的那些：跳过并**如实说明原因**，其余照改。
    #[test]
    fn tag_rename_skips_files_changed_outside_the_app() {
        let (dir, state) = state_with(&[
            ("稳.md", "---\ntags: [旧]\n---\n\n正文 #旧\n"),
            ("被外部改.md", "---\ntags: [旧]\n---\n\n正文 #旧\n"),
        ]);

        // 让条目表与磁盘对不上：这就是"宿主的认知过时了"的判据（ADR-0016 同一份对账口径）。
        // 不用真的去 sleep 等 mtime 跳一格 —— 那个写法在毫秒级 mtime 上并不稳定
        state.update_vault(|ctx| {
            if let Some(entry) = ctx.entries.get_mut("被外部改.md") {
                entry.mtime_ms = Some(1);
            }
        });

        let outcome = tag_rename_in(&state, "旧", "新", false, false).unwrap();

        assert_eq!(
            outcome
                .edited
                .iter()
                .map(|file| file.rel_path.as_str())
                .collect::<Vec<_>>(),
            vec!["稳.md"]
        );
        assert_eq!(outcome.skipped.len(), 1);
        assert_eq!(outcome.skipped[0].rel_path, "被外部改.md");
        assert_eq!(outcome.skipped[0].reason, TagSkipReason::ExternalChange);
        assert!(
            outcome.skipped[0].message.contains("磁盘被外部改动"),
            "跳过必须带上能读懂的原因：{}",
            outcome.skipped[0].message
        );

        // 绝不静默覆盖：被跳过的那一篇一个字节都没动
        assert_eq!(
            read_file(dir.path(), "被外部改.md"),
            "---\ntags: [旧]\n---\n\n正文 #旧\n"
        );
        assert_eq!(
            read_file(dir.path(), "稳.md"),
            "---\ntags: [新]\n---\n\n正文 #新\n"
        );
        // 序列化形状（前端按 kebab-case 的稳定原因分组）
        let json = serde_json::to_string(&outcome).unwrap();
        assert!(
            json.contains("\"reason\":\"external-change\""),
            "实际：{json}"
        );
        assert!(json.contains("\"dryRun\":false"), "实际：{json}");

        // 字节数对不上也算"磁盘被外部改过"：mtime 是毫秒级、有漏检窗口，字节数是第二道判据
        let (dir2, state2) = state_with(&[("乙.md", "---\ntags: [旧]\n---\n正文\n")]);
        state2.update_vault(|ctx| {
            if let Some(entry) = ctx.entries.get_mut("乙.md") {
                entry.size_bytes += 7;
            }
        });
        let by_size = tag_rename_in(&state2, "旧", "新", false, false).unwrap();
        assert_eq!(by_size.skipped.len(), 1);
        assert_eq!(by_size.skipped[0].reason, TagSkipReason::ExternalChange);
        assert!(
            by_size.skipped[0].message.contains("字节"),
            "跳过原因要说清是哪一项对不上：{}",
            by_size.skipped[0].message
        );
        assert_eq!(
            read_file(dir2.path(), "乙.md"),
            "---\ntags: [旧]\n---\n正文\n"
        );
    }

    /// 单篇写失败不能把整批弄成"半截还不说"：只记一条跳过、其余照改。
    ///
    /// 与 `set_tags_reports_io_instead_of_silently_failing_on_a_read_only_file` 同一平台口径：
    /// `write_atomic` 的收尾在 Windows 上是 `MoveFileEx(REPLACE_EXISTING)`，目标只读时必然失败。
    #[cfg(windows)]
    #[test]
    #[allow(clippy::permissions_set_readonly_false)]
    fn tag_rename_reports_a_failed_write_and_keeps_going() {
        let (dir, state) = state_with(&[
            ("只读.md", "---\ntags: [旧]\n---\n正文\n"),
            ("别的.md", "---\ntags: [旧]\n---\n正文\n"),
        ]);
        let path = dir.path().join("只读.md");
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&path, permissions).unwrap();

        let outcome = tag_rename_in(&state, "旧", "新", false, false).unwrap();

        // 收尾：摘掉只读位（否则临时目录清理会失败）
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(false);
        std::fs::set_permissions(&path, permissions).unwrap();

        assert_eq!(outcome.edited.len(), 1, "另一个文件照改");
        assert_eq!(outcome.edited[0].rel_path, "别的.md");
        assert_eq!(outcome.skipped.len(), 1);
        assert_eq!(outcome.skipped[0].rel_path, "只读.md");
        assert_eq!(outcome.skipped[0].reason, TagSkipReason::WriteFailed);
        assert!(outcome.skipped[0].message.contains("写入失败"));
        assert_eq!(
            read_file(dir.path(), "只读.md"),
            "---\ntags: [旧]\n---\n正文\n"
        );
        // 写失败的那篇不能被同步进索引（索引必须与磁盘一致）
        assert_eq!(
            indexer::tags_of(&state, "只读.md")
                .unwrap()
                .iter()
                .map(|tag| tag.tag.clone())
                .collect::<Vec<String>>(),
            owned(&["旧"])
        );
    }

    /// 入参与前置条件：空名、Vault 未打开、索引没就绪。
    #[test]
    fn tag_rename_validates_its_inputs_and_needs_a_ready_index() {
        let (_dir, state) = state_with(&[("甲.md", "#旧\n")]);

        for (from, to) in [
            ("", "新"),
            ("   ", "新"),
            ("#", "新"),
            ("旧", ""),
            ("旧", " # "),
        ] {
            assert_eq!(
                tag_rename_in(&state, from, to, true, false)
                    .unwrap_err()
                    .code,
                mn_core::ErrorCode::PathInvalid.as_str(),
                "应当拒绝：{from:?} → {to:?}"
            );
        }

        // 索引还在构建：明确报错，而不是回答"改了 0 篇"（那是一句假答案）。
        // 错误码是宿主侧新增的 `INDEX_NOT_READY`（从前借 `IO`，见 `tag_rename_in` 的文档）
        state.set_index_status(indexer::IndexStatus::default());
        let building = tag_rename_in(&state, "旧", "新", true, false).unwrap_err();
        assert_eq!(building.code, "INDEX_NOT_READY");
        assert!(building.message.contains("正在构建"), "实际：{building}");

        // Vault 未打开
        let closed = AppState::default();
        assert_eq!(
            tag_rename_in(&closed, "旧", "新", true, false)
                .unwrap_err()
                .code,
            mn_core::ErrorCode::VaultNotSet.as_str()
        );
    }

    // -- 标签的层级编辑（tag_move）---------------------------------------------

    /// 层级编辑的契约：挂到父标签下、提回顶层、以及四种非法移动。
    ///
    /// 这一条同时钉住"复用了重命名那条写路径"：改完之后 frontmatter **与正文行内**都要变
    /// （只改一处就等于没改），子标签要跟着走，而"目标键被占用"必须被拒（那是合并，不是移动）。
    #[test]
    fn tag_move_nests_promotes_and_refuses_invalid_moves() {
        let (dir, state) = state_with(&[
            // 刻意带 frontmatter：移动/重命名只会改**已有**的字段（不会凭空建区块，
            // 那是"加标签"的 `set_tags_or_create` 才做的事），所以两种写法都要覆盖到
            ("甲.md", "---\ntags: [甲]\n---\n\n正文 #甲 与 #甲/子\n"),
            ("乙.md", "# 乙\n\n正文 #乙\n"),
        ]);

        // 挂到 `父` 下：frontmatter 与正文行内一起改，子标签跟着走
        let outcome = tag_move_in(&state, "甲", "父", true, false).unwrap();
        assert_eq!(outcome.from, "甲");
        assert_eq!(outcome.to, "父/甲");
        let moved = read_file(dir.path(), "甲.md");
        assert!(
            moved.contains("tags: [父/甲]"),
            "frontmatter 也要改：{moved}"
        );
        assert!(moved.contains("#父/甲/子"), "子标签跟着走：{moved}");

        // 提回顶层：`父/甲` → `甲`（末段保留），子标签同样跟着回来
        let promoted = tag_move_in(&state, "父/甲", "", true, false).unwrap();
        assert_eq!(promoted.to, "甲");
        assert_eq!(
            read_file(dir.path(), "甲.md"),
            "---\ntags: [甲]\n---\n\n正文 #甲 与 #甲/子\n"
        );

        // 非法移动：挂到自己 / 挂到自己的后代 / 空标签 / 已经在那里
        for (key, parent, reason) in [
            ("甲", "甲", "不能把标签挂到它自己下面"),
            (
                "甲",
                "甲/子",
                "不能把标签挂到它自己的子标签下面（会造出改不完的层级）",
            ),
            ("   ", "父", "标签名称为空，无法调整层级"),
            ("甲", "", "它已经在那个父标签下面了"),
        ] {
            let error = tag_move_in(&state, key, parent, true, false).unwrap_err();
            assert_eq!(error.code, mn_core::ErrorCode::PathInvalid.as_str());
            assert!(error.message.contains(reason), "{key}: {error}");
        }

        // **目标键已被占用 = 合并**：拒绝，并把人引到「重命名」那条路（绝不静默并掉）
        let (dir2, state2) =
            state_with(&[("乙.md", "# 乙\n\n#乙\n"), ("丁.md", "# 丁\n\n#父/乙\n")]);
        let error = tag_move_in(&state2, "乙", "父", true, false).unwrap_err();
        assert_eq!(error.code, mn_core::ErrorCode::PathInvalid.as_str());
        assert!(error.message.contains("已经是一个标签了"), "{error}");
        assert_eq!(
            read_file(dir2.path(), "乙.md"),
            "# 乙\n\n#乙\n",
            "被拒时一个字节都不改"
        );
        // 同一篇同时有 `乙` 与 `父/乙` 时也一样（判据是"目标键存在"，与哪一篇无关）
        assert_eq!(read_file(dir2.path(), "丁.md"), "# 丁\n\n#父/乙\n");
    }

    /// 预演（`dry_run`）只算不写：与真正执行时的候选集**同源**。
    #[test]
    fn tag_move_preview_does_not_touch_disk() {
        let (dir, state) = state_with(&[("甲.md", "---\ntags: [甲]\n---\n\n正文 #甲\n")]);
        let outcome = tag_move_in(&state, "甲", "父", true, true).unwrap();
        assert!(outcome.dry_run);
        assert_eq!(outcome.to, "父/甲");
        assert_eq!(outcome.candidates, 1, "预演也要如实说出会影响几篇");
        assert_eq!(
            read_file(dir.path(), "甲.md"),
            "---\ntags: [甲]\n---\n\n正文 #甲\n",
            "预演不落盘"
        );

        // 预演之后再执行：候选集与结果一致（同一条判定）
        let applied = tag_move_in(&state, "甲", "父", true, false).unwrap();
        assert_eq!(applied.to, outcome.to);
        assert_eq!(applied.candidates, outcome.candidates);
        assert!(read_file(dir.path(), "甲.md").contains("tags: [父/甲]"));
    }

    // -- 标签组合过滤（tag_filter）---------------------------------------------

    /// 组合过滤的契约：并集、排除、层级、以及"共 N 篇"的口径。
    #[test]
    fn tag_filter_combines_any_none_and_children() {
        let (_dir, state) = state_with(&[
            ("项目/甲.md", "# 甲\n\n#项目 #项目/前端\n"),
            ("项目/乙.md", "# 乙\n\n#项目/后端\n"),
            ("归档/旧.md", "# 旧\n\n#归档 #项目\n"),
            ("其它.md", "# 其它\n\n#其它\n"),
            ("无标签.md", "# 没有标签\n"),
        ]);

        // 含 项目（严格等于）：只有那两篇同时写了 `#项目` 的
        let strict = tag_filter_in(&state, &["项目".into()], &[], false);
        assert_eq!(
            strict.paths,
            vec!["归档/旧.md".to_string(), "项目/甲.md".into()]
        );
        assert_eq!(strict.matched, 2);
        assert_eq!(strict.tagged, 4, "有标签的笔记共 4 篇（无标签那篇不算）");

        // 含 项目 的后代（界面上「含子标签」默认开的那一档）
        let with_children = tag_filter_in(&state, &["项目".into()], &[], true);
        assert_eq!(with_children.matched, 3, "`#项目/后端` 也要算进来");

        // 有 项目 且**没有** 归档 —— 本轮新增的那一类查询
        let excluded = tag_filter_in(&state, &["项目".into()], &["归档".into()], true);
        assert_eq!(
            excluded.paths,
            vec!["项目/乙.md".to_string(), "项目/甲.md".into()]
        );

        // `any` 为空 = 全部有标签的笔记；只排除（"没有归档的笔记"）
        let all = tag_filter_in(&state, &[], &[], false);
        assert_eq!(all.matched, 4);
        let without_archive = tag_filter_in(&state, &[], &["归档".into()], false);
        assert_eq!(without_archive.matched, 3);

        // 空串与纯 `#` 忽略（不是"匹配所有"）
        let ignored = tag_filter_in(&state, &["".into(), "#".into()], &[], false);
        assert_eq!(ignored.matched, 4, "空键被忽略 → 等价于 any 为空");

        // 原始写法（大小写、带 `#`）与归一化键同一把尺子
        let raw = tag_filter_in(&state, &["#项目".into()], &[], false);
        assert_eq!(raw.matched, strict.matched);
    }
}
