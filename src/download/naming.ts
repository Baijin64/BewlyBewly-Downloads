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
