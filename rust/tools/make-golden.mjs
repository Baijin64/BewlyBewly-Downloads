// Generates golden fixtures by running the Node implementation, so the Rust port
// can be diffed byte-for-byte against it.
//
//   node rust/tools/make-golden.mjs <output.json> [cases]

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { planLocation } from '../../native/naming.mjs'
import { optionDefaults, outputKinds, selectStreams, toAss, toNfo, toSrt, srtText, validateOptions } from '../../native/formats.mjs'

const output = process.argv[2]
const total = Number(process.argv[3] || 200)
if (!output) {
  console.error('usage: node rust/tools/make-golden.mjs <output.json> [cases]')
  process.exit(2)
}

let seed = 0x9e3779b9
const random = () => {
  seed = (seed + 0x6d2b79f5) >>> 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = list => list[Math.floor(random() * list.length)]
const int = (min, max) => min + Math.floor(random() * (max - min + 1))

const titles = [
  '普通视频', '标题 with spaces', 'a/b:c*?"<>|', 'CON', 'con.txt', 'com1', 'trailing. . ',
  '😀 emoji 标题 😀😀', '字'.repeat(160), '很长的标题'.repeat(30), '', '   ', '第 01 集：开场',
  'A&B <tag> "quote"', 'a'.repeat(150) + '😀', '..........',
]
const authors = ['UP主', 'A&B', '名字/带斜杠', '', '测试 UP']
const templates = [
  '%title% [%bv%-%cid%]', '%index:00%-%title%', '%index:01%-%part%', '%title%',
  '%upnn%/%dd:YYYY%/%title%', '%v%-%vtype%-%collection%', '%index%',
  '%title%-%aqn%-%vqn%', '%upnn-uid%', '%uid-upnn%', '%dd:YYYYMMDD%',
]
const folderTemplates = ['', '%upnn%', '%upnn%/%dd:YYYY%', '合集/%collection%', '../逃逸', '/绝对']

const cases = { naming: [], options: [], srt: [], srtText: [], ass: [], nfo: [], select: [] }

for (let index = 0; index < total; index++) {
  const pageCount = pick([1, 1, 2, 5, 12])
  const page = int(1, pageCount)
  const makeGroup = random() < 0.4
  const task = {
    title: pick(titles),
    part: pick(['', '第一集', 'P' + page, '😀 分P']),
    author: pick(authors),
    bvid: 'BV1' + Math.floor(random() * 1e9).toString(36).padEnd(9, 'x').slice(0, 9),
    cid: int(1, 999999),
    page,
    pageCount,
    uid: pick([0, 12345, 987654321]),
    pubdate: pick([0, 1700000000, 1600000000]),
    createdAt: pick(['', '2026-10-27T00:00:00.000Z', '2023-05-06T12:34:56.000Z']),
    group: makeGroup ? { index: int(1, 20), title: pick(['合集', '系列 视频', '']) } : undefined,
    options: {
      ...optionDefaults,
      quality: pick([0, 80, 112, 127]),
      audioQuality: pick(['auto', '192', 'hires']),
      codec: pick(['auto', 'avc']),
      outputs: pick([['video'], ['video', 'cover'], ['audio'], ['cover', 'nfo'], ['video', 'audio', 'mp3', 'cover', 'xml', 'ass', 'srt', 'nfo']]),
      filenameTemplate: pick(templates),
      folderTemplate: pick(folderTemplates),
      createFolder: random() < 0.5,
      createFolderAddIndex: random() < 0.5,
    },
  }
  cases.naming.push({ task, parts: planLocation(task).parts, basename: planLocation(task).basename })

  const optionInput = {
    quality: pick([0, 16, 80, 126, 99, '80', 'bad', undefined]),
    codec: pick(['auto', 'hevc', 'vp9', undefined]),
    audioQuality: pick(['auto', '64', 'dolby', 'xxx', undefined]),
    mode: pick(['video', 'audio', undefined]),
    outputs: pick([['video'], ['nfo', 'video', 'cover'], [], ['bogus'], undefined]),
    subtitleLanguages: pick([[], ['zh-CN'], ['zh-CN', 'zh-CN'], ['bad lang!'], undefined]),
    filenameTemplate: pick(templates.concat(['%unknown%', '%title'])),
    folderTemplate: pick(folderTemplates),
    createFolder: pick([true, false, undefined]),
    createFolderAddIndex: pick([true, false, undefined]),
  }
  try {
    cases.options.push({ input: optionInput, expected: validateOptions(optionInput) })
  } catch (error) {
    cases.options.push({ input: optionInput, error: error.message })
  }


  const qualityIds = [16, 32, 64, 80, 112, 120, 125, 126, 127]
  const stream = (id, codecid, bandwidth, url) => ({
    id, codecid, bandwidth, codecs: pick(['avc1.640028', 'hev1.1.6', 'av01.0.08M']),
    baseUrl: url ? `https://upos-sz-mirror.bilivideo.com/${id}.m4s?sig=${index}` : undefined,
    backupUrl: random() < 0.5 ? [`https://upos-hz-mirror.bilivideo.com/${id}.m4s`] : undefined,
  })
  const dash = {
    is_preview: pick([undefined, false, true, 1, 0]),
    accept_description: pick([undefined, ['高清 1080P'], ['试看', '1080P'], []]),
    dash: {
      video: Array.from({ length: int(1, 5) }, () => stream(pick(qualityIds), pick([7, 12, 13]), int(1000, 9000000), random() < 0.85)),
      audio: Array.from({ length: int(0, 3) }, () => ({ id: pick([30216, 30232, 30280]), bandwidth: int(10000, 320000), baseUrl: pick([`https://upos-sz-mirror.bilivideo.com/a.m4s`, undefined]) })),
      dolby: random() < 0.4 ? { audio: [{ id: 30250, bandwidth: 448000, baseUrl: 'https://upos-sz-mirror.bilivideo.com/dolby.m4s' }] } : undefined,
      flac: random() < 0.4 ? { audio: { id: 30251, bandwidth: 1200000, baseUrl: random() < 0.5 ? 'https://upos-sz-mirror.bilivideo.com/flac.m4a' : undefined } } : undefined,
    },
  }
  const selectOptions = {
    ...optionDefaults,
    quality: pick([0, 80, 112, 127, 32]),
    codec: pick(['auto', 'avc', 'hevc', 'av1']),
    audioQuality: pick(['auto', '64', '192', 'dolby', 'hires']),
    outputs: pick([['video'], ['audio'], ['cover'], ['video', 'cover'], ['mp3']]),
  }
  try {
    cases.select.push({ data: dash, options: selectOptions, expected: selectStreams(dash, selectOptions) })
  } catch (error) {
    cases.select.push({ data: dash, options: selectOptions, error: error.message })
  }

  const cueCount = int(1, 4)
  const cues = Array.from({ length: cueCount }, () => ({
    from: pick([0, 1.234, 62.5, 3599.999, -1]),
    to: pick([2, 63.5, 3601]),
    content: pick(['第一行', 'line one\nline two', '', '<i>tagged</i>']),
  }))
  try {
    cases.srt.push({ cues, expected: toSrt(cues) })
  } catch (error) {
    cases.srt.push({ cues, error: error.message })
  }

  const srtSource = `\uFEFF1\n00:00:01,000 --> 00:00:02,500\n<i>标题</i>\n第二行\n\n2\n00:01:03.000 --> 00:01:04.000\n下一段\n`
  cases.srtText.push({ text: srtSource, breaks: true, expected: srtText(srtSource, true) })
  cases.srtText.push({ text: srtSource, breaks: false, expected: srtText(srtSource, false) })

  const danmaku = `<i>${Array.from({ length: int(1, 6) }, () => {
    const mode = int(1, 6)
    const color = pick([16777215, 255, 65280, 0])
    const text = pick(['滚动', '底部弹幕', '顶部', '{花括号}', 'a\\b', '换\n行', '&amp;实体'])
    return `<d p="${pick([1.5, 62.25, 0.01])},${mode},${pick([18, 25, 60])},${color}">${text}</d>`
  }).join('')}</i>`
  cases.ass.push({ xml: danmaku, expected: toAss(danmaku) })

  const nfoTask = { ...task, description: pick(['', '简介 & <text>']), cover: pick(['', 'https://i0.hdslb.com/a.jpg']) }
  cases.nfo.push({ task: nfoTask, expected: toNfo(nfoTask) })
}

mkdirSync(path.dirname(path.resolve(output)), { recursive: true })
writeFileSync(output, JSON.stringify({ kinds: outputKinds, cases }, null, 0))
console.log(`golden written: ${output} (${total} cases per kind)`)
