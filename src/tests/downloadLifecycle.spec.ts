import { beforeEach, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ native: vi.fn(), listener: vi.fn(), get: vi.fn(), set: vi.fn(), cookies: vi.fn(), inspect: vi.fn(), values: {} as Record<string, any> }))
vi.mock('webextension-polyfill', () => ({ default: {
  runtime: { id: 'fixture-extension', onMessage: { addListener: mock.listener } },
  storage: { local: { get: mock.get, set: mock.set } },
  cookies: { getAll: mock.cookies },
} }))
vi.mock('~/background/nativeDownloadClient', () => ({ requestNativeDownload: mock.native }))
vi.mock('~/background/downloadResolver', () => ({ inspectDownload: mock.inspect, inspectFormats: vi.fn(async () => ({ video: [], audio: [] })), inspectQualities: vi.fn(), inspectSubtitles: vi.fn(), resolveDownload: vi.fn(), biliApi: vi.fn() }))
let handler: (message: any, sender: any) => Promise<any>
const sender = { id: 'fixture-extension', url: 'https://www.bilibili.com/video/BV17x411w7KC' }
const health = { version: '0.2.8', protocol: 2, capabilities: ['audio-highest', 'on-demand'], engineInstalled: true, settings: { directory: 'C:\\Videos', maxConcurrent: 4, defaultOptions: { filenameTemplate: '%title%', folderTemplate: '', outputs: ['video'] }, features: {} } }
const pending = { id: 'fixture', bvid: 'BV17x411w7KC', cid: 42, title: 'Fixture', part: 'Fixture', status: 'pending', options: { filenameTemplate: '%title%', folderTemplate: '', outputs: ['video'] } }
const snapshot = { health, items: [pending], counts: { pending: 1, active: 0, completed: 0, failed: 0 }, syncedAt: '2026-10-16T12:00:00Z' }
const send = (method: string, params: object = {}) => handler({ bewlyDownload: true, method, params }, sender)
beforeEach(async () => {
  vi.resetModules()
  mock.values = {}
  mock.listener.mockClear()
  mock.native.mockReset()
  mock.get.mockImplementation(async key => ({ [key]: mock.values[key] }))
  mock.set.mockImplementation(async data => Object.assign(mock.values, structuredClone(data)))
  mock.cookies.mockResolvedValue([])
  mock.inspect.mockResolvedValue({ bvid: pending.bvid, title: 'Fixture', author: 'UP', pages: [{ cid: 42, page: 1, title: 'Fixture' }] })
  mock.native.mockImplementation(async message => message.method === 'uiSnapshot' ? { ok: true, result: structuredClone(snapshot) } : { ok: false, code: 'SERVICE_OFFLINE', error: 'offline' })
  const { setupDownloadMessages } = await import('~/background/download')
  setupDownloadMessages()
  handler = mock.listener.mock.calls[0][0]
  await send('health')
})

it('opening the UI and previewing names uses a snapshot without starting the download service', async () => {
  expect(mock.native.mock.calls.map(([value]) => value.method)).toEqual(['uiSnapshot'])
  const status = await send('health')
  expect(status.result.deferred).toBe(true)
  const tasks = await send('queryTasks', { tab: 'pending' })
  expect(tasks.result.items[0].id).toBe('fixture')
  expect(tasks.result.offline).toBe(true)
  const preview = await send('previewPath', { task: pending, options: pending.options })
  expect(preview.result).toEqual({ directory: 'C:\\Videos', basename: 'Fixture' })
  await send('inspect', { video: pending.bvid })
  expect(mock.native).toHaveBeenCalledTimes(1)
})

it('does not prepare or enqueue a download before first-start consent', async () => {
  mock.inspect.mockClear()
  const reply = await send('stageTasks', { video: pending.bvid, cids: [42], options: pending.options })
  expect(reply.code).toBe('HELPER_START_REQUIRED')
  expect(mock.inspect).not.toHaveBeenCalled()
  expect(mock.native).toHaveBeenCalledTimes(1)
})

it('consented writes start on demand, then synchronize records without waking on subsequent reads', async () => {
  await send('authorizeStart')
  mock.native.mockImplementation(async (message) => {
    if (message.method === 'bootstrapStatus')
      return { ok: true, result: { connectorVersion: '0.2.8', runtime: { ready: true } } }
    const runtime = { running: true, mode: 'on-demand', state: 'idle', exitAt: Date.now() + 5000 }
    if (message.method === 'stageTasks')
      return { ok: true, result: [pending], runtime }
    if (message.method === 'health')
      return { ok: true, result: health, runtime }
    return { ok: true, result: { items: [pending], total: 1, page: 1, pageSize: 100, counts: snapshot.counts }, runtime }
  })
  const result = await send('stageTasks', { video: pending.bvid, cids: [42], options: pending.options })
  expect(result.ok).toBe(true)
  expect(mock.values['bewly-native-autostart']).toBe('true')
  expect(mock.native.mock.calls.filter(([value]) => value.allowStart === true).map(([value]) => value.method)).toEqual(['stageTasks'])
  const count = mock.native.mock.calls.length
  await send('queryTasks', { tab: 'pending' })
  await send('health')
  expect(mock.native).toHaveBeenCalledTimes(count)
})

it('an explicit refresh reads a newer completed snapshot but never wakes an offline daemon', async () => {
  mock.native.mockImplementation(async message => message.method === 'uiSnapshot'
    ? { ok: true, result: { ...snapshot, items: [{ ...pending, status: 'completed' }], counts: { ...snapshot.counts, pending: 0, completed: 1 } } }
    : { ok: false, code: 'SERVICE_OFFLINE', error: 'offline' })
  const result = await send('queryTasks', { tab: 'completed', connect: true })
  expect(result.result.items[0].status).toBe('completed')
  expect(mock.native.mock.calls.some(([value]) => value.allowStart === true)).toBe(false)
})

it('stops status polling and cancellation from waking a dormant service', async () => {
  const count = mock.native.mock.calls.length
  expect((await send('tool', { op: 'status', id: 'old' })).ok).toBe(false)
  expect((await send('tool', { op: 'cancel', id: 'old' })).result.cancelled).toBe(true)
  expect(mock.native).toHaveBeenCalledTimes(count)
})

it('uI cache persistence failures cannot turn an accepted download into an error', async () => {
  await send('authorizeStart')
  mock.set.mockRejectedValue(new Error('quota'))
  mock.native.mockImplementation(async (message) => {
    if (message.method === 'bootstrapStatus')
      return { ok: true, result: { connectorVersion: '0.2.8', runtime: { ready: true } } }
    if (message.method === 'stageTasks')
      return { ok: true, result: [pending], runtime: { mode: 'on-demand', state: 'idle' } }
    if (message.method === 'health')
      return { ok: true, result: health }
    return { ok: true, result: { items: [pending], counts: snapshot.counts } }
  })
  expect((await send('stageTasks', { video: pending.bvid, cids: [42], options: pending.options })).ok).toBe(true)
})

it('a restarted worker passively attaches to a still-running download', async () => {
  vi.resetModules()
  mock.values = { 'bewly-download-snapshot': { initialized: true, tasks: [pending], counts: { ...snapshot.counts, active: 1 } } }
  mock.native.mockImplementation(async (message) => {
    const runtime = { mode: 'on-demand', state: 'busy' }
    if (message.method === 'uiSnapshot')
      return { ok: true, result: { ...snapshot, counts: { ...snapshot.counts, active: 1 } } }
    if (message.method === 'health')
      return { ok: true, result: health, runtime }
    return { ok: true, result: { items: [{ ...pending, status: 'downloading', progress: 75 }], counts: { ...snapshot.counts, active: 1 } }, runtime }
  })
  const { setupDownloadMessages } = await import('~/background/download')
  setupDownloadMessages()
  handler = mock.listener.mock.calls.at(-1)![0]
  const result = await send('queryTasks')
  expect(result.result.items[0].progress).toBe(75)
  expect(mock.native.mock.calls.some(([value]) => value.allowStart === true)).toBe(false)
})

it('removed records do not reappear after an aggregate batch and an idle exit', async () => {
  const cache = await import('~/background/downloadCache')
  await cache.rememberReply('uiSnapshot', { ok: true, result: { ...snapshot, items: [pending, { ...pending, id: 'finished', status: 'completed' }] } })
  await cache.rememberReply('batchAction', { ok: true, result: { processed: 1, errors: [] } }, { action: 'remove', all: 'pending' })
  expect((await cache.cachedTasks({})).items.map(task => task.id)).toEqual(['finished'])
  await cache.rememberReply('queryTasks', { ok: true, result: { items: [], total: 0, counts: { pending: 0, active: 0, completed: 0, failed: 0 } } }, { tab: 'all' })
  expect((await cache.cachedTasks({})).items).toEqual([])
})
