import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const helper = process.env.BEWLY_NATIVE_TEST_ROOT || path.join(root, 'dist/helper-msix')
const host = path.join(helper, 'BewlyDownloadHost.exe')
const identity = JSON.parse(readFileSync(path.join(root, 'native/identity.json'), 'utf8'))
const version = JSON.parse(readFileSync(path.join(root, 'native/package.json'), 'utf8')).version
const origin = `chrome-extension://${identity.extensionId}/`
const frame = value => { const body = Buffer.from(JSON.stringify(value)); const prefix = Buffer.alloc(4); prefix.writeUInt32LE(body.length); return Buffer.concat([prefix, body]) }
function replies(bytes) {
  const result = []
  while (bytes.length) { assert.ok(bytes.length >= 4); const length = bytes.readUInt32LE(0); assert.ok(bytes.length >= length + 4); result.push(JSON.parse(bytes.subarray(4, length + 4))); bytes = bytes.subarray(length + 4) }
  return result
}
async function temporary(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'bewly-runtime-test-'))
  t.after(async () => {
    const connection = path.join(directory, 'data/connection.json')
    if (existsSync(connection)) { try { process.kill(JSON.parse(readFileSync(connection, 'utf8')).pid) } catch {} await delay(200) }
    assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('bewly-runtime-test-'))
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  })
  return directory
}
function invoke(args, env = {}, input) {
  return spawnSync(host, args, { input, env: { ...process.env, ...env }, windowsHide: true, timeout: 15000 })
}

test('slim payload excludes Node and foreign prebuilds while resolving a compatible system Node', { skip: process.platform !== 'win32' }, async () => {
  assert.equal(existsSync(path.join(helper, 'runtime/node.exe')), false)
  assert.deepEqual(await readdir(path.join(helper, 'node_modules/classic-level/prebuilds')), ['win32-x64'])
  const result = invoke(['--runtime-diagnostics'], { BEWLY_NODE_PATH: process.execPath, NODE_OPTIONS: '--require=Z:/must-not-load.cjs' })
  assert.equal(result.status, 0, result.stderr.toString())
  const report = JSON.parse(result.stdout)
  assert.equal(report.connectorVersion, version); assert.equal(report.runtime.ready, true)
  assert.equal(report.runtime.executable.toLowerCase(), process.execPath.toLowerCase())
})

test('bootstrap and missing-runtime errors work without Node, a daemon or user data access', async t => {
  const directory = await temporary(t), data = path.join(directory, 'data')
  const env = { BEWLY_NODE_PATH: path.join(directory, 'missing/node.exe'), BEWLY_DOWNLOAD_DATA: data, BEWLY_DOWNLOAD_HEADLESS: '1' }
  const input = Buffer.concat([frame({ method: 'bootstrapStatus', requestId: 1 }), frame({ method: 'health', requestId: 2 })])
  const result = invoke([origin], env, input)
  assert.equal(result.status, 0, result.stderr.toString())
  const [bootstrap, health] = replies(result.stdout)
  assert.equal(bootstrap.requestId, 1); assert.equal(bootstrap.result.runtime.ready, false)
  assert.equal(health.requestId, 2); assert.equal(health.code, 'NODE_UNAVAILABLE')
  assert.match(health.error, /开始菜单/)
  assert.equal(existsSync(data), false)
  const forbidden = invoke(['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'], env, input)
  assert.equal(forbidden.status, 2); assert.equal(forbidden.stdout.length, 0)
})

test('bootstrap-to-live bridge preserves frames and uses the selected system Node for the daemon', async t => {
  const directory = await temporary(t), data = path.join(directory, 'data')
  const input = Buffer.concat([frame({ method: 'bootstrapStatus', requestId: 1 }), frame({ method: 'health', requestId: 2 }), frame({ method: 'bootstrapStatus', requestId: 3 })])
  const result = invoke([origin], { BEWLY_NODE_PATH: process.execPath, BEWLY_DOWNLOAD_DATA: data, BEWLY_DOWNLOAD_HEADLESS: '1', NODE_OPTIONS: '--require=Z:/must-not-load.cjs' }, input)
  assert.equal(result.status, 0, result.stderr.toString())
  const output = replies(result.stdout)
  assert.deepEqual(output.map(reply => reply.requestId), [1, 2, 3])
  assert.ok(output.every(reply => reply.ok))
  assert.equal(output[1].result.version, version)
  assert.equal(output[2].result.runtime.executable.toLowerCase(), process.execPath.toLowerCase())
  assert.ok(existsSync(path.join(data, 'connection.json')))
})

test('runtime detection rejects old versions and wrong architectures', async t => {
  const directory = await temporary(t), fake = path.join(directory, 'node.exe'), source = path.join(directory, 'FakeNode.cs')
  // Keep the fixture executable independent from the real Node installation.
  writeFileSync(source, `using System; using System.Web.Script.Serialization; class FakeNode { static void Main() { Console.WriteLine(new JavaScriptSerializer().Serialize(new { version = Environment.GetEnvironmentVariable("TEST_NODE_VERSION"), architecture = Environment.GetEnvironmentVariable("TEST_NODE_ARCH"), fetch = true, abort = true })); } }`)
  execFileSync(path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/target:exe', '/reference:System.Web.Extensions.dll', '/out:' + fake, source], { windowsHide: true })
  for (const [version, arch] of [['22.14.0', 'x64'], ['24.14.1', 'arm64']]) {
    const result = invoke(['--runtime-diagnostics'], { BEWLY_NODE_PATH: fake, TEST_NODE_VERSION: version, TEST_NODE_ARCH: arch })
    assert.equal(result.status, 0)
    const report = JSON.parse(result.stdout)
    assert.equal(report.runtime.ready, false)
    assert.equal(report.runtime.version, version); assert.equal(report.runtime.architecture, arch)
  }
})

test('Node installer release selection accepts only the official Node 24 x64 MSI filename', () => {
  const hash = 'a'.repeat(64)
  const good = invoke(['--node-release-diagnostics'], {}, Buffer.from(`${hash}  node-v24.21.0-x64.msi\r\n`))
  assert.equal(good.status, 0)
  assert.equal(JSON.parse(good.stdout).url, 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-x64.msi')
  for (const name of ['node-v22.1.0-x64.msi', 'node-v24.21.0-arm64.msi', '../node-v24.21.0-x64.msi', 'node-v24.21.0-x64.msi.exe'])
    assert.equal(invoke(['--node-release-diagnostics'], {}, Buffer.from(`${hash}  ${name}\n`)).status, 1)
})

test('native Node setup layout fits the current DPI without showing a window', async t => {
  const directory = await temporary(t)
  const result = invoke(['--node-setup-preview', path.join(directory, 'setup.png')])
  assert.equal(result.status, 0, result.stderr.toString())
  const layout = JSON.parse(result.stdout)
  assert.equal(layout.allControlsFit, true)
  assert.ok(layout.dpi >= 96)
  assert.ok(existsSync(path.join(directory, 'setup.png')))
  assert.equal(existsSync(path.join(directory, 'data')), false)
})

test('terminating the media connector also terminates its own FFmpeg child', { timeout: 12000 }, async t => {
  const wrapper = spawn(host, ['--run-tool', 'ffmpeg', '-nostdin', '-re', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '60', '-f', 'null', '-'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  let mediaPid
  const running = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  t.after(() => { if (wrapper.exitCode === null) wrapper.kill(); if (mediaPid && running(mediaPid)) process.kill(mediaPid) })
  const closed = new Promise(resolve => wrapper.once('close', resolve))
  await Promise.race([new Promise(resolve => wrapper.stderr.once('data', resolve)), closed.then(() => { throw new Error('Media wrapper exited before starting FFmpeg') }), delay(5000).then(() => { throw new Error('Media wrapper did not start') })])
  const result = execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${wrapper.pid}' | Select-Object -ExpandProperty ProcessId | ConvertTo-Json`], { windowsHide: true, encoding: 'utf8' })
  mediaPid = JSON.parse(result)
  assert.ok(Number.isInteger(mediaPid) && mediaPid > 0)
  wrapper.kill(); await closed
  for (let n = 0; n < 20 && running(mediaPid); n++) await delay(100)
  assert.equal(running(mediaPid), false, 'stopping a transfer must not leave a media process running')
  assert.equal(invoke(['--run-tool', 'notepad']).status, 1)
})
