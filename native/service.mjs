import { spawn, spawnSync } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

import { Aria2, Bilibili, DownloadQueue, publicTask, TaskStore, VERSION } from './core.mjs'
import { outputLocation, validateOptions } from './formats.mjs'
import { desktop, ToolJobs } from './tools.mjs'
import { LegacyMigration } from './migration.mjs'
import { CompletionPolicy } from './completion.mjs'
import { ServiceLifetime } from './lifetime.mjs'
import { writeUiSnapshot } from './snapshot.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))
export const dataDirectory = process.env.BEWLY_DOWNLOAD_DATA || path.join(process.env.LOCALAPPDATA || root, 'BewlyDownload')

export function cryptSession(mode, input) {
  const result = spawnSync(path.join(root, 'BewlyDownloadHost.exe'), [mode], { input, windowsHide: true, encoding: 'utf8', maxBuffer: 128 * 1024 })
  if (result.status !== 0 || result.error) throw new Error('无法保护本地登录信息，请重新安装下载助手')
  return result.stdout.trim()
}

export async function startService() {
  mkdirSync(dataDirectory, { recursive: true })
  const lockPath = path.join(dataDirectory, 'service.lock')
  try {
    const lock = openSync(lockPath, 'wx')
    writeFileSync(lock, String(process.pid))
    const { closeSync } = await import('node:fs'); closeSync(lock)
  }
  catch {
    const pid = Number(readFileSync(lockPath, 'utf8'))
    try { process.kill(pid, 0) } catch { unlinkSync(lockPath); return startService() }
    if (process.env.BEWLY_DOWNLOAD_MODE !== 'on-demand') {
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          const existing = JSON.parse(readFileSync(path.join(dataDirectory, 'connection.json'), 'utf8'))
          const response = await fetch(`http://127.0.0.1:${existing.port}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${existing.token}` }, body: JSON.stringify({ method: 'desktopAction', params: { action: 'keepRunning' } }), signal: AbortSignal.timeout(1000) })
          if ((await response.json()).ok) return
        } catch {}
        try { process.kill(pid, 0) } catch { return startService() }
        await delay(100)
      }
      throw new Error('无法切换为手动后台模式')
    }
    return
  }
  const descriptor = path.join(dataDirectory, 'connection.json')
  const sessionPath = path.join(dataDirectory, 'session.dpapi')
  let cookie = ''
  if (existsSync(sessionPath)) { try { cookie = cryptSession('--unprotect', readFileSync(sessionPath, 'utf8')) } catch { /* Browser can supply a fresh session. */ } }
  const token = randomBytes(32).toString('hex')
  const bin = path.join(root, 'bin')
  const store = new TaskStore(dataDirectory)
  const bilibili = new Bilibili(() => cookie)
  const aria2 = new Aria2(bin)
  const queue = new DownloadQueue({ store, bilibili, aria2, bin, dataDirectory })
  const tools = new ToolJobs({ store, queue, root, bilibili })
  const migration = new LegacyMigration({ store, dataDirectory })
  const policy = new CompletionPolicy()
  const lifetime = new ServiceLifetime(process.env.BEWLY_DOWNLOAD_MODE)
  let activeRequests = 0
  queue.onStarted = task => policy.started(task)
  queue.onCompleted = () => policy.finished()
  let lastTrayContact = 0
  let tray
  let housekeeping
  const headless = process.env.BEWLY_DOWNLOAD_HEADLESS === '1'
  const runtime = () => lifetime.snapshot(!!(queue.running.size || tools.running.size || activeRequests || policy.due), store.settings().idleExitMinutes)
  const ensureTray = () => {
    if (headless || (tray && tray.exitCode === null)) return
    tray = spawn(path.join(root, 'BewlyDownloadHost.exe'), ['--tray'], { detached: true, windowsHide: true, stdio: 'ignore' })
    tray.once('error', () => { tray = undefined })
    tray.unref()
  }
  const begin = () => { policy.begin(store.list()); lifetime.touch() }
  const healthInfo = () => ({ version: VERSION, protocol: 2, storageError: queue.storageError, lastTrayContact, capabilities: ['on-demand', 'pending', 'batch', 'audio-highest', 'formats', 'naming', 'collections', 'tools', 'migration', 'tray'], settings: store.settings(), engineInstalled: existsSync(path.join(bin, 'aria2c.exe')) && existsSync(path.join(bin, 'ffmpeg.exe')) })
  let snapshotTimer
  const saveSnapshot = () => {
    clearTimeout(snapshotTimer)
    try { writeUiSnapshot(dataDirectory, healthInfo(), store.list(), store.query({ pageSize: 1 }).counts) } catch { /* A UI cache failure must not fail a download. */ }
  }
  const scheduleSnapshot = () => { clearTimeout(snapshotTimer); snapshotTimer = setTimeout(saveSnapshot, 250) }
  for (const method of ['put', 'remove', 'settings']) {
    const original = store[method].bind(store)
    store[method] = (...args) => {
      const result = original(...args)
      if (method !== 'settings' || args.length) scheduleSnapshot()
      return result
    }
  }
  const addTasks = async (params, start) => {
    if (start) begin()
    return queue.enqueue(params.info || await bilibili.inspect(params.video), params.cids, params.options, params.prepared || {}, start).map(publicTask)
  }
  const handlers = {
    health: async () => healthInfo(),
    configure: async params => { const settings = store.settings(params); queue.pump(); return settings },
    inspect: async params => bilibili.inspect(params.video),
    expandLink: async params => bilibili.expand(params.video),
    createTasks: async params => addTasks(params, true),
    stageTasks: async params => addTasks(params, false),
    listTasks: async () => store.list().slice(0, 200).map(publicTask),
    queryTasks: async params => ({ ...store.query(params), storageError: queue.storageError }),
    batchAction: async params => {
      if (['start', 'resume', 'retry'].includes(params.action)) begin()
      if (!params.all) return queue.batch(params.ids, params.action, params.options)
      const statuses = { pending: ['pending'], active: ['queued', 'resolving', 'downloading', 'paused'], failed: ['failed', 'cancelled'], completed: ['completed'] }[params.all]
      if (!statuses) throw new Error('无效批量范围')
      const ids = store.list().filter(task => statuses.includes(task.status)).map(task => task.id)
      let processed = 0
      const errors = []
      for (let offset = 0; offset < ids.length; offset += 200) {
        const batch = await queue.batch(ids.slice(offset, offset + 200), params.action, params.options)
        processed += batch.results.length
        errors.push(...batch.errors)
      }
      return { processed, errors: errors.slice(0, 100), errorCount: errors.length }
    },
    taskAction: async params => { if (['start', 'resume', 'retry'].includes(params.action)) begin(); return publicTask(await queue.action(params.id, params.action, params.prepared)) },
    previewPath: async params => {
      const directory = params.directory ?? store.settings().directory
      if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.length > 220) throw new Error('保存目录需要使用绝对路径，且长度不能超过 220')
      return outputLocation({ ...params.task, directory, options: validateOptions(params.options), createdAt: params.task?.createdAt || new Date().toISOString() })
    },
    tool: async params => tools.request(params),
    migrationPreview: async params => migration.preview(params),
    migrationImport: async params => { const result = migration.import(params); queue.pump(); return result },
    taskFile: async params => {
      if (!['play', 'reveal', 'folder'].includes(params.action)) throw new Error('无效文件操作')
      const task = store.get(params.id)
      if (!task && params.action !== 'folder') throw new Error('任务不存在')
      const file = task?.output || Object.values(task?.artifacts || {})[0]
      if (task && !file && !(params.action === 'folder' && task.legacyPath)) throw new Error('任务没有输出文件')
      const target = params.action === 'folder' ? (task?.legacyPath || (file ? path.dirname(file) : store.settings().directory)) : file
      return desktop(root, '--open', { kind: params.action, path: target })
    },
    desktopState: async () => {
      lastTrayContact = Date.now()
      const counts = store.query({ pageSize: 1 }).counts, settings = store.settings()
      return { exiting: closing, mode: lifetime.mode, pending: counts.pending, active: counts.active, completed: policy.completed, tray: settings.tray, soundTip: settings.soundTip, listenClipboard: settings.listenClipboard, shutdownDue: policy.due }
    },
    desktopAction: async params => {
      if (params.action === 'keepRunning') { lifetime.manual(); ensureTray(); return { mode: 'manual' } }
      if (params.action === 'cancelShutdown') { policy.cancel(); return { cancelled: true } }
      if (params.action === 'exit') { setTimeout(close, 200); return { exiting: true } }
      if (!['start', 'pause'].includes(params.action)) throw new Error('无效托盘操作')
      const all = params.action === 'start' ? 'pending' : 'active'
      return handlers.batchAction({ action: params.action, all })
    },
    clipboardVideo: async params => {
      if (!store.settings().listenClipboard) throw new Error('剪贴板监听未启用')
      const info = await bilibili.inspect(params.video)
      return addTasks({ info, cids: [info.pages[0].cid], options: store.settings().defaultOptions || {} }, false)
    },
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store')
    const bearer = Buffer.from(request.headers.authorization || '')
    const expected = Buffer.from(`Bearer ${token}`)
    if (bearer.length !== expected.length || !timingSafeEqual(bearer, expected) || request.headers.origin) {
      response.writeHead(403).end(JSON.stringify({ ok: false, error: 'Forbidden' })); return
    }
    if (request.method !== 'POST' || request.url !== '/rpc') { response.writeHead(404).end('{}'); return }
    try {
      let body = ''
      for await (const chunk of request) {
        body += chunk
        if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error('请求过大')
      }
      const { method, params = {}, session } = JSON.parse(body)
      if (!Object.hasOwn(handlers, method)) throw new Error('未知下载操作')
      if (closing && method !== 'desktopState') { response.end(JSON.stringify({ ok: false, code: 'SERVICE_STOPPING', error: '下载助手正在空闲退出' })); return }
      if (!['health', 'queryTasks', 'listTasks', 'desktopState'].includes(method) && !(method === 'tool' && params.op === 'status')) lifetime.touch()
      if (session !== undefined) {
        if (typeof session !== 'string' || session.length > 32768 || /[\r\n]/.test(session)) throw new Error('无效登录信息')
        cookie = session
        if (cookie) writeFileSync(sessionPath, cryptSession('--protect', cookie), { mode: 0o600 })
        else if (existsSync(sessionPath)) unlinkSync(sessionPath)
      }
      activeRequests++
      let result
      try { result = await handlers[method](params) } finally { activeRequests-- }
      response.end(JSON.stringify({ ok: true, result, runtime: runtime() }))
    }
    catch (error) { response.end(JSON.stringify({ ok: false, error: error.message })) }
  })
  server.requestTimeout = 30000
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  writeFileSync(descriptor, JSON.stringify({ port: server.address().port, token, pid: process.pid }), { mode: 0o600 })
  queue.pump()
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    clearInterval(housekeeping)
    await tools.close(); await queue.close()
    saveSnapshot()
    if (tray && tray.exitCode === null) {
      await Promise.race([new Promise(resolve => tray.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3500))])
      if (tray.exitCode === null) tray.kill()
    }
    server.close(); store.close()
    for (const file of [descriptor, lockPath]) { try { unlinkSync(file) } catch {} }
    process.exit(0)
  }
  process.once('SIGTERM', close); process.once('SIGINT', close)
  ensureTray()
  saveSnapshot()
  housekeeping = setInterval(() => {
    const settings = store.settings(), tasks = store.list()
    const due = policy.evaluate(tasks, settings.shutdown && tools.running.size === 0)
    if (due && due <= Date.now() && !headless) {
      policy.cancel()
      const shutdown = spawn('shutdown.exe', ['/s', '/t', '0'], { windowsHide: true, stdio: 'ignore' })
      shutdown.once('error', () => {})
    }
    const state = runtime()
    if (state.exitAt && Date.now() >= state.exitAt) close()
  }, 1000)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startService().catch(error => { console.error(error.message); process.exitCode = 1 })
}
