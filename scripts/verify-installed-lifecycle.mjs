// Explicit Windows integration check. Uses only its own temporary queue and files.
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const alias = path.join(process.env.LOCALAPPDATA, 'Microsoft/WindowsApps/BewlyDownloadHost.exe')
const data = await mkdtemp(path.join(tmpdir(), 'bewly-installed-lifecycle-'))
const env = { ...process.env, BEWLY_DOWNLOAD_DATA: data }
const extensionVersion = JSON.parse(readFileSync('package.json')).version
delete env.BEWLY_DOWNLOAD_HEADLESS
const origin = 'chrome-extension://' + JSON.parse(readFileSync('platforms/identity.json')).extensionId + '/'
const frame = value => { const body = Buffer.from(JSON.stringify(value)), size = Buffer.alloc(4); size.writeUInt32LE(body.length); return Buffer.concat([size, body]) }
const descriptor = () => JSON.parse(readFileSync(path.join(data, 'connection.json')))
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const processes = () => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'], { windowsHide: true, encoding: 'utf8' }))
async function until(predicate, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await predicate()) return; await delay(100) }
  throw new Error('Installed lifecycle did not settle')
}
async function rpc(method, params = {}) {
  const connection = descriptor()
  const response = await fetch('http://127.0.0.1:' + connection.port + '/rpc', { method: 'POST', headers: { Authorization: 'Bearer ' + connection.token }, body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(5000) })
  const result = await response.json()
  assert.equal(result.ok, true, result.error)
  return result
}
let host, timer
const report = { helperVersion: /\[workspace\.package\][\s\S]*?version\s*=\s*"([^"]+)"/.exec(readFileSync('rust/Cargo.toml', 'utf8'))[1], checkedAt: new Date().toISOString(), productionDataTouched: false }
try {
  const passive = spawnSync(alias, [origin], { env, input: frame({ method: 'health' }), windowsHide: true, timeout: 15000 })
  assert.equal(passive.status, 0)
  assert.equal(JSON.parse(passive.stdout.subarray(4)).code, 'SERVICE_OFFLINE')
  assert.equal(existsSync(path.join(data, 'downloads.sqlite')), false)
  report.passiveRequestDidNotStartService = true
  host = spawn(alias, [origin], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  host.stderr.on('data', () => {})
  let buffer = Buffer.alloc(0), sequence = 0, finalSnapshot
  const waiting = new Map()
  host.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const length = buffer.readUInt32LE(0), reply = JSON.parse(buffer.subarray(4, length + 4))
      buffer = buffer.subarray(length + 4)
      if (reply.event === 'serviceStopped') finalSnapshot = reply.snapshot
      waiting.get(reply.requestId)?.(reply); waiting.delete(reply.requestId)
    }
  })
  const send = (method, params = {}, allowStart = false) => new Promise((resolve, reject) => {
    const requestId = ++sequence, timeout = setTimeout(() => reject(new Error('Installed native frame timed out')), 15000)
    waiting.set(requestId, reply => { clearTimeout(timeout); resolve(reply) })
    host.stdin.write(frame({ method, params, allowStart, requestId }))
  })
  const configured = await send('configure', { directory: path.join(data, 'output') }, true)
  assert.equal(configured.runtime.mode, 'on-demand')
  const queued = await send('stageTasks', { info: { bvid: 'BV17x411w7KC', title: 'Isolated lifecycle fixture', author: 'Fixture', pages: [{ cid: 42, page: 1, title: 'Fixture' }] }, cids: [42], options: { outputs: ['video'] } }, true)
  assert.equal(queued.result[0].status, 'pending')
  const started = Date.now()
  const pid = descriptor().pid
  await until(async () => (await rpc('health')).result.lastTrayContact > 0)
  const tree = processes(), owned = new Set([pid, host.pid])
  for (let i = 0; i < 5; i++) for (const row of tree) if (owned.has(row.ParentProcessId)) owned.add(row.ProcessId)
  report.observedOwnedProcesses = owned.size
  timer = setInterval(() => { if (host.exitCode === null && !host.stdin.destroyed) void send('queryTasks').catch(() => {}) }, 500)
  await until(() => host.exitCode !== null)
  clearInterval(timer)
  await until(() => [...owned].every(pid => !alive(pid)))
  assert.equal(host.exitCode, 0)
  assert.equal(finalSnapshot.counts.pending, 1)
  report.autoExitMilliseconds = Date.now() - started
  report.pendingQueuePersisted = true
  report.serviceTrayAndLiveNativeHostExited = true
  report.pollingDoesNotKeepServiceAlive = true
  const manual = spawnSync(alias, ['--start-service'], { env, windowsHide: true, timeout: 15000 })
  assert.equal(manual.status, 0)
  await until(() => existsSync(path.join(data, 'connection.json')))
  await delay(6500)
  assert.equal((await rpc('health')).runtime.mode, 'manual')
  assert.equal((await rpc('queryTasks')).result.counts.pending, 1)
  report.manualLaunchStayedResident = true
  await rpc('desktopAction', { action: 'exit' })
  await until(() => !existsSync(path.join(data, 'connection.json')))
  await writeFile(`dist/on-demand-${extensionVersion}/installed-lifecycle-verification.json`, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
}
finally {
  clearInterval(timer)
  try { await rpc('desktopAction', { action: 'exit' }); await until(() => !existsSync(path.join(data, 'connection.json'))) } catch {}
  host?.kill(); host?.stdin.destroy()
  assert.equal(existsSync(path.join(data, 'connection.json')), false, 'Leaving isolated files while the service is running')
  assert.equal(path.dirname(data), path.resolve(tmpdir()))
  assert.ok(path.basename(data).startsWith('bewly-installed-lifecycle-'))
  await rm(data, { recursive: true, force: true, maxRetries: 3 })
}
