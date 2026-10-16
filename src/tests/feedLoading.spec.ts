import { expect, it, vi } from 'vitest'

import { FeedLoader } from '~/loading/feed'

const filled = () => Promise.resolve(false)
function fixture(page: (cursor: number, signal: AbortSignal) => Promise<any>) {
  const io = { page: vi.fn(page), key: (item: { id: number }) => String(item.id), changed: vi.fn(), error: vi.fn() }
  return { loader: new FeedLoader(io), io }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => resolve = done)
  return { promise, resolve }
}

it('shares one loading cycle across repeated scroll events and bounds autofill', async () => {
  const first = deferred<any>()
  const { loader, io } = fixture(async cursor => cursor === 1 ? first.promise : { items: [{ id: cursor }], next: cursor + 1 })
  const a = loader.load({ needsMore: filled })
  const b = loader.load({ needsMore: filled })
  expect(a).toBe(b)
  first.resolve({ items: [{ id: 1 }], next: 2 })
  await a
  expect(io.page).toHaveBeenCalledTimes(3)
  expect(loader.items).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
  expect(loader.loading).toBe(false)
})

it('stops immediately on an exhausted server page', async () => {
  const { loader, io } = fixture(async () => ({ items: [], next: 1, done: true }))
  await loader.load({ needsMore: filled })
  await loader.load({ needsMore: filled })
  expect(io.page).toHaveBeenCalledTimes(1)
  expect(loader.done).toBe(true)
})

it('stops filtered or repeated pages without an unbounded request loop', async () => {
  const { loader, io } = fixture(async cursor => ({ items: [], next: cursor + 100 }))
  await loader.load({ needsMore: () => Promise.resolve(true) })
  expect(io.page.mock.calls.map(([cursor]) => cursor)).toEqual([1, 101])
  expect(loader.cursor).toBe(201)
})

it('deduplicates repeated videos while preserving original card references', async () => {
  const original = { id: 1 }
  const { loader } = fixture(async cursor => ({ items: cursor === 1 ? [original] : [{ id: 1 }, { id: 2 }], next: cursor + 1 }))
  await loader.load({ needsMore: filled, maxPages: 1 })
  await loader.load({ needsMore: filled, maxPages: 1 })
  expect(loader.items).toEqual([{ id: 1 }, { id: 2 }])
  expect(loader.items[0]).toBe(original)
})

it('leaves a failed cursor retryable and never retries automatically', async () => {
  const { loader, io } = fixture(async () => {
    throw new Error('offline')
  })
  await loader.load({ needsMore: filled })
  expect(io.page).toHaveBeenCalledTimes(1)
  expect(loader.cursor).toBe(1)
  expect(io.error).toHaveBeenCalledTimes(1)
  await loader.load({ needsMore: filled })
  expect(io.page.mock.calls.map(([cursor]) => cursor)).toEqual([1, 1])
})

it('refresh aborts old requests and ignores late replies from the previous generation', async () => {
  const old = deferred<any>()
  const { loader, io } = fixture(async () => old.promise)
  const previous = loader.load({ needsMore: filled })
  await Promise.resolve()
  const oldSignal = io.page.mock.calls[0][1]
  loader.reset()
  io.page.mockImplementation(async () => ({ items: [{ id: 2 }], next: 2 }))
  await loader.load({ needsMore: filled, maxPages: 1 })
  old.resolve({ items: [{ id: 1 }], next: 99 })
  await previous
  expect(oldSignal.aborted).toBe(true)
  expect(loader.items).toEqual([{ id: 2 }])
  expect(loader.cursor).toBe(2)
})

it('inactive cached pages stop requests and retain their existing cards', async () => {
  const { loader, io } = fixture(async cursor => ({ items: [{ id: cursor }], next: cursor + 1 }))
  await loader.load({ needsMore: filled, maxPages: 1 })
  loader.pause()
  await loader.load({ needsMore: filled })
  expect(io.page).toHaveBeenCalledTimes(1)
  loader.resume()
  await loader.load({ needsMore: filled, maxPages: 1 })
  expect(loader.items).toEqual([{ id: 1 }, { id: 2 }])
})
