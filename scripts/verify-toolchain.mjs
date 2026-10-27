import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const args = process.argv.slice(2)
const flag = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined }
const target = flag('--platform') || `${process.platform}-${process.arch}`
const directory = path.resolve(args.find(value => !value.startsWith('--') && value !== target) || 'dist/toolchain/bin')
const toolchain = JSON.parse(await readFile('native/toolchain.json', 'utf8'))

const platform = toolchain.platforms?.[target]
const files = platform?.files && Object.keys(platform.files).length ? platform.files : target.startsWith('win32') ? toolchain.files : null
if (!files) {
  console.log(`No pinned hashes for ${target}; run scripts/toolchain/build-posix-tools.sh and publish the asset first.`)
  process.exit(0)
}

for (const [name, info] of Object.entries(files)) {
  const file = path.join(directory, name)
  assert.ok(existsSync(file), `${name} is missing from the toolchain directory`)
  if (!info.sha256) continue
  const bytes = await readFile(file)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), info.sha256, `${name} does not match the pinned test toolchain`)
}
console.log(`Verified pinned media tools for ${target}.`)
