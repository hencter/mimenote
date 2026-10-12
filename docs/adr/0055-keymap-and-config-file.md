# ADR-0055：键位系统（默认表 + 档案 + 覆盖）与 Vault 配置文件（TOML / YAML / JSON）

- 状态：已采纳
- 日期：2026-10-12
- 相关：ADR-0005（命令注册表）、ADR-0027（界面偏好）、ADR-0048（三格式 frontmatter 的纪律）、ADR-0011（能力收窄）

## 背景

三件事同时到期：

1. **默认键位有几处按人体工学说不通**：`Mod+O`（右手可达）给了"打开 Vault"这种一天一次的动作；
   `Mod+B` 被"显示/隐藏侧栏"占着，而它在任何编辑器里都是"加粗"；同一件事（面板开关）散落在
   三种不同的键位形态里。
2. **键位不可配**：`Command.keybinding` 是写死的字符串，用户没有任何覆盖入口；
   命令表本身是可枚举、可版本化的（ADR-0005），缺的只是"解析层"。
3. **设置不可移植**：偏好只存在 `localStorage`（`mimenote.settings.v1`）。
   换机器、换 Vault、进 git 都带不走 —— 与"本地优先、文件即真相"的定位不符。

## 决策

### 1. 键位解析链：用户覆盖 → 档案 → 默认表

`Command.keybinding` 的语义收窄为**默认值**；运行时生效的键位由 `domain/keymap.ts` 的
`resolveChords()` 解析，`state/keymap-store.ts` 把它装进 `commands` 的解析器（`setBindingResolver`）。

- **档案（profile）**是整套心智模型（`mimenote` / `obsidian` / `vscode`），只声明"与默认表不同"的条目；
- **覆盖**精确到命令：键存在且为空数组 = **显式解绑**，键不存在 = 没配过（这两件事绝不合并）；
- **冲突必须可见**：同一 chord 命中多条命令时，设置页列出清单，并区分"真的会撞"
  （两条 `when` 同时成立）与"互斥视图下的同名键"。

### 2. 默认表按 QWERTY 人体工学分四层

| 层 | 形态 | 用于 | 例子 |
| --- | --- | --- | --- |
| L1 高频 | `Mod+字母` | 每分钟级 | `Mod+S` 保存、`Mod+P` 快切、`Mod+B` 加粗、`Mod+E` 切换视图 |
| L2 中频 | `Mod+Shift+字母` | 每小时级、面板与视图开关 | `Mod+Shift+P` 命令面板、`Mod+Shift+B` 文件树、`Mod+Shift+F` 全文搜索 |
| L3 低频/难逆 | `Mod+Alt+字母` | 每天几次、破坏性动作 | `Mod+Alt+O` 打开 Vault、`Mod+Alt+R` 重扫、`Mod+Alt+C` 单栏/分栏 |
| L4 导航 | `Mod+数字` / `Mod+Tab` | 标签页 | `Mod+1..9`、`Mod+W` |

键位形态与完整表见 `docs/design/01-keymap-and-config.md` §3。

### 3. 偏好写进 Vault 内的 `config.<toml|yaml|json>`

- 候选顺序：`config.toml` → `config.yaml` → `config.yml` → `config.json`，**只有第一个存在的生效**；
- 三种格式**同构**（同一 schema、同一套校验），解析复用既有依赖（`smol-toml` / `yaml` / `JSON`），
  不为配置文件新增依赖；
- **写入只写规范名**：YAML 写 `config.yaml`，不产生 `config.yml`（避免同一 Vault 里两种拼法）；
- **含注释的文件拒绝改写**（`smol-toml` 与 `yaml` 的序列化都会吃掉注释），界面给出可操作提示 ——
  与 ADR-0048 在 frontmatter 上的同一条纪律；
- `version` 比应用更新时**只读**：写入会抹掉新版本才有的字段；
- 应用写出的文件不带注释，因此"应用写的文件永远能被应用再写"。

### 4. 分层：配置文件是真相，localStorage 只做两件事

```
DEFAULT_SETTINGS → localStorage（仅迁移来源 / 未打开 Vault 时的兜底）→ 配置文件（真相）
```

- 首次打开一个还没有配置文件的 Vault：把当前值（默认值 ∪ localStorage 旧值）**迁移**成 `config.toml`；
- localStorage **始终写一份镜像**（门闸页唯一可用的存储），但只在"没有打开 Vault"与"上面那次迁移"时被**读**；
  **配置文件存在时它赢** —— 镜像不是第二份真相；
- 写盘**合并到一次 300ms 防抖**：字号是滑杆驱动的，每次 set 都 fsync 一次既慢又无意义。

### 5. 宿主接口收窄成两条命令

`config_read()`（无参数，以当前 Vault 为准）/ `config_write(format, content)`：

- 不接受路径参数，文件名由格式唯一决定（调用方**无法**指定目录）；
- 格式白名单 `toml|yaml|yml|json`，内容 ≤256 KiB，写入走 `mn_core::atomic::write_atomic`；
- 定位与写入逻辑放 `mn-core::config`（可独立 `cargo test`，不必启动 tauri）。

## 理由

- **频率决定键位**：把"每分钟按"的动作放在 L1、把"一天按一次"的放在 L3，是这套表唯一的排序依据；
  `Mod+B` 的错位（侧栏 vs 加粗）此前就是"没有频率视角"的直接后果。
- **档案而非全表**：每个档案只写差异，加一条新命令不需要在三个档案里各补一行（漏一处就是静默缺陷）。
- **配置文件放 Vault**：偏好跟着内容走，且可进 git —— 这是项目定位的自然延伸；
  localStorage 的"跨 Vault、换机器就丢"是它唯一无法满足的需求。
- **单一写者**：配置文件的写者只有 `settings-store`（键位状态是派生层，不另开 store），
  否则两个 store 各写一次就会"谁后写谁赢"地丢字段。

## 代价与缓解

| 代价 | 缓解 |
| --- | --- |
| 键位从"读一个字段"变成"跑一次解析链" | 解析是纯函数（`domain/keymap.ts`），单测直接钉住；运行时装一次解析器，分发路径仍是 `byChord` 一次查表 |
| 配置文件是用户可改的输入，可能写坏 | 逐字段校验 + 回退默认值 + 在「配置」分区逐条列出问题；解析失败**保持当前值**而不是静默回退 |
| 含注释即只读，可能让用户"改不动配置" | 应用生成的文件不含注释；提示语明确说"请在源码中编辑"，并说明原因 |
| 防抖窗口内崩溃会丢最后一次改动 | 300ms 是同一取舍下的交点；换 Vault 与显式保存都会 `flushPendingWrite()` |
| 新命令键位与既有用户肌肉记忆冲突 | `obsidian` / `vscode` 档案保留既有习惯；覆盖粒度到单条命令 |

## 替代方案

- **把键位放进 localStorage**：实现最省事，但键位恰恰是最需要"跟着 Vault / 进 git"的偏好之一；
  而且要求里明确要 TOML/YAML/JSON 三格式。
- **每套档案写全表**：维护成本随命令数线性增长，且漏项是静默缺陷。
- **把配置解析放宿主（Rust）**：会立刻长出第二份默认值与第二套校验（ADR-0048 的教训）；
  宿主因此只做"定位 + 读写字节"。
- **配置写入不防抖**：拖一次字号滑杆触发几十次原子写（每次 fsync），没有必要。

## 影响

- `app/commands.ts` 增加解析器注入点（未注入时行为与从前完全一致，纯单测不受影响）；
- 键盘原语（`normalizeChord` / `chordFromEvent` / `formatChord` …）搬到 `domain/keymap.ts`，
  `app/commands.ts` 再导出同一组名字 —— 实现只有一份，调用点零改动；
- 设置页新增「键位」「配置」两个分区；`Icon` 新增 `keyboard` / `fileCode` 两个字形的映射；
- 宿主新增 `config_read` / `config_write` 两条命令（能力面收窄，见 §5）；
- 新增格式化命令（加粗 / 斜体 / 行内代码 / 删除线 / 链接），
  `Mod+B` 归还给"加粗"、侧栏挪到 `Mod+Shift+B` —— 顺带补上了"Live Preview 能渲染粗体却没法加粗"的缺口。
