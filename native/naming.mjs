import { audioIds } from './audio.mjs'

export function safeName(value) {
  const name = String(value).normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/g, '').slice(0, 150)
  return !name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? '_' + (name || 'video') : name
}

const tokens = new Set(['title', 'upnn', 'uid', 'aqn', 'vqn', 'bv', 'cid', 'index', 'part', 'collection', 'vtype', 'upnn-uid', 'uid-upnn', 'v'])
export function validateTemplate(template) {
  for (const match of template.matchAll(/%([^%]+)%/g)) {
    if (!tokens.has(match[1]) && !/^(?:dd|pd)(?::(?:YYYY|MM|DD|YYYYMMDD))?$/.test(match[1]) && !/^index:(?:0|00|01)$/.test(match[1])) throw new Error('不支持的命名变量：%' + match[1] + '%')
  }
}

export function dateValue(value, format) {
  const date = new Date(value || 0)
  if (Number.isNaN(date.getTime())) return ''
  const year = String(date.getFullYear()), month = String(date.getMonth() + 1).padStart(2, '0'), day = String(date.getDate()).padStart(2, '0')
  return ({ YYYY: year, MM: month, DD: day, YYYYMMDD: year + month + day })[format] || year + '-' + month + '-' + day
}

export function renderTemplate(template, task, streams = {}) {
  const index = task.group?.index || task.page || 1
  const title = task.part && task.pageCount > 1 ? task.part : task.title
  const videoQuality = streams.video?.quality || task.options.quality
  const qualityLabels = { 16: '360P', 32: '480P', 64: '720P', 74: '720P 高帧', 80: '1080P', 112: '1080P 高码', 116: '1080P 高帧', 120: '4K', 125: 'HDR', 126: '杜比', 127: '8K' }
  const audioLabels = { 30216: '64K', 30232: '132K', 30280: '192K', 30250: '杜比全景声', 30251: 'Hi-Res无损' }
  const values = { title, part: task.part || task.title, upnn: task.author || '', uid: task.uid || '', bv: task.bvid, cid: task.cid, index, v: '0.2.8',
    aqn: [audioLabels[streams.audio?.id || audioIds[task.options.audioQuality]] || 'auto', (streams.audio?.codecs || '').split('.')[0]].filter(Boolean).join(' '),
    vqn: [qualityLabels[videoQuality] || 'auto', ({ 7: 'avc1', 12: 'hev1', 13: 'av01' })[streams.video?.codec] || task.options.codec].filter(Boolean).join(' '), collection: task.group?.title || '',
    vtype: task.group ? '合集视频' : task.pageCount > 1 ? '分集视频' : '单视频',
    'upnn-uid': (task.author || '') + '-' + (task.uid || ''), 'uid-upnn': (task.uid || '') + '-' + (task.author || ''),
  }
  if (!task.group && !(task.pageCount > 1)) template = template.replace(/%index(?::0|:00|:01)?%[^%]*/g, '')
  return template.replace(/%([^%]+)%/g, (_, token) => {
    if (token === 'index:0') return String(index - 1)
    if (token === 'index:00') return String(index - 1).padStart(2, '0')
    if (token === 'index:01') return String(index).padStart(2, '0')
    if (/^(dd|pd)(:|$)/.test(token)) return dateValue(token.startsWith('dd') ? task.createdAt : Number(task.pubdate || 0) * 1000, token.split(':')[1])
    return String(values[token] ?? '')
  })
}

export function planLocation(task, streams = {}) {
  const parts = (task.options.folderTemplate || '').split(/[\\/]+/).filter(Boolean).map(part => safeName(renderTemplate(part, task, streams)))
  if (task.group?.title) parts.push(safeName(task.group.title))
  else if (task.pageCount > 1) parts.push(safeName(task.title))
  if (task.options.createFolder && task.options.outputs.length > 1) parts.push(safeName((task.options.createFolderAddIndex ? String(task.group?.index || task.page || 1).padStart(2, '0') + ' ' : '') + (task.part || task.title)))
  return { parts, basename: safeName(renderTemplate(task.options.filenameTemplate, task, streams)) }
}
