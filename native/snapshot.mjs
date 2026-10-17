import { renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { uiTask } from './ui-task.mjs'
export { uiTask } from './ui-task.mjs'

// UI-only projection: never include prepared stream URLs, cookies or RPC tokens.
export function writeUiSnapshot(directory, health, tasks, counts) {
  const items = []
  let size = 0
  for (const task of tasks.slice(0, 200)) {
    const item = uiTask(task)
    size += Buffer.byteLength(JSON.stringify(item))
    if (size > 650000) break
    items.push(item)
  }
  const target = path.join(directory, 'ui-snapshot.json')
  const value = { health, items, counts, syncedAt: new Date().toISOString() }
  writeFileSync(target + '.tmp', JSON.stringify(value), { mode: 0o600 })
  renameSync(target + '.tmp', target)
}
