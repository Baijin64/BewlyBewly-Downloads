import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url), JSZip = require('jszip')
const source = path.resolve(process.argv[2] || 'extension')
const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'))
const expected = JSON.parse(await readFile('package.json', 'utf8')).version
assert.equal(manifest.version, expected)
const zip = new JSZip()
async function add(directory, prefix = '') {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    assert.equal(item.isSymbolicLink(), false)
    const name = prefix + item.name
    if (item.isDirectory()) await add(path.join(directory, item.name), name + '/')
    else if (item.isFile()) zip.file(name, await readFile(path.join(directory, item.name)))
  }
}
await add(source)
zip.file('LICENSE.txt', await readFile('LICENSE'))
const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
const checked = await JSZip.loadAsync(bytes, { checkCRC32: true })
assert.equal(JSON.parse(await checked.file('manifest.json').async('string')).version, expected)
await mkdir('dist', { recursive: true })
const file = `dist/BewlyBewly-Downloads-${expected}-Chrome.zip`
await writeFile(file, bytes)
console.log(JSON.stringify({ file, version: expected, sha256: createHash('sha256').update(bytes).digest('hex') }))
