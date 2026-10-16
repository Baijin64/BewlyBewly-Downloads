import { expect, it, vi } from 'vitest'

import { apiListenerFactory } from '~/background/utils'

vi.mock('webextension-polyfill', () => ({ default: {} }))

it('leaves unrelated messages unclaimed so the playback listener can reply', async () => {
  const api = vi.fn(async () => ({ title: 'video' }))
  const listener = apiListenerFactory({ video: api })
  const message = { contentScriptQuery: '', bewlyPlayback: true, method: 'status' }
  const reply = listener(message)
  expect(reply).toBeUndefined()
  expect(api).not.toHaveBeenCalled()
  // Model runtime routing: any returned Promise claims the response channel.
  const playbackReply = Promise.resolve({ ok: true, result: { enabled: false } })
  expect(await (reply === undefined ? playbackReply : reply)).toEqual({ ok: true, result: { enabled: false } })
  expect(listener({ contentScriptQuery: 'toString' })).toBeUndefined()
})

it('keeps the existing API response and request arguments', async () => {
  const api = vi.fn(async () => ({ title: 'video' }))
  const listener = apiListenerFactory({ video: api })
  const message = { contentScriptQuery: 'video', bvid: 'BV17x411w7KC' }
  expect(await listener(message)).toEqual({ title: 'video' })
  expect(api).toHaveBeenCalledWith(message, undefined, undefined)
})
