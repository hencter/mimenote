/**
 * 插件 manifest（M4 第一批）：解析、校验与版本兼容判断。
 *
 * ADR-0005 把第三方插件推迟到 M4，条件是 manifest（id/name/version/minAppVersion/permissions）、
 * 权限声明与安装确认 UI、Worker 隔离、API 版本化、错误边界、卸载清理。本文件只做第一块 ——
 * "这份 manifest 能不能信"（纯函数，可单测）；隔离与动态加载是下一批（见文件头的后续说明）。
 *
 * 为什么校验风格学 `theme/tokens.ts`（返回问题列表 + 抛错只包一层）：
 * 安装确认 UI 要把**全部**问题一次展示给用户（"id 不合法且权限里有陌生项"），而不是修一个、
 * 弹一个。`validatePluginManifest` 因此收集全部问题，`parsePluginManifest` 在此之上抛错。
 */

/** M4 第一批承认的权限（白名单，宁缺勿滥）。 */
export const KNOWN_PERMISSIONS = ['commands'] as const

/** 权限名。 */
export type PluginPermission = (typeof KNOWN_PERMISSIONS)[number]

/** 插件 manifest（`manifest.json` 的形状）。 */
export interface PluginManifest {
  /** 全局唯一 ID（点分小写命名空间，如 `example.hello`；命令 ID 必须以它开头）。 */
  id: string
  /** 展示名。 */
  name: string
  /** 插件自身版本（`主.次.补`）。 */
  version: string
  /** 要求的最低应用版本（`主.次.补`，与 `version_info` 的应用版本同一口径）。 */
  minAppVersion: string
  /** 声明的权限（只认白名单里的）。 */
  permissions: PluginPermission[]
}

const ID_PATTERN = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?)+$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/

/** 校验 manifest，返回全部问题（空数组 = 合法）。 */
export function validatePluginManifest(value: unknown): string[] {
  const problems: string[] = []
  if (typeof value !== 'object' || value === null) {
    return ['manifest 必须是对象']
  }
  const record = value as Record<string, unknown>

  const id = record['id']
  if (typeof id !== 'string' || !ID_PATTERN.test(id) || id.length > 64) {
    problems.push('id 非法：小写点分命名空间（如 example.hello），每段字母数字开头结尾、可用连字符，总长 ≤64')
  }

  const name = record['name']
  if (typeof name !== 'string' || name.trim() === '' || name.trim().length > 64) {
    problems.push('name 非法：非空字符串，长度 ≤64')
  }

  const version = record['version']
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    problems.push('version 非法：必须是 主.次.补（如 0.1.0）')
  }

  const minAppVersion = record['minAppVersion']
  if (typeof minAppVersion !== 'string' || !VERSION_PATTERN.test(minAppVersion)) {
    problems.push('minAppVersion 非法：必须是 主.次.补（如 0.2.0）')
  }

  const permissions = record['permissions']
  if (!Array.isArray(permissions)) {
    problems.push('permissions 非法：必须是数组')
  } else {
    const seen = new Set<string>()
    for (const permission of permissions) {
      if (typeof permission !== 'string' || !(KNOWN_PERMISSIONS as readonly string[]).includes(permission)) {
        problems.push(`未知权限：${String(permission)}（本批只认 ${KNOWN_PERMISSIONS.join('、')}）`)
      } else if (seen.has(permission)) {
        problems.push(`重复权限：${permission}`)
      } else {
        seen.add(permission)
      }
    }
  }

  return problems
}

/** 解析 manifest（非法时抛错，错误信息是全部问题的一行一条）。 */
export function parsePluginManifest(value: unknown): PluginManifest {
  const problems = validatePluginManifest(value)
  if (problems.length > 0) {
    throw new Error(`插件 manifest 非法：\n${problems.map((problem) => `- ${problem}`).join('\n')}`)
  }
  const record = value as unknown as PluginManifest
  return {
    id: record.id,
    name: record.name.trim(),
    version: record.version,
    minAppVersion: record.minAppVersion,
    permissions: [...record.permissions],
  }
}

/** 比较两个 `主.次.补` 版本（负数 = a < b，0 = 相等，正数 = a > b）。 */
function compareVersions(a: string, b: string): number {
  const parse = (version: string): [number, number, number] => {
    const [major = 0, minor = 0, patch = 0] = version.split('.').map((part) => Number(part))
    return [major, minor, patch]
  }
  const [aMajor, aMinor, aPatch] = parse(a)
  const [bMajor, bMinor, bPatch] = parse(b)
  if (aMajor !== bMajor) return aMajor - bMajor
  if (aMinor !== bMinor) return aMinor - bMinor
  return aPatch - bPatch
}

/**
 * manifest 与当前应用版本是否兼容（`appVersion >= minAppVersion`）。
 *
 * 版本号比较只认 `主.次.补` 数字段：非法输入返回 `false`（调用方按"不兼容"处理，
 * 而不是在安装链路上再抛一次错）。
 */
export function isCompatibleManifest(manifest: PluginManifest, appVersion: string): boolean {
  if (!VERSION_PATTERN.test(manifest.minAppVersion) || !VERSION_PATTERN.test(appVersion)) return false
  return compareVersions(appVersion, manifest.minAppVersion) >= 0
}

/** 权限的中文说明（安装确认 UI 逐条展示）。 */
export function describePermission(permission: PluginPermission): string {
  switch (permission) {
    case 'commands':
      return '注册命令：在命令面板与菜单里添加入口（只能以插件 ID 开头，不可覆盖内置命令）'
  }
}

/** manifest 请求的全部权限说明（确认 UI 用）。 */
export function describePermissions(permissions: readonly PluginPermission[]): string[] {
  return permissions.map(describePermission)
}
