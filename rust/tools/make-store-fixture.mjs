// Generates the SQLite fixture used by the Rust store tests.
// Uses the real Node TaskStore so the schema cannot drift from production.
//
//   node rust/tools/make-store-fixture.mjs <output.sqlite>

import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { TaskStore } from '../../native/core.mjs'

const output = process.argv[2]
if (!output) {
  console.error('usage: node rust/tools/make-store-fixture.mjs <output.sqlite>')
  process.exit(2)
}

const directory = mkdtempSync(path.join(tmpdir(), 'bewly-store-fixture-'))
const store = new TaskStore(directory)
store.settings({
  directory: 'C:\\Videos',
  maxConcurrent: 2,
  features: { cover: true, audio: true, tools: true },
  defaultOptions: { quality: 80, outputs: ['video'], codec: 'auto', audioQuality: 'auto' },
})

const base = {
  bvid: 'BV1xx411c7mD',
  author: 'UP主',
  page: 1,
  pageCount: 1,
  directory: 'C:\\Videos',
  options: {
    quality: 80,
    codec: 'auto',
    audioQuality: 'auto',
    mode: 'video',
    cover: false,
    subtitles: false,
    outputs: ['video'],
    subtitleLanguages: [],
    filenameTemplate: '%title% [%bv%-%cid%]',
    folderTemplate: '',
    createFolder: false,
    createFolderAddIndex: false,
  },
  progress: 0,
  speed: 0,
  error: '',
  stage: 'video',
  artifacts: {},
  warnings: [],
  createdAt: '2026-10-01T00:00:00.000Z',
}

store.put({ ...base, id: 'task-pending', cid: 11, title: '待下载视频', status: 'pending' })
store.put({
  ...base,
  id: 'task-active',
  cid: 12,
  title: '下载中的视频',
  status: 'downloading',
  progress: 42,
  speed: 1048576,
  actualQuality: 80,
  actualAudioId: 30280,
  prepared: {
    12: {
      video: { urls: ['https://upos-sz-mirror.bilivideo.com/v.m4s?sig=secret'], quality: 80, codec: 7, codecs: 'avc1.640028', bandwidth: 1 },
      audio: { urls: ['https://upos-sz-mirror.bilivideo.com/a.m4a?sig=secret'], quality: 30280, id: 30280, codec: 0, codecs: 'mp4a.40.2', bandwidth: 1 },
      extras: [],
    },
  },
})
store.put({
  ...base,
  id: 'task-done',
  cid: 13,
  title: '已完成的视频',
  status: 'completed',
  progress: 100,
  output: 'C:\\Videos\\已完成的视频 [BV1xx411c7mD-13].mp4',
  artifacts: { video: 'C:\\Videos\\已完成的视频 [BV1xx411c7mD-13].mp4' },
  completedAt: '2026-10-02T00:00:00.000Z',
})
store.close()

const database = new DatabaseSync(path.join(directory, 'downloads.sqlite'))
database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
database.close()

if (existsSync(output)) rmSync(output)
copyFileSync(path.join(directory, 'downloads.sqlite'), output)
rmSync(directory, { recursive: true, force: true })
console.log('fixture written:', output)
