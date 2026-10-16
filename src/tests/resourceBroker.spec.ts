import { expect, it, vi } from 'vitest'

import { previewExpiry, ResourceBroker } from '~/loading/broker'

const preview = { preview: true, ttl: () => 30000 }
const foreground = { preview: false, ttl: () => 0 }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => resolve = done)
  return { promise, resolve }
}
async function flush() {
  await Promise.resolve()
  await Promise.resolve()
}

it('shares identical requests but cancelling one caller preserves other callers', async () => {
  const broker = new ResourceBroker()
  const data = deferred<any>()
  let signal!: AbortSignal
  const load = vi.fn((value: AbortSignal) => {
    signal = value
    return data.promise
  })
  const one = broker.request('tab:video', 'tab:a', load, preview)
  const two = broker.request('tab:video', 'tab:b', load, preview)
  const cancelled = expect(one).rejects.toHaveProperty('name', 'AbortError')
  broker.cancel('tab:a')
  await cancelled
  expect(signal.aborted).toBe(false)
  data.resolve({ code: 0, title: 'Shared' })
  expect(await two).toEqual({ code: 0, title: 'Shared' })
  expect(load).toHaveBeenCalledTimes(1)
})

it('cancels the underlying request when its last caller leaves', async () => {
  const broker = new ResourceBroker()
  let signal!: AbortSignal
  const result = broker.request('a', 'tab:a', async (value) => {
    signal = value
    return new Promise((_resolve, reject) => value.addEventListener('abort', () => reject(new DOMException('', 'AbortError'))))
  }, preview)
  const cancelled = expect(result).rejects.toHaveProperty('name', 'AbortError')
  broker.cancel('tab:a')
  await cancelled
  expect(signal.aborted).toBe(true)
})

it('limits previews to two concurrent calls and leaves capacity for foreground requests', async () => {
  const broker = new ResourceBroker()
  const data = deferred<any>()
  const load = vi.fn(async () => data.promise)
  const a = broker.request('p1', 'p1', load, preview)
  const b = broker.request('p2', 'p2', load, preview)
  const queuedLoad = vi.fn(async () => 'cancelled-preview')
  const c = broker.request('p3', 'p3', queuedLoad, preview)
  expect(load).toHaveBeenCalledTimes(2)
  expect(queuedLoad).not.toHaveBeenCalled()
  expect(await broker.request('feed', 'feed', async () => 'feed-result', foreground)).toBe('feed-result')
  const cancelled = expect(c).rejects.toHaveProperty('name', 'AbortError')
  broker.cancel('p3')
  await cancelled
  data.resolve('done')
  await Promise.all([a, b])
  expect(queuedLoad).not.toHaveBeenCalled()
})

it('expires short-lived metadata and never caches recommendations or errors', async () => {
  let now = 1000
  const broker = new ResourceBroker(() => now)
  const load = vi.fn(async () => ({ code: 0, value: 'cached' }))
  const a = await broker.request('info', 'a', load, preview)
  a.value = 'mutated by caller'
  expect((await broker.request('info', 'b', load, preview)).value).toBe('cached')
  expect(load).toHaveBeenCalledTimes(1)
  now += 30001
  await broker.request('info', 'c', load, preview)
  expect(load).toHaveBeenCalledTimes(2)
  await broker.request('feed', 'd', load, foreground)
  await broker.request('feed', 'e', load, foreground)
  expect(load).toHaveBeenCalledTimes(4)
  const failed = vi.fn(async () => {
    throw new Error('network')
  })
  await expect(broker.request('failed', 'f', failed, preview)).rejects.toThrow('network')
  await expect(broker.request('failed', 'g', failed, preview)).rejects.toThrow('network')
  expect(failed).toHaveBeenCalledTimes(2)
})

it('clears cached account data and queued requests without starting cancelled jobs', async () => {
  const broker = new ResourceBroker()
  const data = deferred<any>()
  const load = vi.fn(async () => data.promise)
  const promises = ['a', 'b', 'c'].map(id => broker.request(`tab:${id}`, `tab:${id}`, load, preview))
  const cancelled = promises.map(p => expect(p).rejects.toHaveProperty('name', 'AbortError'))
  broker.clear('tab:')
  await Promise.all(cancelled)
  expect(load).toHaveBeenCalledTimes(2)
  data.resolve('old-account')
  await flush()
  expect(await broker.request('tab:a', 'new', async () => 'new-account', preview)).toBe('new-account')
})

it('never retains a preview URL past its signed expiry', () => {
  expect(previewExpiry('https://cdn.bilivideo.com/v?deadline=120', 100000)).toBe(110000)
  expect(previewExpiry('https://cdn.bilivideo.com/v?deadline=90', 100000)).toBeLessThan(100000)
  expect(previewExpiry('https://cdn.bilivideo.com/v', 100000)).toBe(130000)
  expect(previewExpiry('invalid', 100000)).toBe(100000)
})
