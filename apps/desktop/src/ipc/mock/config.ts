/**
 * ipc/mock/config.ts
 *

 */
import type { MockHost } from './host'



/**
 * `snippets_list` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function snippetsList(_host: MockHost, _a: Record<string, unknown>): Promise<unknown> {
          const snippets = [
            { name: 'example.css', css: '.mn-preview h1 { letter-spacing: 0.02em; }', sizeBytes: 44 },
          ]
          return snippets
}

/**
 * `config_read` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function configRead(host: MockHost, _a: Record<string, unknown>): Promise<unknown> {
  const { configContent, configFormat } = host
          // 没有配置文件 → 三个字段都是 null（正常状态，不是错误）
          const payload = {
            path:
              configContent === null || configFormat === null
                ? null
                : `.mimenote/config.${configFormat}`,
            format: configFormat,
            content: configContent,
          }
          return payload
}

/**
 * `config_write` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function configWrite(host: MockHost, a: Record<string, unknown>): Promise<unknown> {
          const format = String(a.format ?? '')
          if (format !== 'toml' && format !== 'yaml' && format !== 'json') {
            host.fail('PATH_INVALID', `Mock 只认 toml / yaml / json，收到：${format}`)
          }
          const content = String(a.content ?? '')
          if (content.length > 256 * 1024) {
            host.fail('TOO_LARGE', `配置内容过大：${content.length} 字节`)
          }
          host.configContent = content
          host.configFormat = format
          const outcome = { path: `.mimenote/config.${format}` }
          return outcome
}

/**
 * `templates_list` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function templatesList(host: MockHost, a: Record<string, unknown>): Promise<unknown> {
  const { files } = host
          const dirRel = String(a.dirRel ?? '.mimenote/templates').replace(/\/+$/, '')
          const prefix = dirRel === '' ? '' : `${dirRel}/`
          const templates = [...files.keys()]
            .filter((rel) => {
              if (!rel.startsWith(prefix)) return false
              const rest = rel.slice(prefix.length)
              return rest !== '' && !rest.includes('/') && rest.toLowerCase().endsWith('.md')
            })
            .sort()
            .map((rel) => ({
              name: rel.slice(prefix.length),
              relPath: rel,
              sizeBytes: new TextEncoder().encode(files.get(rel)?.text ?? '').length,
            }))
          return templates
}

/**
 * `version_info` 的处理体（从 mock-adapter.ts 逐字搬出，注释原样保留）。
 */
export async function versionInfo(_host: MockHost, _a: Record<string, unknown>): Promise<unknown> {
          const info = { app: '0.1.0', core: '0.1.0', tauri: 'mock' }
          return info
}
