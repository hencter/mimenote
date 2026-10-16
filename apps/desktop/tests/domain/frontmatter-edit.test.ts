/**
 * frontmatter 三种格式（YAML `---` / TOML `+++` / JSON `;;;`）的解析与改写。
 *
 * 这一层最贵的一类错误是**静默吃掉或改写正文**：面板里改一个属性值，写回时把正文的头几行、BOM
 * 或 CRLF 弄丢，用户只看到"笔记内容自己变了"。所以保真类用例一律整段 `toBe` 对比，不写 `toContain`；
 * `metadataBlock().to` 也连带断言 `text.slice(to)` —— `to` 是后面一堆 slice 的起点，差一位就会
 * 多/少一个换行，而且会**每改一次累积一次**。
 */

import { describe, expect, it } from 'vitest'

import {
  editMetadataField,
  metadataBlock,
  parseMetadata,
  renameMetadata,
  reorderMetadata,
  replaceMetadata,
  serializeMetadata,
  tomlHasComment,
} from '@/domain/frontmatter-edit'

describe('metadataBlock：围栏识别与正文起点', () => {
  it('三种围栏各自识别为 yaml / toml / json，`to` 正好落在正文第一个字符', () => {
    const yaml = '---\ntitle: t\n---\n正文\n'
    expect(metadataBlock(yaml)).toEqual({ format: 'yaml', source: 'title: t', to: 17, endLine: 2 })
    expect(yaml.slice(metadataBlock(yaml)!.to)).toBe('正文\n')

    const toml = '+++\ntitle = "t"\n+++\n正文\n'
    expect(metadataBlock(toml)).toEqual({ format: 'toml', source: 'title = "t"', to: 20, endLine: 2 })
    expect(toml.slice(metadataBlock(toml)!.to)).toBe('正文\n')

    const json = ';;;\n{"title":"t"}\n;;;\n正文\n'
    expect(metadataBlock(json)).toEqual({ format: 'json', source: '{"title":"t"}', to: 22, endLine: 2 })
    expect(json.slice(metadataBlock(json)!.to)).toBe('正文\n')
  })

  it('首行不是围栏（正文、空文件、缩进的 `---`、`...`）返回 null', () => {
    expect(metadataBlock('正文\n')).toBeNull()
    expect(metadataBlock('')).toBeNull()
    // 缩进过的 `---` 是分隔线或缩进内容：认成 frontmatter 会把正文第一段当属性吃掉
    expect(metadataBlock(' ---\ntitle: t\n---\n正文\n')).toBeNull()
    expect(metadataBlock('...\ntitle: t\n...\n')).toBeNull()
  })

  it('只有开头围栏、找不到结束行时返回 null（否则整篇正文都会被当成属性）', () => {
    expect(metadataBlock('---\ntitle: t\n正文\n')).toBeNull()
    expect(metadataBlock('+++\ntitle = "t"\n')).toBeNull()
    expect(metadataBlock('---\n')).toBeNull()
  })

  it('结束行没有尾随换行也能闭合；空区块给出空 source', () => {
    expect(metadataBlock('---\ntitle: t\n---')).toEqual({ format: 'yaml', source: 'title: t', to: 16, endLine: 2 })
    expect(metadataBlock('---\n---\n正文\n')).toEqual({ format: 'yaml', source: '', to: 8, endLine: 1 })
  })

  it('带 BOM 也能识别，且 `to` 已经把 BOM 那一个字符算进去', () => {
    // 坑：`to` 是**原文**（含 BOM）里的下标。这里只按"去掉 BOM 后的长度"算，写回时就会
    // 少切一个字符、每次编辑多吐一个换行。
    const text = '\uFEFF---\ntitle: t\n---\n正文\n'
    const block = metadataBlock(text)!
    expect(block).toEqual({ format: 'yaml', source: 'title: t', to: 18, endLine: 2 })
    expect(text.slice(block.to)).toBe('正文\n')
    expect(metadataBlock('\uFEFF正文\n')).toBeNull()
  })

  it('`\\r\\n` 文件里 source 逐行去掉 `\\r`、用 `\\n` 重新拼接', () => {
    // source 会交给 yaml 解析器，也会显示在源码编辑框里：残留的 `\r` 会让 YAML 把它当成
    // 标量内容（值末尾莫名多一个回车），在编辑框里则是一行看不出区别的"脏"字符。
    const text = '---\r\ntitle: t\r\ntags: [甲]\r\n---\r\n正文\r\n'
    const block = metadataBlock(text)!
    expect(block).toEqual({ format: 'yaml', source: 'title: t\ntags: [甲]', to: 31, endLine: 3 })
    expect(block.source).not.toContain('\r')
    expect(text.slice(block.to)).toBe('正文\r\n')
  })
})

describe('parseMetadata：三种格式都落到键值对象', () => {
  it('YAML / TOML / JSON 解析出同样的键值', () => {
    expect(parseMetadata('title: 标题\ntags:\n  - 甲\n  - 乙\ndraft: false\n', 'yaml')).toEqual({
      title: '标题',
      tags: ['甲', '乙'],
      draft: false,
    })
    expect(parseMetadata('title = "标题"\ntags = ["甲", "乙"]\ndraft = false\n', 'toml')).toEqual({
      title: '标题',
      tags: ['甲', '乙'],
      draft: false,
    })
    expect(parseMetadata('{"title":"标题","tags":["甲","乙"],"draft":false}', 'json')).toEqual({
      title: '标题',
      tags: ['甲', '乙'],
      draft: false,
    })
  })

  it('顶层是数组或标量时抛错（面板据此拒绝把整篇正文当属性渲染）', () => {
    expect(() => parseMetadata('- 甲\n- 乙', 'yaml')).toThrow('属性必须是键值对象')
    expect(() => parseMetadata('甲', 'yaml')).toThrow('属性必须是键值对象')
    expect(() => parseMetadata('123', 'yaml')).toThrow('属性必须是键值对象')
    expect(() => parseMetadata('[1, 2]', 'json')).toThrow('属性必须是键值对象')
    expect(() => parseMetadata('"甲"', 'json')).toThrow('属性必须是键值对象')
    expect(() => parseMetadata('42', 'json')).toThrow('属性必须是键值对象')
    // JSON 的 `null` 也走这条：`typeof null === 'object'`，少了那半个判断就会当成空属性放过去
    expect(() => parseMetadata('null', 'json')).toThrow('属性必须是键值对象')
  })

  it('YAML 语法错误抛解析器错误，而不是被当成空属性', () => {
    // 当成空属性最危险：面板会显示"没有属性"，用户一改就按空对象整体写回，把原属性全抹掉。
    expect(() => parseMetadata('key: [1, 2', 'yaml')).toThrow()
    expect(() => parseMetadata('key: [1, 2', 'yaml')).toThrow(/Flow sequence/)
  })

  it('空 source 返回空对象——`---/---` 的空区块不该让面板一直报错', () => {
    // 任务书把"空"和数组/标量列在一起，但实测三种格式的空字符串都返回 `{}`
    // （YAML 靠 `toJS() ?? {}`，JSON 靠 `source || '{}'`）。这对空区块是**必需**的：
    // 抛错的话，`---\n---` 的笔记一打开就是红色报错。
    expect(parseMetadata('', 'yaml')).toEqual({})
    expect(parseMetadata('', 'toml')).toEqual({})
    expect(parseMetadata('', 'json')).toEqual({})
  })

  it('三种格式对"顶层就是 null"判据一致：都抛错（空区块另算，见上一条）', () => {
    // 空区块（`---\n---`）与"显式写了 null"是两件事：前者给 `{}`（否则一打开就报错），
    // 后者在三种格式里都**不是**键值对象，一律拒绝 —— 判据不能一个格式一套。
    expect(() => parseMetadata('null', 'json')).toThrow('属性必须是键值对象')
    expect(() => parseMetadata('null', 'yaml')).toThrow('属性必须是键值对象')
    expect(() => parseMetadata('~', 'yaml')).toThrow('属性必须是键值对象')
    // YAML 的"只有注释"与空文档一样算空区块（`contents === null`）
    expect(parseMetadata('# 只有注释\n', 'yaml')).toEqual({})
  })
})

describe('serializeMetadata：三种格式的写出形状', () => {
  it('YAML 用块序列、TOML 用 `key = 值`、JSON 两空格缩进', () => {
    expect(serializeMetadata({ title: '标题', tags: ['甲', '乙'], draft: false }, 'yaml')).toBe(
      'title: 标题\ntags:\n  - 甲\n  - 乙\ndraft: false\n',
    )
    expect(serializeMetadata({ title: '标题', count: 1 }, 'toml')).toBe('title = "标题"\ncount = 1\n')
    expect(serializeMetadata({ title: '标题', count: 1 }, 'json')).toBe(
      '{\n  "title": "标题",\n  "count": 1\n}',
    )
  })

  it('空属性集各给各的写法（YAML/JSON 是 `{}`，TOML 是空行）', () => {
    // TOML 序列化器对空表返回 "\n"：写回时被 replaceMetadata 的 trimEnd 收掉，不会多出空行，
    // 所以这里直接钉住它的原始输出，而不是假装它返回空串。
    expect(serializeMetadata({}, 'yaml')).toBe('{}\n')
    expect(serializeMetadata({}, 'json')).toBe('{}')
    expect(serializeMetadata({}, 'toml')).toBe('\n')
  })
})

describe('editMetadataField：YAML 保留原始写法', () => {
  // 样本刻意带上：行首注释、带引号的值、多行字面量块、块序列。
  // YAML 改写走 AST（parseDocument → set/delete → toString），不是"重新序列化整个对象"——
  // 一旦退回后者，下面这些写法会被全部抹平成默认风格，用户会看到一次莫名其妙的全文件 diff。
  const source = `# 文件头注释
title: "旧标题"
tags:
  - 甲
  - 乙
summary: |
  第一行
  第二行
draft: false
`

  it('改一个已存在的字段：注释、引号、多行块、其它字段的写法逐字不变', () => {
    expect(editMetadataField(source, 'yaml', 'title', '新标题')).toBe(`# 文件头注释
title: "新标题"
tags:
  - 甲
  - 乙
summary: |
  第一行
  第二行
draft: false
`)
  })

  it('remove=true 时字段整行消失，其余内容一字不差', () => {
    expect(editMetadataField(source, 'yaml', 'draft', null, true)).toBe(`# 文件头注释
title: "旧标题"
tags:
  - 甲
  - 乙
summary: |
  第一行
  第二行
`)
  })

  it('新字段追加在末尾，不影响已有字段的写法', () => {
    expect(editMetadataField(source, 'yaml', 'status', '草稿')).toBe(`# 文件头注释
title: "旧标题"
tags:
  - 甲
  - 乙
summary: |
  第一行
  第二行
draft: false
status: 草稿
`)
  })

  it('YAML 的 flow 集合会被解析器顺带规范化（既有取舍，非本模块引入）', () => {
    // 实测：`parseDocument('tags: [甲]').toString()` 本身就产出 `tags: [ 甲 ]`，所以只要经过
    // "解析 → 写回"，流式集合就会多两个空格。值没变，因此不当缺陷处理；钉住是为了下次看到
    // 这种 diff 时知道它从哪来。
    expect(editMetadataField('a: 1\ntags: [甲]\nb: 2\n', 'yaml', 'a', 9)).toBe('a: 9\ntags: [ 甲 ]\nb: 2\n')
  })

  it('TOML / JSON 解析成对象再整体序列化：能改、能删、能加', () => {
    expect(editMetadataField('title = "旧"\ncount = 1\n', 'toml', 'count', 2)).toBe('title = "旧"\ncount = 2\n')
    expect(editMetadataField('title = "旧"\ncount = 1\n', 'toml', 'count', null, true)).toBe('title = "旧"\n')
    expect(editMetadataField('title = "旧"\n', 'toml', 'count', 2)).toBe('title = "旧"\ncount = 2\n')
    expect(editMetadataField('{\n  "title": "旧",\n  "count": 1\n}', 'json', 'count', 2)).toBe(
      '{\n  "title": "旧",\n  "count": 2\n}',
    )
    expect(editMetadataField('{\n  "title": "旧",\n  "count": 1\n}', 'json', 'count', null, true)).toBe(
      '{\n  "title": "旧"\n}',
    )
  })

  it('含注释的 TOML 拒绝改写，错误信息指路"源码"', () => {
    // 整体序列化会抹掉注释，所以宁可不改也不静默丢注释；错误信息里必须有"源码"，
    // 面板是把它原样显示给用户的，没有这个词用户不知道下一步该做什么。
    expect(() => editMetadataField('# 说明\ntitle = "旧"\n', 'toml', 'title', '新')).toThrow('源码')
    expect(() => editMetadataField('title = "旧" # 行尾注释\n', 'toml', 'title', '新')).toThrow('源码')
    expect(() => editMetadataField('# 说明\ntitle = "旧"\n', 'toml', 'title', '新')).toThrow(
      '这份 TOML 含注释，请使用源码编辑以保留注释。',
    )
  })

  it('TOML 值里的 `#` 不算注释：照常改写（引号内外的 `#` 必须分开判）', () => {
    // 判据只有 `tomlHasComment` 一份：先把字符串字面量抠掉再看 `#`。
    // 否则 `title = "C # 教程"` 这种完全没有注释的区块也会被赶去源码里改，
    // 而 YAML 的同名值却没事 —— 同一件事两种行为。
    expect(tomlHasComment('title = "C # 教程"')).toBe(false)
    expect(tomlHasComment('title = \'C # 教程\'')).toBe(false)
    expect(tomlHasComment('title = "多行\n# 也不算"\n')).toBe(false)
    expect(editMetadataField('title = "C # 教程"\n', 'toml', 'title', '新')).toBe('title = "新"\n')
    expect(editMetadataField('title: "C # 教程"\n', 'yaml', 'title', '新')).toBe('title: "新"\n')
    // 引号**外**的 `#` 仍然是注释，照样拒绝（含行尾、整行、多行串之后）
    expect(tomlHasComment('title = "旧" # 行尾')).toBe(true)
    expect(tomlHasComment('# 整行注释\ntitle = "旧"')).toBe(true)
    expect(tomlHasComment('note = """\n正文\n"""\n# 之后')).toBe(true)
  })
})

describe('renameMetadata：改名与拒绝条件', () => {
  const source = '# keep\ntitle: old\nstatus: draft\n'

  it('YAML 改名只动键名，注释与其它行原样保留', () => {
    expect(renameMetadata(source, 'yaml', 'title', 'name')).toBe('# keep\nname: old\nstatus: draft\n')
  })

  it('目标名已存在 / 原名不存在 / 新名为空（含全空白）都抛错', () => {
    // 覆盖已有键会把它的值直接吞掉，所以必须拒绝；空名会写出一个没法再引用的键。
    expect(() => renameMetadata(source, 'yaml', 'title', 'status')).toThrow('属性名称已存在')
    expect(() => renameMetadata(source, 'yaml', 'missing', 'name')).toThrow('原属性已不存在')
    expect(() => renameMetadata(source, 'yaml', 'title', '')).toThrow('属性名称不能为空')
    expect(() => renameMetadata(source, 'yaml', 'title', '   ')).toThrow('属性名称不能为空')
  })

  it('新旧同名（含首尾空白）原样返回：否则会写出带空格的键名', () => {
    // 名字来自输入框，`title ` 与 `title` 必须视为同一个名字：`to` 做了 trim 后命中
    // `from === to` 的短路，返回的是**同一个字符串**（不改写、不重排、不重新序列化）。
    expect(renameMetadata(source, 'yaml', 'title', 'title')).toBe(source)
    expect(renameMetadata(source, 'yaml', 'title', ' title ')).toBe(source)
  })

  it('TOML / JSON 改名走整体序列化，键序保持', () => {
    expect(renameMetadata('title = "旧"\ncount = 1\n', 'toml', 'title', 'name')).toBe('name = "旧"\ncount = 1\n')
    expect(renameMetadata('{"title":"旧","count":1}', 'json', 'title', 'name')).toBe(
      '{\n  "name": "旧",\n  "count": 1\n}',
    )
  })

  it('含注释的 TOML 拒绝改名（整体序列化会丢注释）', () => {
    expect(() => renameMetadata('# 说明\ntitle = "旧"\n', 'toml', 'title', 'name')).toThrow('源码')
  })
})

describe('reorderMetadata：拖拽排序', () => {
  it('把字段移到另一个字段之前，其余字段值与顺序不变', () => {
    expect(reorderMetadata('alpha: 1\nbeta: 2\ngamma: 3\n', 'yaml', 'gamma', 'alpha')).toBe(
      'gamma: 3\nalpha: 1\nbeta: 2\n',
    )
    // 往下移也是"插到 before 前面"（不是后面）：`alpha` 落到 `gamma` 前一位，`beta` 被顶上去
    expect(reorderMetadata('alpha: 1\nbeta: 2\ngamma: 3\n', 'yaml', 'alpha', 'gamma')).toBe(
      'beta: 2\nalpha: 1\ngamma: 3\n',
    )
  })

  it('原字段的行首注释跟着字段一起走（yaml 把注释挂给它下面的那个键）', () => {
    // 实测行为：注释跟着 `alpha` 被搬到下面，而不是留在文件顶部。这样"注释描述的是哪个字段"
    // 不会错位；如果哪天改成"注释留在顶部"，这里会红，需要产品上确认哪种才是想要的。
    expect(reorderMetadata('# 注释\nalpha: 1\nbeta: 2\ngamma: 3\n', 'yaml', 'gamma', 'alpha')).toBe(
      'gamma: 3\n# 注释\nalpha: 1\nbeta: 2\n',
    )
  })

  it('moved === before 或名字不存在时原样返回（不重排、也不重新序列化）', () => {
    const source = 'alpha: 1\nbeta: 2\n'
    expect(reorderMetadata(source, 'yaml', 'alpha', 'alpha')).toBe(source)
    expect(reorderMetadata(source, 'yaml', 'missing', 'alpha')).toBe(source)
    expect(reorderMetadata(source, 'yaml', 'alpha', 'missing')).toBe(source)
    // JSON 分支同样要短路：少了它，单行 JSON 会被顺手格式化成一堆缩进行
    expect(reorderMetadata('{"a":1}', 'json', 'a', 'missing')).toBe('{"a":1}')
  })

  it('TOML / JSON 靠对象键序重排', () => {
    expect(reorderMetadata('a = 1\nb = 2\nc = 3\n', 'toml', 'c', 'a')).toBe('c = 3\na = 1\nb = 2\n')
    expect(reorderMetadata('{"a":1,"b":2,"c":3}', 'json', 'c', 'a')).toBe('{\n  "c": 3,\n  "a": 1,\n  "b": 2\n}')
  })

  it('含注释的 TOML 拒绝排序', () => {
    expect(() => reorderMetadata('# 说明\na = 1\nb = 2\n', 'toml', 'b', 'a')).toThrow('源码')
  })
})

describe('replaceMetadata：写回时正文与换行逐字保真', () => {
  const text = '---\ntitle: 旧\n---\n\n正文第一行\n\n- [ ] 任务 #标签\n'

  it('source 没变时整体往返，一个字符都不差', () => {
    // 面板每次改属性都会走"解析 → 改写 → replaceMetadata"，往返不保真就会**累积**漂移
    // （每点一次多一个空行）。所以直接拿原文和自己比，比任何分段断言都硬。
    expect(replaceMetadata(text, 'title: 旧', 'yaml')).toBe(text)
  })

  it('改 source 只动围栏内，正文（空行、任务列表、行内标签）逐字保留', () => {
    expect(replaceMetadata(text, 'title: 新', 'yaml')).toBe(
      '---\ntitle: 新\n---\n\n正文第一行\n\n- [ ] 任务 #标签\n',
    )
  })

  it('换格式时围栏字符跟着换，正文不动', () => {
    expect(replaceMetadata(text, 'title = "新"\ncount = 1\n', 'toml')).toBe(
      '+++\ntitle = "新"\ncount = 1\n+++\n\n正文第一行\n\n- [ ] 任务 #标签\n',
    )
    // JSON source 原样写入，不会被重新缩进（用户在源码里怎么排就怎么留）
    expect(replaceMetadata(text, '{"title":"新","count":1}', 'json')).toBe(
      ';;;\n{"title":"新","count":1}\n;;;\n\n正文第一行\n\n- [ ] 任务 #标签\n',
    )
  })

  it('BOM 留在文件最前，往返一次也不丢', () => {
    const withBom = '\uFEFF---\ntitle: 旧\n---\n正文\n'
    expect(replaceMetadata(withBom, 'title: 旧', 'yaml')).toBe(withBom)
    expect(replaceMetadata(withBom, 'title: 新', 'yaml')).toBe('\uFEFF---\ntitle: 新\n---\n正文\n')
  })

  it('`\\r\\n` 文件写回仍是 `\\r\\n`，source 里的 `\\n` 也一并转成 CRLF', () => {
    const crlf = '---\r\ntitle: 旧\r\n---\r\n\r\n正文\r\n'
    expect(replaceMetadata(crlf, 'title: 旧', 'yaml')).toBe(crlf)
    expect(replaceMetadata(crlf, 'title: 新', 'yaml')).toBe('---\r\ntitle: 新\r\n---\r\n\r\n正文\r\n')
    // 源码编辑框里输入的是 `\n`：混进去会让文件变成 CRLF/LF 混排
    expect(replaceMetadata(crlf, 'title: 新\ncount: 1', 'yaml')).toBe(
      '---\r\ntitle: 新\r\ncount: 1\r\n---\r\n\r\n正文\r\n',
    )
  })

  it('没有 frontmatter 的笔记：新区块插到最前面，正文原样跟在后面', () => {
    expect(replaceMetadata('正文\n', 'title: t', 'yaml')).toBe('---\ntitle: t\n---\n正文\n')
  })

  it('source 非法时先抛错，绝不拿坏数据改写文件', () => {
    expect(() => replaceMetadata(text, '[1, 2]', 'json')).toThrow('属性必须是键值对象')
    expect(() => replaceMetadata(text, '{broken', 'json')).toThrow()
    expect(() => replaceMetadata(text, 'key: [1, 2', 'yaml')).toThrow()
  })
})
