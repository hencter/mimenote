/**
 * 资源路径解析测试（`asset:` 协议的前置安全判定）。
 *
 * 重点不是"能拼出路径"，而是**该拒绝的都拒绝**：这是把笔记内容变成磁盘绝对路径的
 * 唯一入口，任何一条放行都可能让预览去读 Vault 之外的文件。
 */

import { describe, expect, it } from 'vitest'

import { isExternalAssetHref, resolveVaultAssetPath } from '@/domain/assets'

describe('isExternalAssetHref', () => {
  it('识别外部与内联地址', () => {
    for (const href of ['http://x/y.png', 'https://x/y.png', 'data:image/png;base64,AA', 'blob:x', 'asset://localhost/x', '//cdn/x.png', 'MAILTO:a@b']) {
      expect(isExternalAssetHref(href), href).toBe(true)
    }
  })

  it('相对路径与根绝对路径都算 Vault 内', () => {
    for (const href of ['图.png', './图.png', '../附件/图.png', '/附件/图.png', 'a/b.PNG']) {
      expect(isExternalAssetHref(href), href).toBe(false)
    }
  })
})

describe('resolveVaultAssetPath', () => {
  const root = 'D:\\Vault'

  it('相对当前笔记解析（跨目录用 ..）', () => {
    expect(resolveVaultAssetPath(root, '项目/设计.md', '图.png')).toBe('D:\\Vault\\项目\\图.png')
    expect(resolveVaultAssetPath(root, '项目/子/设计.md', '../图.png')).toBe('D:\\Vault\\项目\\图.png')
    expect(resolveVaultAssetPath(root, '项目/设计.md', './子/图.png')).toBe('D:\\Vault\\项目\\子\\图.png')
    expect(resolveVaultAssetPath(root, '顶层.md', '附件/图.png')).toBe('D:\\Vault\\附件\\图.png')
  })

  it('Vault 根绝对路径（`/` 开头）', () => {
    expect(resolveVaultAssetPath(root, '项目/设计.md', '/附件/图.png')).toBe('D:\\Vault\\附件\\图.png')
  })

  it('反斜杠与百分号编码按原样归一', () => {
    expect(resolveVaultAssetPath(root, '项目/设计.md', '子\\图.png')).toBe('D:\\Vault\\项目\\子\\图.png')
    expect(resolveVaultAssetPath(root, '项目/设计.md', '%E5%9B%BE.png')).toBe('D:\\Vault\\项目\\图.png')
    // 非法编码不抛错，按原样处理
    expect(resolveVaultAssetPath(root, '项目/设计.md', '%zz.png')).toBe('D:\\Vault\\项目\\%zz.png')
  })

  it('根路径结尾的分隔符不会拼出双斜杠', () => {
    expect(resolveVaultAssetPath('D:\\Vault\\', '项目/设计.md', '图.png')).toBe('D:\\Vault\\项目\\图.png')
    expect(resolveVaultAssetPath('/home/me/Vault/', 'a.md', '图.png')).toBe('/home/me/Vault/图.png')
  })

  it('拒绝越界（`..` 走出 Vault）', () => {
    expect(resolveVaultAssetPath(root, '设计.md', '../图.png')).toBeNull()
    expect(resolveVaultAssetPath(root, 'a/b.md', '../../图.png')).toBeNull()
    expect(resolveVaultAssetPath(root, '设计.md', '../../../../etc/passwd')).toBeNull()
    // 口径是"过程中任何时候越出根都拒绝"（哪怕后文又用 `a/` 绕回来）：
    // 允许"出去再回来"会让判定依赖整条路径，容易在后续改动里被绕过。
    expect(resolveVaultAssetPath(root, 'a/b.md', '../../a/图.png')).toBeNull()
    // 没越界的多级 `..` 正常放行
    expect(resolveVaultAssetPath(root, 'a/b/c.md', '../../图.png')).toBe('D:\\Vault\\图.png')
  })

  it('拒绝外部地址、空地址与"只解析到根"的地址', () => {
    expect(resolveVaultAssetPath(root, '设计.md', 'https://x/y.png')).toBeNull()
    expect(resolveVaultAssetPath(root, '设计.md', 'data:image/png;base64,AA')).toBeNull()
    expect(resolveVaultAssetPath(root, '设计.md', '   ')).toBeNull()
    expect(resolveVaultAssetPath(root, '设计.md', '.')).toBeNull()
    expect(resolveVaultAssetPath(root, '设计.md', '..')).toBeNull()
  })

  it('拒绝 Windows 非法字符与保留设备名', () => {
    expect(resolveVaultAssetPath(root, '设计.md', 'a:b.png')).toBeNull()
    expect(resolveVaultAssetPath(root, '设计.md', 'a|b.png')).toBeNull()
    expect(resolveVaultAssetPath(root, '设计.md', 'con.png')).toBeNull()
    expect(resolveVaultAssetPath(root, '设计.md', 'COM1')).toBeNull()
  })
})
