import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { checkVersions, readWorkspaceVersion } from './check-version.mjs'

const files = ['package.json', 'apps/desktop/package.json', 'apps/desktop/src-tauri/tauri.conf.json', 'Cargo.toml']

function fixture(t, version = '0.1.0') {
  const root = mkdtempSync(join(tmpdir(), 'mimenote-version-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeVersion(root, file, version)
  }
  return root
}

function writeVersion(root, file, version) {
  writeFileSync(join(root, file), file === 'Cargo.toml'
    ? `[workspace]\nresolver = "2"\n\n[workspace.package]\nversion = "${version}"\nedition = "2021"\n\n[workspace.dependencies]\nother = "9.0.0"\n`
    : JSON.stringify({ version }))
}

test('四处版本相同，本地检查与标签检查均通过', (t) => {
  const root = fixture(t)
  assert.equal(checkVersions(root), '0.1.0')
  assert.equal(checkVersions(root, 'v0.1.0'), '0.1.0')
})

test('预发布版本通过', (t) => {
  assert.equal(checkVersions(fixture(t, '1.2.3-rc.1'), 'v1.2.3-rc.1'), '1.2.3-rc.1')
})

for (const file of files) {
  test(`${file} 漂移会阻断本地与发布检查`, (t) => {
    const root = fixture(t)
    writeVersion(root, file, '0.2.0')
    for (const tag of [undefined, 'v0.1.0']) {
      assert.throws(() => checkVersions(root, tag), (error) => {
        assert.match(error.message, /0\.2\.0/)
        assert.match(error.message, /0\.1\.0/)
        if (tag !== undefined) assert.ok(error.message.includes(file))
        return true
      })
    }
  })
  test(`${file} 缺失或损坏会失败并指出文件`, (t) => {
    const root = fixture(t)
    for (const content of ['', '{}', 'invalid']) {
      writeFileSync(join(root, file), content)
      assert.throws(() => checkVersions(root), (error) => error.message.includes(file))
    }
    rmSync(join(root, file))
    assert.throws(() => checkVersions(root), (error) => error.message.includes(file))
  })
}

test('同时报告所有不匹配的版本来源', (t) => {
  assert.throws(() => checkVersions(fixture(t), 'v2.0.0'), (error) => {
    for (const file of files) assert.ok(error.message.includes(file))
    return true
  })
})

test('拒绝非法标签与非法版本，即使四处一致', (t) => {
  const root = fixture(t)
  for (const tag of ['', '0.1.0', 'v01.1.0', 'v1.2', 'v1.2.3-01', 'v1.2.3+', 'v1.2.3+build', 'v0.1.0\n']) {
    assert.throws(() => checkVersions(root, tag), /标签/)
  }
  for (const version of ['01.1.0', '1.2', '1.2.3-01', '', 1, null]) {
    for (const file of files) writeVersion(root, file, version)
    assert.throws(() => checkVersions(root), /非法或缺失/)
  }
})

test('Cargo 只读取 workspace.package，兼容 CRLF、注释和单引号', () => {
  const source = "[package]\r\nversion = '9.0.0'\r\n[workspace.package] # shared\r\nversion = '0.1.0' # release\r\n[workspace.dependencies]\r\nversion = '8.0.0'\r\n"
  assert.equal(readWorkspaceVersion(source), '0.1.0')
  for (const invalid of [
    '[package]\nversion = "0.1.0"',
    '[workspace.package]\n[workspace.dependencies]\nversion = "0.1.0"',
    '[workspace.package]\nversion = "0.1.0"\nversion = "0.2.0"',
    '[workspace.package]\nversion = 1',
    '[workspace.package]\nversion = "0.1.0',
  ]) assert.throws(() => readWorkspaceVersion(invalid))
})

test('CLI 从其他目录运行，并在非法输入或版本漂移时返回非零退出码', (t) => {
  const root = fixture(t)
  mkdirSync(join(root, 'scripts'))
  const script = join(root, 'scripts/check-version.mjs')
  copyFileSync(fileURLToPath(new URL('./check-version.mjs', import.meta.url)), script)
  for (const args of [[], ['v0.1.0']]) {
    const success = spawnSync(process.execPath, [script, ...args], { cwd: tmpdir(), encoding: 'utf8' })
    assert.equal(success.status, 0, success.stderr)
    assert.match(success.stdout, /版本校验通过/)
  }
  for (const args of [['invalid'], ['v0.1.0', 'extra']]) {
    const failure = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
    assert.equal(failure.status, 1)
    assert.ok(failure.stderr.length > 0)
  }
  for (const file of files) {
    writeVersion(root, file, '0.2.0')
    const failure = spawnSync(process.execPath, [script, 'v0.1.0'], { encoding: 'utf8' })
    assert.equal(failure.status, 1)
    assert.ok(failure.stderr.includes(file))
    writeVersion(root, file, '0.1.0')
  }
})
