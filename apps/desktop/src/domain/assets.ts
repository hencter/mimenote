/**
 * Vault 内资源的路径解析（给预览的 `asset:` 协议用）。
 *
 * 领域层规则：纯字符串处理、不碰文件系统、不 import React/Tauri —— 这样"越界拒绝"
 * 这类安全判定可以在 vitest 里逐条钉死，而不是等到真实 WebView 里才发现。
 *
 * 输出是**Vault 相对路径**（POSIX 风格），与 IPC 契约一致（跨 IPC 只传相对路径）；
 * 由宿主用 `mn_core::path_guard` 把它变成磁盘绝对路径 —— 那一步才会逐级检查符号链接，
 * 避免"Vault 内的符号链接指向外部文件"被读出来（见 ADR-0007）。
 */

import { parentOf } from './paths'

/** 是否是外部/内联地址（http(s)、data:、blob:、asset:、协议相对 `//`）。 */
export function isExternalAssetHref(href: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href.trim())
}

/** Windows 保留设备名（与 `mn_core::path_guard` 的口径一致）。 */
function isReservedName(segment: string): boolean {
  const stem = (segment.split('.')[0] ?? '').toUpperCase()
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)
}

/** 段里是否有 Windows 非法字符或控制字符。 */
function hasIllegalChars(segment: string): boolean {
  return /[<>:"|?*\u0000-\u001f]/.test(segment)
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    // 非法百分号编码（`%zz`）：按原样处理，后续校验会决定是否放行
    return value
  }
}

/**
 * 把 Markdown 里的资源地址解析成**Vault 相对路径**（POSIX）。
 *
 * 支持三种写法（与 Obsidian 一致）：
 * - 相对当前笔记：`图.png`、`./子目录/图.png`、`../附件/图.png`
 * - Vault 根绝对：`/附件/图.png`
 *
 * 返回 `null` 的场合（调用方应回退到占位元素，而不是拼出一个越界路径）：
 * 空串、外部地址、`..` 越出 Vault、含 Windows 非法字符或保留设备名、只解析到根目录。
 */
export function resolveVaultAssetRel(noteRelPath: string, href: string): string | null {
  const raw = href.trim()
  if (raw === '' || isExternalAssetHref(raw)) return null

  // 统一分隔符：笔记里可能写成 `图\图.png`（Windows 习惯），不能当成转义
  const normalized = safeDecode(raw).replaceAll('\\', '/')
  const fromRoot = normalized.startsWith('/')

  const segments: string[] = []
  if (!fromRoot) {
    for (const part of parentOf(noteRelPath).split('/')) {
      if (part !== '' && part !== '.') segments.push(part)
    }
  }

  for (const part of normalized.replace(/^\/+/, '').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      // 越界：口径是"过程中任何时候越出根都拒绝"（哪怕后文又用子目录绕回来）——
      // 允许"出去再回来"会让判定依赖整条路径，容易在后续改动里被绕过。
      if (segments.length === 0) return null
      segments.pop()
      continue
    }
    if (hasIllegalChars(part) || isReservedName(part)) return null
    segments.push(part)
  }

  if (segments.length === 0) return null
  return segments.join('/')
}
