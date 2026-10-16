import assert from 'node:assert/strict'
import test from 'node:test'

import { CompletionPolicy } from '../completion.mjs'

test('shutdown requires this run to succeed, an empty pending queue, and 30 seconds', () => {
  const policy = new CompletionPolicy()
  assert.equal(policy.evaluate([{ id: 'old', status: 'completed' }], true, 100), 0)
  policy.begin([]); policy.started({ id: 'one' }); policy.finished()
  const completed = [{ id: 'one', status: 'completed' }]
  assert.equal(policy.evaluate(completed, false, 100), 0)
  assert.equal(policy.evaluate(completed, true, 100), 30100)
  assert.equal(policy.evaluate(completed, true, 1100), 30100)
  assert.equal(policy.evaluate([...completed, { id: 'later', status: 'pending' }], true, 2100), 0)
})

test('paused, failed, cancelled, removed and processing jobs never trigger shutdown', () => {
  for (const status of ['pending', 'paused', 'failed', 'cancelled', 'queued', 'muxing', 'postprocessing']) {
    const policy = new CompletionPolicy()
    policy.started({ id: 'one' })
    assert.equal(policy.evaluate([{ id: 'one', status }], true, 100), 0)
  }
  const policy = new CompletionPolicy()
  policy.started({ id: 'removed' })
  assert.equal(policy.evaluate([], true, 100), 0)
  const incomplete = new CompletionPolicy()
  incomplete.started({ id: 'one' })
  assert.equal(incomplete.evaluate([{ id: 'one', status: 'completed', warnings: ['字幕下载失败'] }], true, 100), 0)
})

test('cancelling shutdown suppresses it until a new explicit run', () => {
  const policy = new CompletionPolicy()
  policy.started({ id: 'one' })
  const tasks = [{ id: 'one', status: 'completed' }]
  assert.equal(policy.evaluate(tasks, true, 100), 30100)
  policy.cancel()
  assert.equal(policy.evaluate(tasks, true, 100000), 0)
  policy.begin(tasks)
  policy.started({ id: 'two' })
  assert.equal(policy.evaluate([...tasks, { id: 'two', status: 'completed' }], true, 100000), 130000)
})
