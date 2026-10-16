import { afterEach, expect, it } from 'vitest'
import { createApp, nextTick, reactive } from 'vue'

import DownloadTaskHeader from '~/download/components/DownloadTaskHeader.vue'
import { formatTaskTimestamp, taskCoverUrl, taskTime } from '~/download/taskMetadata'
import type { DownloadTask } from '~/download/types'
import { defaultOptions } from '~/download/types'

let app: ReturnType<typeof createApp> | undefined
let container: HTMLDivElement | undefined
function mount(overrides: Partial<DownloadTask> = {}) {
  const task = reactive({ id: 'fixture', bvid: 'BV1GJ411x7h7', cid: 42, page: 2, title: '示例视频', part: '第二集', author: '示例 UP 主', uid: 12345, cover: 'http://i0.hdslb.com/bfs/archive/example.jpg', status: 'completed', progress: 100, speed: 0, error: '', options: defaultOptions, createdAt: '2026-10-09T18:00:00Z', completedAt: '2026-10-09T19:32:00Z', ...overrides } as DownloadTask)
  container = document.createElement('div')
  document.body.append(container)
  app = createApp(DownloadTaskHeader, { task })
  app.mount(container)
  return task
}
afterEach(() => {
  app?.unmount()
  container?.remove()
  app = undefined
})

it('shows persisted cover, uploader profile and completion timestamp', () => {
  mount()
  expect(container?.querySelector('img')?.src).toBe('https://i0.hdslb.com/bfs/archive/example.jpg@320w_180h_1c.webp')
  expect(container?.querySelector('.task-author a')?.getAttribute('href')).toBe('https://space.bilibili.com/12345')
  expect(container?.textContent).toContain('示例 UP 主')
  expect(container?.querySelector('time')?.dateTime).toBe('2026-10-09T19:32:00.000Z')
  expect(container?.textContent).toContain('完成时间')
  expect(container?.querySelector('.task-video-title')?.getAttribute('href')).toContain('?p=2')
})

it('preserves a legacy date without inventing midnight or converting an unknown timezone', () => {
  expect(formatTaskTimestamp('2026-10-09')).toEqual({ text: '2026-10-09', dateTime: '2026-10-09' })
  expect(formatTaskTimestamp('2026/10/9 9:32:11')).toEqual({ text: '2026-10-09 09:32', dateTime: '2026-10-09T09:32:11' })
})

it('does not replace an unknown completion time with the import or creation time', () => {
  mount({ author: '', uid: 0, cover: '', completedAt: '' })
  expect(container?.textContent).toContain('UP 主未记录')
  expect(container?.textContent).toContain('完成时间未记录')
  expect(container?.querySelector('.task-author a')).toBeNull()
  expect(container?.querySelector('time')).toBeNull()
  expect(taskTime({ status: 'completed', createdAt: '2026-10-09T18:00:00Z' }).text).toBeUndefined()
})

it('switches from join time to completion time when the task completes', async () => {
  const task = mount({ status: 'downloading', completedAt: undefined })
  expect(container?.textContent).toContain('加入时间')
  expect(container?.querySelector('time')?.dateTime).toBe('2026-10-09T18:00:00.000Z')
  task.status = 'completed'
  task.completedAt = '2026-10-09T19:32:00Z'
  await nextTick()
  expect(container?.textContent).toContain('完成时间')
  expect(container?.querySelector('time')?.dateTime).toBe('2026-10-09T19:32:00.000Z')
})

it('keeps a failed cover as a placeholder until the recorded URL changes', async () => {
  const task = mount()
  container?.querySelector('img')?.dispatchEvent(new Event('error'))
  await nextTick()
  expect(container?.querySelector('img')).toBeNull()
  expect(container?.textContent).toContain('暂无封面')
  task.cover = 'https://i1.hdslb.com/bfs/archive/new.jpg'
  await nextTick()
  expect(container?.querySelector('img')).not.toBeNull()
})

it('uses browser local time for absolute timestamps', () => {
  const source = '2026-10-09T19:32:00+08:00'
  const date = new Date(source)
  const result = formatTaskTimestamp(source)
  expect(result?.dateTime).toBe('2026-10-09T11:32:00.000Z')
  expect(result?.text).toContain(`${String(date.getHours()).padStart(2, '0')}:32`)
})

it.each(['', 'not-a-date', '2026-02-30', '2026-10-09 25:30', '2026-10-09 12:99'])('leaves invalid dates unknown: %s', (source) => {
  expect(formatTaskTimestamp(source)).toBeUndefined()
})

it('accepts official image hosts only and rejects arbitrary or executable URLs', () => {
  expect(taskCoverUrl('//i2.hdslb.com/bfs/archive/a.png')).toContain('https://i2.hdslb.com/')
  for (const url of ['javascript:alert(1)', 'data:image/svg+xml,x', 'file:///a.png', 'https://example.com/a.jpg', 'https://i0.hdslb.com.evil.test/a.jpg', 'https://user:password@i0.hdslb.com/a.jpg'])
    expect(taskCoverUrl(url)).toBeUndefined()
})
