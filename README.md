# Mimenote

本地优先的 Markdown 知识库桌面应用。

你的笔记始终是普通目录里的普通 Markdown 文件：可以被 Git 管理、可以被其他编辑器打开，也可以随时整体迁移。Mimenote 在这个基础上提供所见即所得编辑、双链与反链、全文搜索、标签、知识图谱、附件、本地导出和工作区体验。

[下载最新版本](https://github.com/hencter/mimenote/releases/latest) · [路线图](docs/milestones.md) · [架构说明](docs/architecture.md) · [Issues](https://github.com/hencter/mimenote/issues)

> 当前版本：**v0.1.0**  
> 当前正式发布包仅提供 **Windows x64**（`.exe` / `.msi`）。macOS 与 Linux 尚未作为正式支持平台发布。

## 为什么是 Mimenote

Mimenote 的设计重点不是把笔记锁进一个数据库，而是在普通 Markdown 文件之上补齐知识库体验。

- **本地优先**：内容保存在你选择的 Vault 目录中，不依赖云端才能工作。
- **文件可迁移**：Markdown、图片和附件都保持为普通文件，可以直接备份、同步或交给 Git 管理。
- **快速编辑**：CodeMirror 6 + Live Preview，常见 Markdown 语法在编辑时直接呈现。
- **知识连接**：支持 `[[wikilink]]`、反向链接、悬空链接、快速跳转和关系图谱。
- **安全写入**：原子保存、外部修改检测和冲突保护，尽量避免静默覆盖文件。
- **可重建派生数据**：索引、搜索和图谱等能力建立在文件之上，而不是替代文件本身。

## 核心能力

### Markdown 编辑

- CodeMirror 6 编辑器
- 所见即所得 Live Preview
- 标题、列表、任务列表、引用、代码块、表格、Callout
- `**粗体**`、`*斜体*`、行内代码、Markdown 链接、Wikilink
- 图片与附件预览
- Markdown 表格格式化
- 自动保存与 `Ctrl+S`
- 保留 LF / CRLF 与 UTF-8 BOM，避免无意义的整文件 diff

### 双链与知识导航

- `[[笔记]]`、`[[笔记|别名]]`、`[[笔记#小节]]`
- 反向链接与出链
- 悬空链接识别与一键创建
- 同名笔记消歧
- 链接补全
- 笔记重命名、移动时自动改写相关链接

### 搜索、标签与属性

- SQLite FTS5 全文搜索
- 搜索命中行跳转
- 快速切换与命令面板
- Frontmatter 属性读取
- Frontmatter / 正文标签索引
- 标签新增、删除、重命名、合并与层级移动
- 按标签过滤文件树

### 文件与附件

- 虚拟化文件树
- 新建、重命名、移动笔记和目录
- 拖拽整理文件
- 回收站恢复
- 外部文件变更自动同步
- 粘贴 / 拖入图片自动保存到附件目录
- 本地图片安全渲染与灯箱预览

### 图谱与工作区

- 当前笔记关系图
- 整个 Vault 图谱
- 多跳关系探索
- 可调力导向布局与碰撞
- 图谱卡片 Markdown 预览
- 多标签页
- 可停靠侧边面板
- 工作区布局持久化
- 主题、字体、阅读视图等界面设置

### 导出

- 单篇自包含 HTML
- 浏览器打印 / 另存为 PDF
- 整库静态站点导出
- Wikilink 转换为可浏览的相对链接
- 图片与静态资源复制到导出目录

## 快速开始

### 1. 安装

前往 [Releases](https://github.com/hencter/mimenote/releases/latest) 下载 Windows x64 安装包：

- `Mimenote_<version>_x64-setup.exe`
- `Mimenote_<version>_x64_en-US.msi`

### 2. 打开一个 Vault

Vault 就是一个普通文件夹。你可以选择已有 Markdown 目录，也可以新建一个空目录作为知识库。

```text
MyVault/
├─ Inbox.md
├─ Projects/
│  └─ Mimenote.md
├─ Notes/
└─ assets/
```

Mimenote 会扫描其中的 Markdown、图片和附件，并为搜索、双链和图谱建立可重建的派生索引。

### 3. 开始写作

创建 `.md` 文件后即可直接编辑。可以使用标准 Markdown，也可以加入：

```md
[[另一篇笔记]]
[[另一篇笔记|显示名称]]
[[另一篇笔记#某个小节]]

#标签

> [!note] 提示
> 这是一个 Callout。
```

## 数据与隐私

Mimenote 的核心数据模型是文件系统：

- 笔记存放在你指定的 Vault 中。
- 文件写入由 Rust 核心层处理，并使用原子替换策略。
- 删除操作进入 Mimenote 回收站流程，而不是直接静默永久删除。
- 当前 Tauri capability 不向前端开放通用文件系统、Shell 或 HTTP 权限；文件访问通过受控 IPC 完成。
- 预览渲染关闭原始 HTML，并使用 DOMPurify 进行二次净化。

详细设计见 [架构说明](docs/architecture.md) 与 [`docs/adr`](docs/adr)。

## 平台状态

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| Windows x64 | ✅ 当前正式支持 | 已提供 NSIS `.exe` 与 MSI 安装包 |
| macOS | 🧪 计划适配 / 验证 | 尚未提供正式发布包 |
| Linux | 📋 待明确支持范围 | 当前没有正式发布包 |

跨平台工作见 [Roadmap](docs/milestones.md) 与 [#5](https://github.com/hencter/mimenote/issues/5)。

## 本地开发

### 环境要求

- Node.js `>= 22`
- pnpm `11.7.0`
- Rust stable
- 当前桌面目标主要为 `x86_64-pc-windows-msvc`

### 启动

```bash
git clone https://github.com/hencter/mimenote.git
cd mimenote
pnpm install
pnpm tauri:dev
```

只启动前端开发服务器：

```bash
pnpm dev
```

### 常用检查

```bash
pnpm typecheck
pnpm test
pnpm test:rust
pnpm lint:rust
pnpm test:e2e
pnpm check
```

构建桌面安装包：

```bash
pnpm tauri:build
```

## 仓库结构

```text
mimenote/
├─ apps/
│  └─ desktop/          # React + Tauri 桌面应用
├─ crates/
│  ├─ mn-core/          # 纯 Rust 文件 / Vault 核心逻辑
│  └─ mn-index/         # 索引、搜索等能力
├─ docs/
│  ├─ adr/              # Architecture Decision Records
│  ├─ architecture.md   # 架构说明
│  └─ milestones.md     # Roadmap
├─ .github/workflows/   # CI / Release
└─ package.json
```

核心边界是：`mn-core` 不依赖 Tauri/UI；Tauri host 负责会话状态、IPC 和能力暴露；前端通过统一 IPC client 调用宿主能力。

## Roadmap

Mimenote 已完成早期 M1–M3 的主要产品闭环，并发布 `v0.1.0`。下一阶段重点不再是继续堆功能，而是先把发布工程、契约一致性和平台支持做稳。

| 阶段 | 目标 | 相关 Issue |
| --- | --- | --- |
| `v0.1.0` | 已完成基础知识库、编辑、搜索、图谱、标签、附件、导出等主流程 | 已发布 |
| `v0.1.1 — 稳定性与发布` | 版本一致性、真实应用 E2E、IPC 契约检查、依赖安全 | [#1](https://github.com/hencter/mimenote/issues/1) [#2](https://github.com/hencter/mimenote/issues/2) [#3](https://github.com/hencter/mimenote/issues/3) [#4](https://github.com/hencter/mimenote/issues/4) |
| `v0.2.0 — 跨平台与桌面体验` | 建立 macOS / Linux 支持策略与跨平台 CI | [#5](https://github.com/hencter/mimenote/issues/5) |
| `M4 — 插件系统` | Plugin Manifest、权限模型、隔离、生命周期和宿主能力边界 | [#6](https://github.com/hencter/mimenote/issues/6) |

完整范围与验收条件见 [`docs/milestones.md`](docs/milestones.md)。

## 参与项目

Mimenote 目前仍处于早期版本，很多交互、兼容性和工程流程都还有改进空间。

如果你遇到问题或有功能建议，可以直接提交 [GitHub Issue](https://github.com/hencter/mimenote/issues)。提交问题时，建议包含：

- Mimenote 版本
- Windows / macOS / Linux 与系统版本
- 可复现步骤
- 预期结果与实际结果
- 日志、截图或最小复现 Vault（如适用）

代码贡献建议先阅读 [架构说明](docs/architecture.md) 与相关 ADR，避免绕过现有的数据安全和 IPC 边界。

## 当前阶段

`v0.1.0` 是第一个公开版本。现阶段优先级是稳定性、发布质量、跨平台验证以及后续插件系统的基础设施，而不是追求快速扩大功能列表。
