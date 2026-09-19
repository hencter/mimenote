import { readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))

/**
 * 这个模块是"被直接运行"还是"被测试 import"。
 *
 * 必须 `realpathSync`：macOS 上 `tmpdir()` 是 `/var/folders/…`，而 Node 解析出来的
 * `import.meta.url` 是 `/private/var/…`（`/var` 是软链）—— 直接比字符串会让 CLI 分支
 * 在 macOS 上静默不执行（退出码 0、没有输出），测试却只看到"没输出"。
 */
function isMainModule() {
  if (!process.argv[1]) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?$/
const jsonFiles = ['package.json', 'apps/desktop/package.json', 'apps/desktop/src-tauri/tauri.conf.json']

export function readWorkspaceVersion(source) {
  const sections = source.replaceAll('\r\n', '\n').split(/\n(?=[ \t]*\[)/)
  const workspace = sections.filter((section) => /^[ \t]*\[workspace\.package\][ \t]*(?:#[^\r\n]*)?\r?\n/.test(section))
  if (workspace.length !== 1) throw new Error('需要唯一的 [workspace.package] 段')
  const versions = [...workspace[0].matchAll(/^[ \t]*version[ \t]*=[ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)')[ \t]*(?:#[^\r\n]*)?$/gm)]
  if (versions.length !== 1) throw new Error('需要唯一的 workspace.package.version 字符串')
  return versions[0][1] ?? versions[0][2]
}

export function checkVersions(directory = root, tag) {
  if (tag !== undefined && (!tag.startsWith('v') || !isVersion(tag.slice(1)))) {
    throw new Error(`标签 ${JSON.stringify(tag)} 不是合法的发布版本（期望 vX.Y.Z 或 vX.Y.Z-prerelease，不支持构建元数据）`)
  }
  const versions = new Map()
  const errors = []
  for (const file of [...jsonFiles, 'Cargo.toml']) {
    try {
      const source = readFileSync(resolve(directory, file), 'utf8')
      const version = file === 'Cargo.toml' ? readWorkspaceVersion(source) : JSON.parse(source).version
      versions.set(file, version)
      if (!isVersion(version)) errors.push(`${file}: 非法或缺失的版本 ${JSON.stringify(version)}`)
    } catch (error) {
      errors.push(`${file}: ${error.message}`)
    }
  }
  const expected = tag === undefined ? versions.get('package.json') : tag.slice(1)
  for (const [file, version] of versions) {
    if (version !== expected) errors.push(`${file}: 实际 ${JSON.stringify(version)}，期望 ${JSON.stringify(expected)}`)
  }
  if (errors.length > 0) throw new Error(`版本校验失败：\n${errors.join('\n')}`)
  return expected
}

function isVersion(value) {
  return typeof value === 'string' && !/[\r\n]/.test(value) && versionPattern.test(value)
}

if (isMainModule()) {
  try {
    const args = process.argv.slice(2)
    if (args.length > 1) throw new Error('用法：node scripts/check-version.mjs [vX.Y.Z]')
    const version = checkVersions(root, args[0])
    console.log(`版本校验通过：${version}（四处版本一致）`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
