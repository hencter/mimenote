---
title: IPC 契约
tags: [手册, 开发]
---

# IPC 契约

## 基本款

- 所有命令返回 `Result<T, IpcError>`，`code` 是稳定字符串（UI 只按 `code` 分支）；
- 路径只传 Vault 相对路径（POSIX 风格），时间一律毫秒 `mtimeMs`（版本令牌）；
- 写操作带 `baseMtimeMs`，对不上就 `CONFLICT`（绝不静默覆盖）。

## 一致性校验（`pnpm check:ipc`，CI 门禁）

命令名三方一致（Rust `generate_handler!` ↔ `client.ts` ↔ `mock-adapter.ts`）、
错误码集合一致、DTO 字段逐字段一致、字符串枚举一致。
新增命令/DTO 的流程：Rust 写命令 → `types.ts` 镜像 → mock 加 `case` →
登记进 `DTO_MANIFEST` → 本地跑通 `check:ipc`。

## 领域命令速查

vault / notes / tags / trash / links / graph / search / system +
assets / attachments / export / site_export（`commands/` 一个领域一个文件）。
`export_write_html` 是唯一允许写 Vault 之外的命令（只接受 `.html`）。

事件（宿主 → 前端）：`mn://index-status`（索引进度）、`mn://vault-changed`
（外部改动，只报"有新闻"，前端走既有重扫链路）。

测试门禁见 [[开发者手册/测试与门禁]]。
