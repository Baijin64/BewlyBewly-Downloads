// Explicit opt-in integration check. Uses a separate database and output directory.
// Never prints the encrypted or clear browser session, signed media URLs or RPC token.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const video = process.argv[2]
if (!/^BV[0-9A-Za-z]{10}$/.test(video || '')) throw new Error('Pass one explicit BV identifier')
const root = process.env.BEWLY_NATIVE_TEST_ROOT || path.resolve('dist/helper-msix')
const output = path.resolve('dist/live-download-' + Date.now())
const data = path.join(output, 'data')
await mkdir(data, { recursive: true })
const session = path.join(process.env.LOCALAPPDATA, 'BewlyDownload/session.dpapi')
if (existsSync(session)) await copyFile(session, path.join(data, 'session.dpapi'))
const identity = JSON.parse(await readFile(path.join(root, 'identity.json'), 'utf8'))
const bridge = spawn(path.join(root, 'BewlyDownloadHost.exe'), ['chrome-extension://' + identity.extensionId + '/'], { windowsHide: true, env: { ...process.env, BEWLY_DOWNLOAD_DATA: data } })
let buffer = Buffer.alloc(0)
let waiting
let requestId = 0
bridge.stderr.on('data', () => {})
bridge.stdout.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
    const size = buffer.readUInt32LE(0)
    const result = JSON.parse(buffer.subarray(4, size + 4).toString('utf8'))
    buffer = buffer.subarray(size + 4)
    waiting?.(result)
    waiting = undefined
  }
})
async function framed(method, params = {}) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Native request timed out')), 15000)
    waiting = reply => { clearTimeout(timeout); reply.ok ? resolve(reply.result) : reject(new Error(reply.error)) }
    const body = Buffer.from(JSON.stringify({ requestId: ++requestId, method, params }))
    const prefix = Buffer.alloc(4); prefix.writeUInt32LE(body.length)
    bridge.stdin.write(Buffer.concat([prefix, body]))
  })
}
let descriptor
async function rpc(method, params = {}) {
  descriptor ||= JSON.parse(await readFile(path.join(data, 'connection.json'), 'utf8'))
  const response = await fetch('http://127.0.0.1:' + descriptor.port + '/rpc', { method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.token }, body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(20000) })
  const reply = await response.json()
  if (!reply.ok) throw new Error(reply.error)
  return reply.result
}
const report = { startedAt: new Date().toISOString(), video, isolated: true }
try {
  const health = await framed('health')
  assert.equal(health.protocol, 2)
  await framed('configure', { directory: path.join(output, 'videos'), maxConcurrent: 1, soundTip: false, shutdown: false, listenClipboard: false })
  const info = await framed('inspect', { video })
  const [task] = await framed('stageTasks', { info, cids: [info.pages[0].cid], options: { quality: 16, codec: 'avc', audioQuality: '192' } })
  assert.equal(task.status, 'pending')
  await framed('batchAction', { ids: [task.id], action: 'start' })
  const bridgeExited = new Promise(resolve => bridge.once('exit', code => resolve(code)))
  bridge.stdin.end()
  assert.equal(await Promise.race([bridgeExited, delay(5000).then(() => -1)]), 0)
  report.bridgeExitedAt = new Date().toISOString()
  const afterExit = await rpc('queryTasks')
  report.statusAtBridgeExit = afterExit.items.find(item => item.id === task.id)?.status
  report.bridgeExitedBeforeCompletion = report.statusAtBridgeExit !== 'completed'
  assert.ok(['queued', 'resolving', 'downloading', 'muxing', 'postprocessing'].includes(report.statusAtBridgeExit), 'Download must still be active after the bridge exits')
  for (let attempt = 0; attempt < 180; attempt++) {
    const query = await rpc('queryTasks')
    const current = query.items.find(item => item.id === task.id)
    if (current?.status === 'failed') throw new Error(current.error)
    if (current?.status === 'completed') {
      assert.ok(existsSync(current.output))
      assert.equal(current.actualQuality, 16)
      assert.equal(current.actualCodec, 7)
      report.completed = true
      report.output = current.output
      report.quality = current.actualQuality
      report.codec = current.actualCodec
      report.audioId = current.actualAudioId
      break
    }
    await delay(1000)
  }
  if (!report.completed) throw new Error('Live download did not finish within 180 seconds')
  const active = await rpc('health')
  report.trayConnected = active.lastTrayContact > 0
  assert.ok(report.trayConnected, 'The real Windows tray must authenticate to the isolated service')
  report.helperVersion = active.version
}
catch (error) {
  report.completed = false
  report.error = String(error.message).replace(/https?:\/\/[^\s]+/g, value => { try { return new URL(value).hostname } catch { return '[url]' } })
  process.exitCode = 1
}
finally {
  await rpc('desktopAction', { action: 'exit' }).catch(() => {})
  bridge.kill()
  for (let attempt = 0; attempt < 30 && existsSync(path.join(data, 'connection.json')); attempt++) await delay(200)
  await unlink(path.join(data, 'session.dpapi')).catch(() => {})
  report.finishedAt = new Date().toISOString()
  await writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
