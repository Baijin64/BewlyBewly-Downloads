import { afterEach, expect, it, vi } from 'vitest'

import { inspectDownload, inspectFormats, inspectQualities, inspectSubtitles, parseDownloadId, resolveDownload } from '~/background/downloadResolver'
import { defaultOptions } from '~/download/types'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('rejects foreign links before making a network request', () => {
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  expect(() => parseDownloadId('https://bilibili.com.evil.test/video/BV1GJ411x7h7')).toThrow()
  expect(fetcher).not.toHaveBeenCalled()
})

it('uses the browser login session and preserves part identities', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ code: 0, data: { title: '示例', owner: { name: 'UP' }, pic: '', pages: [{ cid: 42, page: 1, part: '第一集', duration: 30 }] } }) })
  vi.stubGlobal('fetch', fetcher)
  const info = await inspectDownload('BV1GJ411x7h7')
  expect(info.pages[0].cid).toBe(42)
  expect(fetcher.mock.calls[0][1].credentials).toBe('include')
})

it('selects the requested codec and reports unavailable qualities', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ code: 0, data: { dash: { video: [{ id: 80, codecid: 7, baseUrl: 'https://cdn.bilivideo.com/v', bandwidth: 50 }, { id: 80, codecid: 12, baseUrl: 'https://cdn.bilivideo.com/h', bandwidth: 40 }], audio: [{ id: 30280, baseUrl: 'https://cdn.bilivideo.com/a', bandwidth: 10 }] } } }) }))
  const result = await resolveDownload('BV1GJ411x7h7', 42, { ...defaultOptions, quality: 80, codec: 'hevc' })
  expect(result.video?.codec).toBe(12)
  await expect(resolveDownload('BV1GJ411x7h7', 42, { ...defaultOptions, quality: 120 })).rejects.toThrow('画质')
})

it('surfaces HTTP 412 instead of treating it as a playable video', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 412 }))
  await expect(inspectDownload('BV1GJ411x7h7')).rejects.toThrow('412')
})

it('lists subtitle languages by display name without exposing subtitle URLs', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ code: 0, data: { subtitle: { subtitles: [{ lan: 'ai-zh', lan_doc: '中文（自动生成）', subtitle_url: 'https://aisubtitle.hdslb.com/private.json' }] } } }) }))
  expect(await inspectSubtitles('BV1GJ411x7h7', 42)).toEqual([{ language: 'ai-zh', label: '中文（自动生成）' }])
  await expect(inspectSubtitles('BV1GJ411x7h7', -1)).rejects.toThrow('分 P')
})

it('reports actual downloadable qualities rather than advertised locked tiers', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ code: 0, data: {
    accept_quality: [127, 126, 120, 80],
    dash: { video: [
      { id: 80, codecid: 7, baseUrl: 'https://cdn.bilivideo.com/private?token=secret' },
      { id: 80, codecid: 7, base_url: 'https://cdn.bilivideo.com/duplicate' },
      { id: 80, codecid: 12, base_url: 'https://cdn.bilivideo.com/hevc' },
    ] },
  } }) })
  vi.stubGlobal('fetch', fetcher)
  expect(await inspectQualities('BV1GJ411x7h7', 42)).toEqual([{ quality: 80, codec: 7 }, { quality: 80, codec: 12 }])
  expect(fetcher.mock.calls[0][1].credentials).toBe('include')
  expect(fetcher.mock.calls[0][0].searchParams.get('qn')).toBe('127')
  await expect(inspectQualities('BV1GJ411x7h7', 0)).rejects.toThrow('分 P')
})

it('does not describe preview-only or missing streams as available qualities', async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 0, data: { is_preview: 1 } }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 0, data: { accept_quality: [127, 126], dash: { video: [] } } }) })
  vi.stubGlobal('fetch', fetcher)
  await expect(inspectQualities('BV1GJ411x7h7', 42)).rejects.toThrow('试看')
  await expect(inspectQualities('BV1GJ411x7h7', 42)).rejects.toThrow('未提供可下载画质')
})

it('returns actual audio tiers and selects the same highest tier for immediate downloads', async () => {
  const audio = (id: number, bandwidth: number) => ({ id, bandwidth, baseUrl: `https://cdn.bilivideo.com/${id}?private=signed` })
  const data = { dash: {
    video: [{ id: 80, codecid: 7, baseUrl: 'https://cdn.bilivideo.com/video' }],
    audio: [audio(30280, 192000)],
    dolby: { audio: [audio(30250, 256000)] },
    flac: { audio: audio(30251, 100000) },
  } }
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => ({ ok: true, json: async () => ({ code: 0, data }) })))
  expect((await inspectFormats('BV1GJ411x7h7', 42)).audio).toEqual([{ id: 30251, bandwidth: 100000 }, { id: 30250, bandwidth: 256000 }, { id: 30280, bandwidth: 192000 }])
  expect((await resolveDownload('BV1GJ411x7h7', 42, defaultOptions)).audio?.id).toBe(30251)
  expect((await resolveDownload('BV1GJ411x7h7', 42, { ...defaultOptions, audioQuality: '192' })).audio?.id).toBe(30280)
  data.dash.flac.audio.baseUrl = ''
  expect((await inspectFormats('BV1GJ411x7h7', 42)).audio.map(track => track.id)).toEqual([30250, 30280])
  expect((await resolveDownload('BV1GJ411x7h7', 42, defaultOptions)).audio?.id).toBe(30250)
})
