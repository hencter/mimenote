# ADR-0048：属性编辑（编辑器上方的属性面板）+ TOML/JSON 两种 frontmatter 写法

- 状态：已采纳（已交付）
- 日期：v0.3.0 之后（ADR-0045「编辑是下一批」的那一批）
- 相关：ADR-0045（属性展示一期）、ADR-0047（OKF + Hugo + CLI）、
  ADR-0004（原子写与冲突令牌）、ADR-0006（frontmatter 改写纪律）、ADR-0002（Markdown 是唯一事实来源）

## 背景

ADR-0045 把属性**展示**做完了（`PropertiesTable` 两处共用），但改一个属性仍然要
手动编辑 frontmatter 文本 —— 而 frontmatter 现在还有第三种写法：Hugo/Zola 的
`+++`（TOML）与 Hexo 风格的 `;;;`（JSON）。ADR-0047 已经让**宿主**（`mn-core`）
认得这两种围栏，前端却连块都找不出来。

## 决策

### 1. 属性面板挂在**编辑器**上方，阅读视图仍然只读

- 所见即所得视图里，`MarkdownEditor` 顶部渲染 `FrontmatterEditor`；
  阅读视图继续用 ADR-0045 的只读 `PropertiesTable`（"阅读视图是只读的"这条纪律
  一字未改 —— 任务复选框、图片、双链在那边也不写盘）。
- **改写走 CodeMirror 文档**：面板调 `MarkdownEditor` 给的 `apply(text)`，
  它在编辑器里派发一次整篇替换 —— 于是属性编辑自动获得撤销历史、脏标记、
  防抖自动保存、冲突横幅这四条既有能力，**没有第二条写盘路径**（ADR-0004 的
  令牌校验不会被绕开）。
- 编辑器里的 frontmatter 文本默认**折叠**（`cm/metadata-fold.ts`，`Decoration.replace`
  块级替换、只扫前 200 行）：属性已经在面板里了，重复显示两遍只会挤走正文。
  「编辑源码」按 `Compartment` 重配置掉折叠层并把光标放到第 1 行 ——
  想看原文随时有出口，且**不重建编辑器**（文档、撤销历史都留着）。

### 2. 三种围栏在前端收敛成同一个 `Record<string, unknown>`

判据只有 `domain/frontmatter-edit.ts` 一份（`metadataBlock` 认围栏 +
`parseMetadata` / `serializeMetadata` / `editMetadataField`）：

| 围栏 | 格式 | 改写方式 | 保真程度 |
| --- | --- | --- | --- |
| `---` | YAML | `yaml` 的文档模型原地改 | 注释、字段顺序、其它值的原始写法都留着 |
| `+++` | TOML | `smol-toml` 解析后**重建** | 注释保不住 ⇒ **含注释时拒绝改写**（让它去源码里改） |
| `;;;` | JSON | `JSON.parse` 后 pretty 序列化 | 没有注释可保；缩进被规范化 |

- **读不懂就不改写**：解析失败一律抛错，错误原话显示在面板里（第 2 条纪律与
  `mn-core` 的 frontmatter 改写完全一致）。
- **会丢东西的操作要拦**：TOML 带注释时改名/排序/改值都拒绝并说明原因 ——
  静默吃掉注释比报错糟得多。
- `replaceMetadata` 只替换**两个围栏之间**的那一段：BOM、正文、CRLF/LF 全部逐字保留
  （属性编辑不该产生"保存一次 = 全文 diff"）。原本没有块时按当前格式新造一个。

### 3. 顺带修掉：`+++` / `;;;` 的字段顺序

`Frontmatter::fields` 的类型文档写着"**保持文档顺序**"，而这两种围栏走的是
serde 的映射，默认按字典序排 —— 于是属性表里的顺序与正文里的写法对不上，
而前端（`frontmatter-edit.ts`）又是文档顺序，同一份数据两个真相。
修法是把 `toml` / `serde_json` 的 **`preserve_order`** 特性打开（`mn-core/Cargo.toml`
里写了原因）；`frontmatter_field_order_follows_the_document` 钉住它。

## 代价与已知边界

1. 属性面板每次操作都要 `read()` 一次全文（`viewRef.current.state.doc.toString()`）：
   一次属性操作 = 一次全文字符串 + 一次整篇替换。属性是低频操作，换来的
   "只有一条写路径"值得；
2. `+++` / `;;;` 的字段行号统一报第 2 行（逐字追行号要再写一套解析器，
   而面板只用它做定位提示）；数字字面量也不保留原文写法（`1.50` → `1.5`）。
   两处都写在 `formats.rs` 的模块文档里，不假装精确；
3. 格式转换（YAML ↔ TOML ↔ JSON）会重排整块：含注释的 YAML/TOML 先拦下并让用户
   自己处理注释；
4. 面板还没有日期选择器/开关这类**类型化输入**（ADR-0042 提到的 Base UI 那批还没接）：
   值仍是文本/标签胶囊两类，`draft` 这类布尔暂时按文本改。
