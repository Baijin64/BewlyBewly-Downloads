import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock('webextension-polyfill', () => ({ default: { runtime: { connectNative: mocked.connect } } }))

function fakePort() {
  let message: ((value: any) => void) | undefined
  let disconnected: (() => void) | undefined
  return {
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: { addListener: (listener: typeof message) => { message = listener } },
    onDisconnect: { addListener: (listener: typeof disconnected) => { disconnected = listener } },
    reply(value: unknown) { message?.(value) },
    close() { disconnected?.() },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetModules()
  mocked.connect.mockReset()
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

it('serializes concurrent messages and uses one native host connection', async () => {
  const port = fakePort()
  mocked.connect.mockReturnValue(port)
  const { requestNativeDownload } = await import('~/background/nativeDownloadClient')
  const first = requestNativeDownload({ method: 'health' })
  const second = requestNativeDownload({ method: 'listTasks' })
  await vi.advanceTimersByTimeAsync(0)
  expect(mocked.connect).toHaveBeenCalledTimes(1)
  expect(port.postMessage).toHaveBeenCalledTimes(1)
  port.reply({ ok: true, result: {}, requestId: 1 })
  await first
  await vi.advanceTimersByTimeAsync(0)
  expect(port.postMessage).toHaveBeenCalledTimes(2)
  port.reply({ ok: true, result: [], requestId: 2 })
  await second
  expect(mocked.connect).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(15000)
  expect(port.disconnect).toHaveBeenCalledOnce()
})

it('closes an unresponsive native host instead of leaving an endless loading state', async () => {
  const port = fakePort()
  mocked.connect.mockReturnValue(port)
  const { requestNativeDownload } = await import('~/background/nativeDownloadClient')
  const pending = requestNativeDownload({ method: 'health' })
  const failed = expect(pending).rejects.toThrow('通信超时')
  await vi.advanceTimersByTimeAsync(15001)
  await failed
  expect(port.disconnect).toHaveBeenCalledOnce()
})

it('ignores responses for a different request and handles host disconnection', async () => {
  const port = fakePort()
  mocked.connect.mockReturnValue(port)
  const { requestNativeDownload } = await import('~/background/nativeDownloadClient')
  const pending = requestNativeDownload({ method: 'health' })
  let settled = false
  pending.then(() => {
    settled = true
  }, () => {
    settled = true
  })
  await vi.advanceTimersByTimeAsync(0)
  port.reply({ ok: true, requestId: 99 })
  await vi.advanceTimersByTimeAsync(0)
  expect(settled).toBe(false)
  const failed = expect(pending).rejects.toThrow('连接中断')
  port.close()
  await failed
})
