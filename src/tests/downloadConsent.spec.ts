import { beforeEach, expect, it, vi } from 'vitest'

import { downloadRequest } from '~/download/client'

const mock = vi.hoisted(() => ({ send: vi.fn(), confirm: vi.fn(), approved: { value: false } }))
vi.mock('webextension-polyfill', () => ({ default: { runtime: { sendMessage: mock.send } } }))
vi.mock('~/download/wake', () => ({ confirmHelperWake: mock.confirm, helperAutoStart: mock.approved }))
beforeEach(() => {
  mock.send.mockReset()
  mock.confirm.mockReset()
  mock.approved.value = false
})

it('cancelled consent never sends an authorized operation', async () => {
  mock.send.mockResolvedValue({ ok: false, code: 'HELPER_START_REQUIRED', error: 'start required' })
  mock.confirm.mockResolvedValue(false)
  await expect(downloadRequest('stageTasks')).rejects.toHaveProperty('name', 'AbortError')
  expect(mock.send).toHaveBeenCalledTimes(1)
  expect(mock.approved.value).toBe(false)
})

it('persists consent before retrying the untouched operation once', async () => {
  mock.send.mockResolvedValueOnce({ ok: false, code: 'HELPER_START_REQUIRED', error: 'start required' }).mockResolvedValueOnce({ ok: true, result: { allowed: true } }).mockResolvedValueOnce({ ok: true, result: ['task'] })
  mock.confirm.mockResolvedValue(true)
  const params = { video: 'BV17x411w7KC', cids: [42] }
  expect(await downloadRequest('stageTasks', params)).toEqual(['task'])
  expect(mock.send.mock.calls.map(([message]) => message.method)).toEqual(['stageTasks', 'authorizeStart', 'stageTasks'])
  expect(mock.send.mock.calls[2][0].params).toBe(params)
  expect(mock.approved.value).toBe(true)
})

it('ordinary responses never show a start confirmation', async () => {
  mock.send.mockResolvedValue({ ok: true, result: { deferred: true } })
  expect(await downloadRequest('health')).toEqual({ deferred: true })
  expect(mock.confirm).not.toHaveBeenCalled()
})
