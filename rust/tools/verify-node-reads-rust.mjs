// Verifies that the Node implementation can still read a database written by the
// Rust store, including fields it does not know about.
//
//   node rust/tools/verify-node-reads-rust.mjs <data-directory>

import path from 'node:path'

import { TaskStore } from '../../native/core.mjs'

const directory = process.argv[2]
if (!directory) {
  console.error('usage: node rust/tools/verify-node-reads-rust.mjs <data-directory>')
  process.exit(2)
}

const store = new TaskStore(directory)
const task = store.get('rust-written')
const settings = store.settings()
store.close()

if (!task) {
  console.error('FAIL: Node could not read the task written by Rust')
  process.exit(1)
}
if (task.unknownFutureField?.kept !== true) {
  console.error('FAIL: unknown field was dropped:', JSON.stringify(task))
  process.exit(1)
}
if (task.title !== 'Rust 写入的任务' || task.status !== 'pending') {
  console.error('FAIL: task content changed:', JSON.stringify(task))
  process.exit(1)
}
if (settings.maxConcurrent !== 3) {
  console.error('FAIL: settings not visible to Node:', JSON.stringify(settings))
  process.exit(1)
}

console.log('OK: Node read the Rust-written task and settings')
console.log(JSON.stringify({ id: task.id, title: task.title, status: task.status, maxConcurrent: settings.maxConcurrent }))
