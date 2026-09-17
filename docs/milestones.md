# Mimenote Roadmap

本文件描述 Mimenote 当前已经交付的产品基线，以及接下来几个 GitHub Milestone 的目标、范围和验收条件。

原则：**每个里程碑结束时，应用必须可运行、可验证、可交付。** 不把半成品能力提前视为完成，也不把纯实现细节当成产品里程碑。

## 已交付基线

Mimenote 在 `v0.1.0` 之前已经完成 M1、M1.5、M2、M3 的主要范围。后续 Roadmap 不再重复逐条记录所有历史实现，而把这些能力视为当前产品基线。

### M1 — 最小可用闭环 ✅

完成：

- 打开本地 Vault
- 虚拟化文件树
- Markdown 编辑
- 原子保存
- 阅读预览
- 文件冲突保护
- 回收站删除流程
- 基础主题 / 命令扩展点

### M1.5 — 测试与自动化 ✅

完成：

- Rust / TypeScript 单元测试
- 真实 Tauri 应用 E2E 能力
- UI E2E 能力
- 命令行直接打开 Vault
- 日志落盘
- 基础 CI

> E2E 能力本身已经存在，但当前仍需要把真实应用 E2E 正式接入 PR / Release 质量门禁，见 #2。

### M2 — 核心知识库体验 ✅

完成：

- Wikilink 双链
- 反向链接与出链
- 笔记重命名与全库链接改写
- 标签与 Frontmatter
- SQLite FTS5 全文搜索
- 快速切换
- 命令面板
- 本地图片与附件
- 搜索命中行跳转

### M3 — 高级桌面体验 ✅

完成：

- Live Preview 所见即所得编辑
- 关系图 / 整库图谱
- 多标签页
- 工作区布局持久化
- 面板停靠与界面偏好
- 笔记 / 目录拖拽移动
- 目录重命名与全库链接改写
- 标签新增、删除、重命名、合并与层级移动
- Markdown 表格渲染与格式化
- Obsidian 风格 Callout
- 任务列表
- 图片粘贴 / 拖入附件目录
- HTML / PDF 导出
- 整库静态站点导出
- 回收站恢复
- 外部文件改动自动同步
- 大文档与图谱性能优化

详细实现决策不在这里展开，见 [`architecture.md`](architecture.md) 与 [`adr/`](adr/)。

---

## 接下来

### v0.1.1 — 稳定性与发布

**目标：把已经具备的产品能力变成更可靠的可发布版本。**

这个阶段优先解决发布工程、自动化门禁、跨语言契约和依赖供应链问题，不新增大型产品功能。

#### Scope

##### 1. 发版版本一致性

Issue: [#1 — 发版版本校验覆盖 Cargo workspace version](https://github.com/hencter/mimenote/issues/1)

需要保证以下版本来源在发版时一致：

- Git tag
- 根 `package.json`
- `apps/desktop/package.json`
- `apps/desktop/src-tauri/tauri.conf.json`
- 根 `Cargo.toml [workspace.package].version`

##### 2. 真实应用 E2E 进入发布门禁

Issue: [#2 — 将真实应用 E2E 纳入 PR / Release 质量门禁](https://github.com/hencter/mimenote/issues/2)

目标：

- PR 至少运行稳定 smoke E2E
- `main` / 定时任务运行更完整的 E2E
- Release 必须通过真实应用 smoke E2E
- 测试失败保留日志、截图和诊断产物

##### 3. Rust ↔ TypeScript IPC 契约一致性

Issue: [#3 — Rust ↔ TypeScript IPC 契约增加自动一致性检查](https://github.com/hencter/mimenote/issues/3)

目标：

- command 名称漂移可被 CI 发现
- Rust / TS ErrorCode 不一致可被 CI 发现
- 关键 DTO 不再完全依赖人工同步

##### 4. 依赖安全与自动更新

Issue: [#4 — 增加依赖安全扫描与自动更新](https://github.com/hencter/mimenote/issues/4)

目标：

- Rust 依赖 CVE 扫描
- JS / TS 依赖安全扫描
- GitHub Actions 自动更新
- 高严重度问题具备明确 Release 阻断策略

#### Done when

- [ ] #1 完成
- [ ] #2 完成
- [ ] #3 完成
- [ ] #4 完成
- [ ] Release workflow 能对核心发布风险提供自动门禁
- [ ] 发布文档与实际版本来源一致

#### Non-goals

本里程碑不包含：

- 插件系统
- 云同步
- Git 集成
- 大规模 UI 重构
- 新的知识管理模型

---

### v0.2.0 — 跨平台与桌面体验

**目标：从“Windows 正式可用”向明确、可验证的跨平台支持推进。**

Issue: [#5 — 明确平台支持矩阵，并建立跨平台 CI](https://github.com/hencter/mimenote/issues/5)

#### Scope

- 明确 Windows / macOS / Linux 支持等级
- CI 至少覆盖 Windows 与 macOS 的核心构建 / 测试
- 验证平台差异：
  - 快捷键
  - 文件路径
  - 文件监听
  - asset protocol
  - 窗口行为
- 建立 macOS 构建验证
- 正式发布 macOS 前完成签名 / notarization 方案
- 对 Linux 做出明确支持决策

#### Done when

- [ ] README 中的平台矩阵与实际发布状态一致
- [ ] Windows + macOS 至少有核心 CI 验证
- [ ] macOS 可以稳定构建并通过最小 smoke 验证
- [ ] 平台差异有测试或明确文档
- [ ] Linux 支持范围有明确结论

#### Non-goals

- 不要求本阶段同时正式发布所有 Linux 发行版
- 不为跨平台适配重写 `mn-core`
- 不把同步 / 插件系统混进此里程碑

---

### M4 — 插件系统

**目标：在不破坏本地文件安全边界的前提下，为 Mimenote 建立可演进的第三方扩展模型。**

当前准备 Issue: [#6 — 按领域拆分宿主 IPC commands，为 M4 插件系统做准备](https://github.com/hencter/mimenote/issues/6)

插件模型的总体方向已经在 ADR 中确定：Manifest、权限声明、隔离、API versioning、错误边界和卸载清理。

#### Phase A — Capability boundary

- 宿主 IPC commands 按领域拆分
- 明确 `vault / notes / tags / search / graph / assets / export / system` 等能力边界
- 保持 `mn-core` 为纯 Rust，不依赖 Tauri / UI

#### Phase B — Plugin Manifest

至少定义：

```text
id
name
version
minAppVersion
permissions
```

要求：

- Manifest 可校验
- 插件 ID 稳定
- API / App 最低版本约束明确

#### Phase C — Permission Model

- 插件显式声明权限
- 安装前展示权限确认
- 默认最小权限
- 插件无法绕过宿主能力边界直接获得通用 FS / Shell / HTTP 能力

#### Phase D — Isolation & Error Boundary

- 插件逻辑与主 UI / 核心状态隔离
- 优先 Worker 等隔离模型
- 插件崩溃不能拖垮整个应用
- 超时 / 异常有统一处理策略

#### Phase E — Lifecycle

- 安装
- 启用 / 禁用
- 更新
- 卸载
- 插件数据清理规则
- 兼容性检查

#### Done when

- [ ] #6 完成
- [ ] Manifest schema 稳定
- [ ] Permission model 有明确实现与 UI
- [ ] 插件运行具备隔离和错误边界
- [ ] 插件 API 有版本机制
- [ ] 安装 / 禁用 / 更新 / 卸载完整闭环可验证
- [ ] 至少一个内部 / 示例插件验证完整 API

#### Non-goals

M4 首版不追求：

- 完整插件市场
- 任意原生代码执行
- 无限制的系统权限
- 与 Obsidian 插件 API 完全兼容

---

## 待后续规划

以下方向有价值，但当前不放入已承诺里程碑：

- Git 集成
- 多设备同步
- 静态站点站内搜索
- 静态站点增量导出
- 回收站永久删除 / 清空
- 更完整的插件分发与发现机制

这些能力应在进入开发前先建立独立 Issue / ADR，并明确数据安全与迁移策略。

---

## GitHub Milestone 映射

计划使用以下 GitHub Milestone：

| GitHub Milestone | Issues |
| --- | --- |
| `v0.1.1 — 稳定性与发布` | #1, #2, #3, #4 |
| `v0.2.0 — 跨平台与桌面体验` | #5 |
| `M4 — 插件系统` | #6，以及后续拆出的插件子 Issue |

GitHub Milestone 应作为执行状态的主要入口；本文件用于解释每个 Milestone 的产品目标和验收边界。
