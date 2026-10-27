import { mkdirSync, readFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { VERSION } from './core.mjs'
import { platform } from './platform/index.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))
const dataDirectory = platform.dataDirectory()
const methods = new Set(['health', 'configure', 'inspect', 'expandLink', 'createTasks', 'stageTasks', 'listTasks', 'queryTasks', 'taskAction', 'batchAction', 'previewPath', 'taskFile', 'tool', 'migrationPreview', 'migrationImport'])
let connecting
let retryAfter = 0
let servicePid
let dispatching = 0
function writeReply(result) {
  const payload = Buffer.from(JSON.stringify(result))
  const prefix = Buffer.alloc(4); prefix.writeUInt32LE(payload.length)
  process.stdout.write(Buffer.concat([prefix, payload]))
}
const serviceWatcher = setInterval(() => {
  if (!servicePid || dispatching || isRunning(servicePid)) return
  try { writeReply({ event: 'serviceStopped', snapshot: JSON.parse(readFileSync(path.join(dataDirectory, 'ui-snapshot.json'), 'utf8')) }) } catch {}
  clearInterval(serviceWatcher)
  process.stdin.destroy()
  process.stdout.end()
  process.exitCode = 0
}, 1000)
serviceWatcher.unref()

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

async function connect(allowStart) {
  if (connecting) return connecting
  connecting = startOrConnect(allowStart).finally(() => { connecting = undefined })
  return connecting
}

async function startOrConnect(allowStart) {
  const probe = async () => {
    const descriptor = JSON.parse(readFileSync(path.join(dataDirectory, 'connection.json'), 'utf8'))
    const response = await rpc(descriptor, { method: 'health' }, 1000)
    if (!response.ok) throw new Error('下载服务未就绪')
    servicePid = descriptor.pid
    return descriptor
  }
  try { return await probe() } catch {}
  if (!allowStart) { const error = new Error('下载助手当前未运行'); error.code = 'SERVICE_OFFLINE'; throw error }
  mkdirSync(dataDirectory, { recursive: true })
  if (Date.now() < retryAfter) throw new Error('下载助手暂时未就绪，请稍后重试；不会重复启动进程')
  let startedPid
  for (let attempt = 0; attempt < 100; attempt++) {
    try { return await probe() } catch {}
    let serviceRunning = false
    try { serviceRunning = isRunning(Number(readFileSync(path.join(dataDirectory, 'service.lock'), 'utf8'))) } catch {}
    if (!startedPid && !serviceRunning) {
      startedPid = platform.startService({ root, dataDirectory, mode: 'on-demand' }).pid
    }
    await delay(100)
  }
  retryAfter = Date.now() + 15000
  if (startedPid && isRunning(startedPid)) process.kill(startedPid)
  throw new Error('本地下载服务启动超时，' + platform.installHint)
}

async function dispatch(message) {
  if (message.method === 'bootstrapStatus') return { ok: true, result: { connectorVersion: VERSION, runtime: { ready: true, version: process.versions.node, architecture: process.arch, executable: process.execPath } } }
  if (!methods.has(message.method)) throw new Error('未知下载操作')
  const descriptor = await connect(message.allowStart === true)
  const result = await rpc(descriptor, message, 60000)
  if (result.code === 'SERVICE_STOPPING' && message.allowStart === true) {
    await delay(200)
    return rpc(await connect(true), message, 60000)
  }
  return result
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
        dispatching++
        try { result = await dispatch(message) } finally { dispatching-- }
      } catch (error) {
        result = { ok: false, error: error.message, ...(error.code ? { code: error.code } : {}) }
        if (error.code === 'SERVICE_OFFLINE') {
          try { result.snapshot = JSON.parse(readFileSync(path.join(dataDirectory, 'ui-snapshot.json'), 'utf8')) } catch {}
        }
      }
      if (requestId !== undefined) result = { ...result, requestId }
      let payload = Buffer.from(JSON.stringify(result))
      if (payload.length > 1000000) payload = Buffer.from(JSON.stringify({ ok: false, error: '任务列表过大' }))
      const prefix = Buffer.alloc(4); prefix.writeUInt32LE(payload.length)
      process.stdout.write(Buffer.concat([prefix, payload]))
    })
  }
})
process.stdin.on('end', () => { chain.finally(() => { process.exitCode = pending.length ? 1 : 0; process.stdout.end() }) })
