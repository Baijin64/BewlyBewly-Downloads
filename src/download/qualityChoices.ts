import { audioIds, audioRank, selectAudio } from './audio'
import { audioQualities, qualities } from './presentation'
import type { AvailableAudioFormat, AvailableVideoFormat, DownloadOptions } from './types'

export function qualityChoices(formats: AvailableVideoFormat[] | undefined, codec: DownloadOptions['codec'], selected: number) {
  if (!formats)
    return qualities
  const codecId = { avc: 7, hevc: 12, av1: 13 }
  const available = [...new Set(formats.filter(format => codec === 'auto' || format.codec === codecId[codec]).map(format => format.quality))].sort((a, b) => b - a)
  const label = (quality: number) => qualities.find(item => item.value === quality)?.label || `画质 ${quality}`
  const result = [
    { value: 0, label: available.length ? `最高可用 · ${label(available[0])}` : '当前编码暂无可用画质' },
    ...available.map(value => ({ value, label: label(value) })),
  ]
  if (selected && !available.includes(selected))
    result.push({ value: selected, label: `${label(selected)}（当前不可用）` })
  return result
}

export function audioChoices(formats: AvailableAudioFormat[] | undefined, selected: DownloadOptions['audioQuality']) {
  if (!formats)
    return audioQualities
  const available = [...new Set(formats.filter(format => audioRank(format.id)).map(format => format.id))].sort((a, b) => audioRank(b) - audioRank(a))
  const quality = (id: number) => Object.entries(audioIds).find(([, value]) => value === id)![0]
  const label = (id: number) => audioQualities.find(item => item.value === quality(id))!.label
  const best = selectAudio(formats)
  const choices = [
    { value: 'auto', label: best ? `最高可用 · ${label(best.id)}` : '当前视频暂无可用音轨' },
    ...available.map(id => ({ value: quality(id), label: label(id) })),
  ]
  if (selected !== 'auto' && !choices.some(item => item.value === selected))
    choices.push({ value: selected, label: `${audioQualities.find(item => item.value === selected)?.label || selected}（当前不可用）` })
  return choices
}
