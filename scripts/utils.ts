import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { bgCyan, black } from 'kolorist'

export const port = Number.parseInt(process.env.PORT || '') || 3303
export function r(...args: string[]) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  if (process.env.BEWLY_BUILD_DIR && /^(?:\.\/)?extension(?:\/|$)/.test(args[0] || '')) {
    const relative = args[0].replace(/^(?:\.\/)?extension\/?/, '')
    return resolve(root, process.env.BEWLY_BUILD_DIR, relative, ...args.slice(1))
  }
  return resolve(root, ...args)
}
export const isDev = process.env.NODE_ENV !== 'production'
export const isWin = process.platform === 'win32'
export const isFirefox = process.env.FIREFOX === 'true'
export const isSafari = process.env.SAFARI === 'true'

export function log(name: string, message: string) {
  console.log(black(bgCyan(` ${name} `)), message)
}
