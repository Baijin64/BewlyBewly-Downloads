import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'

import { sharedConfig } from '../../../vite.config'

const here = path.dirname(fileURLToPath(import.meta.url))
export default defineConfig({
  ...sharedConfig,
  root: here,
  resolve: { alias: { '~/': `${path.resolve(here, '../../../src')}/`, 'webextension-polyfill': path.join(here, 'browser.mjs') } },
  optimizeDeps: { include: ['vue', '@vueuse/core'], exclude: ['webextension-polyfill', 'vue-demi'] },
  server: { host: '127.0.0.1', port: 5187, strictPort: true },
})
