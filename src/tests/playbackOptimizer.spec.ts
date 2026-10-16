import { describe, expect, it, vi } from 'vitest'

import type { PlaybackSample, PlaybackStream } from '~/playback/engine'
import {
  fasterProbe,
  playbackCause,
  PlaybackOptimizer,
  trustedMedia,
} from '~/playback/engine'

const sample: PlaybackSample = {
  bvid: 'BV17x411w7KC',
  page: 1,
  buffer: 0,
  waitingSeconds: 12,
  playing: true,
  seeking: false,
  visible: true,
  droppedRatio: 0,
}
const primary
  = 'https://primary.bilivideo.com/video-80-avc.m4s?deadline=9999999999'
const backup
  = 'https://backup.bilivideo.com/video-80-avc.m4s?deadline=9999999999'
const stream: PlaybackStream = {
  kind: 'video',
  id: 80,
  codec: 7,
  codecs: 'avc1',
  bandwidth: 100,
  urls: [primary, backup],
}
function fixture(streams = [stream]) {
  let now = 100000
  const io = {
    now: () => now,
    api: vi.fn(async () => streams),
    allowed: vi.fn(async (_url: string) => true),
    probe: vi.fn(async (url: string) => ({
      url,
      bytesPerSecond: url.includes('backup') ? 300 : 100,
      elapsed: 100,
    })),
    redirect: vi.fn(async (): Promise<void | (() => Promise<void>)> => {}),
    clearRules: vi.fn(async () => {}),
    persist: vi.fn(),
  }
  const optimizer = new PlaybackOptimizer(io)
  return {
    optimizer,
    io,
    advance: (ms: number) => {
      now += ms
    },
  }
}
describe('playback diagnosis', () => {
  it('excludes pause, seek, hidden tabs and sufficient buffering', () => {
    expect(playbackCause(sample)).toBe('network')
    for (const change of [
      { playing: false },
      { seeking: true },
      { visible: false },
      { buffer: 10 },
    ])
      expect(playbackCause({ ...sample, ...change })).toBe('idle')
    expect(playbackCause({ ...sample, buffer: 8, droppedRatio: 0.25 })).toBe(
      'decode',
    )
  })
  it('rejects foreign, credential-bearing and nonstandard-port CDN addresses', () => {
    expect(
      trustedMedia('https://upos-hz-mirrorakam.akamaized.net/a'),
    ).toContain('akamaized.net')
    for (const url of [
      'https://evil.test/a',
      'https://unrelated.akamaized.net/a',
      'https://u:p@cdn.bilivideo.com/a',
      'https://cdn.bilivideo.com:4483/a',
    ])
      expect(() => trustedMedia(url)).toThrow()
  })
  it('requires a material improvement over a responsive baseline', () => {
    expect(
      fasterProbe(
        [
          { url: primary, bytesPerSecond: 100, elapsed: 1 },
          { url: backup, bytesPerSecond: 110, elapsed: 1 },
        ],
        primary,
      ),
    ).toBeUndefined()
  })
})

describe('official media failover', () => {
  it('does not recreate a closed tab after a pending rule cleanup finishes', async () => {
    const { optimizer, io } = fixture()
    let finish!: () => void
    io.clearRules.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const preparing = optimizer.prepare(7, {
      bvid: sample.bvid,
      cid: 42,
      quality: 80,
    })
    await optimizer.clear(7)
    finish()
    await preparing
    expect(optimizer.states.has(7)).toBe(false)
    expect(io.api).not.toHaveBeenCalled()
  })

  it('does not remove a retained video rule when an older audio switch finishes late', async () => {
    const audioPrimary = 'https://primary.bilivideo.com/audio.m4s'
    const audioBackup = 'https://backup.bilivideo.com/audio.m4s'
    const { optimizer, io } = fixture([
      stream,
      {
        ...stream,
        kind: 'audio',
        id: 30280,
        urls: [audioPrimary, audioBackup],
      },
    ])
    let finish!: (undo: () => Promise<void>) => void
    const undo = vi.fn(async () => {})
    io.redirect
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(
        () =>
          new Promise<() => Promise<void>>((resolve) => {
            finish = resolve
          }),
      )
    optimizer.observe(7, primary)
    optimizer.observe(7, audioPrimary)
    await optimizer.prepare(7, { bvid: sample.bvid, cid: 42, quality: 80 })
    const pending = optimizer.optimize(7, sample)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await optimizer.prepare(7, { bvid: sample.bvid, cid: 42, quality: 127 })
    const clearCount = io.clearRules.mock.calls.length
    finish(undo)
    await pending
    expect(undo).toHaveBeenCalledTimes(1)
    expect(io.clearRules).toHaveBeenCalledTimes(clearCount)
    expect(optimizer.state(7).redirects).toEqual([
      { source: primary, target: backup },
    ])
  })

  it('changes only an observed stream to its own official backup and retains specification', async () => {
    const { optimizer, io } = fixture()
    optimizer.observe(7, primary)
    await optimizer.prepare(7, { bvid: sample.bvid, cid: 42, quality: 80 })
    const result = await optimizer.optimize(7, sample)
    expect(io.redirect).toHaveBeenCalledTimes(1)
    expect(io.redirect).toHaveBeenCalledWith(7, primary, backup)
    expect(result.state).toBe('optimized')
    expect(result.reloadSuggested).toBe(true)
    expect(result.hosts).toEqual(['backup.bilivideo.com'])
    expect(JSON.stringify(result)).not.toContain('deadline')
    expect(optimizer.state(7).streams[0].id).toBe(80)
    expect(optimizer.state(7).streams[0].codec).toBe(7)
    await optimizer.optimize(7, { ...sample, buffer: 8, waitingSeconds: 0 })
    expect(optimizer.diagnostic(7).reloadSuggested).toBe(false)
  })
  it('does not probe or switch for decoder overload', async () => {
    const { optimizer, io } = fixture()
    optimizer.observe(7, primary)
    await optimizer.prepare(7, { bvid: sample.bvid, cid: 42, quality: 80 })
    expect(
      (
        await optimizer.optimize(7, {
          ...sample,
          buffer: 10,
          droppedRatio: 0.5,
        })
      ).state,
    ).toBe('decode')
    expect(io.probe).not.toHaveBeenCalled()
  })
  it('does not switch an unobserved or ambiguous media stream', async () => {
    const { optimizer, io } = fixture([stream, { ...stream, id: 120 }])
    optimizer.observe(7, primary)
    await optimizer.prepare(7, { bvid: sample.bvid, cid: 42, quality: 80 })
    expect((await optimizer.optimize(7, sample)).state).toBe('unavailable')
    expect(io.redirect).not.toHaveBeenCalled()
  })
  it('respects denied host access and limits retries during repeated stalls', async () => {
    const { optimizer, io, advance } = fixture()
    io.allowed.mockImplementation(async url => !url.includes('backup'))
    optimizer.observe(7, primary)
    await optimizer.prepare(7, { bvid: sample.bvid, cid: 42, quality: 80 })
    const result = await optimizer.optimize(7, sample)
    expect(result.missingOrigins).toEqual(['https://backup.bilivideo.com/*'])
    expect(io.redirect).not.toHaveBeenCalled()
    const count = io.probe.mock.calls.length
    await optimizer.optimize(7, sample)
    expect(io.probe).toHaveBeenCalledTimes(count)
    advance(61000)
    await optimizer.optimize(7, sample)
    expect(io.probe).toHaveBeenCalledTimes(count * 2)
    advance(61000)
    await optimizer.optimize(7, sample)
    expect(io.probe).toHaveBeenCalledTimes(count * 2)
  })
  it('rolls back a failed target without reloading the page', async () => {
    const { optimizer, io } = fixture()
    optimizer.observe(7, primary)
    await optimizer.prepare(7, { bvid: sample.bvid, cid: 42, quality: 80 })
    await optimizer.optimize(7, sample)
    await optimizer.failed(7, backup)
    expect(io.clearRules).toHaveBeenLastCalledWith(7)
    expect(optimizer.state(7).redirects).toHaveLength(0)
    expect(optimizer.diagnostic(7).state).toBe('failed')
  })
  it('ignores stale probe results after navigation and supports worker restoration', async () => {
    const { optimizer, io } = fixture()
    let finish!: (value: {
      url: string
      bytesPerSecond: number
      elapsed: number
    }) => void
    io.probe.mockImplementation(url =>
      url === backup
        ? new Promise((resolve) => {
          finish = resolve
        })
        : Promise.resolve({ url, bytesPerSecond: 1, elapsed: 100 }),
    )
    optimizer.observe(7, primary)
    await optimizer.prepare(7, { bvid: sample.bvid, cid: 42, quality: 80 })
    const pending = optimizer.optimize(7, sample)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const snapshot = optimizer.snapshot()
    const restored = fixture().optimizer
    restored.restore(snapshot)
    expect(restored.state(7).identity?.cid).toBe(42)
    await optimizer.clear(7)
    finish({ url: backup, bytesPerSecond: 500, elapsed: 100 })
    await pending
    expect(io.redirect).not.toHaveBeenCalled()
  })
})
