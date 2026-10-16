import { expect, it } from 'vitest'

import { insertNamingVariable } from '~/download/naming'
import { audioChoices, qualityChoices } from '~/download/qualityChoices'
import { selectionGroup, selectionRows } from '~/download/selection'
import type { DownloadVideo } from '~/download/types'

const source: DownloadVideo = {
  bvid: 'BV1GJ411x7h7',
  title: '当前视频',
  author: 'UP',
  cover: '',
  pages: [{ cid: 42, page: 1, title: '第一集', duration: 60 }, { cid: 43, page: 2, title: '第二集', duration: 60 }],
  collection: { id: 1, title: '完整合集', sections: [
    { id: 1, title: '上篇', videos: [{ bvid: 'BV1GJ411x7h7', cid: 42, title: '当前视频', available: true }] },
    { id: 2, title: '下篇', videos: [{ bvid: 'BV17x411w7KC', cid: 44, title: '另一个视频', available: true }] },
  ] },
}

it('uses the highest actual quality for each codec and preserves explicit unavailable choices', () => {
  const formats = [{ quality: 80, codec: 7 }, { quality: 126, codec: 12 }, { quality: 127, codec: 13 }]
  expect(qualityChoices(formats, 'auto', 0)[0].label).toBe('最高可用 · 8K')
  expect(qualityChoices(formats, 'hevc', 0)[0].label).toBe('最高可用 · 杜比视界')
  expect(qualityChoices(formats, 'avc', 0)).toEqual([{ value: 0, label: '最高可用 · 1080P' }, { value: 80, label: '1080P' }])
  expect(qualityChoices(formats, 'avc', 120).at(-1)?.label).toBe('4K（当前不可用）')
  expect(qualityChoices([], 'auto', 0)[0].label).toContain('暂无')
})

it('displays the highest available audio tier without exposing codec jargon', () => {
  const basic = [{ id: 30216, bandwidth: 64000 }, { id: 30280, bandwidth: 192000 }]
  expect(audioChoices(basic, 'auto')[0].label).toBe('最高可用 · 192K')
  expect(audioChoices([...basic, { id: 30250, bandwidth: 128000 }], 'auto')[0].label).toBe('最高可用 · 杜比全景声')
  const full = [...basic, { id: 30250, bandwidth: 256000 }, { id: 30251, bandwidth: 100000 }]
  expect(audioChoices(full, 'auto')[0].label).toBe('最高可用 · Hi-Res 无损')
  expect(audioChoices(basic, 'hires').at(-1)?.label).toBe('Hi-Res 无损（当前不可用）')
  expect(audioChoices([], 'auto')[0].label).toContain('暂无可用音轨')
})

it('inserts variables at the caret and replaces only the selected text', () => {
  expect(insertNamingVariable('标题 - .mp4', '%bv%', 5, 5)).toEqual({ value: '标题 - %bv%.mp4', caret: 9 })
  expect(insertNamingVariable('前缀-替换-后缀', '%title%', 3, 5)).toEqual({ value: '前缀-%title%-后缀', caret: 10 })
  expect(insertNamingVariable('', '%dd:YYYYMMDD%')).toEqual({ value: '%dd:YYYYMMDD%', caret: 13 })
})

it('shows all collection sections and keeps expanded part identities', () => {
  expect(selectionRows([source], true, [], {})).toHaveLength(2)
  const rows = selectionRows([source], true, [source.bvid], { [source.bvid]: source })
  expect(rows.map(row => row.cid)).toEqual([42, 43, undefined])
  expect(rows[2].section).toBe('下篇')
  expect(selectionGroup([source], 'BV17x411w7KC')).toEqual({ title: '完整合集', index: 2 })
})

it('merges pasted videos and overlapping collections without duplicate selection rows', () => {
  const other = { ...source, bvid: 'BV17x411w7KC', collection: undefined, pages: [{ cid: 44, page: 1, title: '独立标题', duration: 60 }] }
  expect(selectionRows([other, source, source], true, [], {})).toHaveLength(2)
  expect(selectionRows([source, other], false, [], {}).map(row => row.cid)).toEqual([42, 43, 44])
})

it('does not truncate a large collection at 120 entries', () => {
  const large = { ...source, collection: { ...source.collection!, sections: [{ id: 3, title: '全部', videos: Array.from({ length: 321 }, (_, index) => ({ bvid: `BV${String(index).padStart(10, '0')}`, cid: index + 1, title: String(index), available: true })) }] } }
  expect(selectionRows([large], true, [], {})).toHaveLength(321)
})
