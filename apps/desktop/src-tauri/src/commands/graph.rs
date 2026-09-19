//! 知识图谱领域：全库图谱 / 自我中心子图（节点与边的组装在 `mn-index::graph`）。

use std::sync::Arc;

use tauri::State;

use mn_core::Error;
use mn_index::graph::GraphData;

use crate::error::IpcError;
use crate::indexer;
use crate::state::AppState;

use super::run_blocking;

// ---------------------------------------------------------------------------
// 知识图谱（节点 + 链接边一次下发，供前端画卡片画布）
// ---------------------------------------------------------------------------

/// 图谱节点上限（节点数超过它只返回度数最高的一部分，并置 `truncated = true`）。
///
/// 上限定在宿主/索引层（而不是前端）是为了让一次 IPC 的**报文体积有硬上限**：
/// 1 万笔记全量下发是几百 KB 量级的 JSON，而这是"打开图谱面板就会调一次"的路径。
const MAX_GRAPH_NODES: usize = mn_index::graph::MAX_GRAPH_NODES;

/// 知识图谱数据：**节点 + 链接边一次性交给前端**（前端据此画可平移缩放的卡片画布）。
///
/// 契约与口径（`src/ipc/types.ts` 手工镜像，字段名不可偏离）：
///
/// * 数据**全部来自索引**，本命令零文件 IO；遍历索引、去重、排序、截断走 `spawn_blocking`（ADR-0003）；
/// * 边按 `(from, to)` 去重，`count` 是合并后的链接条数；悬空链接 `toRelPath = null`，
///   此时 `toRawTarget` 是画布上唯一能显示"指向谁"的信息（解析成功时它同样保留用户写法）；
/// * `nodes` 按 `relPath` 字典序，`edges` 按 `fromRelPath → toRelPath（null 排最后）→ kind`，
///   前端**不做二次排序**；
/// * 节点数超过 [`MAX_GRAPH_NODES`] → 只返回度数（in + out）最高的那部分并置 `truncated = true`
///   （此时节点的度数仍是**全图**度数，可能大于它在 `edges` 里能看到的线数，见 `mn_index::graph`）；
/// * 索引未就绪/为空 → 空图谱（**不报错**），前端按 `index_status` 显示"索引构建中"；
/// * Vault 未打开 → `VAULT_NOT_SET`（与其它命令一致）。
#[tauri::command]
pub async fn graph_data(state: State<'_, Arc<AppState>>) -> Result<GraphData, IpcError> {
    let app = Arc::clone(state.inner());
    run_blocking(move || graph_data_in(&app, MAX_GRAPH_NODES)).await
}

/// 以某一篇笔记为中心的**自我中心子图**（ego graph，ADR-0021）。
///
/// 为什么要有它、而不是在前端拿 `graph_data` 的结果自己筛：`graph_data` 会在大 Vault 上按度数
/// **截断**（上限 `MAX_GRAPH_NODES`），从那批数据里做 BFS 拿到的"邻居"可能根本不完整 ——
/// 用户看到的是"这篇笔记只连着 3 篇"，而真相是"另外 7 篇被截断掉了"。邻接只有索引知道，
/// 所以 BFS 在宿主里做（纯内存索引，仍然零文件 IO）。
///
/// 契约（`src/ipc/types.ts` 手工镜像同一份 `GraphData`，字段名不可偏离）：
///
/// * 形状与 `graph_data` **完全一样**：`{ nodes, edges, truncated, elapsedMs }`，
///   两级视图共用同一个 DTO，因此卡片绘制/手工位置/命中测试都不用分支；
/// * 节点/边的口径（`(from, to)` 去重并累加 `count`、度数、`title`/`tags`/`folder`、排序）
///   与 `graph_data` **逐条相同** —— 用的是 `mn_index::graph` 里同一段组装代码；
/// * `depth` 是**双向**跳数（出链与反链都算一跳），归一化到 1..=5，缺省 1；
/// * `maxNodes` 缺省 80、上限 300；超出时按"离起点近优先 → 同层度数降序 → 路径字典序"取，
///   并置 `truncated = true`（**不静默截断**：界面要能如实说出"只显示了最近的一部分"）；
/// * 起点**永远**在结果里（哪怕它一条链接都没有）；
/// * 起点不在索引里（含索引还在构建）→ 空结果 + `truncated = false`，**不报错**：
///   前端据此显示"这篇笔记还没有进入索引"，而不是弹一条红色错误；
/// * Vault 未打开 → `VAULT_NOT_SET`（与其它命令一致）。
#[tauri::command]
pub async fn graph_ego(
    state: State<'_, Arc<AppState>>,
    rel_path: String,
    depth: Option<u32>,
    max_nodes: Option<usize>,
) -> Result<GraphData, IpcError> {
    let app = Arc::clone(state.inner());
    // 缺省值取自 `mn_index::graph`（与归一化范围同一处定义）：宿主不另写一份 1 / 80 ——
    // 否则"前端不传 depth 时走几跳"这个问题会有两个答案，取决于读的是哪份代码。
    // 越界的值不在这里夹：归一化只有一处（`ego_graph`），免得两层各夹一个不同的范围。
    let depth = depth.unwrap_or(mn_index::graph::DEFAULT_EGO_DEPTH);
    let max_nodes = max_nodes.unwrap_or(mn_index::graph::DEFAULT_EGO_MAX_NODES);
    run_blocking(move || graph_ego_in(&app, &rel_path, depth, max_nodes)).await
}

/// `graph_data` 的主体（与 Tauri 无关，可单测）。
///
/// 只做三件事：确认 Vault 已打开（否则 `VAULT_NOT_SET`）、取索引、记一条 debug 日志。
///
/// **索引为空不算错误**：那通常意味着后台索引正在构建，前端应当显示"索引构建中"
/// 而不是弹错误 —— 与 `note_tags`/`tags_list` 在索引未就绪时返回空是同一个姿态。
/// 组装规则全在 `mn_index::graph`（宿主不放业务逻辑，见 architecture.md §2 第 3 条）。
fn graph_data_in(state: &AppState, max_nodes: usize) -> mn_core::Result<GraphData> {
    if !state.is_open() {
        return Err(Error::VaultNotSet);
    }
    let data = indexer::graph_data(state, max_nodes);
    log::debug!(
        "图谱数据：{} 节点 / {} 边（截断 {}），组装 {}ms",
        data.nodes.len(),
        data.edges.len(),
        data.truncated,
        data.elapsed_ms
    );
    Ok(data)
}

/// `graph_ego` 的主体（与 Tauri 无关，可单测）。
///
/// 与 [`graph_data_in`] 同一姿态：只确认 Vault 已打开（否则 `VAULT_NOT_SET`）、取索引、
/// 记一条 debug 日志；组装与筛选全在 `mn_index::graph`（宿主不放业务逻辑）。
///
/// **起点不在索引里不算错误**：那通常意味着后台索引还没收录这一篇（刚打开 Vault 就是这种
/// 情形），前端据此显示"这篇笔记还没有进入索引"，比弹一条红色提示有用得多 ——
/// 与"索引为空时 `graph_data` 返回空图谱"是同一个口径。
///
/// 这里直接取索引而不是像全图那样经 `indexer::graph_data` 转发：那一层是给"全图 + 多处复用"
/// 准备的壳，自我中心子图只有这一个调用点，再包一层只会多一个改一处忘一处的地方。
fn graph_ego_in(
    state: &AppState,
    rel_path: &str,
    depth: u32,
    max_nodes: usize,
) -> mn_core::Result<GraphData> {
    if !state.is_open() {
        return Err(Error::VaultNotSet);
    }
    let data = state.index_write().ego_graph(rel_path, depth, max_nodes);
    log::debug!(
        "自我中心图谱：{rel_path} 双向 {depth} 跳 → {} 节点 / {} 边（截断 {}），组装 {}ms",
        data.nodes.len(),
        data.edges.len(),
        data.truncated,
        data.elapsed_ms
    );
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::notes::rename_note_in;
    use crate::commands::testkit::*;
    use std::time::Instant;

    #[test]
    fn graph_without_vault_is_rejected() {
        let state = AppState::default();
        let error = graph_data_in(&state, MAX_GRAPH_NODES).unwrap_err();
        assert_eq!(error.code(), mn_core::ErrorCode::VaultNotSet);
        assert_eq!(
            IpcError::from(error).code,
            "VAULT_NOT_SET",
            "跨 IPC 的错误码必须与其它命令一致"
        );
    }

    #[test]
    fn graph_data_returns_the_canvas_contract() {
        let (_dir, state) = state_with(&[
            (
                "项目/设计.md",
                "---\ntitle: 设计文档\ntags: [项目]\n---\n\n见 [[路线图]] 与 [[还不存在]]\n",
            ),
            ("项目/路线图.md", "# 路线图\n"),
        ]);

        let data = graph_data_in(&state, MAX_GRAPH_NODES).unwrap();
        assert!(!data.truncated);
        assert_eq!(
            data.nodes
                .iter()
                .map(|node| node.rel_path.as_str())
                .collect::<Vec<_>>(),
            vec!["项目/设计.md", "项目/路线图.md"],
            "节点按 relPath 字典序（前端不二次排序）"
        );

        let design = &data.nodes[0];
        assert_eq!(design.title, "设计文档", "frontmatter 的 title 优先");
        assert_eq!(design.folder, "项目");
        assert_eq!(design.tags, vec!["项目".to_string()]);
        assert_eq!(design.out_degree, 2, "→路线图 + 悬空");
        assert_eq!(design.in_degree, 0);

        let roadmap = &data.nodes[1];
        assert_eq!(
            roadmap.title, "路线图",
            "没有 frontmatter title → 文件名主干"
        );
        assert_eq!(roadmap.in_degree, 1);
        assert_eq!(roadmap.out_degree, 0);

        assert_eq!(data.edges.len(), 2);
        assert_eq!(data.edges[0].from_rel_path, "项目/设计.md");
        assert_eq!(data.edges[0].to_rel_path.as_deref(), Some("项目/路线图.md"));
        assert_eq!(data.edges[0].to_raw_target, "路线图");
        assert_eq!(data.edges[0].count, 1);
        assert_eq!(data.edges[1].to_rel_path, None, "悬空边排在最后");
        assert_eq!(
            data.edges[1].to_raw_target, "还不存在",
            "悬空边靠原始写法显示'指向谁'"
        );

        // JSON 字段名必须与前端类型逐字一致（camelCase，一个 snake_case 都不能有）
        let json = serde_json::to_string(&data).unwrap();
        for key in [
            "\"nodes\"",
            "\"edges\"",
            "\"truncated\"",
            "\"elapsedMs\"",
            "\"relPath\"",
            "\"title\"",
            "\"folder\"",
            "\"tags\"",
            "\"outDegree\"",
            "\"inDegree\"",
            "\"fromRelPath\"",
            "\"toRelPath\"",
            "\"toRawTarget\"",
            "\"kind\"",
            "\"count\"",
        ] {
            assert!(json.contains(key), "缺少字段 {key}：{json}");
        }
        assert!(
            json.contains("\"toRelPath\":null"),
            "悬空链接是 null：{json}"
        );
        assert!(
            json.contains("\"toRawTarget\":\"还不存在\""),
            "悬空边的原始写法：{json}"
        );
        assert!(json.contains("\"kind\":\"wiki\""), "实际：{json}");
        assert!(json.contains("\"outDegree\":2"), "实际：{json}");
        for snake in [
            "rel_path",
            "out_degree",
            "in_degree",
            "from_rel_path",
            "to_rel_path",
            "to_raw_target",
            "elapsed_ms",
        ] {
            assert!(!json.contains(snake), "不该出现 snake_case {snake}：{json}");
        }
    }

    #[test]
    fn graph_is_empty_not_an_error_while_the_index_is_building() {
        let (_dir, state) = state_with(&[("甲.md", "[[乙]]\n"), ("乙.md", "# 乙\n")]);
        // 打开 Vault 后索引在后台重建（indexer::reset 就是 clear + 状态归零）
        indexer::reset(&state);

        let data = graph_data_in(&state, MAX_GRAPH_NODES).unwrap();
        assert!(data.nodes.is_empty(), "索引还没收录任何笔记");
        assert!(data.edges.is_empty());
        assert!(!data.truncated, "空索引不算'被截断'");
    }

    #[test]
    fn graph_ego_without_vault_is_rejected() {
        // 与 graph_data 同一个错误码口径：Vault 未打开是**调用方**的错误，不是"索引里没有这篇"
        let state = AppState::default();
        let error = graph_ego_in(&state, "甲.md", 1, 80).unwrap_err();
        assert_eq!(error.code(), mn_core::ErrorCode::VaultNotSet);
        assert_eq!(IpcError::from(error).code, "VAULT_NOT_SET");
    }

    #[test]
    fn graph_ego_serializes_to_the_frontend_contract() {
        let (_dir, state) = state_with(&[
            (
                "中心.md",
                "---\ntitle: 中心\ntags: [项目]\n---\n\n[[邻.md]] 与 [[还没有]]\n",
            ),
            ("邻.md", "见 [[中心]]\n"),
            ("无关.md", "谁都不认识\n"),
        ]);

        // 双向一跳：出链（邻.md）与反链都在（邻.md 也指回中心），无关.md 不出现
        let data = graph_ego_in(&state, "中心.md", 1, 80).unwrap();
        assert_eq!(
            data.nodes
                .iter()
                .map(|node| node.rel_path.as_str())
                .collect::<Vec<_>>(),
            vec!["中心.md", "邻.md"],
            "节点按 relPath 字典序（前端不二次排序）"
        );
        assert!(!data.truncated);
        assert_eq!(
            data.edges.len(),
            3,
            "中心→邻、邻→中心（双向都在），外加起点自己那条悬空边"
        );
        assert_eq!(
            data.nodes[0].out_degree, 2,
            "度数是全图口径（与 graph_data 逐字相同）"
        );

        // 起点不在索引里：空结果 + truncated=false，**不报错**（前端据此显示"还没进入索引"）
        let missing = graph_ego_in(&state, "还没进索引.md", 1, 80).unwrap();
        assert!(missing.nodes.is_empty());
        assert!(missing.edges.is_empty());
        assert!(!missing.truncated);

        // JSON 字段名必须与前端类型逐字一致（camelCase，一个 snake_case 都不能有）
        let json = serde_json::to_string(&data).unwrap();
        for key in [
            "\"nodes\"",
            "\"edges\"",
            "\"truncated\"",
            "\"elapsedMs\"",
            "\"relPath\"",
            "\"title\"",
            "\"folder\"",
            "\"tags\"",
            "\"outDegree\"",
            "\"inDegree\"",
            "\"fromRelPath\"",
            "\"toRelPath\"",
            "\"toRawTarget\"",
            "\"kind\"",
            "\"count\"",
        ] {
            assert!(json.contains(key), "缺少字段 {key}：{json}");
        }
        assert!(
            json.contains("\"toRelPath\":null"),
            "悬空链接是 null：{json}"
        );
        assert!(json.contains("\"outDegree\":2"), "实际：{json}");
        for snake in [
            "rel_path",
            "out_degree",
            "in_degree",
            "from_rel_path",
            "to_rel_path",
            "to_raw_target",
            "elapsed_ms",
            "max_nodes",
        ] {
            assert!(!json.contains(snake), "不该出现 snake_case {snake}：{json}");
        }
    }

    #[test]
    fn graph_follows_save_rename_and_delete() {
        let (dir, state) = state_with(&[("甲.md", "[[乙]]\n"), ("乙.md", "# 乙\n")]);
        let before = graph_data_in(&state, MAX_GRAPH_NODES).unwrap();
        assert_eq!(before.edges[0].to_rel_path.as_deref(), Some("乙.md"));

        // 保存：链接改成还不存在的目标 → 变成悬空边（toRelPath = null）
        let saved = "[[丙]]\n";
        std::fs::write(dir.path().join("甲.md"), saved).unwrap();
        indexer::update_note(&state, "甲.md", saved);
        let after_save = graph_data_in(&state, MAX_GRAPH_NODES).unwrap();
        assert_eq!(after_save.edges[0].to_rel_path, None);
        assert_eq!(
            after_save.edges[0].to_raw_target, "丙",
            "悬空边仍然带着用户写的目标名（画布上要显示它）"
        );
        assert_eq!(
            after_save
                .nodes
                .iter()
                .find(|node| node.rel_path == "乙.md")
                .unwrap()
                .in_degree,
            0,
            "乙 已经没人指向它了"
        );

        // 改名：节点路径与指向它的链接一起跟上（改写走的是同一份索引）
        rename_note_in(&state, "乙.md", "戊", true).unwrap();
        let after_rename = graph_data_in(&state, MAX_GRAPH_NODES).unwrap();
        assert!(after_rename
            .nodes
            .iter()
            .any(|node| node.rel_path == "戊.md"));
        assert!(!after_rename
            .nodes
            .iter()
            .any(|node| node.rel_path == "乙.md"));

        // 删除：节点消失；甲 指向不存在目标的悬空边不受影响
        indexer::remove_note(&state, "戊.md");
        let after_delete = graph_data_in(&state, MAX_GRAPH_NODES).unwrap();
        assert_eq!(after_delete.nodes.len(), 1);
        assert_eq!(after_delete.edges.len(), 1);
        assert_eq!(after_delete.edges[0].to_rel_path, None);
    }

    #[test]
    fn graph_truncates_from_the_host_entry_point() {
        let (_dir, state) = state_with(&[
            ("a.md", "[[b]] [[c]]\n"),
            ("b.md", ""),
            ("c.md", ""),
            ("d.md", ""),
        ]);

        let data = graph_data_in(&state, 3).unwrap();
        assert!(data.truncated);
        assert_eq!(
            data.nodes
                .iter()
                .map(|node| node.rel_path.as_str())
                .collect::<Vec<_>>(),
            vec!["a.md", "b.md", "c.md"],
            "度数最高的 a（2）+ 并列的 b/c（各 1，按路径定序）"
        );
        assert_eq!(data.edges.len(), 2, "指向被丢弃的 d.md 的边一起过滤");
        assert_eq!(
            data.nodes[0].out_degree, 2,
            "度数仍是全图度数（见 mn_index::graph 模块文档）"
        );
    }

    /// 合成一套 1 万笔记 / 100 目录的索引：每篇 frontmatter（title + 2 个标签）+ 2 条出链。
    ///
    /// `dangling_every = 0` → 所有链接都能解析；否则每 N 篇多一条指向**不存在笔记**的链接
    /// （悬空链接在真实 Vault 里很常见：先写下 `[[还没写的笔记]]`）。
    /// 第二个返回值是待解析的 `(from, target)` 列表 —— 供基准里**单独**测一遍解析成本。
    fn synthetic_graph_index(
        dangling_every: usize,
    ) -> (mn_index::LinkIndex, Vec<(String, String)>) {
        let mut index = mn_index::LinkIndex::new();
        let mut pairs: Vec<(String, String)> = Vec::new();
        for d in 0..100usize {
            for f in 0..100usize {
                let i = d * 100 + f;
                let rel = format!("dir{d:03}/note{i:04}.md");
                let mut text = format!(
                    "---\ntitle: 笔记 {i}\ntags: [标签{}, 标签{}]\n---\n\n第 {i} 篇的正文。\n\n",
                    i % 50,
                    i % 200,
                );
                for target in [(i + 1) % 10_000, (i + 7) % 10_000] {
                    let target = format!("note{target:04}");
                    text.push_str(&format!("[[{target}]] 与 "));
                    pairs.push((rel.clone(), target));
                }
                if dangling_every > 0 && i % dangling_every == 0 {
                    let target = format!("不存在{i}");
                    text.push_str(&format!("[[{target}]]\n"));
                    pairs.push((rel.clone(), target));
                }
                index.upsert(&rel, &text);
            }
        }
        (index, pairs)
    }

    /// 性能基准：1 万笔记的图谱组装耗时与 **IPC 报文体积**。
    ///
    /// 运行：`cargo test -p mimenote --release -- --ignored --nocapture bench_graph_data_10k_notes`
    ///
    /// 为什么需要它：`graph_data` 是第一个"把全库一次性交给前端"的命令，报文体积与耗时必须有
    /// 真实数字（前端画布据此决定虚拟化与降级策略）。索引直接**在内存里 upsert**出来，不碰磁盘 ——
    /// 测到的就是这条命令本身的成本，不含索引构建与文件 IO。
    ///
    /// 两套数据（A 无悬空 / B 5% 悬空）是为了**归因**：悬空目标会走
    /// `mn_index` 的 `by_path` 后缀兜底扫描（O(全库路径数)），这正是图谱最贵的一类输入。
    #[test]
    #[ignore]
    fn bench_graph_data_10k_notes() {
        let building = Instant::now();
        let (resolvable, resolvable_pairs) = synthetic_graph_index(0);
        let (with_dangling, dangling_pairs) = synthetic_graph_index(20);
        let build_ms = building.elapsed().as_millis();

        eprintln!("图谱 1 万笔记（两套索引在内存里 upsert 共 {build_ms} ms）：");
        report_graph_bench("A 全部可解析", &resolvable, &resolvable_pairs);
        let (truncated, full) =
            report_graph_bench("B 5% 笔记多一条悬空链接", &with_dangling, &dangling_pairs);

        assert!(truncated.truncated);
        assert_eq!(truncated.nodes.len(), mn_index::graph::MAX_GRAPH_NODES);
        assert!(!full.truncated);
        assert_eq!(full.nodes.len(), 10_000);
        assert_eq!(full.edges.len(), 20_500, "2 万条可解析 + 500 条悬空合并");
    }

    /// 打印一套数据的「解析归因 + 组装耗时 + 报文体积」。
    fn report_graph_bench(
        label: &str,
        index: &mn_index::LinkIndex,
        pairs: &[(String, String)],
    ) -> (mn_index::GraphData, mn_index::GraphData) {
        // 归因：单独把这批链接解析一遍（与图谱内部用的是同一个 resolve_target）
        let started = Instant::now();
        let mut resolved = 0usize;
        for (from, target) in pairs {
            resolved += usize::from(index.resolve(from, target).is_some());
        }
        let resolve_ms = started.elapsed().as_millis();

        let started = Instant::now();
        let truncated = index.graph_data(mn_index::graph::MAX_GRAPH_NODES);
        let truncated_ms = started.elapsed().as_millis();
        let truncated_kb = serde_json::to_string(&truncated).unwrap().len() as f64 / 1024.0;

        let started = Instant::now();
        let full = index.graph_data(usize::MAX);
        let full_ms = started.elapsed().as_millis();
        let full_kb = serde_json::to_string(&full).unwrap().len() as f64 / 1024.0;

        eprintln!(
            "{label}：{} 条链接（解析成功 {resolved}），单独解析 {resolve_ms} ms\n\
             \x20 截断（上限 3000）：{} 节点 / {} 边，组装 {truncated_ms} ms，JSON {truncated_kb:.0} KB\n\
             \x20 全量（上限 1 万）：{} 节点 / {} 边，组装 {full_ms} ms，JSON {full_kb:.0} KB",
            pairs.len(),
            truncated.nodes.len(),
            truncated.edges.len(),
            full.nodes.len(),
            full.edges.len(),
        );
        (truncated, full)
    }
}
