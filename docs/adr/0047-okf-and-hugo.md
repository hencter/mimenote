# ADR-0047：OKF 原生支持 + Hugo frontmatter 参照 + CLI 起步

- 状态：已采纳（第一批已交付）
- 日期：v0.3.0 之后（用户需求：文档原生 OKF + 本地 SSG CMS + CLI 端开工）
- 相关：ADR-0002（Markdown 唯一事实来源）、ADR-0006（frontmatter 纪律）、
  ADR-0019（静态站点）、ADR-0045（属性展示）

## 背景

Google OKF v0.2（Open Knowledge Format）：目录式 Markdown + YAML frontmatter
知识包，`type` 唯一必填，`index.md` / `log.md` 为保留文件，另有信任/生命周期
家族（`generated` / `verified` / `sources` / `status` / `stale_after`）。
Hugo 的 frontmatter（`title` / `date` / `draft` / `tags` / `slug` / `url` /
`aliases`）是另一份参照：它是 SSG 的事实标准，字段语义经过十年沉淀。

我们的笔记天然接近 OKF（Markdown + YAML），差的是三件事：
嵌套字段读不出来、包级合规没人检查、SSG 只活在应用里。

## 决策

### 1. 解析器加一层映射（`mn-core::frontmatter`，本批）

- 新增 `Map(Vec<FrontmatterField>)` / `MapList(Vec<Vec<FrontmatterField>>)`，
  覆盖行内流式 `{k: v}` 与块内一级映射（含 `- k: v` 续行）；
  再深的结构忽略（文档里写死"一层"，不猜）；
- 首项定形态（块列表）、混排丢纯文本项（病态输入，记录在案）；
- 编辑路径（`set_tags` / 改名 / 标量 upsert）**永不碰**映射形态（原样返回）：
  看不懂的结构不配拥有改写权；
- 标签抽取跳过映射（`tags: {a: b}` 不贡献标签，与 Bool/Null 同等待遇）；
- TS 镜像同步（`map` / `mapList`），属性表结构化渲染（子行 / 分组），
  `check:ipc` 无需改动（联合加法，清单只核对字段名）。

### 2. 合规检查是新模块（`mn-core::okf`，本批），不是索引的附庸

- 纯函数，输入 `(路径, 全文)` 列表：缺块/缺 `type`/空 `type` = Error；
  无链接的 `index.md` = Warning；链接不可达 = Error（近似口径：
  裸名先拼同目录，带 `/` 走全路径后缀，再退主干；外链/锚点/嵌入跳过）；
- 未知 `type` 不是问题（规范原话：消费者必须容忍）；
- `suspendisse`：悬空 wikilink 在本应用日常语义里是"待建概念"，
  在 OKF 里是不合规 —— 检查器定位是**发布前门禁**，不是写作实时标红。

### 3. CLI 端开工（`apps/cli`，二进制 `mimenote-cli`，本批）

- 与桌面应用共用 `mn-core`；首批命令只有 `okf check <vault> [--json]`
  （退出码 0 合规 / 1 有 Error / 2 用法 IO 错误）；
- 二进制名刻意不叫 `mimenote`：`target/debug/mimenote.exe` 是桌面应用的，
  同名会互锁（实测踩过，见提交说明）；
- **红线**：HTML 渲染永不进 CLI（渲染管线只有前端一份，复刻第二份等于
  两个真相）。`export-site` 的 HTML 构建永远走应用内导出；
  CLI 只碰文本层（检查、索引生成这类）。

### 4. Hugo 映射（本批只定映射，不动实现）

| Hugo | 我们 | 落点 |
| --- | --- | --- |
| `title` / `date` | 已有（属性表展示） | — |
| `draft` | 无 | 下一批：站点导出跳过 `draft: true`（计划层过滤，不删文件） |
| `slug` / `url` | 无（输出路径由索引分配） | 下一批：允许覆盖本页输出路径（需防 `..` 越界，与导出白名单同一审查） |
| `aliases` | 无 | 不做（双链解析是文件名口径，别名会引入第二套身份） |
| `tags` / `categories` | `tags` 已有；无 categories | 不做（单标签体系，层级标签已覆盖分类需求） |
| `created_at` / `updated_at`（OKF 风格） | `created` / `updated`（ADR-0044） | 显示层都认（时钟图标）；合规检查不看时间字段（只有 `type` 必填） |

## 代价与后续

1. `index.md` 生成器（`okf index`）是下一批：需要 §6 全文逐条实现，
   本批只读不写；
2. `okf_version` 只认不验（best-effort 原则）；
3. 检查复杂度 O(文件 × 链接)，万篇库约秒级 —— CI 门禁可用，编辑器实时检查不可用。
