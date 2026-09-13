# ADR-0003：IPC 契约 + 文件 IO 全部 `spawn_blocking` 隔离

- 状态：已采纳
- 日期：M1

## 背景

Tauri 的同步命令（`fn` 而非 `async fn`）在**主线程**执行；主线程同时负责 WebView 消息泵。若在命令里直接做 1 万文件的目录扫描或 1MB 文件写入，UI 会出现可感知卡顿——这违反"输入延迟 ≤16ms / 主线程单任务 ≤8ms"。

## 决策

1. **所有涉及文件 IO 的命令声明为 `async fn`**，内部用 `tauri::async_runtime::spawn_blocking` 执行实际 IO，主线程只做状态读取与参数校验。
2. IPC 契约固定为：camelCase DTO、相对路径、毫秒时间戳、稳定错误码。
3. Rust 侧错误统一为 `IpcError { code, message, detail?, currentMtimeMs? }`；UI 只按 `code` 分支，**不解析 message**（message 面向人，可随时改）。
4. 前端 IPC 调用统一经过 `ipc/client.ts` 的**可替换适配器**（Tauri 适配器 / Mock 适配器）。组件与 store 永不直接 `invoke`。

## 理由

- 结构化并发：把"线程模型"的选择锁在一个薄层里，业务代码不感知。
- 可测试：适配器可替换意味着 store 与领域层可以在 vitest 里无 Tauri 运行。
- 稳定错误码让 UI 分支、埋点、文档三者对齐；message 可以自由本地化/演化。

## 代价与缓解

| 代价 | 缓解 |
| --- | --- |
| `spawn_blocking` 需要 `'static` 数据 → 状态需可克隆 | Vault 根用 `Arc<VaultRoot>`，跨线程只移动 Arc 与 owned String |
| 异步命令引入额外一层 `async` 心智负担 | 命令层极薄（<20 行/命令），逻辑全在 mn-core |
| DTO 手工镜像有漂移风险 | M2 接入类型生成（ts-rs）或契约测试；M1 用 `ipc/types.ts` 集中定义 + 单测锁定字段名 |

## 影响

新增命令时必须遵守：`async fn` + `spawn_blocking` + `IpcError` + DTO 加进 `ipc/types.ts` + 在 architecture.md §3.1 表格登记。
