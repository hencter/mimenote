//! `mn-core` 的 frontmatter / 标签集成测试：只走**公开 API**（上层接线看到的就是这些）。
//!
//! 覆盖契约：
//!
//! * [`mn_core::frontmatter::parse`] 的识别边界（BOM/CRLF/未闭合/字段顺序）；
//! * [`mn_core::tags::extract_tags`] 的两个来源、行号、排除项与去重；
//! * [`mn_core::frontmatter::set_tags`] 的**最小 diff**：除被改的那几行外逐字节不变；
//! * [`mn_core::tags::rename_tags`] 的重命名/合并：frontmatter 与正文一起改、
//!   跳过判据与抽取器一致、合并去重。

use mn_core::frontmatter::{self, FrontmatterValue};
use mn_core::tags::{
    apply_tag_edits, extract_tags, normalize_tag, rename_tags, TagRename, TagSource,
};
use mn_core::{parse_frontmatter, set_tags, set_tags_or_create};

/// 把文本按"含换行符的行"切开，便于逐字节比对（`split_inclusive` 保留行尾）。
fn lines(text: &str) -> Vec<&str> {
    text.split_inclusive('\n').collect()
}

/// 逐行比对：只有 `changed` 指定的行允许不同。
fn assert_only_these_lines_changed(before: &str, after: &str, changed: &[usize]) {
    let lhs = lines(before);
    let rhs = lines(after);
    assert_eq!(lhs.len(), rhs.len(), "行数不应变化：\n{lhs:?}\n{rhs:?}");
    for (index, (a, b)) in lhs.iter().zip(rhs.iter()).enumerate() {
        if changed.contains(&index) {
            continue;
        }
        assert_eq!(a, b, "第 {} 行不应变化", index + 1);
    }
}

const NOTE: &str = "---\r\ntitle: 示例笔记\r\ntags:\r\n  - 项目/甲\r\n  - 乙\r\ndraft: false # 未完成\r\ncover: 图.png\r\n---\r\n# 标题 #不是标签\r\n\r\n正文里的 #丙 与 #项目/甲（重复）。\r\n\r\n```\r\n#代码块里的不算\r\n```\r\n\r\n`#行内代码也不算` 与 <https://example.com/x#锚点>\r\n";

#[test]
fn parse_keeps_order_eol_and_bom() {
    let text = format!("\u{feff}{NOTE}");
    let fm = parse_frontmatter(&text).expect("应识别 frontmatter");

    // raw：不含首尾分隔行与 BOM，但保留 CRLF
    assert_eq!(
        fm.raw,
        "title: 示例笔记\r\ntags:\r\n  - 项目/甲\r\n  - 乙\r\ndraft: false # 未完成\r\ncover: 图.png\r\n"
    );
    // 字段顺序 = 文档顺序；行号是全文绝对行号（首行 `---` 是第 1 行）
    let keys: Vec<&str> = fm.fields.iter().map(|f| f.key.as_str()).collect();
    assert_eq!(keys, vec!["title", "tags", "draft", "cover"]);
    assert_eq!(fm.fields[1].line, 3);
    assert_eq!(
        fm.fields[1].value,
        FrontmatterValue::List(vec!["项目/甲".into(), "乙".into()])
    );
    assert_eq!(fm.fields[2].value, FrontmatterValue::Bool(false));
    assert_eq!(
        fm.fields[3].value,
        FrontmatterValue::Scalar("图.png".into())
    );
    // tags 字段合并去重后的结果
    assert_eq!(fm.tags, vec!["项目/甲".to_string(), "乙".to_string()]);
    // 正文（frontmatter 之后）可以直接切出来喂给预览/统计
    assert!(frontmatter::body(&text).starts_with("# 标题 #不是标签"));
}

#[test]
fn extract_tags_covers_sources_exclusions_and_dedup() {
    let text = format!("\u{feff}{NOTE}");
    let found = extract_tags(&text);

    let summary: Vec<(&str, TagSource, u32)> = found
        .iter()
        .map(|t| (t.tag.as_str(), t.source, t.line))
        .collect();

    assert_eq!(
        summary,
        vec![
            // frontmatter 的块数组：项自己的行号
            ("项目/甲", TagSource::Frontmatter, 4),
            ("乙", TagSource::Frontmatter, 5),
            // 正文行内：行首 `# 标题` 是标题整行跳过；URL 锚点与代码里的都不算
            ("丙", TagSource::Inline, 11),
        ],
        "正文里的 #项目/甲 与 frontmatter 重复，只保留首次出现"
    );
}

#[test]
fn set_tags_minimal_diff_on_block_list() {
    let text = format!("\u{feff}{NOTE}");
    let out = set_tags(&text, &["新甲".to_string(), "新乙".to_string()]).expect("有 frontmatter");

    let expected =
        format!("\u{feff}{NOTE}").replace("  - 项目/甲\r\n  - 乙", "  - 新甲\r\n  - 新乙");
    assert_eq!(out, expected, "只应改动两个项行");
    // 逐字节：只有第 4、5 行变化（BOM/CRLF/注释/未知键/正文全都不动）
    assert_only_these_lines_changed(&text, &out, &[3, 4]);
    assert!(out.starts_with('\u{feff}'), "BOM 必须保留");
    assert!(out.contains("draft: false # 未完成"), "行尾注释必须保留");
    assert!(out.contains("cover: 图.png"), "未知键必须保留");
}

#[test]
fn set_tags_is_idempotent_and_round_trips() {
    let text = format!("\u{feff}{NOTE}");
    let wanted = vec!["甲/子".to_string(), "With Space".to_string()];
    let once = set_tags(&text, &wanted).unwrap();
    let twice = set_tags(&once, &wanted).unwrap();
    assert_eq!(once, twice, "同样的输入应得到同样的输出（幂等）");

    let found = extract_tags(&once);
    let tags: Vec<&str> = found
        .iter()
        .filter(|t| t.source == TagSource::Frontmatter)
        .map(|t| t.tag.as_str())
        .collect();
    assert_eq!(tags, vec!["甲/子", "With Space"]);
}

#[test]
fn set_tags_appends_without_touching_existing_fields() {
    let text = "---\ntitle: 只有标题\n---\n正文\n";
    let out = set_tags(text, &["甲".to_string(), "乙".to_string()]).unwrap();
    assert_eq!(out, "---\ntitle: 只有标题\ntags: [甲, 乙]\n---\n正文\n");
    // 只多了一行：把它删掉后必须与原文逐字节相同
    assert_eq!(out.replacen("tags: [甲, 乙]\n", "", 1), text);
    assert_only_these_lines_changed(text, &out.replacen("tags: [甲, 乙]\n", "", 1), &[]);
}

#[test]
fn set_tags_refuses_without_frontmatter() {
    let plain = "# 普通笔记\n\n没有 frontmatter 的文件。\n";
    assert!(set_tags(plain, &["甲".to_string()]).is_none());
    // 未闭合的 frontmatter 同样视为"没有"，绝不擅自补一个结束分隔行
    let unclosed = "---\ntitle: 未闭合\n\n正文\n";
    assert!(set_tags(unclosed, &["甲".to_string()]).is_none());
    assert!(parse_frontmatter(unclosed).is_none());
    assert_eq!(frontmatter::body(unclosed), unclosed);
}

/// 面板"加标签 / 删标签"在宿主里就是这三步：`parse` → `apply_tag_edits` → `set_tags_or_create`。
/// 这里钉住整条链路的**可逆性**：加了再删，磁盘文本逐字节回到原样。
#[test]
fn tag_edits_round_trip_through_the_public_api() {
    let text = "\u{feff}---\r\ntitle: 示例\r\ntags: [Rust]\r\n---\r\n\r\n正文 #丙\r\n";
    let existing = parse_frontmatter(text).unwrap().tags;
    assert_eq!(existing, vec!["Rust".to_string()]);

    let wanted = apply_tag_edits(
        &existing,
        &["#新标签".to_string(), "父/子".to_string()],
        &[],
    );
    let added = set_tags_or_create(text, &wanted);
    assert!(added.starts_with('\u{feff}'), "BOM 必须保留");
    assert_only_these_lines_changed(text, &added, &[2]);
    assert_eq!(
        parse_frontmatter(&added).unwrap().tags,
        vec![
            "Rust".to_string(),
            "新标签".to_string(),
            "父/子".to_string()
        ]
    );
    // 行内标签一个都没动
    assert_eq!(
        extract_tags(&added)
            .into_iter()
            .filter(|tag| tag.source == TagSource::Inline)
            .map(|tag| tag.tag)
            .collect::<Vec<String>>(),
        vec!["丙".to_string()]
    );

    // 删掉刚加的两个（其中 `#Rust` 用大小写不同的写法删也没问题），必须逐字节回到原样
    let current = parse_frontmatter(&added).unwrap().tags;
    let back = apply_tag_edits(&current, &[], &["新标签".to_string(), "父/子".to_string()]);
    assert_eq!(set_tags_or_create(&added, &back), text);
}

/// 完全没有 frontmatter 的笔记：加标签要**造出**区块，但正文一个字节都不能少。
#[test]
fn tag_edits_create_frontmatter_without_touching_the_body() {
    let plain = "# 只有正文\n\n正文里的 #丙。\n";
    assert!(parse_frontmatter(plain).is_none());

    let added = set_tags_or_create(plain, &["甲".to_string()]);
    assert_eq!(
        added,
        "---\ntags: [甲]\n---\n# 只有正文\n\n正文里的 #丙。\n"
    );
    // 正文（区块之后的部分）与原文逐字节相同 —— 首行没有被吞进区块
    assert_eq!(frontmatter::body(&added), plain);
    assert_eq!(
        extract_tags(&added)
            .into_iter()
            .map(|tag| (tag.tag, tag.source))
            .collect::<Vec<(String, TagSource)>>(),
        vec![
            ("甲".to_string(), TagSource::Frontmatter),
            ("丙".to_string(), TagSource::Inline)
        ]
    );

    // 删掉最后一个标签：**保留** `tags` 字段并写成空列表（不删 key，见 ADR-0006 的后续修订）
    let back = set_tags_or_create(&added, &[]);
    assert_eq!(back, "---\ntags: []\n---\n# 只有正文\n\n正文里的 #丙。\n");
    assert_eq!(frontmatter::body(&back), plain);
}

#[test]
fn normalize_tag_is_the_shared_identity_key() {
    assert_eq!(normalize_tag("#项目/甲"), "项目/甲");
    assert_eq!(normalize_tag("  项目/甲  "), "项目/甲");
    assert_eq!(normalize_tag("Project/Sub"), "project/sub");
    assert_eq!(normalize_tag("/前导/尾随/"), "前导/尾随");
    assert_eq!(normalize_tag("#"), "");
    // 抽取结果里的显示写法与归一化键分开：显示保留原样，判同用小写键
    let found = extract_tags("正文 #Project 与 #project\n");
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].tag, "Project");
    assert_eq!(normalize_tag(&found[0].tag), "project");
}

#[test]
fn no_frontmatter_notes_still_get_inline_tags() {
    let text = "# 顶部标题\n\n一行 #标签 与 #父/子。\n";
    assert!(parse_frontmatter(text).is_none());
    let found = extract_tags(text);
    assert_eq!(
        found
            .iter()
            .map(|t| (t.tag.as_str(), t.line))
            .collect::<Vec<(&str, u32)>>(),
        vec![("标签", 3), ("父/子", 3)]
    );
}

/// 上层要把这些类型镜像到 TS（`src/ipc/types.ts`），所以序列化形状也算契约，钉住它。
#[test]
fn serialized_shape_for_ipc_mirroring() {
    let fm =
        parse_frontmatter("---\ntitle: t\ntags: [a]\nn: 1.50\nok: true\nnil: ~\n---\n").unwrap();
    let expected = r#"{"raw":"title: t\ntags: [a]\nn: 1.50\nok: true\nnil: ~\n","fields":[{"key":"title","value":{"kind":"scalar","value":"t"},"line":2},{"key":"tags","value":{"kind":"list","value":["a"]},"line":3},{"key":"n","value":{"kind":"number","value":"1.50"},"line":4},{"key":"ok","value":{"kind":"bool","value":true},"line":5},{"key":"nil","value":{"kind":"null"},"line":6}],"tags":["a"]}"#;
    assert_eq!(serde_json::to_string(&fm).unwrap(), expected);
}

#[test]
fn serialized_tag_ref_shape() {
    let found = extract_tags("正文 #丙\n");
    assert_eq!(
        serde_json::to_string(&found).unwrap(),
        r#"[{"tag":"丙","source":"inline","line":1}]"#
    );
    let fm_tags = extract_tags("---\ntags: [甲]\n---\n");
    assert_eq!(
        serde_json::to_string(&fm_tags).unwrap(),
        r#"[{"tag":"甲","source":"frontmatter","line":2}]"#
    );
}

// ---------------------------------------------------------------------------
// 标签重命名 / 合并（`tags::rename_tags`）
// ---------------------------------------------------------------------------

/// 重命名必须**同时**改 frontmatter 与正文，且只动该动的字节（BOM/CRLF/未知键/代码块）。
#[test]
fn rename_rewrites_frontmatter_and_body_with_a_minimal_diff() {
    let text = format!("\u{feff}{NOTE}");
    let map = TagRename::new("项目/甲", "归档/甲", false).unwrap();
    let out = rename_tags(&text, &map)
        .expect("正文与 frontmatter 都有它，必须改")
        .text;

    // 只有 block 数组的那一项与正文那一行发生变化（正文里的 `#项目/甲` 是行内标签）
    assert_only_these_lines_changed(&text, &out, &[3, 10]);
    assert!(out.starts_with('\u{feff}'), "BOM 必须保留");
    assert!(out.contains("cover: 图.png"), "未知键必须保留");
    assert!(out.contains("draft: false # 未完成"), "行尾注释必须保留");
    // 代码块里的 `#项目/甲`（如果有）与行内代码里的都不动 —— 这里用排除项直接钉住
    assert!(out.contains("```\r\n#代码块里的不算\r\n```"));
    assert!(out.contains("`#行内代码也不算`"));
    assert_eq!(
        parse_frontmatter(&out).unwrap().tags,
        vec!["归档/甲".to_string(), "乙".to_string()]
    );
    // 正文里那一处也真的改了（抽取器按归一化键去重，所以它不会出现在 `extract_tags`
    // 的行内列表里 —— frontmatter 先出现，写法胜出），因此这里直接看文本
    assert!(out.contains("正文里的 #丙 与 #归档/甲（重复）。"));
}

/// 层级标签：`父` → `母` 把 `父/子` 一起带走（后缀逐字保留），`include_children=false` 时不带。
#[test]
fn rename_carries_hierarchical_children() {
    let text = "---\ntags: [父, 父/子, 父/子/孙, 父老]\n---\n\n#父 与 #父/子 与 #父老\n";
    let carried = rename_tags(text, &TagRename::new("父", "母", true).unwrap())
        .unwrap()
        .text;
    assert_eq!(
        carried, "---\ntags: [母, 母/子, 母/子/孙, 父老]\n---\n\n#母 与 #母/子 与 #父老\n",
        "`父老` 前缀只是看起来像，不能动"
    );

    // 不带子标签：只改整条等于 `父` 的那些
    let flat = "---\ntags: [父, 父/子]\n---\n\n#父 与 #父/子\n";
    let only_parent = rename_tags(flat, &TagRename::new("父", "母", false).unwrap())
        .unwrap()
        .text;
    assert_eq!(
        only_parent,
        "---\ntags: [母, 父/子]\n---\n\n#母 与 #父/子\n"
    );
}

/// 合并：目标已经在同一篇里出现时不能留下重复项（frontmatter 列表与正文提及都算）。
#[test]
fn merge_dedupes_within_one_note() {
    let text = "---\ntags: [甲, 乙]\n---\n\n正文 #甲 与 #乙 与 #别的。\n";
    let out = rename_tags(text, &TagRename::new("甲", "乙", false).unwrap())
        .unwrap()
        .text;
    assert_eq!(out, "---\ntags: [乙]\n---\n\n正文 与 #乙 与 #别的。\n");
    // 幂等：重试（例如用户对"被跳过的文件"再点一次）不会二次改动
    assert!(rename_tags(&out, &TagRename::new("甲", "乙", false).unwrap()).is_none());
}

/// 正文行内标签在**重命名**时会改（M2 起它是只读的那条边界被打开）——
/// 但不该出现在代码块/行内代码/HTML 注释/frontmatter 区块/标题行里的那些。
#[test]
fn rename_skips_everything_that_is_not_a_tag() {
    let map = TagRename::new("甲", "乙", false).unwrap();
    let text = "---\n# 注释里的 #甲\ntitle: t\n---\n\n# 标题里的 #甲\n\n正文 #甲\n\n```\n#甲\n```\n\n`#甲`\n\n<!-- #甲 -->\n";
    let out = rename_tags(text, &map).unwrap().text;
    assert_eq!(
        out,
        "---\n# 注释里的 #甲\ntitle: t\n---\n\n# 标题里的 #甲\n\n正文 #乙\n\n```\n#甲\n```\n\n`#甲`\n\n<!-- #甲 -->\n"
    );
}
