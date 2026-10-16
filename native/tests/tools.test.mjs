import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { ClassicLevel } from 'classic-level'

import { DownloadQueue, TaskStore } from '../core.mjs'
import { LegacyMigration, parseLegacyHistory, readLegacySettings } from '../migration.mjs'
import { convertVideoId, ToolJobs } from '../tools.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const helper = path.join(root, 'dist/helper-msix')
const bin = path.join(helper, 'bin')
const identity = JSON.parse(readFileSync(path.join(root, 'native/identity.json'), 'utf8'))
async function temporary(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'bewly-tools-'))
  t.after(async () => {
    if (existsSync(path.join(directory, 'connection.json'))) {
      const connection = JSON.parse(readFileSync(path.join(directory, 'connection.json'), 'utf8'))
      try { process.kill(connection.pid) } catch {}
      await delay(300)
    }
    assert.equal(path.dirname(directory), path.resolve(tmpdir()))
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  })
  return directory
}
test('BV / AV conversion matches published identities and rejects invalid identifiers', () => {
  assert.equal(convertVideoId('av170001'), 'BV17x411w7KC')
  assert.equal(convertVideoId('BV17x411w7KC'), 'av170001')
  for (const value of ['https://evil.test', 'BV1O00000000', '-1', '99999999999999999']) assert.throws(() => convertVideoId(value))
})

test('Windows desktop protocol preserves Unicode paths and readable errors', { skip: !existsSync(path.join(helper, 'BewlyDownloadHost.exe')) }, async (t) => {
  const directory = await temporary(t), file = path.join(directory, '中文路径 😀.mp4')
  writeFileSync(file, 'fixture')
  const result = spawnSync(path.join(helper, 'BewlyDownloadHost.exe'), ['--open'], { input: JSON.stringify({ kind: 'unsupported', path: file }), windowsHide: true, encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /此文件不能作为媒体播放/)
})

test('Chromium migration reads an isolated snapshot and only whitelisted settings', async (t) => {
  const directory = await temporary(t), profile = path.join(directory, 'profile')
  const source = path.join(profile, 'Local Storage', 'leveldb')
  const level = new ClassicLevel(source, { keyEncoding: 'buffer', valueEncoding: 'buffer' })
  const encode = text => Buffer.concat([Buffer.from([0]), Buffer.from(text, 'utf16le')])
  const key = name => Buffer.concat([Buffer.from('_app://.\x00'), Buffer.from([1]), Buffer.from(name, 'latin1')])
  await level.put(key('setting'), encode(JSON.stringify({ videoQn: '112', audioQn: 'hi', videoEncoding: 'hev1', maxDownCount: 4, pic: true, shutdown: true, listenClipBoard: true })))
  await level.put(key('defaultDownPath'), encode(path.join(directory, '视频')))
  await level.put(key('renameRule'), encode('%index:01%-%title%'))
  await level.put(key('user'), Buffer.from([255, 255, 255])) // Invalid string intentionally: it must never be decoded.
  await level.close()
  const fingerprint = async () => Promise.all((await readdir(source)).map(name => [name, createHash('sha256').update(readFileSync(path.join(source, name))).digest('hex')]))
  const before = await fingerprint()
  const value = await readLegacySettings(profile, path.join(directory, 'data'), { checkRunning: false })
  assert.equal(value.defaultOptions.quality, 112)
  assert.equal(value.defaultOptions.audioQuality, 'hires')
  assert.equal(value.defaultOptions.codec, 'hevc')
  assert.equal(value.maxConcurrent, 4)
  assert.equal(value.shutdown, false); assert.equal(value.listenClipboard, false)
  assert.equal(value.directory, path.join(directory, '视频'))
  assert.deepEqual(await fingerprint(), before)
})

test('legacy export previews, deduplicates, and never claims directories are media files', async (t) => {
  const directory = await temporary(t), store = new TaskStore(path.join(directory, 'data'))
  const migration = new LegacyMigration({ store, dataDirectory: path.join(directory, 'data') })
  const file = path.join(directory, 'old.bilidownexport')
  const content = JSON.stringify({ downloaded: [{ vid: '123', bv: 'BV17x411w7KC', title: '视频😀', pic: 'http://i0.hdslb.com/bfs/archive/fixture.jpg@240w', path: directory, downDate: '2024-11-07' }] })
  writeFileSync(file, content.split('').map(char => String.fromCharCode(char.charCodeAt(0) ^ 54)).join(''))
  assert.equal(parseLegacyHistory(readFileSync(file, 'utf8')).records[0].title, '视频😀')
  const preview = await migration.preview({ settings: false, historyFile: file })
  assert.equal(preview.total, 1); assert.equal(store.list().length, 0)
  const result = migration.import({ id: preview.id, history: true })
  assert.equal(result.imported, 1)
  const imported = store.list()[0]
  assert.equal(imported.cover, 'https://i0.hdslb.com/bfs/archive/fixture.jpg@240w')
  assert.equal(imported.status, 'completed'); assert.equal(imported.cid, 0); assert.equal(imported.output, undefined); assert.equal(imported.legacyPath, directory)
  const again = await migration.preview({ settings: false, historyFile: file })
  assert.equal(again.duplicate, 1)
  assert.equal(migration.import({ id: again.id, history: true }).imported, 0)
  const jobs = new ToolJobs({ store, queue: {}, root: helper })
  const exported = await jobs.execute({ op: 'exportHistory', directory: path.join(directory, 'export') }, new AbortController().signal)
  const roundTrip = await migration.preview({ settings: false, historyFile: exported.path })
  assert.equal(roundTrip.duplicate, 1)
  assert.equal(migration.import({ id: roundTrip.id, history: true }).imported, 0)
  assert.equal(readFileSync(file, 'utf8'), content.split('').map(char => String.fromCharCode(char.charCodeAt(0) ^ 54)).join(''))
  store.close()
})

test('reimport repairs a missing legacy cover without changing history or existing metadata', async (t) => {
  const directory = await temporary(t), store = new TaskStore(path.join(directory, 'data'))
  const migration = new LegacyMigration({ store, dataDirectory: path.join(directory, 'data') })
  const file = path.join(directory, 'old.bilidownexport')
  const writeExport = pic => writeFileSync(file, JSON.stringify({ downloaded: [{ vid: 'cover-repair', bv: 'BV17x411w7KC', title: 'History', path: directory, pic, downDate: '2024-11-07' }] }).split('').map(char => String.fromCharCode(char.charCodeAt(0) ^ 54)).join(''))
  writeExport('https://unrelated.example/cover.jpg')
  let preview = await migration.preview({ settings: false, historyFile: file })
  migration.import({ id: preview.id, history: true })
  const before = store.list()[0]
  assert.equal(before.cover, '')
  writeExport('//i0.hdslb.com/bfs/archive/restored.jpg')
  preview = await migration.preview({ settings: false, historyFile: file })
  const result = migration.import({ id: preview.id, history: true })
  assert.equal(result.imported, 0)
  assert.equal(result.restoredCovers, 1)
  assert.deepEqual(store.list()[0], { ...before, cover: 'https://i0.hdslb.com/bfs/archive/restored.jpg' })
  writeExport('https://i0.hdslb.com/bfs/archive/replacement.jpg')
  preview = await migration.preview({ settings: false, historyFile: file })
  assert.equal(migration.import({ id: preview.id, history: true }).restoredCovers, 0)
  assert.equal(store.list().length, 1)
  assert.equal(store.list()[0].cover, 'https://i0.hdslb.com/bfs/archive/restored.jpg')
  store.close()
})

test('local tools convert subtitles and preserve existing outputs', async (t) => {
  const directory = await temporary(t), store = new TaskStore(path.join(directory, 'data'))
  const queue = new DownloadQueue({ store, bin, dataDirectory: directory })
  const jobs = new ToolJobs({ store, queue, root: helper })
  const source = path.join(directory, '字幕.json')
  writeFileSync(source, JSON.stringify({ body: [{ from: 0, to: 1.25, content: '2024' }] }))
  const output = path.join(directory, 'output')
  const result = await jobs.execute({ op: 'ccToSrt', source, directory: output }, new AbortController().signal)
  assert.match(readFileSync(result.path, 'utf8'), /00:00:01,250\n2024/)
  await assert.rejects(() => jobs.execute({ op: 'ccToSrt', source, directory: output }, new AbortController().signal), /已存在/)
  const text = await jobs.execute({ op: 'srtToText', source: result.path, directory: output }, new AbortController().signal)
  assert.equal(readFileSync(text.path, 'utf8'), '2024')
  store.close()
})

test('real auxiliary MP3 conversion and manual mux preserve source files', { skip: !existsSync(path.join(bin, 'ffmpeg.exe')), timeout: 10000 }, async (t) => {
  const directory = await temporary(t), store = new TaskStore(path.join(directory, 'data'))
  const queue = new DownloadQueue({ store, bin, dataDirectory: directory }), jobs = new ToolJobs({ store, queue, root: helper })
  const ffmpeg = path.join(bin, 'ffmpeg.exe'), audio = path.join(directory, 'source.m4a'), video = path.join(directory, 'source.mp4')
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '0.2', '-c:a', 'aac', audio], { windowsHide: true })
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10', '-t', '0.2', '-c:v', 'libx264', '-an', video], { windowsHide: true })
  const mp3 = await jobs.execute({ op: 'audioToMp3', source: audio, directory: path.join(directory, 'output') }, new AbortController().signal)
  const mux = await jobs.execute({ op: 'mux', audio, video, directory: path.join(directory, 'output') }, new AbortController().signal)
  assert.ok(existsSync(mp3.path)); assert.ok(existsSync(mux.path)); assert.ok(existsSync(audio)); assert.ok(existsSync(video))
  store.close()
})

test('framed native host supports the new pending/query/batch/tool protocol end to end', { skip: !existsSync(path.join(helper, 'BewlyDownloadHost.exe')), timeout: 15000 }, async (t) => {
  const directory = await temporary(t)
  const child = spawn(path.join(helper, 'BewlyDownloadHost.exe'), ['chrome-extension://' + identity.extensionId + '/'], { windowsHide: true, env: { ...process.env, BEWLY_DOWNLOAD_DATA: directory, BEWLY_DOWNLOAD_HEADLESS: '1' } })
  t.after(() => { child.kill(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy() })
  let bytes = Buffer.alloc(0), sequence = 0
  const awaiting = new Map()
  child.stdout.on('data', chunk => {
    bytes = Buffer.concat([bytes, chunk])
    while (bytes.length >= 4 && bytes.length >= bytes.readUInt32LE(0) + 4) {
      const length = bytes.readUInt32LE(0), reply = JSON.parse(bytes.subarray(4, length + 4).toString('utf8'))
      bytes = bytes.subarray(length + 4); awaiting.get(reply.requestId)?.(reply); awaiting.delete(reply.requestId)
    }
  })
  child.stderr.on('data', () => {})
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++sequence, timeout = setTimeout(() => reject(new Error('Native protocol timed out')), 5000)
    awaiting.set(requestId, reply => { clearTimeout(timeout); reply.ok ? resolve(reply.result) : reject(new Error(reply.error)) })
    const body = Buffer.from(JSON.stringify({ method, params, requestId })), prefix = Buffer.alloc(4); prefix.writeUInt32LE(body.length)
    child.stdin.write(Buffer.concat([prefix, body]))
  })
  const health = await request('health')
  assert.equal(health.protocol, 2)
  const info = { bvid: 'BV17x411w7KC', title: 'native protocol', pages: [{ cid: 42, page: 1, title: 'one' }] }
  const [task] = await request('stageTasks', { info, cids: [42], options: {} })
  assert.equal(task.status, 'pending')
  assert.equal((await request('queryTasks', { tab: 'pending' })).total, 1)
  const batch = await request('batchAction', { ids: [task.id], action: 'edit', options: { outputs: ['cover'] } })
  assert.equal(batch.results.length, 1)
  const job = await request('tool', { op: 'convertId', input: 'av170001' })
  let result
  for (let attempt = 0; attempt < 20; attempt++) {
    result = await request('tool', { op: 'status', id: job.id })
    if (result.status !== 'running') break
    await delay(50)
  }
  assert.equal(result.result.text, 'BV17x411w7KC')
  child.stdin.end()
})
