import type { DownloadTask } from './types'

const pad = (value: number | string) => String(value).padStart(2, '0')

export function taskCoverUrl(value?: string): string | undefined {
  if (!value || value.length > 2048)
    return undefined
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && url.port !== '443') || !(url.hostname === 'hdslb.com' || url.hostname.endsWith('.hdslb.com')))
      return undefined
    url.protocol = 'https:'
    if (!url.search && /\.(?:jpe?g|png|webp|avif)(?:@[^/]*)?$/i.test(url.pathname))
      url.pathname = `${url.pathname.replace(/@[^/]*$/, '')}@320w_180h_1c.webp`
    return url.href
  }
  catch {
    return undefined
  }
}

export function formatTaskTimestamp(value?: string): { text: string, dateTime: string } | undefined {
  if (!value)
    return undefined
  const source = value.trim()
  // Legacy dates without an offset retain their recorded wall-clock time.
  const local = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(source)
  if (local) {
    const [, year, month, day, hour, minute, second] = local
    const y = Number(year)
    const m = Number(month)
    const d = Number(day)
    const date = new Date(Date.UTC(y, m - 1, d))
    if (y < 1970 || date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d || (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59 || Number(second || 0) > 59)))
      return undefined
    const dayText = `${year}-${pad(month)}-${pad(day)}`
    return hour === undefined ? { text: dayText, dateTime: dayText } : { text: `${dayText} ${pad(hour)}:${minute}`, dateTime: `${dayText}T${pad(hour)}:${minute}${second === undefined ? '' : `:${second}`}` }
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(source) && !/^\d{10}(?:\d{3})?$/.test(source))
    return undefined
  const date = new Date(/^\d+$/.test(source) ? Number(source) * (source.length === 10 ? 1000 : 1) : source)
  if (!Number.isFinite(date.getTime()))
    return undefined
  return { text: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`, dateTime: date.toISOString() }
}

export function taskTime(task: Pick<DownloadTask, 'status' | 'createdAt' | 'completedAt'>) {
  const label = task.status === 'completed' ? '完成时间' : '加入时间'
  return { label, ...formatTaskTimestamp(task.status === 'completed' ? task.completedAt : task.createdAt) }
}
