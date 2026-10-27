import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const factory = process.platform === 'win32'
  ? (await import('./win32.mjs')).createPlatform
  : process.platform === 'darwin'
    ? (await import('./darwin.mjs')).createPlatform
    : (await import('./linux.mjs')).createPlatform

export const platform = factory({ packageRoot })
export { packageRoot as root }
