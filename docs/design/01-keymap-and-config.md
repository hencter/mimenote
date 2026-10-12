# 设计 01：键位系统与配置文件（TOML / YAML / JSON）

- 状态：**已定稿，进入实现**（Lead 负责；对应 ADR-0055）
- 日期：2026-10-12
- 前置：ADR-0005（命令注册表）、ADR-0027（界面偏好）、ADR-0048（三格式 frontmatter 的纪律）

## 0. 要解决的三件事

1. **键位不够顺**：现行默认表里有几处按人体工学说不通（`Mod+O` 给了低频的"打开 Vault"、
   命令面板与快速切换的选择没有频率依据、`Mod+B` 被"显示/隐藏侧栏"占着 —— 而它在任何编辑器里
   都是"加粗"）。
2. **键位不可配**：`Command.keybinding` 是写死的字符串，用户没有任何覆盖入口。
3. **设置不可移植**：偏好只存在 `localStorage`（`mimenote.settings.v1`），换机器、换 Vault
   什么都不带走，也不能被 git 管理 —— 与"本地优先、文件即真相"的定位不符。

## 1. 三个设计决定

### 决定 1：键位解析 = 默认表 + 档案（profile）+ 用户覆盖

`Command.keybinding` 的语义**收窄为"默认值"**，不再是运行时唯一真相。
运行时的解析链（自上而下，先命中者胜）：

```
用户覆盖（配置文件 keymap.bindings）
  ↓ 未覆盖
档案（keymap.profile：mimenote | obsidian | vscode）
  ↓ 档案里没有这条命令
默认表（Command.keybinding）
  ↓ 也没有
该命令没有快捷键（只能从命令面板触发）
```

- **档案是"整套心智模型"，不是零散别名**。`obsidian` 档案只重写那些"Obsidian 用户手上有肌肉记忆"
  的命令（见 §3.2），其余继承默认表。
- **用户覆盖粒度是命令，不是键**：`{ command: "note.save", chords: ["Mod+S"] }`。
  `chords = []` 表示**显式解绑**（"这个动作我不要快捷键"），与"没配"是两件事。
- 覆盖冲突**必须被看见**：同一 chord 命中多条命令时
  ① 命令面板里两条都标出冲突；② 设置页给出红字清单；③ 分发时按"用户覆盖 > 档案 > 默认"的
  同一优先级裁决，同层冲突则按命令 id 字典序取第一条并记 warn 日志。**绝不静默丢键**。

### 决定 2：配置文件是 Vault 内的 `config.<ext>`，支持三种格式

位置与优先级（**只有第一个存在的生效**，其余忽略；界面里显示"当前生效的是哪一个"）：

```
<Vault>/.mimenote/config.toml     ← 首选
<Vault>/.mimenote/config.yaml
<Vault>/.mimenote/config.yml
<Vault>/.mimenote/config.json
```

- 三种格式**同构**：同一份 schema、同一套校验与默认值，只是序列化不同。
  解析复用前端已有依赖（`smol-toml` / `yaml` / 原生 `JSON`），**不为配置文件新增任何依赖**。
- 与 ADR-0048 同一条纪律：**含注释的 TOML/YAML 拒绝改写**（`smol-toml` 与 `yaml` 的序列化都不带注释）。
  界面上如实说明"请在源码中编辑"，而不是静默吃掉用户的注释。
- 应用**首次生成的配置文件不含任何注释**，所以"应用自己写的文件"永远能被应用改写 ——
  注释只在用户手写时才出现，此时把写权交还给用户。
- schema 带 `version = 1`：读到更大的版本号 → 只读不写（避免旧版本破坏新版本的配置），
  界面提示"这份配置由更新的 Mimenote 写入"。

### 决定 3：分层与优先级

```
DEFAULT_SETTINGS（代码里的默认值，永远兜底）
  ↓
localStorage `mimenote.settings.v1`（**旧值迁移来源** + 门闸页兜底）
  ↓
<Vault>/.mimenote/config.<ext>（**Vault 作用域的真相**：存在时它赢）
  ↓
会话态（`settings.open` / 上次分区等，不落盘）
```

- localStorage **始终写一份镜像**，但只在两种情况下被**读**：没有打开 Vault 时（门闸页）、
  以及"Vault 内还没有配置文件"时的首次迁移。规矩只有一条：**配置文件存在时它赢**。
- **首次启动迁移**：若 Vault 内没有配置文件，就把当前值（默认值 ∪ localStorage 里的旧值）
  **写入新建的 config.toml**。迁移只在"配置文件不存在"时发生，且写盘走原子写。
- 换 Vault：读那个 Vault 的配置；找不到就按上一条迁移生成。**用户的键位随 Vault 走** ——
  这正是"配置文件放 Vault 里"的价值。
- 应用级（跨 Vault）偏好仍是 localStorage：窗口位置、上次分区、`settings.open` 这类会话态。

## 2. 配置文件 schema（v1）

分组与代码里的字段一一对应（**不发明第二套命名**）：

```toml
version = 1

[keymap]
profile = "mimenote"          # mimenote | obsidian | vscode

# 规范写法：每条命令一项；chords 为空数组 = 显式解绑
[[keymap.bindings]]
command = "note.save"
chords = ["Mod+S"]

[ui]
fontSize = 16                 # → SettingsValues.uiFontSize

[editor]
fontSize = 16
readingFontSize = 16
autosaveDelayMs = 600
tabWidth = 4
lineNumbers = true
frontmatterTimestamps = false

[tree]
layout = "single"             # single | columns（ADR-0058）

[vault]
attachmentDir = "attachments"

[inbox]
dir = "Inbox"                # 收件箱（独立目录，相对 Vault 根，ADR-0057）

[templates]
dir = ".mimenote/templates"  # 模板目录（ADR-0056）
```

- **主题不在配置文件里**：主题归 `ui-store` 的 `themeId`（它有自己的持久化与主题 JSON），
  搬进配置会变成第二个真相源。
- `keymap.bindings` **宽容读、严格写**：也认顺手的映射写法
  （`[keymap.bindings]` 下 `"note.save" = ["Mod+S"]`），但写回永远只有上面的规范形态。
- 未知键：**忽略但记日志**（不报错、不阻断启动）—— 配置文件的向前兼容靠这条。
- 类型错误：该字段回退默认值 + 在设置页列出来（与 `restoreValues()` 的"逐字段校验"同一条纪律）。

## 3. 默认键位表（QWERTY 人体工学）

### 3.1 分层原则（这是"人体工学"的全部依据）

| 层级 | 形态 | 用于 | 为什么 |
| --- | --- | --- | --- |
| **L1 高频** | `Mod + 单字母` | 每分钟都会按的动作（保存、快切、加粗、切视图） | 一个小指 + 一个食指，无 Shift、无跨手 |
| **L2 中频** | `Mod + Shift + 单字母` | 每小时几次（面板开关、搜索、捕获） | 多一个小指动作，换来与 L1 完全分离的空间 |
| **L3 低频/次级** | `Mod + Alt + 单字母` | 每天几次、或**破坏性/难逆**动作（重扫、移动、重置） | 三键组合天然劝退误按 |
| **L4 导航** | `Mod + 数字` / `Mod + Tab` | 标签页切换 | 与浏览器/编辑器一致 |

补充规则：

- **字母选在左右手食指/中指的自然落点**（E R T / D F G / U I O / J K L / B N M），
  避开需要跨手（左手按 B 同时右手按 Shift）与小指外伸（P / Q / Z）的高频组合。
- **同一语义尽量同键同层**：`Mod+B` 加粗、`Mod+Shift+B` 是"和 B 有关的面板"（文件树）；
  面板一律 `Mod+Shift+<记忆字母>`。
- **`Mod+O`（右手无名指，高频可达）不再给低频动作**：它让给"快速切换"以兼容 Obsidian；
  "打开 Vault"降到 L3。
- **不新增任何 `Mod+Shift+<罕见字母>` 的高频动作**（Q/Z/X 之外尽量不用 Shift+小指）。

### 3.2 完整默认表（`mimenote` 档案）

**编辑与文档（L1 为主）**

| 命令 id | 默认键位 | 说明 |
| --- | --- | --- |
| `note.new` | `Mod+N` | 新建笔记（不变） |
| `note.save` | `Mod+S` | 保存（不变；自动保存之外的显式出口） |
| `note.formatBold` | **`Mod+B`** | **新增**：加粗（选中即包裹，无选区插入成对标记） |
| `note.formatItalic` | **`Mod+I`** | **新增**：斜体 |
| `note.formatLink` | **`Mod+K`** | **新增**：插入 Markdown 链接（有选中文字 + 剪贴板是 URL 时直接成链接） |
| `note.formatCode` | **`Mod+Shift+K`** | **新增**：行内代码 |
| `note.formatStrike` | **`Mod+Shift+X`** | **新增**：删除线 |
| `note.reload` | `Mod+Alt+L` | 从磁盘重新加载（不变） |
| `note.formatTable` | `Mod+Alt+F` | 表格格式化（不变） |

**导航（L1 / L2）**

| 命令 id | 默认键位 | 说明 |
| --- | --- | --- |
| `palette.quickSwitch` | `Mod+P` | 快速切换笔记（最高频，右手食指；Obsidian 档案里是 `Mod+O`） |
| `palette.open` | **`Mod+Shift+P`** | 命令面板（VS Code 一致；原 `Mod+K` 让给"插入链接"） |
| `search.open` | `Mod+Shift+F` | 全文搜索（不变） |
| `settings.open` | `Mod+,` | 打开设置（不变） |

**视图与面板（L1 / L2）**

| 命令 id | 默认键位 | 说明 |
| --- | --- | --- |
| `view.cycleMode` | `Mod+E` | 编辑 ⇄ 阅读（**两态切换**；图谱有自己的键） |
| `view.graph` | `Mod+G` | 知识图谱（与 Obsidian 一致） |
| `view.toggleSidebar` | **`Mod+Shift+B`** | 文件树开关（原 `Mod+B` 让给加粗） |
| `tree.toggleColumns` | **`Mod+Alt+C`** | **新增**：单栏 ⇄ 双栏（Miller）文件树 |
| `view.toggleLinksPanel` | `Mod+Shift+L` | 链接面板 |
| `view.toggleTagsPanel` | `Mod+Shift+T` | 标签面板 |
| `view.toggleOutlinePanel` | `Mod+Shift+O` | 大纲面板 |
| `view.toggleLineNumbers` | **`Mod+Alt+N`** | **新增键位**：行号开关（原先没有键位） |

**捕获（L2）**

| 命令 id | 默认键位 | 说明 |
| --- | --- | --- |
| `inbox.capture` | **`Mod+Shift+I`** | **新增**：快速捕获（一行输入 → 追加到收件箱） |
| `inbox.open` | **`Mod+Alt+I`** | **新增**：打开收件箱视图 |

**模板（L2）**

| 命令 id | 默认键位 | 说明 |
| --- | --- | --- |
| `template.newFrom` | **`Mod+Shift+N`** | **新增**：从模板新建（与 `Mod+N` 成对） |

**Vault / 导出 / 外观（L3）**

| 命令 id | 默认键位 |
| --- | --- |
| `vault.open` | **`Mod+Alt+O`**（原 `Mod+O`） |
| `vault.rescan` | `Mod+Alt+R` |
| `export.html` | `Mod+Shift+S` |
| `export.pdf` | **`Mod+Alt+P`**（原 `Mod+Shift+P` —— 与新命令面板撞车，见 §6 第 8 条的实测） |
| `export.site` | `Mod+Alt+S` |
| `tree.expandAll` / `tree.collapseAll` | `Mod+Alt+E` / `Mod+Alt+W` |
| `tree.focusFilter` | `Mod+Shift+E` |
| `theme.next` | `Mod+Alt+T` |
| `help.about` | `Mod+Alt+A` |

**图谱（L1，仅图谱视图内生效）**：`Mod+=` 放大、`Mod+-` 缩小、`Mod+0` 适应窗口、`Escape` 关浮窗。
**标签导航（L4）**：`Mod+1..9` 跳到第 N 个标签、`Mod+W` 关闭当前标签、
`Mod+Tab` / `Mod+Shift+Tab` 前后切换（现状保留）。

### 3.3 `obsidian` 档案（只重写有肌肉记忆的 5 条）

| 命令 id | mimenote 默认 | obsidian 档案 |
| --- | --- | --- |
| `palette.quickSwitch` | `Mod+P` | `Mod+O` |
| `palette.open` | `Mod+Shift+P` | `Mod+P` |
| `vault.open` | `Mod+Alt+O` | `Mod+Shift+O` |
| `view.cycleMode` | `Mod+E` | `Mod+E`（一致，不需要重写） |
| `settings.open` | `Mod+,` | `Mod+,`（一致） |

`vscode` 档案同理（`Mod+P` 快切 / `Mod+Shift+P` 面板 / `Mod+B` 侧栏 —— 但侧栏与加粗冲突，
因此 vscode 档案里 `view.toggleSidebar` 保持 `Mod+Shift+B`，并在设置页写明这条**故意的不一致**）。

## 4. 宿主接口（窄面）

前端不能直接读写任意路径（ADR-0001/0011 的能力收窄纪律）。新增两条**只认这三个文件名**的命令：

```
config_read()                     -> { path: string | null, format: 'toml'|'yaml'|'json'|null, content: string | null }
config_write(format, content)     -> { path: string }
```

- **不接受路径参数**：以当前打开的 Vault 为准（宿主 `AppState` 里就有，与 `snippets_list` 一致），
  文件名由格式唯一决定 —— 调用方无从指定目录。
- 读：只在 `<root>/.mimenote/` 下按优先级找 4 个文件名，**不做目录遍历**；
  命中即返回原文（不解析 —— 解析在前端，格式判据只有一份）。
- 写：扩展名白名单 `toml|yaml|yml|json`，路径由格式决定，**不接受调用方给的文件名**；
  内容 ≤ 256 KiB；走 `mn_core::atomic::write_atomic`（同目录临时文件 → fsync → rename）。
- 越界/符号链接检查复用 `path_guard`，与 `export_write_html` 同一条纪律。
- 定位与写入逻辑在 `crates/mn-core/src/config.rs`（可独立 `cargo test`），宿主命令只做映射。

## 5. 实现落点（写权限划分）

| 文件 | 归属 |
| --- | --- |
| `app/commands.ts`（解析链接口）、`app/keymap.ts`、`app/builtin-commands.ts` | Lead |
| `domain/keymap.ts`（解析判据 + 键盘原语）、`state/keymap-store.ts`（派生层，不持有偏好） | Lead |
| `state/settings-store.ts`（**配置文件的唯一写者**：偏好值 + `[keymap]` 都在这里） | Lead |
| `domain/config-file.ts`（新，三格式解析/序列化/注释判据） | Lead |
| `features/settings/KeymapSection.tsx`、`ConfigSection.tsx`、`SettingsDialog.tsx`、`settings.css` | Lead |
| `ipc/{types,client,mock-adapter}.ts` | Lead |
| `src-tauri/src/commands/config.rs`、`crates/mn-core/src/config.rs` | Lead |
| `features/editor/cm/format.ts`（加粗/斜体/行内代码/删除线/链接） | Lead |

> 键位状态为什么不存在 `keymap-store` 里：`profile` 与 `overrides` 是**偏好值**，
> 必须和别的偏好一起写进**同一个**配置文件。两个 store 各写一次 `config.toml`
> 就会出现"谁后写谁赢"的丢字段问题 —— 配置文件的写者只能有一个。
> `keymap-store` 因此是**派生层**：装解析器、算冲突、查当前键位，不持有状态。

## 6. 验收（进入测试阶段的判据）

1. 三种格式各自能被读出并生效（同一份配置改格式，行为完全一致）。
2. 含注释的 TOML/YAML：拒绝改写 + 界面给出可操作提示；无注释的文件能被应用改写。
3. 用户覆盖生效：改 `config.toml` 后重启，键位跟随；解绑（`chords = []`）后该键不再触发。
4. 冲突可见：故意把两条命令绑到同一键 → 设置页列出冲突，命令面板两条都标注。
5. 全新 Vault 首次打开：自动生成 `config.toml`（**不写注释**，改为在设置页展示当前生效路径与 schema 版本）。
6. `Mod+B` / `Mod+I` 在编辑器里对**选中文字**生效、无选区时插入成对标记、且**一次撤销**回退。
7. 旧 localStorage 偏好迁移一次，且迁移后改配置文件不再被 localStorage 覆盖。
8. **整张默认表没有"结构性重叠"**（`tests/keymap-defaults.test.tsx`）：判据不看 `when()` ——
   只看"同一 chord 的所有者里有没有非 `graph.*` 的命令"。
   > 这条是从一个**真实缺陷**里长出来的：本设计把命令面板放在 `Mod+Shift+P`，而 `export.pdf`
   > 原来也是 `Mod+Shift+P`。`findChordConflicts` 的 `real` 判据要调 `when()`，在没有打开任何笔记的
   > 测试环境里它判定"两条不可能同时可用"，于是**假绿**。改成结构性判据后立刻抓出来，
   > `export.pdf` 因此挪到 `Mod+Alt+P`。教训写在这里：**门禁不能依赖"恰好复现真机状态"的环境**。
