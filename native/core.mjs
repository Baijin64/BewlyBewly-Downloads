import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { mkdir, rename, rm, stat, writeFile, open, unlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'

import { safeName, validateOptions, outputLocation, selectStreams, toSrt, toAss, toNfo } from './formats.mjs'
export { safeName, validateOptions, toSrt } from './formats.mjs'

export const VERSION = '0.2.6'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
const activeStates = new Set(['resolving', 'downloading', 'muxing', 'postprocessing'])
export const defaults = { directory: path.join(homedir(), 'Downloads', 'Bilibili'), maxConcurrent: 2 }
function spawnMediaTool(bin, name, args, options) {
  return spawn(path.join(path.dirname(bin), 'BewlyDownloadHost.exe'), ['--run-tool', name, ...args], options)
}

export function videoId(value) {
  if (typeof value !== 'string') throw new Error('缺少视频链接')
  if (/^BV[0-9A-Za-z]{10}$/.test(value)) return value
  if (/^av[1-9]\d{0,15}$/i.test(value)) return 'av' + value.slice(2)
  const url = new URL(value)
  if (url.protocol !== 'https:' || !['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(url.hostname))
    throw new Error('请使用 B 站普通视频的 BV 链接')
  const match = /^\/video\/(BV[0-9A-Za-z]{10}|av[1-9]\d{0,15})(?:\/|$)/i.exec(url.pathname)
  if (/^\/(?:list\/watchlater|watchlater)(?:\/|$)/.test(url.pathname) && /^BV[0-9A-Za-z]{10}$/.test(url.searchParams.get('bvid') || '')) return url.searchParams.get('bvid')
  if (!match) throw new Error('当前版本支持普通视频及分 P，暂不支持直播或番剧')
  return match[1]
}

export function mediaUrl(value) {
  const url = new URL(value.startsWith('//') ? `https:${value}` : value)
  if (url.protocol === 'http:') url.protocol = 'https:'
  const knownDomain = ['bilivideo.com', 'bilivideo.cn', 'bilivideo.net', 'hdslb.com', 'bilibili.com'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))
  const overseasBilibiliCdn = /^upos-[a-z0-9-]+\.akamaized\.net$/.test(url.hostname)
  if (url.protocol !== 'https:' || !(knownDomain || overseasBilibiliCdn))
    throw new Error(`视频接口返回了不受支持的媒体地址（${url.hostname}）`)
  return url.href
}

export function validatePrepared(value) {
  if (!value || typeof value !== 'object') throw new Error('缺少视频解析结果')
  const stream = input => {
    if (!input) return null
    if (!Array.isArray(input.urls) || !input.urls.length || input.urls.length > 10) throw new Error('无效媒体列表')
    return { urls: input.urls.map(mediaUrl), quality: Number(input.quality) || 0, id: Number(input.id || input.quality) || 0, codec: Number(input.codec) || 0, codecs: String(input.codecs || '').slice(0, 100), bandwidth: Number(input.bandwidth) || 0 }
  }
  const subtitleTracks = Array.isArray(value.subtitleTracks) ? value.subtitleTracks.slice(0, 10).map(track => ({ url: mediaUrl(track.url), language: safeName(track.language).slice(0, 30) })) : undefined
  return { video: stream(value.video), audio: stream(value.audio), subtitleTracks, preparedAt: Date.now() }
}

export function validateInfo(info) {
  videoId(info?.bvid)
  if (typeof info.title !== 'string' || !info.title || info.title.length > 500 || !Array.isArray(info.pages) || !info.pages.length || info.pages.length > 10000) throw new Error('无效视频信息')
  const pages = info.pages.map(p => {
    if (!Number.isSafeInteger(p.cid) || p.cid <= 0 || !Number.isSafeInteger(p.page) || typeof p.title !== 'string' || p.title.length > 500) throw new Error('无效分 P 信息')
    return { cid: p.cid, page: p.page, title: p.title, duration: Number(p.duration) || 0 }
  })
  return { bvid: info.bvid, title: info.title, author: String(info.author || '').slice(0, 200), cover: info.cover ? mediaUrl(info.cover) : '', uid: Number(info.uid) || 0, pubdate: Number(info.pubdate) || 0, description: String(info.description || '').slice(0, 20000), pages, ...(info.group && typeof info.group.title === 'string' ? { group: { title: info.group.title.slice(0, 300), index: Number(info.group.index) || 1 } } : {}) }
}

export function publicTask(task) {
  const { prepared, ...result } = task
  return result
}

export class TaskStore {
  constructor(directory) {
    mkdirSync(directory, { recursive: true })
    this.db = new DatabaseSync(path.join(directory, 'downloads.sqlite'))
    const version = this.db.prepare('PRAGMA user_version').get().user_version
    const existing = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get()
    if (existing && version < 2) {
      const backup = path.join(directory, 'downloads.pre-v2-' + Date.now() + '.sqlite')
      this.db.exec("VACUUM INTO '" + backup.replace(/'/g, "''") + "'")
    }
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, data TEXT NOT NULL)')
    this.db.exec("CREATE INDEX IF NOT EXISTS task_status ON tasks(json_extract(data,'$.status')); PRAGMA user_version=2")
    for (const task of this.list()) {
      if (activeStates.has(task.status)) this.put({ ...task, status: 'queued', speed: 0, error: '', prepared: undefined })
    }
  }

  list() { return this.db.prepare('SELECT data FROM tasks ORDER BY rowid DESC').all().map(row => JSON.parse(row.data)) }
  get(id) { const row = this.db.prepare('SELECT data FROM tasks WHERE id = ?').get(id); return row ? JSON.parse(row.data) : undefined }
  put(task) {
    task.updatedAt = new Date().toISOString()
    this.db.prepare('INSERT INTO tasks(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(task.id, JSON.stringify(task))
    return task
  }

  remove(id) { this.db.prepare('DELETE FROM tasks WHERE id=?').run(id) }
  query({ tab = 'all', search = '', page = 1, pageSize = 50 } = {}) {
    const groups = { pending: ['pending'], active: ['queued', 'resolving', 'downloading', 'paused', 'muxing', 'postprocessing'], completed: ['completed'], failed: ['failed', 'cancelled'] }
    if (tab !== 'all' && !groups[tab]) throw new Error('无效任务分类')
    page = Math.max(1, Number(page) || 1); pageSize = Math.max(1, Math.min(100, Number(pageSize) || 50))
    const where = [], params = []
    if (groups[tab]) { where.push("json_extract(data,'$.status') IN (" + groups[tab].map(() => '?').join(',') + ')'); params.push(...groups[tab]) }
    if (search) { where.push("(json_extract(data,'$.title') LIKE ? ESCAPE '\\' OR json_extract(data,'$.part') LIKE ? ESCAPE '\\' OR json_extract(data,'$.bvid') LIKE ? ESCAPE '\\')"); const term = '%' + String(search).slice(0, 200).replace(/[\\%_]/g, '\\$&') + '%'; params.push(term, term, term) }
    const filter = where.length ? ' WHERE ' + where.join(' AND ') : ''
    const total = this.db.prepare('SELECT COUNT(*) AS total FROM tasks' + filter).get(...params).total
    const items = this.db.prepare('SELECT data FROM tasks' + filter + ' ORDER BY rowid DESC LIMIT ? OFFSET ?').all(...params, pageSize, (page - 1) * pageSize).map(row => publicTask(JSON.parse(row.data)))
    const counts = { pending: 0, active: 0, completed: 0, failed: 0 }
    for (const row of this.db.prepare("SELECT json_extract(data,'$.status') AS status, COUNT(*) AS count FROM tasks GROUP BY status").all()) {
      for (const [group, statuses] of Object.entries(groups)) if (statuses.includes(row.status)) counts[group] += row.count
    }
    return { items, total, page, pageSize, counts }
  }

  settings(value) {
    const row = this.db.prepare('SELECT data FROM settings WHERE id=1').get()
    const current = { ...defaults, soundTip: true, shutdown: false, listenClipboard: false, idleExitMinutes: 0, tray: true,
      features: { cover: true, audio: true, xml: false, ass: false, nfo: false, srt: false, tools: false },
      ...(row ? JSON.parse(row.data) : {}) }
    if (value) {
      const merged = { ...current, ...value }
      if (typeof merged.directory !== 'string' || !path.isAbsolute(merged.directory) || merged.directory.length > 220) throw new Error('保存目录需要使用绝对路径，且长度不能超过 220')
      const maxConcurrent = Number(merged.maxConcurrent)
      if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 4) throw new Error('同时下载数量应为 1–4')
      const idleExitMinutes = Number(merged.idleExitMinutes)
      if (!Number.isInteger(idleExitMinutes) || idleExitMinutes < 0 || idleExitMinutes > 1440) throw new Error('空闲退出时间应为 0–1440 分钟')
      const next = { directory: path.resolve(merged.directory), maxConcurrent, soundTip: merged.soundTip === true, shutdown: merged.shutdown === true, listenClipboard: merged.listenClipboard === true, tray: merged.tray !== false, idleExitMinutes,
        features: Object.fromEntries(Object.keys(current.features).map(key => [key, (merged.features || current.features)[key] === true])),
        ...(merged.defaultOptions ? { defaultOptions: validateOptions(merged.defaultOptions) } : {}) }
      this.db.prepare('INSERT INTO settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(next))
      return next
    }
    return current
  }

  close() { this.db.close() }
}

export class Bilibili {
  constructor(cookie = () => '', fetcher = fetch) { this.cookie = cookie; this.fetch = fetcher }
  async api(endpoint, params, signal) {
    const url = new URL(endpoint, 'https://api.bilibili.com')
    url.search = new URLSearchParams(params).toString()
    const response = await this.fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Referer': 'https://www.bilibili.com/', 'Cookie': this.cookie() },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
    })
    if (!response.ok) throw new Error(`B 站接口请求失败（HTTP ${response.status}）`)
    const body = await response.json()
    if (body.code !== 0) throw new Error(`B 站返回 ${body.code}：${body.message || '请求未成功'}`)
    return body.data
  }

  async expand(value, signal) {
    signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000)
    if (typeof value === 'string' && /^https?:\/\/(?:b23\.tv|bili2233\.(?:cn|com))\//.test(value)) {
      let url = new URL(value); url.protocol = 'https:'
      for (let count = 0; count < 5; count++) {
        if (!['b23.tv', 'bili2233.cn', 'bili2233.com'].includes(url.hostname)) break
        if (url.username || url.password || url.port) throw new Error('无效短链接地址')
        const response = await this.fetch(url, { headers: { 'User-Agent': USER_AGENT, Referer: 'https://www.bilibili.com/' }, redirect: 'manual', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) })
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (!location) throw new Error('短链接没有返回视频地址')
        url = new URL(location, url)
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('无效短链接跳转')
        url.protocol = 'https:'
      }
      value = url.href
    }
    videoId(value)
    return value
  }

  async inspect(value, signal) {
    signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000)
    value = await this.expand(value, signal)
    const id = videoId(value)
    const info = await this.api('/x/web-interface/view', id.startsWith('av') ? { aid: id.slice(2) } : { bvid: id }, signal)
    const collection = info.ugc_season ? { id: info.ugc_season.id, title: info.ugc_season.title, sections: (info.ugc_season.sections || []).map(section => ({ id: section.id, title: section.title, videos: (section.episodes || []).map(ep => ({ bvid: ep.bvid, cid: ep.cid, title: ep.title, available: /^BV[0-9A-Za-z]{10}$/.test(ep.bvid || '') && Number(ep.cid) > 0 && ep.arc?.stat?.view !== -1 })) })) } : undefined
    const requestedPage = String(value).startsWith('https:') ? Number(new URL(value).searchParams.get('p')) || 1 : 1
    return { requestedPage, bvid: info.bvid || id, title: info.title, author: info.owner?.name || '', uid: info.owner?.mid || 0, pubdate: info.pubdate || 0, description: info.desc || '', cover: info.pic, pages: info.pages.map(p => ({ cid: p.cid, page: p.page, title: p.part, duration: p.duration })), collection }
  }

  async resolve(task, signal) {
    const data = await this.api('/x/player/playurl', { bvid: task.bvid, cid: String(task.cid), qn: String(task.options.quality || 127), fnval: '4048', fnver: '0', fourk: '1' }, signal)
    const streams = selectStreams(data, task.options)
    return validatePrepared(streams)
  }

  async subtitles(task, signal) {
    const tracks = task.prepared?.subtitleTracks
    const data = tracks ? { subtitle: { subtitles: tracks.map(track => ({ subtitle_url: track.url, lan: track.language })) } } : await this.api('/x/player/v2', { bvid: task.bvid, cid: String(task.cid) }, signal)
    const result = []
    for (const subtitle of data.subtitle?.subtitles || []) {
      if (task.options.subtitleLanguages?.length && !task.options.subtitleLanguages.includes(subtitle.lan)) continue
      const response = await this.fetch(mediaUrl(subtitle.subtitle_url), { signal, headers: { Referer: 'https://www.bilibili.com/' } })
      if (!response.ok) throw new Error(`字幕请求失败（HTTP ${response.status}）`)
      result.push({ language: subtitle.lan, content: toSrt((await response.json()).body || []) })
    }
    return result
  }

  async danmaku(task, signal) {
    const response = await this.fetch('https://comment.bilibili.com/' + Number(task.cid) + '.xml', { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000), headers: { Referer: 'https://www.bilibili.com/' } })
    if (!response.ok) throw new Error('弹幕请求失败（HTTP ' + response.status + '）')
    const text = await response.text()
    if (!/<i[\s>]/.test(text)) throw new Error('接口没有返回 XML 弹幕')
    return text
  }
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

export class Aria2 {
  constructor(bin) { this.bin = bin; this.secret = randomBytes(32).toString('hex'); this.child = null; this.starting = null }
  async ready() {
    if (this.starting) return this.starting
    if (this.child && this.child.exitCode === null) return
    this.starting = (async () => {
      this.port = await freePort()
      this.child = spawnMediaTool(this.bin, 'aria2c', ['--no-conf=true', '--enable-rpc=true', '--rpc-listen-all=false', '--rpc-allow-origin-all=false', `--rpc-listen-port=${this.port}`, `--rpc-secret=${this.secret}`, '--check-certificate=true', '--continue=true', '--auto-file-renaming=false', '--allow-overwrite=true', '--file-allocation=none', '--max-concurrent-downloads=8', '--console-log-level=error', '--summary-interval=0'], { windowsHide: true, stdio: 'ignore' })
      let launchError
      this.child.once('error', error => { launchError = error })
      for (let attempt = 0; attempt < 60; attempt++) {
        if (launchError) throw new Error('无法启动 aria2，请重新安装下载助手')
        try { await this.rpc('getVersion'); return } catch { await delay(100) }
      }
      throw new Error('下载引擎启动超时')
    })().finally(() => { this.starting = null })
    return this.starting
  }

  async rpc(method, ...params) {
    const response = await fetch(`http://127.0.0.1:${this.port}/jsonrpc`, { method: 'POST', signal: AbortSignal.timeout(5000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: `aria2.${method}`, params: [`token:${this.secret}`, ...params] }) })
    const data = await response.json()
    if (data.error) throw new Error(data.error.message)
    return data.result
  }

  close() { this.child?.kill() }
}

export class DownloadQueue {
  constructor({ store, bilibili, aria2, bin, dataDirectory, fetcher = fetch }) {
    Object.assign(this, { store, bilibili, aria2, bin, dataDirectory, fetcher })
    this.running = new Map()
    this.closed = false
    this.storageError = ''
  }

  enqueue(info, cids, options, prepared = {}, start = true) {
    info = validateInfo(info)
    options = validateOptions(options)
    if (!Array.isArray(cids) || !cids.length || cids.length > 10000) throw new Error('请选择 1–10000 个分 P')
    if (cids.some(cid => !info.pages.some(p => p.cid === Number(cid)))) throw new Error('所选分 P 不属于这个视频')
    const plans = Object.fromEntries(Object.entries(prepared).map(([cid, value]) => [cid, validatePrepared(value)]))
    const jobs = []
    const known = this.store.list()
    for (const cid of [...new Set(cids)]) {
      const part = info.pages.find(p => p.cid === Number(cid))
      if (!part) throw new Error('所选分 P 不属于这个视频')
      const directory = this.store.settings().directory
      const duplicate = known.find(t => t.bvid === info.bvid && t.cid === part.cid && t.directory === directory && JSON.stringify(validateOptions(t.options)) === JSON.stringify(options) && !['failed', 'cancelled'].includes(t.status) && (t.status !== 'completed' || (!t.filesDeleted && t.output && existsSync(t.output))))
      if (duplicate) {
        if (start && duplicate.status === 'pending') { duplicate.status = 'queued'; this.store.put(duplicate) }
        jobs.push({ ...duplicate, duplicate: true }); continue
      }
      const job = this.store.put({ id: randomUUID(), bvid: info.bvid, cid: part.cid, title: info.title, part: part.title, page: part.page, pageCount: info.pages.length, duration: part.duration,
        uid: info.uid, pubdate: info.pubdate, description: info.description, group: info.group, author: info.author, cover: info.cover, options, directory, prepared: plans[part.cid], status: start ? 'queued' : 'pending', progress: 0, speed: 0, error: '', createdAt: new Date().toISOString() })
      known.push(job); jobs.push(job)
    }
    this.pump()
    return jobs
  }

  update(id, changes) { const task = this.store.get(id); return this.store.put({ ...task, ...changes }) }
  pump() {
    if (this.closed || this.storageError) return
    for (const task of this.store.list().reverse()) {
      if (this.running.size >= this.store.settings().maxConcurrent) break
      if (task.status !== 'queued' || this.running.has(task.id)) continue
      const execution = { controller: new AbortController(), gids: new Set() }
      this.running.set(task.id, execution)
      this.onStarted?.(task)
      this.run(task, execution).catch(error => {
        if (!execution.controller.signal.aborted) {
          try { this.update(task.id, { status: 'failed', speed: 0, error: error.message }) }
          catch { this.storageError = '无法保存任务状态，请检查磁盘剩余空间及目录权限，然后重启助手' }
        }
      }).finally(() => { this.running.delete(task.id); this.pump() })
    }
  }

  async action(id, action, prepared) {
    const task = this.store.get(id)
    if (!task) throw new Error('任务不存在')
    if (action === 'start') {
      if (task.status !== 'pending') throw new Error('任务不在待下载列表')
      this.update(id, { status: 'queued', error: '' }); this.pump()
    }
    else if (action === 'remove' || action === 'deleteFiles') {
      if (activeStates.has(task.status) || task.status === 'queued') throw new Error('请先暂停任务再移除')
      if (action === 'deleteFiles') {
        if (task.legacyPath && !task.output) throw new Error('旧版记录没有可删除的已核验文件，仅可移除记录')
        for (const file of new Set([task.output, ...Object.values(task.artifacts || {})].filter(Boolean))) {
          const relative = path.relative(path.resolve(task.directory), path.resolve(file))
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('文件路径超出任务保存目录')
          await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error })
        }
        return this.update(id, { output: undefined, artifacts: {}, filesDeleted: true })
      }
      while (this.running.has(id)) await delay(20)
      const work = path.resolve(this.dataDirectory, 'partial', id)
      if (path.dirname(work) === path.resolve(this.dataDirectory, 'partial')) await rm(work, { recursive: true, force: true }).catch(() => {})
      this.store.remove(id)
      return { id, removed: true }
    }
    else if (action === 'pause' || action === 'cancel') {
      if (['completed', 'cancelled'].includes(task.status)) return task
      if (['muxing', 'postprocessing'].includes(task.status)) throw new Error('正在合并或保存附件，请等待当前步骤结束')
      this.update(id, { status: action === 'pause' ? 'paused' : 'cancelled', speed: 0 })
      const execution = this.running.get(id)
      execution?.controller.abort()
      if (execution) await Promise.allSettled([...execution.gids].map(gid => this.aria2.rpc('forceRemove', gid)))
    }
    else if (action === 'resume' || action === 'retry') {
      if (!['paused', 'failed', 'cancelled'].includes(task.status)) throw new Error('任务当前不能恢复')
      this.update(id, { status: 'queued', error: '', ...(prepared ? { prepared: validatePrepared(prepared) } : {}) })
      this.pump()
    }
    else throw new Error('未知任务操作')
    return this.store.get(id)
  }

  async batch(ids, action, options) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 200) throw new Error('每批请选择 1–200 个任务')
    const results = [], errors = []
    for (const id of [...new Set(ids)]) {
      try {
        if (action === 'edit') {
          const task = this.store.get(id)
          if (!task || !['pending', 'failed'].includes(task.status)) throw new Error('只能修改待下载或失败任务')
          if (Object.keys(task.artifacts || {}).length || task.output) throw new Error('已有输出文件的任务不可改配置，请重新添加')
          results.push(publicTask(this.update(id, { options: validateOptions(options), prepared: undefined })))
        }
        else results.push(publicTask(await this.action(id, action)))
      } catch (error) { errors.push({ id, error: error.message }) }
    }
    return { results, errors }
  }

  async transfer(task, urls, name, directory, execution) {
    const { signal } = execution.controller
    signal.throwIfAborted()
    const gid = await this.aria2.rpc('addUri', urls, { dir: directory, out: name, split: '4', 'max-connection-per-server': '4', 'min-split-size': '10M', 'max-tries': '5', 'retry-wait': '2', header: [`User-Agent: ${USER_AGENT}`, 'Referer: https://www.bilibili.com/'] })
    execution.gids.add(gid)
    try {
      while (true) {
        signal.throwIfAborted()
        const state = await this.aria2.rpc('tellStatus', gid)
        if (state.status === 'complete') return path.join(directory, name)
        if (state.status === 'error' || state.status === 'removed') {
          const error = new Error(String(state.errorCode) === '9' ? '磁盘空间不足，已保留断点进度' : '下载失败：' + (state.errorMessage || state.errorCode || state.status))
          if (String(state.errorCode) === '9') error.code = 'ENOSPC'
          throw error
        }
        this.update(task.id, { progress: Number(state.totalLength) ? Math.round(Number(state.completedLength) / Number(state.totalLength) * 100) : 0, speed: Number(state.downloadSpeed), stage: name.startsWith('video') ? 'video' : 'audio' })
        await delay(1000, undefined, { signal })
      }
    }
    finally {
      await this.aria2.rpc('forceRemove', gid).catch(() => {})
      await this.aria2.rpc('removeDownloadResult', gid).catch(() => {})
      execution.gids.delete(gid)
    }
  }

  async saveArtifact(task, key, target, producer, signal) {
    const known = this.store.get(task.id).artifacts || {}
    if (known[key] && existsSync(known[key]) && (await stat(known[key])).size > 0) return known[key]
    if (existsSync(target)) throw new Error('同名文件已存在，保留了原文件：' + path.basename(target))
    await mkdir(path.dirname(target), { recursive: true })
    const temporary = path.join(path.dirname(target), '.bewly-' + task.id + '-' + safeName(key) + '.part' + path.extname(target))
    try {
      await producer(temporary)
      signal.throwIfAborted()
      if (!(await stat(temporary)).size) throw new Error('输出文件为空，未保存为完成文件')
      const reserved = await open(target, 'wx'); await reserved.close()
      try { await rename(temporary, target) } catch (error) { await unlink(target).catch(() => {}); throw error }
      const current = this.store.get(task.id)
      this.update(task.id, { artifacts: { ...current.artifacts, [key]: target }, output: current.output || target })
      return target
    } finally { await unlink(temporary).catch(() => {}) }
  }

  async ffmpeg(args, signal) {
    await new Promise((resolve, reject) => {
      const child = spawnMediaTool(this.bin, 'ffmpeg', ['-hide_banner', '-nostdin', '-y', ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], signal })
      let stderr = ''
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000) })
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('音视频处理失败（' + code + '）：' + stderr.slice(-500))))
    })
  }

  async run(task, execution) {
    const { signal } = execution.controller
    task = { ...task, options: validateOptions(task.options) }
    const mediaKinds = task.options.outputs.filter(kind => ['video', 'silent', 'audio', 'mp3'].includes(kind))
    const recorded = this.store.get(task.id).artifacts || {}
    if (task.output && existsSync(task.output) && (await stat(task.output)).size > 0 && (!Object.keys(recorded).length || mediaKinds.every(kind => recorded[kind] && existsSync(recorded[kind])))) return this.finish(task, task.output, signal)
    this.update(task.id, { status: 'resolving', error: '', speed: 0 })
    let streams = mediaKinds.length ? (task.prepared && Date.now() - task.prepared.preparedAt < 20 * 60000 ? task.prepared : await this.bilibili.resolve(task, signal)) : {}
    signal.throwIfAborted()
    const location = outputLocation(task, streams)
    if (mediaKinds.length) await this.aria2.ready()
    const work = path.join(this.dataDirectory, 'partial', task.id)
    await mkdir(work, { recursive: true })
    if ((task.actualQuality && (task.actualQuality !== streams.video?.quality || task.actualCodec !== streams.video?.codec)) || (task.actualAudioId && task.actualAudioId !== streams.audio?.id)) {
      for (const name of ['video.m4s', 'video.m4s.aria2', 'audio.m4a', 'audio.m4a.aria2']) await rm(path.join(work, name), { force: true })
    }
    this.update(task.id, { status: 'downloading', actualQuality: streams.video?.quality, actualCodec: streams.video?.codec, actualAudioId: streams.audio?.id })
    const downloadStream = async (kind, source, name) => {
      if (!source) return null
      try { return await this.transfer(task, source.urls, name, work, execution) }
      catch (error) {
        if (signal.aborted || error.code === 'ENOSPC' || execution.refreshed) throw error
        execution.refreshed = true
        const fresh = await this.bilibili.resolve(task, signal)
        const next = fresh[kind]
        if (!next || source.quality !== next.quality || source.codec !== next.codec || (source.id && source.id !== next.id)) throw new Error('媒体规格已变化，请重新添加任务')
        streams = fresh
        return this.transfer(task, next.urls, name, work, execution)
      }
    }
    const video = mediaKinds.some(kind => ['video', 'silent'].includes(kind)) ? await downloadStream('video', streams.video, 'video.m4s') : null
    const audio = mediaKinds.some(kind => ['video', 'audio', 'mp3'].includes(kind)) ? await downloadStream('audio', streams.audio, 'audio.m4a') : null
    signal.throwIfAborted()
    this.update(task.id, { status: 'muxing', progress: 100, speed: 0 })
    for (const kind of mediaKinds) {
      const lossless = streams.audio?.id === 30251 || task.options.audioQuality === 'hires'
      const dolby = streams.audio?.id === 30250 || task.options.audioQuality === 'dolby'
      const extension = kind === 'mp3' ? 'mp3' : kind === 'audio' ? (lossless ? 'flac' : dolby ? 'mka' : 'm4a') : kind === 'video' && (lossless || dolby || streams.video?.quality === 126) ? 'mkv' : 'mp4'
      const suffix = kind === 'silent' ? '.video' : kind === 'audio' && mediaKinds.length > 1 ? '.audio' : ''
      const target = path.join(location.directory, location.basename + suffix + '.' + extension)
      this.update(task.id, { stage: kind })
      await this.saveArtifact(task, kind, target, async temporary => {
        const useVideo = ['video', 'silent'].includes(kind)
        const useAudio = kind !== 'silent'
        if (useVideo && !video) throw new Error('没有所选视频流')
        if (useAudio && !audio) throw new Error('没有所选音频流')
        const args = [...(useVideo ? ['-i', video] : []), ...(useAudio ? ['-i', audio] : []), ...(useVideo ? ['-map', '0:v:0'] : []), ...(useAudio ? ['-map', useVideo ? '1:a:0' : '0:a:0'] : []), ...(kind === 'mp3' ? ['-c:a', 'libmp3lame', '-q:a', '2'] : ['-c', 'copy']), ...(['mp4', 'm4a'].includes(extension) ? ['-movflags', '+faststart'] : []), temporary]
        await this.ffmpeg(args, signal)
      }, signal)
    }
    const current = this.store.get(task.id)
    return this.finish(task, current.output, signal, location)
  }

  async finish(task, target, signal, location) {
    task = { ...task, options: validateOptions(task.options) }
    location ||= target ? { directory: path.dirname(target), basename: path.basename(target, path.extname(target)) } : outputLocation(task)
    this.update(task.id, { status: 'postprocessing', ...(target ? { output: target } : {}) })
    const warnings = []
    const writeAttachment = (key, suffix, content) => this.saveArtifact(task, key, path.join(location.directory, location.basename + suffix), temporary => writeFile(temporary, content), signal)
    const attempt = async (label, action) => {
      try { await action() } catch (error) { if (signal.aborted) throw error; warnings.push(label + '：' + error.message) }
    }
    if (task.options.outputs.includes('cover') && task.cover) await attempt('封面', async () => {
      const response = await this.fetcher(mediaUrl(task.cover), { signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      const type = response.headers?.get('content-type') || ''
      const extension = type.includes('png') ? '.png' : type.includes('webp') ? '.webp' : '.jpg'
      await writeAttachment('cover', extension, Buffer.from(await response.arrayBuffer()))
    })
    if (task.options.outputs.some(kind => ['xml', 'ass'].includes(kind))) await attempt('弹幕', async () => {
      const xml = await this.bilibili.danmaku(task, signal)
      if (task.options.outputs.includes('xml')) await writeAttachment('xml', '.xml', xml)
      if (task.options.outputs.includes('ass')) await writeAttachment('ass', '.ass', toAss(xml))
    })
    if (task.options.outputs.includes('srt')) await attempt('字幕', async () => {
      const subtitles = await this.bilibili.subtitles(task, signal)
      if (!subtitles.length) throw new Error('这个视频没有所选语言的可用字幕')
      for (const subtitle of subtitles) await writeAttachment('srt-' + subtitle.language, '.' + safeName(subtitle.language) + '.srt', subtitle.content)
    })
    if (task.options.outputs.includes('nfo')) await attempt('NFO', () => writeAttachment('nfo', '.nfo', toNfo(task)))
    signal.throwIfAborted()
    const current = this.store.get(task.id)
    if (!current.output && !Object.keys(current.artifacts || {}).length) throw new Error(warnings.join('；') || '没有生成任何输出文件')
    this.update(task.id, { status: 'completed', progress: 100, stage: '', speed: 0, warnings, prepared: undefined, completedAt: new Date().toISOString() })
    this.onCompleted?.(this.store.get(task.id))
    const work = path.resolve(this.dataDirectory, 'partial', task.id)
    if (path.dirname(work) === path.resolve(this.dataDirectory, 'partial')) await rm(work, { recursive: true, force: true }).catch(() => {})
  }

  async close() {
    this.closed = true
    for (const [id, execution] of this.running) { this.update(id, { status: 'queued', speed: 0 }); execution.controller.abort() }
    while (this.running.size) await delay(20)
    this.aria2.close()
  }
}
