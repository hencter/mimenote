/**
 * E2E 底座：启动**真实应用二进制**，用 Playwright 通过 CDP 接管它的 WebView2。
 *
 * ## 为什么不是 tauri-driver
 *
 * Tauri 官方文档的 E2E 路径是 `tauri-driver` + WebdriverIO。但：
 * - `tauri-driver` 是一个 **WebDriver 服务端**，而 Playwright 不走 WebDriver 协议，两者无法对接；
 * - 走 tauri-driver 还需要一个与 WebView2 运行版本**精确匹配**的 `msedgedriver.exe`。
 *
 * WebView2 支持 `--remote-debugging-port`（通过 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`
 * 环境变量传入），Playwright 的 `chromium.connectOverCDP()` 可以直接接管它 ——
 * 于是我们既能继续用 Playwright，又能跑**真实二进制 + 真实文件 IO**：
 * 被测对象就是 `tauri build` 产出的那个 exe。
 *
 * ## 踩过的坑（写在这里省得下次再查）
 *
 * 1. CDP 端口要和别的程序（浏览器、其它调试实例）冲突时，WebView2 会退到 IPv6 `[::1]`，
 *    而 IPv4 `127.0.0.1` 上仍是别人在监听 → 探测到的是**别人的 404**。
 *    所以这里先申请一个空闲端口再用。
 * 2. 应用启动到 WebView 就绪之间有几百毫秒到数秒的间隔，必须先轮询 `/json/version`。
 * 3. 必须先把 Vault 目录通过**命令行参数**传进去（`mimenote.exe <vault>`），
 *    否则会停在门闸页等系统目录选择框 —— 自动化点不动原生对话框。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { chromium, type Browser, type Page } from 'playwright-core'

/** `apps/desktop` 目录（vitest 的 cwd 即是它；带一层兜底以防从仓库根运行）。 */
export function packageRoot(): string {
  const cwd = process.cwd()
  if (existsSync(join(cwd, 'package.json')) && existsSync(join(cwd, 'src-tauri'))) return cwd
  const nested = resolve(cwd, 'apps/desktop')
  if (existsSync(join(nested, 'src-tauri'))) return nested
  throw new Error(`无法定位 apps/desktop（cwd=${cwd}）`)
}

export function repoRoot(): string {
  return resolve(packageRoot(), '..', '..')
}

/** 被测二进制：必须由 `tauri build --no-bundle` 产出（release 才内嵌前端资源）。 */
export function appBinaryPath(): string {
  const name = process.platform === 'win32' ? 'mimenote.exe' : 'mimenote'
  return join(repoRoot(), 'target', 'release', name)
}

function assertBinaryExists(): void {
  const binary = appBinaryPath()
  if (!existsSync(binary)) {
    throw new Error(
      `找不到应用二进制：${binary}\n请先构建：pnpm --filter @mimenote/desktop exec tauri build --no-bundle`,
    )
  }
}

/** 申请一个空闲端口（避免与其它监听者冲突，见文件头第 1 条坑）。 */
export async function findFreePort(): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => {
        if (port > 0) resolvePort(port)
        else reject(new Error('无法分配空闲端口'))
      })
    })
  })
}

async function waitForCdp(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = '未知错误'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await delay(200)
  }
  throw new Error(`等待 WebView2 CDP 端口 ${port} 超时（最后错误：${lastError}）`)
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

export interface LaunchedApp {
  page: Page
  browser: Browser
  process: ChildProcess
  cdpPort: number
  /** 关闭连接并结束应用进程。 */
  close: () => Promise<void>
}

export interface LaunchOptions {
  /** 通过命令行参数打开的 Vault 目录。 */
  vaultPath?: string
  /** 固定 CDP 端口（默认自动分配）。 */
  cdpPort?: number
  /** 等待 WebView 就绪的上限（毫秒）。 */
  readyTimeoutMs?: number
}

/** 启动应用并接管它的 WebView。 */
export async function launchApp(options: LaunchOptions = {}): Promise<LaunchedApp> {
  assertBinaryExists()

  const port = options.cdpPort ?? (await findFreePort())
  const args = options.vaultPath === undefined ? [] : [options.vaultPath]
  const child = spawn(appBinaryPath(), args, {
    env: {
      ...process.env,
      // WebView2 只认这个环境变量来附加浏览器参数
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: 'ignore',
    windowsHide: false,
  })

  let browser: Browser | null = null
  let page: Page | null = null
  try {
    await waitForCdp(port, options.readyTimeoutMs ?? 30_000)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    const context = browser.contexts()[0]
    if (context === undefined) throw new Error('CDP 连接成功但没有默认 browser context')

    let first = context.pages()[0]
    if (first === undefined) first = await context.waitForEvent('page', { timeout: 15_000 })
    first.setDefaultTimeout(15_000)
    page = first
  } catch (error) {
    if (browser !== null) await browser.close().catch(() => undefined)
    if (child.exitCode === null) child.kill()
    throw error
  }

  if (browser === null || page === null) {
    if (child.exitCode === null) child.kill()
    throw new Error('启动应用失败：未拿到 WebView 页面')
  }
  const connectedBrowser = browser
  const connectedPage = page

  return {
    page: connectedPage,
    browser: connectedBrowser,
    process: child,
    cdpPort: port,
    close: async () => {
      await connectedBrowser.close().catch(() => undefined)
      if (child.exitCode === null) child.kill()
      // 给进程一点时间退出，避免影响下一个用例
      await delay(300)
    },
  }
}

export interface TempVault {
  path: string
  /** 写入/覆盖一篇笔记（相对路径用 `/`）。 */
  write: (relPath: string, content: string) => Promise<void>
  /** 读取笔记内容。 */
  read: (relPath: string) => Promise<string>
  /** 绝对路径。 */
  absolute: (relPath: string) => string
  cleanup: () => Promise<void>
}

/** 建一个临时 Vault（含给定的初始笔记）。 */
export async function createTempVault(notes: Record<string, string>): Promise<TempVault> {
  const path = await mkdtemp(join(tmpdir(), 'mimenote-e2e-'))

  const absolute = (relPath: string): string => join(path, ...relPath.split('/'))
  const write = async (relPath: string, content: string): Promise<void> => {
    const full = absolute(relPath)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content, 'utf8')
  }

  for (const [relPath, content] of Object.entries(notes)) {
    await write(relPath, content)
  }

  return {
    path,
    write,
    read: (relPath) => readFile(absolute(relPath), 'utf8'),
    absolute,
    cleanup: async () => {
      await rm(path, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
    },
  }
}

/** 轮询直到文件内容满足条件（用于验证"保存到磁盘"这类异步结果）。 */
export async function waitForFileContent(
  vault: TempVault,
  relPath: string,
  predicate: (content: string) => boolean,
  timeoutMs = 15_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    try {
      last = await vault.read(relPath)
      if (predicate(last)) return last
    } catch (error) {
      last = `（读取失败：${error instanceof Error ? error.message : String(error)}）`
    }
    await delay(150)
  }
  throw new Error(`等待 ${relPath} 满足条件超时。最后一次内容：\n${last}`)
}
