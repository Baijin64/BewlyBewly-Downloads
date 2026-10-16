import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'

import Radio from '~/components/Radio.vue'
import { playbackRequest } from '~/playback/client'
import PlaybackSettings from '~/playback/PlaybackSettings.vue'

vi.mock('webextension-polyfill', () => ({ default: {} }))
vi.mock('~/playback/client', () => ({ playbackRequest: vi.fn() }))
const request = vi.mocked(playbackRequest)
let app: ReturnType<typeof createApp>
let container: HTMLDivElement
function mount(component: any) {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp(component)
  app.mount(container)
}
const control = () => container.querySelector<HTMLElement>('[role="switch"]')!
const input = () => container.querySelector<HTMLInputElement>('input')!
beforeEach(() => {
  request.mockReset()
})
afterEach(() => {
  app?.unmount()
  container?.remove()
})

it('keeps the switch off when permission fails, including its visual checkbox state', async () => {
  let rejectEnable: (error: Error) => void = () => {}
  request.mockImplementation(method => method === 'status' ? Promise.resolve({ enabled: false }) : new Promise((_, reject) => rejectEnable = reject))
  mount(PlaybackSettings)
  await vi.waitFor(() => expect(control().getAttribute('aria-disabled')).toBeNull())
  control().click()
  // Requests remain in the input gesture, before any asynchronous work.
  expect(request).toHaveBeenLastCalledWith('enable')
  await nextTick()
  expect(control().getAttribute('aria-disabled')).toBe('true')
  expect(input().checked).toBe(false)
  rejectEnable(new Error('未获得媒体线路权限'))
  await vi.waitFor(() => expect(container.textContent).toContain('未获得媒体线路权限'))
  expect(control().getAttribute('aria-checked')).toBe('false')
  expect(input().checked).toBe(false)
})

it('shows the confirmed on state until a disable request succeeds', async () => {
  let finish: (value: { enabled: boolean }) => void = () => {}
  request.mockImplementation(method => method === 'status' ? Promise.resolve({ enabled: true }) : new Promise(resolve => finish = resolve))
  mount(PlaybackSettings)
  await vi.waitFor(() => expect(control().getAttribute('aria-checked')).toBe('true'))
  control().click()
  await nextTick()
  expect(request).toHaveBeenLastCalledWith('disable')
  expect(input().checked).toBe(true)
  finish({ enabled: false })
  await vi.waitFor(() => expect(control().getAttribute('aria-checked')).toBe('false'))
  expect(input().checked).toBe(false)
})

it('does not submit a setting while the initial state is still loading', async () => {
  let finish: (value: { enabled: boolean }) => void = () => {}
  request.mockImplementation(() => new Promise(resolve => finish = resolve))
  mount(PlaybackSettings)
  control().click()
  expect(request).toHaveBeenCalledTimes(1)
  expect(request).toHaveBeenCalledWith('status')
  finish({ enabled: true })
  await vi.waitFor(() => expect(control().getAttribute('aria-checked')).toBe('true'))
})

it('keeps the original switch usable from the keyboard and honors disabled state', async () => {
  const model = ref(false)
  const disabled = ref(false)
  mount(defineComponent({ setup: () => () => h(Radio, { modelValue: model.value, disabled: disabled.value, ariaLabel: '测试开关', 'onUpdate:modelValue': value => model.value = value }) }))
  control().dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
  await nextTick()
  expect(model.value).toBe(true)
  expect(input().checked).toBe(true)
  disabled.value = true
  await nextTick()
  control().click()
  control().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await nextTick()
  expect(model.value).toBe(true)
})
