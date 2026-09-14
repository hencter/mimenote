//! 整库导出静态站点：**宿主侧的三条命令**（出计划 / 落盘页面 / 复制图片）。
//!
//! 这一层只做"计划 → 校验 → 原子写"，正文一个字都不生成：Markdown → HTML 的唯一管线在前端
//! （`domain/markdown.ts` 的 `renderMarkdown` + DOMPurify）。宿主侧再引一个渲染器就等于
//! 让语法口径与 XSS 防线同时分叉，而这两样东西分叉之后**没有任何一处能发现**。
//! 因此本章程里的 HTML 一律当成"前端渲染好的字符串"搬运。
//!
//! # 这个模块存在的理由：所有策略校验都写在这里
//!
//! ## 1. 输出目录必须在 Vault 之外（[`ensure_outside_vault`]）
//!
//! 在 Vault 内、等于 Vault 根、或在 `<Vault>/.mimenote` 之下 → `PATH_INVALID`。
//! 理由不是洁癖：导出会往目标目录**写上千个文件**（真实 Vault 是几千篇），而 Vault 里的一次
//! 外部改动会触发应用重扫 —— 重扫风暴、文件树被整站灌满、以及用户很可能把 Vault 放在
//! 同步盘里（作者的库就在 Nutstore 里，4267 篇）：那意味着每次导出都会把上百 MB 的产物
//! 上传一遍。这三件事没有一件是"用户想要的结果"，所以宁可在最前面拦住并说清楚。
//!
//! ## 2. 覆盖策略：只认自己的标记文件，且**从不删除任何文件**
//!
//! * 目录不存在 → 建（[`SiteWriteOutcome::created_dirs`] 如实报出建了哪些）；
//! * 存在且是空目录 → 直接用；
//! * 存在、非空 → 必须有我们上次写的 [`SITE_MARKER_FILE`]，否则 `ALREADY_EXISTS`。
//!   用户很可能随手选了一个装着自己东西的目录（`C:\Users\me\Documents`），
//!   "写进去"之前必须先证明这个目录是我们的；
//! * **从不删除任何文件**（与 ADR-0018 同一条底线）：上次导出过、这次没有的文件留在原处，
//!   由前端拿 `previous.files` 与新清单比对后在界面上如实汇报。删掉"看起来多余"的文件
//!   是这个功能里最容易造成不可逆损失的一步 —— 我们无法区分"上次导出的残留"和
//!   "用户自己放进来的东西"。
//!
//! 第二条在 [`export_site_write_pages`] / [`export_site_copy_assets`] 里被放宽成
//! **"绝不覆盖一个无法证明属于我们的已存在文件"**：标记文件按契约是**最后**一批才写的，
//! 而几千篇的 Vault 必然要分批写（单批 256 个文件），严格执行"非空必须有标记"会让
//! **第二批开始全部失败**。于是"这个目录能不能用"这个判定落在 [`export_site_plan`]
//! （前端一定会先调它，否则它没有页面可以渲染），写命令只保证"要写的那个文件如果已经存在，
//! 就必须有我们的标记"。这条偏离与契约的字面表述不同，所以写在这里而不是悄悄实现：
//! 它的代价是"上一次导出中途失败、目录里没有标记"时重试会被拒（用户需要换一个空目录），
//! 收益是"绝不覆盖别人的 `index.html`"这条底线无论如何都成立。
//!
//! ## 3. 站内路径逐段校验（复用 `path_guard`）
//!
//! 每个 [`SiteFile::rel_path`] 与每个资源落点都要过 `mn_core::path_guard::validate_relative_path`：
//! 空段、`.`、`..`、绝对路径、盘符、`:`（NTFS 备用数据流 `a.html:ads`）、Windows 保留设备名
//! （`CON`/`PRN`/`NUL`/`COM1..9`/`LPT1..9`，含带扩展名的写法）、控制字符、结尾的点或空格
//! 全部拒绝。**不在这里另写一份**：Vault 那套判定已经把这些情形逐条测试过了，
//! 复制一份出来只会让两份逐渐分家（总有一份先被修补），而漏掉的那一份就是一条写入路径。
//!
//! ## 4. 绝不写到输出目录之外，且顺序是**校验 → 建目录 → 再校验 → 原子写**
//!
//! 落点一律经 `mn_core::path_guard::resolve_under`（词法检查 + 逐级符号链接检查）。
//! 顺序是硬性的：先建目录再校验，等于让一个**预先存在**的符号链接决定落点
//! （`link` → `..\..\evil`，`create_dir_all` 会跟着它把目录建到外面去）。
//! 目录建好之后再校验一次：此时父目录真实存在，可以做一次真正的 `canonicalize` 比对。
//!
//! ## 5. 不做整目录 staging
//!
//! "先写进临时目录，最后整体换上去"在 Windows 上行不通：无法原子覆盖一个**已存在**的目录，
//! 而"先删后换"等于对我们不该删的东西动手（见第 2 条）。所以逐文件原子写（ADR-0004）：
//! 中断留下的是一个"部分但自洽"的站点 —— 每个文件都是完整的，而 `index.html` 与标记文件
//! 是最后一批写的，所以不会有任何东西自称"导出完成"。
//!
//! ## 6. 部分失败如实汇报
//!
//! 单张图复制失败、单篇笔记读失败都进 `skipped` 并继续：几千篇的导出不能因为一篇坏笔记
//! （被删、非 UTF-8、超过上限）而白跑。**跳过原因是稳定值**（[`SiteSkipReason`]），
//! 前端按它分组给出人话，而不是去解析 `message`。

use std::collections::BTreeSet;
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

// 入参 DTO 要 `Deserialize`：它们从 IPC 报文里读出来（出参只需要 `Serialize`）。
// 一律 `#[serde(rename_all = "camelCase")]` + 一条"JSON 键名就是前端契约"的测试。

use serde::{Deserialize, Serialize};
use tauri::State;

use mn_core::atomic::{write_atomic, TEMP_PREFIX};
use mn_core::path_guard::{display_path, resolve_under, validate_relative_path};
use mn_core::site::{SITE_ASSET_DIR, SITE_MARKER_FILE};
use mn_core::{Error, VaultRoot};
use mn_index::site::{plan_site, SiteMarker, SitePlan, SITE_TOOL_ID};

use crate::assets::is_allowed_image;
use crate::error::IpcError;
use crate::indexer::{self, IndexPhase};
use crate::state::AppState;

/// 允许写出的站内文件扩展名（小写比较）。
///
/// 白名单而不是黑名单：这条命令的入参是"相对路径 + 内容"，放行任意扩展名就等于给前端开了
/// 一个**在用户选定目录里写任意文件**的后门（`.exe`、`.bat`、`autorun.inf`…）。
/// 收窄成这三种之后，它的能力面就是"写一个静态站点"。
const SITE_FILE_EXTENSIONS: &[&str] = &["html", "css", "json"];

/// 单批文件数上限。
///
/// 为什么有上限：一次 IPC 的报文体积必须有硬边界（前端把整批内容当 JSON 发过来）。
/// 几千篇的 Vault 分多批写即可 —— 批内顺序是数组顺序，批与批之间没有顺序要求，
/// 除了"`index.html` 与标记文件在最后一批"这一条由前端保证。
const MAX_SITE_FILES: usize = 256;

/// 单个站内文件的上限（32 MiB）。
///
/// 与 `export.rs` 同一个数量级，理由也一样：即使扩展名被限死，也不该允许一次写入把磁盘写满。
/// 一篇几千字的笔记渲染出来是几十 KB，32 MiB 已经是"这不是一篇笔记"的量级。
const MAX_SITE_FILE_BYTES: usize = 32 * 1024 * 1024;

/// 一批站内文件的总量上限（32 MiB）。
const MAX_SITE_BATCH_BYTES: usize = 32 * 1024 * 1024;

/// 单次复制的图片张数上限。
///
/// 超出的部分进 `skipped`（`reason: too-large`）而**不报错**。理由：前端把整库图片一次性发过来
/// （它没有分批），报错会让一次"页面全都写好了、只差图片"的导出被报成失败 —— 而用户对此
/// 无能为力。如实汇报 + 继续，至少站点是完整的（少几张图），而且用户能看到"有 N 张没复制"。
/// 真正的出路在前端分批调用（每次 ≤ 这个数），那时这个上限就永远不会被碰到。
const MAX_ASSETS: usize = 512;

/// 单张图片的上限（64 MiB）。
///
/// 图片是**二进制原样搬运**，比 HTML 大得多是正常的（相机原图几十 MB）。上限的作用是
/// "一张图不该让整批失败"：超过它的那张进 `skipped`，其余照常 —— 与笔记读失败同一条纪律。
const MAX_ASSET_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// 单次复制的图片总量上限（256 MiB）。
///
/// 与张数上限是两道独立的闸门：张数挡"几千张小图"，字节挡"几十张大图"。
/// 累计超过它时**剩下的**进 `skipped`（已复制好的如实汇报），而不是整批报错：
/// 报错会让已经落盘的那些失去汇报（前端只能显示"导出失败"，而磁盘上确实多了一百张图）。
const MAX_ASSET_BATCH_BYTES: u64 = 256 * 1024 * 1024;

/// 输出目录落在 Vault 里时的说明（面向人，提到用户真正会在意的那三件事）。
const REASON_INSIDE_VAULT: &str = "导出会往目标目录写上千个文件，而这个目录就在 Vault 里：\
Vault 里的一次改动就会触发应用重扫，文件树会被整站灌满，同步盘还会把它们全部上传一遍。\
请换一个 Vault 之外的目录（例如桌面，或另一个盘）。";

/// 输出目录正好是 Vault 根目录时的说明。
const REASON_IS_VAULT_ROOT: &str =
    "导出目录不能就是 Vault 根目录本身：整站会与你的笔记混在同一个目录里，\
应用会把它们当成外部改动重扫一遍。请换一个 Vault 之外的目录。";

/// 输出目录在 `<Vault>/.mimenote` 之下时的说明。
const REASON_UNDER_META: &str = "导出目录不能放在 Vault 的管理目录 `.mimenote` 之下：\
那是应用自己的缓存与回收站，写进去会被当成需要重扫的外部改动，还可能覆盖正在用的文件。\
请换一个 Vault 之外的目录。";

// ---------------------------------------------------------------------------
// DTO（字段名与嵌套都是 IPC 契约，`src/ipc/types.ts` 手工镜像）
// ---------------------------------------------------------------------------

/// 一个准备写出的站内文件（契约 `SiteFile`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteFile {
    /// 站内相对路径（POSIX），如 `index.html`、`项目/设计.html`、`assets/site.css`。
    pub rel_path: String,
    /// 完整内容（HTML / CSS / JSON；正文由前端渲染）。
    pub text: String,
}

/// 落盘结果（契约 `SiteWriteOutcome`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteWriteOutcome {
    /// 规范化后的输出目录绝对路径（回显，前端直接显示给用户）。
    pub output_dir: String,
    /// 本次写入的文件数。
    pub files: usize,
    /// 本次写入的总字节数。
    pub bytes: u64,
    /// 实际写入耗时（毫秒，含 fsync）。
    pub written_in_ms: u64,
    /// 本次**新建**的目录（站内相对路径，自浅到深，已去重）。
    ///
    /// 输出目录本身不在其中：它没有"站内相对路径"（它**就是**那个根），
    /// 而前端已经拿到了它的绝对路径（[`SiteWriteOutcome::output_dir`]）。
    pub created_dirs: Vec<String>,
}

/// 一张要复制的图片（契约 `SiteAssetInput`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteAssetInput {
    /// 图片在 Vault 里的相对路径（POSIX），如 `附件/图.png`。
    pub vault_rel_path: String,
}

/// 复制图片的结果（契约 `SiteAssetOutcome`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteAssetOutcome {
    /// 成功复制的张数。
    pub copied: usize,
    /// 成功复制的总字节数（源文件的字节数）。
    pub bytes: u64,
    /// 本次新建的目录（站内相对路径，自浅到深）—— 多数是 `assets/` 之下那几层。
    pub created_dirs: Vec<String>,
    /// 被跳过的图片 + 原因（按输入顺序）。
    pub skipped: Vec<SiteSkip>,
}

/// 一条被跳过的条目（契约 `SiteSkip`；`notes_read_batch` 与 `copy_assets` 共用）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteSkip {
    /// 出问题的那一条（笔记的 Vault 相对路径 / 图片的 Vault 相对路径）。
    pub rel_path: String,
    /// 稳定原因（前端按它分组给出人话）。
    pub reason: SiteSkipReason,
    /// 面向用户的一句话（宿主侧的**真实**原因，例如"读取失败：文件不存在"）。
    pub message: String,
}

impl SiteSkip {
    /// 组装一条跳过记录。
    pub(crate) fn new(
        rel_path: impl Into<String>,
        reason: SiteSkipReason,
        message: impl Into<String>,
    ) -> Self {
        Self {
            rel_path: rel_path.into(),
            reason,
            message: message.into(),
        }
    }
}

/// 一条条目被跳过的稳定原因。
///
/// 与 `TagSkipReason` 同一姿态：**这不是错误码**（一次操作会碰几百个文件，每个各自的处境不同），
/// 而是"这一次它为什么没成功"的分组键。前端的 `notes_read_batch` 分支只认前四个。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SiteSkipReason {
    /// 目标不存在（已被删除、路径写错）。
    NotFound,
    /// 读不到（权限、被占用、不是文件、目录、系统错误）。
    Unreadable,
    /// 内容不是合法 UTF-8（只可能来自笔记；图片是二进制，不解释内容）。
    NotUtf8,
    /// 超过大小上限（单篇 64 MiB / 单张图 64 MiB / 整批累计）。
    TooLarge,
    /// 扩展名不在允许的名单里（图片复制专用；笔记侧不会出现）。
    UnsupportedType,
    /// 路径越界或非法（`..`、绝对路径、符号链接逃出 Vault、Windows 保留名……）。
    PathEscape,
    /// 源读到了，但**写目标**失败（磁盘满、只读、被占用）——与"读不到"不是一回事，
    /// 用户要做的事也不同（前者重试，后者查磁盘），所以分开报（与 `TagSkipReason::WriteFailed` 同理）。
    WriteFailed,
}

impl SiteSkipReason {
    /// 由一次读取失败的错误分类。
    ///
    /// `notes_read_batch` 与图片复制共用这一处映射：同一类错误在两条命令上给出不同的原因字符串
    /// 会让前端的分支多出一份影子规则，而"哪一类错误该显示什么话"本该只有一处判断。
    pub(crate) fn from_read_error(error: &Error) -> Self {
        match error {
            Error::NotFound(_) => Self::NotFound,
            Error::NotUtf8(_) => Self::NotUtf8,
            Error::TooLarge(_) => Self::TooLarge,
            Error::PathEscape(_) | Error::PathInvalid { .. } => Self::PathEscape,
            _ => Self::Unreadable,
        }
    }

    /// 由一次写入失败的错误分类。
    fn from_write_error(error: &Error) -> Self {
        match error {
            Error::PathEscape(_) | Error::PathInvalid { .. } => Self::PathEscape,
            Error::AlreadyExists(_) => Self::WriteFailed,
            _ => Self::WriteFailed,
        }
    }
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/// 出导出计划：页面清单 + 每页的双链/标签/反链 + 概况（**不写任何文件**）。
///
/// `output_dir` 为空（前端第一次调用）时**不做任何 IO**、`previous` 为 `null`；
/// 传了就按模块文档第 1、2 条校验目标目录，并把标记文件里的"上次导出"读出来。
///
/// 索引未就绪 → `INDEX_NOT_READY`（而不是 `IO`：真实情况是"索引还在构建"，
/// 前端 `describeError()` 会把 `IO` 翻成"磁盘读写失败"，那句话是错的）。
#[tauri::command]
pub async fn export_site_plan(
    state: State<'_, Arc<AppState>>,
    output_dir: Option<String>,
) -> Result<SitePlan, IpcError> {
    let app = Arc::clone(state.inner());
    // 计划要遍历全库索引（几千篇的解析结果），按 ADR-0003 放到阻塞线程上
    tauri::async_runtime::spawn_blocking(move || plan_site_in(&app, output_dir.as_deref()))
        .await
        .map_err(|error| IpcError::internal(format!("导出计划任务失败：{error}")))?
}

/// [`export_site_plan`] 的主体（与 Tauri 无关，可单测）。
fn plan_site_in(state: &AppState, output_dir: Option<&str>) -> Result<SitePlan, IpcError> {
    let root = state.vault_root()?;

    // 索引是计划里一切东西的来源（页面清单、双链解析、标签、反链）。没就绪时返回空计划
    // 会让用户以为"导出成功但一篇都没有"，那是**错的信息**；等一下再来才是对的。
    if indexer::status(state).phase != IndexPhase::Ready {
        return Err(IpcError::index_not_ready(
            "链接索引正在构建，导出计划要等它建好才能算出页面路径与双链；请稍后重试。",
        ));
    }

    let (echo, previous) = match output_dir {
        None => (None, None),
        Some(raw) => {
            let dir = resolve_output_dir(state, raw)?;
            // 计划的这一次校验就是"这个目录能不能写"的**唯一**权威判定：
            // 目录不存在/为空 → 可以用（previous 没有）；非空 → 必须有我们的标记，
            // 否则 `ALREADY_EXISTS`（用户在写之前就知道选错了目录，而不是写了一半才发现）
            match inspect_output_dir(&dir)? {
                OutputDirState::Ours(previous) => (Some(display_path(&dir)), Some(previous)),
                OutputDirState::Missing | OutputDirState::Empty => (Some(display_path(&dir)), None),
            }
        }
    };

    let plan = plan_site(&state.index_write());
    log::info!(
        "导出计划：{} 篇 / {} 页 / {} 条链接（悬空 {}）/ 改名 {}（输出目录 {}）",
        plan.stats.notes,
        plan.stats.pages,
        plan.stats.links,
        plan.stats.dangling,
        plan.stats.renamed.len(),
        echo.as_deref().unwrap_or("未指定")
    );

    // vault_name / output_dir / previous 只有宿主知道（见 `mn_index::site` 的模块文档）
    Ok(SitePlan {
        vault_name: root.name(),
        output_dir: echo,
        previous,
        ..plan
    })
}

/// 把前端渲染好的页面批量落盘（**批内按数组顺序写**：前端依赖这一点把 `index.html`
/// 与标记文件放在最后一批）。
#[tauri::command]
pub async fn export_site_write_pages(
    state: State<'_, Arc<AppState>>,
    output_dir: String,
    files: Vec<SiteFile>,
) -> Result<SiteWriteOutcome, IpcError> {
    let app = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || write_pages_command(&app, &output_dir, &files))
        .await
        .map_err(|error| IpcError::internal(format!("导出落盘任务失败：{error}")))?
}

/// [`export_site_write_pages`] 的主体（与 Tauri 无关，可单测）。
fn write_pages_command(
    state: &AppState,
    output_dir: &str,
    files: &[SiteFile],
) -> Result<SiteWriteOutcome, IpcError> {
    let dir = resolve_output_dir(state, output_dir)?;
    let outcome = write_pages_in(&dir, files)?;
    log::info!(
        "导出落盘：{} 个文件 / {} 字节（新建目录 {}，耗时 {}ms）→ {}",
        outcome.files,
        outcome.bytes,
        outcome.created_dirs.len(),
        outcome.written_in_ms,
        outcome.output_dir
    );
    Ok(outcome)
}

/// 把 Vault 里的图片复制进 `<输出目录>/assets/<原 Vault 相对路径>`。
///
/// 清单由**前端渲染时收集**（见 `mn_index::site` 的模块文档：Rust 侧没有第二份图片解析规则）。
/// 这里只做"逐个校验路径 → 原子复制 → 如实汇报跳过"。
#[tauri::command]
pub async fn export_site_copy_assets(
    state: State<'_, Arc<AppState>>,
    output_dir: String,
    assets: Vec<SiteAssetInput>,
) -> Result<SiteAssetOutcome, IpcError> {
    let app = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || copy_assets_command(&app, &output_dir, &assets))
        .await
        .map_err(|error| IpcError::internal(format!("导出图片任务失败：{error}")))?
}

/// [`export_site_copy_assets`] 的主体（与 Tauri 无关，可单测）。
fn copy_assets_command(
    state: &AppState,
    output_dir: &str,
    assets: &[SiteAssetInput],
) -> Result<SiteAssetOutcome, IpcError> {
    let root = state.vault_root()?;
    let dir = resolve_output_dir(state, output_dir)?;
    let outcome = copy_assets_in(&root, &dir, assets)?;
    log::info!(
        "导出图片：复制 {} 张 / {} 字节（跳过 {} 张，新建目录 {}）",
        outcome.copied,
        outcome.bytes,
        outcome.skipped.len(),
        outcome.created_dirs.len()
    );
    Ok(outcome)
}

// ---------------------------------------------------------------------------
// 输出目录的校验（三条命令共用同一套）
// ---------------------------------------------------------------------------

/// 校验并规范化输出目录：绝对化 → Vault 之外。任一条不过就返回错误。
fn resolve_output_dir(state: &AppState, raw: &str) -> Result<PathBuf, IpcError> {
    let root = state.vault_root()?;
    let dir = normalize_output_dir(raw)?;
    ensure_outside_vault(&root, &dir)?;
    Ok(dir)
}

/// 把用户给的目录字符串规范化成绝对路径（**不要求它已经存在**）。
///
/// 做法：找出最深的**已存在**祖先并 `canonicalize` 它，再把剩下那几段（它们还不存在，
/// 所以不可能藏着符号链接）接回去。这样做的意义在于"在不在 Vault 里"这条判定：
/// 拿用户字符串前缀去比会漏掉两种写法 —— 符号链接（`C:\link` 指向 Vault）与
/// `C:\Users\me\Vault\..\Vault\导出`（词法上看着在外面，实际就在里面）。
fn normalize_output_dir(raw: &str) -> mn_core::Result<PathBuf> {
    if raw.trim().is_empty() {
        return Err(Error::invalid(raw, "导出目录为空"));
    }
    let input = PathBuf::from(raw);
    let absolute = if input.is_absolute() {
        input
    } else {
        std::env::current_dir()
            .map_err(|error| Error::io(raw, error))?
            .join(input)
    };

    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cursor = absolute;
    let base = loop {
        if let Ok(real) = cursor.canonicalize() {
            break real;
        }
        let Some(name) = cursor.file_name().map(|name| name.to_os_string()) else {
            return Err(Error::invalid(raw, "导出目录无法解析为绝对路径"));
        };
        tail.push(name);
        match cursor.parent() {
            Some(parent) => cursor = parent.to_path_buf(),
            None => return Err(Error::invalid(raw, "导出目录无法解析为绝对路径")),
        }
    };

    let mut normalized = base;
    // `tail` 是自深到浅压进去的，接回去要反过来
    for segment in tail.iter().rev() {
        match segment.to_str() {
            Some(".") => continue,
            Some("..") => {
                // 已经在 `base` 里被 canonicalize 过的那几级不存在符号链接问题，
                // 折叠 `..` 因此是安全的（不折叠的话 `C:\库\..\库\导出` 会绕过下面那条判定）
                if !normalized.pop() {
                    return Err(Error::invalid(raw, "导出目录越出了根目录"));
                }
            }
            _ => normalized.push(segment),
        }
    }
    Ok(normalized)
}

/// 输出目录必须在 Vault 之外（理由见模块文档第 1 条）。
fn ensure_outside_vault(root: &VaultRoot, dir: &Path) -> mn_core::Result<()> {
    let vault = root.path();
    if dir == vault {
        return Err(Error::invalid(display_path(dir), REASON_IS_VAULT_ROOT));
    }
    if !dir.starts_with(vault) {
        return Ok(());
    }

    // `<Vault>/.mimenote` 之下单独给一句话：那是应用自己的缓存与回收站目录，
    // 写进去除了同样触发重扫，还会污染管理目录本身
    let under_meta = matches!(
        dir.strip_prefix(vault).ok().and_then(|rest| rest.components().next()),
        Some(Component::Normal(name)) if name.eq_ignore_ascii_case(".mimenote")
    );
    Err(Error::invalid(
        display_path(dir),
        if under_meta {
            REASON_UNDER_META
        } else {
            REASON_INSIDE_VAULT
        },
    ))
}

/// 目标目录现在的状态（见模块文档第 2 条）。
#[derive(Debug, Clone, PartialEq, Eq)]
enum OutputDirState {
    /// 目录不存在（写的时候会建）。
    Missing,
    /// 存在且是空目录（可以直接用）。
    Empty,
    /// 存在、非空、且有我们上次写的标记 —— 这是我们自己的目录。
    Ours(mn_index::site::SitePreviousExport),
}

/// 标记文件的读取结果。
#[derive(Debug, Clone, PartialEq, Eq)]
enum MarkerReading {
    /// 没有这个文件。
    Missing,
    /// 有，但读不出来或不是我们的（附一句面向用户的说明）。
    Broken(String),
    /// 是我们写的。
    Ours(SiteMarker),
}

/// 判定（必要时报错）一个目标目录能不能作为导出目录。
///
/// 这是**计划命令**的权威判定（见模块文档第 2 条：写命令用的是更宽松的"不覆盖别人的文件"）。
fn inspect_output_dir(dir: &Path) -> mn_core::Result<OutputDirState> {
    match fs::symlink_metadata(dir) {
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(OutputDirState::Missing),
        Err(error) => return Err(Error::io(dir, error)),
        Ok(meta) => {
            if !meta.is_dir() {
                return Err(Error::NotADirectory(display_path(dir)));
            }
        }
    }

    if is_effectively_empty(dir)? {
        return Ok(OutputDirState::Empty);
    }

    match read_marker(dir)? {
        MarkerReading::Ours(marker) => Ok(OutputDirState::Ours(marker.previous())),
        MarkerReading::Missing => Err(Error::AlreadyExists(format!(
            "{}（目录非空，但没有我们上次导出的标记文件 {SITE_MARKER_FILE}；\
             导出的东西从不删除，所以这里可能是别人的目录，请换一个空目录）",
            display_path(dir)
        ))),
        MarkerReading::Broken(detail) => Err(Error::AlreadyExists(format!(
            "{}（标记文件 {SITE_MARKER_FILE} 不可用：{detail}）",
            display_path(dir)
        ))),
    }
}

/// 目录是不是"事实上空的"。
///
/// 原子写留下的 `.mimenote-*.tmp` 不计入：那是**我们自己**在崩溃/断电时留下的半截临时文件
/// （ADR-0004），把它算成"非空"会让用户第二次导出时收到一句"这个目录不是空的"，
/// 而那句话描述的是我们自己的垃圾。我们从不删它们（见模块文档第 2 条），只是不当回事。
fn is_effectively_empty(dir: &Path) -> mn_core::Result<bool> {
    let entries = fs::read_dir(dir).map_err(|error| Error::io(dir, error))?;
    for entry in entries {
        let entry = entry.map_err(|error| Error::io(dir, error))?;
        if !entry.file_name().to_string_lossy().starts_with(TEMP_PREFIX) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// 读标记文件（不存在的读法是**正常**的：第一次导出就是没有标记）。
fn read_marker(dir: &Path) -> mn_core::Result<MarkerReading> {
    let path = dir.join(SITE_MARKER_FILE);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(MarkerReading::Missing),
        Err(error) => return Ok(MarkerReading::Broken(error.to_string())),
    };
    match serde_json::from_str::<SiteMarker>(&text) {
        Ok(marker) if marker.is_ours() => Ok(MarkerReading::Ours(marker)),
        // `tool` 不是 `mimenote` = 别人的文件恰好叫这个名字（或用户手改过）：
        // 一律当成"不是我们的"，绝不因为文件名对上就覆盖
        Ok(marker) => Ok(MarkerReading::Broken(format!(
            "tool 是 {:?}，不是 {SITE_TOOL_ID}",
            marker.tool
        ))),
        Err(error) => Ok(MarkerReading::Broken(error.to_string())),
    }
}

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

/// 批内形状校验：路径合法 + 扩展名白名单 + 大小上限。
///
/// 整批**先判完再写**：写了一半才发现第 200 个文件超限，会留下一个"看起来写完了"的目录
/// （而它的标记文件还在最后一批里，根本不会写出），排查成本远高于提前拒绝。
fn ensure_site_batch(files: &[SiteFile]) -> mn_core::Result<()> {
    if files.len() > MAX_SITE_FILES {
        return Err(Error::TooLarge(format!(
            "一批最多写 {MAX_SITE_FILES} 个文件（本批 {} 个）",
            files.len()
        )));
    }

    let mut total = 0usize;
    for file in files {
        ensure_site_file_path(&file.rel_path)?;
        if file.text.len() > MAX_SITE_FILE_BYTES {
            return Err(Error::TooLarge(format!(
                "{}：{} 字节 > 单文件上限 {MAX_SITE_FILE_BYTES} 字节",
                file.rel_path,
                file.text.len()
            )));
        }
        total += file.text.len();
    }
    if total > MAX_SITE_BATCH_BYTES {
        return Err(Error::TooLarge(format!(
            "一批最多写 {MAX_SITE_BATCH_BYTES} 字节（本批 {total} 字节）"
        )));
    }
    Ok(())
}

/// 单个站内文件的路径校验：段级校验（复用 `path_guard`）+ 扩展名白名单。
fn ensure_site_file_path(rel_path: &str) -> mn_core::Result<()> {
    ensure_site_rel_path(rel_path)?;

    let extension = rel_path
        .rsplit('/')
        .next()
        .unwrap_or(rel_path)
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    if !SITE_FILE_EXTENSIONS.contains(&extension.as_str()) {
        return Err(Error::invalid(
            rel_path,
            format!(
                "导出只允许写 {} 文件",
                SITE_FILE_EXTENSIONS
                    .iter()
                    .map(|extension| format!(".{extension}"))
                    .collect::<Vec<_>>()
                    .join(" / ")
            ),
        ));
    }
    Ok(())
}

/// 站内相对路径的**段级**校验（不含扩展名白名单）。
///
/// 图片落点（`assets/附件/图.png`）也走它：那类路径的"允许什么类型"由**另一份**名单回答
/// （[`is_allowed_image`]，与前端 `domain/assets.ts` 对齐），在这里再套一层页面扩展名白名单
/// 会把 `.png` 全部挡掉 —— 两处名单各有各的对象，不该混成一条。
fn ensure_site_rel_path(rel_path: &str) -> mn_core::Result<()> {
    // 空段、`.`、`..`、绝对路径、盘符、`:`（NTFS 备用数据流）、Windows 保留名、
    // 控制字符、结尾的点或空格 —— 全在这一步被拒（判定只有一份，见模块文档第 3 条）
    validate_relative_path(rel_path)?;
    Ok(())
}

/// [`export_site_write_pages`] 的落盘实现（与 Tauri 无关，可单测）。
fn write_pages_in(output_root: &Path, files: &[SiteFile]) -> mn_core::Result<SiteWriteOutcome> {
    ensure_site_batch(files)?;

    let started = Instant::now();
    let mut created: BTreeSet<(usize, String)> = BTreeSet::new();
    create_root_dir(output_root)?;
    let real_root = canonical_root(output_root)?;
    // 归属判定只做一次（本次调用**开始时**的目录状态）：批内后面的写入不会改变这个答案，
    // 而最后一批写出的标记文件也不该让同一批里更早的判断变卦
    let owned = matches!(read_marker(output_root)?, MarkerReading::Ours(_));

    let mut bytes = 0u64;
    for file in files {
        // ① 校验（词法 + 逐级符号链接，都在这一句里）
        let target = resolve_under(output_root, &file.rel_path)?;
        // ② 绝不覆盖无法证明属于我们的文件（见模块文档第 2 条）
        if fs::symlink_metadata(&target).is_ok() && !owned {
            return Err(Error::AlreadyExists(format!(
                "{}（这里已经有同名文件，而且没有我们上次导出的标记；\
                 如果这是上一次没写完的导出，请换一个空目录重来）",
                display_path(&target)
            )));
        }
        // ③ 建目录（逐级建、逐级记，父目录已存在就不动它）
        create_parent_dirs(output_root, &file.rel_path, &mut created)?;
        // ④ 再校验一次：目录此时真实存在，可以做真正的 canonicalize 比对
        let target = verify_target(output_root, &real_root, &file.rel_path)?;
        // ⑤ 原子写（同目录临时文件 → fsync → rename，ADR-0004）
        write_atomic(&target, file.text.as_bytes())?;
        bytes += file.text.len() as u64;
    }

    Ok(SiteWriteOutcome {
        output_dir: display_path(output_root),
        files: files.len(),
        bytes,
        written_in_ms: started.elapsed().as_millis() as u64,
        created_dirs: collect_created_dirs(&created),
    })
}

/// [`export_site_copy_assets`] 的复制实现（与 Tauri 无关，可单测）。
///
/// 三条上限（张数 / 单张字节 / 整批字节）**全部走 `skipped` 而不是报错**：图片是这次导出的
/// 一部分而不是全部，一次复制不完不该把已经写好的几千个页面一起判成失败（见各常量的说明）。
fn copy_assets_in(
    root: &VaultRoot,
    output_root: &Path,
    assets: &[SiteAssetInput],
) -> mn_core::Result<SiteAssetOutcome> {
    let mut created: BTreeSet<(usize, String)> = BTreeSet::new();
    create_root_dir(output_root)?;
    let real_root = canonical_root(output_root)?;
    let owned = matches!(read_marker(output_root)?, MarkerReading::Ours(_));

    let mut copied = 0usize;
    let mut bytes = 0u64;
    let mut skipped: Vec<SiteSkip> = Vec::new();
    // 累计字节到顶之后，剩下的不再尝试（`skipped` 里逐条如实说明），
    // 而不是整批报错把已经复制好的那些一起吞掉（见 MAX_ASSET_BATCH_BYTES 的说明）
    let mut exhausted = false;

    for (position, asset) in assets.iter().enumerate() {
        let rel = asset.vault_rel_path.replace('\\', "/");

        // ① 白名单：唯一一份图片扩展名判定（`assets.rs`，与前端 `domain/assets.ts` 对齐）
        if !is_allowed_image(&rel) {
            skipped.push(SiteSkip::new(
                &rel,
                SiteSkipReason::UnsupportedType,
                "只接受图片扩展名（png/jpg/jpeg/gif/webp/avif/bmp/svg/ico）",
            ));
            continue;
        }
        // ② 张数上限：超出的如实汇报（见 MAX_ASSETS 的说明）
        if position >= MAX_ASSETS {
            skipped.push(SiteSkip::new(
                &rel,
                SiteSkipReason::TooLarge,
                format!("一次最多复制 {MAX_ASSETS} 张图片，这一张没有复制"),
            ));
            continue;
        }
        if exhausted {
            skipped.push(SiteSkip::new(
                &rel,
                SiteSkipReason::TooLarge,
                format!("本批累计已达 {MAX_ASSET_BATCH_BYTES} 字节上限，这张没有复制"),
            ));
            continue;
        }

        // ③ 源路径校验（`resolve_existing`：段级校验 + 逐级符号链接 + 必须存在）
        let source = match root.resolve_existing(&rel) {
            Ok(source) => source,
            Err(error) => {
                skipped.push(SiteSkip::new(
                    &rel,
                    SiteSkipReason::from_read_error(&error),
                    error.to_string(),
                ));
                continue;
            }
        };
        let meta = match fs::metadata(&source) {
            Ok(meta) => meta,
            Err(error) => {
                // 先把面向人的那句话取出来，再把 `error` 搬进 `Error::io`（它要所有权）
                let message = error.to_string();
                skipped.push(SiteSkip::new(
                    &rel,
                    SiteSkipReason::from_read_error(&Error::io(&source, error)),
                    message,
                ));
                continue;
            }
        };
        if !meta.is_file() {
            skipped.push(SiteSkip::new(&rel, SiteSkipReason::Unreadable, "不是文件"));
            continue;
        }
        if meta.len() > MAX_ASSET_FILE_BYTES {
            skipped.push(SiteSkip::new(
                &rel,
                SiteSkipReason::TooLarge,
                format!("{} 字节 > 单张上限 {MAX_ASSET_FILE_BYTES} 字节", meta.len()),
            ));
            continue;
        }
        if bytes + meta.len() > MAX_ASSET_BATCH_BYTES {
            exhausted = true;
            skipped.push(SiteSkip::new(
                &rel,
                SiteSkipReason::TooLarge,
                format!("加上这张会超过本批 {MAX_ASSET_BATCH_BYTES} 字节上限，它没有复制"),
            ));
            continue;
        }

        // ④ 逐字节读源（图片是二进制，不解释内容：非 UTF-8 是**正常**的）
        let data = match fs::read(&source) {
            Ok(data) => data,
            Err(error) => {
                let message = error.to_string();
                skipped.push(SiteSkip::new(
                    &rel,
                    SiteSkipReason::from_read_error(&Error::io(&source, error)),
                    message,
                ));
                continue;
            }
        };

        // ⑤ 站内落点固定：`assets/<原 Vault 相对路径>`（保留"图在哪一类笔记旁边"这个信息）
        let dest_rel = format!("{SITE_ASSET_DIR}/{rel}");
        match write_asset(
            output_root,
            &real_root,
            &dest_rel,
            &data,
            &mut created,
            owned,
        ) {
            Ok(()) => {
                copied += 1;
                bytes += data.len() as u64;
            }
            Err(error) => skipped.push(SiteSkip::new(
                &rel,
                SiteSkipReason::from_write_error(&error),
                error.to_string(),
            )),
        }
    }

    Ok(SiteAssetOutcome {
        copied,
        bytes,
        created_dirs: collect_created_dirs(&created),
        skipped,
    })
}

/// 把一张图片原子地写到站内落点（复制要**原子**：写进同目录临时文件再 rename）。
///
/// 与页面走同一个 `write_atomic`：一张写了一半的图在浏览器里是一个坏图标，
/// 而它的字节数还留在磁盘上 —— 用户重试也无法区分"这次没复制"和"上次复制了一半"。
fn write_asset(
    output_root: &Path,
    real_root: &Path,
    dest_rel: &str,
    data: &[u8],
    created: &mut BTreeSet<(usize, String)>,
    owned: bool,
) -> mn_core::Result<()> {
    ensure_site_rel_path(dest_rel)?;
    let target = resolve_under(output_root, dest_rel)?;
    if fs::symlink_metadata(&target).is_ok() && !owned {
        return Err(Error::AlreadyExists(format!(
            "{}（这里已经有同名文件，而且没有我们上次导出的标记）",
            display_path(&target)
        )));
    }
    create_parent_dirs(output_root, dest_rel, created)?;
    let target = verify_target(output_root, real_root, dest_rel)?;
    write_atomic(&target, data)
}

/// 确保输出目录存在（它就是"站内相对路径"的根，因此**不进** `created_dirs`）。
fn create_root_dir(output_root: &Path) -> mn_core::Result<()> {
    match fs::symlink_metadata(output_root) {
        Ok(meta) => {
            if meta.is_dir() {
                Ok(())
            } else {
                Err(Error::NotADirectory(display_path(output_root)))
            }
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {
            fs::create_dir_all(output_root).map_err(|error| Error::io(output_root, error))
        }
        Err(error) => Err(Error::io(output_root, error)),
    }
}

/// 输出目录的**真实**路径（canonicalize 之后）。
///
/// 这一步在 `create_root_dir` 之后做，所以它一定成功：拿它去和"父目录的真实路径"比，
/// 才能回答"我要写的这个文件到底落在输出目录里面还是外面"（符号链接一解析就见分晓）。
fn canonical_root(output_root: &Path) -> mn_core::Result<PathBuf> {
    output_root
        .canonicalize()
        .map_err(|error| Error::io(output_root, error))
}

/// 逐级创建 `rel` 的父目录，并把**新建**的那些记下来（自浅到深，站内相对路径）。
///
/// 为什么逐级 `create_dir` 而不是一次 `create_dir_all`：`create_dir_all` 会**跟着符号链接**
/// 往里建（`link/sub` 而 `link` 指向外部时，它会在外面造出 `sub`）。逐级建 + 每级先
/// `symlink_metadata` 就不给这个行为任何机会，而且顺手拿到了 `created_dirs` 的准确清单
/// （与 `note_restore` 报"顺手建了 2 个目录"是同一个口径）。
fn create_parent_dirs(
    output_root: &Path,
    rel: &str,
    created: &mut BTreeSet<(usize, String)>,
) -> mn_core::Result<()> {
    let segments = validate_relative_path(rel)?;
    let mut accumulated = String::new();

    for segment in segments.iter().take(segments.len() - 1) {
        accumulated = if accumulated.is_empty() {
            segment.clone()
        } else {
            format!("{accumulated}/{segment}")
        };
        let dir = output_root.join(native_segments(&accumulated));
        match fs::symlink_metadata(&dir) {
            Ok(meta) => {
                // 符号链接交给后面的 `verify_target` 判（它可能指回输出目录之内，是合法的）
                if !meta.is_dir() && !meta.file_type().is_symlink() {
                    return Err(Error::NotADirectory(display_path(&dir)));
                }
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {
                fs::create_dir(&dir).map_err(|error| Error::io(&dir, error))?;
                created.insert((accumulated.matches('/').count() + 1, accumulated.clone()));
            }
            Err(error) => return Err(Error::io(&dir, error)),
        }
    }
    Ok(())
}

/// 落点的最终校验：再跑一次 `resolve_under`，并用真实路径确认父目录仍在输出目录之内。
///
/// 两次校验不是冗余：第一次发生在**建目录之前**（那时父目录可能还不存在，
/// `resolve_under` 只能检查已经存在的那几级），这一次发生在父目录真实存在之后，
/// `canonicalize` 会把任何一个符号链接解析到底 —— 这是"绝不写到输出目录之外"的最后一道闸门。
fn verify_target(output_root: &Path, real_root: &Path, rel: &str) -> mn_core::Result<PathBuf> {
    let target = resolve_under(output_root, rel)?;
    let parent = match target.parent() {
        Some(parent) => parent,
        None => return Err(Error::invalid(rel, "路径没有父目录")),
    };
    let real_parent = parent
        .canonicalize()
        .map_err(|error| Error::io(parent, error))?;
    if !real_parent.starts_with(real_root) {
        return Err(Error::PathEscape(display_path(parent)));
    }
    Ok(target)
}

/// 站内相对路径 → 本机路径（`/` → `MAIN_SEPARATOR_STR`）。
fn native_segments(rel: &str) -> String {
    rel.replace('/', std::path::MAIN_SEPARATOR_STR)
}

/// `created_dirs` 的出参形状：自浅到深，同层按路径排序（已去重）。
fn collect_created_dirs(created: &BTreeSet<(usize, String)>) -> Vec<String> {
    created.iter().map(|(_, dir)| dir.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    use mn_core::scanner::{scan, ScanOptions};
    use mn_core::ErrorCode;

    use crate::state::VaultCtx;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn file(rel_path: &str, text: &str) -> SiteFile {
        SiteFile {
            rel_path: rel_path.to_string(),
            text: text.to_string(),
        }
    }

    fn asset(vault_rel_path: &str) -> SiteAssetInput {
        SiteAssetInput {
            vault_rel_path: vault_rel_path.to_string(),
        }
    }

    fn read_at(dir: &Path, rel: &str) -> String {
        fs::read_to_string(dir.join(native_segments(rel))).unwrap()
    }

    fn exists(dir: &Path, rel: &str) -> bool {
        dir.join(native_segments(rel)).exists()
    }

    /// 一个干净的站内目录（已创建、已 canonicalize —— 与生产路径一致：
    /// "符号链接有没有逃出去"这条判定要求根是真实路径）。
    fn site_dir(parent: &Path) -> PathBuf {
        let dir = parent.join("站点");
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    /// 一个 Vault（只建文件，不建索引）。
    fn vault_with(files: &[(&str, &str)]) -> (tempfile::TempDir, VaultRoot) {
        let dir = tempfile::tempdir().unwrap();
        for (rel, text) in files {
            let path = dir.path().join(native_segments(rel));
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&path, text).unwrap();
        }
        let root = VaultRoot::open(dir.path()).unwrap();
        (dir, root)
    }

    /// 一个"已打开 Vault + 索引就绪"的应用状态（与 App 启动链路同形）。
    fn state_with(files: &[(&str, &str)]) -> (tempfile::TempDir, AppState) {
        let (dir, root) = vault_with(files);
        let options = ScanOptions::default();
        let report = scan(root.path(), &options).unwrap();
        let entries = report.entries.clone();
        let (index, _) = mn_index::build_index(
            root.path(),
            &entries,
            &mn_index::BuildOptions::default(),
            None,
            |_done, _total| {},
        );

        let state = AppState::default();
        state.set_vault(VaultCtx::new(root, options, report));
        *state.index_write() = index;
        state.set_index_status(indexer::IndexStatus {
            phase: IndexPhase::Ready,
            indexed: files.len(),
            total: files.len(),
            ..Default::default()
        });
        (dir, state)
    }

    /// 一份标记文件文本（形状见 `mn_index::site::SiteMarker`）。
    fn marker_text(tool: &str) -> String {
        let marker = SiteMarker {
            tool: tool.to_string(),
            version: 1,
            exported_at_ms: 1_700_000_000_000,
            vault_name: "我的库".to_string(),
            files: vec!["index.html".to_string()],
        };
        serde_json::to_string(&marker).unwrap()
    }

    fn write_marker(dir: &Path, tool: &str) {
        fs::write(dir.join(SITE_MARKER_FILE), marker_text(tool)).unwrap();
    }

    #[cfg(windows)]
    fn symlink_dir(target: &Path, link: &Path) -> bool {
        std::os::windows::fs::symlink_dir(target, link).is_ok()
    }

    #[cfg(unix)]
    fn symlink_dir(target: &Path, link: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).is_ok()
    }

    /// 建一个指向外部目录的链接，成功返回 `true`。
    ///
    /// 先试真符号链接；Windows 上没有开发者模式/管理员时它必然失败，于是退回**联接**
    /// （junction，`mklink /J`）—— 它不需要任何特权，而对 `symlink_metadata` 来说同样是
    /// 重解析点（`file_type().is_symlink()` 为真）、`canonicalize` 也一样会解析到真实目标。
    /// 于是"预先存在的链接会不会决定落点"这条判定在没有开发者模式的机器上也能真跑一遍，
    /// 而不是被跳过。两者都失败才跳过（**不把环境限制当成通过**）。
    fn make_dir_link(target: &Path, link: &Path) -> bool {
        if symlink_dir(target, link) {
            return true;
        }
        #[cfg(windows)]
        {
            std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .map(|output| output.status.success())
                .unwrap_or(false)
        }
        #[cfg(not(windows))]
        {
            false
        }
    }

    // -- 计划 ----------------------------------------------------------------

    #[test]
    fn plan_refuses_while_the_index_is_building() {
        let (_dir, state) = state_with(&[("甲.md", "正文\n")]);

        // 索引未就绪 → INDEX_NOT_READY（借 IO 会被前端翻成"磁盘读写失败：…"，那是错的）
        state.set_index_status(indexer::IndexStatus {
            phase: IndexPhase::Building,
            ..Default::default()
        });
        let error = plan_site_in(&state, None).unwrap_err();
        assert_eq!(error.code, "INDEX_NOT_READY");
        assert!(
            error.message.contains("正在构建"),
            "说明要能指导用户重试：{}",
            error.message
        );

        // 未打开 Vault 仍是既有错误码（新增一个码不该弄乱原来的分支）
        let closed = AppState::default();
        assert_eq!(
            plan_site_in(&closed, None).unwrap_err().code,
            "VAULT_NOT_SET"
        );
    }

    #[test]
    fn plan_echoes_the_output_dir_and_the_previous_export() {
        let (_dir, state) = state_with(&[
            ("项目/设计.md", "[[路线图]]\n"),
            ("项目/路线图.md", "正文\n"),
        ]);
        // 输出目录必须在 Vault **之外**（这是模块文档第 1 条），所以它有自己的临时目录
        let home = temp_dir();
        let out = site_dir(home.path());
        let out_str = out.to_string_lossy().to_string();
        let vault_name = state.with_vault(|ctx| Ok(ctx.root.name())).unwrap();

        // 没传输出目录 → 不做任何 IO、previous 为 null（前端第一次调用只要统计）
        let bare = plan_site_in(&state, None).unwrap();
        assert!(bare.output_dir.is_none() && bare.previous.is_none());
        assert_eq!(bare.vault_name, vault_name);
        assert_eq!(bare.pages.len(), 2);

        // 传了空目录 → 回显规范化后的绝对路径，仍然没有"上次导出"
        let first = plan_site_in(&state, Some(out_str.as_str())).unwrap();
        assert_eq!(
            first.output_dir.as_deref(),
            Some(display_path(&out).as_str()),
            "必须回显规范化（canonicalize）之后的绝对路径"
        );
        assert!(first.previous.is_none());

        // 目标目录里有我们的标记 → 把"上次导出"读出来交给前端（它据此汇报残留文件）
        write_marker(&out, SITE_TOOL_ID);
        let second = plan_site_in(&state, Some(out_str.as_str())).unwrap();
        let previous = second.previous.expect("标记文件在，previous 必须有值");
        assert_eq!(previous.exported_at_ms, 1_700_000_000_000);
        assert_eq!(previous.vault_name, "我的库");
        assert_eq!(previous.files, vec!["index.html".to_string()]);

        // 目录非空但没有我们的标记 → 在**写之前**拒绝（否则用户会拿到一个写了一半的目录）
        let foreign_home = temp_dir();
        let foreign = foreign_home.path().join("别人的目录");
        fs::create_dir_all(&foreign).unwrap();
        fs::write(foreign.join("我的东西.txt"), "别动").unwrap();
        let foreign_str = foreign.to_string_lossy().to_string();
        let error = plan_site_in(&state, Some(foreign_str.as_str())).unwrap_err();
        assert_eq!(error.code, ErrorCode::AlreadyExists.as_str());
    }

    #[test]
    fn site_plan_serializes_to_the_frontend_contract() {
        let (_dir, state) = state_with(&[
            (
                "项目/设计.md",
                "---\ntitle: 设计\ntags: [甲]\n---\n\n[[路线图]] 与 [[没有这篇]]\n",
            ),
            ("项目/路线图.md", "正文\n"),
        ]);
        let plan = plan_site_in(&state, None).unwrap();
        let json = serde_json::to_string(&plan).unwrap();

        for key in [
            "vaultName",
            "outputDir",
            "previous",
            "pages",
            "stats",
            "assets",
            "relPath",
            "pagePath",
            "urlPath",
            "title",
            "tags",
            "links",
            "target",
            "anchor",
            "href",
            "display",
            "backlinks",
            "notes",
            "dangling",
            "renamed",
        ] {
            assert!(
                json.contains(&format!("\"{key}\"")),
                "缺少字段 {key}：{json}"
            );
        }
        // 没有"上次导出"时必须是字面量 `null`（前端按 null 分支）
        assert!(json.contains("\"previous\":null"), "实际：{json}");
        assert!(json.contains("\"outputDir\":null"), "实际：{json}");
        // 悬空链接的 href 同样是字面量 `null`（前端据此渲染成不可点的文字）
        assert!(json.contains("\"href\":null"), "实际：{json}");

        for snake in [
            "vault_name",
            "output_dir",
            "exported_at_ms",
            "rel_path",
            "page_path",
            "url_path",
            "created_dirs",
        ] {
            assert!(!json.contains(snake), "不该出现 snake_case {snake}：{json}");
        }
    }

    // -- 覆盖策略 ------------------------------------------------------------

    #[test]
    fn refuses_an_output_directory_inside_the_vault_or_mimenote() {
        let (dir, root) = vault_with(&[("甲.md", "正文\n")]);

        // ① 在 Vault 里（含还不存在的子目录）
        let inside = root.path().join("导出");
        let error = ensure_outside_vault(&root, &inside).unwrap_err();
        assert_eq!(error.code(), ErrorCode::PathInvalid);
        let message = error.to_string();
        assert!(
            message.contains("重扫") && message.contains("同步"),
            "错误信息要说清代价（重扫 / 同步盘上传）：{message}"
        );

        // ② 正好是 Vault 根
        let error = ensure_outside_vault(&root, root.path()).unwrap_err();
        assert_eq!(error.code(), ErrorCode::PathInvalid);
        assert!(error.to_string().contains("Vault 根目录"), "实际：{error}");

        // ③ 在 Vault 的管理目录之下（缓存与回收站）
        let under_meta = root.path().join(".mimenote").join("站点");
        let error = ensure_outside_vault(&root, &under_meta).unwrap_err();
        assert_eq!(error.code(), ErrorCode::PathInvalid);
        assert!(error.to_string().contains(".mimenote"), "实际：{error}");

        // ④ Vault 之外的目录放行（Vault 的上一级、以及完全无关的目录）
        assert!(ensure_outside_vault(&root, &dir.path().parent().unwrap().join("导出")).is_ok());
        assert!(ensure_outside_vault(&root, Path::new(r"C:\别处")).is_ok());

        // ⑤ 词法上在外面、实际在里面的写法同样要拦：`..` 必须在规范化时被折叠掉
        assert_eq!(
            normalize_output_dir("").unwrap_err().code(),
            ErrorCode::PathInvalid,
            "空目录要明确拒绝"
        );
        let sneaky = root.path().join("..").join(root.name()).join("导出");
        let normalized = normalize_output_dir(&sneaky.to_string_lossy()).unwrap();
        assert!(
            ensure_outside_vault(&root, &normalized).is_err(),
            "`<Vault>\\..\\<Vault>\\导出` 规范化之后就在 Vault 里：{normalized:?}"
        );
    }

    #[test]
    fn refuses_a_non_empty_directory_without_our_marker() {
        let dir = temp_dir();
        fs::write(dir.path().join("我的东西.txt"), "别动").unwrap();

        // 计划命令：目录非空且没有标记 → 直接拒绝（判定发生在任何写入之前）
        let error = inspect_output_dir(dir.path()).unwrap_err();
        assert_eq!(error.code(), ErrorCode::AlreadyExists);
        assert!(
            error.to_string().contains(SITE_MARKER_FILE),
            "实际：{error}"
        );

        // 写命令：绝不覆盖一个无法证明属于我们的已存在文件
        fs::write(dir.path().join("index.html"), "别人的首页").unwrap();
        let error = write_pages_in(dir.path(), &[file("index.html", "我们的首页")]).unwrap_err();
        assert_eq!(error.code(), ErrorCode::AlreadyExists);
        assert_eq!(
            read_at(dir.path(), "index.html"),
            "别人的首页",
            "一个字节都不许动"
        );

        // 标记文件在，但不是我们写的 → 一样拒绝
        write_marker(dir.path(), "someone-else");
        assert_eq!(
            inspect_output_dir(dir.path()).unwrap_err().code(),
            ErrorCode::AlreadyExists
        );

        // 标记文件是坏的 JSON → 拒绝（宁可让用户换目录，也不要猜）
        fs::write(dir.path().join(SITE_MARKER_FILE), "{ 这不是 json").unwrap();
        assert_eq!(
            inspect_output_dir(dir.path()).unwrap_err().code(),
            ErrorCode::AlreadyExists
        );
    }

    #[test]
    fn proceeds_when_the_marker_says_it_is_a_previous_export() {
        let dir = temp_dir();
        fs::write(dir.path().join("index.html"), "上一版").unwrap();
        write_marker(dir.path(), SITE_TOOL_ID);

        match inspect_output_dir(dir.path()).unwrap() {
            OutputDirState::Ours(previous) => {
                assert_eq!(previous.exported_at_ms, 1_700_000_000_000);
                assert_eq!(previous.vault_name, "我的库");
                assert_eq!(previous.files, vec!["index.html".to_string()]);
            }
            other => panic!("应当认成我们上次导出的目录：{other:?}"),
        }

        // 只有 `tool` 的标记也算我们的：将来加字段不该让"我们自己的目录"变成"别人的目录"
        fs::write(dir.path().join(SITE_MARKER_FILE), r#"{"tool":"mimenote"}"#).unwrap();
        match inspect_output_dir(dir.path()).unwrap() {
            OutputDirState::Ours(previous) => {
                assert_eq!(previous.files, Vec::<String>::new());
                assert_eq!(previous.exported_at_ms, 0);
            }
            other => panic!("缺省字段不该让标记作废：{other:?}"),
        }

        // 覆盖我们自己的文件是允许的
        write_marker(dir.path(), SITE_TOOL_ID);
        let outcome = write_pages_in(dir.path(), &[file("index.html", "这一版")]).unwrap();
        assert_eq!(outcome.files, 1);
        assert_eq!(read_at(dir.path(), "index.html"), "这一版");

        // 上次导出过、这次没有的文件**留在原处**（从不删除任何文件）
        fs::write(dir.path().join("上一版的残留.html"), "旧").unwrap();
        write_pages_in(dir.path(), &[file("index.html", "第三版")]).unwrap();
        assert!(
            exists(dir.path(), "上一版的残留.html"),
            "导出的东西从不删除：残留由前端按 previous.files 如实汇报"
        );
    }

    // -- 站内路径 ------------------------------------------------------------

    #[test]
    fn site_file_whitelist_accepts_html_css_json_only() {
        for good in [
            "index.html",
            "assets/site.css",
            SITE_MARKER_FILE,
            "项目/设计.HTML",
            "深层/目录/样式.CSS",
        ] {
            assert!(ensure_site_file_path(good).is_ok(), "{good} 应当被接受");
        }

        for bad in [
            "笔记.md",
            "图.png",
            "无扩展名",
            // NTFS 备用数据流：`:` 在段级校验里就被拒（比看扩展名更早）
            "a.html:ads",
            "a.html.exe",
            "../越界.html",
            "a/../../越界.html",
            "/绝对.html",
            r"C:\绝对.html",
            // Windows 保留设备名（含带扩展名的写法）
            "con.html",
            "NUL.css",
            // 结尾的点或空格（Windows 会静默截断，落点会与请求的不是同一个文件）
            "a.html.",
            "a.html ",
            // 空段
            "a//b.html",
        ] {
            assert_eq!(
                ensure_site_file_path(bad).unwrap_err().code(),
                ErrorCode::PathInvalid,
                "{bad} 必须被拒绝"
            );
        }

        // 批级上限用 TOO_LARGE：这是"这一批的形状不对"，不是某个文件自己的处境
        assert!(ensure_site_batch(&[file("index.html", "x")]).is_ok());
        let too_many = vec![file("a.html", "x"); MAX_SITE_FILES + 1];
        assert_eq!(
            ensure_site_batch(&too_many).unwrap_err().code(),
            ErrorCode::TooLarge
        );
    }

    #[test]
    fn never_writes_outside_the_output_directory() {
        let dir = temp_dir();
        let out = dir.path().join("站点");

        // ① 词法越界：整个批次在写第一个字节之前就被拒
        for bad in [
            "../外面.html",
            "a/../../外面.html",
            "/绝对.html",
            r"C:\外面.html",
            r"\\server\share\x.html",
        ] {
            let error = write_pages_in(&out, &[file(bad, "x")]).unwrap_err();
            assert_eq!(error.code(), ErrorCode::PathInvalid, "{bad} 必须被拒");
        }
        assert!(!dir.path().join("外面.html").exists());
        assert!(!out.exists(), "被拒绝的批次连输出目录都不该建");

        // ② 符号链接逃逸：输出目录里**预先躺着**一个指向外面的目录链接。
        //    这正是"校验 → 建目录 → 再校验 → 原子写"这个顺序存在的全部理由：
        //    反过来先建目录，落点就已经由那个链接决定了
        let outside = temp_dir();
        fs::create_dir_all(outside.path().join("evil")).unwrap();
        fs::write(outside.path().join("evil/x.html"), "外面的内容").unwrap();

        let out = site_dir(dir.path());
        if !make_dir_link(&outside.path().join("evil"), &out.join("link")) {
            // 符号链接与联接都建不了（非 Windows 且不支持 reparse point 的环境）。
            // 这里跳过而不是断言失败 —— 但**不把环境限制当作通过**：同一条防线在
            // `mn_core::path_guard` 的单测里也覆盖着（那里是 Vault 根，这里是任意根，
            // 走的是同一个 `ensure_no_escape` + 同一次真实 `canonicalize` 比对）
            eprintln!("跳过符号链接部分：当前环境既建不了符号链接也建不了联接");
            return;
        }

        let error = write_pages_in(&out, &[file("link/x.html", "我们的")]).unwrap_err();
        assert_eq!(error.code(), ErrorCode::PathEscape);
        assert_eq!(
            fs::read_to_string(outside.path().join("evil/x.html")).unwrap(),
            "外面的内容",
            "外部那个文件一个字节都不许变"
        );
    }

    // -- 落盘 ----------------------------------------------------------------

    #[test]
    fn writes_pages_into_the_chosen_directory_and_reports_the_contract() {
        let home = temp_dir();
        let out = home.path().join("站点");
        let marker = marker_text(SITE_TOOL_ID);
        let files = vec![
            file("index.html", "<!doctype html><p>目录</p>"),
            file("assets/site.css", "body{color:#333}"),
            file("项目/设计.html", "<!doctype html><p>设计</p>"),
            file(SITE_MARKER_FILE, &marker),
        ];
        let expected_bytes: u64 = files.iter().map(|item| item.text.len() as u64).sum();

        let outcome = write_pages_in(&out, &files).unwrap();

        assert_eq!(outcome.files, 4);
        assert_eq!(outcome.bytes, expected_bytes, "按字节计（中文 3 字节）");
        assert_eq!(outcome.output_dir, display_path(&out));
        assert!(
            !outcome.output_dir.contains(r"\\?\"),
            "必须去掉 verbatim 前缀"
        );
        assert_eq!(
            read_at(&out, "项目/设计.html"),
            "<!doctype html><p>设计</p>"
        );
        assert_eq!(read_at(&out, "assets/site.css"), "body{color:#333}");
        assert_eq!(
            read_at(&out, SITE_MARKER_FILE),
            marker,
            "标记文件由前端原样写入（宿主只读它）"
        );
        assert_eq!(outcome.created_dirs, vec!["assets", "项目"]);
    }

    #[test]
    fn writes_files_in_array_order_so_the_marker_can_go_last() {
        // 批内**按数组顺序**写：第 2 个文件的父路径被一个同名文件占着 → 它失败，
        // 而第 1 个已经落盘、第 3 个一个字节都没写。前端把 `index.html` 与标记文件
        // 放到最后一批，依赖的正是这条顺序（中断时不会有任何东西自称"导出完成"）
        let home = temp_dir();
        let out = home.path().join("站点");
        fs::create_dir_all(&out).unwrap();
        fs::write(out.join("assets"), "占位的同名文件").unwrap();

        let error = write_pages_in(
            &out,
            &[
                file("index.html", "第一"),
                file("assets/site.css", "第二"),
                file("最后.html", "第三"),
            ],
        )
        .unwrap_err();

        assert_eq!(error.code(), ErrorCode::NotADirectory);
        assert_eq!(read_at(&out, "index.html"), "第一");
        assert!(!exists(&out, "最后.html"));
    }

    #[test]
    fn creates_the_output_directory_and_reports_which_directories_it_made() {
        let home = temp_dir();
        // 输出目录本身不存在（连它的上级也不存在）：用户选了一个新的目录
        let out = home.path().join("还没建的站点").join("更深一层");

        let outcome = write_pages_in(
            &out,
            &[
                file("index.html", "首页"),
                file("assets/site.css", "css"),
                file("assets/深层/site.css", "css"),
                file("项目/设计.html", "页"),
                file("a/b/c.html", "深"),
            ],
        )
        .unwrap();

        assert!(exists(&out, "index.html"), "输出目录不存在 → 建出来");
        assert_eq!(
            outcome.created_dirs,
            vec!["a", "assets", "项目", "a/b", "assets/深层"],
            "站内相对路径、自浅到深、同层按路径排序（与 note_restore 的 created_dirs 同一口径）"
        );
        assert!(
            !outcome
                .created_dirs
                .iter()
                .any(|item| item.contains("还没建的站点")),
            "输出目录本身没有'站内相对路径'，不进这份清单：{:?}",
            outcome.created_dirs
        );

        // 第二次写：目录都在了 → 不再报"新建"
        let again = write_pages_in(&out, &[file("项目/另一页.html", "另一页")]).unwrap();
        assert!(again.created_dirs.is_empty(), "已存在的目录不算新建");
    }

    #[test]
    fn overwrites_an_existing_page_atomically_without_leftovers() {
        let dir = temp_dir();
        write_marker(dir.path(), SITE_TOOL_ID);
        fs::write(dir.path().join("index.html"), "旧内容").unwrap();

        write_pages_in(dir.path(), &[file("index.html", "新内容")]).unwrap();

        assert_eq!(read_at(dir.path(), "index.html"), "新内容");
        // 原子写的临时文件必须已经被 rename 掉（ADR-0004：不留半写文件）
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(TEMP_PREFIX))
            .collect();
        assert!(leftovers.is_empty(), "不应残留临时文件：{leftovers:?}");
    }

    #[test]
    fn site_write_outcome_serializes_to_the_frontend_contract() {
        let outcome = SiteWriteOutcome {
            output_dir: r"D:\导出\站点".into(),
            files: 4,
            bytes: 12345,
            written_in_ms: 7,
            created_dirs: vec!["assets".into(), "项目".into()],
        };
        let json = serde_json::to_string(&outcome).unwrap();
        for key in ["outputDir", "files", "bytes", "writtenInMs", "createdDirs"] {
            assert!(
                json.contains(&format!("\"{key}\"")),
                "缺少字段 {key}：{json}"
            );
        }
        assert!(json.contains("\"files\":4"), "实际：{json}");
        assert!(json.contains("\"bytes\":12345"), "实际：{json}");
        assert!(json.contains("\"writtenInMs\":7"), "实际：{json}");
        for snake in ["output_dir", "written_in_ms", "created_dirs"] {
            assert!(!json.contains(snake), "不该出现 snake_case {snake}：{json}");
        }
    }

    // -- 图片 ----------------------------------------------------------------

    #[test]
    fn asset_copy_only_accepts_images() {
        let (_dir, root) = vault_with(&[("附件/图.png", "PNG"), ("附件/说明.txt", "TXT")]);
        let home = temp_dir();
        let out = site_dir(home.path());

        let outcome =
            copy_assets_in(&root, &out, &[asset("附件/图.png"), asset("附件/说明.txt")]).unwrap();

        assert_eq!(outcome.copied, 1);
        assert_eq!(outcome.bytes, 3, "按源文件字节数计");
        assert_eq!(
            read_at(&out, "assets/附件/图.png"),
            "PNG",
            "落点固定为 assets/<原 Vault 相对路径>"
        );
        assert!(!exists(&out, "assets/附件/说明.txt"));
        assert_eq!(outcome.created_dirs, vec!["assets", "assets/附件"]);

        assert_eq!(outcome.skipped.len(), 1);
        assert_eq!(outcome.skipped[0].reason, SiteSkipReason::UnsupportedType);
        let json = serde_json::to_string(&outcome.skipped).unwrap();
        assert!(json.contains("\"unsupported-type\""), "实际：{json}");
        assert!(json.contains("\"relPath\""), "实际：{json}");
    }

    #[test]
    fn asset_copy_skips_and_reports_missing_files() {
        let (dir, root) = vault_with(&[("附件/好图.png", "OK")]);
        // 名字像图片、实际是目录的条目：它属于"读不到"，不是"不存在"
        fs::create_dir_all(dir.path().join("附件").join("子目录.png")).unwrap();
        let home = temp_dir();
        let out = site_dir(home.path());

        let outcome = copy_assets_in(
            &root,
            &out,
            &[
                asset("附件/不存在.png"),
                asset("附件/子目录.png"),
                asset("../外面.png"),
                asset("附件/好图.png"),
            ],
        )
        .unwrap();

        assert_eq!(outcome.copied, 1, "一张坏图不该让整批失败");
        assert_eq!(read_at(&out, "assets/附件/好图.png"), "OK");
        assert_eq!(
            outcome
                .skipped
                .iter()
                .map(|skip| skip.rel_path.as_str())
                .collect::<Vec<_>>(),
            vec!["附件/不存在.png", "附件/子目录.png", "../外面.png"],
            "被跳过的条目要如实列出来（按输入顺序）"
        );
        assert_eq!(outcome.skipped[0].reason, SiteSkipReason::NotFound);
        assert_eq!(outcome.skipped[1].reason, SiteSkipReason::Unreadable);
        assert_eq!(outcome.skipped[2].reason, SiteSkipReason::PathEscape);
        // 稳定原因字符串就是前端分支的依据（`notes_read_batch` 认的是同一套值）
        let json = serde_json::to_string(&outcome.skipped).unwrap();
        for reason in ["\"not-found\"", "\"unreadable\"", "\"path-escape\""] {
            assert!(json.contains(reason), "缺少 {reason}：{json}");
        }

        // 越界的那一条在 Vault 之外什么都没留下
        assert!(!dir.path().parent().unwrap().join("外面.png").exists());
    }

    #[test]
    fn asset_copy_reports_the_overflow_instead_of_failing_the_batch() {
        let (_dir, root) = vault_with(&[("附件/图.png", "PNG")]);
        let home = temp_dir();
        let out = site_dir(home.path());

        // 超过张数上限的那部分如实进 `skipped`，**不报错**：一次"页面都写好了、只差图片"的
        // 导出不该被判成失败（见 MAX_ASSETS 的说明）
        let mut inputs: Vec<SiteAssetInput> = (0..MAX_ASSETS)
            .map(|index| asset(&format!("附件/缺{index}.png")))
            .collect();
        inputs.push(asset("附件/图.png"));

        let outcome = copy_assets_in(&root, &out, &inputs).unwrap();

        assert_eq!(outcome.copied, 0, "第 {MAX_ASSETS} 张之后的不再复制");
        assert_eq!(outcome.skipped.len(), MAX_ASSETS + 1);
        let last = outcome.skipped.last().unwrap();
        assert_eq!(last.rel_path, "附件/图.png");
        assert_eq!(last.reason, SiteSkipReason::TooLarge);
        assert!(
            last.message.contains(&MAX_ASSETS.to_string()),
            "说明要写清上限：{}",
            last.message
        );
        assert_eq!(
            outcome.skipped[0].reason,
            SiteSkipReason::NotFound,
            "上限之内的条目照常处理（这里是读不到）"
        );
        assert!(!exists(&out, "assets/附件/图.png"));
    }

    #[test]
    fn asset_outcome_serializes_to_the_frontend_contract() {
        let outcome = SiteAssetOutcome {
            copied: 2,
            bytes: 1024,
            created_dirs: vec!["assets".into()],
            skipped: vec![SiteSkip::new(
                "图.png",
                SiteSkipReason::WriteFailed,
                "写入失败：磁盘空间不足",
            )],
        };
        let json = serde_json::to_string(&outcome).unwrap();
        for key in [
            "copied",
            "bytes",
            "createdDirs",
            "skipped",
            "relPath",
            "reason",
            "message",
        ] {
            assert!(
                json.contains(&format!("\"{key}\"")),
                "缺少字段 {key}：{json}"
            );
        }
        assert!(json.contains("\"copied\":2"), "实际：{json}");
        assert!(json.contains("\"write-failed\""), "实际：{json}");
        for snake in ["created_dirs", "rel_path"] {
            assert!(!json.contains(snake), "不该出现 snake_case {snake}：{json}");
        }
    }
}
