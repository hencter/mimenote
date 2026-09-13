/**
 * 资源路径解析测试（`asset:` 协议的前置安全判定）。
 *
 * 重点不是"能拼出路径"，而是**该拒绝的都拒绝**：这是把笔记内容变成宿主绝对路径的入口，
 * 任何一条放行都可能让预览去读 Vault 之外的文件。真正的权威判定在宿主
 * （`path_guard::resolve_existing`，含逐级符号链接检查），这里只是第一道闸。
 */

import { describe, expect, it } from 'vitest'

import {
  createAssetResolver,
  isExternalAssetHref,
  isImageAssetTarget,
  resolveVaultAssetRel,
} from '@/domain/assets'

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

describe('resolveVaultAssetRel', () => {
  it('相对当前笔记解析（跨目录用 ..），输出 POSIX 相对路径', () => {
    expect(resolveVaultAssetRel('项目/设计.md', '图.png')).toBe('项目/图.png')
    expect(resolveVaultAssetRel('项目/子/设计.md', '../图.png')).toBe('项目/图.png')
    expect(resolveVaultAssetRel('项目/设计.md', './子/图.png')).toBe('项目/子/图.png')
    expect(resolveVaultAssetRel('顶层.md', '附件/图.png')).toBe('附件/图.png')
    expect(resolveVaultAssetRel('a/b/c.md', '../../图.png')).toBe('图.png')
  })

  it('Vault 根绝对路径（`/` 开头）', () => {
    expect(resolveVaultAssetRel('项目/设计.md', '/附件/图.png')).toBe('附件/图.png')
  })

  it('反斜杠与百分号编码按原样归一', () => {
    expect(resolveVaultAssetRel('项目/设计.md', '子\\图.png')).toBe('项目/子/图.png')
    expect(resolveVaultAssetRel('项目/设计.md', '%E5%9B%BE.png')).toBe('项目/图.png')
    // 非法编码不抛错，按原样处理（`%` 不是 Windows 非法字符，所以会保留）
    expect(resolveVaultAssetRel('项目/设计.md', '%zz.png')).toBe('项目/%zz.png')
  })

  it('拒绝越界（`..` 走出 Vault）', () => {
    expect(resolveVaultAssetRel('设计.md', '../图.png')).toBeNull()
    expect(resolveVaultAssetRel('a/b.md', '../../图.png')).toBeNull()
    expect(resolveVaultAssetRel('设计.md', '../../../../etc/passwd')).toBeNull()
    // 口径是"过程中任何时刻越出根都拒绝"
    expect(resolveVaultAssetRel('a/b.md', '../../a/图.png')).toBeNull()
  })

  it('拒绝外部地址、空地址与"只解析到根"的地址', () => {
    expect(resolveVaultAssetRel('设计.md', 'https://x/y.png')).toBeNull()
    expect(resolveVaultAssetRel('设计.md', 'data:image/png;base64,AA')).toBeNull()
    expect(resolveVaultAssetRel('设计.md', '   ')).toBeNull()
    expect(resolveVaultAssetRel('设计.md', '.')).toBeNull()
    expect(resolveVaultAssetRel('设计.md', '..')).toBeNull()
  })

  it('拒绝 Windows 非法字符与保留设备名', () => {
    expect(resolveVaultAssetRel('设计.md', 'a:b.png')).toBeNull()
    expect(resolveVaultAssetRel('设计.md', 'a|b.png')).toBeNull()
    expect(resolveVaultAssetRel('设计.md', 'con.png')).toBeNull()
    expect(resolveVaultAssetRel('设计.md', 'COM1')).toBeNull()
  })
})

/**
 * `![[…]]` 嵌入（Obsidian 风格）的目标最终也喂给 `resolveVaultAssetRel`
 * （见 `domain/markdown.ts` 的 `mn_embed` 规则），所以这里把它常见写法的行为钉死。
 */
describe('createAssetResolver（带全库索引的图片解析）', () => {
  const entries = [
    { relPath: '项目/设计.md', isDir: false },
    { relPath: '项目/子项目', isDir: true },
    { relPath: '项目/图.png', isDir: false },
    { relPath: '附件/示例图片.png', isDir: false },
    { relPath: '附件/图.png', isDir: false },
    { relPath: '素材/图.png', isDir: false },
  ]
  const resolve = createAssetResolver(entries)

  it('相对当前笔记能找到就用它（就近优先）', () => {
    expect(resolve('项目/设计.md', '图.png')).toBe('项目/图.png')
    expect(resolve('项目/设计.md', './子项目/../图.png')).toBe('项目/图.png')
  })

  it('Vault 绝对写法直接生效', () => {
    expect(resolve('项目/设计.md', '/附件/图.png')).toBe('附件/图.png')
  })

  it('裸文件名在本目录找不到时，按文件名在整库兜底（Obsidian 用法）', () => {
    // 设计.md 在 项目/ 下、没有 项目/示例图片.png —— 但整库只有一张同名图
    expect(resolve('项目/设计.md', '示例图片.png')).toBe('附件/示例图片.png')
  })

  it('同名多张时选"路径更短 → 字典序"，结果可复现', () => {
    expect(resolve('项目/设计.md', '图.png')).toBe('项目/图.png') // 本目录存在，直接命中
    expect(resolve('其它/笔记.md', '图.png')).toBe('附件/图.png') // 两个候选同长 → 字典序
  })

  it('外部地址与空地址不会伪造出路径；都找不到时交回相对解析结果', () => {
    expect(resolve('项目/设计.md', 'https://x/y.png')).toBeNull()
    expect(resolve('项目/设计.md', '')).toBeNull()
    // 交回相对解析结果（而不是 null）：既有失败语义是"宿主拒了就占位"，
    // 提前判死会让"文件存在但快照过期"的情况白白不请求
    expect(resolve('项目/设计.md', '没有这张图.png')).toBe('项目/没有这张图.png')
  })

  it('越界写法仍然被拒绝', () => {
    expect(resolve('设计.md', '../图.png')).toBeNull()
  })
})

describe('isImageAssetTarget（`![[…]]` 的图片分流）', () => {
  it('白名单与宿主一致：png/jpg/jpeg/gif/webp/avif/bmp/svg/ico，大小写不敏感', () => {
    for (const name of [
      '图.png',
      '图.JPG',
      '图.JpEg',
      '图.gif',
      '图.WEBP',
      '图.avif',
      '图.BMP',
      '图.svg',
      '图.ico',
    ]) {
      expect(isImageAssetTarget(name), name).toBe(true)
    }
  })

  it('带目录或反斜杠时只看最后一段', () => {
    expect(isImageAssetTarget('附件/图.png')).toBe(true)
    expect(isImageAssetTarget('附件\\子\\图.png')).toBe(true)
    expect(isImageAssetTarget('/附件/图.svg')).toBe(true)
  })

  it('非图片、扩展名缺失、点开头的隐藏文件都不算图片', () => {
    for (const target of [
      '另一篇笔记',
      '笔记.md',
      '附件/数据.json',
      '图.png.txt',
      '图.',
      '.gitignore',
      '.png',
      '',
      '   ',
    ]) {
      expect(isImageAssetTarget(target), target).toBe(false)
    }
  })
})

describe('resolveVaultAssetRel：`![[…]]` 里的目标写法', () => {
  it('纯文件名与带目录都相对当前笔记解析（与 `![](…)` 同一口径）', () => {
    expect(resolveVaultAssetRel('笔记/图片.md', '图.png')).toBe('笔记/图.png')
    expect(resolveVaultAssetRel('笔记/图片.md', '附件/图.png')).toBe('笔记/附件/图.png')
    expect(resolveVaultAssetRel('笔记/子/图片.md', '附件/图.png')).toBe('笔记/子/附件/图.png')
    // 反斜杠写法（Windows 习惯）同样认
    expect(resolveVaultAssetRel('笔记/图片.md', '附件\\图.png')).toBe('笔记/附件/图.png')
  })

  it('只有以 `/` 开头才是 Vault 根', () => {
    expect(resolveVaultAssetRel('笔记/图片.md', '/附件/图.png')).toBe('附件/图.png')
  })

  it('嵌入目标同样受越界、非法字符与保留名约束（拒绝面不打折）', () => {
    // 笔记在 Vault 根时，`..` 直接越界
    expect(resolveVaultAssetRel('图片.md', '../外部.png')).toBeNull()
    expect(resolveVaultAssetRel('图片.md', '../../外部.png')).toBeNull()
    // `|别名` 本该由 markdown.ts 的 splitWikilink 先剥掉；万一原样传进来，
    // `|` 是 Windows 非法字符，这里会拒绝 —— 双保险
    expect(resolveVaultAssetRel('笔记/图片.md', '图.png|图注')).toBeNull()
    expect(resolveVaultAssetRel('笔记/图片.md', 'a:b.png')).toBeNull()
    expect(resolveVaultAssetRel('笔记/图片.md', 'con.png')).toBeNull()
    expect(resolveVaultAssetRel('笔记/图片.md', 'https://x/图.png')).toBeNull()
  })
})
