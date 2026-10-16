import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const JSZip = require('jszip')
const helperVersion = JSON.parse(await readFile(path.join(root, 'native/package.json'), 'utf8')).version
const stage = path.join(root, 'dist/helper-msix')
const packageFile = path.join(root, `dist/Bewly-DownloadHelper-${helperVersion}-x64.msix`)
const archive = await JSZip.loadAsync(await readFile(packageFile))
const entries = Object.values(archive.files).filter(entry => !entry.dir)
const groupOf = name => name.startsWith('runtime/') ? 'node' : name === 'bin/ffmpeg.exe' ? 'ffmpeg' : name === 'bin/aria2c.exe' ? 'aria2' : name.startsWith('node_modules/') ? 'migrationDependencies' : 'connectorCoreAndPackageMetadata'
const components = {}
for (const entry of entries) {
  const group = groupOf(entry.name.replaceAll('\\', '/'))
  components[group] ||= { installedBytes: 0, compressedBytes: 0, files: 0 }
  components[group].installedBytes += entry._data.uncompressedSize
  components[group].compressedBytes += entry._data.compressedSize
  components[group].files++
}
const totalBytes = Object.values(components).reduce((sum, value) => sum + value.installedBytes, 0)

// This is an isolated packaging experiment, not a filter applied to the release.
function keepRuntimeDependency(name) {
  const normalized = name.replaceAll('\\', '/')
  if (/\/prebuilds\//.test(normalized)) return /\/prebuilds\/win32-x64\/[^/]+\.node$/.test(normalized)
  if (/(^|\/)(test|tests|benchmark|benchmarks|example|examples|deps|src|types)(\/|$)/.test(normalized)) return false
  if (/\.(?:cc|cpp|h|gyp|gypi|map|ts)$/.test(normalized)) return false
  return true
}
async function files(directory, prefix = '') {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name)
    if (entry.isDirectory()) result.push(...await files(path.join(directory, entry.name), relative))
    else if (entry.isFile()) result.push({ relative, file: path.join(directory, entry.name), bytes: (await stat(path.join(directory, entry.name))).size })
  }
  return result
}
const dependencies = await files(path.join(stage, 'node_modules'))
const retained = dependencies.filter(entry => keepRuntimeDependency(entry.relative))
const retainedBytes = retained.reduce((sum, entry) => sum + entry.bytes, 0)
const sourceBytes = dependencies.reduce((sum, entry) => sum + entry.bytes, 0)
const directory = await mkdtemp(path.join(tmpdir(), 'bewly-component-audit-'))
const fixture = path.join(directory, 'connector')
const data = path.join(directory, 'service-data')
let child, closed
async function startFixture() {
  child = spawn(process.execPath, ['--no-warnings', path.join(fixture, 'service-entry.mjs')], {
    cwd: fixture, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, BEWLY_DOWNLOAD_DATA: data, BEWLY_DOWNLOAD_HEADLESS: '1' },
  })
  closed = new Promise(resolve => { child.once('close', resolve); child.once('error', () => resolve(-1)) })
  for (let n = 0; n < 60; n++) {
    if (existsSync(path.join(data, 'connection.json'))) return
    if (child.exitCode !== null) break
    await delay(100)
  }
  throw new Error('Isolated system-Node service failed to start')
}
async function rpc(method, params = {}) {
  const descriptor = JSON.parse(await readFile(path.join(data, 'connection.json'), 'utf8'))
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: descriptor.port, path: '/rpc', method: 'POST', agent: false, headers: { Authorization: `Bearer ${descriptor.token}`, 'Content-Type': 'application/json' } }, response => {
      let body = ''
      response.setEncoding('utf8'); response.on('data', chunk => { body += chunk })
      response.on('end', () => { try { const reply = JSON.parse(body); assert.equal(reply.ok, true); resolve(reply.result) } catch (error) { reject(error) } })
      response.on('error', reject)
    })
    request.setTimeout(5000, () => request.destroy(new Error('Isolated request timed out')))
    request.on('error', reject)
    request.end(JSON.stringify({ method, params }))
  })
}
async function stopFixture() {
  if (!child || child.exitCode !== null) return
  try { await rpc('desktopAction', { action: 'exit' }) } catch { child.kill() }
  const timer = setTimeout(() => child.kill(), 5000)
  try { await closed } finally { clearTimeout(timer) }
}
let validation
try {
  await mkdir(fixture, { recursive: true })
  for (const entry of retained) {
    const destination = path.join(fixture, 'node_modules', entry.relative)
    await mkdir(path.dirname(destination), { recursive: true })
    await copyFile(entry.file, destination)
  }
  for (const entry of await readdir(stage)) if (entry.endsWith('.mjs')) await copyFile(path.join(stage, entry), path.join(fixture, entry))
  const runtimeProbe = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import path from 'node:path';
    import { DatabaseSync } from 'node:sqlite';
    import { ClassicLevel } from './node_modules/classic-level/index.js';
    import { readLegacySettings } from './migration.mjs';
    const db = new DatabaseSync(':memory:');
    const sqlite = db.prepare('SELECT sqlite_version() AS version').get().version; db.close();
    const profile = path.join(process.cwd(), 'fake-legacy-profile');
    const level = new ClassicLevel(path.join(profile, 'Local Storage/leveldb'), { keyEncoding:'buffer', valueEncoding:'buffer' });
    const key = Buffer.concat([Buffer.from('_app://.\\x00'), Buffer.from([1]), Buffer.from('setting')]);
    await level.put(key, Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify({videoQn:'112',audioQn:'192',videoEncoding:'avc1',maxDownCount:4}), 'utf16le')]));
    await level.close();
    const settings = await readLegacySettings(profile, path.join(process.cwd(), 'fake-migration'), {checkRunning:false});
    assert.equal(settings.defaultOptions.quality,112); assert.equal(settings.maxConcurrent,4);
    console.log(JSON.stringify({version:process.version,arch:process.arch,sqlite,fetchAvailable:typeof fetch==='function',trimmedLegacyReaderVerified:true}));
  `], { cwd: fixture, windowsHide: true, encoding: 'utf8', timeout: 15000 })
  assert.equal(runtimeProbe.status, 0, runtimeProbe.stderr)
  const runtime = JSON.parse(runtimeProbe.stdout)
  await startFixture()
  const health = await rpc('health')
  assert.equal(health.version, helperVersion)
  assert.equal(health.engineInstalled, false)
  const info = { bvid: 'BV1GJ411x7h7', title: 'Component audit fixture', author: 'Synthetic', cover: '', pages: [{ cid: 1, page: 1, title: 'Fixture', duration: 1 }] }
  await rpc('stageTasks', { info, cids: [1], options: { outputs: ['cover'] } })
  const first = await rpc('queryTasks')
  assert.equal(first.counts.pending, 1); assert.equal(first.counts.active, 0)
  await stopFixture()
  await startFixture()
  const restored = await rpc('queryTasks')
  assert.equal(restored.items[0].id, first.items[0].id)
  assert.equal(restored.counts.pending, 1); assert.equal(restored.counts.active, 0)
  await stopFixture()
  validation = { ...runtime, noBundledNode: true, noAria2OrFfmpeg: true, coreHealthVerified: true, pendingQueueRestoredAfterRestart: true, noNetworkMediaRequested: true, productionProfileAccessed: false }
}
finally {
  await stopFixture()
  assert.equal(path.dirname(directory), path.resolve(tmpdir()))
  assert.ok(path.basename(directory).startsWith('bewly-component-audit-'))
  await rm(directory, { recursive: true, force: true, maxRetries: 3 })
}
const bundledNode = existsSync(path.join(stage, 'runtime/node.exe')) ? await readFile(path.join(stage, 'runtime/node.exe')) : undefined
const bundledNodeBytes = bundledNode?.length || 0
const systemNode = await readFile(process.execPath)
const report = {
  checkedAt: new Date().toISOString(), helperVersion, currentPackageBytes: (await stat(packageFile)).size,
  currentPayloadBytes: totalBytes, components,
  systemNode: { executable: process.execPath, bundledNodeAbsent: !bundledNode, bundledBinaryIdentical: bundledNode ? createHash('sha256').update(bundledNode).digest('hex') === createHash('sha256').update(systemNode).digest('hex') : null },
  dependencyPruningExperiment: { beforeBytes: sourceBytes, afterBytes: retainedBytes, removableBytes: sourceBytes - retainedBytes, retainedFiles: retained.length },
  payloadEstimates: {
    reuseSystemNodeAndTrimDependencies: totalBytes - bundledNodeBytes - (sourceBytes - retainedBytes),
    connectorWithTrimmedMigrationButNoRuntimeOrEngines: totalBytes - bundledNodeBytes - components.ffmpeg.installedBytes - components.aria2.installedBytes - (sourceBytes - retainedBytes),
    connectorWithoutMigrationRuntimeOrEngines: components.connectorCoreAndPackageMetadata.installedBytes,
  },
  validation,
  limitations: ['Payload estimates for further component splitting are not an installed modular connector.', 'The isolated script validation is separate from installed MSIX evidence in installed-runtime-version-verification.json.', 'Media transfer and merging need aria2/FFmpeg or a separate replacement implementation.', 'Current MSIX metadata is included in estimates and will change after repackaging.'],
}
await writeFile(path.join(root, 'dist/helper-size-audit.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
