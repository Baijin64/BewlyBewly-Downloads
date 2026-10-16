import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd(), source = path.resolve(process.argv[2] || '')
const destination = path.join(root, 'extension')
assert.equal((await lstat(source)).isSymbolicLink(), false)
assert.equal((await lstat(destination)).isSymbolicLink(), false)
assert.ok(source.startsWith(path.join(root, 'dist') + path.sep), 'candidate must be inside this project dist directory')
const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'))
assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
const backup = path.join(root, 'dist', 'extension-backup-before-' + manifest.version + '-' + Date.now())
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
let changed = 0, unchanged = 0
async function copy(directory, relative = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false)
    const next = path.join(relative, entry.name), from = path.join(source, next), to = path.join(destination, next)
    if (entry.isDirectory()) {
      try { assert.equal((await lstat(to)).isSymbolicLink(), false) } catch (error) { if (error.code !== 'ENOENT') throw error }
      await copy(from, next)
      continue
    }
    if (!entry.isFile()) continue
    const bytes = await readFile(from)
    let previous
    try { assert.equal((await lstat(to)).isSymbolicLink(), false); previous = await readFile(to) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (previous && hash(previous) === hash(bytes)) { unchanged++; continue }
    if (previous) { const saved = path.join(backup, next); await mkdir(path.dirname(saved), { recursive: true }); await writeFile(saved, previous) }
    await mkdir(path.dirname(to), { recursive: true }); await copyFile(from, to)
    assert.equal(hash(await readFile(to)), hash(bytes)); changed++
  }
}
await copy(source)
const report = { checkedAt: new Date().toISOString(), version: manifest.version, changedFiles: changed, unchangedFiles: unchanged, removedFiles: 0, backupDirectory: backup, needsBrowserReload: true }
await writeFile('dist/extension-files-' + manifest.version + '-verification.json', JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report))
