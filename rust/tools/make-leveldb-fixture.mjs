// Builds a Chromium-style Local Storage LevelDB fixture for the Rust reader.
// Mirrors the data the browser extension migration path has to consume.
//
//   node rust/tools/make-leveldb-fixture.mjs <output-directory>

import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'

import { ClassicLevel } from '../../native/node_modules/classic-level/index.js'

const output = process.argv[2]
if (!output) {
  console.error('usage: node rust/tools/make-leveldb-fixture.mjs <output-directory>')
  process.exit(2)
}
if (existsSync(output)) rmSync(output, { recursive: true, force: true })

const level = new ClassicLevel(output, { keyEncoding: 'buffer', valueEncoding: 'buffer' })
const encode = text => Buffer.concat([Buffer.from([0]), Buffer.from(text, 'utf16le')])
const key = name => Buffer.concat([Buffer.from('_app://.\x00'), Buffer.from([1]), Buffer.from(name, 'latin1')])

await level.put(key('setting'), encode(JSON.stringify({ videoQn: '112', audioQn: 'hi', videoEncoding: 'hev1', maxDownCount: 4, pic: true, shutdown: true, listenClipBoard: true })))
await level.put(key('defaultDownPath'), encode(path.join('C:\\Users\\Test', '视频')))
await level.put(key('renameRule'), encode('%index:01%-%title%'))
await level.put(key('createFolder'), encode('true'))
await level.put(Buffer.concat([Buffer.from('_app://.\x00'), Buffer.from([1]), Buffer.from('user', 'latin1')]), Buffer.from([255, 255, 255]))
await level.put(Buffer.concat([Buffer.from('_file://.\x00'), Buffer.from([1]), Buffer.from('setting', 'latin1')]), encode('{"videoQn":"80"}'))
// Force the memtable into an .ldb table so the fixture exercises both the log and
// the block format a real browser profile contains.
await level.compactRange(Buffer.from('_'), Buffer.from('_\xff'))
await level.close()

console.log('leveldb fixture written:', output)
