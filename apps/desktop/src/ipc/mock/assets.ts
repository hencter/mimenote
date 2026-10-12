/**
 * ipc/mock/assets.ts（从 mock-adapter.ts 逐字搬出，只加了 export 与 import）
 *
 * 附件与资源授权 —— Mock 侧的镜像（判据在 `domain/attachments.ts`）。
 */
import type { MockHost } from './host'
import { extensionOf } from '@/domain/paths'
import { MOCK_IMAGE_MIMES, mockBase64 } from './site'
import { isImageAssetTarget } from '@/domain/assets'
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BATCH_BYTES, MAX_ATTACHMENT_BYTES, estimatedDecodedBytes, uniqueAttachmentName } from '@/domain/attachments'
import type { AssetBytes, AssetGrant, AttachmentInput, AttachmentSaved } from '@/ipc/types'


export const MOCK_MAX_ATTACHMENTS = MAX_ATTACHMENTS

/** 标准 base64 → 字节；非法输入返回 `null`（与宿主 `assets::base64_decode` 的严格口径一致）。 */
export function mockDecodeBase64(encoded: string): Uint8Array | null {
  if (encoded.length % 4 !== 0) return null
  try {
    const binary = atob(encoded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  } catch {
    // `atob` 对白名单外字符会抛：在 Mock 里就是"载荷非法"
    return null
  }
}

// ---------------------------------------------------------------------------
// Mock 的整库导出（`mn_core::site` + `mn_index::site` 的简化镜像）
//
// ⚠️ 权威实现永远在 Rust 侧（`crates/mn-core/src/site.rs` 的页面命名与 URL 编码、
// `crates/mn-index/src/site.rs` 的链接解析、`src-tauri/src/site_export.rs` 的落盘策略）。
// 这里镜像到"能在浏览器里把整条导出链路跑通"为止：
//
// * **路径与 URL 算术直接复用前端那一份**（`domain/site-paths.ts`）—— Mock 与真实导出走的是
//   同一段纯函数，因此这里不可能出现"Mock 的 href 与真机不一样"这种最阴的假绿；
// * 链接用与 `note_links` **同一个** `createMockResolver`，因此"计划里的 href"与
//   "反向链接面板里的解析结果"必然一致（两份规则漂移是这一层最该防的事）；
// * **落盘只记账**（没有真实文件系统）：`export_site_write_pages` / `export_site_copy_assets`
//   把写过的路径记下来供测试断言，返回与真机同形的结果。浏览器预览模式下前端本来就会
//   在"没有系统目录选择框"这一步停下来并如实说明，不会假装写出去了。
// ---------------------------------------------------------------------------

/** 计划里的最小页面形状（出参在 `export_site_plan` 分支里补上标题、标签与统计）。 */

/**
 * `asset_authorize` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function assetAuthorize(host: MockHost, a: Record<string, unknown>): Promise<unknown> {
  const { rootPath, files, binaries, validate } = host
          // 逐文件授权的 Mock（ADR-0007）：真实宿主用 `path_guard::resolve_existing` 逐级检查
          // 符号链接并拒绝越界；这里只做形状与最基础的越界拒绝 —— 浏览器预览不渲染本地图片，
          // 这个分支主要用于让契约保持完整（前端只有在 Tauri 运行时才会调用它）。
          const requested = Array.isArray(a.relPaths) ? a.relPaths : []
          const grants: AssetGrant[] = []
          for (const raw of requested) {
            const rel = String(raw)
            validate(rel)
            const separator = rootPath.includes('\\') ? '\\' : '/'
            grants.push({
              relPath: rel,
              absolutePath: `${rootPath.replace(/[\\/]+$/, '')}${separator}${rel.replaceAll('/', separator)}`,
              sizeBytes:
                binaries.get(rel)?.length ??
                new TextEncoder().encode(files.get(rel)?.text ?? '').length,
            })
          }
          return grants
}

/**
 * `asset_read_base64` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function assetReadBase64(host: MockHost, a: Record<string, unknown>): Promise<unknown> {
  const { files, binaries } = host
          // 导出内嵌（`asset_read_base64` 的 Mock 镜像）：只对白名单扩展名、且在"文件表"里
          // 存在的条目返回 base64；越界、非图片、不存在的路径一律跳过（与宿主一致：
          // 宿主也是"只返回成功的那些"，调用方把没返回的渲染成占位文字）。
          const requested = Array.isArray(a.relPaths) ? a.relPaths : []
          const items: AssetBytes[] = []
          for (const raw of requested) {
            const rel = String(raw)
            const mime = MOCK_IMAGE_MIMES[extensionOf(rel)]
            if (mime === undefined) continue
            // 图片既可能是笔记表里的"假图片"（测试用），也可能是附件写入留下的真字节
            const bytes =
              binaries.get(rel) ??
              (files.get(rel) === undefined
                ? undefined
                : new TextEncoder().encode(files.get(rel)?.text ?? ''))
            if (bytes === undefined) continue
            items.push({
              relPath: rel,
              mime,
              dataBase64: mockBase64(bytes),
              sizeBytes: bytes.length,
            })
          }
          return items
}

/**
 * `attachment_save` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function attachmentSave(host: MockHost, a: Record<string, unknown>): Promise<unknown> {
  const { files, dirs, binaries, touch, mtimes, validate } = host
          // 附件写入的 Mock 镜像（ADR-0013）：**逐条**对齐宿主的行为 ——
          // 目录口径、白名单、三道上限、命名去重、返回契约，以及"要么全落、要么一张都不落"。
          const rawDir = String(a.dirRel ?? '')
          const dir = rawDir.trim().replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '')
          if (dir !== '') validate(dir)

          const requested = Array.isArray(a.files) ? a.files : []
          if (requested.length > MOCK_MAX_ATTACHMENTS) {
            host.fail('TOO_LARGE', `一次最多接受 ${MOCK_MAX_ATTACHMENTS} 张图片（本次 ${requested.length} 张）`)
          }

          // 第一阶段：只校验，不落盘
          const planned: Array<{ relPath: string; bytes: Uint8Array }> = []
          const reserved = new Set<string>()
          let totalBytes = 0
          for (const raw of requested) {
            const entry = (raw ?? {}) as Partial<AttachmentInput>
            const name = String(entry.name ?? '').trim()
            const encoded = String(entry.dataBase64 ?? '')
            if (name.includes('/') || name.includes('\\')) {
              host.fail('PATH_INVALID', `附件文件名不能含路径分隔符：${name}`)
            }
            if (!isImageAssetTarget(name) || extensionOf(name) === '') {
              host.fail(
                'UNSUPPORTED_MEDIA',
                `只接受图片附件（png / jpg / jpeg / gif / webp / avif / bmp / svg / ico），已拒绝：${
                  name === '' ? '（文件名为空）' : name
                }`,
              )
            }
            // 先按 base64 长度估上界（与宿主同一口径），再解码
            const estimate = estimatedDecodedBytes(encoded.length)
            if (estimate > MAX_ATTACHMENT_BYTES) {
              host.fail('TOO_LARGE', `${name}：${estimate}+ 字节 > 单张上限 ${MAX_ATTACHMENT_BYTES} 字节`)
            }
            const bytes = mockDecodeBase64(encoded)
            if (bytes === null) {
              host.fail('UNSUPPORTED_MEDIA', `附件载荷不是合法的 base64：${name}`)
            }
            if (bytes.length === 0) {
              host.fail('UNSUPPORTED_MEDIA', `附件内容为空，已拒绝：${name}`)
            }
            totalBytes += bytes.length
            if (totalBytes > MAX_ATTACHMENT_BATCH_BYTES) {
              host.fail(
                'TOO_LARGE',
                `本批附件合计超过上限 ${MAX_ATTACHMENT_BATCH_BYTES} 字节（写到 ${name} 时已达 ${totalBytes} 字节）`,
              )
            }

            const rel = uniqueAttachmentName(name, (candidate) => {
              const path = dir === '' ? candidate : `${dir}/${candidate}`
              return reserved.has(path) || files.has(path) || binaries.has(path)
            })
            if (rel === null) host.fail('ALREADY_EXISTS', `${name} 的重名尝试次数过多`)
            const relPath = dir === '' ? rel : `${dir}/${rel}`
            reserved.add(relPath)
            planned.push({ relPath, bytes })
          }

          // 第二阶段：落盘（内存表）+ 造出附件目录（含缺失的祖先，与宿主建目录一致）
          if (dir !== '') {
            let accumulated = ''
            for (const segment of dir.split('/')) {
              accumulated = accumulated === '' ? segment : `${accumulated}/${segment}`
              dirs.add(accumulated)
            }
          }
          const payload: AttachmentSaved[] = planned.map((item) => {
            binaries.set(item.relPath, item.bytes)
            mtimes.set(item.relPath, touch())
            return { relPath: item.relPath, sizeBytes: item.bytes.length }
          })
          return payload
}
