/**
 * ipc/mock/vault.ts
 *
 * Vault 生命周期与概览命令（`vault_open` / `vault_info` / `index_status`…）。
 */
import type { MockHost } from './host'
import { buildMockNoteLinks } from './links'
import type { IndexStatus, VaultInfo, VaultSnapshot } from '@/ipc/types'



/**
 * `vault_snapshot` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function vaultSnapshotOrOpen(host: MockHost, _a: Record<string, unknown>): Promise<unknown> {
  const { rootPath, dirs, entries, noteCount } = host
          const list = entries()
          const payload: VaultSnapshot = {
            rootPath,
            name: 'MockVault',
            entries: list,
            noteCount: noteCount(),
            folderCount: dirs.size,
            truncated: false,
            skipped: 0,
            scanMs: 3,
            generatedAtMs: Date.now(),
          }
          // vault_open 与 vault_snapshot 在契约上返回同一结构（见 commands.rs）
          return payload
}

/**
 * `vault_info` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function vaultInfo(host: MockHost, _a: Record<string, unknown>): Promise<unknown> {
  const { rootPath, dirs, entries, noteCount } = host
          const info: VaultInfo = {
            rootPath,
            name: 'MockVault',
            entryCount: entries().length,
            noteCount: noteCount(),
            folderCount: dirs.size,
            truncated: false,
            skipped: 0,
            scanMs: 3,
          }
          return info
}

/**
 * `vault_close` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function vaultClose(_host: MockHost, _a: Record<string, unknown>): Promise<unknown> {
          return undefined
}

/**
 * `startup_vault` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function startupVault(host: MockHost, _a: Record<string, unknown>): Promise<unknown> {
          return (host.startupVaultPath ?? null)
}

/**
 * `index_status` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function indexStatus(host: MockHost, _a: Record<string, unknown>): Promise<unknown> {
  const { files, noteCount } = host
          const status: IndexStatus = {
            phase: 'ready',
            indexed: noteCount(),
            total: noteCount(),
            durationMs: 2,
            links: [...files.keys()].reduce(
              (sum, rel) => sum + buildMockNoteLinks(files, rel).outbound.length,
              0,
            ),
            // Mock 没有落盘索引可复用：如实报 0（语义见 types.ts 的 IndexStatus）
            reusedNotes: 0,
          }
          return status
}
