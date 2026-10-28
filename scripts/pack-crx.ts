import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { createHash, verify, X509Certificate } from 'node:crypto'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

interface HelperIdentity {
  extensionId: string
  publicKey: string
  signingCertificateThumbprint?: string
  legacyExtensionIds?: string[]
}

interface ExtensionManifest {
  version: string
  key?: string
}

interface CrxReport {
  format: string
  version: string
  extensionId: string
  signatureVerified: boolean
  bytes: number
  sha256: string
  zipSha256: string
  helperIdentityMatched: boolean
  signingUsesWindowsKeyProvider: boolean
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceArg = process.argv.indexOf('--source')
const nameArg = process.argv.indexOf('--name')
const extensionRoot = path.resolve(
  root,
  sourceArg >= 0 ? process.argv[sourceArg + 1] : 'extension',
)
const outputName = nameArg >= 0 ? process.argv[nameArg + 1] : 'BewlyBewly-Downloads-Chrome'
if (!outputName || !/^[A-Z0-9][\w.-]*$/i.test(outputName))
  throw new Error('Invalid package name')

const certificate = new X509Certificate(
  readFileSync(path.join(root, 'dist/BewlyDownload-Development.cer')),
)
const publicKey = certificate.publicKey.export({ type: 'spki', format: 'der' }) as Buffer
const hash = createHash('sha256').update(publicKey).digest()
const extensionId = hash
  .subarray(0, 16)
  .toString('hex')
  .replace(/[0-9a-f]/g, character => String.fromCharCode(97 + Number.parseInt(character, 16)))
const thumbprint = certificate.fingerprint.replaceAll(':', '')
const identityPath = path.join(root, 'platforms/identity.json')
const identity = JSON.parse(readFileSync(identityPath, 'utf8')) as HelperIdentity

if (process.argv.includes('--prepare')) {
  const legacyExtensionIds = [
    ...new Set([...(identity.legacyExtensionIds ?? []), identity.extensionId]),
  ].filter(id => id !== extensionId)
  writeFileSync(
    identityPath,
    `${JSON.stringify(
      {
        extensionId,
        publicKey: publicKey.toString('base64'),
        signingCertificateThumbprint: thumbprint,
        legacyExtensionIds,
      },
      null,
      2,
    )}\n`,
  )
  console.log(JSON.stringify({ extensionId, compatiblePreviousIds: legacyExtensionIds }))
}
else {
  if (identity.extensionId !== extensionId || identity.publicKey !== publicKey.toString('base64'))
    throw new Error('Run npm run prepare:crx, npm run build and rebuild the helper first.')
  const manifest = JSON.parse(
    readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'),
  ) as ExtensionManifest
  const helperIdentity = JSON.parse(
    readFileSync(path.join(root, 'dist/helper-msix/identity.json'), 'utf8'),
  ) as HelperIdentity
  if (manifest.key !== identity.publicKey || helperIdentity.extensionId !== extensionId) {
    throw new Error(
      'Extension manifest and native helper identities do not match the signing certificate.',
    )
  }
  const require = createRequire(import.meta.url)
  const ChromeExtension = require('crx')
  const crxRequire = createRequire(require.resolve('crx'))
  const Pbf = crxRequire('pbf')
  const proto = crxRequire('./crx3.js.pb')
  const packer = new ChromeExtension({ rootDirectory: extensionRoot })
  copyFileSync(path.join(root, 'LICENSE'), path.join(extensionRoot, 'LICENSE.txt'))
  await packer.load()
  const zip: Buffer = await packer.loadContents()
  let pb = new Pbf()
  proto.SignedData.write({ crx_id: hash.subarray(0, 16) }, pb)
  const signedHeader = Buffer.from(pb.finish())
  const size = Buffer.alloc(4)
  size.writeUInt32LE(signedHeader.length)
  const signedBytes = Buffer.concat([Buffer.from('CRX3 SignedData\0'), size, signedHeader, zip])
  const signing = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(root, 'scripts/sign-crx.ps1'),
      '-Thumbprint',
      thumbprint,
    ],
    { input: signedBytes, windowsHide: true, encoding: 'utf8', maxBuffer: 128 * 1024 },
  )
  if (signing.status !== 0 || signing.error)
    throw new Error(`Windows CRX signing failed: ${signing.stderr || signing.error?.message}`)
  const signature = Buffer.from(signing.stdout.trim(), 'base64')
  if (!verify('sha256', signedBytes, certificate.publicKey, signature))
    throw new Error('CRX signature verification failed')
  pb = new Pbf()
  proto.CrxFileHeader.write(
    { sha256_with_rsa: [{ public_key: publicKey, signature }], signed_header_data: signedHeader },
    pb,
  )
  const header = Buffer.from(pb.finish())
  const prefix = Buffer.alloc(12)
  prefix.write('Cr24', 0)
  prefix.writeUInt32LE(3, 4)
  prefix.writeUInt32LE(header.length, 8)
  const result = Buffer.concat([prefix, header, zip])
  const output = path.join(root, 'dist', `${outputName}.crx`)
  writeFileSync(output, result)
  writeFileSync(path.join(root, 'dist', `${outputName}.zip`), zip)
  const report: CrxReport = {
    format: 'CRX3',
    version: manifest.version,
    extensionId,
    signatureVerified: true,
    bytes: result.length,
    sha256: createHash('sha256').update(result).digest('hex'),
    zipSha256: createHash('sha256').update(zip).digest('hex'),
    helperIdentityMatched: true,
    signingUsesWindowsKeyProvider: true,
  }
  writeFileSync(
    path.join(
      root,
      'dist',
      nameArg >= 0 ? `${outputName}-verification.json` : 'crx-verification.json',
    ),
    `${JSON.stringify(report, null, 2)}\n`,
  )
  console.log(JSON.stringify({ path: output, ...report }))
}
