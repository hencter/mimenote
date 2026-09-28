//! # mimenote CLI
//!
//! 桌面应用之外的第二入口：与应用共用同一套 `mn-core`（`mn-index` 后续按需接入），
//! 面向"写脚本的人"与"跑 CI 的机器" —— 交互式能力（编辑、图谱、灯箱）永远只在
//! 桌面应用里，CLI 只做**可无人值守**的事：检查、生成、搬运。
//!
//! 当前命令（`mimenote --help` 看全表）：
//!
//! * `okf check <vault>`：按 Google OKF v0.2 检查一个目录（见 `mn_core::okf`）。
//!   退出码：0 = 合规，1 = 有 Error，2 = 用法/IO 错误（目录不存在、读失败）。
//!
//! 刻意**没有**的（不是路线图，是红线）：`export-site` 的 HTML 渲染 ——
//! 渲染管线只有前端那一份（`domain/markdown.ts`），Rust 侧复刻第二份等于
//! 把"导出件长什么样"变成两处真相。HTML 构建永远走应用内导出；CLI 只碰文本层。

use std::path::{Path, PathBuf};

use clap::{Args, Parser, Subcommand};
use mn_core::okf::{check_bundle, OkfSeverity};

#[derive(Debug, Parser)]
#[command(
    name = "mimenote-cli",
    version,
    about = "Mimenote 命令行：检查与站点构建"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// OKF 相关（Google Open Knowledge Format v0.2）。
    Okf(OkfArgs),
}

#[derive(Debug, Args)]
struct OkfArgs {
    #[command(subcommand)]
    command: OkfCommand,
}

#[derive(Debug, Subcommand)]
enum OkfCommand {
    /// 检查一个目录是否符合 OKF（frontmatter + type + 链接可达）。
    Check(CheckArgs),
}

#[derive(Debug, Args)]
struct CheckArgs {
    /// Vault 根目录。
    vault: PathBuf,
    /// 输出机器可读的 JSON（给 agent/CI 消费；默认是人读的文本）。
    #[arg(long)]
    json: bool,
}

fn main() {
    let cli = Cli::parse();
    let code = match cli.command {
        Command::Okf(args) => match args.command {
            OkfCommand::Check(args) => cmd_okf_check(&args),
        },
    };
    std::process::exit(code);
}

/// 读 Vault 全量 `.md`（跳过目录与超大文件），跑合规检查，打印报告。
fn cmd_okf_check(args: &CheckArgs) -> i32 {
    let files = match read_markdown_files(&args.vault) {
        Ok(files) => files,
        Err(message) => {
            eprint_error(&message);
            return 2;
        }
    };
    let report = check_bundle(&files);
    if args.json {
        match serde_json::to_string(&report) {
            Ok(json) => println!("{json}"),
            Err(error) => {
                eprint_error(&format!("报告序列化失败：{error}"));
                return 2;
            }
        }
    } else {
        print_text(&args.vault, &report);
    }
    if report.conformant {
        0
    } else {
        1
    }
}

/// 单个 Markdown 文件的读取上限（与索引层 `MAX_INDEX_BYTES` 同一个数量级概念，
/// 这里取小一点：检查只读 frontmatter 与链接，大文件不需要全文进内存——
/// 不过实现上是整篇读（frontmatter 在头上，链接散在全文），4MB 是上限不是目标）。
const MAX_READ_BYTES: u64 = 4 * 1024 * 1024;

fn read_markdown_files(root: &Path) -> Result<Vec<(String, String)>, String> {
    let report = mn_core::scanner::scan(root, &mn_core::scanner::ScanOptions::default())
        .map_err(|error| format!("扫描目录失败（{}）：{error}", root.display()))?;
    let mut files = Vec::new();
    for entry in &report.entries {
        if entry.is_dir {
            continue;
        }
        let lower = entry.rel_path.to_ascii_lowercase();
        if !(lower.ends_with(".md") || lower.ends_with(".markdown")) {
            continue;
        }
        if entry.size_bytes > MAX_READ_BYTES {
            continue;
        }
        let path = root.join(entry.rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
        match std::fs::read_to_string(&path) {
            Ok(text) => files.push((entry.rel_path.clone(), text)),
            Err(error) => {
                // 单个文件读失败不整轮失败：跳过并记一条（检查的是"包"，不是"这个文件必须可读"，
                // 读失败本身由宿主的索引/预览路径负责报告）。
                eprintln!("跳过读失败的文件（{}）：{error}", entry.rel_path);
            }
        }
    }
    Ok(files)
}

fn eprint_error(message: &str) {
    eprintln!("mimenote: 错误：{message}");
}

fn print_text(vault: &Path, report: &mn_core::okf::OkfReport) {
    println!("OKF 检查：{}（{} 篇笔记）", vault.display(), report.files);
    if report.issues.is_empty() {
        println!("合规：没有发现任何问题。");
        return;
    }
    for issue in &report.issues {
        let level = match issue.severity {
            OkfSeverity::Error => "错误",
            OkfSeverity::Warning => "警告",
        };
        println!(
            "[{level}] {}:{} {}",
            issue.rel_path, issue.line, issue.message
        );
    }
    println!(
        "{}（{} 个错误，{} 个警告）",
        if report.conformant {
            "合规"
        } else {
            "不合规"
        },
        report.error_count(),
        report.issues.len() - report.error_count(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_vault(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (rel, text) in files {
            let path = dir
                .path()
                .join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(path, text).unwrap();
        }
        dir
    }

    #[test]
    fn check_reads_a_vault_and_reports_conformance() {
        let dir = write_vault(&[
            ("index.md", "# 索引\n\n- [甲](甲.md)\n"),
            ("甲.md", "---\ntype: Reference\n---\n\n见 [[乙]]。\n"),
            ("乙.md", "---\ntype: Note\n---\n"),
        ]);
        let files = read_markdown_files(dir.path()).unwrap();
        assert_eq!(files.len(), 3);
        let report = check_bundle(&files);
        assert!(report.conformant, "{report:?}");
    }

    #[test]
    fn check_finds_missing_types() {
        let dir = write_vault(&[("甲.md", "# 没块\n")]);
        let files = read_markdown_files(dir.path()).unwrap();
        let report = check_bundle(&files);
        assert!(!report.conformant);
        assert_eq!(report.error_count(), 1);
    }

    #[test]
    fn missing_vault_is_a_usage_error() {
        let code = cmd_okf_check(&CheckArgs {
            vault: PathBuf::from("Z:\\不存在\\的目录\\一定不存在"),
            json: false,
        });
        assert_eq!(code, 2);
    }

    #[test]
    fn json_output_escapes_and_parses() {
        // Windows 文件名里不能有半角引号：把引号放在链接目标里，
        // 错误消息就会带引号 —— JSON 必须合法（引号转义）。
        let dir = write_vault(&[("乙.md", "---\ntype: Note\n---\n\n见 [[带\"引号\"目标]]。\n")]);
        let files = read_markdown_files(dir.path()).unwrap();
        let report = check_bundle(&files);
        assert!(!report.conformant);
        let json = serde_json::to_string(&report).unwrap();
        assert!(json.contains("\\\"引号\\\""));
        // 往返解析：转义正确 JSON 才 parse 得回来
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["conformant"], false);
    }
}
