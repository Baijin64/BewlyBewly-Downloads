import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'

import ForYou from '~/contentScripts/views/Home/components/ForYou.vue'
import { loadingRequest } from '~/loading/client'

const state = vi.hoisted(() => ({ mode: undefined as any, bottom: undefined as any, refresh: undefined as any, renders: new Map<number, number>(), error: vi.fn() }))
vi.mock('webextension-polyfill', () => ({ default: {} }))
vi.mock('~/utils/authProvider', () => ({ TVAppKey: { appkey: 'fixture' } }))
vi.mock('~/loading/client', () => ({ loadingRequest: vi.fn() }))
vi.mock('~/logic', async () => {
  const { ref } = await import('vue')
  state.mode = ref({ recommendationMode: 'web', language: 'cmn-CN' })
  return { settings: state.mode, accessKey: ref('') }
})
vi.mock('~/composables/useFilter', async () => {
  const { ref } = await import('vue')
  return { FilterType: {}, useFilter: () => ref() }
})
vi.mock('~/composables/useAppProvider', async () => {
  const { ref } = await import('vue')
  state.bottom = ref()
  state.refresh = ref()
  return { useBewlyApp: () => ({ handleReachBottom: state.bottom, handlePageRefresh: state.refresh, haveScrollbar: async () => true }) }
})
vi.mock('vue-toastification', () => ({ useToast: () => ({ error: state.error }) }))
const request = vi.mocked(loadingRequest)
let app: ReturnType<typeof createApp> | undefined
let container: HTMLDivElement
const layout = ref('adaptive')
function items(start: number) {
  return Array.from({ length: 30 }, (_, offset) => {
    const id = start + offset
    return { id, bvid: `BV${String(id).padStart(10, '0')}`, title: `Video ${id}`, duration: 120, pic: '', owner: { name: 'UP', face: '', mid: 1 }, stat: { view: 10, danmaku: 1 } }
  })
}
function mount() {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp({ setup: () => () => h(ForYou, { gridLayout: layout.value as any }) })
  app.config.globalProperties.$t = (key: string) => key
  app.component('VideoCard', defineComponent({ props: ['video', 'skeleton', 'horizontal', 'coverLoading'], setup: props => () => {
    if (props.video)
      state.renders.set(props.video.id, (state.renders.get(props.video.id) || 0) + 1)
    return h('article', { class: 'card' }, props.video?.title || 'Skeleton')
  } }))
  for (const name of ['Loading', 'Button']) app.component(name, { render: () => null })
  app.component('Empty', defineComponent({ props: ['description'], setup: props => () => h('div', props.description) }))
  app.mount(container)
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  request.mockReset()
  state.renders.clear()
  state.error.mockClear()
  state.mode.value = { recommendationMode: 'web', language: 'cmn-CN' }
  layout.value = 'adaptive'
  request.mockImplementation(async (_method, params: any) => ({ code: 0, data: { item: items((params.fresh_idx - 1) * 30 + 1) } }) as any)
})
afterEach(() => {
  app?.unmount()
  container?.remove()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('appending cards leaves previous cards unrendered while grid changes still update them', async () => {
  mount()
  await vi.advanceTimersByTimeAsync(201)
  expect(container.querySelectorAll('.card')).toHaveLength(30)
  const before = state.renders.get(1)
  await state.bottom.value()
  await nextTick()
  expect(container.querySelectorAll('.card')).toHaveLength(60)
  expect(state.renders.get(1)).toBe(before)
  for (let index = 0;
    index < 8;
    index++) await state.bottom.value()
  await nextTick()
  expect(container.querySelectorAll('.card')).toHaveLength(300)
  const previousRenders = Array.from(state.renders).filter(([id]) => id <= 300).reduce((sum, [, count]) => sum + count, 0)
  await state.bottom.value()
  await nextTick()
  expect(container.querySelectorAll('.card')).toHaveLength(330)
  expect(Array.from(state.renders).filter(([id]) => id <= 300).reduce((sum, [, count]) => sum + count, 0)).toBe(previousRenders)
  layout.value = 'twoColumns'
  await nextTick()
  expect(state.renders.get(1)).toBe((before || 0) + 1)
})

it('mode changes discard late login failures and old recommendation results', async () => {
  let resolve!: (value: any) => void
  request.mockImplementationOnce(() => new Promise(done => resolve = done))
  mount()
  await vi.advanceTimersByTimeAsync(201)
  const oldSignal = request.mock.calls[0][2]
  request.mockImplementation(async () => ({ code: 0, data: { items: [] } }) as any)
  state.mode.value.recommendationMode = 'app'
  await nextTick()
  await vi.advanceTimersByTimeAsync(1)
  resolve({ code: 62011 })
  await vi.advanceTimersByTimeAsync(1)
  expect(oldSignal.aborted).toBe(true)
  expect(container.textContent).not.toContain('Video 1')
  expect(container.textContent).not.toContain('common.please_log_in_first')
  expect(state.error).not.toHaveBeenCalled()
})

it('unmounting before the initial timer fires starts no requests', async () => {
  mount()
  app!.unmount()
  app = undefined
  await vi.advanceTimersByTimeAsync(1000)
  expect(request).not.toHaveBeenCalled()
})
