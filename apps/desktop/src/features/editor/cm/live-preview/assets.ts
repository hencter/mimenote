/**
 * Live Preview 的图片授权缓存（ADR-0007 的"逐文件授权"在编辑器侧的落地）。
 *
 * 三条纪律：
 * 1. **装饰计算只读这个缓存**：`lookupAsset` 是同步的、不发请求 —— 输入路径上不能有 IO，
 *    更不能"每按一个键就问一次宿主"；
 * 2. **只请求视口里出现过的图片**：登记由装饰层在算完之后一次性 flush（见 plugin.ts），
 *    同一路径（含失败）只请求一次，滚动回来看过的图不会重复请求；
 * 3. **失败即降级**：拿不到授权（越界、符号链接逃逸、文件不存在、非图片扩展名、旧宿主没有这个命令）
 *    一律留在占位态，绝不产出会变成裂图的 `<img>`。
 *
 * 缓存键 = `Vault 根 + \u0000 + Vault 相对路径`（与预览面板同一套口径）：
 * 换 Vault 后旧条目不会被误用。缓存**跨笔记保留**，因此来回切换笔记不会重新授权。
 */

import { ipc, isTauriRuntime } from '@/ipc/client'
import { convertAssetUrl } from '@/ipc/tauri-adapter'

import type { ImageResolution } from './types'

type AssetState =
  | { status: 'pending' }
  | { status: 'ready'; url: string }
  | { status: 'denied' }

const cache = new Map<string, AssetState>()
/** asset URL → 缓存键（图片加载失败时用它反查该降级哪一条）。 */
const urlToKey = new Map<string, string>()

const listeners = new Set<() => void>()

/** 待 flush 的登记（`rootPath` 一起记着，避免换 Vault 时把旧路径发出去）。 */
let stagedRoot: string | null = null
let staged = new Set<string>()

function keyOf(rootPath: string, rel: string): string {
  return `${rootPath}\u0000${rel}`
}

function notify(): void {
  for (const listener of [...listeners]) listener()
}

/** 订阅"授权结果有变化"（插件据此重算装饰）。返回取消订阅函数。 */
export function subscribeAssets(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 只读查询：装饰层唯一该用的入口，**不发起任何请求**。 */
export function lookupAsset(rootPath: string, rel: string): ImageResolution {
  const entry = cache.get(keyOf(rootPath, rel))
  return entry?.status === 'ready' ? { kind: 'ready', url: entry.url } : { kind: 'placeholder' }
}

/** 登记"这一屏需要这张图"（装饰层在算完后调用；下一帧由 {@link flushAssets} 批量换取）。 */
export function stageAsset(rootPath: string, rel: string): void {
  if (stagedRoot !== rootPath) {
    stagedRoot = rootPath
    staged = new Set<string>()
  }
  const key = keyOf(rootPath, rel)
  if (cache.has(key)) return
  staged.add(rel)
}

/**
 * 把登记过的图片一次性换成读取授权。
 *
 * 一次 IPC 拿一整批（不是每张图一次往返）；宿主的返回里只含**通过 `path_guard` 校验**的条目，
 * 没返回的就是拿不到授权 → 永久留在占位态（不再反复请求）。
 */
export function flushAssets(): void {
  const rootPath = stagedRoot
  if (rootPath === null || staged.size === 0) return
  const wanted = [...staged]
  staged = new Set<string>()

  // 浏览器预览（`pnpm dev`）没有 asset 协议：直接记成 denied，装饰层渲染占位文本，
  // 而不是产出一堆必然加载失败的 URL。
  if (!isTauriRuntime()) {
    for (const rel of wanted) cache.set(keyOf(rootPath, rel), { status: 'denied' })
    return
  }

  for (const rel of wanted) cache.set(keyOf(rootPath, rel), { status: 'pending' })

  void (async () => {
    try {
      const grants = await ipc.assetAuthorize(wanted)
      const granted = new Map(grants.map((grant) => [grant.relPath, grant.absolutePath]))
      for (const rel of wanted) {
        const key = keyOf(rootPath, rel)
        const absolutePath = granted.get(rel)
        if (absolutePath === undefined) {
          cache.set(key, { status: 'denied' })
          continue
        }
        const url = convertAssetUrl(absolutePath)
        cache.set(key, { status: 'ready', url })
        urlToKey.set(url, key)
      }
    } catch {
      // 授权失败（旧宿主没有这个命令、Vault 只读等）：永久回退占位，不刷屏报错
      for (const rel of wanted) cache.set(keyOf(rootPath, rel), { status: 'denied' })
    }
    notify()
  })()
}

/**
 * 图片真的加载失败（作用域没覆盖到、文件被删、磁盘上其实是坏图）：
 * 把这条缓存降级成 `denied`，于是下一次重算就换成占位文本 —— **不留裂图**。
 */
export function markAssetFailed(url: string): void {
  const key = urlToKey.get(url)
  if (key === undefined) return
  urlToKey.delete(url)
  cache.set(key, { status: 'denied' })
  notify()
}

/** 清空缓存与登记（换 Vault、测试用）。 */
export function resetAssets(): void {
  cache.clear()
  urlToKey.clear()
  staged = new Set<string>()
  stagedRoot = null
}
