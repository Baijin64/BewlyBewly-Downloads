import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url), JSZip = require('jszip')
const extensionVersion = JSON.parse(await readFile('package.json', 'utf8')).version
const helperVersion = JSON.parse(await readFile('native/package.json', 'utf8')).version
const extension = `BewlyBewly-Downloads-${extensionVersion}-candidate`
const bundle = `Bewly-Downloads-${extensionVersion}-helper-${helperVersion}-test-bundle`
let progressEvidence
try { progressEvidence = JSON.parse(await readFile(`dist/download-progress-${extensionVersion}-verification.json`, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
const names = [
  `${extension}.crx`, `${extension}.zip`, `Bewly-DownloadHelper-${helperVersion}-x64.msix`,
  'verification-current.json', `native-ui-${helperVersion}-verification.json`, `helper-update-${helperVersion}-verification.json`,
  `installed-runtime-${helperVersion}-verification.json`, `helper-slim-size-${helperVersion}.json`, `helper-signature-${helperVersion}.json`,
  'node-installer-download-verification.json', `node-setup-${helperVersion}-preview.png`,
  ...progressEvidence ? [`download-progress-${extensionVersion}-verification.json`, `download-progress-${extensionVersion}-light.png`, `download-progress-${extensionVersion}-dark.png`] : [],
]
const zip = new JSZip(), hashes = []
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function add(name, bytes) { zip.file(name, bytes); hashes.push(hash(bytes) + '  ' + name) }
for (const name of names) await add(name, await readFile('dist/' + name))
for (const name of ['DOWNLOADS.md', 'DOWNLOAD-PARITY.md', 'DOWNLOAD-COMPONENTS.md']) await add(name, await readFile('docs/' + name))
const update = progressEvidence ? '进度条 UI 已更新，请重载 Edge 中的扩展后刷新 B 站。CRX 安装用户使用本包的新版 CRX。助手 0.2.6 无需重装。' : '本机助手已更新，网页插件无需重载。'
await add('README.txt', Buffer.from(`扩展 ${extensionVersion} / 助手 ${helperVersion}\r\n${update}\r\nMSIX 不内置 Node.js，约 27.6 MiB；安装文件约 65.1 MiB。\r\n新安装用户从开始菜单打开一次，已有兼容 Node 会直接复用；缺少时点击本地窗口中的“下载并安装 Node.js”。Windows 可能请求安装授权。\r\n原下载记录与配置保留，FFmpeg 与 aria2 继续内置。\r\nNode 官方安装程序下载、哈希及签名验证通过；本机已有 Node，未执行重复安装。缺 Node 环境的完整 UAC/MSI 交互待单独验收。\r\n下载进度截图为浏览器内模拟任务；Node 安装窗口为离屏控件渲染。详见使用说明与验证报告。\r\n`))
zip.file('SHA256SUMS.txt', hashes.join('\n') + '\n')
const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' })
await writeFile('dist/' + bundle + '.zip', bytes)
const check = await JSZip.loadAsync(bytes, { checkCRC32: true })
for (const line of hashes) { const [expected, name] = line.split('  '); assert.equal(hash(await check.file(name).async('nodebuffer')), expected) }
const report = { checkedAt: new Date().toISOString(), bundle: bundle + '.zip', extensionVersion, helperVersion, size: bytes.length, sha256: hash(bytes), allEntriesAndCrcVerified: true, containsUserSessionOrDatabase: false }
await writeFile('dist/' + bundle + '-verification.json', JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report))
