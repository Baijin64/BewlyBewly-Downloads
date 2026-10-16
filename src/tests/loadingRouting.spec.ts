import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ add: vi.fn(), removed: vi.fn(), cookieChanged: vi.fn(), cookies: vi.fn() }))
vi.mock('webextension-polyfill', () => ({ default: {
  runtime: { id: 'extension-id', onMessage: { addListener: mock.add } },
  tabs: { onRemoved: { addListener: mock.removed } },
  cookies: { getAll: mock.cookies, onChanged: { addListener: mock.cookieChanged } },
} }))
let handler: (message: any, sender: any) => any
const sender = { id: 'extension-id', url: 'https://www.bilibili.com/', tab: { id: 7 }, frameId: 0, documentId: 'document' }
const message = (id: string, method = 'getVideoInfo') => ({ bewlyResource: true, method, id, params: { bvid: 'BV17x411w7KC' } })
beforeEach(async () => {
  vi.resetModules()
  mock.add.mockClear()
  const { setupLoadingMessages } = await import('~/background/loading')
  setupLoadingMessages()
  handler = mock.add.mock.calls[0][0]
})
afterEach(() => {
  vi.unstubAllGlobals()
})

it('does not claim other listeners and refuses unknown methods and foreign senders', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  expect(handler({ bewlyDownload: true }, sender)).toBeUndefined()
  expect(handler({ bewlyPlayback: true }, sender)).toBeUndefined()
  expect(await handler(message('one', 'configure'), sender)).toMatchObject({ ok: false })
  expect(await handler(message('two'), { ...sender, url: 'https://unrelated.example' })).toMatchObject({ ok: false })
  expect(fetch).not.toHaveBeenCalled()
})

it('uses fixed official endpoints, caches metadata, and keeps control fields out of URLs', async () => {
  const fetch = vi.fn(async (_url: URL, _options: RequestInit) => ({ ok: true, json: async () => ({ code: 0, data: { cid: 42 } }) }))
  vi.stubGlobal('fetch', fetch)
  expect(await handler(message('one'), sender)).toEqual({ ok: true, result: { code: 0, data: { cid: 42 } } })
  await handler(message('two'), sender)
  expect(fetch).toHaveBeenCalledTimes(1)
  const url = new URL(String(fetch.mock.calls[0][0]))
  expect(url.origin).toBe('https://api.bilibili.com')
  expect(url.searchParams.has('id')).toBe(false)
  expect(url.searchParams.has('bewlyResource')).toBe(false)
  expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
})

it('invalidates account metadata and isolates different tabs', async () => {
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ code: 0, data: { cid: 42 } }) }))
  vi.stubGlobal('fetch', fetch)
  await handler(message('one'), sender)
  await handler(message('two'), { ...sender, tab: { id: 8 } })
  expect(fetch).toHaveBeenCalledTimes(2)
  mock.cookieChanged.mock.calls.at(-1)![0]({ cookie: { domain: '.bilibili.com', name: 'SESSDATA' } })
  await handler(message('three'), sender)
  expect(fetch).toHaveBeenCalledTimes(3)
})

it('cancellation from another frame cannot abort the owner request', async () => {
  let signal!: AbortSignal
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    signal = options.signal
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('', 'AbortError'))))
  }))
  const result = handler(message('one'), sender)
  await handler({ bewlyResource: true, method: 'cancel', id: 'one' }, { ...sender, frameId: 2 })
  expect(signal.aborted).toBe(false)
  await handler({ bewlyResource: true, method: 'cancel', id: 'one' }, sender)
  expect(signal.aborted).toBe(true)
  expect(await result).toEqual({ ok: false, aborted: true })
})
