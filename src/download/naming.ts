import { audioIds } from './audio'

export const filenamePresets = [
  { label: '视频标题', value: '%title%' },
  { label: '序号 + 标题', value: '%index:01% - %title%' },
  { label: 'UP 主 + 标题', value: '%upnn% - %title%' },
  { label: '标题 + 视频编号', value: '%title% [%bv%-%cid%]' },
]
export const folderPresets = [
  { label: '不分层', value: '' },
  { label: '按 UP 主', value: '%upnn%' },
  { label: '按合集', value: '%collection%' },
  { label: 'UP 主 / 发布年份', value: '%upnn%/%pd:YYYY%' },
]
export const namingVariables = [
  { label: '视频资料', items: [
    ['视频标题', '%title%'],
    ['分 P 标题', '%part%'],
    ['UP 主', '%upnn%'],
    ['UP 主 UID', '%uid%'],
    ['视频 BV 号', '%bv%'],
    ['分 P CID', '%cid%'],
    ['画质', '%vqn%'],
    ['音质', '%aqn%'],
    ['合集名称', '%collection%'],
  ] },
  { label: '日期', items: [
    ['下载日期', '%dd%'],
    ['下载年', '%dd:YYYY%'],
    ['下载月', '%dd:MM%'],
    ['下载日', '%dd:DD%'],
    ['下载年月日', '%dd:YYYYMMDD%'],
    ['发布日期', '%pd%'],
    ['发布年', '%pd:YYYY%'],
    ['发布月', '%pd:MM%'],
    ['发布日', '%pd:DD%'],
    ['发布年月日', '%pd:YYYYMMDD%'],
  ] },
  { label: '排序', items: [
    ['从 1 开始', '%index%'],
    ['从 0 开始', '%index:0%'],
    ['从 0 开始并补零', '%index:00%'],
    ['从 1 开始并补零', '%index:01%'],
  ] },
]

export function insertNamingVariable(value: string, token: string, start = value.length, end = start) {
  const left = Math.max(0, Math.min(value.length, start))
  const right = Math.max(left, Math.min(value.length, end))
  return { value: value.slice(0, left) + token + value.slice(right), caret: left + token.length }
}

export function safeName(value: unknown): string {
  const name = String(value).normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/g, '').slice(0, 150)
  return !name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `_${name || 'video'}` : name
}

const tokens = new Set(['title', 'upnn', 'uid', 'aqn', 'vqn', 'bv', 'cid', 'index', 'part', 'collection', 'vtype', 'upnn-uid', 'uid-upnn', 'v'])
export function validateTemplate(template: string): void {
  for (const match of template.matchAll(/%([^%]+)%/g)) {
    if (!tokens.has(match[1]) && !/^(?:dd|pd)(?::(?:YYYY|MM|DD|YYYYMMDD))?$/.test(match[1]) && !/^index:(?:0|00|01)$/.test(match[1]))
      throw new Error(`不支持的命名变量：%${match[1]}%`)
  }
}

export function dateValue(value: unknown, format?: string): string {
  const date = new Date((value as any) || 0)
  if (Number.isNaN(date.getTime()))
    return ''
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return ({ YYYY: year, MM: month, DD: day, YYYYMMDD: year + month + day })[format || ''] || `${year}-${month}-${day}`
}

export function renderTemplate(template: string, task: Record<string, any>, streams: Record<string, any> = {}): string {
  const index = task.group?.index || task.page || 1
  const title = task.part && task.pageCount > 1 ? task.part : task.title
  const videoQuality = streams.video?.quality || task.options.quality
  const qualityLabels: Record<number, string> = { 16: '360P', 32: '480P', 64: '720P', 74: '720P 高帧', 80: '1080P', 112: '1080P 高码', 116: '1080P 高帧', 120: '4K', 125: 'HDR', 126: '杜比', 127: '8K' }
  const audioLabels: Record<number, string> = { 30216: '64K', 30232: '132K', 30280: '192K', 30250: '杜比全景声', 30251: 'Hi-Res无损' }
  const values: Record<string, any> = {
    title,
    part: task.part || task.title,
    upnn: task.author || '',
    uid: task.uid || '',
    bv: task.bvid,
    cid: task.cid,
    index,
    v: '0.2.8',
    aqn: [audioLabels[streams.audio?.id || audioIds[task.options.audioQuality]] || 'auto', (streams.audio?.codecs || '').split('.')[0]].filter(Boolean).join(' '),
    vqn: [qualityLabels[videoQuality] || 'auto', ({ 7: 'avc1', 12: 'hev1', 13: 'av01' } as Record<number, string>)[streams.video?.codec] || task.options.codec].filter(Boolean).join(' '),
    collection: task.group?.title || '',
    vtype: task.group ? '合集视频' : task.pageCount > 1 ? '分集视频' : '单视频',
    'upnn-uid': `${task.author || ''}-${task.uid || ''}`,
    'uid-upnn': `${task.uid || ''}-${task.author || ''}`,
  }
  if (!task.group && !(task.pageCount > 1))
    template = template.replace(/%index(?::0|:00|:01)?%[^%]*/g, '')
  return template.replace(/%([^%]+)%/g, (_, token) => {
    if (token === 'index:0')
      return String(index - 1)
    if (token === 'index:00')
      return String(index - 1).padStart(2, '0')
    if (token === 'index:01')
      return String(index).padStart(2, '0')
    if (/^(dd|pd)(:|$)/.test(token))
      return dateValue(token.startsWith('dd') ? task.createdAt : Number(task.pubdate || 0) * 1000, token.split(':')[1])
    return String(values[token] ?? '')
  })
}

export function planLocation(task: Record<string, any>, streams: Record<string, any> = {}): { parts: string[], basename: string } {
  const parts = (task.options.folderTemplate || '').split(/[\\/]+/).filter(Boolean).map((part: string) => safeName(renderTemplate(part, task, streams)))
  if (task.group?.title)
    parts.push(safeName(task.group.title))
  else if (task.pageCount > 1)
    parts.push(safeName(task.title))
  if (task.options.createFolder && task.options.outputs.length > 1)
    parts.push(safeName((task.options.createFolderAddIndex ? `${String(task.group?.index || task.page || 1).padStart(2, '0')} ` : '') + (task.part || task.title)))
  return { parts, basename: safeName(renderTemplate(task.options.filenameTemplate, task, streams)) }
}
