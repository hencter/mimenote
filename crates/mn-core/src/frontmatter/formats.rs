//! TOML（`+++`）与 JSON（`;;;`）两种 frontmatter 围栏。
//!
//! ## 为什么要有这一层
//!
//! `---`（YAML）是本应用与 OKF 的默认形态，但生态里另外两个围栏是**事实标准**：
//! Hugo / Zola 的 `+++`（TOML）、Hexo 风格的 `;;;`（JSON）。"普通文件夹里的普通 Markdown
//! 文件"要能被这些工具直接吃下去，最小代价就是认这两个围栏 —— 而不是要求用户先把
//! frontmatter 转成 YAML（那等于把 Mimenote 变成数据的唯一所有者，与 ADR-0002 相反）。
//!
//! ## 三条纪律（`super::parse` / `super::set_tags` 等入口按 [`region`] 分流）
//!
//! 1. **只解析一层**：顶层必须是对象，值只认标量/布尔/数字/null/数组/一层对象。
//!    再深的结构不猜 —— 与 OKF 的"一层映射"同一条底线（见 [`super::FrontmatterValue`]）。
//! 2. **读不懂就不改写**：拿不到对象、或要写入的值类型不认识，一律返回 `None`
//!    （"这次不改"而不是"尽力而为地写坏"）。看不懂的结构不配拥有改写权。
//! 3. **保真优先于整齐**：围栏之外的正文、BOM、CRLF/LF 逐字保留（[`set`] 只重写
//!    两个围栏之间的那一段）。TOML 走 `toml_edit` 正是为了**原地换一个键的值**，
//!    把用户写的注释与其它字段的排版一起留住；JSON 没有注释可保，整块会重新
//!    pretty 序列化 —— 这一点写在 [`rewrite_json`] 上，不假装它也是逐字保真。
//!
//! ## 与 `---` 路径的两处已知差异（如实记录，不藏）
//!
//! - **行号**：这里的顶层字段统一报 `line: 2`。这些格式里"这个键在第几行"取决于
//!   TOML 的段写法 / JSON 的换行，逐字追行号要再写一套解析器，而属性表只用它做
//!   定位提示；`---` 那条路径的行号是**真的**逐行数出来的（见 [`super::parse_located`]）。
//! - **数字字面量**：TOML/JSON 的数字经 `serde_json` 一轮之后不再保留原文写法
//!   （`1.50` 会显示成 `1.5`），而 `---` 路径保留原文（见 [`super::FrontmatterValue::Number`]）。
//!   这两种格式的数值本来就没有"引号写法"可保，代价接受。

use serde_json::Value;

use super::{clean_tags, Frontmatter, FrontmatterField, FrontmatterValue};

/// frontmatter 区块在全文里的位置（字节下标）。
pub(super) struct Region {
    /// 首行围栏之后、区块正文的起点。
    pub start: usize,
    /// 结束围栏那一行的起点。
    pub close: usize,
    /// 结束围栏那一行之后（含它自己的换行；文件末尾没有换行时等于全文长度）。
    pub end: usize,
    /// `true` = TOML（`+++`）；`false` = JSON（`;;;`）。
    pub toml: bool,
}

/// 识别 `+++` / `;;;` 区块，返回它在全文里的位置。
///
/// 首行必须是围栏本身（允许 BOM 与行尾空白），结束行取**第一个**与首行相同的行。
/// 没有结束围栏时返回 `None` —— 与 `---` 那条路径一致："未闭合"算没有 frontmatter，
/// 不算错误（见 [`super::parse`] 的说明）。
pub(super) fn region(text: &str) -> Option<Region> {
    let first_end = text.find('\n')?;
    let fence = text[..first_end].trim_start_matches('\u{feff}').trim_end();
    let toml = match fence {
        "+++" => true,
        ";;;" => false,
        _ => return None,
    };
    let start = first_end + 1;
    let mut offset = start;
    for line in text[start..].split_inclusive('\n') {
        if line.trim_end() == fence {
            return Some(Region {
                start,
                close: offset,
                end: offset + line.len(),
                toml,
            });
        }
        offset += line.len();
    }
    None
}

/// 区块正文 → JSON 对象。
///
/// 两种格式统一收敛到 `serde_json::Value`：后面的取值、转换、写回就不必再分叉。
/// 不是对象（顶层是数组/标量）或语法错误时返回 `None`。
fn object_value(text: &str, region: &Region) -> Option<Value> {
    let raw = &text[region.start..region.close];
    let value = if region.toml {
        serde_json::to_value(raw.parse::<toml::Table>().ok()?).ok()?
    } else {
        serde_json::from_str(raw).ok()?
    };
    value.is_object().then_some(value)
}

/// 一条顶层字段（`line` 的口径见模块文档"已知差异"）。
fn field(key: &str, value: &Value) -> FrontmatterField {
    FrontmatterField {
        key: key.to_string(),
        value: convert(value),
        line: 2,
    }
}

/// `serde_json::Value` → 本 crate 的极简值模型。
///
/// 数组元素只留"文本表示"：`---` 那条路径的 `List` 也只装字符串，三条路径必须同一口径，
/// 否则同一份数据换个围栏就换了形态。
fn convert(value: &Value) -> FrontmatterValue {
    match value {
        Value::Null => FrontmatterValue::Null,
        Value::Bool(flag) => FrontmatterValue::Bool(*flag),
        Value::Number(number) => FrontmatterValue::Number(number.to_string()),
        Value::String(text) => FrontmatterValue::Scalar(text.clone()),
        Value::Array(items) => FrontmatterValue::List(items.iter().map(text_of).collect()),
        Value::Object(entries) => FrontmatterValue::Map(
            entries
                .iter()
                .map(|(key, value)| field(key, value))
                .collect(),
        ),
    }
}

/// 数组元素的文本表示：字符串原样，其它用 JSON 字面量（与"`List` 只装字符串"对齐）。
fn text_of(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

/// 取字段的字符串列表（标签抽取用）。
///
/// 映射/布尔/null 不贡献标签 —— 与 `---` 路径对 `Bool`/`Null` 的处理一致
/// （见 [`super::collect_tags`]）：`tags: {a: b}` 不该凭空变出一个叫 `tags` 的标签。
pub(super) fn items(value: &FrontmatterValue) -> Vec<String> {
    match value {
        FrontmatterValue::List(items) => items.clone(),
        FrontmatterValue::Scalar(scalar) => vec![scalar.clone()],
        _ => Vec::new(),
    }
}

/// 解析 `+++` / `;;;` frontmatter。
///
/// `None` 的语义与 [`super::parse`] 完全一致（没有块 / 未闭合 / 解析不出），**不是错误**。
pub(super) fn parse(text: &str) -> Option<Frontmatter> {
    let region = region(text)?;
    let data = object_value(text, &region)?;
    // 字段顺序 = 文档顺序：靠 Cargo.toml 里 `toml` / `serde_json` 的 `preserve_order`
    // 特性（见那个文件上的注释），`frontmatter_field_order_follows_the_document` 钉着它。
    let fields: Vec<FrontmatterField> = data
        .as_object()?
        .iter()
        .map(|(key, value)| field(key, value))
        .collect();
    let tags = clean_tags(
        &fields
            .iter()
            .filter(|field| {
                field.key.eq_ignore_ascii_case("tags") || field.key.eq_ignore_ascii_case("tag")
            })
            .flat_map(|field| items(&field.value))
            .collect::<Vec<_>>(),
    );
    Some(Frontmatter {
        raw: text[region.start..region.close].to_string(),
        fields,
        tags,
    })
}

/// 要写入的值（`serde_json::Value`）→ `toml_edit::Value`。
///
/// 只认字符串 / 布尔 / 数组（元素同样递归只认这三种）：调用方至今只会传这三种
/// （[`super::set_tags`] 的标签数组、[`super::set_scalar_field`] 的字符串、
/// [`super::rename_tag_fields`] 的标签数组）。其余一律 `None` = **拒绝改写**，
/// 走模块文档第 2 条纪律（宁可不改，也不写进一个看不懂的值）。
fn toml_value(value: &Value) -> Option<toml_edit::Value> {
    match value {
        Value::String(text) => Some(text.clone().into()),
        Value::Bool(flag) => Some((*flag).into()),
        Value::Array(items) => {
            let mut array = toml_edit::Array::new();
            for item in items {
                array.push(toml_value(item)?);
            }
            Some(array.into())
        }
        _ => None,
    }
}

/// 把 `key` 写成 `value`，返回新的全文。
///
/// 只重写两个围栏之间的那一段：`&text[..region.start]`（含 BOM 与首行围栏）与
/// `&text[region.close..]`（含结束围栏与全部正文）**逐字不动**。
pub(super) fn set(text: &str, key: &str, value: Value) -> Option<String> {
    let region = region(text)?;
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let block = if region.toml {
        rewrite_toml(text, &region, key, &value)?
    } else {
        rewrite_json(text, &region, key, &value)?
    };
    // 区块内部统一成文件自己的换行：`toml_edit` / `serde_json` 只会吐 `\n`，
    // 而 CRLF 文件里混进裸 `\n` 就是"保存一次 = 全文 diff"（保真那条底线）。
    let block = block.replace("\r\n", "\n").trim_end().replace('\n', eol);
    Some(format!(
        "{}{}{}{}",
        &text[..region.start],
        block,
        eol,
        &text[region.close..]
    ))
}

/// TOML 改写：`toml_edit` 的文档模型能在**原地**换掉一个键的值，
/// 注释、空行与其它字段的排版逐字不动 —— 这就是不用 `toml` 序列化器写回的唯一理由。
fn rewrite_toml(text: &str, region: &Region, key: &str, value: &Value) -> Option<String> {
    let mut document = text[region.start..region.close]
        .parse::<toml_edit::DocumentMut>()
        .ok()?;
    // 键名大小写不敏感（与 `Frontmatter::field` 同一口径）：命中已有键就写回**它原本的
    // 拼写**，否则才用调用方给的名字新增一条 —— 改写不该顺手把 `Tags` 改成 `tags`。
    let existing = document
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(key))
        .map(|(name, _)| name.to_string())
        .unwrap_or_else(|| key.to_string());
    let mut next = toml_value(value)?;
    // 继承旧值的修饰（`title = "x"  # 备注` 里那个备注与空格位）：
    // 不继承的话"改一个值"会把行尾注释一起吃掉。
    if let Some(previous) = document.get(&existing).and_then(toml_edit::Item::as_value) {
        *next.decor_mut() = previous.decor().clone();
    }
    document[&existing] = toml_edit::Item::Value(next);
    Some(document.to_string())
}

/// JSON 改写：整块重新序列化（2 空格缩进）。
///
/// **代价如实记**：JSON 没有注释可保，也不存在"不解析就替换一个键"的可靠写法；
/// 区块的原始缩进与换行会被规范化（键的**顺序**仍是文档顺序，靠 `preserve_order`）。
/// 要逐字保真的用户应当把 frontmatter 留在 `---` / `+++`。
fn rewrite_json(text: &str, region: &Region, key: &str, value: &Value) -> Option<String> {
    let mut data = object_value(text, region)?;
    let map = data.as_object_mut()?;
    let existing = map
        .keys()
        .find(|name| name.eq_ignore_ascii_case(key))
        .cloned()
        .unwrap_or_else(|| key.to_string());
    map.insert(existing, value.clone());
    serde_json::to_string_pretty(&data).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frontmatter::{
        body, parse as parse_frontmatter, set_scalar_field, set_tags_or_create,
    };

    /// 两类围栏共用同一份值模型与标签抽取（换个围栏不该换个形态）。
    #[test]
    fn toml_and_json_share_one_value_model() {
        let toml = "+++\ntitle = \"Hello\"\ntags = [\"a\"] # 行尾备注\n+++\nBody";
        let json = ";;;\n{\"title\":\"Hello\",\"tags\":[\"a\"]}\n;;;\nBody";
        for text in [toml, json] {
            let parsed = parse_frontmatter(text).expect("应当解析出 frontmatter");
            assert_eq!(parsed.tags, vec!["a"]);
            assert_eq!(
                parsed.get("title").and_then(FrontmatterValue::as_str),
                Some("Hello")
            );
            let changed = set_tags_or_create(text, &["b".into()]);
            assert_eq!(parse_frontmatter(&changed).unwrap().tags, vec!["b"]);
            assert_eq!(body(&changed), "Body");
        }
        // TOML 的注释必须活下来（JSON 没有注释可保，见 `rewrite_json`）
        assert!(set_tags_or_create(toml, &["b".into()]).contains("# 行尾备注"));
    }

    /// `Frontmatter::fields` 承诺"保持文档顺序"：这条钉住 `preserve_order` 特性
    /// 没有被人悄悄关掉（关掉之后 serde 的映射会按字典序排，属性表于是与正文里的
    /// 写法对不上）。
    #[test]
    fn frontmatter_field_order_follows_the_document() {
        let toml = "+++\nzeta = 1\nalpha = 2\nmiddle = 3\n+++\nBody";
        let keys: Vec<String> = parse_frontmatter(toml)
            .unwrap()
            .fields
            .iter()
            .map(|field| field.key.clone())
            .collect();
        assert_eq!(keys, vec!["zeta", "alpha", "middle"]);

        let json = ";;;\n{\"zeta\":1,\"alpha\":2,\"middle\":3}\n;;;\nBody";
        let keys: Vec<String> = parse_frontmatter(json)
            .unwrap()
            .fields
            .iter()
            .map(|field| field.key.clone())
            .collect();
        assert_eq!(keys, vec!["zeta", "alpha", "middle"]);
    }

    /// BOM 与 CRLF 都要保真：围栏之外逐字不动，区块内部换成文件自己的换行。
    #[test]
    fn bom_and_crlf_survive_inside_and_outside_the_block() {
        let text = "\u{feff}+++\r\ntitle = \"Hi\"\r\n+++\r\n正文\r\n";
        let changed = set(text, "title", Value::String("New".into())).unwrap();
        assert!(changed.starts_with('\u{feff}'));
        assert_eq!(body(&changed), "正文\r\n");
        assert!(changed.contains("title = \"New\"\r\n"), "{changed:?}");
        // 区块里不能混进裸 `\n`
        assert_eq!(
            changed.matches('\n').count(),
            changed.matches("\r\n").count()
        );
    }

    /// 改写命中已有键时写回**它原本的拼写**（大小写不敏感，但绝不顺手规范化键名）。
    #[test]
    fn rewriting_keeps_the_original_key_spelling() {
        let text = "+++\nTags = [\"a\"]\n+++\nBody";
        let changed = set_tags_or_create(text, &["b".into()]);
        assert!(changed.contains("Tags = [\"b\"]"), "{changed:?}");
        let json = ";;;\n{\"Tags\":[\"a\"]}\n;;;\nBody";
        let changed = set_tags_or_create(json, &["b".into()]);
        assert!(changed.contains("\"Tags\""), "{changed:?}");
        assert_eq!(parse_frontmatter(&changed).unwrap().tags, vec!["b"]);
    }

    /// `tag` 是 `tags` 的别名（与 `---` 路径同一口径）：抽取合并，改写落在**已有的那个键**上。
    #[test]
    fn tag_alias_is_merged_and_rewritten_in_place() {
        let text = "+++\ntag = [\"a\"]\n+++\nBody";
        assert_eq!(parse_frontmatter(text).unwrap().tags, vec!["a"]);
        let changed = set_tags_or_create(text, &["b".into()]);
        assert!(changed.contains("tag = [\"b\"]"), "{changed:?}");
        assert!(!changed.contains("tags ="), "{changed:?}");
    }

    /// 只解析一层：再深的结构不猜（映射不贡献标签，与 `Bool`/`Null` 同待遇）。
    #[test]
    fn maps_do_not_contribute_tags() {
        let text = "+++\nverified = { by = \"人审\" }\n+++\nBody";
        let parsed = parse_frontmatter(text).unwrap();
        assert!(parsed.tags.is_empty());
        assert_eq!(
            parsed.get("verified"),
            Some(&FrontmatterValue::Map(vec![FrontmatterField {
                key: "by".into(),
                value: FrontmatterValue::Scalar("人审".into()),
                line: 2,
            }]))
        );
        assert_eq!(items(&FrontmatterValue::Bool(true)), Vec::<String>::new());
        assert_eq!(items(&FrontmatterValue::List(vec!["x".into()])), vec!["x"]);
    }

    /// 读不懂就不改写：语法错、顶层不是对象、没有结束围栏都只是"没有 frontmatter"。
    #[test]
    fn unparsable_blocks_are_reported_as_absent_not_rewritten() {
        assert!(parse_frontmatter("+++\nbroken =\n+++\nBody").is_none());
        assert!(parse_frontmatter(";;;\n{\"a\":\n;;;\nBody").is_none());
        assert!(parse_frontmatter("+++\n[1, 2]\n+++\nBody").is_none());
        assert!(parse_frontmatter("+++\ntitle = \"x\"\nBody").is_none());
        assert!(set(
            "+++\nbroken =\n+++\nBody",
            "title",
            Value::String("x".into())
        )
        .is_none());
        // 不认识的写入值类型 = 拒绝改写（而不是写一个坏值进去）
        assert!(set(
            "+++\ntitle = \"x\"\n+++\nBody",
            "meta",
            serde_json::json!({ "a": 1 })
        )
        .is_none());
    }

    /// 文件末尾没有换行、区块为空都不该 panic 或丢正文。
    #[test]
    fn edge_shapes_of_the_block_are_handled() {
        let no_trailing_newline = "+++\ntitle = \"x\"\n+++";
        assert_eq!(body(no_trailing_newline), "");
        let changed = set_scalar_field(no_trailing_newline, "title", "y").unwrap();
        assert!(changed.starts_with("+++\n"), "{changed:?}");
        assert_eq!(body(&changed), "");

        let empty_block = ";;;\n{}\n;;;\n正文";
        let changed = set_scalar_field(empty_block, "created", "2026-01-02").unwrap();
        assert_eq!(body(&changed), "正文");
        assert_eq!(
            parse_frontmatter(&changed)
                .unwrap()
                .get("created")
                .and_then(FrontmatterValue::as_str),
            Some("2026-01-02")
        );
    }
}
