//! 全文搜索领域：SQLite FTS5 查询（索引缓存与 MATCH 在 `mn-index::search`）。

use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use tauri::State;

use mn_core::Error;

use crate::error::IpcError;
use crate::indexer;
use crate::state::AppState;

use super::run_blocking;

/// 全文搜索的一条命中（行级）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub rel_path: String,
    /// 行号（1 起）。
    pub line: u32,
    /// 命中所在一行的裁剪版（单行、纯文本、约 120 字符以内）。
    pub snippet: String,
    /// 相关性分数（**越大越相关**，仅用于排序；前端不要再排一次）。
    pub score: f64,
}

impl From<mn_index::search::SearchHit> for SearchHit {
    fn from(hit: mn_index::search::SearchHit) -> Self {
        Self {
            rel_path: hit.rel_path,
            line: hit.line,
            snippet: hit.snippet,
            score: hit.score,
        }
    }
}

/// 全文搜索结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    /// 原样回显用户输入。
    pub query: String,
    /// 命中（已按 `score` 降序 → `relPath` → `line` 排好，最多 `limit` 条）。
    pub hits: Vec<SearchHit>,
    /// 命中总数（可能大于 `hits.len()`）。
    pub total: u32,
    /// 实际耗时（毫秒）。
    pub elapsed_ms: u64,
}

// ---------------------------------------------------------------------------
// 全文搜索
// ---------------------------------------------------------------------------

/// 默认返回条数。
const DEFAULT_SEARCH_LIMIT: u32 = 50;
/// 单次返回条数上限（再多也没有意义：前端是列表，不是导出）。
const MAX_SEARCH_LIMIT: u32 = 200;

/// 把入参的 `limit` 归一化到 [1, 200]（缺省 50）。
fn search_limit(limit: Option<u32>) -> u32 {
    limit
        .unwrap_or(DEFAULT_SEARCH_LIMIT)
        .clamp(1, MAX_SEARCH_LIMIT)
}

/// 全文搜索（SQLite FTS5）。
///
/// 参数与结果形状是不可偏离的 IPC 契约（`src/ipc/types.ts` 手工镜像）。
#[tauri::command]
pub async fn search_query(
    state: State<'_, Arc<AppState>>,
    query: String,
    limit: Option<u32>,
) -> Result<SearchResult, IpcError> {
    let app = Arc::clone(state.inner());
    // 主体在 `search_query_in`（与 Tauri 无关，可单测）；查询不走主线程（ADR-0003）
    run_blocking(move || search_query_in(&app, &query, limit)).await
}

/// `search_query` 的主体（与 Tauri 无关，可单测）。
///
/// * `query` trim 后为空 → 直接返回空结果（**不查库**：前端清空输入框时不该打一次 IPC）；
/// * 没打开 Vault → `VAULT_NOT_SET`（明确区分"没库"和"没有结果"）；
/// * 索引未就绪/不可用 → `IO` 错误，message 里带原因（"正在构建" / "Vault 只读"…）。
pub(crate) fn search_query_in(
    state: &AppState,
    query: &str,
    limit: Option<u32>,
) -> mn_core::Result<SearchResult> {
    let started = Instant::now();
    let query = query.to_string();

    if query.trim().is_empty() {
        return Ok(SearchResult {
            query,
            hits: Vec::new(),
            total: 0,
            elapsed_ms: started.elapsed().as_millis() as u64,
        });
    }
    if !state.is_open() {
        return Err(Error::VaultNotSet);
    }

    let outcome = indexer::search(state, &query, search_limit(limit))?;
    Ok(SearchResult {
        query,
        hits: outcome.hits.into_iter().map(SearchHit::from).collect(),
        total: outcome.total,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::notes::rename_note_in;
    use crate::commands::testkit::*;
    use mn_index::SearchIndex;

    // -- 全文搜索（search_query） -----------------------------------------------
    #[test]
    fn search_limit_is_clamped() {
        assert_eq!(search_limit(None), 50, "缺省 50");
        assert_eq!(search_limit(Some(7)), 7);
        assert_eq!(search_limit(Some(0)), 1, "0 条没有意义，抬到 1");
        assert_eq!(search_limit(Some(9999)), 200, "上限 200");
    }

    #[test]
    fn search_returns_hits_with_camel_case_fields() {
        let (_dir, state) = state_with(&[
            ("笔记/甲.md", "第一行\n这里有 关键词 出现\n"),
            ("笔记/乙.md", "关键词 也在标题里\n"),
        ]);

        let result = search_query_in(&state, "关键词", None).unwrap();
        assert_eq!(result.query, "关键词", "原样回显");
        assert_eq!(result.total, 2);
        assert_eq!(result.hits.len(), 2);

        // 命中行号正确（顺序由 score 决定，这里只核对集合）
        let mut pairs: Vec<(&str, u32)> = result
            .hits
            .iter()
            .map(|hit| (hit.rel_path.as_str(), hit.line))
            .collect();
        pairs.sort_unstable();
        assert_eq!(
            pairs,
            vec![("笔记/乙.md", 1), ("笔记/甲.md", 2)],
            "行号是文件里的绝对行号（乙 U+4E59 在 甲 U+7532 之前）"
        );

        // 排序规则（契约）：score 降序 → relPath 升序 → line 升序，前端不再排一次
        for pair in result.hits.windows(2) {
            let (first, second) = (&pair[0], &pair[1]);
            let ordered = (second.score < first.score)
                || (second.score == first.score
                    && (first.rel_path.as_str(), first.line)
                        <= (second.rel_path.as_str(), second.line));
            assert!(ordered, "排序不稳定：{first:?} / {second:?}");
        }
        assert!(
            result.hits[0].snippet.contains("关键词"),
            "{:?}",
            result.hits[0]
        );
        assert!(!result.hits[0].snippet.contains('\n'), "snippet 必须是单行");

        let json = serde_json::to_string(&result).unwrap();
        for key in [
            "\"query\"",
            "\"hits\"",
            "\"total\"",
            "\"elapsedMs\"",
            "\"relPath\"",
            "\"line\"",
            "\"snippet\"",
            "\"score\"",
        ] {
            assert!(json.contains(key), "缺少字段 {key}：{json}");
        }
        assert!(!json.contains("rel_path"), "字段名必须是 camelCase：{json}");
    }

    #[test]
    fn search_snippets_are_cropped_around_the_match() {
        let long = format!("{}关键词{}", "前".repeat(200), "后".repeat(200));
        let (_dir, state) = state_with(&[("长行.md", &format!("开头\n{long}\n结尾\n"))]);

        let result = search_query_in(&state, "关键词", None).unwrap();
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].line, 2);
        assert!(result.hits[0].snippet.contains("关键词"));
        assert!(result.hits[0].snippet.chars().count() <= 120);
    }

    #[test]
    fn search_with_empty_query_never_touches_the_index() {
        // 故意不装搜索索引：空查询必须照样成功（"清空输入框"不该报错、也不该查库）
        let (dir, state) = state_with(&[("甲.md", "内容\n")]);
        state.clear_search();
        assert!(
            search_query_in(&state, "内容", None).is_err(),
            "非空查询该报错"
        );
        for query in ["", "   ", "\n\t"] {
            let result = search_query_in(&state, query, None).unwrap();
            assert!(result.hits.is_empty(), "查询 {query:?}");
            assert_eq!(result.total, 0);
        }
        let _ = dir;
    }

    #[test]
    fn search_reports_unavailable_index_with_reason() {
        let (_dir, state) = state_with(&[("甲.md", "内容\n")]);

        // 正在构建
        state.clear_search();
        let error = search_query_in(&state, "内容", None).unwrap_err();
        assert_eq!(error.code(), mn_core::ErrorCode::Io);
        assert!(error.to_string().contains("正在构建"), "{error}");

        // 建库失败（只读 Vault / 磁盘满）：把**原因**带给用户，而不是伪装成"没有结果"
        state.fail_search("Vault 只读，无法写入 .mimenote/cache");
        let error = search_query_in(&state, "内容", None).unwrap_err();
        assert_eq!(error.code(), mn_core::ErrorCode::Io);
        assert!(error.to_string().contains("只读"), "{error}");
    }

    #[test]
    fn search_without_vault_is_rejected_but_empty_query_is_fine() {
        let state = AppState::default();
        state.clear_search();
        assert_eq!(
            search_query_in(&state, "内容", None).unwrap_err().code(),
            mn_core::ErrorCode::VaultNotSet
        );
        assert_eq!(search_query_in(&state, "  ", None).unwrap().total, 0);
    }

    #[test]
    fn unavailable_cache_directory_degrades_instead_of_failing() {
        // 在 `.mimenote/cache` 的位置放一个**文件** → 建库必然失败（与"Vault 只读"同一条路径）
        let (dir, state) = state_with(&[("甲.md", "内容\n")]);
        std::fs::create_dir_all(dir.path().join(".mimenote")).unwrap();
        std::fs::write(dir.path().join(".mimenote").join("cache"), "占位").unwrap();

        let root = state.vault_root().unwrap();
        state.clear_search();
        // 打开失败 → 记原因、返回 None（不 panic、不返回半成品索引）
        let opened = SearchIndex::open_for_rebuild(&indexer::search_db_path(&root));
        assert!(opened.is_err(), "父路径是文件，必然打不开");
        state.fail_search(opened.unwrap_err().to_string());

        let error = search_query_in(&state, "内容", None).unwrap_err();
        assert_eq!(error.code(), mn_core::ErrorCode::Io);
        assert!(error.to_string().contains("SQLite") || error.to_string().contains("IO"));
    }

    #[test]
    fn search_index_follows_save_rename_and_delete() {
        let (dir, state) = state_with(&[("笔记/甲.md", "旧内容\n")]);
        assert_eq!(search_query_in(&state, "旧内容", None).unwrap().total, 1);

        // 保存 = 落盘 + 增量更新索引（note_write 里就是这两步）
        let saved = "新内容 与 关键词\n";
        std::fs::write(dir.path().join("笔记").join("甲.md"), saved).unwrap();
        indexer::update_note(&state, "笔记/甲.md", saved);
        assert_eq!(search_query_in(&state, "旧内容", None).unwrap().total, 0);
        assert_eq!(search_query_in(&state, "关键词", None).unwrap().total, 1);

        // 改名 → 搜索里的路径跟着走
        rename_note_in(&state, "笔记/甲.md", "乙", true).unwrap();
        let hits = search_query_in(&state, "关键词", None).unwrap().hits;
        assert_eq!(hits[0].rel_path, "笔记/乙.md");

        // 删除 → 搜不到了
        indexer::remove_note(&state, "笔记/乙.md");
        assert_eq!(search_query_in(&state, "关键词", None).unwrap().total, 0);
    }

    #[test]
    fn search_reports_line_and_snippet_for_chinese_queries() {
        let (_dir, state) = state_with(&[("日记.md", "今天天气很好\n\n明天要下雨\n")]);

        let result = search_query_in(&state, "天气", None).unwrap();
        assert_eq!(result.total, 1);
        assert_eq!(result.hits[0].line, 1);
        assert!(result.hits[0].snippet.contains("天气"));
    }

    #[test]
    fn hostile_search_queries_do_not_error() {
        let (_dir, state) = state_with(&[("甲.md", "alpha beta\nOR 也是词\n")]);
        for query in [
            "a\"b(c)", "-x", "OR", "NEAR", "*", "(", ")", "^", "\"", "a:b",
        ] {
            assert!(
                search_query_in(&state, query, None).is_ok(),
                "查询 {query:?} 不该报错"
            );
        }
    }
}
