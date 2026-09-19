import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  checkIpc,
  extractBraced,
  parseClientCommands,
  parseCoreErrorCodes,
  parseHostErrorCodes,
  parseKnownCodes,
  parseMockCommands,
  parseRustCommands,
  parseRustEnumLiterals,
  parseRustStructFields,
  parseTsInterfaces,
  parseTsUnion,
  pascalToKebab,
  snakeToCamel,
} from './check-ipc.mjs'

// ---------------------------------------------------------------------------
// 解析器单测（喂内联字符串，不碰仓库文件）
// ---------------------------------------------------------------------------

test('snakeToCamel / pascalToKebab', () => {
  assert.equal(snakeToCamel('rel_path'), 'relPath')
  assert.equal(snakeToCamel('name'), 'name')
  assert.equal(snakeToCamel('generated_at_ms'), 'generatedAtMs')
  assert.equal(pascalToKebab('ExternalChange'), 'external-change')
  assert.equal(pascalToKebab('Unreadable'), 'unreadable')
})

test('extractBraced 配对嵌套括号', () => {
  assert.equal(extractBraced('{ a { b } c }', 0), ' a { b } c ')
  assert.throws(() => extractBraced('{ a ', 0), /不配对/)
  assert.throws(() => extractBraced('x{', 0), /期望/)
})

test('parseRustStructFields：camelCase 换算，跳过属性与私有字段', () => {
  const source = `
/// 注释里有个 pub fake_field: String 不能算
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Demo {
    /// 字段注释 pub ghost: u64 也不算
    pub rel_path: String,
    pub size_bytes: u64,
    #[serde(default)]
    pub reused_notes: usize,
    hidden: bool,
}
`
  assert.deepEqual(parseRustStructFields(source, 'Demo'), ['relPath', 'sizeBytes', 'reusedNotes'])
  assert.throws(() => parseRustStructFields(source, 'Missing'), /找不到 struct Missing/)
})

test('parseRustEnumLiterals：识别 lowercase / kebab-case / camelCase', () => {
  const lower = `
#[serde(rename_all = "lowercase")]
pub enum Phase {
    /// 注释
    Idle,
    Building,
}
`
  assert.deepEqual(parseRustEnumLiterals(lower, 'Phase'), ['idle', 'building'])
  const kebab = `
#[serde(rename_all = "kebab-case")]
pub enum Reason {
    ExternalChange,
    Unreadable,
    WriteFailed,
}
`
  assert.deepEqual(parseRustEnumLiterals(kebab, 'Reason'), [
    'external-change',
    'unreadable',
    'write-failed',
  ])
  assert.throws(() => parseRustEnumLiterals('pub enum X { A, }', 'X'), /rename_all/)
})

test('parseCoreErrorCodes：码里允许数字（NOT_UTF8）', () => {
  const source = `
impl ErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::VaultNotSet => "VAULT_NOT_SET",
            Self::Io => "IO",
            Self::NotUtf8 => "NOT_UTF8",
        }
    }
}
`
  assert.deepEqual(parseCoreErrorCodes(source), ['VAULT_NOT_SET', 'IO', 'NOT_UTF8'])
})

test('parseHostErrorCodes：const 与 code: 字面量都收', () => {
  const source = `
pub const UNSUPPORTED_MEDIA: &str = "UNSUPPORTED_MEDIA";
pub fn internal(message: impl Into<String>) -> Self {
    Self { code: "INTERNAL", message: message.into() }
}
`
  assert.deepEqual(parseHostErrorCodes(source).sort(), ['INTERNAL', 'UNSUPPORTED_MEDIA'])
})

test('parseTsInterfaces：字段、readonly、可选、extends 展开、注释剔除', () => {
  const source = `
/** fake: string 不能算 */
export interface Base {
  id: string
  /** ghost: number 也不能算 */
  sizeBytes: number
}
export interface Child extends Base {
  readonly present?: boolean
  text: string
}
`
  const interfaces = parseTsInterfaces(source)
  assert.deepEqual(interfaces.get('Base'), ['id', 'sizeBytes'])
  assert.deepEqual(interfaces.get('Child'), ['id', 'sizeBytes', 'present', 'text'])
})

test('parseTsUnion：跨行联合 + 行间注释 + 单行联合', () => {
  const source = `
export type Multi =
  | 'ALPHA'
  /** 行间注释 */
  | 'BETA_2'
  | 'GAMMA'

export const after = 1
export type Single = 'wiki' | 'embed'
`
  assert.deepEqual(parseTsUnion(source, 'Multi'), ['ALPHA', 'BETA_2', 'GAMMA'])
  assert.deepEqual(parseTsUnion(source, 'Single'), ['wiki', 'embed'])
  assert.throws(() => parseTsUnion(source, 'Missing'), /找不到 type Missing/)
})

test('parseKnownCodes：只取 Set 里的字面量', () => {
  const source = `
const KNOWN_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'VAULT_NOT_SET',
  'IO',
])
`
  assert.deepEqual(parseKnownCodes(source), ['VAULT_NOT_SET', 'IO'])
})

test('命令三侧解析：generate_handler! / call / case', () => {
  const lib = `
        .invoke_handler(tauri::generate_handler![
            commands::vault_open,
            // 注释里的 commands::ghost 不能算
            assets::asset_read_base64,
        ])
`
  assert.deepEqual(parseRustCommands(lib), ['vault_open', 'asset_read_base64'])
  const client = `
  vaultOpen: (path: string) => call<VaultSnapshot>('vault_open', { path }),
  vaultClose: () => call<void>('vault_close'),
`
  assert.deepEqual(parseClientCommands(client), ['vault_open', 'vault_close'])
  const mock = `
        case 'vault_open':
        case 'vault_snapshot': {
`
  assert.deepEqual(parseMockCommands(mock), ['vault_open', 'vault_snapshot'])
})

// ---------------------------------------------------------------------------
// 对真实仓库的集成校验：当前必须全绿；漂移时必须报错且点名
// ---------------------------------------------------------------------------

test('真实仓库 IPC 契约全绿（命令 / 错误码 / DTO / 枚举）', () => {
  const stats = checkIpc(fileURLToPath(new URL('../', import.meta.url)))
  assert.ok(stats.commands > 0)
  assert.ok(stats.dtos >= 50)
  assert.ok(stats.enums >= 4)
})
