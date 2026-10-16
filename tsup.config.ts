import path from 'node:path'
import process from 'node:process'

import fs from 'fs-extra'
import { defineConfig } from 'tsup'

import { isDev, isFirefox, isSafari } from './scripts/utils'

const outDir = process.env.BEWLY_BUILD_DIR ? path.join(process.env.BEWLY_BUILD_DIR, 'dist') : isFirefox ? 'extension-firefox/dist' : isSafari ? 'extension-safari/dist' : 'extension/dist'

export default defineConfig(() => ({
  entry: {
    'background/index': './src/background/index.ts',
    ...(isDev ? { mv3client: './scripts/client.ts' } : {}),
  },
  async onSuccess() {
    fs.copySync(path.resolve(__dirname, './src/inject/index.js'), path.resolve(outDir, 'inject/index.js'))
  },
  outDir,
  format: ['esm'],
  target: 'esnext',
  ignoreWatch: ['**/extension/**', '**/extension-firefox/**', '**/extension-safari/**'],
  splitting: false,
  sourcemap: false, // https://github.com/vitejs/vite-plugin-vue/issues/35
  define: {
    '__DEV__': JSON.stringify(isDev),
    'process.env.NODE_ENV': JSON.stringify(isDev ? 'development' : 'production'),
    'process.env.FIREFOX': isFirefox ? 'true' : 'false',
  },
  platform: 'browser',
  minifyWhitespace: !isDev,
  minifySyntax: !isDev,
}))
