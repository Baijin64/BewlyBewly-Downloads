import path from 'node:path'

import { audioIds, selectAudio } from './audio.mjs'
import { dateValue, planLocation, safeName, validateTemplate } from './naming.mjs'
export { safeName, renderTemplate, validateTemplate } from './naming.mjs'
export { audioIds } from './audio.mjs'

export const outputKinds = ['video', 'silent', 'audio', 'mp3', 'cover', 'xml', 'ass', 'srt', 'nfo']
export const optionDefaults = {
  quality: 0, codec: 'auto', audioQuality: 'auto', mode: 'video', cover: false, subtitles: false,
  outputs: ['video'], subtitleLanguages: [], filenameTemplate: '%title% [%bv%-%cid%]',
  folderTemplate: '', createFolder: false, createFolderAddIndex: false,
}

export function validateOptions(value = {}) {
  const quality = Number(value.quality ?? 0)
  if (![0, 16, 32, 64, 74, 80, 112, 116, 120, 125, 126, 127].includes(quality)) throw new Error('无效画质')
  const codec = value.codec ?? 'auto'
  const mode = value.mode ?? 'video'
  const audioQuality = String(value.audioQuality ?? 'auto')
  if (!['auto', 'avc', 'hevc', 'av1'].includes(codec) || !['video', 'audio'].includes(mode) || !['auto', ...Object.keys(audioIds)].includes(audioQuality)) throw new Error('无效下载格式')
  const requested = value.outputs ?? [mode === 'audio' ? 'audio' : 'video', ...(value.cover ? ['cover'] : []), ...(value.subtitles ? ['srt'] : [])]
  if (!Array.isArray(requested) || !requested.length || requested.some(kind => !outputKinds.includes(kind))) throw new Error('请至少选择一种下载内容')
  const outputs = outputKinds.filter(kind => requested.includes(kind))
  const subtitleLanguages = value.subtitleLanguages ?? []
  if (!Array.isArray(subtitleLanguages) || subtitleLanguages.length > 50 || subtitleLanguages.some(lan => typeof lan !== 'string' || !/^[\w-]{1,40}$/.test(lan))) throw new Error('无效字幕语言')
  const filenameTemplate = value.filenameTemplate ?? optionDefaults.filenameTemplate
  const folderTemplate = value.folderTemplate ?? ''
  for (const template of [filenameTemplate, folderTemplate]) {
    if (typeof template !== 'string' || template.length > 300 || /[\x00-\x1f]/.test(template)) throw new Error('命名规则过长或包含控制字符')
    validateTemplate(template)
  }
  if (!filenameTemplate.trim()) throw new Error('文件名规则不能为空')
  return { quality, codec, audioQuality, mode, outputs, subtitleLanguages: [...new Set(subtitleLanguages)], cover: outputs.includes('cover'), subtitles: outputs.includes('srt'), filenameTemplate, folderTemplate, createFolder: value.createFolder === true, createFolderAddIndex: value.createFolderAddIndex === true }
}

export function outputLocation(task, streams = {}) {
  const root = path.resolve(task.directory)
  const { parts, basename } = planLocation(task, streams)
  const directory = path.resolve(root, ...parts)
  const relative = path.relative(root, directory)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('输出目录超出保存位置')
  if (path.join(directory, basename).length > 235) throw new Error('输出路径过长，请缩短命名规则或保存目录')
  return { directory, basename }
}

export function selectStreams(data, options) {
  options = validateOptions(options)
  if (data.is_preview === true || data.is_preview === 1 || data.accept_description?.some(label => String(label).includes('试看'))) throw new Error('接口仅提供试看内容，未下载不完整的视频')
  const videos = data.dash?.video || []
  const needVideo = options.outputs.some(kind => ['video', 'silent'].includes(kind))
  const needAudio = options.outputs.some(kind => ['video', 'audio', 'mp3'].includes(kind))
  const codes = { avc: 7, hevc: 12, av1: 13 }
  const candidates = videos.filter(v => options.codec === 'auto' || v.codecid === codes[options.codec])
  const quality = options.quality || Math.max(...candidates.map(v => v.id))
  const video = candidates.filter(v => v.id === quality).sort((a, b) => b.bandwidth - a.bandwidth)[0]
  const audios = [...(data.dash?.audio || []), ...(data.dash?.dolby?.audio || []), ...(data.dash?.flac?.audio ? [data.dash.flac.audio] : [])]
  const audio = selectAudio(audios.filter(a => a.baseUrl || a.base_url), options.audioQuality)
  if (needVideo && !video) throw new Error('当前账号或视频没有所选画质和编码，没有自动降级')
  if (needAudio && !audio) throw new Error('当前账号或视频没有所选音质，没有自动替换音轨')
  const stream = input => input ? { urls: [input.baseUrl || input.base_url, ...(input.backupUrl || input.backup_url || [])].filter(Boolean), quality: input.id, id: input.id, codec: input.codecid || 0, codecs: input.codecs || '', bandwidth: input.bandwidth || 0 } : null
  return { video: needVideo ? stream(video) : null, audio: needAudio ? stream(audio) : null }
}

export function toSrt(cues) {
  const stamp = seconds => {
    const ms = Math.max(0, Math.round(Number(seconds) * 1000))
    return String(Math.floor(ms / 3600000)).padStart(2, '0') + ':' + String(Math.floor(ms / 60000) % 60).padStart(2, '0') + ':' + String(Math.floor(ms / 1000) % 60).padStart(2, '0') + ',' + String(ms % 1000).padStart(3, '0')
  }
  if (!Array.isArray(cues) || !cues.length || cues.some(cue => !Number.isFinite(Number(cue.from)) || !Number.isFinite(Number(cue.to)) || Number(cue.to) < Number(cue.from) || typeof cue.content !== 'string')) throw new Error('CC 文件没有有效字幕')
  return cues.map((cue, index) => String(index + 1) + '\n' + stamp(cue.from) + ' --> ' + stamp(cue.to) + '\n' + cue.content + '\n').join('\n')
}

export function srtText(value, lineBreaks = true) {
  const lines = []
  for (const block of String(value).replace(/^\uFEFF/, '').split(/\r?\n\s*\r?\n/)) {
    const blockLines = block.split(/\r?\n/)
    const time = blockLines.findIndex(line => /^\d{2,}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(line.trim()))
    if (time >= 0) lines.push(...blockLines.slice(time + 1).filter(line => line.trim()))
  }
  if (!lines.length) throw new Error('SRT 文件没有有效字幕')
  return lines.map(line => line.replace(/<[^>]*>/g, '')).join(lineBreaks ? '\n' : '')
}

export const xmlEscape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char])
const xmlDecode = value => value.replace(/&#(x[0-9a-f]+|\d+);|&(amp|lt|gt|quot|apos);/gi, (_, number, name) => number ? String.fromCodePoint(Math.min(0x10ffff, number[0].toLowerCase() === 'x' ? parseInt(number.slice(1), 16) : Number(number))) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name.toLowerCase()])

export function toAss(xml) {
  const header = '[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Microsoft YaHei,48,&H00FFFFFF,&H00FFFFFF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,2,0,7,0,0,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
  const stamp = seconds => { const cs = Math.max(0, Math.round(seconds * 100)); return Math.floor(cs / 360000) + ':' + String(Math.floor(cs / 6000) % 60).padStart(2, '0') + ':' + String(Math.floor(cs / 100) % 60).padStart(2, '0') + '.' + String(cs % 100).padStart(2, '0') }
  const lanes = { scroll: Array(14).fill(0), top: Array(4).fill(0), bottom: Array(4).fill(0) }
  const comments = [...String(xml).matchAll(/<d\s+p="([^"]+)"[^>]*>([\s\S]*?)<\/d>/g)].map(match => ({ p: match[1].split(','), text: xmlDecode(match[2]) })).sort((a, b) => Number(a.p[0]) - Number(b.p[0]))
  const events = []
  for (const { p, text } of comments) {
    const time = Number(p[0]), mode = Number(p[1]), size = Math.min(96, Math.max(24, Number(p[2]) * 2)), color = Number(p[3])
    if (!Number.isFinite(time) || !Number.isFinite(size) || !Number.isFinite(color) || ![1, 2, 3, 4, 5, 6].includes(mode)) continue
    const group = mode === 4 ? 'bottom' : mode === 5 ? 'top' : 'scroll', pool = lanes[group]
    let lane = pool.findIndex(until => until <= time)
    if (lane < 0) lane = pool.indexOf(Math.min(...pool))
    pool[lane] = time + (group === 'scroll' ? 2 : 4)
    const y = group === 'bottom' ? 1000 - lane * 60 : 30 + lane * 64
    const motion = group === 'scroll' ? (mode === 6 ? '\\move(-500,' + y + ',1920,' + y + ')' : '\\move(1920,' + y + ',-' + Math.max(500, text.length * size) + ',' + y + ')') : '\\an8\\pos(960,' + y + ')'
    const rgb = color.toString(16).padStart(6, '0').slice(-6), bgr = rgb.slice(4) + rgb.slice(2, 4) + rgb.slice(0, 2)
    events.push('Dialogue: 0,' + stamp(time) + ',' + stamp(time + (group === 'scroll' ? 8 : 4)) + ',Default,,0,0,0,,{' + motion + '\\fs' + size + '\\c&H' + bgr + '&}' + text.replace(/[{}\\]/g, ' ').replace(/\r?\n/g, '\\N'))
  }
  return header + events.join('\n') + '\n'
}

export function toNfo(task) {
  const tag = (name, value) => '  <' + name + '>' + xmlEscape(value) + '</' + name + '>\n'
  return '<?xml version="1.0" encoding="UTF-8"?>\n<movie>\n' + tag('title', task.part || task.title) + tag('originaltitle', task.title) + tag('plot', task.description || '') + tag('studio', task.author) + tag('premiered', dateValue(Number(task.pubdate || 0) * 1000)) + tag('thumb', task.cover) + tag('website', 'https://www.bilibili.com/video/' + task.bvid + '/?p=' + task.page) + '  <uniqueid type="bilibili" default="true">' + xmlEscape(task.bvid + '-' + task.cid) + '</uniqueid>\n</movie>\n'
}
