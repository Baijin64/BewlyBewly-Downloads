import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { candidates, isCompatible, parseShasums, parseVersion, resolveNode, tarballFor } from '../runtime/node-resolver.mjs'
import { latestFor } from '../runtime/node-install.mjs'

const hash = 'a'.repeat(64)

test('version parsing accepts v-prefixed and bare semver', () => {
  assert.deepEqual(parseVersion('v24.14.1'), { major: 24, minor: 14, patch: 1, text: '24.14.1' })
  assert.equal(parseVersion('24.0.0').major, 24)
  assert.equal(parseVersion('not-a-version'), null)
  assert.equal(parseVersion(undefined), null)
})

test('compatibility requires Node 24, matching arch and the sqlite/fetch probe', () => {
  const good = { version: '24.14.1', arch: 'x64', fetch: true, abort: true }
  assert.equal(isCompatible(good, { platform: 'linux', arch: 'x64' }), true)
  assert.equal(isCompatible({ ...good, version: '22.14.0' }, { platform: 'linux', arch: 'x64' }), false)
  assert.equal(isCompatible({ ...good, arch: 'arm64' }, { platform: 'darwin', arch: 'arm64' }), true)
  assert.equal(isCompatible({ ...good, arch: 'arm64' }, { platform: 'darwin', arch: 'x64' }), false)
  assert.equal(isCompatible({ ...good, fetch: false }, { platform: 'linux', arch: 'x64' }), false)
  assert.equal(isCompatible(null), false)
})

test('tarball naming stays inside the official release matrix', () => {
  assert.equal(tarballFor('24.14.1', 'darwin', 'arm64'), 'node-v24.14.1-darwin-arm64.tar.gz')
  assert.equal(tarballFor('24.14.1', 'linux', 'x64'), 'node-v24.14.1-linux-x64.tar.gz')
  assert.throws(() => tarballFor('24.14.1', 'win32', 'x64'))
  assert.throws(() => tarballFor('24.14.1', 'linux', 'ia32'))
})

test('checksum parsing only matches the exact archive name', () => {
  const text = [
    `${hash}  node-v24.14.1-linux-x64.tar.gz`,
    `${'b'.repeat(64)}  node-v24.14.1-linux-arm64.tar.gz`,
  ].join('\n')
  assert.equal(parseShasums(text, 'node-v24.14.1-linux-x64.tar.gz'), hash)
  assert.equal(parseShasums(text, '../node-v24.14.1-linux-x64.tar.gz'), '')
  assert.equal(parseShasums(text, 'node-v24.14.1-linux-x64.tar.gz.exe'), '')
})

test('release selection picks the archive for this platform and arch', () => {
  const text = [
    `${'1'.repeat(64)}  node-v24.14.1-darwin-arm64.tar.gz`,
    `${'2'.repeat(64)}  node-v24.14.1-darwin-x64.tar.gz`,
    `${'3'.repeat(64)}  node-v24.14.1-linux-arm64.tar.gz`,
    `${'4'.repeat(64)}  node-v24.14.1-linux-x64.tar.gz`,
  ].join('\n')
  assert.deepEqual(latestFor(text, 'darwin', 'arm64'), { version: '24.14.1', filename: 'node-v24.14.1-darwin-arm64.tar.gz', sha256: '1'.repeat(64) })
  assert.equal(latestFor(text, 'linux', 'x64').sha256, '4'.repeat(64))
  assert.equal(latestFor(text, 'linux', 'ia32'), null)
  assert.equal(latestFor('', 'linux', 'x64'), null)
})

test('candidate ordering prefers the explicit override then the managed runtime', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'bewly-resolver-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const managed = path.join(directory, 'data', 'runtime', 'node', 'bin', 'node')
  const override = path.join(directory, 'override-node')
  const pathDirectory = path.join(directory, 'bin')
  const onPath = path.join(pathDirectory, 'node')
  mkdirSync(path.dirname(managed), { recursive: true })
  mkdirSync(pathDirectory, { recursive: true })
  for (const file of [managed, override, onPath]) writeFileSync(file, '#!/bin/sh\n')

  const { list, arch } = candidates({ env: { BEWLY_NODE_PATH: override, PATH: pathDirectory }, dataDirectory: path.join(directory, 'data'), platform: 'linux', arch: 'x64' })
  assert.equal(arch, 'x64')
  assert.deepEqual(list.slice(0, 3).map(item => item.source), ['env', 'managed', 'path'])
  assert.equal(list[0].executable, override)
  assert.equal(list[2].executable, onPath)

  const missing = candidates({ env: { PATH: '' }, dataDirectory: path.join(directory, 'absent'), platform: 'darwin', arch: 'x64' })
  assert.ok(missing.list.every(item => !item.executable.startsWith(directory)))
})

test('resolver reports a reason instead of throwing when nothing is usable', () => {
  const result = resolveNode({ env: { PATH: '' }, platform: 'linux', arch: 'x64', probe: () => null })
  assert.equal(result.ready, false)
  assert.match(result.reason, /Node\.js 24/)
})
