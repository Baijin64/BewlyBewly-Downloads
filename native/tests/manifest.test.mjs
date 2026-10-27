import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { browserDirectories, HOST_NAME, manifestFor, register, unregister } from '../posix/register.mjs'
import { nativeRoot } from './support/host.mjs'

const launcher = path.join(nativeRoot, 'posix', 'launcher.sh')

test('browser manifest directories follow each platform convention', () => {
  const mac = browserDirectories({ home: '/Users/x', kind: 'darwin' })
  assert.ok(mac.includes(path.join('/Users/x', 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts')))
  assert.ok(mac.every(item => item.endsWith('NativeMessagingHosts')))

  const linux = browserDirectories({ home: '/home/x', kind: 'linux', env: {} })
  assert.ok(linux.includes(path.join('/home/x', '.config', 'google-chrome', 'NativeMessagingHosts')))
  assert.ok(linux.includes(path.join('/home/x', '.config', 'microsoft-edge', 'NativeMessagingHosts')))
  assert.equal(linux.length, 4)
})

test('manifest payload matches the Chromium native messaging schema', () => {
  const manifest = manifestFor(launcher, ['chrome-extension://abc/'])
  assert.deepEqual(manifest, { name: HOST_NAME, description: 'Bewly local download core', path: launcher, type: 'stdio', allowed_origins: ['chrome-extension://abc/'] })
})

test('register writes every manifest with 0644 and is idempotent', async t => {
  const home = mkdtempSync(path.join(tmpdir(), 'bewly-manifest-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const files = register({ root: nativeRoot, launcher, home, kind: 'linux', env: {} })
  assert.equal(files.length, 4)
  for (const file of files) {
    assert.ok(existsSync(file))
    const manifest = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(manifest.path, launcher)
    assert.ok(manifest.allowed_origins.every(origin => /^chrome-extension:\/\/[a-p]{32}\/$/.test(origin)))
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o644)
  }
  assert.deepEqual(register({ root: nativeRoot, launcher, home, kind: 'linux', env: {} }), files)
  assert.equal(unregister({ home, kind: 'linux', env: {} }).length, 4)
  assert.ok(files.every(file => !existsSync(file)))
})

test('register refuses a relative or missing launcher', async t => {
  const home = mkdtempSync(path.join(tmpdir(), 'bewly-manifest-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  assert.throws(() => register({ root: nativeRoot, launcher: 'posix/launcher.sh', home, kind: 'linux', env: {} }), /绝对路径/)
  assert.throws(() => register({ root: nativeRoot, launcher: path.join(home, 'missing.sh'), home, kind: 'linux', env: {} }), /不存在/)
})

test('register creates missing browser directories', async t => {
  const home = mkdtempSync(path.join(tmpdir(), 'bewly-manifest-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  mkdirSync(home, { recursive: true })
  const files = register({ root: nativeRoot, launcher, home, kind: 'darwin', env: {} })
  assert.ok(files.every(existsSync))
})
