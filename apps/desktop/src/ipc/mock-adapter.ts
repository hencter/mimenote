/**
 * 内存 Vault 适配器（**再导出壳**，ADR-0060 §3(d)）。
 *
 * 双重用途：
 * 1. **测试替身**：让 store / 领域层可以在 vitest 里跑完整 M1 闭环，无需 Tauri；
 * 2. **浏览器预览**：`pnpm dev` 时若不在 Tauri 内，UI 依然可用（便于调样式）。
 *
 * 行为刻意与 Rust 侧对齐：删除进回收站、mtime 作为版本令牌、路径校验。
 *
 * 实现已按领域拆进 `ipc/mock/**`：
 * - `mock/host.ts` —— 内存宿主的状态与共用辅助（目录重映射、回收站台账、标签全库改写各一份）；
 * - `mock/{vault,notes,trash,dirs,tag-ops,graph,assets,site,config,search}.ts` —— 各域处理体；
 * - `mock/{links,tags,tag-rename,search,site,assets,model}.ts` —— 领域算法与数据的镜像；
 * - `mock/index.ts` —— 43 条命令的**薄分发**（`case '命令名'` 必须留在那一个文件里，
 *   因为 `scripts/check-ipc.mjs` 的 mock 侧判据是"在 `TS_MOCK` 指向的文件里数 case"）。
 *
 * 这个壳保留原来的模块路径与**同名的**导出符号：56 个测试文件 import 的是
 * `@/ipc/mock-adapter`，所以拆分对调用点零改动。
 *
 * `mock/index.ts` 的头部还有一张"Mock 与权威判据的差异清单"（B11 的收敛结果）。
 */
export { createMockAdapter, MOCK_VAULT_PATH } from './mock/index'
export type { MockAdapter, MockAdapterOptions } from './mock/model'
