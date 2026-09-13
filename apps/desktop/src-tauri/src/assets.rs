//! 本地图片的读取授权（ADR-0007）。
//!
//! 为什么不是"打开 Vault 时把整个目录加进 asset 作用域"：Tauri 的 asset 协议是拿**路径字符串**
//! 去匹配作用域、然后直接 `File::open`（`tauri/src/protocol/asset.rs`，全程没有 canonicalize）。
//! 于是 `allow_directory(root, true)` 的真实语义是"路径以 root 开头"——Vault 内一个指向外部的
//! 符号链接会被跟随读出，这与"符号链接逃逸一律拦截"的既有姿态冲突。
//!
//! 所以这里改成**逐文件授权**：
//! 1. 前端把「笔记 + 图片原始地址」解析成 Vault 相对路径（`domain/assets.ts` 只做字符串层面的拒绝）；
//! 2. 宿主用 `mn_core::path_guard` 的 `resolve_existing` 把它解析成真实文件 —— 逐级检查符号链接、
//!    拒绝越界、拒绝 Windows 保留名与 ADS；
//! 3. 只有**通过校验的那一个文件**被加进 asset 作用域，前端再把它渲染成 `<img>`。
//!
//! 批量而不是逐张：一次 IPC 换一整篇笔记的图片，避免"每张图一次往返"。
//!
//! 本模块还提供**读字节**的变体 [`asset_read_base64`]（导出时把图片内嵌成 `data:` URL）：
//! 路径校验与扩展名白名单与授权完全共用同一套代码，区别只在"返回绝对路径"还是"返回字节"。

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::error::IpcError;
use crate::state::AppState;

/// 单次请求最多授权的图片数。
///
/// 上限的意义是"一条笔记里塞了几千个图片路径"不会把一次 IPC 拖成秒级；超出的部分前端会在
/// 下一次渲染里再请求（占位元素仍然在，不会丢内容）。
const MAX_ASSETS_PER_REQUEST: usize = 256;

/// 单张图片可以被内嵌进导出件的大小上限。
///
/// 为什么设上限：base64 会把体积撑大约 4/3，而导出要把整份 HTML 当成一个 JSON 字符串
/// 走一次 IPC —— 一张几十 MB 的图足以把这条命令变成一次内存事故。超限的图片**不报错**，
/// 只是不内嵌（导出件里它退化成占位文字，用户至少能看懂"这里原本有张图"）。
const MAX_EMBED_IMAGE_BYTES: u64 = 8 * 1024 * 1024;

/// 单次内嵌请求的**原始字节**总量上限（base64 后约为此值的 4/3）。
///
/// 与 [`MAX_ASSETS_PER_REQUEST`] 是两道独立的闸门：张数上限挡"几千张小图"，
/// 字节上限挡"几十张大图"。两者都不设的话，一次 IPC 的报文体积就没有硬上限了。
const MAX_EMBED_BATCH_BYTES: u64 = 32 * 1024 * 1024;

/// 允许渲染的图片扩展名。
///
/// 加进 asset 作用域就等于"这个文件可读"，所以这里给白名单而不是放行任意文件类型。
///
/// 这也是**唯一**一份图片扩展名单：附件写入（`attachments.rs`）与前端解析
/// （`domain/assets.ts`）都从这里对齐，谁都不许再抄一份 —— 三处漂移的后果是
/// "能渲染却写不进去"或"写得进去却永远显示占位"这类只在某个平台上出现的怪状态。
pub(crate) const ALLOWED_IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "ico",
];

/// 一张图片的读取授权。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetGrant {
    /// 图片的 Vault 相对路径（与请求里的写法一致）。
    pub rel_path: String,
    /// 磁盘上的绝对路径（前端用 `convertFileSrc` 转成 asset URL）。
    pub absolute_path: String,
    pub size_bytes: u64,
}

/// 为一批图片换取读取授权。
///
/// 返回值**只包含通过校验的条目**：越界、符号链接逃逸、非图片扩展名、不存在或不是文件的路径
/// 都会被静默跳过。这是刻意的 —— 一条笔记里有一张坏图，不该让同一篇里其他图片也显示不出来，
/// 调用方把没返回的路径留在占位态即可。
#[tauri::command]
pub async fn asset_authorize(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    rel_paths: Vec<String>,
) -> Result<Vec<AssetGrant>, IpcError> {
    if rel_paths.is_empty() {
        return Ok(Vec::new());
    }

    let root = state.vault_root()?;
    let requested: Vec<String> = rel_paths.into_iter().take(MAX_ASSETS_PER_REQUEST).collect();
    let requested_count = requested.len();

    // 路径校验会读符号链接元数据（文件 IO）→ 按 ADR-0003 放到阻塞线程上
    let resolved = tauri::async_runtime::spawn_blocking(move || -> Vec<(String, PathBuf, u64)> {
        let mut out = Vec::new();
        for rel in requested {
            if !is_allowed_image(&rel) {
                continue;
            }
            // 相对路径本身非法（含 `..`、绝对路径、保留名…）与"解析后逃出 Vault"都在这一步被拒
            let Ok(absolute) = root.resolve_existing(&rel) else {
                log::debug!("图片未通过路径校验，保持占位：{rel}");
                continue;
            };
            let Ok(metadata) = std::fs::metadata(&absolute) else {
                continue;
            };
            if !metadata.is_file() {
                continue;
            }
            out.push((rel, absolute, metadata.len()));
        }
        out
    })
    .await
    .map_err(|error| IpcError::internal(format!("图片授权任务失败：{error}")))?;

    let mut grants = Vec::with_capacity(resolved.len());
    for (rel, absolute, size_bytes) in resolved {
        // 只放行这一个文件；作用域内部出错时跳过它，不影响同批其它图片
        if let Err(error) = app.asset_protocol_scope().allow_file(&absolute) {
            log::warn!("图片加入 asset 作用域失败（{rel}）：{error}");
            continue;
        }
        grants.push(AssetGrant {
            rel_path: rel,
            absolute_path: mn_core::path_guard::display_path(&absolute),
            size_bytes,
        });
    }

    log::debug!(
        "图片授权：请求 {requested_count} 张，放行 {} 张",
        grants.len()
    );
    Ok(grants)
}

/// 扩展名是否是允许渲染的图片（只看最后一段的文件名，不看目录）。
///
/// 同时是渲染授权、导出内嵌与附件写入（`attachments.rs`）三处的**同一个判定**。
pub(crate) fn is_allowed_image(rel: &str) -> bool {
    let file_name = rel.rsplit('/').next().unwrap_or(rel);
    let Some((_, extension)) = file_name.rsplit_once('.') else {
        return false;
    };
    let lower = extension.to_ascii_lowercase();
    ALLOWED_IMAGE_EXTENSIONS.contains(&lower.as_str())
}

// ---------------------------------------------------------------------------
// 导出用：把图片读成 base64（内嵌进自包含 HTML）
// ---------------------------------------------------------------------------

/// 一张图片的内容（base64 编码）。
///
/// 字段名是 IPC 契约的一部分（`src/ipc/types.ts` 手工镜像），一律 camelCase。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetBytes {
    /// 图片的 Vault 相对路径（与请求里的写法一致，POSIX）。
    pub rel_path: String,
    /// MIME 类型（由扩展名决定，如 `image/png`）。
    pub mime: String,
    /// **标准 base64**（RFC 4648，含 `=` 填充）的原始字节。
    pub data_base64: String,
    /// 原始字节数（**不是** base64 之后的长度）。
    pub size_bytes: u64,
}

/// 把一批 Vault 内图片读成 base64，供导出把图片内嵌进自包含 HTML。
///
/// 为什么需要它（为什么不直接引用 `asset:` 协议，也不用绝对路径）：
/// 导出的 HTML 是**要离开这个应用**的 —— 浏览器、别的机器、归档、发给别人。
/// `asset:` URL 只在当前 WebView 里有效（ADR-0007 的逐文件授权是会话级的），
/// 绝对路径换台机器就断。只有把字节写进文件本身（`data:` URL），
/// 单个 HTML 才能"拿到任何地方都能看"。这是导出这个功能唯一说得通的做法。
///
/// 契约与 [`asset_authorize`] 刻意保持一致：
///
/// * 路径走 `path_guard::resolve_existing`（逐级符号链接检查 + 越界拒绝），不自己拼路径；
/// * 扩展名白名单与授权**共用同一份** [`ALLOWED_IMAGE_EXTENSIONS`] 与同一个 [`is_allowed_image`]；
/// * **返回值只包含成功读到的条目**：越界、符号链接逃逸、非图片、不存在、超过
///   [`MAX_EMBED_IMAGE_BYTES`]、超出批次字节上限的条目都被静默跳过并记日志 ——
///   调用方把没返回的图片渲染成占位文字即可，不该因为一张坏图让整次导出失败。
///
/// 读取（可能几 MB）按 ADR-0003 放在阻塞线程上。
#[tauri::command]
pub async fn asset_read_base64(
    state: State<'_, Arc<AppState>>,
    rel_paths: Vec<String>,
) -> Result<Vec<AssetBytes>, IpcError> {
    if rel_paths.is_empty() {
        return Ok(Vec::new());
    }

    let root = state.vault_root()?;
    let requested: Vec<String> = rel_paths.into_iter().take(MAX_ASSETS_PER_REQUEST).collect();
    let requested_count = requested.len();

    let embedded =
        tauri::async_runtime::spawn_blocking(move || read_images_base64(&root, &requested))
            .await
            .map_err(|error| IpcError::internal(format!("图片读取任务失败：{error}")))?;

    log::debug!(
        "导出内嵌图片：请求 {requested_count} 张，内嵌 {} 张",
        embedded.len()
    );
    Ok(embedded)
}

/// [`asset_read_base64`] 的主体（与 Tauri 无关，可单测）。
///
/// 结果**保序**：返回顺序与请求顺序一致（前端据此把 data URL 贴回对应的图片位置）。
fn read_images_base64(root: &mn_core::VaultRoot, rel_paths: &[String]) -> Vec<AssetBytes> {
    read_images_with_limits(
        root,
        rel_paths,
        MAX_EMBED_IMAGE_BYTES,
        MAX_EMBED_BATCH_BYTES,
    )
}

/// 真正的读取实现（上限作为参数传入，便于用**小文件**单测两条闸门）。
fn read_images_with_limits(
    root: &mn_core::VaultRoot,
    rel_paths: &[String],
    max_image_bytes: u64,
    max_batch_bytes: u64,
) -> Vec<AssetBytes> {
    let mut out = Vec::new();
    let mut total_bytes: u64 = 0;

    for rel in rel_paths {
        // 扩展名白名单（与渲染授权同一份口径）：不是图片就直接跳过，连文件都不打开
        let Some(mime) = image_mime(rel) else {
            log::debug!("导出：跳过非图片扩展名 {rel}");
            continue;
        };
        // 相对路径本身非法，或（经符号链接解析后）逃出 Vault → 跳过
        let Ok(absolute) = root.resolve_existing(rel) else {
            log::debug!("导出：图片未通过路径校验，跳过 {rel}");
            continue;
        };
        let Ok(metadata) = std::fs::metadata(&absolute) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        if metadata.len() > max_image_bytes {
            log::warn!(
                "导出：图片超过单张上限（{} 字节 > {} 字节），不内嵌：{rel}",
                metadata.len(),
                max_image_bytes
            );
            continue;
        }
        if total_bytes.saturating_add(metadata.len()) > max_batch_bytes {
            log::warn!("导出：本批内嵌总量超过上限（{max_batch_bytes} 字节），不内嵌：{rel}");
            continue;
        }
        let Ok(bytes) = std::fs::read(&absolute) else {
            log::warn!("导出：读取图片失败，不内嵌：{rel}");
            continue;
        };

        total_bytes = total_bytes.saturating_add(bytes.len() as u64);
        out.push(AssetBytes {
            rel_path: rel.clone(),
            mime: mime.to_string(),
            data_base64: base64_encode(&bytes),
            size_bytes: bytes.len() as u64,
        });
    }

    out
}

/// 扩展名 → MIME 类型；不在 [`ALLOWED_IMAGE_EXTENSIONS`] 里返回 `None`。
///
/// 先过白名单再查 MIME 表：白名单是"能不能读"的唯一口径（与渲染授权共用），
/// 这里只在其之上补一个"读出来是什么类型"。两者的一致性由单测逐个扩展名钉死。
fn image_mime(rel: &str) -> Option<&'static str> {
    if !is_allowed_image(rel) {
        return None;
    }
    let file_name = rel.rsplit('/').next().unwrap_or(rel);
    let (_, extension) = file_name.rsplit_once('.')?;
    Some(match extension.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        // `is_allowed_image` 已挡住白名单外的扩展名，正常到不了这里；
        // 真到了（有人加了白名单却忘了配 MIME）给一个不至于被当成图片的兜底类型。
        _ => "application/octet-stream",
    })
}

/// 标准 base64 编码（RFC 4648，含 `=` 填充）。
///
/// 为什么不引依赖：整个导出功能只需要这一个函数，不到 30 行；引入 base64 crate 按仓库约定
/// 还要在 `docs/dependencies.md` 登记理由与许可证 —— 这里手写的收益明显更大。
///
/// 附件写入（`attachments.rs`）与 [`base64_decode`] 共用这一对实现：编解码必须来自同一处，
/// 否则"前端能发出去、宿主解不开"这种只在某条路径上出现的错，排查成本远高于这 30 行代码。
pub(crate) fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = u32::from(chunk[0]);
        let second = u32::from(chunk.get(1).copied().unwrap_or(0));
        let third = u32::from(chunk.get(2).copied().unwrap_or(0));
        let triple = (first << 16) | (second << 8) | third;

        out.push(ALPHABET[((triple >> 18) & 0x3f) as usize] as char);
        out.push(ALPHABET[((triple >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[((triple >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(triple & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// 标准 base64 解码（RFC 4648，要求规范的 `=` 填充）。
///
/// 与 [`base64_encode`] 成对（同一个"不引依赖"的理由），服务的是附件**写入**这条路径：
/// 它面对的是渲染进程递进来的字节，因此**严格**优先 —— 白名单外的字符、长度不是 4 的倍数、
/// 填充位置不对、`=` 之后又出现有效字符，一律返回 `None` 让调用方报错，
/// 而不是"尽力猜一猜"。写盘路径上猜错的代价是一个内容不明的文件。
pub(crate) fn base64_decode(input: &str) -> Option<Vec<u8>> {
    let bytes = input.as_bytes();
    if bytes.len() % 4 != 0 {
        return None;
    }

    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    // 填充只能出现在**最后一组**：`Zm9vYg==extr` 这种"填完还接着写"的载荷必须被拒，
    // 否则解码器会凭空多吐出一段本该不存在的字节。
    let mut padded = false;
    for chunk in bytes.chunks(4) {
        if padded {
            return None;
        }
        let mut triple: u32 = 0;
        let mut padding = 0usize;
        for (index, &byte) in chunk.iter().enumerate() {
            // `=` 也占一个 6 位槽（值记 0）—— 少移一位会让**最后一组**整体错位，
            // 而前面几组仍然是对的（这种"只有尾字节坏掉"的 bug 最难看出来）
            let value = if byte == b'=' {
                // 填充只能出现在末尾两位（`Zg==` / `Zm8=`），否则前面凑不满两个有效字符
                if index < 2 {
                    return None;
                }
                padding += 1;
                0
            } else {
                // 填充之后又出现有效字符（`Zm=v`）：那不是 base64
                if padding > 0 {
                    return None;
                }
                match byte {
                    b'A'..=b'Z' => byte - b'A',
                    b'a'..=b'z' => byte - b'a' + 26,
                    b'0'..=b'9' => byte - b'0' + 52,
                    b'+' => 62,
                    b'/' => 63,
                    _ => return None,
                }
            };
            triple = (triple << 6) | u32::from(value);
        }

        out.push((triple >> 16) as u8);
        if padding < 2 {
            out.push((triple >> 8) as u8);
        }
        if padding == 0 {
            out.push(triple as u8);
        }
        padded = padding > 0;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_vault() -> (tempfile::TempDir, mn_core::VaultRoot) {
        let dir = tempfile::tempdir().unwrap();
        let root = mn_core::VaultRoot::open(dir.path()).unwrap();
        (dir, root)
    }

    /// 写一个文件（自动建父目录），返回它的 Vault 相对路径。
    fn write_file(dir: &std::path::Path, rel: &str, bytes: &[u8]) -> String {
        let path = dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&path, bytes).unwrap();
        rel.to_string()
    }

    #[test]
    fn accepts_common_image_extensions_case_insensitively() {
        for rel in [
            "附件/图.png",
            "图.JPG",
            "a/b/c.webp",
            "icon.ico",
            "x.SVG",
            "图.avif",
        ] {
            assert!(is_allowed_image(rel), "{rel} 应该被接受");
        }
    }

    #[test]
    fn rejects_non_image_and_extensionless_paths() {
        for rel in [
            "笔记.md",
            "附件/说明.txt",
            "无扩展名",
            "目录.图",
            "a.b/文件名",
        ] {
            assert!(!is_allowed_image(rel), "{rel} 不该被接受");
        }
    }

    #[test]
    fn asset_grant_serializes_to_the_frontend_contract() {
        let grant = AssetGrant {
            rel_path: "附件/图.png".into(),
            absolute_path: "D:\\Vault\\附件\\图.png".into(),
            size_bytes: 12,
        };
        let json = serde_json::to_string(&grant).unwrap();
        assert!(json.contains("\"relPath\":\"附件/图.png\""), "实际：{json}");
        assert!(json.contains("\"absolutePath\""), "实际：{json}");
        assert!(json.contains("\"sizeBytes\":12"), "实际：{json}");
        assert!(!json.contains("rel_path"), "不该出现 snake_case：{json}");
    }

    // -- 导出内嵌（asset_read_base64） -----------------------------------------

    #[test]
    fn base64_matches_rfc4648_vectors() {
        // RFC 4648 §10 的官方测试向量（含三种填充长度）
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        // 非 ASCII（UTF-8 多字节）+ 0xff：编码的是**字节**，不是字符
        assert_eq!(base64_encode("图".as_bytes()), "5Zu+");
        assert_eq!(base64_encode(&[0x00, 0xff, 0x10, 0x80]), "AP8QgA==");
    }

    #[test]
    fn base64_decode_reverses_the_rfc4648_vectors() {
        // 与上一用例一一对应：附件写入拿到的就是这些字符串，解不开就等于图存不下来
        for (encoded, plain) in [
            ("", &b""[..]),
            ("Zg==", &b"f"[..]),
            ("Zm8=", &b"fo"[..]),
            ("Zm9v", &b"foo"[..]),
            ("Zm9vYg==", &b"foob"[..]),
            ("Zm9vYmE=", &b"fooba"[..]),
            ("Zm9vYmFy", &b"foobar"[..]),
            ("5Zu+", "图".as_bytes()),
            ("AP8QgA==", &[0x00, 0xff, 0x10, 0x80][..]),
        ] {
            assert_eq!(
                base64_decode(encoded).as_deref(),
                Some(plain),
                "解码 {encoded}"
            );
        }

        // 往返：任意字节序列编码再解码必须原样回来
        let raw: Vec<u8> = (0..=255u8).collect();
        assert_eq!(base64_decode(&base64_encode(&raw)).unwrap(), raw);
    }

    #[test]
    fn base64_decode_rejects_malformed_input() {
        for bad in [
            "Zm9v!",         // 白名单外的字符
            "Zm9",           // 长度不是 4 的倍数
            "Zm=9",          // 填充位置不对（`=` 出现在第 3 位之前）
            "Zm9v=",         // 多出来的填充
            "=Zm9v",         // 前缀填充
            "Zm9vYg==extra", // 填充之后还有内容
            "Zm9vYg==extr",  // 同上，长度凑成 4 的倍数（只靠长度检查挡不住）
            "5Zu+\n",        // 换行也是白名单外
        ] {
            assert!(base64_decode(bad).is_none(), "{bad} 应被拒绝");
        }
    }

    #[test]
    fn every_allowed_extension_maps_to_an_image_mime() {
        // 白名单与 MIME 表是两份数据，必须逐个对齐：漏配的后果是导出件里出现
        // `data:application/octet-stream`（浏览器不再按图片渲染），而这一条很难人工发现。
        for ext in ALLOWED_IMAGE_EXTENSIONS {
            let mime = image_mime(&format!("附件/图.{ext}"))
                .unwrap_or_else(|| panic!("{ext} 应能读出 MIME"));
            assert!(
                mime.starts_with("image/"),
                "{ext} 的 MIME 必须是 image/*：{mime}"
            );
        }
        assert_eq!(image_mime("a.JPEG"), Some("image/jpeg"), "大小写不敏感");
        assert_eq!(image_mime("笔记.md"), None);
    }

    #[test]
    fn reads_and_encodes_images_inside_the_vault() {
        let (dir, root) = temp_vault();
        write_file(dir.path(), "附件/图.png", b"foo");
        write_file(dir.path(), "b.JPG", &[0x00, 0xff, 0x10, 0x80]);

        let result = read_images_base64(&root, &["附件/图.png".to_string(), "b.JPG".to_string()]);

        assert_eq!(result.len(), 2, "两张都该内嵌");
        assert_eq!(result[0].rel_path, "附件/图.png", "返回保持请求顺序");
        assert_eq!(result[0].mime, "image/png");
        assert_eq!(result[0].data_base64, "Zm9v");
        assert_eq!(result[0].size_bytes, 3);
        assert_eq!(result[1].rel_path, "b.JPG");
        assert_eq!(result[1].mime, "image/jpeg");
        assert_eq!(result[1].data_base64, "AP8QgA==");
        assert_eq!(result[1].size_bytes, 4);
    }

    #[test]
    fn skips_escaping_missing_non_image_and_directory_paths() {
        let (dir, root) = temp_vault();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("外部.png"), b"secret").unwrap();

        write_file(dir.path(), "笔记.md", b"# not an image");
        write_file(dir.path(), "好的.png", b"ok");
        std::fs::create_dir_all(dir.path().join("目录.png")).unwrap();

        let result = read_images_base64(
            &root,
            &[
                "../外部.png".to_string(),
                "笔记.md".to_string(),
                "没有这张.png".to_string(),
                "目录.png".to_string(),
                "好的.png".to_string(),
            ],
        );

        // 只留下真正可内嵌的那一张：越界、非图片扩展名、不存在、目录全部被跳过
        assert_eq!(result.len(), 1, "实际：{result:?}");
        assert_eq!(result[0].rel_path, "好的.png");
        assert_eq!(result[0].data_base64, "b2s=");
    }

    #[test]
    fn skips_symlink_escape() {
        let (dir, root) = temp_vault();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("秘密.png"), b"secret").unwrap();

        let link = dir.path().join("链接.png");
        #[cfg(windows)]
        let created =
            std::os::windows::fs::symlink_file(outside.path().join("秘密.png"), &link).is_ok();
        #[cfg(unix)]
        let created = std::os::unix::fs::symlink(outside.path().join("秘密.png"), &link).is_ok();

        if !created {
            // 环境不允许创建符号链接（需要开发者模式）：跳过，但**不**把跳过当通过
            eprintln!("跳过：当前环境不允许创建符号链接");
            return;
        }

        let result = read_images_base64(&root, &["链接.png".to_string()]);
        assert!(result.is_empty(), "符号链接逃逸必须被拒绝：{result:?}");
    }

    #[test]
    fn embed_limits_match_the_documented_policy() {
        // 策略（写在模块注释里）：单张 ≤ 8 MiB、一批 ≤ 32 MiB。这两个数字是导出功能的
        // 行为契约（超限不报错、只退化成占位），改它们等于改用户能导出什么。
        assert_eq!(MAX_EMBED_IMAGE_BYTES, 8 * 1024 * 1024);
        assert_eq!(MAX_EMBED_BATCH_BYTES, 32 * 1024 * 1024);
        // 单张上限必须小于批次上限，否则"一批"永远只能装下一张（用 const 块让 clippy 明确
        // 这是一条编译期不变式，而不是运行期才有意义的断言）
        const { assert!(MAX_EMBED_IMAGE_BYTES <= MAX_EMBED_BATCH_BYTES) };
    }

    #[test]
    fn skips_images_over_the_per_image_limit() {
        let (dir, root) = temp_vault();
        write_file(dir.path(), "小.png", b"ok");
        write_file(dir.path(), "大.png", b"0123456789"); // 10 字节

        // 用 8 字节的单张上限验证分支（真实上限 8 MiB 由上面的策略用例钉住）
        let result = read_images_with_limits(&root, &["大.png".into(), "小.png".into()], 8, 1024);

        assert_eq!(result.len(), 1, "超限的图必须被跳过：{result:?}");
        assert_eq!(result[0].rel_path, "小.png");
    }

    #[test]
    fn stops_embedding_when_the_batch_budget_is_used_up() {
        let (dir, root) = temp_vault();
        let mut rels = Vec::new();
        for index in 0..3 {
            rels.push(write_file(
                dir.path(),
                &format!("图{index}.png"),
                b"0123456789", // 每张 10 字节
            ));
        }

        // 总量闸门：单张 12 字节、一批 25 字节 → 前两张（20）通过，第三张（30）被挡
        let result = read_images_with_limits(&root, &rels, 12, 25);

        assert_eq!(result.len(), 2, "总量闸门只放得下 2 张：{result:?}");
        assert_eq!(result[0].rel_path, "图0.png");
        assert_eq!(result[1].rel_path, "图1.png");
        assert!(result.iter().all(|item| item.size_bytes == 10));

        // 上限放宽后三张都在（说明挡的是"预算"而不是别的规则）
        assert_eq!(read_images_with_limits(&root, &rels, 12, 30).len(), 3);
    }

    #[test]
    fn asset_bytes_serializes_to_the_frontend_contract() {
        let item = AssetBytes {
            rel_path: "附件/图.png".into(),
            mime: "image/png".into(),
            data_base64: "Zm9v".into(),
            size_bytes: 3,
        };
        let json = serde_json::to_string(&item).unwrap();
        for key in ["relPath", "mime", "dataBase64", "sizeBytes"] {
            assert!(
                json.contains(&format!("\"{key}\"")),
                "缺少字段 {key}：{json}"
            );
        }
        assert!(json.contains("\"relPath\":\"附件/图.png\""), "实际：{json}");
        assert!(json.contains("\"mime\":\"image/png\""), "实际：{json}");
        assert!(json.contains("\"dataBase64\":\"Zm9v\""), "实际：{json}");
        assert!(json.contains("\"sizeBytes\":3"), "实际：{json}");
        for snake in ["rel_path", "data_base64", "size_bytes"] {
            assert!(!json.contains(snake), "不该出现 snake_case {snake}：{json}");
        }
    }
}
