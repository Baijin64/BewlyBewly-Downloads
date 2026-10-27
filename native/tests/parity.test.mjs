import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { copyFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { Bilibili, DownloadQueue, TaskStore } from '../core.mjs'
import { outputLocation, selectStreams, srtText, toAss, toNfo, validateOptions } from '../formats.mjs'
import { stageRoot } from './support/host.mjs'
import { setTimeout as delay } from 'node:timers/promises'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const bin = path.join(stageRoot(), 'bin')
const info = { bvid: 'BV1GJ411x7h7', title: '系列视频', author: 'UP', uid: 123, pubdate: 1700000000, cover: 'https://i0.hdslb.com/cover.png', description: '<内容 & 说明>', pages: [{ cid: 42, page: 1, title: '第一集', duration: 1 }] }
async function temporary(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'bewly-parity-'))
  t.after(() => { assert.equal(path.dirname(directory), path.resolve(tmpdir())); return rm(directory, { recursive: true, force: true, maxRetries: 3 }) })
  return directory
}

test('short-link expansion is bounded, preserves part selection and never follows foreign redirects', async () => {
  let calls = 0
  const bili = new Bilibili(() => 'synthetic-secret', async (_url, options) => {
    calls++
    assert.equal(options.redirect, 'manual')
    assert.equal(options.headers.Cookie, undefined)
    return { headers: new Headers({ location: 'https://www.bilibili.com/video/BV17x411w7KC/?p=2' }) }
  })
  assert.equal(await bili.expand('https://b23.tv/example'), 'https://www.bilibili.com/video/BV17x411w7KC/?p=2')
  assert.equal(calls, 1)
  calls = 0
  const foreign = new Bilibili(() => '', async () => { calls++; return { headers: new Headers({ location: 'https://evil.test/private' }) } })
  await assert.rejects(() => foreign.expand('https://b23.tv/example'))
  assert.equal(calls, 1)
})

test('pending tasks never auto-start, survive restart, and batch edits are snapshots', async (t) => {
  const directory = await temporary(t)
  let store = new TaskStore(directory)
  const queue = new DownloadQueue({ store, dataDirectory: directory }); queue.closed = true
  const [first] = queue.enqueue(info, [42], { quality: 80, audioQuality: '192' }, {}, false)
  assert.equal(first.status, 'pending')
  const [duplicate] = queue.enqueue(info, [42], { quality: 80, audioQuality: '192' }, {}, false)
  assert.equal(duplicate.id, first.id); assert.equal(duplicate.duplicate, true)
  store.settings({ maxConcurrent: 4 })
  assert.equal(store.get(first.id).options.quality, 80)
  const changed = await queue.batch([first.id, 'missing'], 'edit', { quality: 120, outputs: ['video', 'srt'] })
  assert.equal(changed.results.length, 1); assert.equal(changed.errors.length, 1)
  store.close()
  store = new TaskStore(directory)
  assert.equal(store.get(first.id).status, 'pending')
  const restarted = new DownloadQueue({ store, dataDirectory: directory }); restarted.closed = true
  await restarted.batch([first.id], 'start')
  assert.equal(store.get(first.id).status, 'queued')
  store.close()
})

test('large part batches are searchable and paginated beyond the old 100/200 limits', async (t) => {
  const directory = await temporary(t), store = new TaskStore(directory)
  const queue = new DownloadQueue({ store, dataDirectory: directory }); queue.closed = true
  const pages = Array.from({ length: 321 }, (_, index) => ({ cid: index + 1, page: index + 1, title: '分 P ' + (index + 1), duration: 1 }))
  queue.enqueue({ ...info, pages }, pages.map(page => page.cid), {}, {}, false)
  const page = store.query({ tab: 'pending', page: 4, pageSize: 100 })
  assert.equal(page.total, 321); assert.equal(page.items.length, 21); assert.equal(page.counts.pending, 321)
  assert.equal(store.query({ search: '分 P 321' }).total, 1)
  assert.equal(store.query({ search: '%' }).total, 0)
  store.close()
})

test('pre-v2 databases receive a restorable backup without losing output records', async (t) => {
  const directory = await temporary(t)
  const db = new DatabaseSync(path.join(directory, 'downloads.sqlite'))
  db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY,data TEXT NOT NULL)')
  db.prepare('INSERT INTO tasks VALUES(?,?)').run('old', JSON.stringify({ id: 'old', status: 'completed', output: 'old.mp4' })); db.close()
  const store = new TaskStore(directory)
  assert.equal(store.get('old').output, 'old.mp4')
  assert.equal(readdirSync(directory).filter(name => /^downloads.pre-v2-.*\.sqlite$/.test(name)).length, 1)
  store.close()
})

test('audio choice includes Dolby and Hi-Res, and never silently substitutes', () => {
  const data = { dash: { video: [{ id: 80, codecid: 7, bandwidth: 100, baseUrl: 'https://cdn.bilivideo.com/v' }], audio: [{ id: 30280, bandwidth: 30, baseUrl: 'https://cdn.bilivideo.com/a' }], dolby: { audio: [{ id: 30250, bandwidth: 50, baseUrl: 'https://cdn.bilivideo.com/d' }] }, flac: { audio: { id: 30251, bandwidth: 80, baseUrl: 'https://cdn.bilivideo.com/f' } } } }
  assert.equal(selectStreams(data, {}).audio.id, 30251)
  assert.equal(selectStreams(data, { audioQuality: '192' }).audio.id, 30280)
  assert.equal(selectStreams(data, { audioQuality: 'hires' }).audio.id, 30251)
  assert.equal(selectStreams(data, { audioQuality: 'dolby' }).audio.id, 30250)
  assert.throws(() => selectStreams(data, { audioQuality: '132' }), /音质/)
  assert.throws(() => selectStreams(data, { codec: 'av1' }), /编码/)
  assert.equal(selectStreams({}, { outputs: ['cover', 'nfo'] }).video, null)
})

test('automatic audio prioritizes Hi-Res, Dolby and ordinary bitrate tiers consistently', () => {
  const track = (id, bandwidth) => ({ id, bandwidth, baseUrl: 'https://cdn.bilivideo.com/' + id })
  const data = { dash: { audio: [track(30216, 64000), track(30232, 132000), track(30280, 192000)], dolby: { audio: [track(30250, 100000)] }, flac: { audio: track(30251, 50000) } } }
  const options = { outputs: ['audio'] }
  assert.equal(selectStreams(data, options).audio.id, 30251)
  data.dash.flac.audio.baseUrl = ''
  assert.equal(selectStreams(data, options).audio.id, 30250)
  data.dash.dolby.audio = []
  assert.equal(selectStreams(data, options).audio.id, 30280)
  data.dash.audio = data.dash.audio.filter(item => item.id !== 30280)
  assert.equal(selectStreams(data, options).audio.id, 30232)
  assert.throws(() => selectStreams(data, { ...options, audioQuality: 'hires' }), /音质/)
})

test('naming templates support dates, indices, advanced folders and reject escapes', () => {
  const task = { ...info, cid: 42, part: '第一集', page: 2, pageCount: 3, directory: path.resolve('test-output'), createdAt: '2026-10-16T12:00:00', options: validateOptions({ outputs: ['video', 'srt'], filenameTemplate: '%index:00%-%title%-%bv%', folderTemplate: '%upnn%/%pd:YYYY%', createFolder: true, createFolderAddIndex: true }) }
  const output = outputLocation(task)
  assert.equal(output.basename, '01-第一集-BV1GJ411x7h7')
  assert.ok(output.directory.endsWith(path.join('UP', '2023', '系列视频', '02 第一集')))
  assert.throws(() => validateOptions({ filenameTemplate: '%unknown%' }), /变量/)
  const escaped = outputLocation({ ...task, options: validateOptions({ folderTemplate: '../%upnn%' }) })
  assert.ok(!path.relative(task.directory, escaped.directory).startsWith('..'))
})

test('ASS and NFO escape embedded syntax while subtitles retain their text', () => {
  const ass = toAss('<i><d p="1.25,1,25,16711680,0,0,0,0">hello &amp; {\\\\pos(0,0)}</d><d p="2,5,25,16777215,0">top</d></i>')
  assert.match(ass, /Dialogue: 0,0:00:01\.25/); assert.match(ass, /\\c&H0000ff&/i)
  assert.ok(!ass.includes('{\\\\pos'))
  assert.match(toNfo({ ...info, cid: 42, page: 1 }), /&lt;内容 &amp; 说明&gt;/)
  assert.equal(srtText('1\n00:00:01,000 --> 00:00:02,000\n<b>第一行</b>\n\n2\n00:00:03,000 --> 00:00:04,000\n第二行'), '第一行\n第二行')
})

test('real FFmpeg produces every combined media and attachment output, with safe remove', { skip: !existsSync(path.join(bin, 'ffmpeg.exe')), timeout: 20000 }, async (t) => {
  const directory = await temporary(t), store = new TaskStore(path.join(directory, 'data'))
  store.settings({ directory: path.join(directory, 'output'), maxConcurrent: 1 })
  const ffmpeg = path.join(bin, 'ffmpeg.exe')
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10', '-t', '0.4', '-c:v', 'mpeg4', '-an', path.join(directory, 'video.mp4')], { windowsHide: true })
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '0.4', '-c:a', 'aac', path.join(directory, 'audio.m4a')], { windowsHide: true })
  const queue = new DownloadQueue({ store, dataDirectory: path.join(directory, 'data'), bin, aria2: { ready: async () => {} }, fetcher: async () => new Response(readFileSync(path.join(root, 'assets/icon-512.png')), { headers: { 'Content-Type': 'image/png' } }), bilibili: {
    resolve: async () => ({ video: { quality: 80, codec: 7 }, audio: { id: 30280 } }),
    subtitles: async () => [{ language: 'zh-CN', content: '1\n00:00:00,000 --> 00:00:01,000\n字幕\n' }],
    danmaku: async () => '<i><d p="0,1,25,16777215,0">弹幕</d></i>',
  } })
  queue.closed = true
  queue.transfer = async (_task, _urls, name, work) => { const target = path.join(work, name); await copyFile(path.join(directory, name.startsWith('video') ? 'video.mp4' : 'audio.m4a'), target); return target }
  const [task] = queue.enqueue(info, [42], { outputs: ['video', 'silent', 'audio', 'mp3', 'cover', 'xml', 'ass', 'srt', 'nfo'] }, {}, false)
  await queue.run(task, { controller: new AbortController(), gids: new Set() })
  const done = store.get(task.id)
  assert.equal(done.status, 'completed'); assert.equal(Object.keys(done.artifacts).length, 9); assert.deepEqual(done.warnings, [])
  for (const kind of ['video', 'silent', 'audio', 'mp3']) {
    const inspection = execFileSync(ffmpeg, ['-v', 'info', '-i', done.artifacts[kind], '-f', 'null', '-'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    assert.equal(inspection, '')
  }
  assert.match(readFileSync(done.artifacts.ass, 'utf8'), /Dialogue:/)
  assert.ok(done.artifacts.cover.endsWith('.png'))
  const files = Object.values(done.artifacts)
  await queue.action(task.id, 'remove')
  assert.ok(files.every(file => existsSync(file)), 'removing a record must keep downloaded files')
  store.put(done)
  await queue.action(task.id, 'deleteFiles')
  assert.ok(files.every(file => !existsSync(file)))
  store.close()
})

test('Hi-Res is remuxed to MKV and native FLAC without transcoding', { skip: !existsSync(path.join(bin, 'ffmpeg.exe')), timeout: 10000 }, async (t) => {
  const directory = await temporary(t), store = new TaskStore(path.join(directory, 'data'))
  store.settings({ directory: path.join(directory, 'output') })
  const ffmpeg = path.join(bin, 'ffmpeg.exe'), audio = path.join(directory, 'source.flac'), video = path.join(directory, 'source.mp4')
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=96000', '-t', '0.3', '-c:a', 'flac', audio], { windowsHide: true })
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10', '-t', '0.3', '-c:v', 'mpeg4', '-an', video], { windowsHide: true })
  const queue = new DownloadQueue({ store, bin, dataDirectory: directory, aria2: { ready: async () => {} }, bilibili: { resolve: async () => ({ video: { quality: 80, codec: 7 }, audio: { id: 30251, codecs: 'fLaC' } }) } })
  queue.closed = true
  queue.transfer = async (_task, _urls, name, work) => { const target = path.join(work, name); await copyFile(name.startsWith('video') ? video : audio, target); return target }
  const [task] = queue.enqueue(info, [42], { outputs: ['video', 'audio'], audioQuality: 'hires' }, {}, false)
  await queue.run(task, { controller: new AbortController(), gids: new Set() })
  const done = store.get(task.id)
  assert.ok(done.artifacts.video.endsWith('.mkv')); assert.ok(done.artifacts.audio.endsWith('.flac'))
  const digest = file => execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'md5', '-'], { windowsHide: true, encoding: 'utf8' }).trim()
  assert.equal(digest(done.artifacts.audio), digest(audio))
  assert.equal(digest(done.artifacts.video), digest(audio))
  store.close()
})

test('disk-full transfer preserves partial state and never retries the video API', async (t) => {
  const directory = await temporary(t), store = new TaskStore(path.join(directory, 'data'))
  store.settings({ directory: path.join(directory, 'output') })
  let resolves = 0
  const queue = new DownloadQueue({ store, dataDirectory: directory, aria2: { ready: async () => {}, rpc: async method => method === 'tellStatus' ? { status: 'error', errorCode: '9' } : 'synthetic-gid' },
    bilibili: { resolve: async () => { resolves++; return { video: { quality: 80, codec: 7, urls: ['https://cdn.bilivideo.com/v'] }, audio: { id: 30280, urls: ['https://cdn.bilivideo.com/a'] } } } },
  })
  queue.closed = true
  const [task] = queue.enqueue(info, [42], {}, {}, false)
  await assert.rejects(() => queue.run(task, { controller: new AbortController(), gids: new Set() }), error => error.code === 'ENOSPC')
  assert.equal(resolves, 1)
  store.close()
})

test('a database write failure stops scheduling without an unhandled failure loop', async (t) => {
  const directory = await temporary(t), store = new TaskStore(directory)
  const queue = new DownloadQueue({ store, dataDirectory: directory })
  queue.closed = true
  queue.enqueue(info, [42], {})
  store.put = () => { throw new Error('SQLITE_FULL') }
  queue.run = async () => { throw new Error('disk full') }
  queue.closed = false; queue.pump()
  for (let attempt = 0; attempt < 50 && queue.running.size; attempt++) await delay(20)
  assert.match(queue.storageError, /磁盘/)
  assert.equal(queue.running.size, 0)
  store.close()
})
