/**
 * UI 层 E2E 用的极简静态服务器：把构建产物 `dist/` 以 http 提供服务。
 *
 * 为什么不用 `vite preview`：那会多起一个进程、多一个端口、多一份日志噪音；
 * 我们要的只是"把 dist 端给浏览器"。因此这里用 node:http 手写 40 行，
 * 只支持 GET/HEAD + 少量 MIME 类型，不引入新依赖。
 */

import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

export interface StaticServer {
  url: string
  close: () => Promise<void>
}

/** 启动静态服务器（root 之外的路径一律拒绝）。 */
export async function startStaticServer(root: string, port: number): Promise<StaticServer> {
  const rootDir = resolve(root)
  if (!existsSync(join(rootDir, 'index.html'))) {
    throw new Error(`dist 不存在或不完整：${rootDir}（请先 pnpm build）`)
  }

  const server: Server = createServer((request, response) => {
    const rawPath = (request.url ?? '/').split('?')[0] ?? '/'
    const relative = normalize(decodeURIComponent(rawPath)).replace(/^([/\\])+/, '')
    let filePath = resolve(rootDir, relative)
    if (!filePath.startsWith(rootDir)) {
      response.writeHead(403).end('forbidden')
      return
    }
    // SPA 回退：未知路径一律返回 index.html
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      filePath = join(rootDir, 'index.html')
    }
    response.writeHead(200, {
      'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    createReadStream(filePath).pipe(response)
  })

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolveListen())
  })

  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose())
      }),
  }
}
