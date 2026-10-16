import { beforeEach, expect, it, vi } from 'vitest'

function event() {
  const listeners: ((...args: any[]) => any)[] = []
  return {
    listeners,
    addListener: vi.fn((listener: (...args: any[]) => any) => {
      listeners.push(listener)
    }),
  }
}
const mock = vi.hoisted(() => ({ browser: {} as any, api: vi.fn() }))
vi.mock('webextension-polyfill', () => ({ default: mock.browser }))
vi.mock('~/background/downloadResolver', () => ({ biliApi: mock.api }))
const primary
  = 'https://primary.bilivideo.com/video-80-avc.m4s?deadline=9999999999'
const backup
  = 'https://backup.bilivideo.com/video-80-avc.m4s?deadline=9999999999'
const sender = {
  id: 'fixture',
  url: 'https://www.bilibili.com/video/BV17x411w7KC/',
  tab: { id: 42 },
}
let handler: (...args: any[]) => any
let rules: Map<number, any>
let storage: Record<string, any>

beforeEach(async () => {
  vi.resetModules()
  rules = new Map([
    [12, { id: 12 }],
    [7600001, { id: 7600001 }],
  ])
  storage = {}
  mock.api.mockReset()
  mock.api.mockImplementation(async (endpoint: string) =>
    endpoint.includes('view')
      ? { pages: [{ page: 1, cid: 42 }] }
      : {
          dash: {
            video: [
              {
                id: 80,
                codecid: 7,
                bandwidth: 100,
                baseUrl: primary,
                backupUrl: [backup],
              },
            ],
          },
        },
  )
  Object.assign(mock.browser, {
    runtime: { id: 'fixture', onMessage: event() },
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storage[key] })),
        set: vi.fn(async (value: object) => {
          Object.assign(storage, value)
        }),
      },
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      onChanged: event(),
    },
    permissions: {
      contains: vi.fn(async () => true),
      request: vi.fn(async () => true),
      onRemoved: event(),
    },
    tabs: { onRemoved: event(), onUpdated: event() },
    alarms: {
      onAlarm: event(),
      create: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    },
    webRequest: {
      onBeforeRequest: event(),
      onCompleted: event(),
      onErrorOccurred: event(),
    },
    declarativeNetRequest: {
      getSessionRules: vi.fn(async () => [...rules.values()]),
      isRegexSupported: vi.fn(async () => ({ isSupported: true })),
      updateSessionRules: vi.fn(
        async ({ removeRuleIds = [], addRules = [] }) => {
          for (const id of removeRuleIds) rules.delete(id)
          for (const rule of addRules) rules.set(rule.id, rule)
        },
      ),
    },
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('primary'))
        await new Promise(resolve => setTimeout(resolve, 30))
      let read = false
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: async () =>
              read
                ? { done: true }
                : ((read = true),
                  { done: false, value: new Uint8Array(131072) }),
            cancel: vi.fn(async () => {}),
          }),
        },
      }
    }),
  )
  const { setupPlaybackMessages } = await import('~/background/playback')
  setupPlaybackMessages()
  handler = mock.browser.runtime.onMessage.listeners[0]
  await handler({ bewlyPlayback: true, method: 'status' }, sender)
})

it('removes orphaned session redirects without touching other extension rules', () => {
  expect(rules.has(7600001)).toBe(false)
  expect(rules.has(12)).toBe(true)
})

it('requests optional access only from the explicit enable action', async () => {
  expect(mock.browser.permissions.request).not.toHaveBeenCalled()
  const reply = handler({ bewlyPlayback: true, method: 'enable' }, sender)
  expect(mock.browser.permissions.request).toHaveBeenCalledTimes(1)
  const request = mock.browser.permissions.request.mock.calls[0][0]
  expect(request.permissions).toEqual(['webRequest'])
  expect(request.origins).not.toContain('<all_urls>')
  expect((await reply).ok).toBe(true)
})

it('does not request permissions or process samples from a foreign page', async () => {
  const reply = await handler(
    { bewlyPlayback: true, method: 'enable' },
    { ...sender, url: 'https://evil.test/' },
  )
  expect(reply.ok).toBe(false)
  expect(mock.browser.permissions.request).not.toHaveBeenCalled()
})

it('applies tab-scoped redirects to observed media and clears them when disabled', async () => {
  await handler({ bewlyPlayback: true, method: 'enable' }, sender)
  const observed = mock.browser.webRequest.onBeforeRequest.listeners[0]
  observed({ tabId: 42, url: primary })
  const reply = await handler(
    {
      bewlyPlayback: true,
      method: 'sample',
      sample: {
        bvid: 'BV17x411w7KC',
        page: 1,
        buffer: 0,
        waitingSeconds: 12,
        playing: true,
        seeking: false,
        visible: true,
        droppedRatio: 0,
      },
    },
    sender,
  )
  expect(reply.ok).toBe(true)
  expect(reply.result.diagnostic.state).toBe('optimized')
  const redirects = [...rules.values()].filter(
    rule => rule.action?.type === 'redirect',
  )
  expect(redirects).toHaveLength(1)
  expect(redirects[0].condition.tabIds).toEqual([42])
  expect(redirects[0].condition.initiatorDomains).toEqual(['bilibili.com'])
  expect(redirects[0].action.redirect.url).toBe(backup)
  const probes
    = mock.browser.declarativeNetRequest.updateSessionRules.mock.calls
      .flatMap(([params]: any) => params.addRules || [])
      .filter((rule: any) => rule.action.type === 'modifyHeaders')
  expect(probes.every((rule: any) => rule.condition.tabIds[0] === -1)).toBe(
    true,
  )
  await handler({ bewlyPlayback: true, method: 'disable' }, sender)
  expect([...rules.values()].filter(rule => rule.id >= 7600000)).toHaveLength(
    0,
  )
  expect(rules.has(12)).toBe(true)
})

const stalled = {
  bewlyPlayback: true,
  method: 'sample',
  sample: {
    bvid: 'BV17x411w7KC',
    page: 1,
    buffer: 0,
    waitingSeconds: 12,
    playing: true,
    seeking: false,
    visible: true,
    droppedRatio: 0,
  },
}

it('does not install a redirect after disable while regex validation is pending', async () => {
  await handler({ bewlyPlayback: true, method: 'enable' }, sender)
  mock.browser.webRequest.onBeforeRequest.listeners[0]({
    tabId: 42,
    url: primary,
  })
  let finish!: (result: { isSupported: boolean }) => void
  mock.browser.declarativeNetRequest.isRegexSupported.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const pending = handler(stalled, sender)
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  await handler({ bewlyPlayback: true, method: 'disable' }, sender)
  finish({ isSupported: true })
  await pending
  expect(
    [...rules.values()].filter(rule => rule.action?.type === 'redirect'),
  ).toHaveLength(0)
})

it('removes a late browser rule commit that finishes after disable', async () => {
  await handler({ bewlyPlayback: true, method: 'enable' }, sender)
  mock.browser.webRequest.onBeforeRequest.listeners[0]({
    tabId: 42,
    url: primary,
  })
  let commit!: () => void
  const update
    = mock.browser.declarativeNetRequest.updateSessionRules.getMockImplementation()!
  mock.browser.declarativeNetRequest.updateSessionRules.mockImplementation(
    async (params: any) => {
      if (
        params.addRules?.some((rule: any) => rule.action.type === 'redirect')
      ) {
        await new Promise<void>((resolve) => {
          commit = resolve
        })
      }
      return update(params)
    },
  )
  const pending = handler(stalled, sender)
  await vi.waitFor(() => expect(commit).toBeTypeOf('function'))
  await handler({ bewlyPlayback: true, method: 'disable' }, sender)
  commit()
  await pending
  expect(
    [...rules.values()].filter(rule => rule.action?.type === 'redirect'),
  ).toHaveLength(0)
})

it('does not resolve streams after disable while video metadata is pending', async () => {
  await handler({ bewlyPlayback: true, method: 'enable' }, sender)
  let finish!: (data: object) => void
  mock.api.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const pending = handler(stalled, sender)
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  await handler({ bewlyPlayback: true, method: 'disable' }, sender)
  finish({ pages: [{ page: 1, cid: 42 }] })
  const reply = await pending
  expect(reply.result.enabled).toBe(false)
  expect(mock.api).toHaveBeenCalledTimes(1)
})

it('aborts outstanding media probes immediately when disabled', async () => {
  await handler({ bewlyPlayback: true, method: 'enable' }, sender)
  mock.browser.webRequest.onBeforeRequest.listeners[0]({
    tabId: 42,
    url: primary,
  })
  const signals: AbortSignal[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: string, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = options.signal as AbortSignal
          signals.push(signal)
          signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          })
        }),
    ),
  )
  const pending = handler(stalled, sender)
  await vi.waitFor(() => expect(signals).toHaveLength(2))
  await handler({ bewlyPlayback: true, method: 'disable' }, sender)
  await pending
  expect(signals.every(signal => signal.aborted)).toBe(true)
  expect([...rules.values()].filter(rule => rule.id >= 7600000)).toHaveLength(
    0,
  )
})

it('does not cache late video metadata after the tab has closed', async () => {
  await handler({ bewlyPlayback: true, method: 'enable' }, sender)
  let finish!: (data: object) => void
  mock.api.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const pending = handler(stalled, sender)
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  mock.browser.tabs.onRemoved.listeners[0](42)
  finish({ pages: [{ page: 1, cid: 42 }] })
  await pending
  expect(mock.api).toHaveBeenCalledTimes(1)
})
