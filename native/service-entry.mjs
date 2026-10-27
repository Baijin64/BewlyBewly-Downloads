import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

import { platform } from './platform/index.mjs'

// No inherited console/pipe handles are needed by this daemon. Bootstrap logging
// also captures module-loading errors before service.mjs can install its handlers.
const data = platform.dataDirectory()
try {
  const { startService } = await import('./service.mjs')
  await startService()
}
catch (error) {
  try { mkdirSync(data, { recursive: true }); appendFileSync(path.join(data, 'startup.log'), new Date().toISOString() + ' ' + error.message + '\n') } catch {}
  process.exitCode = 1
}
