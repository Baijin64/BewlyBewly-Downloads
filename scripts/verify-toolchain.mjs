import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const directory = path.resolve(process.argv[2] || 'dist/toolchain/bin')
const toolchain = JSON.parse(await readFile('native/toolchain.json', 'utf8'))
for (const [name, info] of Object.entries(toolchain.files)) {
  const bytes = await readFile(path.join(directory, name))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), info.sha256, `${name} does not match the pinned test toolchain`)
}
console.log('Verified pinned aria2 and FFmpeg binaries.')
