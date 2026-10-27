import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { platform } from '../platform/index.mjs'
import { register, unregister } from './register.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dataDirectory = platform.dataDirectory()
const descriptor = path.join(dataDirectory, 'connection.json')

function serviceRunning() {
  if (!existsSync(descriptor)) return undefined
  try {
    const { pid, port, token } = JSON.parse(readFileSync(descriptor, 'utf8'))
    return { pid, port, token }
  } catch { return undefined }
}

async function health(service) {
  const response = await fetch(`http://127.0.0.1:${service.port}/rpc`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${service.token}` },
    body: JSON.stringify({ method: 'health' }),
    signal: AbortSignal.timeout(2000),
  })
  return response.json()
}

export async function run(argv) {
  const [command, ...rest] = argv
  switch (command) {
    case 'register': {
      const files = register({ root })
      console.log(`已注册 ${files.length} 个浏览器清单`)
      return 0
    }
    case 'unregister': {
      console.log(`已移除 ${unregister().length} 个浏览器清单`)
      return 0
    }
    case 'first-run': {
      if (!platform.supports.tray) process.env.BEWLY_DOWNLOAD_HEADLESS = '1'
      const files = register({ root })
      const { pid } = platform.startService({ root, dataDirectory, mode: 'manual' })
      console.log(`已注册 ${files.length} 个浏览器清单，服务进程 ${pid}`)
      console.log(platform.installHint)
      return 0
    }
    case 'start': {
      const existing = serviceRunning()
      if (existing && existing.pid) { console.log(`服务已在运行（${existing.pid}）`); return 0 }
      const { pid } = platform.startService({ root, dataDirectory, mode: 'manual' })
      console.log(`服务进程 ${pid}`)
      return 0
    }
    case 'stop': {
      const service = serviceRunning()
      if (!service?.pid) { console.log('服务未在运行'); return 0 }
      platform.killPid(service.pid)
      console.log(`已停止 ${service.pid}`)
      return 0
    }
    case 'status': {
      const service = serviceRunning()
      if (!service) { console.log('服务未在运行'); return 1 }
      try {
        const reply = await health(service)
        console.log(JSON.stringify(reply.result ?? reply, null, 2))
        return reply.ok ? 0 : 1
      } catch (error) { console.log('无法连接服务：' + error.message); return 1 }
    }
    case 'install-node': {
      const { ensureNode } = await import('../runtime/node-install.mjs')
      const node = await ensureNode({ dataDirectory })
      console.log(node)
      return 0
    }
    case 'open': {
      const url = 'https://www.bilibili.com/?page=Downloads&downloadConnect=1'
      const command = process.platform === 'darwin' ? 'open' : 'xdg-open'
      spawn(command, [url], { stdio: 'ignore', detached: true }).unref()
      return 0
    }
    default:
      console.error('用法: launcher.sh [register|unregister|first-run|start|stop|status|install-node|open]')
      return 2
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then(code => { process.exitCode = code }).catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
