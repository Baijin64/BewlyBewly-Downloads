import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { Aria2, Bilibili, DownloadQueue, publicTask, safeName, TaskStore, toSrt, validateOptions, validatePrepared, videoId } from '../core.mjs'
import { toolPath } from './support/host.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const helper = process.env.BEWLY_NATIVE_TEST_ROOT || path.join(root, 'dist', 'helper-msix')
const identity = JSON.parse(readFileSync(path.join(root, 'native', 'identity.json'), 'utf8'))
const info = { bvid: 'BV1GJ411x7h7', title: 'Test video', author: 'Test', cover: '', pages: [{ cid: 1, page: 1, title: 'Test video', duration: 1 }] }

async function temporary(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'bewly-download-test-'))
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()))
    assert.ok(path.basename(directory).startsWith('bewly-download-test-'))
    const descriptorPath = path.join(directory, 'connection.json')
    if (existsSync(descriptorPath)) {
      const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'))
      try { process.kill(descriptor.pid) } catch {}
      await delay(200)
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })
  return directory
}

test('video identities reject foreign origins, http, and non-video pages', () => {
  assert.equal(videoId(info.bvid), info.bvid)
  assert.equal(videoId(`https://www.bilibili.com/video/${info.bvid}/?p=2`), info.bvid)
  for (const url of [`http://www.bilibili.com/video/${info.bvid}`, `https://www.bilibili.com.evil.test/video/${info.bvid}`, 'https://www.bilibili.com/bangumi/play/ep1', 'file:///C:/data']) assert.throws(() => videoId(url))
})

test('filenames and download options stay within supported values', () => {
  assert.equal(safeName('CON'), '_CON')
  assert.equal(safeName('a/b:c*?. '), 'a_b_c__')
  assert.throws(() => validateOptions({ mode: 'shell' }))
  assert.throws(() => validateOptions({ quality: 9999 }))
  assert.throws(() => validatePrepared({ video: { urls: ['http://127.0.0.1/private'] } }))
  assert.ok(validatePrepared({ audio: { urls: ['https://cdn.bilivideo.com/audio'] } }).audio)
  assert.ok(validatePrepared({ audio: { urls: ['https://upos-hz-mirrorakam.akamaized.net/audio'] } }).audio)
  assert.throws(() => validatePrepared({ audio: { urls: ['https://unrelated.akamaized.net/audio'] } }))
})

test('SRT keeps accurate timestamps and source text', () => {
  assert.equal(toSrt([{ from: 1.234, to: 62.5, content: '字幕' }]), '1\n00:00:01,234 --> 00:01:02,500\n字幕\n')
})

test('SQLite restores interrupted jobs without resuming intentionally paused jobs', async (t) => {
  const directory = await temporary(t)
  let store = new TaskStore(directory)
  store.put({ id: 'active', status: 'downloading', progress: 42 })
  store.put({ id: 'paused', status: 'paused' })
  store.put({ id: 'complete', status: 'completed' })
  store.close()
  store = new TaskStore(directory)
  assert.equal(store.get('active').status, 'queued')
  assert.equal(store.get('active').progress, 42)
  assert.equal(store.get('paused').status, 'paused')
  assert.equal(store.get('complete').status, 'completed')
  store.close()
})

test('invalid batches add nothing and duplicate submissions reuse active tasks', async (t) => {
  const directory = await temporary(t)
  const store = new TaskStore(directory)
  const queue = new DownloadQueue({ store, dataDirectory: directory })
  queue.closed = true
  assert.throws(() => queue.enqueue(info, [1, 999], {}))
  assert.equal(store.list().length, 0)
  const first = queue.enqueue(info, [1], {})
  const second = queue.enqueue(info, [1], {})
  assert.equal(first[0].id, second[0].id)
  assert.equal(store.list().length, 1)
  await queue.action(first[0].id, 'pause')
  assert.equal(store.get(first[0].id).status, 'paused')
  await queue.action(first[0].id, 'resume')
  assert.equal(store.get(first[0].id).status, 'queued')
  assert.equal(publicTask({ id: 'example', prepared: { secretUrl: true } }).prepared, undefined)
  store.close()
})

test('resolver selects the requested quality/codec and reports unavailable quality', async () => {
  const bilibili = new Bilibili(() => 'test=synthetic', async (url, options) => {
    assert.equal(options.headers.Cookie, 'test=synthetic')
    return { ok: true, json: async () => ({ code: 0, data: { dash: { video: [{ id: 80, codecid: 7, bandwidth: 100, baseUrl: 'https://cdn.bilivideo.com/v' }, { id: 80, codecid: 12, bandwidth: 80, baseUrl: 'https://cdn.bilivideo.com/hevc' }], audio: [{ id: 30280, bandwidth: 20, baseUrl: 'https://cdn.bilivideo.com/a' }] } } }) }
  })
  const result = await bilibili.resolve({ ...info, cid: 1, options: validateOptions({ quality: 80, codec: 'hevc' }) })
  assert.equal(result.video.codec, 12)
  await assert.rejects(() => bilibili.resolve({ ...info, cid: 1, options: validateOptions({ quality: 120 }) }), /画质/)
})

test('a completed container survives restart when optional subtitles fail', async (t) => {
  const directory = await temporary(t)
  const output = path.join(directory, 'completed.mp4')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(output, 'synthetic-already-muxed-container')
  const store = new TaskStore(path.join(directory, 'data'))
  const task = store.put({ id: 'recovered', bvid: info.bvid, cid: 1, options: { ...validateOptions({ subtitles: true }) }, directory, output, status: 'queued' })
  const queue = new DownloadQueue({ store, dataDirectory: directory, bilibili: { resolve: async () => { throw new Error('should not re-download completed media') }, subtitles: async () => { throw new Error('subtitle unavailable') } } })
  await queue.run(task, { controller: new AbortController(), gids: new Set() })
  assert.equal(store.get(task.id).status, 'completed')
  assert.match(store.get(task.id).warnings[0], /subtitle unavailable/)
  assert.equal(readFileSync(output, 'utf8'), 'synthetic-already-muxed-container')
  store.close()
})

test('Windows DPAPI round-trips synthetic session data', { skip: !existsSync(path.join(helper, 'BewlyDownloadHost.exe')) }, () => {
  const executable = path.join(helper, 'BewlyDownloadHost.exe')
  const clear = 'SESSDATA=synthetic-test-value'
  const protectedValue = execFileSync(executable, ['--protect'], { input: clear, windowsHide: true, encoding: 'utf8' })
  assert.notEqual(protectedValue, clear)
  assert.equal(execFileSync(executable, ['--unprotect'], { input: protectedValue, windowsHide: true, encoding: 'utf8' }), clear)
})

test('native protocol starts a daemon which survives the bridge exiting', { skip: !existsSync(path.join(helper, 'BewlyDownloadHost.exe')), timeout: 25000 }, async (t) => {
  const directory = await temporary(t)
  const payload = Buffer.from(JSON.stringify({ method: 'health', allowStart: true }))
  const prefix = Buffer.alloc(4); prefix.writeUInt32LE(payload.length)
  const child = spawn(path.join(helper, 'BewlyDownloadHost.exe'), [`chrome-extension://${identity.extensionId}/`], { env: { ...process.env, BEWLY_DOWNLOAD_DATA: directory, BEWLY_DOWNLOAD_HEADLESS: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const chunks = []
  let errors = ''
  child.stdout.on('data', chunk => chunks.push(chunk))
  child.stderr.on('data', chunk => { errors += chunk })
  child.stdin.end(Buffer.concat([prefix, payload]))
  const code = await new Promise(resolve => child.once('exit', resolve))
  assert.equal(code, 0, errors)
  const response = Buffer.concat(chunks)
  assert.equal(response.readUInt32LE(0), response.length - 4)
  const reply = JSON.parse(response.subarray(4).toString('utf8'))
  assert.equal(reply.ok, true)
  const descriptor = JSON.parse(readFileSync(path.join(directory, 'connection.json'), 'utf8'))
  const alive = await fetch(`http://127.0.0.1:${descriptor.port}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${descriptor.token}` }, body: JSON.stringify({ method: 'health' }) })
  assert.equal((await alive.json()).ok, true)
  const forbidden = await fetch(`http://127.0.0.1:${descriptor.port}/rpc`, { method: 'POST', body: '{}' })
  assert.equal(forbidden.status, 403)
})

test('native host replies on an OPEN input pipe, reuses one daemon, then exits on EOF', { skip: !existsSync(path.join(helper, 'BewlyDownloadHost.exe')), timeout: 20000 }, async (t) => {
  const directory = await temporary(t)
  const child = spawn(path.join(helper, 'BewlyDownloadHost.exe'), [`chrome-extension://${identity.extensionId}/`], { env: { ...process.env, BEWLY_DOWNLOAD_DATA: directory, BEWLY_DOWNLOAD_HEADLESS: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => { child.kill(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy() })
  let bytes = Buffer.alloc(0)
  const awaiting = new Map()
  child.stderr.on('data', () => {})
  child.stdout.on('data', (chunk) => {
    bytes = Buffer.concat([bytes, chunk])
    while (bytes.length >= 4 && bytes.length >= bytes.readUInt32LE(0) + 4) {
      const size = bytes.readUInt32LE(0)
      const reply = JSON.parse(bytes.subarray(4, size + 4).toString())
      bytes = bytes.subarray(size + 4)
      awaiting.get(reply.requestId)?.(reply)
      awaiting.delete(reply.requestId)
    }
  })
  const request = requestId => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { awaiting.delete(requestId); reject(new Error('Host did not flush its reply while stdin was still open')) }, 4000)
    awaiting.set(requestId, reply => { clearTimeout(timeout); resolve(reply) })
    const body = Buffer.from(JSON.stringify({ method: 'health', requestId, allowStart: requestId === 1 }))
    const prefix = Buffer.alloc(4); prefix.writeUInt32LE(body.length)
    child.stdin.write(Buffer.concat([prefix, body]))
  })
  let daemonPid
  for (let id = 1; id <= 12; id++) {
    const reply = await request(id)
    assert.equal(reply.ok, true)
    assert.equal(child.stdin.writableEnded, false)
    const currentPid = JSON.parse(readFileSync(path.join(directory, 'connection.json'), 'utf8')).pid
    if (daemonPid) assert.equal(currentPid, daemonPid)
    daemonPid = currentPid
  }
  const exit = new Promise(resolve => child.once('exit', resolve))
  const streamsClosed = Promise.all([new Promise(resolve => child.stdout.once('end', resolve)), new Promise(resolve => child.stderr.once('end', resolve))])
  child.stdin.end()
  const timeout = delay(3000).then(() => { throw new Error('Bridge stayed alive after its input pipe closed') })
  assert.equal(await Promise.race([exit, timeout]), 0)
  await Promise.race([streamsClosed, delay(3000).then(() => { throw new Error('The daemon inherited native messaging pipe handles') })])
})

test('real aria2 pauses, resumes partial data, and FFmpeg merges synthetic media', { skip: !existsSync(toolPath('ffmpeg')), timeout: 30000 }, async (t) => {
  const directory = await temporary(t)
  // Fixture generation runs outside MSIX. Installed media execution is covered
  // separately through the authenticated service in verify-download-live.mjs.
  const ffmpeg = toolPath('ffmpeg'), bin = path.dirname(ffmpeg)
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10', '-t', '0.5', '-c:v', 'mpeg4', '-an', path.join(directory, 'source-video.mp4')], { windowsHide: true })
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '0.5', '-c:a', 'aac', path.join(directory, 'source-audio.m4a')], { windowsHide: true })
  const padding = Buffer.alloc(4 * 1024 * 1024)
  padding.writeUInt32BE(padding.length, 0); padding.write('free', 4)
  const media = { '/video': Buffer.concat([readFileSync(path.join(directory, 'source-video.mp4')), padding]), '/audio': readFileSync(path.join(directory, 'source-audio.m4a')) }
  const resumedOffsets = []
  const server = http.createServer((request, response) => {
    const body = media[request.url]
    if (!body) { response.writeHead(404).end(); return }
    const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range || '')
    const start = range ? Number(range[1]) : 0
    if (request.url === '/video' && start > 0) resumedOffsets.push(start)
    const end = range && range[2] ? Number(range[2]) : body.length - 1
    response.writeHead(range ? 206 : 200, { 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${body.length}` } : {}) })
    let offset = start
    const timer = setInterval(() => {
      const next = Math.min(offset + 32768, end + 1)
      response.write(body.subarray(offset, next)); offset = next
      if (offset > end) { clearInterval(timer); response.end() }
    }, 20)
    response.once('close', () => clearInterval(timer))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const store = new TaskStore(path.join(directory, 'data'))
  store.settings({ directory: path.join(directory, 'output'), maxConcurrent: 1 })
  const aria2 = new Aria2(bin)
  const queue = new DownloadQueue({ store, aria2, bin, dataDirectory: directory, bilibili: { resolve: async () => ({ video: { urls: [`${base}/video`], quality: 80, codec: 7 }, audio: { urls: [`${base}/audio`] } }) } })
  try {
    const [task] = queue.enqueue(info, [1], {})
    for (let attempt = 0; attempt < 80; attempt++) {
      const current = store.get(task.id)
      if (current.status === 'downloading' && current.progress > 0) break
      await delay(100)
    }
    await queue.action(task.id, 'pause')
    assert.equal(store.get(task.id).status, 'paused')
    while (queue.running.has(task.id)) await delay(20)
    await queue.action(task.id, 'resume')
    let result
    for (let attempt = 0; attempt < 200; attempt++) {
      result = store.get(task.id)
      if (['completed', 'failed'].includes(result.status)) break
      await delay(100)
    }
    assert.equal(result.status, 'completed', result.error)
    assert.ok(existsSync(result.output))
    assert.ok(resumedOffsets.length > 0, 'aria2 must resume from an existing partial file')
    const inspection = execFileSync(ffmpeg, ['-i', result.output, '-f', 'null', '-'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] })
    assert.equal(inspection, null)
  }
  finally { await queue.close(); store.close(); await new Promise(resolve => server.close(resolve)) }
})
