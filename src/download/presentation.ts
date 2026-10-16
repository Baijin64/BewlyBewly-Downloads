import type { DownloadTask, OutputKind } from './types'

export const outputLabels: Record<OutputKind, string> = { video: '有声视频', silent: '无声视频', audio: '原生音频', mp3: '音频 MP3', cover: '封面', xml: 'XML 弹幕', ass: 'ASS 弹幕', srt: 'SRT 字幕', nfo: '保存视频资料（NFO）' }
export const statusLabels: Record<DownloadTask['status'], string> = { pending: '待下载', queued: '排队中', resolving: '正在解析', downloading: '下载中', paused: '已暂停', muxing: '处理媒体', postprocessing: '保存附件', completed: '已完成', failed: '失败', cancelled: '已取消' }
export const qualities = [
  { value: 0, label: '最高可用画质' },
  { value: 127, label: '8K' },
  { value: 126, label: '杜比视界' },
  { value: 125, label: 'HDR' },
  { value: 120, label: '4K' },
  { value: 116, label: '1080P 高帧率' },
  { value: 112, label: '1080P 高码率' },
  { value: 80, label: '1080P' },
  { value: 74, label: '720P 高帧率' },
  { value: 64, label: '720P' },
  { value: 32, label: '480P' },
  { value: 16, label: '360P' },
]
export const audioQualities = [{ value: 'auto', label: '最高可用音质' }, { value: '64', label: '64K' }, { value: '132', label: '132K' }, { value: '192', label: '192K' }, { value: 'dolby', label: '杜比全景声' }, { value: 'hires', label: 'Hi-Res 无损' }]
export const codecs = [{ value: 'auto', label: '自动' }, { value: 'avc', label: 'AVC / H.264' }, { value: 'hevc', label: 'HEVC / H.265' }, { value: 'av1', label: 'AV1' }]
