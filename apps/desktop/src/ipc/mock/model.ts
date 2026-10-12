/**
 * ipc/mock/model.ts（从 mock-adapter.ts 逐字搬出，只加了 export 与 import）
 *
 * Mock 的**类型面与默认数据**：笔记形状、默认 Vault 内容、适配器对外形状。
 *
 * 为什么先搬这一块：它是所有领域模块与 56 个测试文件共同依赖的面 —— 放在最底层，
 * 各领域之间就不需要互相 import（那会长出模块级环，门禁会红）。
 */
import type { IpcAdapter } from '@/ipc/client'

export interface MockNote {
  relPath: string
  text: string
}

/** 内存示例 Vault 的根路径（浏览器预览模式下"打开 Vault"打开的就是它）。 */
export const MOCK_VAULT_PATH = 'C:\\MockVault'

export const DEFAULT_NOTES: MockNote[] = [
  { relPath: 'README.md', text: '# 示例 Vault\n\n这是**内存 Mock Vault**，用于浏览器预览与自动化测试。\n' },
  {
    relPath: '日记/2025-01-01.md',
    text: '# 一月一日\n\n- [x] 起床\n- [ ] 写笔记\n\n> 引用：本地优先。\n',
  },
  { relPath: '日记/2025-01-02.md', text: '# 一月二日\n\n今天研究了 CodeMirror 6 的扩展机制。\n' },
  { relPath: '项目/设计.md', text: '# 设计\n\n参考 [[路线图]] 与 [[细节]]。\n\n| 层 | 职责 |\n| --- | --- |\n| 文件层 | 原子写 |\n| 索引层 | FTS5 |\n\n#项目\n' },
  { relPath: '项目/路线图.md', text: '# 路线图\n\n1. M1 闭环\n2. M2 搜索\n3. M3 图谱\n\n设计细节见 [[设计]]。\n' },
  { relPath: '项目/子项目/细节.md', text: '# 细节\n\n```ts\nexport const answer = 42\n```\n\n还有一个还没写的笔记：[[还不存在的笔记]]。\n' },
  { relPath: '随手记.md', text: '字数统计测试：hello world 与中文混排。\n' },
  // 专门用来演示「标签与属性面板」与「全文搜索」的笔记：
  // 其它用例请勿依赖它的内容（改了会影响 UI 层 E2E 里的标签/搜索断言）。
  {
    relPath: '项目/标签示例.md',
    text: '---\ntitle: 标签示例\ntags: [项目, 进行中]\n---\n\n这一段用来演示 #架构 与 #项目 标签的抽取。\n',
  },
  // 专门用来演示「callout」（ADR-0022）的笔记：三种类型 + 折叠符 + 未知类型 + 嵌套。
  // 其它用例请勿依赖它的内容（改了会影响 UI 层 E2E 里的 callout 断言）。
  // **刻意不放 `[[链接]]`**：这个 Mock Vault 的链接索引被重命名/移动/反链的用例逐字断言着，
  // 多一条链接会让那些用例一起红（而这条笔记要演示的只是提示框本身）。
  {
    relPath: '项目/callout 示例.md',
    text:
      '# 提示框示例\n\n' +
      '> [!note] 一条笔记\n> 正文里 **粗体**、*斜体*、`行内代码` 与 ~~删除线~~ 照常。\n\n' +
      '> [!warning] 小心\n> 折叠符让正文在**编辑器里**默认收起。\n\n' +
      '> [!tip]- 收起的一节\n> 这一段在所见即所得里默认是收起的。\n\n' +
      '> [!摘录]\n> 未知类型按 note 渲染，标题保留用户写的名字。\n\n' +
      '> [!note] 外层\n> > [!tip] 内层\n> > 嵌套的提示框。\n',
  },
  { relPath: '附件/说明.txt', text: '非 Markdown 附件，M1 不可编辑。\n' },
  // 专门用来演示「大纲面板」的笔记（多级标题 + 一个代码块里的伪标题）：
  // 其它用例请勿依赖它的内容。
  {
    relPath: '项目/大纲.md',
    text: [
      '# 大纲示例',
      '',
      '开头一段。',
      '',
      '## 第一节',
      '',
      '内容一。',
      '',
      '### 小节',
      '',
      '```md',
      '# 这是代码块里的伪标题',
      '```',
      '',
      '## 第二节',
      '',
      '内容二。',
      '',
    ].join('\n'),
  },
]

export interface MockAdapterOptions {
  notes?: MockNote[]
  rootPath?: string
  /** 模拟命令行指定的 Vault（`startup_vault` 命令）。 */
  startupVaultPath?: string
  /** 模拟写入延迟（毫秒），用于验证 UI 的"保存中"状态。 */
  writeLatencyMs?: number
}

// 扩展名判据不在本文件再写一份：用 `domain/paths.ts` 的 `isMarkdown`
// （这里曾经有一份 `isMockMarkdown` —— 同一判据两处实现，改一处就会与文件树/索引分家）。

/**
 * Mock 适配器的对外形状（含两个测试专用钩子）。
 *
 * 放在这里而不是分发文件里：`MockHost` 的 `trashCalls` 字段要用它的类型，
 * 而 host 是所有领域模块的底层 —— 接口跟着类型面走才不会有环。
 */
export interface MockAdapter extends IpcAdapter {
  /** 模拟外部程序修改文件（用于手工验证冲突横幅）。 */
  simulateExternalEdit(relPath: string, text: string): void
  /**
   * 模拟"用户在文件管理器里清掉了回收站里的这个文件"：台账记录留着，东西没了。
   *
   * 为什么 Mock 需要它：这正是界面上"文件已不在回收站"那一行（孤儿记录）的来路 ——
   * 没有这个钩子，那条分支就只能靠测试临时搭一个桩适配器，Mock 与宿主的
   * `present: false` 语义也就没人对着跑过。对**永久删除**尤其要紧：孤儿记录那一步
   * 只清台账、**不释放空间**，Mock 必须能造出这种记录。
   */
  simulateTrashFileGone(id: string): void
  /**
   * 这一份适配器收到的**永久删除**调用（按发生顺序）。
   *
   * 为什么单独记一笔而不是让用例 `vi.spyOn(adapter, 'invoke')`：`confirm` 是不是真的被
   * 当成"必填"传了 `true`，是这两条命令契约里最要紧的一件事（它是"界面忘了二次确认"的兜底），
   * 而它只体现在入参上 —— 记账比在测试里翻 `invoke` 的参数更好读、也更容易在别处复用。
   */
  trashCalls: { method: 'trash_delete' | 'trash_empty'; id?: string; confirm: boolean }[]
  /** 当前快照（测试断言用）。 */
  dump(): MockNote[]
}
