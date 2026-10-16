import { audioRank, selectAudio } from '../../native/audio.mjs'
import type { AvailableAudioFormat, AvailableMediaFormats, AvailableVideoFormat, DownloadOptions, DownloadVideo } from '../download/types'
import { normalizeDownloadOptions } from '../download/types'

export function parseDownloadId(value: unknown) {
  if (typeof value !== 'string')
    throw new Error('缺少视频链接')
  if (/^BV[0-9A-Za-z]{10}$/.test(value))
    return value
  if (/^av[1-9]\d{0,15}$/i.test(value))
    return `av${value.slice(2)}`
  const url = new URL(value)
  if (url.protocol !== 'https:' || !['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(url.hostname))
    throw new Error('请使用 B 站普通视频的 BV 链接')
  const bvid = /^\/video\/(BV[0-9A-Z]{10}|av[1-9]\d{0,15})(?:\/|$)/i.exec(url.pathname)?.[1]
    || (/^\/(?:list\/watchlater|watchlater)(?:\/|$)/.test(url.pathname) ? url.searchParams.get('bvid') : '')
  if (!bvid)
    throw new Error('当前版本支持普通视频及分 P')
  return bvid
}

export async function biliApi(endpoint: string, params: Record<string, string>) {
  const url = new URL(endpoint, 'https://api.bilibili.com')
  url.search = new URLSearchParams(params).toString()
  const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(20000) })
  if (!response.ok)
    throw new Error(`B 站请求失败（HTTP ${response.status}），请在浏览器打开 B 站确认登录后重试`)
  const result = await response.json()
  if (result.code !== 0)
    throw new Error(`B 站返回 ${result.code}：${result.message || '请求未成功'}`)
  return result.data
}

export async function inspectDownload(value: unknown): Promise<DownloadVideo> {
  if (typeof value === 'string' && /^https?:\/\/(?:b23\.tv|bili2233\.(?:cn|com))\//.test(value)) {
    const { requestNativeDownload } = await import('./nativeDownloadClient')
    const reply = await requestNativeDownload({ method: 'expandLink', params: { video: value } })
    if (!reply.ok)
      throw new Error(reply.error)
    value = reply.result
  }
  const id = parseDownloadId(value)
  const info = await biliApi('/x/web-interface/view', id.startsWith('av') ? { aid: id.slice(2) } : { bvid: id })
  const collection = info.ugc_season
    ? {
        id: info.ugc_season.id,
        title: info.ugc_season.title,
        sections: (info.ugc_season.sections || []).map((section: any) => ({
          id: section.id,
          title: section.title,
          videos: (section.episodes || []).map((ep: any) => ({ bvid: ep.bvid, cid: ep.cid, title: ep.title, available: /^BV[0-9A-Za-z]{10}$/.test(ep.bvid || '') && Number(ep.cid) > 0 && ep.arc?.stat?.view !== -1 })),
        })),
      }
    : undefined
  const requestedPage = typeof value === 'string' && value.startsWith('https:') ? Number(new URL(value).searchParams.get('p')) || 1 : 1
  return { requestedPage, bvid: info.bvid || id, title: info.title, author: info.owner?.name || '', uid: info.owner?.mid || 0, pubdate: info.pubdate || 0, description: info.desc || '', cover: info.pic, pages: info.pages.map((p: any) => ({ cid: p.cid, page: p.page, title: p.part, duration: p.duration })), collection }
}

export async function inspectSubtitles(bvid: unknown, cid: unknown): Promise<{ language: string, label: string }[]> {
  if (!Number.isSafeInteger(Number(cid)) || Number(cid) <= 0)
    throw new Error('无效分 P')
  const data = await biliApi('/x/player/v2', { bvid: parseDownloadId(bvid), cid: String(cid) })
  return (data.subtitle?.subtitles || []).map((track: any) => ({ language: track.lan, label: track.lan_doc || track.lan }))
}

export async function inspectFormats(bvid: unknown, cid: unknown): Promise<AvailableMediaFormats> {
  if (!Number.isSafeInteger(Number(cid)) || Number(cid) <= 0)
    throw new Error('无效分 P')
  const data = await biliApi('/x/player/playurl', { bvid: parseDownloadId(bvid), cid: String(cid), qn: '127', fnval: '4048', fnver: '0', fourk: '1' })
  if (data.is_preview === true || data.is_preview === 1 || data.accept_description?.some((label: string) => label.includes('试看')))
    throw new Error('当前账号仅能获取试看画质，请确认视频访问权限')
  const formats = new Map<string, AvailableVideoFormat>()
  const audio = new Map<number, AvailableAudioFormat>()
  // Advertised accept_quality can include locked tiers. Only actual DASH streams
  // match the set used by both download resolvers, without exposing signed URLs.
  for (const stream of data.dash?.video || []) {
    if (Number.isSafeInteger(stream.id) && stream.id > 0 && [7, 12, 13].includes(stream.codecid) && (stream.baseUrl || stream.base_url))
      formats.set(`${stream.id}:${stream.codecid}`, { quality: stream.id, codec: stream.codecid })
  }
  for (const stream of [...(data.dash?.audio || []), ...(data.dash?.dolby?.audio || []), ...(data.dash?.flac?.audio ? [data.dash.flac.audio] : [])]) {
    if (!audioRank(stream.id) || !(stream.baseUrl || stream.base_url))
      continue
    const bandwidth = Number.isFinite(stream.bandwidth) ? Math.max(0, stream.bandwidth) : 0
    if (!audio.has(stream.id) || bandwidth > audio.get(stream.id)!.bandwidth)
      audio.set(stream.id, { id: stream.id, bandwidth })
  }
  if (!formats.size && !audio.size)
    throw new Error('当前账号或视频未提供可下载画质或音轨，请稍后重试')
  return { video: [...formats.values()].sort((a, b) => b.quality - a.quality || a.codec - b.codec), audio: [...audio.values()].sort((a, b) => audioRank(b.id) - audioRank(a.id)) }
}

export async function inspectQualities(bvid: unknown, cid: unknown): Promise<AvailableVideoFormat[]> {
  const result = await inspectFormats(bvid, cid)
  if (!result.video.length)
    throw new Error('当前账号或视频未提供可下载画质，请稍后重试')
  return result.video
}

export async function resolveDownload(bvid: string, cid: number, options: DownloadOptions) {
  options = normalizeDownloadOptions(options)
  const data = await biliApi('/x/player/playurl', { bvid: parseDownloadId(bvid), cid: String(cid), qn: String(options.quality || 127), fnval: '4048', fnver: '0', fourk: '1' })
  if (data.is_preview === true || data.is_preview === 1 || data.accept_description?.some((label: string) => label.includes('试看')))
    throw new Error('接口仅提供试看内容，未下载不完整的视频')
  const videos: any[] = data.dash?.video || []
  const codecs = { avc: 7, hevc: 12, av1: 13 }
  const candidates = videos.filter(v => options.codec === 'auto' || v.codecid === codecs[options.codec])
  const quality = options.quality || Math.max(...candidates.map(v => v.id))
  const video = candidates.filter(v => v.id === quality).sort((a, b) => b.bandwidth - a.bandwidth)[0]
  const audios = [...(data.dash?.audio || []), ...(data.dash?.dolby?.audio || []), ...(data.dash?.flac?.audio ? [data.dash.flac.audio] : [])]
  const audio = selectAudio<any>(audios.filter(a => a.baseUrl || a.base_url), options.audioQuality)
  const needVideo = options.outputs.some(kind => ['video', 'silent'].includes(kind))
  const needAudio = options.outputs.some(kind => ['video', 'audio', 'mp3'].includes(kind))
  if (needVideo && !video)
    throw new Error('当前账号或视频没有所选画质和编码，没有自动降级')
  if (needAudio && !audio)
    throw new Error('当前账号或视频没有所选音质，没有自动替换音轨')
  const stream = (value: any) => value ? { urls: [value.baseUrl || value.base_url, ...(value.backupUrl || value.backup_url || [])].filter(Boolean), quality: value.id, id: value.id, codec: value.codecid || 0, codecs: value.codecs || '', bandwidth: value.bandwidth || 0 } : null
  let subtitleTracks: { language: string, url: string }[] | undefined
  if (options.outputs.includes('srt')) {
    const subtitles = await biliApi('/x/player/v2', { bvid, cid: String(cid) })
    subtitleTracks = (subtitles.subtitle?.subtitles || []).map((track: any) => ({ language: track.lan, url: track.subtitle_url }))
  }
  return { video: needVideo ? stream(video) : null, audio: needAudio ? stream(audio) : null, subtitleTracks }
}
