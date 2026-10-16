import { afterEach, expect, it, vi } from 'vitest'

import { loadingRequest } from '~/loading/client'

const send = vi.hoisted(() => vi.fn())
vi.mock('webextension-polyfill', () => ({ default: { runtime: { sendMessage: send } } }))
afterEach(() => {
  send.mockReset()
  vi.useRealTimers()
})

it('aborts a pending message and notifies the background to release its request', async () => {
  send.mockImplementation(message => message.method === 'cancel' ? Promise.resolve({ ok: true }) : new Promise(() => {}))
  const controller = new AbortController()
  const request = loadingRequest('getVideoPreview', { cid: 42 }, controller.signal)
  const cancelled = expect(request).rejects.toHaveProperty('name', 'AbortError')
  controller.abort()
  await cancelled
  expect(send.mock.calls[1][0]).toMatchObject({ bewlyResource: true, method: 'cancel', id: send.mock.calls[0][0].id })
})

it('does not send already-aborted requests and bounds unresponsive background calls', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(loadingRequest('getVideoInfo', {}, controller.signal)).rejects.toHaveProperty('name', 'AbortError')
  expect(send).not.toHaveBeenCalled()
  vi.useFakeTimers()
  send.mockImplementation(message => message.method === 'cancel' ? Promise.resolve({ ok: true }) : new Promise(() => {}))
  const request = loadingRequest('getVideoInfo', {}, new AbortController().signal)
  const timedOut = expect(request).rejects.toThrow('超时')
  await vi.advanceTimersByTimeAsync(25000)
  await timedOut
  expect(send.mock.calls.at(-1)![0].method).toBe('cancel')
})
