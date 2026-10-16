import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const helper = process.env.BEWLY_NATIVE_TEST_ROOT || path.join(root, 'dist/helper-msix')

test('packaged desktop UI is DPI-aware and renders both themes without starting the service', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'bewly-desktop-ui-'))
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()))
    assert.ok(path.basename(directory).startsWith('bewly-desktop-ui-'))
    await rm(directory, { recursive: true, force: true })
  })
  const result = spawnSync(path.join(helper, 'BewlyDownloadHost.exe'), ['--tray-preview', directory], {
    env: { ...process.env, BEWLY_DOWNLOAD_DATA: path.join(directory, 'unused-service-data') },
    windowsHide: true, encoding: 'utf8', timeout: 15000,
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  const diagnostics = JSON.parse(result.stdout)
  assert.equal(diagnostics.perMonitorV2, true)
  assert.ok(diagnostics.controlDpi >= 96)
  assert.equal(diagnostics.renderDpi, diagnostics.controlDpi)
  assert.equal(diagnostics.menuWidth, Math.round(268 * diagnostics.controlDpi / 96))
  assert.equal(diagnostics.menuHeight, Math.round(272 * diagnostics.controlDpi / 96))
  assert.equal(diagnostics.menuItemCount, 9)
  assert.equal(diagnostics.allItemsFit, true, 'real menu control must contain all owner-drawn rows')
  const files = await readdir(directory)
  assert.equal(files.length, 8, 'preview must not create service data or start a downloader')
  for (const dpi of [96, 120, 144, 192]) for (const theme of ['light', 'dark']) {
    const png = readFileSync(path.join(directory, `tray-${dpi}-${theme}.png`))
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    assert.equal(png.readUInt32BE(16), Math.round(280 * dpi / 96))
    assert.equal(png.readUInt32BE(20), Math.round(284 * dpi / 96))
    const density = png.indexOf(Buffer.from('pHYs'))
    assert.ok(density > 0)
    assert.ok(Math.abs(png.readUInt32BE(density + 4) * 0.0254 - dpi) < 1)
  }
  const ico = readFileSync(path.join(helper, 'Assets/BewlyDownload.ico'))
  assert.equal(ico.readUInt16LE(2), 1)
  const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, index) => ico[6 + index * 16] || 256)
  assert.deepEqual(sizes, [16, 20, 24, 32, 40, 48, 64, 128, 256])
  for (let i = 0; i < sizes.length; i++) {
    const offset = ico.readUInt32LE(6 + i * 16 + 12)
    assert.equal(ico.readUInt32BE(offset + 16), sizes[i])
  }
  assert.match(readFileSync(path.join(helper, 'BewlyDownloadHost.exe.config'), 'utf8'), /DpiAwareness" value="PerMonitorV2"/)
})
