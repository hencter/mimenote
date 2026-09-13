/**
 * 图片附件的**命名与落盘规则**（ADR-0013）。
 *
 * 分两层，理由与 `tests/assets.test.ts` 同一套：
 *
 * 1. **纯函数层**（`domain/attachments.ts`）：命名、去重、相对路径与 Markdown 语法。
 *    这些规则全是"用户能看到结果"的边界（通用名、无扩展名、重名、空格、保留名），
 *    在这里逐条钉死，就不必等到真实磁盘上才发现"粘第二张把第一张覆盖了"；
 * 2. **Mock 适配器层**：`attachment_save` 的镜像行为必须与宿主**逐条对齐** ——
 *    白名单、三道上限、去重、附件目录、返回契约。Mock 与真实宿主一旦漂移，
 *    所有跑在它上面的 UI 测试都会变成假绿。
 *
 * 权威判定在 `src-tauri/src/attachments.rs`（那里的单测覆盖路径越界、符号链接逃逸、
 * 原子写不留临时文件）；这里覆盖的是"前端送过去什么"与"前端怎么用返回结果"。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_ATTACHMENT_DIR,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BATCH_BYTES,
  MAX_ATTACHMENT_BYTES,
  attachmentFileName,
  attachmentMarkdown,
  attachmentTimestamp,
  bytesToBase64,
  encodeMarkdownHref,
  estimatedDecodedBytes,
  extensionForImage,
  isGenericImageName,
  normalizeAttachmentDir,
  relativeAssetHref,
  sanitizeAttachmentStem,
  uniqueAttachmentName,
} from '@/domain/attachments'
import { setIpcAdapter } from '@/ipc/client'
import { createMockAdapter } from '@/ipc/mock-adapter'
import { ipc } from '@/ipc/client'
import { MimenoteError } from '@/ipc/types'

/** 固定时刻，让时间戳名可预期。 */
const AT = new Date(2025, 0, 1, 12, 34, 56)

describe('扩展名推断（MIME → 扩展名）', () => {
  it('MIME 认得就用 MIME（原文件名可能是 blob、没有扩展名）', () => {
    expect(extensionForImage('image/png', 'blob')).toBe('png')
    expect(extensionForImage('image/jpeg', '')).toBe('jpg')
    expect(extensionForImage('IMAGE/GIF', 'x')).toBe('gif')
    expect(extensionForImage('image/svg+xml', 'x')).toBe('svg')
    expect(extensionForImage('image/x-icon', 'x')).toBe('ico')
  })

  it('MIME 缺失或不是图片时退到原文件名的扩展名（但必须在白名单里）', () => {
    expect(extensionForImage('', '屏幕截图.PNG')).toBe('png')
    expect(extensionForImage('application/octet-stream', '图.webp')).toBe('webp')
  })

  it('是图片类型但不支持（tiff/heic）→ 拒绝，不退回文件名', () => {
    // 名字写着 `.png` 但字节是 TIFF：按名字落盘会造出一个"扩展名撒谎"的文件
    expect(extensionForImage('image/tiff', '扫描.png')).toBeNull()
    expect(extensionForImage('image/heic', '照片.heic')).toBeNull()
  })

  it('两者都拿不到就拒绝（绝不蒙一个扩展名）', () => {
    expect(extensionForImage('', 'blob')).toBeNull()
    expect(extensionForImage('', '说明.pdf')).toBeNull()
    expect(extensionForImage('application/pdf', '说明.pdf')).toBeNull()
    expect(extensionForImage('image/tiff', '扫描.tiff')).toBeNull()
    expect(extensionForImage('image/heic', '照片.heic')).toBeNull()
  })
})

describe('通用名判定', () => {
  it('剪贴板/截图工具给的通用名', () => {
    for (const name of ['image.png', 'IMAGE.PNG', 'blob', 'untitled.png', 'paste.png', '图片.png']) {
      expect(isGenericImageName(name), name).toBe(true)
    }
  })

  it('无扩展名、空名、只有扩展名也算"没有信息量"', () => {
    for (const name of ['', '   ', 'screenshot', '.png']) {
      expect(isGenericImageName(name), name).toBe(true)
    }
  })

  it('用户自己有意义的文件名不动它', () => {
    for (const name of ['屏幕截图 2025-01-01.png', '设计稿.png', 'image-2.png', '我的图.png']) {
      expect(isGenericImageName(name), name).toBe(false)
    }
  })
})

describe('命名规则', () => {
  it('保留原文件名（用户认得出它是什么）', () => {
    expect(attachmentFileName({ name: '屏幕截图 2025-01-01.png', mime: 'image/png', at: AT })).toBe(
      '屏幕截图 2025-01-01.png',
    )
  })

  it('通用名换成带时间戳的名字（连续粘贴不会互相去重）', () => {
    expect(attachmentFileName({ name: 'image.png', mime: 'image/png', at: AT })).toBe(
      '粘贴图片 2025-01-01 123456.png',
    )
    expect(attachmentFileName({ name: 'blob', mime: 'image/png', at: AT })).toBe(
      '粘贴图片 2025-01-01 123456.png',
    )
    // 无扩展名但有意义的写法同样换名：扩展名只能靠 MIME 补，名字里没有信息
    expect(attachmentFileName({ name: 'screenshot', mime: 'image/webp', at: AT })).toBe(
      '粘贴图片 2025-01-01 123456.webp',
    )
    expect(attachmentFileName({ name: '', mime: 'image/gif', at: AT })).toBe(
      '粘贴图片 2025-01-01 123456.gif',
    )
  })

  it('扩展名一律来自推断结果（不信原文件名的写法）', () => {
    expect(attachmentFileName({ name: '图.png', mime: 'image/jpeg', at: AT })).toBe('图.jpg')
  })

  it('时间戳格式：`YYYY-MM-DD HHmmss`（文件名里不能有冒号）', () => {
    expect(attachmentTimestamp(AT)).toBe('2025-01-01 123456')
    expect(attachmentTimestamp(new Date(2025, 10, 9, 8, 7, 6))).toBe('2025-11-09 080706')
  })

  it('非法字符被安全化；安全化之后什么都不剩（或撞上保留名）才换名', () => {
    expect(attachmentFileName({ name: 'a:b?c.png', mime: 'image/png', at: AT })).toBe('a-b-c.png')
    expect(attachmentFileName({ name: '  图.png  ', mime: 'image/png', at: AT })).toBe('图.png')
    // `con` 是 Windows 保留设备名：与其造一个 `con-附件.png` 这种怪名字，不如换成时间戳名
    expect(attachmentFileName({ name: 'con.png', mime: 'image/png', at: AT })).toBe(
      '粘贴图片 2025-01-01 123456.png',
    )
    expect(attachmentFileName({ name: '***.png', mime: 'image/png', at: AT })).toBe(
      '粘贴图片 2025-01-01 123456.png',
    )
  })

  it('类型拿不到就返回 null（调用方必须拒绝，而不是落一个无类型文件）', () => {
    expect(attachmentFileName({ name: '说明.pdf', mime: 'application/pdf', at: AT })).toBeNull()
    expect(attachmentFileName({ name: 'blob', mime: '', at: AT })).toBeNull()
  })
})

describe('去重（绝不覆盖同名文件）', () => {
  it('已有同名就追加 ` 1` / ` 2`，直到唯一', () => {
    const taken = new Set(['图.png', '图 1.png'])
    expect(uniqueAttachmentName('图.png', (name) => taken.has(name))).toBe('图 2.png')
  })

  it('没冲突时原样返回；扩展名跟着走（名字里有多个点时按最后一个拆）', () => {
    expect(uniqueAttachmentName('图.png', () => false)).toBe('图.png')
    const taken = new Set(['我的图.tar.png'])
    expect(uniqueAttachmentName('我的图.tar.png', (name) => taken.has(name))).toBe(
      '我的图.tar 1.png',
    )
  })

  it('尝试次数用尽返回 null（宿主侧对应 ALREADY_EXISTS，而不是回退成覆盖）', () => {
    expect(uniqueAttachmentName('图.png', () => true, 5)).toBeNull()
  })
})

describe('相对路径与 Markdown 语法', () => {
  it('相对当前笔记解析（同目录不带前缀，跨目录补 `..`）', () => {
    expect(relativeAssetHref('项目/设计.md', '项目/图.png')).toBe('图.png')
    expect(relativeAssetHref('项目/设计.md', '附件/图.png')).toBe('../附件/图.png')
    expect(relativeAssetHref('随手记.md', '附件/图.png')).toBe('附件/图.png')
    expect(relativeAssetHref('a/b/c.md', '附件/图.png')).toBe('../../附件/图.png')
    expect(relativeAssetHref('项目/设计.md', '项目/子/图.png')).toBe('子/图.png')
  })

  it('绝不吃掉目标的文件名（共同前缀最多比到倒数第二段）', () => {
    expect(relativeAssetHref('图/设计.md', '图/图.png')).toBe('图.png')
  })

  it('地址里的空格与括号必须转义，否则链接会被截断', () => {
    // 空格：CommonMark 的地址遇到空白就结束 → 不转义的话 `![](屏幕截图 2025-01-01.png)`
    // 只会把 `屏幕截图` 当地址，图片永远显示不出来
    expect(encodeMarkdownHref('附件/屏幕截图 2025-01-01.png')).toBe(
      '附件/屏幕截图%202025-01-01.png',
    )
    expect(encodeMarkdownHref('附件/图 (1).png')).toBe('附件/图%20%281%29.png')
    expect(encodeMarkdownHref('附件/50%off.png')).toBe('附件/50%25off.png')
    // 中文保持可读（与 `resolveVaultAssetRel` 的解码口径一致）
    expect(encodeMarkdownHref('附件/图.png')).toBe('附件/图.png')
  })

  it('插入的语法就是 `![](相对路径)`（alt 留空，避免阅读视图里多出一行图注）', () => {
    expect(attachmentMarkdown('项目/设计.md', '附件/粘贴图片 2025-01-01 123456.png')).toBe(
      '![](../附件/粘贴图片%202025-01-01%20123456.png)',
    )
  })
})

describe('文件名主干安全化', () => {
  it('分隔符与非法字符换成 `-`，收掉首尾空白与尾随点', () => {
    expect(sanitizeAttachmentStem('a/b\\c')).toBe('a-b-c')
    expect(sanitizeAttachmentStem('  图.png  '.replace('.png', ''))).toBe('图')
    expect(sanitizeAttachmentStem('结尾点.')).toBe('结尾点')
    expect(sanitizeAttachmentStem('多   个  空格')).toBe('多 个 空格')
  })

  it('全是非法字符、空串、保留名一律返回空串（由调用方走换名）', () => {
    for (const input of ['', '   ', '///', '...', 'con', 'NUL']) {
      expect(sanitizeAttachmentStem(input), input).toBe('')
    }
  })
})

describe('附件目录设置值归一化', () => {
  it('空值 = Vault 根；正常目录原样保留（去掉反斜杠与首尾 `/`）', () => {
    expect(normalizeAttachmentDir('')).toBe('')
    expect(normalizeAttachmentDir('   ')).toBe('')
    expect(normalizeAttachmentDir('assets')).toBe('assets')
    expect(normalizeAttachmentDir('素材/图片')).toBe('素材/图片')
    expect(normalizeAttachmentDir('\\素材\\图片\\')).toBe('素材/图片')
    expect(normalizeAttachmentDir('/附件/')).toBe('附件')
  })

  it('绝对路径、`..`、非法字符、保留名一律回退到默认值（而不是留个永远失败的值）', () => {
    for (const bad of ['C:/外部', 'C:\\外部', '../外面', 'a/../b', 'a//b', 'con', 'a:b', 'a /b']) {
      expect(normalizeAttachmentDir(bad), bad).toBe(DEFAULT_ATTACHMENT_DIR)
    }
    // 整个值前后的空白只是输入噪声，去掉之后照常生效（与"段内空格"不同）
    expect(normalizeAttachmentDir('  附件  ')).toBe('附件')
  })
})

describe('字节与 base64', () => {
  it('编码结果与宿主 `assets::base64_encode` 的 RFC 4648 向量一致', () => {
    const encode = (text: string): string => bytesToBase64(new TextEncoder().encode(text))
    expect(encode('')).toBe('')
    expect(encode('f')).toBe('Zg==')
    expect(encode('fo')).toBe('Zm8=')
    expect(encode('foo')).toBe('Zm9v')
    expect(encode('foobar')).toBe('Zm9vYmFy')
    // 非 ASCII 与 0xff：编码的是**字节**
    expect(encode('图')).toBe('5Zu+')
    expect(bytesToBase64(new Uint8Array([0x00, 0xff, 0x10, 0x80]))).toBe('AP8QgA==')
  })

  it('上界换算与宿主 `attachments.rs::estimated_bytes` 同口径', () => {
    expect(estimatedDecodedBytes(0)).toBe(0)
    expect(estimatedDecodedBytes(4)).toBe(3)
    expect(estimatedDecodedBytes(6)).toBe(3)
  })

  it('三道上限的数字与宿主一致（改这里等于改"能粘什么图"）', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(8 * 1024 * 1024)
    expect(MAX_ATTACHMENT_BATCH_BYTES).toBe(32 * 1024 * 1024)
    expect(MAX_ATTACHMENTS).toBe(32)
  })
})

// ---------------------------------------------------------------------------
// Mock 适配器：`attachment_save` 的镜像行为
// ---------------------------------------------------------------------------

interface RecordedCall {
  method: string
  args: Record<string, unknown>
}

/** 记录调用的适配器：对外表现与 Mock 完全一致，只是多留一份"前端到底发了什么"。 */
function recordingMock() {
  const inner = createMockAdapter()
  const calls: RecordedCall[] = []
  setIpcAdapter({
    kind: 'test',
    async invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
      calls.push({ method, args: args ?? {} })
      return inner.invoke<T>(method, args)
    },
  })
  return { inner, calls }
}

/** 一张 1×1 PNG 的字节（够真实，又不必引入图片库）。 */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function attachmentInput(name: string, bytes: Uint8Array) {
  return { name, dataBase64: bytesToBase64(bytes) }
}

describe('Mock 的 `attachment_save` 镜像', () => {
  let calls: RecordedCall[]

  beforeEach(() => {
    calls = recordingMock().calls
  })

  afterEach(() => {
    calls = []
  })

  it('落盘 + 返回契约（camelCase 的 relPath/sizeBytes），并进入条目表', async () => {
    const saved = await ipc.attachmentSave('附件', [attachmentInput('图.png', PNG_BYTES)])

    expect(calls[0]).toEqual({
      method: 'attachment_save',
      args: { dirRel: '附件', files: [attachmentInput('图.png', PNG_BYTES)] },
    })
    expect(saved).toEqual([{ relPath: '附件/图.png', sizeBytes: PNG_BYTES.length }])

    // 条目表（文件树的数据源）里真的多了一条：证明"文件树刷新"不是靠重扫
    const snapshot = await ipc.vaultSnapshot()
    const entry = snapshot.entries.find((item) => item.relPath === '附件/图.png')
    expect(entry).toBeDefined()
    expect(entry?.sizeBytes).toBe(PNG_BYTES.length)
    expect(entry?.ext).toBe('png')
  })

  it('附件目录不存在时自动创建（目录条目也进表，否则树会把它当根节点）', async () => {
    await ipc.attachmentSave('素材/新建', [attachmentInput('图.png', PNG_BYTES)])
    const snapshot = await ipc.vaultSnapshot()
    const paths = snapshot.entries.map((item) => item.relPath)
    expect(paths).toContain('素材')
    expect(paths).toContain('素材/新建')
    expect(paths).toContain('素材/新建/图.png')
  })

  it('空目录 = Vault 根', async () => {
    const saved = await ipc.attachmentSave('', [attachmentInput('图.png', PNG_BYTES)])
    expect(saved[0]?.relPath).toBe('图.png')
  })

  it('同名不覆盖：第二次落成 ` 1`，同一批里的重名也让位', async () => {
    await ipc.attachmentSave('附件', [attachmentInput('图.png', PNG_BYTES)])
    const second = await ipc.attachmentSave('附件', [attachmentInput('图.png', PNG_BYTES)])
    expect(second[0]?.relPath).toBe('附件/图 1.png')

    const batch = await ipc.attachmentSave('附件', [
      attachmentInput('图 1.png', PNG_BYTES),
      attachmentInput('图 1.png', PNG_BYTES),
    ])
    expect(batch.map((item) => item.relPath)).toEqual(['附件/图 1 1.png', '附件/图 1 2.png'])
  })

  it('非图片扩展名 → UNSUPPORTED_MEDIA（可分支的稳定错误码，不是 UNKNOWN）', async () => {
    await expect(
      ipc.attachmentSave('附件', [attachmentInput('说明.pdf', new Uint8Array([1, 2, 3]))]),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' })

    // 一批里混进非图片 → 整批被拒（不允许"三张落盘、第四张没有"的中间态）
    await expect(
      ipc.attachmentSave('附件', [
        attachmentInput('好图.png', PNG_BYTES),
        attachmentInput('说明.pdf', new Uint8Array([1])),
      ]),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' })
    const snapshot = await ipc.vaultSnapshot()
    expect(snapshot.entries.some((item) => item.relPath === '附件/好图.png')).toBe(false)
  })

  it('空载荷与非法 base64 → UNSUPPORTED_MEDIA', async () => {
    await expect(
      ipc.attachmentSave('附件', [{ name: '图.png', dataBase64: '' }]),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' })
    await expect(
      ipc.attachmentSave('附件', [{ name: '图.png', dataBase64: 'Zm9v!' }]),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' })
  })

  it('文件名带路径分隔符 → PATH_INVALID（不能借文件名绕开附件目录）', async () => {
    await expect(
      ipc.attachmentSave('附件', [attachmentInput('../外面.png', PNG_BYTES)]),
    ).rejects.toMatchObject({ code: 'PATH_INVALID' })
    await expect(
      ipc.attachmentSave('附件', [attachmentInput('子目录/图.png', PNG_BYTES)]),
    ).rejects.toMatchObject({ code: 'PATH_INVALID' })
  })

  it('单张超 8 MiB → TOO_LARGE（用 base64 上界挡，不必真的造 8 MiB 数据）', async () => {
    // 上界 = len/4*3 > 8 MiB ⇒ len > 11 184 810
    const oversized = 'A'.repeat(MAX_ATTACHMENT_BYTES / 3 * 4 + 8)
    await expect(
      ipc.attachmentSave('附件', [{ name: '大.png', dataBase64: oversized }]),
    ).rejects.toMatchObject({ code: 'TOO_LARGE' })
  })

  it('一批超 32 MiB → TOO_LARGE（第 5 张越界时整批不落）', async () => {
    // 每张 6.75 MiB：前 4 张合计 27 MiB ≤ 32 MiB，第 5 张越界
    const perFile = Math.ceil((MAX_ATTACHMENT_BATCH_BYTES / 5 + 1) / 3) * 3
    const encoded = bytesToBase64(new Uint8Array(perFile).fill(7))
    const file = (name: string) => ({ name, dataBase64: encoded })

    await expect(
      ipc.attachmentSave('附件', [
        file('甲.png'),
        file('乙.png'),
        file('丙.png'),
        file('丁.png'),
        file('戊.png'),
      ]),
    ).rejects.toMatchObject({ code: 'TOO_LARGE' })

    const snapshot = await ipc.vaultSnapshot()
    expect(snapshot.entries.some((item) => item.relPath.endsWith('.png'))).toBe(false)
  })

  it('张数超 32 → TOO_LARGE', async () => {
    const files = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, index) => ({
      name: `图${index}.png`,
      dataBase64: bytesToBase64(PNG_BYTES),
    }))
    await expect(ipc.attachmentSave('附件', files)).rejects.toMatchObject({ code: 'TOO_LARGE' })
  })

  it('宿主新增的错误码在前端被识别成具体码（不是 UNKNOWN）', () => {
    // `MimenoteError` 只认白名单里的码：`types.ts` 少镜像一个字符串，UI 就只能显示兜底文案
    const error = MimenoteError.from({
      code: 'UNSUPPORTED_MEDIA',
      message: '只接受图片附件',
      detail: null,
      currentMtimeMs: null,
    })
    expect(error.code).toBe('UNSUPPORTED_MEDIA')
  })
})
