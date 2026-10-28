// Explicit opt-in integration check. Uses a separate database and output directory.
// Never prints the encrypted or clear browser session, signed media URLs or RPC token.
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'

interface Reply {
  ok: boolean
  result?: unknown
  error?: string
}

interface Descriptor {
  port: number
  token: string
}

interface Health {
  protocol: number
  lastTrayContact: number
  version: string
}

interface VideoInfo {
  pages: Array<{ cid: number }>
}

interface TaskItem {
  id: string
  status: string
  output?: string
  error?: string
  actualQuality?: number
  actualCodec?: number
  actualAudioId?: number
}

interface QueryResult {
  items: TaskItem[]
}

interface LiveReport {
  startedAt: string
  video: string
  isolated: boolean
  bridgeExitedAt?: string
  statusAtBridgeExit?: string
  bridgeExitedBeforeCompletion?: boolean
  completed?: boolean
  output?: string
  quality?: number
  codec?: number
  audioId?: number
  trayConnected?: boolean
  helperVersion?: string
  error?: string
  finishedAt?: string
}

const video = process.argv[2]
if (!/^BV[0-9A-Za-z]{10}$/.test(video ?? ''))
  throw new Error('Pass one explicit BV identifier')
const root = process.env.BEWLY_NATIVE_TEST_ROOT ?? path.resolve('dist/helper-msix')
const output = path.resolve(`dist/live-download-${Date.now()}`)
const data = path.join(output, 'data')
await mkdir(data, { recursive: true })
const localAppData = process.env.LOCALAPPDATA ?? ''
const session = path.join(localAppData, 'BewlyDownload/session.dpapi')
if (existsSync(session))
  await copyFile(session, path.join(data, 'session.dpapi'))
const identity = JSON.parse(await readFile(path.join(root, 'identity.json'), 'utf8')) as {
  extensionId: string
}
const bridge = spawn(path.join(root, 'BewlyDownloadHost.exe'), [
  `chrome-extension://${identity.extensionId}/`,
], { windowsHide: true, env: { ...process.env, BEWLY_DOWNLOAD_DATA: data } })

let buffer = Buffer.alloc(0)
let waiting: ((reply: Reply) => void) | undefined
let requestId = 0
bridge.stderr.on('data', () => {})
bridge.stdout.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk])
  while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
    const size = buffer.readUInt32LE(0)
    const reply = JSON.parse(buffer.subarray(4, size + 4).toString('utf8')) as Reply
    buffer = buffer.subarray(size + 4)
    waiting?.(reply)
    waiting = undefined
  }
})

async function framed<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Native request timed out')), 15000)
    waiting = (reply) => {
      clearTimeout(timeout)
      if (reply.ok)
        resolve(reply.result as T)
      else reject(new Error(reply.error ?? 'Native request failed'))
    }
    const body = Buffer.from(
      JSON.stringify({ requestId: ++requestId, method, params, allowStart: true }),
    )
    const prefix = Buffer.alloc(4)
    prefix.writeUInt32LE(body.length)
    bridge.stdin.write(Buffer.concat([prefix, body]))
  })
}

let descriptor: Descriptor | undefined

async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  descriptor ??= JSON.parse(
    await readFile(path.join(data, 'connection.json'), 'utf8'),
  ) as Descriptor
  const response = await fetch(`http://127.0.0.1:${descriptor.port}/rpc`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${descriptor.token}` },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(20000),
  })
  const reply = (await response.json()) as Reply
  if (!reply.ok)
    throw new Error(reply.error ?? 'RPC failed')
  return reply.result as T
}

const report: LiveReport = { startedAt: new Date().toISOString(), video: video as string, isolated: true }
try {
  const health = await framed<Health>('health')
  assert.equal(health.protocol, 2)
  await framed('configure', {
    directory: path.join(output, 'videos'),
    maxConcurrent: 1,
    soundTip: false,
    shutdown: false,
    listenClipboard: false,
  })
  const info = await framed<VideoInfo>('inspect', { video })
  const [task] = await framed<TaskItem[]>('stageTasks', {
    info,
    cids: [info.pages[0].cid],
    options: { quality: 16, codec: 'avc', audioQuality: '192' },
  })
  assert.equal(task.status, 'pending')
  await framed('batchAction', { ids: [task.id], action: 'start' })
  const bridgeExited = new Promise<number | null>(resolve =>
    bridge.once('exit', code => resolve(code)),
  )
  bridge.stdin.end()
  assert.equal(await Promise.race([bridgeExited, delay(5000).then(() => -1)]), 0)
  report.bridgeExitedAt = new Date().toISOString()
  const afterExit = await rpc<QueryResult>('queryTasks')
  report.statusAtBridgeExit = afterExit.items.find(item => item.id === task.id)?.status
  report.bridgeExitedBeforeCompletion = report.statusAtBridgeExit !== 'completed'
  assert.ok(
    ['queued', 'resolving', 'downloading', 'muxing', 'postprocessing'].includes(
      report.statusAtBridgeExit ?? '',
    ),
    'Download must still be active after the bridge exits',
  )
  for (let attempt = 0; attempt < 180; attempt++) {
    const query = await rpc<QueryResult>('queryTasks')
    const current = query.items.find(item => item.id === task.id)
    if (current?.status === 'failed')
      throw new Error(current.error ?? 'Download failed')
    if (current?.status === 'completed') {
      assert.ok(existsSync(current.output ?? ''))
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
  if (!report.completed)
    throw new Error('Live download did not finish within 180 seconds')
  const active = await rpc<Health>('health')
  report.trayConnected = active.lastTrayContact > 0
  assert.ok(report.trayConnected, 'The real Windows tray must authenticate to the isolated service')
  report.helperVersion = active.version
}
catch (error) {
  report.completed = false
  report.error = String((error as Error).message).replace(/https?:\/\/\S+/g, (value) => {
    try {
      return new URL(value).hostname
    }
    catch {
      return '[url]'
    }
  })
  process.exitCode = 1
}
finally {
  await rpc('desktopAction', { action: 'exit' }).catch(() => {})
  bridge.kill()
  for (let attempt = 0; attempt < 30 && existsSync(path.join(data, 'connection.json')); attempt++)
    await delay(200)
  await unlink(path.join(data, 'session.dpapi')).catch(() => {})
  report.finishedAt = new Date().toISOString()
  await writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
