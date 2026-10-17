import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { ServiceLifetime } from '../lifetime.mjs'
import { writeUiSnapshot } from '../snapshot.mjs'
import { uiTask } from '../ui-task.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const helper = path.join(root, 'dist/helper-msix'), exe = path.join(helper, 'BewlyDownloadHost.exe')
const origin = 'chrome-extension://' + JSON.parse(readFileSync(path.join(root, 'native/identity.json'), 'utf8')).extensionId + '/'
const info = { bvid: 'BV17x411w7KC', title: 'Lifecycle fixture', cover: '', author: 'Fixture', pages: [{ cid: 42, page: 1, title: 'Lifecycle fixture', duration: 1 }] }
const frame = value => { const data = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4); header.writeUInt32LE(data.length); return Buffer.concat([header, data]) }
async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'bewly-lifetime-'))
  t.after(async () => {
    try { const c = JSON.parse(readFileSync(path.join(directory, 'connection.json'), 'utf8')); process.kill(c.pid) } catch {}
    await delay(150)
    assert.equal(path.dirname(directory), path.resolve(tmpdir()))
    assert.ok(path.basename(directory).startsWith('bewly-lifetime-'))
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })
  return directory
}
const environment = directory => ({ ...process.env, BEWLY_DOWNLOAD_DATA: directory, BEWLY_DOWNLOAD_HEADLESS: '1' })
function invoke(directory, message, extra = {}) {
  const result = spawnSync(exe, [origin], { env: { ...environment(directory), ...extra }, input: frame(message), windowsHide: true, timeout: 15000 })
  assert.equal(result.status, 0, result.stderr.toString())
  return JSON.parse(result.stdout.subarray(4))
}
async function rpc(directory, method, params = {}) {
  const c = JSON.parse(readFileSync(path.join(directory, 'connection.json'), 'utf8'))
  const response = await fetch(`http://127.0.0.1:${c.port}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${c.token}` }, body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(5000) })
  const value = await response.json()
  assert.equal(value.ok, true, value.error)
  return value
}
async function until(predicate, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await predicate()) return; await delay(100) }
  throw new Error('Lifecycle condition did not settle')
}
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

test('observations do not extend an idle lease, busy work does, and manual mode stays resident', () => {
  let now = 10000
  const lifetime = new ServiceLifetime('on-demand', () => now)
  assert.equal(lifetime.snapshot(false).exitAt, 15000)
  now = 14000
  assert.equal(lifetime.snapshot(false).exitAt, 15000)
  assert.equal(lifetime.snapshot(true).exitAt, undefined)
  now = 20000
  assert.equal(lifetime.snapshot(false).exitAt, 25000)
  lifetime.manual()
  now = 100000
  assert.equal(lifetime.snapshot(false).exitAt, undefined)
})

test('UI snapshot projection excludes prepared media and session credentials', async t => {
  const directory = await temporary(t)
  const task = { id: 'fixture', title: 'Safe', status: 'pending', prepared: { video: { urls: ['signed-secret'] } }, cookie: 'private', token: 'private', cover: 'https://i0.hdslb.com/cover.jpg' }
  assert.equal(uiTask(task).prepared, undefined)
  writeUiSnapshot(directory, { settings: {} }, [task], { pending: 1 })
  const text = readFileSync(path.join(directory, 'ui-snapshot.json'), 'utf8')
  assert.ok(!text.includes('private') && !text.includes('signed-secret'))
  assert.equal(JSON.parse(text).items[0].cover, task.cover)
})

test('native UI snapshots work without Node or a download service', { skip: !existsSync(exe) }, async t => {
  const directory = await temporary(t)
  writeUiSnapshot(directory, { version: 'fixture', settings: {} }, [{ id: 'pending', status: 'pending' }], { pending: 1 })
  const reply = invoke(directory, { method: 'uiSnapshot', requestId: 1 }, { BEWLY_NODE_PATH: path.join(directory, 'missing/node.exe') })
  assert.equal(reply.ok, true)
  assert.equal(reply.result.items[0].id, 'pending')
  assert.equal(existsSync(path.join(directory, 'downloads.sqlite')), false)
  assert.equal(existsSync(path.join(directory, 'support')), false)
})

test('passive native requests never start a download service', { skip: !existsSync(exe) }, async t => {
  const directory = await temporary(t)
  const reply = invoke(directory, { method: 'health', requestId: 1 })
  assert.equal(reply.ok, false)
  assert.equal(reply.code, 'SERVICE_OFFLINE')
  assert.equal(existsSync(path.join(directory, 'connection.json')), false)
  assert.equal(existsSync(path.join(directory, 'downloads.sqlite')), false)
})

test('a pending-only service exits despite polling and its live native bridge exits too', { skip: !existsSync(exe), timeout: 25000 }, async t => {
  const directory = await temporary(t)
  const host = spawn(exe, [origin], { env: environment(directory), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => { host.kill(); host.stdin.destroy() })
  host.stderr.on('data', () => {})
  let data = Buffer.alloc(0), sequence = 0, stopped
  const pending = new Map()
  host.stdout.on('data', chunk => {
    data = Buffer.concat([data, chunk])
    while (data.length >= 4 && data.length >= data.readUInt32LE(0) + 4) {
      const length = data.readUInt32LE(0), reply = JSON.parse(data.subarray(4, length + 4))
      data = data.subarray(length + 4)
      if (reply.event === 'serviceStopped') stopped = reply.snapshot
      pending.get(reply.requestId)?.(reply)
      pending.delete(reply.requestId)
    }
  })
  const send = (method, params = {}, allowStart = false) => new Promise(resolve => {
    const requestId = ++sequence
    pending.set(requestId, resolve)
    host.stdin.write(frame({ method, params, allowStart, requestId }))
  })
  const configured = await send('configure', { directory: path.join(directory, 'output') }, true)
  assert.equal(configured.runtime.mode, 'on-demand')
  const staged = await send('stageTasks', { info, cids: [42], options: { outputs: ['video'] } }, true)
  assert.equal(staged.result[0].status, 'pending')
  const pid = JSON.parse(readFileSync(path.join(directory, 'connection.json'), 'utf8')).pid
  const poll = setInterval(() => { if (host.exitCode === null && !host.stdin.destroyed) void send('queryTasks', { pageSize: 1 }) }, 500)
  t.after(() => clearInterval(poll))
  await until(() => host.exitCode !== null)
  clearInterval(poll)
  assert.equal(host.exitCode, 0)
  assert.equal(alive(pid), false)
  assert.equal(existsSync(path.join(directory, 'connection.json')), false)
  assert.equal(stopped.items[0].status, 'pending')
  assert.equal(JSON.parse(readFileSync(path.join(directory, 'ui-snapshot.json'), 'utf8')).counts.pending, 1)
})

test('manual Windows launch promotes an existing on-demand service without replacing it', { skip: !existsSync(exe), timeout: 20000 }, async t => {
  const directory = await temporary(t)
  const reply = invoke(directory, { method: 'health', allowStart: true })
  assert.equal(reply.runtime.mode, 'on-demand')
  const before = JSON.parse(readFileSync(path.join(directory, 'connection.json'), 'utf8')).pid
  const launch = spawnSync(exe, ['--start-service'], { env: environment(directory), windowsHide: true, encoding: 'utf8' })
  assert.equal(launch.status, 0, launch.stderr)
  await until(async () => (await rpc(directory, 'health')).runtime.mode === 'manual')
  await delay(6000)
  assert.equal(JSON.parse(readFileSync(path.join(directory, 'connection.json'), 'utf8')).pid, before)
  assert.equal(alive(before), true)
  await rpc(directory, 'desktopAction', { action: 'exit' })
  await until(() => !alive(before))
})

test('a slow active download is retained until completion, then the service exits', { skip: !existsSync(exe), timeout: 24000 }, async t => {
  const directory = await temporary(t), script = path.join(directory, 'slow-service.mjs')
  const serviceUrl = new URL('../service.mjs', 'file:///' + helper.replaceAll('\\', '/') + '/tests/test.mjs').href
  writeFileSync(script, `import {setTimeout as delay} from 'node:timers/promises'; globalThis.fetch = async () => { await delay(6500); return new Response('synthetic cover'); }; const {startService} = await import(${JSON.stringify(serviceUrl)}); await startService();`)
  const service = spawn(process.execPath, [script], { env: { ...environment(directory), BEWLY_DOWNLOAD_MODE: 'on-demand' }, windowsHide: true, stdio: 'ignore' })
  t.after(() => service.kill())
  await until(() => existsSync(path.join(directory, 'connection.json')))
  await rpc(directory, 'configure', { directory: path.join(directory, 'output') })
  const created = await rpc(directory, 'createTasks', { info: { ...info, cover: 'https://i0.hdslb.com/fixture.jpg' }, cids: [42], options: { outputs: ['cover'] } })
  const id = created.result[0].id
  await delay(5500)
  assert.equal(service.exitCode, null)
  assert.equal((await rpc(directory, 'health')).runtime.state, 'busy')
  await until(async () => (await rpc(directory, 'queryTasks')).result.items.find(task => task.id === id)?.status === 'completed')
  await until(() => service.exitCode !== null)
  assert.equal(service.exitCode, 0)
  const record = JSON.parse(readFileSync(path.join(directory, 'ui-snapshot.json'), 'utf8')).items.find(task => task.id === id)
  assert.equal(record.status, 'completed')
  assert.ok(existsSync(record.output))
})
