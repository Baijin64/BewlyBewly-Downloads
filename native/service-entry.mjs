import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

// No inherited console/pipe handles are needed by this daemon. Bootstrap logging
// also captures module-loading errors before service.mjs can install its handlers.
const data = process.env.BEWLY_DOWNLOAD_DATA || path.join(process.env.LOCALAPPDATA || process.env.TEMP || '.', 'BewlyDownload')
try {
  const { startService } = await import('./service.mjs')
  await startService()
}
catch (error) {
  try { mkdirSync(data, { recursive: true }); appendFileSync(path.join(data, 'startup.log'), new Date().toISOString() + ' ' + error.message + '\n') } catch {}
  process.exitCode = 1
}
