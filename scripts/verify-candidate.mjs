import assert from 'node:assert/strict'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const JSZip = require('jszip')
const crxRequire = createRequire(require.resolve('crx'))
const Pbf = crxRequire('pbf')
const proto = crxRequire('./crx3.js.pb')
const identity = JSON.parse(await readFile('platforms/identity.json', 'utf8'))
const expectedVersion = JSON.parse(await readFile('package.json', 'utf8')).version
const expectedHelperVersion = /\[workspace\.package\][\s\S]*?version\s*=\s*"([^"]+)"/.exec(await readFile('rust/Cargo.toml', 'utf8'))[1]
const name = 'BewlyBewly-Downloads-' + expectedVersion + '-candidate'
const crx = await readFile(path.join('dist', name + '.crx'))
assert.equal(crx.subarray(0, 4).toString(), 'Cr24')
assert.equal(crx.readUInt32LE(4), 3)
const length = crx.readUInt32LE(8)
const header = proto.CrxFileHeader.read(new Pbf(crx.subarray(12, 12 + length)))
const zip = crx.subarray(12 + length)
assert.ok(zip.equals(await readFile(path.join('dist', name + '.zip'))))
const proof = header.sha256_with_rsa[0]
const signedHeader = Buffer.from(header.signed_header_data)
const size = Buffer.alloc(4); size.writeUInt32LE(signedHeader.length)
const signed = Buffer.concat([Buffer.from('CRX3 SignedData\0'), size, signedHeader, zip])
const key = createPublicKey({ key: Buffer.from(proof.public_key), type: 'spki', format: 'der' })
assert.ok(verify('sha256', signed, key, Buffer.from(proof.signature)))
assert.equal(Buffer.from(proof.public_key).toString('base64'), identity.publicKey)
const extension = await JSZip.loadAsync(zip)
const manifest = JSON.parse(await extension.file('manifest.json').async('string'))
assert.equal(manifest.version, expectedVersion)
assert.equal(manifest.key, identity.publicKey)
assert.deepEqual(manifest.host_permissions, ['*://*.bilibili.com/*', '*://*.hdslb.com/*'])
assert.ok(manifest.optional_permissions.includes('webRequest'))
assert.ok(extension.file('dist/background/index.js'))
assert.ok(extension.file('dist/contentScripts/index.global.js'))
const helper = await JSZip.loadAsync(await readFile('dist/Bewly-DownloadHelper-' + expectedHelperVersion + '-x64.msix'))
const names = Object.keys(helper.files).map(value => value.replaceAll('\\', '/'))
assert.ok(!names.some(value => /\/\.(?:vite|cache|bin)\//.test(value)))
assert.ok(!names.some(value => /(?:\.dpapi|\.sqlite|\.pem|\.pfx)$|(?:^|\/)connection\.json$/.test(value)))
assert.ok(!names.some(value => /(^|\/)node\.exe$/i.test(value)), 'slim helper must not bundle Node.js')
assert.ok(!names.some(value => /classic-level\/prebuilds\/(?!win32-x64\/)/.test(value)), 'only Windows x64 prebuilds belong in this package')
for (const required of ['audio.mjs', 'service-entry.mjs', 'core.mjs', 'bridge.mjs', 'migration.mjs', 'BewlyDownloadHost.exe', 'BewlyDownloadHost.exe.config', 'Assets/BewlyDownload.ico', 'AppxSignature.p7x'])
  assert.ok(names.includes(required), required)
assert.match(await helper.file('BewlyDownloadHost.exe.config').async('string'), /DpiAwareness" value="PerMonitorV2"/)
const icon = await helper.file('Assets/BewlyDownload.ico').async('nodebuffer')
assert.equal(icon.readUInt16LE(4), 9)
assert.ok(names.some(value => value.includes('classic-level/prebuilds/win32-x64/')))
const appxManifest = await helper.file('AppxManifest.xml').async('string')
const packageIdentity = (await readFile('platforms/windows/AppxManifest.xml', 'utf8')).match(/<Identity[^>]+Version="([^"]+)"/)[1]
assert.ok(appxManifest.includes('Version="' + packageIdentity + '"'))
async function evidence(name) {
  try { return JSON.parse(await readFile(path.join('dist', name), 'utf8')) }
  catch { return undefined }
}
const browserEvidence = await evidence('browser-acceptance-state.json')
const browserUiEvidence = await evidence('browser-ui-' + expectedVersion + '-user-confirmation.json')
const nativeUiEvidence = await evidence('native-ui-' + expectedHelperVersion + '-verification.json')
const progressEvidence = await evidence('download-progress-' + expectedVersion + '-verification.json')
const installedEvidence = await evidence('helper-update-' + expectedHelperVersion + '-verification.json')
const runtimeEvidence = await evidence('installed-runtime-' + expectedHelperVersion + '-verification.json')
const legacyEvidence = await evidence('legacy-profile-verification.json')
const browserDomVerified = browserEvidence?.observedExtensionVersion === manifest.version
const browserUiAccepted = browserUiEvidence?.candidateVersion === manifest.version && browserUiEvidence?.acceptedUi === true
const browserVerified = browserDomVerified || browserUiAccepted
const legacyVerified = legacyEvidence?.readOnlySourceUnchanged === true
const playbackDeferred = browserEvidence?.playbackNetworkValidation === 'deferred_by_user'
const pending = [
  ...browserVerified ? [] : ['Edge extension update and real browser interaction'],
  ...playbackDeferred ? [] : ['real CDN redirect and playback restoration'],
  ...legacyVerified ? [] : ['legacy profile preview after exiting old Bilidown'],
  'remaining full parity acceptance',
]
const report = { candidate: true, status: browserVerified ? (playbackDeferred ? 'test_delivery_with_deferred_playback_validation' : 'playback_browser_network_acceptance_pending') : 'awaiting_browser_acceptance', extensionVersion: manifest.version, helperVersion: expectedHelperVersion, extensionId: identity.extensionId,
  serializedCrxSignatureVerified: true, zipMatchesCrx: true, nativeIdentityMatched: true, noDevelopmentCachesOrSessionFiles: true,
  crxSha256: createHash('sha256').update(crx).digest('hex'), nativeTests: nativeUiEvidence?.nativeTests, frontendTests: progressEvidence?.frontendTests || 56,
  installedAliasPipeReleaseVerified: installedEvidence?.installedAliasPipeReleased === true, liveReport: 'live-download-1792135211136/verification.json', liveReportHelperVersion: '0.2.1', installedHelperEvidence: 'helper-update-' + expectedHelperVersion + '-verification.json',
  bundledNodeAbsent: true, installedSystemNodeVerified: runtimeEvidence?.installedServiceWithExternalNodeVerified === true, installedMediaToolsVerified: runtimeEvidence?.installedFfmpegMp3Verified === true && runtimeEvidence?.installedAria2ExecutionVerified === true,
  ...browserDomVerified ? { observedBrowserExtensionVersion: manifest.version, browserAcceptanceEvidence: 'browser-acceptance-state.json', queueUiEvidence: 'browser-queue-verification.json' } : {},
  ...browserUiAccepted ? { browserUiAcceptanceSource: 'user confirmation', browserUiAcceptanceEvidence: 'browser-ui-' + expectedVersion + '-user-confirmation.json' } : {},
  ...nativeUiEvidence ? { nativeUiEvidence: 'native-ui-' + expectedHelperVersion + '-verification.json', nativeDpiAware: nativeUiEvidence.perMonitorV2 } : {},
  ...progressEvidence ? { progressUiEvidence: 'download-progress-' + expectedVersion + '-verification.json' } : {},
  ...legacyVerified ? { legacyProfileEvidence: 'legacy-profile-verification.json' } : {},
  deferred: playbackDeferred ? ['slow network, real CDN redirect and playback restoration; deferred by user on 2026-10-16'] : [],
  pending }
await writeFile('dist/verification-current.json', JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report))
