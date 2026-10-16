/** 插件 manifest：校验、解析与版本兼容（M4 纯函数部分）。 */

import { describe, expect, it } from 'vitest'

import {
  describePermissions,
  isCompatibleManifest,
  parsePluginManifest,
  validatePluginManifest,
} from '@/features/plugins/manifest'

const VALID = {
  id: 'example.hello',
  name: '示例插件',
  version: '0.1.0',
  minAppVersion: '0.2.0',
  permissions: ['commands'],
}

describe('validatePluginManifest', () => {
  it('合法 manifest 没有问题', () => {
    expect(validatePluginManifest(VALID)).toEqual([])
  })

  it('非对象直接拒', () => {
    expect(validatePluginManifest(null)).toHaveLength(1)
    expect(validatePluginManifest('x')).toHaveLength(1)
  })

  it('id 必须点分小写命名空间', () => {
    expect(validatePluginManifest({ ...VALID, id: 'Hello' }).length).toBeGreaterThan(0)
    expect(validatePluginManifest({ ...VALID, id: 'nodot' }).length).toBeGreaterThan(0)
    expect(validatePluginManifest({ ...VALID, id: '' }).length).toBeGreaterThan(0)
  })

  it('name/version/minAppVersion 逐项校验', () => {
    expect(validatePluginManifest({ ...VALID, name: '  ' }).length).toBeGreaterThan(0)
    expect(validatePluginManifest({ ...VALID, version: '1' }).length).toBeGreaterThan(0)
    expect(validatePluginManifest({ ...VALID, minAppVersion: 'x' }).length).toBeGreaterThan(0)
  })

  it('未知权限与重复权限都报出来（一次展示全部问题）', () => {
    const problems = validatePluginManifest({ ...VALID, permissions: ['commands', 'network', 'commands'] })
    expect(problems.join('\n')).toContain('未知权限')
    expect(problems.join('\n')).toContain('重复权限')
  })
})

describe('parsePluginManifest', () => {
  it('合法时原样返回（name 去空格，permissions 复制）', () => {
    const manifest = parsePluginManifest({ ...VALID, name: ' 示例 ' })
    expect(manifest.name).toBe('示例')
    expect(manifest.permissions).toEqual(['commands'])
  })

  it('非法时抛错且信息含全部问题', () => {
    expect(() => parsePluginManifest({})).toThrow(/插件 manifest 非法/)
  })
})

describe('isCompatibleManifest', () => {
  it('应用版本 ≥ minAppVersion 才兼容', () => {
    const manifest = parsePluginManifest(VALID)
    expect(isCompatibleManifest(manifest, '0.2.0')).toBe(true)
    expect(isCompatibleManifest(manifest, '0.3.1')).toBe(true)
    expect(isCompatibleManifest(manifest, '0.1.9')).toBe(false)
    expect(isCompatibleManifest(manifest, 'not-a-version')).toBe(false)
  })
})

describe('describePermissions', () => {
  it('每条权限都有中文说明', () => {
    expect(describePermissions(['commands'])).toHaveLength(1)
    expect(describePermissions(['commands'])[0]).toContain('注册命令')
  })
})
