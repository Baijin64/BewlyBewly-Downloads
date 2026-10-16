import { afterEach, expect, it } from 'vitest'
import { createApp, nextTick, reactive } from 'vue'

import DownloadProgress from '~/download/components/DownloadProgress.vue'
import type { DownloadTask } from '~/download/types'

let app: ReturnType<typeof createApp> | undefined
let container: HTMLDivElement
function mount(values: Partial<DownloadTask> = {}) {
  const task = reactive({ title: '示例视频', status: 'downloading', stage: 'video', progress: 4, speed: 21076377, ...values } as DownloadTask)
  container = document.createElement('div')
  document.body.append(container)
  app = createApp(DownloadProgress, { task })
  app.mount(container)
  return task
}
afterEach(() => {
  app?.unmount()
  app = undefined
  container?.remove()
})

it('labels the actual stream and changes stage without pretending it is overall progress', async () => {
  const task = mount()
  expect(container.textContent).toContain('下载视频')
  expect(container.textContent).toContain('20.1 MB/s')
  expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('4')
  task.stage = 'audio'
  task.progress = 0
  task.speed = 512000
  await nextTick()
  expect(container.textContent).toContain('下载音频')
  expect(container.textContent).toContain('500 KB/s')
  expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('0')
})

it('keeps paused progress and removes stale transfer speed', async () => {
  const task = mount({ progress: 62 })
  task.status = 'paused'
  await nextTick()
  expect(container.textContent).toContain('已暂停')
  expect(container.textContent).toContain('62%')
  expect(container.textContent).not.toContain('MB/s')
})

it.each(['queued', 'resolving', 'muxing', 'postprocessing'] as const)('does not advertise 100 percent during %s', (status) => {
  mount({ status, progress: 100 })
  expect(container.querySelector('[role="progressbar"]')?.hasAttribute('aria-valuenow')).toBe(false)
  expect(container.textContent).not.toContain('100%')
  expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuetext')).toContain('暂不可计量')
})

it('shows completion only after the task is completed', () => {
  mount({ status: 'completed', progress: 62 })
  expect(container.textContent).toContain('下载完成')
  expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('100')
})

it('handles invalid progress and transfer rates without invalid widths or NaN text', async () => {
  const task = mount({ progress: Number.NaN, speed: -1 })
  expect(container.textContent).toContain('等待数据')
  expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('0')
  task.progress = 200
  await nextTick()
  expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('100')
  task.progress = -20
  await nextTick()
  expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('0')
  expect(container.textContent).not.toContain('NaN')
})
