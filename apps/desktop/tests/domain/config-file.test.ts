/**
 * 配置文件的格式判据（`domain/config-file.ts`，ADR-0055）。
 *
 * 这一层是"用户手写的文件"与"应用写回"之间的闸门，四类断言各钉一条纪律：
 * 1. **候选顺序固定**，且写回只产生规范名（`.yml` 只读）；
 * 2. **三格式同构**：同一份对象序列化再解析必须逐字回来（否则"换格式"会静默改语义）；
 * 3. **解析失败是数据不是崩溃**：`ok: false` 带可读消息，绝不抛；
 * 4. **注释判据必须准**：漏判会吃掉用户注释（不可接受），误判只会多提示一次（可接受）——
 *    所以这里的用例同时覆盖"字符串里的 `#` 不算注释"与"行内 `#` 之后算注释"。
 */

import { describe, expect, it } from 'vitest'

import {
  CONFIG_DIR,
  CONFIG_FILE_CANDIDATES,
  CONFIG_SCHEMA_VERSION,
  configFileNameOf,
  configFormatOf,
  configRelPathOf,
  hasConfigComments,
  parseConfigText,
  serializeConfigText,
} from '@/domain/config-file'

describe('候选文件与规范名', () => {
  it('候选顺序是 toml → yaml → yml → json（只有第一个存在的生效）', () => {
    expect(CONFIG_FILE_CANDIDATES.map((candidate) => candidate.fileName)).toEqual([
      'config.toml',
      'config.yaml',
      'config.yml',
      'config.json',
    ])
    expect(CONFIG_FILE_CANDIDATES.map((candidate) => candidate.format)).toEqual([
      'toml',
      'yaml',
      'yaml',
      'json',
    ])
  })

  it('写回只产生规范名：yaml 不写 .yml', () => {
    expect(configFileNameOf('toml')).toBe('config.toml')
    expect(configFileNameOf('yaml')).toBe('config.yaml')
    expect(configFileNameOf('json')).toBe('config.json')
  })

  it('文件名 → 格式，未知名字返回 null', () => {
    expect(configFormatOf('config.yml')).toBe('yaml')
    expect(configFormatOf('config.ini')).toBeNull()
    expect(configRelPathOf('config.toml')).toBe(`${CONFIG_DIR}/config.toml`)
  })
})

describe('解析：成功、空文件与失败', () => {
  it('空文件等价于"全用默认值"', () => {
    for (const format of ['toml', 'yaml', 'json'] as const) {
      expect(parseConfigText('   \n', format)).toEqual({ ok: true, value: {} })
    }
  })

  it('三种格式都能解析出同一个对象', () => {
    const toml = parseConfigText('version = 1\n[ui]\nfontSize = 16\n', 'toml')
    const yaml = parseConfigText('version: 1\nui:\n  fontSize: 16\n', 'yaml')
    const json = parseConfigText('{"version":1,"ui":{"fontSize":16}}', 'json')
    for (const parsed of [toml, yaml, json]) {
      expect(parsed.ok).toBe(true)
      if (parsed.ok) expect(parsed.value).toEqual({ version: 1, ui: { fontSize: 16 } })
    }
  })

  it('顶层不是对象 → 失败并说清原因', () => {
    const parsed = parseConfigText('- 1\n- 2\n', 'yaml')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.message).toContain('顶层必须是一个表')
  })

  it('语法错误 → 失败并带上格式名与解析器的原话', () => {
    const parsed = parseConfigText('version = = 1\n', 'toml')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.message.startsWith('TOML 解析失败：')).toBe(true)
  })
})

describe('序列化：三格式往返一致、空值被拒绝', () => {
  const document = {
    version: CONFIG_SCHEMA_VERSION,
    keymap: { profile: 'mimenote', bindings: [{ command: 'note.save', chords: ['Mod+S'] }] },
    ui: { fontSize: 16 },
    tree: { layout: 'single' },
  }

  it('三种格式各自往返后与原文对象逐字相等', () => {
    for (const format of ['toml', 'yaml', 'json'] as const) {
      const serialized = serializeConfigText(document, format)
      expect(serialized.ok).toBe(true)
      if (!serialized.ok) continue
      const parsed = parseConfigText(serialized.text, format)
      expect(parsed.ok).toBe(true)
      if (parsed.ok) expect(parsed.value).toEqual(document)
      // 写出的文件以换行结尾：让"最后一行"在编辑器里也是完整的一行
      expect(serialized.text.endsWith('\n')).toBe(true)
    }
  })

  it('null 被拒绝（TOML 没有 null，静默变成字符串比报错糟）', () => {
    const serialized = serializeConfigText({ ui: { fontSize: null } }, 'toml')
    expect(serialized.ok).toBe(false)
    if (!serialized.ok) expect(serialized.message).toContain('ui.fontSize')
  })
})

describe('注释判据（漏判会吃掉注释，误判只是多一次提示）', () => {
  it('TOML：字符串里的 # 不是注释，行首/行尾的 # 是', () => {
    expect(hasConfigComments('title = "a # b"\n', 'toml')).toBe(false)
    expect(hasConfigComments("title = 'a # b'\n", 'toml')).toBe(false)
    expect(hasConfigComments('# 说明\nversion = 1\n', 'toml')).toBe(true)
    expect(hasConfigComments('version = 1 # 说明\n', 'toml')).toBe(true)
    // 多行基本串里的 # 同样不算注释
    expect(hasConfigComments('note = """\n# 不是注释\n"""\n', 'toml')).toBe(false)
  })

  it('YAML：`a#b` 是标量，` # ` 之后才是注释；引号里的 # 不算', () => {
    expect(hasConfigComments('pattern: a#b\n', 'yaml')).toBe(false)
    expect(hasConfigComments('pattern: a # b\n', 'yaml')).toBe(true)
    expect(hasConfigComments('pattern: "a # b"\n', 'yaml')).toBe(false)
    expect(hasConfigComments("pattern: 'a # b'\n", 'yaml')).toBe(false)
  })

  it('JSON：严格 JSON 没有注释', () => {
    expect(hasConfigComments('{"ui":{"fontSize":16}}\n', 'json')).toBe(false)
  })
})
