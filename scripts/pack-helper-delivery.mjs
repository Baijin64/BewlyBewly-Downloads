import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const JSZip = require('jszip')

const extensionVersion = JSON.parse(await readFile('package.json', 'utf8')).version
const helperVersion = /\[workspace\.package\][\s\S]*?version\s*=\s*"([^"]+)"/.exec(await readFile('rust/Cargo.toml', 'utf8'))[1]
const extension = `BewlyBewly-Downloads-${extensionVersion}-candidate`
const bundle = `Bewly-Downloads-${extensionVersion}-helper-${helperVersion}-test-bundle`
const requiredNames = [
  `${extension}.crx`,
  `${extension}.zip`,
  `Bewly-DownloadHelper-${helperVersion}-x64.msix`,
  'verification-current.json',
]
const optionalNames = [
  `native-ui-${helperVersion}-verification.json`,
  `helper-update-${helperVersion}-verification.json`,
  `installed-runtime-${helperVersion}-verification.json`,
  `helper-signature-${helperVersion}.json`,
  `download-progress-${extensionVersion}-verification.json`,
]
const names = [
  ...requiredNames,
  ...optionalNames.filter(name => existsSync(`dist/${name}`)),
]
const zip = new JSZip()
const hashes = []
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

async function add(name, bytes) {
  zip.file(name, bytes)
  hashes.push(`${hash(bytes)}  ${name}`)
}

for (const name of names)
  await add(name, await readFile(`dist/${name}`))
for (const name of ['DOWNLOADS.md', 'INSTALL-DOWNLOADS.md', 'DOWNLOAD-PARITY.md'])
  await add(name, await readFile(`docs/${name}`))

await add('README.txt', Buffer.from(
  `扩展 ${extensionVersion} / 助手 ${helperVersion}\r\n`
  + `本地下载助手已由 Rust 重写（BewlyDownloadHost.exe + NativeAOT 托盘 BewlyDownloadTray.exe），不再依赖 Node.js 或 aria2。\r\n`
  + `合流、音频提取与 MP3 转码使用随包内置的精简版 LGPL FFmpeg（bin\\ffmpeg.exe）。\r\n`
  + `安装 MSIX 后请从开始菜单打开“Bewly 下载助手”一次完成 Native Messaging 注册，原下载记录与配置会自动沿用。\r\n`
  + `扩展推荐解压 ZIP 后以开发者模式加载；详见包内 INSTALL-DOWNLOADS.md 与 DOWNLOADS.md。\r\n`,
))

zip.file('SHA256SUMS.txt', `${hashes.join('\n')}\n`)
const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' })
await writeFile(`dist/${bundle}.zip`, bytes)
const check = await JSZip.loadAsync(bytes, { checkCRC32: true })
for (const line of hashes) {
  const [expected, name] = line.split('  ')
  assert.equal(hash(await check.file(name).async('nodebuffer')), expected)
}
const report = {
  checkedAt: new Date().toISOString(),
  bundle: `${bundle}.zip`,
  extensionVersion,
  helperVersion,
  size: bytes.length,
  sha256: hash(bytes),
  allEntriesAndCrcVerified: true,
  containsUserSessionOrDatabase: false,
}
await writeFile(`dist/${bundle}-verification.json`, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report))
