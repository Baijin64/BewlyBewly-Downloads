import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { VERSION } from './core.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))
const dataDirectory = process.env.BEWLY_DOWNLOAD_DATA || path.join(process.env.LOCALAPPDATA || root, 'BewlyDownload')
const methods = new Set(['health', 'configure', 'inspect', 'expandLink', 'createTasks', 'stageTasks', 'listTasks', 'queryTasks', 'taskAction', 'batchAction', 'previewPath', 'taskFile', 'tool', 'migrationPreview', 'migrationImport'])
let connecting
let retryAfter = 0

function rpc(descriptor, message, timeout) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: descriptor.port, path: '/rpc', method: 'POST', agent: false, headers: { Authorization: `Bearer ${descriptor.token}`, 'Content-Type': 'application/json' } }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
        if (Buffer.byteLength(body) > 1000000) request.destroy(new Error('下载助手回复过大'))
      })
      response.once('error', reject)
      response.once('end', () => { try { resolve(JSON.parse(body)) } catch { reject(new Error('下载助手返回了无效数据')) } })
    })
    request.setTimeout(timeout, () => request.destroy(new Error('下载助手请求超时')))
    request.once('error', reject)
    request.end(JSON.stringify(message))
  })
}

function isRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

async function connect() {
  if (connecting) return connecting
  connecting = startOrConnect().finally(() => { connecting = undefined })
  return connecting
}

async function startOrConnect() {
  mkdirSync(dataDirectory, { recursive: true })
  const probe = async () => {
    const descriptor = JSON.parse(readFileSync(path.join(dataDirectory, 'connection.json'), 'utf8'))
    const response = await rpc(descriptor, { method: 'health' }, 1000)
    if (!response.ok) throw new Error('下载服务未就绪')
    return descriptor
  }
  try { return await probe() } catch {}
  if (Date.now() < retryAfter) throw new Error('下载助手暂时未就绪，请稍后重试；不会重复启动进程')
  let serviceRunning = false
  try { serviceRunning = isRunning(Number(readFileSync(path.join(dataDirectory, 'service.lock'), 'utf8'))) } catch {}
  let startedPid
  if (!serviceRunning) {
    const launch = spawnSync(path.join(root, 'BewlyDownloadHost.exe'), ['--start-service'], { windowsHide: true, encoding: 'utf8', env: process.env, timeout: 10000 })
    if (launch.status !== 0 || launch.error) throw new Error('无法启动独立下载服务，请重新安装助手')
    try { startedPid = JSON.parse(launch.stdout).pid } catch { throw new Error('下载服务启动结果无效') }
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    await delay(100)
    try { return await probe() } catch {}
  }
  retryAfter = Date.now() + 15000
  if (startedPid && isRunning(startedPid)) process.kill(startedPid)
  throw new Error('本地下载服务启动超时，请从开始菜单重新连接下载助手')
}

async function dispatch(message) {
  if (message.method === 'bootstrapStatus') return { ok: true, result: { connectorVersion: VERSION, runtime: { ready: true, version: process.versions.node, architecture: process.arch, executable: process.execPath } } }
  if (!methods.has(message.method)) throw new Error('未知下载操作')
  const descriptor = await connect()
  return rpc(descriptor, message, 60000)
}

// Only framed protocol responses go to stdout; diagnostics belong on stderr.
let pending = Buffer.alloc(0)
let chain = Promise.resolve()
process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk])
  while (pending.length >= 4) {
    const length = pending.readUInt32LE(0)
    if (length > 2 * 1024 * 1024) { process.exitCode = 1; process.stdin.destroy(); return }
    if (pending.length < length + 4) return
    const body = pending.subarray(4, length + 4)
    pending = pending.subarray(length + 4)
    chain = chain.then(async () => {
      let result
      let requestId
      try {
        const message = JSON.parse(body.toString('utf8'))
        requestId = message.requestId
        result = await dispatch(message)
      } catch (error) { result = { ok: false, error: error.message } }
      if (requestId !== undefined) result = { ...result, requestId }
      let payload = Buffer.from(JSON.stringify(result))
      if (payload.length > 1000000) payload = Buffer.from(JSON.stringify({ ok: false, error: '任务列表过大' }))
      const prefix = Buffer.alloc(4); prefix.writeUInt32LE(payload.length)
      process.stdout.write(Buffer.concat([prefix, payload]))
    })
  }
})
process.stdin.on('end', () => { chain.finally(() => { process.exitCode = pending.length ? 1 : 0; process.stdout.end() }) })
