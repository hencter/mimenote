//! 路径防护：把"用户/前端给的相对路径"安全地解析成"Vault 内的绝对路径"。
//!
//! 威胁模型（见 `docs/architecture.md` §5）：
//!
//! | 攻击 | 拦截点 |
//! | --- | --- |
//! | `../../Windows/System32/x` | 段级校验拒绝 `..`；canonicalize 后再次 `starts_with(root)` |
//! | `C:\Windows\x`、`\\server\share`、`/etc/passwd` | 拒绝绝对路径与盘符/UNC 前缀 |
//! | `a:b`（NTFS 备用数据流） | 拒绝 `:` |
//! | `con.md`、`NUL`、`COM1.txt` | 拒绝 Windows 保留设备名 |
//! | `a.`、`a `（Windows 会静默截断） | 拒绝段尾点与空格 |
//! | Vault 内符号链接指向外部 | 逐级 `symlink_metadata`，链接目标必须仍在根内 |

use std::path::{Component, Path, PathBuf};

use crate::error::{Error, Result};

/// 相对路径总长度上限（字节）。
pub const MAX_REL_PATH_LEN: usize = 4096;
/// 单段长度上限（Windows 每个文件名成分上限 255）。
pub const MAX_SEGMENT_LEN: usize = 255;

/// Windows 文件名禁用字符。
const FORBIDDEN_CHARS: &[char] = &['<', '>', ':', '"', '|', '?', '*'];

/// Windows 保留设备名（不区分大小写，且带扩展名同样保留）。
const RESERVED_NAMES: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// 一个已校验、已 canonicalize 的 Vault 根。
///
/// **所有**接收相对路径的 API 都必须通过它解析；不要自己 `Path::join` 用户输入。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultRoot {
    root: PathBuf,
}

impl VaultRoot {
    /// 打开（并校验）一个 Vault 根目录。
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let raw = path.as_ref();
        if !raw.exists() {
            return Err(Error::NotFound(display_path(raw)));
        }
        if !raw.is_dir() {
            return Err(Error::NotADirectory(display_path(raw)));
        }
        let root = raw.canonicalize().map_err(|e| Error::io(raw, e))?;
        Ok(Self { root })
    }

    /// canonicalize 后的绝对根路径（Windows 上带 `\\?\` 前缀，比较用）。
    pub fn path(&self) -> &Path {
        &self.root
    }

    /// 面向用户展示的绝对根路径（去掉 Windows verbatim 前缀）。
    pub fn display(&self) -> String {
        display_path(&self.root)
    }

    /// Vault 目录名（用于标题栏）。
    pub fn name(&self) -> String {
        self.root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| self.display())
    }

    /// 解析一个**必须已存在**的相对路径。
    pub fn resolve_existing(&self, rel: &str) -> Result<PathBuf> {
        let candidate = self.resolve_for_write(rel)?;
        match std::fs::symlink_metadata(&candidate) {
            Ok(_) => Ok(candidate),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                Err(Error::NotFound(rel.to_string()))
            }
            Err(e) => Err(Error::io(&candidate, e)),
        }
    }

    /// 解析一个**准备写入**的相对路径（允许末段尚不存在，但父目录必须已存在且安全）。
    pub fn resolve_for_write(&self, rel: &str) -> Result<PathBuf> {
        let segments = validate_relative_path(rel)?;
        let mut candidate = self.root.clone();
        for seg in &segments {
            candidate.push(seg);
        }
        // 词法检查：joined 必须仍在 root 之内。
        if !candidate.starts_with(&self.root) {
            return Err(Error::PathEscape(rel.to_string()));
        }
        // 符号链接检查：逐级确认没有跳出 root。
        ensure_no_escape(&self.root, &candidate)?;
        Ok(candidate)
    }

    /// 面向用户展示的、相对根的显示路径（统一 `/` 分隔）。
    pub fn relativize(&self, path: &Path) -> Option<String> {
        let rel = path.strip_prefix(&self.root).ok()?;
        let mut out = String::new();
        for comp in rel.components() {
            if let Component::Normal(part) = comp {
                if !out.is_empty() {
                    out.push('/');
                }
                out.push_str(&part.to_string_lossy());
            }
        }
        Some(out)
    }
}

/// 校验相对路径并返回其各段。
///
/// 返回的段保证：非空、非 `.`/`..`、无禁用字符、非保留名、无尾随点/空格。
pub fn validate_relative_path(rel: &str) -> Result<Vec<String>> {
    if rel.is_empty() {
        return Err(Error::invalid(rel, "路径为空"));
    }
    if rel.len() > MAX_REL_PATH_LEN {
        return Err(Error::invalid(
            rel,
            format!("路径过长（> {MAX_REL_PATH_LEN} 字节）"),
        ));
    }
    if rel
        .chars()
        .any(|c| c == '\0' || (c.is_control() && c != '\t'))
    {
        return Err(Error::invalid(rel, "含控制字符"));
    }
    let first = rel.as_bytes()[0];
    if first == b'/' || first == b'\\' {
        return Err(Error::invalid(rel, "不允许绝对路径"));
    }
    let mut out = Vec::new();
    for segment in rel.split(['/', '\\']) {
        validate_segment(segment).map_err(|reason| Error::invalid(rel, reason))?;
        out.push(segment.to_string());
    }
    Ok(out)
}

fn validate_segment(segment: &str) -> std::result::Result<(), String> {
    if segment.is_empty() {
        return Err("含空路径段（连续分隔符）".to_string());
    }
    if segment == "." || segment == ".." {
        return Err("不允许 `.` 或 `..` 路径段".to_string());
    }
    if segment.len() > MAX_SEGMENT_LEN {
        return Err(format!("路径段过长（> {MAX_SEGMENT_LEN} 字节）：{segment}"));
    }
    if let Some(ch) = segment.chars().find(|c| FORBIDDEN_CHARS.contains(c)) {
        return Err(format!("含禁用字符 `{ch}`：{segment}"));
    }
    if segment.starts_with(' ') || segment.ends_with(' ') || segment.ends_with('.') {
        return Err(format!("路径段以空格或点结尾：{segment}"));
    }
    if is_reserved_name(segment) {
        return Err(format!("使用了 Windows 保留名：{segment}"));
    }
    Ok(())
}

/// 是否为 Windows 保留设备名（`con`、`con.md`、`COM1` 均算）。
pub fn is_reserved_name(segment: &str) -> bool {
    let stem = segment.split('.').next().unwrap_or(segment);
    let stem = stem.trim_end_matches([' ', '.']);
    RESERVED_NAMES.iter().any(|r| stem.eq_ignore_ascii_case(r))
}

/// 把用户输入的标题转成**安全的文件名主干**（不含扩展名）。
///
/// 规则：去掉 `.md`/`.markdown` 后缀 → 禁用字符与分隔符替换为 `-` → 去首尾空白与尾随点 →
/// 空标题回退为「未命名」→ 规避 Windows 保留名 → 按字符截断到 120 字节以内。
pub fn sanitize_file_stem(input: &str) -> String {
    let trimmed = input.trim();
    let without_ext = trimmed
        .strip_suffix(".md")
        .or_else(|| trimmed.strip_suffix(".markdown"))
        .unwrap_or(trimmed);

    let mut sanitized = String::with_capacity(without_ext.len());
    for ch in without_ext.chars() {
        if ch.is_control() || FORBIDDEN_CHARS.contains(&ch) || ch == '/' || ch == '\\' {
            sanitized.push('-');
        } else {
            sanitized.push(ch);
        }
    }

    let collapsed = sanitized.split_whitespace().collect::<Vec<_>>().join(" ");
    let stripped = collapsed.trim_matches([' ', '.']).to_string();

    let named = if stripped.is_empty() || stripped == "." || stripped == ".." {
        "未命名".to_string()
    } else {
        stripped
    };
    let safe = if is_reserved_name(&named) {
        format!("{named}-note")
    } else {
        named
    };
    truncate_bytes(&safe, 120)
}

/// 按字符边界截断到不超过 `max_bytes` 字节。
fn truncate_bytes(input: &str, max_bytes: usize) -> String {
    if input.len() <= max_bytes {
        return input.to_string();
    }
    let mut out = String::with_capacity(max_bytes);
    for ch in input.chars() {
        if out.len() + ch.len_utf8() > max_bytes {
            break;
        }
        out.push(ch);
    }
    out
}

/// 逐级检查候选路径：任何符号链接的解析结果都必须仍在根内。
pub(crate) fn ensure_no_escape(root: &Path, candidate: &Path) -> Result<()> {
    let rel = candidate
        .strip_prefix(root)
        .map_err(|_| Error::PathEscape(display_path(candidate)))?;
    let mut cursor = root.to_path_buf();
    for comp in rel.components() {
        cursor.push(comp.as_os_str());
        match std::fs::symlink_metadata(&cursor) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    let real = cursor.canonicalize().map_err(|e| Error::io(&cursor, e))?;
                    if !real.starts_with(root) {
                        return Err(Error::PathEscape(display_path(&cursor)));
                    }
                    cursor = real;
                }
            }
            // 后续路径尚不存在（新建文件）：无需继续检查。
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
            Err(e) => return Err(Error::io(&cursor, e)),
        }
    }
    Ok(())
}

/// 去掉 Windows verbatim 前缀，得到人类可读路径。
pub fn display_path(path: &Path) -> String {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    s.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use std::fs;

    fn temp_vault() -> (tempfile::TempDir, VaultRoot) {
        let dir = tempfile::tempdir().expect("建临时目录");
        let root = VaultRoot::open(dir.path()).expect("打开 Vault");
        (dir, root)
    }

    #[test]
    fn accepts_normal_relative_paths() {
        let segs = validate_relative_path("notes/日拱一卒/2025-01-01.md").unwrap();
        assert_eq!(segs.len(), 3);
        assert_eq!(segs[2], "2025-01-01.md");
        // 反斜杠也接受（统一按分隔符处理）
        assert_eq!(validate_relative_path(r"a\b\c.md").unwrap().len(), 3);
    }

    #[test]
    fn rejects_traversal_and_absolute() {
        for bad in [
            "../secret.md",
            "a/../../secret.md",
            "/etc/passwd",
            r"C:\Windows\System32\evil.dll",
            r"\\server\share\x.md",
            "a//b.md",
            "a/./b.md",
            "",
        ] {
            let err = validate_relative_path(bad).unwrap_err();
            assert_eq!(err.code(), ErrorCode::PathInvalid, "应拒绝：{bad}");
        }
    }

    #[test]
    fn rejects_windows_hazards() {
        for bad in [
            "con.md",
            "CON",
            "aux.txt",
            "com1.md",
            "LPT9",
            "a:b.md",
            "a?.md",
            "a*.md",
            "a|b.md",
            "x.",
            "x ",
            "nul/inside.md",
        ] {
            assert!(validate_relative_path(bad).is_err(), "应拒绝：{bad}");
        }
        assert!(is_reserved_name("con.md"));
        assert!(is_reserved_name("COM1"));
        assert!(!is_reserved_name("console.md"));
        assert!(!is_reserved_name("com10.md"));
    }

    #[test]
    fn rejects_control_chars_and_long_segments() {
        assert!(validate_relative_path("a\u{0}b.md").is_err());
        assert!(validate_relative_path("a\nb.md").is_err());
        let long = "a".repeat(MAX_SEGMENT_LEN + 1);
        assert!(validate_relative_path(&format!("dir/{long}.md")).is_err());
    }

    #[test]
    fn sanitize_file_stem_rules() {
        assert_eq!(sanitize_file_stem("关于/安全: 测试"), "关于-安全- 测试");
        assert_eq!(sanitize_file_stem("  笔记.md  "), "笔记");
        assert_eq!(sanitize_file_stem("草稿.markdown"), "草稿");
        assert_eq!(sanitize_file_stem(""), "未命名");
        assert_eq!(sanitize_file_stem("   "), "未命名");
        assert_eq!(sanitize_file_stem("..."), "未命名");
        assert_eq!(sanitize_file_stem("con"), "con-note", "保留名必须规避");
        assert_eq!(sanitize_file_stem("COM1.md"), "COM1-note");
        assert_eq!(sanitize_file_stem("结尾点."), "结尾点");
        assert_eq!(sanitize_file_stem("多  个   空格"), "多 个 空格");

        let long = sanitize_file_stem(&"标".repeat(500));
        assert!(long.len() <= 120);
        assert!(validate_relative_path(&format!("{long}.md")).is_ok());
        // 结果本身必须是合法路径段
        assert!(validate_relative_path(&format!("{}.md", sanitize_file_stem("a:b"))).is_ok());
    }

    #[test]
    fn resolve_existing_finds_file_inside_vault() {
        let (dir, root) = temp_vault();
        fs::create_dir_all(dir.path().join("notes")).unwrap();
        fs::write(dir.path().join("notes/a.md"), "hi").unwrap();

        let p = root.resolve_existing("notes/a.md").unwrap();
        assert!(p.starts_with(root.path()));
        assert_eq!(root.relativize(&p).as_deref(), Some("notes/a.md"));
        assert_eq!(fs::read_to_string(&p).unwrap(), "hi");

        assert_eq!(
            root.resolve_existing("notes/missing.md")
                .unwrap_err()
                .code(),
            ErrorCode::NotFound
        );
    }

    #[test]
    fn resolve_for_write_allows_new_leaf_in_existing_dir() {
        let (dir, root) = temp_vault();
        fs::create_dir_all(dir.path().join("notes")).unwrap();
        let p = root.resolve_for_write("notes/new.md").unwrap();
        assert!(p.starts_with(root.path()));
        assert!(!p.exists());
        // 父目录写错也不会越界
        assert!(root.resolve_for_write("notes/../x.md").is_err());
    }

    #[test]
    fn display_path_strips_verbatim_prefix() {
        #[cfg(windows)]
        {
            let p = Path::new(r"\\?\C:\Users\me\Vault");
            assert_eq!(display_path(p), r"C:\Users\me\Vault");
            let u = Path::new(r"\\?\UNC\server\share\v");
            assert_eq!(display_path(u), r"\\server\share\v");
        }
        #[cfg(not(windows))]
        {
            assert_eq!(display_path(Path::new("/home/me/v")), "/home/me/v");
        }
    }

    #[test]
    fn open_rejects_missing_and_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.md");
        fs::write(&file, "x").unwrap();
        assert_eq!(
            VaultRoot::open(&file).unwrap_err().code(),
            ErrorCode::NotADirectory
        );
        assert_eq!(
            VaultRoot::open(dir.path().join("nope")).unwrap_err().code(),
            ErrorCode::NotFound
        );
    }

    /// 符号链接逃逸必须被拦截。Windows 上创建符号链接可能需要开发者模式，
    /// 无法创建时跳过（不把环境限制当作通过）。
    #[test]
    fn rejects_symlink_escape() {
        let outer = tempfile::tempdir().unwrap();
        let (dir, root) = temp_vault();
        let outside = outer.path().join("secret.md");
        fs::write(&outside, "top secret").unwrap();

        let link = dir.path().join("link.md");
        #[cfg(windows)]
        let created = std::os::windows::fs::symlink_file(&outside, &link).is_ok();
        #[cfg(unix)]
        let created = std::os::unix::fs::symlink(&outside, &link).is_ok();

        if !created {
            eprintln!("跳过：当前环境不允许创建符号链接（需要开发者模式/管理员）");
            return;
        }

        let err = root.resolve_existing("link.md").unwrap_err();
        assert_eq!(err.code(), ErrorCode::PathEscape);
    }
}
