import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'

import { downloadRequest } from '~/download/client'
import DownloadDialog from '~/download/components/DownloadDialog.vue'
import DownloaderPage from '~/download/components/DownloaderPage.vue'
import DownloadNaming from '~/download/components/DownloadNaming.vue'
import { downloadTarget, openDownloadSelection } from '~/download/state'
import type { DownloadOptions, DownloadVideo } from '~/download/types'
import { defaultOptions } from '~/download/types'

vi.mock('webextension-polyfill', () => ({ default: {} }))
vi.mock('~/download/client', () => ({ downloadRequest: vi.fn() }))
vi.mock('~/download/state', async () => {
  const { ref } = await import('vue')
  return { downloadTarget: ref(), downloadPreferences: ref({}), openDownloader: vi.fn(), openDownloadSelection: vi.fn() }
})
vi.mock('~/composables/useAppProvider', async () => {
  const { ref } = await import('vue')
  return { useBewlyApp: () => ({ handlePageRefresh: ref(), handleReachBottom: ref() }) }
})
vi.mock('~/components/Button.vue', async () => {
  const { h } = await import('vue')
  return { default: { props: ['type', 'size', 'disabled'], setup: (props: any, { slots }: any) => () => h('button', { disabled: props.disabled }, slots.default?.()) } }
})
vi.mock('~/components/Dialog.vue', async () => {
  const { h } = await import('vue')
  return { default: { setup: (_: any, { slots }: any) => () => h('div', slots.default?.()) } }
})
vi.mock('~/download/components/DownloadSettings.vue', () => ({ default: { render: () => null } }))
vi.mock('~/download/components/DownloadTools.vue', () => ({ default: { render: () => null } }))
vi.mock('~/download/components/DownloadsPanel.vue', () => ({ default: { render: () => null } }))

const request = vi.mocked(downloadRequest)
const current: DownloadVideo = {
  bvid: 'BV1GJ411x7h7',
  title: '当前视频',
  author: 'UP',
  cover: '',
  requestedPage: 2,
  pages: [{ cid: 42, page: 1, title: '第一集', duration: 60 }, { cid: 43, page: 2, title: '第二集', duration: 60 }],
  collection: { id: 1, title: '完整合集', sections: [{ id: 1, title: '全部', videos: [
    { bvid: 'BV1GJ411x7h7', cid: 42, title: '当前视频', available: true },
    { bvid: 'BV17x411w7KC', cid: 44, title: '另一个视频', available: true },
  ] }] },
}
const other: DownloadVideo = { bvid: 'BV17x411w7KC', title: '另一个视频', author: 'UP', cover: '', pages: [{ cid: 44, page: 1, title: '完整视频', duration: 60 }] }
let app: ReturnType<typeof createApp> | undefined
let container: HTMLDivElement

function mount(component: any, props: any = {}) {
  container = document.createElement('div')
  document.body.append(container)
  app = createApp(component, props)
  app.component('Select', defineComponent({ props: ['options', 'modelValue'], setup: props => () => h('div', props.options?.find((item: any) => item.value === props.modelValue)?.label) }))
  app.mount(container)
}
function button(text: string) {
  const match = Array.from(container.querySelectorAll('button')).find(node => node.textContent?.trim() === text)
  if (!match)
    throw new Error(`没有找到按钮 ${text}`)
  return match
}
async function loaded() {
  await vi.waitFor(() => expect(container.textContent).toContain('最高可用 · 1080P'))
}
beforeEach(() => {
  request.mockReset()
  vi.mocked(openDownloadSelection).mockClear()
  downloadTarget.value = { video: current.bvid, instanceId: 1 }
  request.mockImplementation(async (method, params = {}) => {
    if (method === 'health')
      return { protocol: 2, capabilities: ['audio-highest'], engineInstalled: true, settings: { defaultOptions, features: {} } } as any
    if (method === 'inspect')
      return structuredClone(params.video === other.bvid ? other : current) as any
    if (method === 'inspectFormats')
      return { video: [{ quality: 80, codec: 7 }], audio: [{ id: 30280, bandwidth: 192000 }] } as any
    if (method === 'previewPath')
      return { directory: 'D:\\Videos', basename: '示例视频' } as any
    if (method === 'stageTasks' || method === 'createTasks')
      return [{ id: String(params.video) }] as any
    return [] as any
  })
})
afterEach(() => {
  app?.unmount()
  app = undefined
  container?.remove()
})

it('opens the complete collection by default but submits only the current part', async () => {
  mount(DownloadDialog)
  await loaded()
  expect(container.textContent).toContain('另一个视频')
  expect(container.textContent).toContain('返回当前视频')
  expect(container.querySelector('.part-row [aria-pressed="mixed"]')).not.toBeNull()
  expect(request.mock.calls.some(([method]) => ['stageTasks', 'createTasks'].includes(method))).toBe(false)
  button('加入待下载').click()
  await vi.waitFor(() => expect(request.mock.calls.filter(([method]) => method === 'stageTasks')).toHaveLength(1))
  expect(request.mock.calls.find(([method]) => method === 'stageTasks')?.[1]).toMatchObject({ video: current.bvid, cids: [43], options: { quality: 0 }, group: { title: '完整合集', index: 1 } })
})

it('presents all pasted links together, deduplicates collection rows and stages every selected source', async () => {
  downloadTarget.value = { video: current.bvid, videos: [current.bvid, other.bvid], instanceId: 2 }
  mount(DownloadDialog)
  await loaded()
  expect(container.textContent).toContain('批量选择（2 个链接）')
  expect(container.querySelectorAll('.part-row')).toHaveLength(2)
  button('加入待下载').click()
  await vi.waitFor(() => expect(request.mock.calls.filter(([method]) => method === 'stageTasks')).toHaveLength(2))
  expect(request.mock.calls.filter(([method]) => method === 'stageTasks').map(([, params]) => params?.cids)).toEqual([[43], [44]])
})

it('keeps a failed pasted link separate from the successful selection', async () => {
  const original = request.getMockImplementation()!
  request.mockImplementation(async (method, params) => {
    if (method === 'inspect' && params?.video === 'bad-link')
      throw new Error('链接不可用')
    return original(method, params)
  })
  downloadTarget.value = { video: current.bvid, videos: ['bad-link', current.bvid], instanceId: 3 }
  mount(DownloadDialog)
  await loaded()
  expect(container.textContent).toContain('bad-link：链接不可用')
  expect(container.textContent).toContain('另一个视频')
  expect(request.mock.calls.some(([method]) => method === 'stageTasks')).toBe(false)
})

it('uses filename presets and inserts a variable into the selected filename range', async () => {
  const options = ref<DownloadOptions>({ ...defaultOptions, filenameTemplate: '开头-替换-结尾' })
  mount(defineComponent({ setup: () => () => h(DownloadNaming, { modelValue: options.value, 'onUpdate:modelValue': value => options.value = value }) }))
  const input = container.querySelector<HTMLInputElement>('[aria-label="文件名规则"]')!
  input.focus()
  input.setSelectionRange(3, 5)
  container.querySelector<HTMLButtonElement>('[aria-label="插入视频标题 %title%"]')!.click()
  await nextTick()
  expect(options.value.filenameTemplate).toBe('开头-%title%-结尾')
  expect(input.selectionStart).toBe(10)
  button('序号 + 标题').click()
  await nextTick()
  expect(options.value.filenameTemplate).toBe('%index:01% - %title%')
  button('按 UP 主').click()
  await nextTick()
  container.querySelector<HTMLButtonElement>('[aria-label="插入发布年 %pd:YYYY%"]')!.click()
  await nextTick()
  expect(options.value.folderTemplate).toContain('%pd:YYYY%')
  expect(options.value.outputs).toEqual(['video'])
})

it('opens selection from pasted links before any task is created', async () => {
  mount(DownloaderPage)
  const input = container.querySelector('textarea')!
  input.value = `${current.bvid}\n${current.bvid}\n${other.bvid}`
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
  button('解析并选择视频').click()
  expect(openDownloadSelection).toHaveBeenCalledWith([current.bvid, other.bvid], false)
  expect(request.mock.calls.some(([method]) => ['stageTasks', 'createTasks', 'inspect'].includes(method))).toBe(false)
})

it('keeps the current quality result when an older video query finishes late', async () => {
  const original = request.getMockImplementation()!
  let finishFirst: (value: any) => void = () => {}
  request.mockImplementation(async (method, params) => {
    if (method === 'inspectFormats' && params?.video === current.bvid)
      return new Promise(resolve => finishFirst = resolve)
    if (method === 'inspectFormats')
      return { video: [{ quality: 127, codec: 13 }], audio: [{ id: 30251, bandwidth: 1000000 }] } as any
    return original(method, params)
  })
  mount(DownloadDialog)
  await vi.waitFor(() => expect(container.textContent).toContain('正在读取可用画质'))
  // Clear the default part selection, then select the other collection video.
  button('全选 / 清空当前列表').click()
  await nextTick()
  button('全选 / 清空当前列表').click()
  await nextTick()
  container.querySelectorAll<HTMLButtonElement>('.part-row [data-download-choice]')[1].click()
  await vi.waitFor(() => expect(container.textContent).toContain('最高可用 · 8K'))
  finishFirst({ video: [{ quality: 80, codec: 7 }], audio: [{ id: 30280, bandwidth: 192000 }] })
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(container.textContent).toContain('最高可用 · 8K')
  expect(container.textContent).toContain('最高可用 · Hi-Res 无损')
})

it('requires a compatible helper before automatic highest audio can be queued', async () => {
  const original = request.getMockImplementation()!
  let updated = false
  request.mockImplementation(async (method, params) => {
    const result: any = await original(method, params)
    if (method === 'health' && !updated)
      return { ...result, capabilities: [] }
    return result
  })
  mount(DownloadDialog)
  await loaded()
  expect(container.textContent).toContain('需要下载助手 0.2.2')
  expect(button('加入待下载').disabled).toBe(true)
  updated = true
  button('检查助手更新').click()
  await vi.waitFor(() => expect(button('加入待下载').disabled).toBe(false))
  expect(request.mock.calls.some(([method]) => method === 'stageTasks')).toBe(false)
})

it('uses option chips to stage only the chosen download content', async () => {
  mount(DownloadDialog)
  await loaded()
  const confirm = vi.fn()
  document.addEventListener('keydown', confirm)
  button('封面').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  document.removeEventListener('keydown', confirm)
  expect(confirm).not.toHaveBeenCalled()
  expect(button('有声视频').getAttribute('aria-pressed')).toBe('true')
  button('封面').click()
  await nextTick()
  button('有声视频').click()
  await nextTick()
  expect(button('有声视频').getAttribute('aria-pressed')).toBe('false')
  expect(button('封面').getAttribute('aria-pressed')).toBe('true')
  button('加入待下载').click()
  await vi.waitFor(() => expect(request.mock.calls.some(([method]) => method === 'stageTasks')).toBe(true))
  expect(request.mock.calls.find(([method]) => method === 'stageTasks')?.[1]?.options).toMatchObject({ outputs: ['cover'], cover: true })
})
