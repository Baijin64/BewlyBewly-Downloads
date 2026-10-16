import type { Video } from '~/components/VideoCard/types'
import type { Item as AppItem } from '~/models/video/appForYou'
import type { Item as WebItem } from '~/models/video/forYou'
import { isVerticalVideo } from '~/utils/uriParse'

export interface RecommendationCard { uniqueId: string, video?: Video }
export function webCard(item: WebItem): RecommendationCard {
  return { uniqueId: item.bvid || String(item.id), video: {
    id: item.id,
    duration: item.duration,
    title: item.title,
    cover: item.pic,
    author: { name: item.owner.name, authorFace: item.owner.face, followed: !!item.is_followed, mid: item.owner.mid },
    view: item.stat.view,
    danmaku: item.stat.danmaku,
    publishedTimestamp: item.pubdate,
    bvid: item.bvid,
    cid: item.cid,
    threePointV2: [],
  } }
}
export function appCard(item: AppItem): RecommendationCard {
  return { uniqueId: item.bvid || `${item.goto}:${item.param || item.idx}`, video: {
    id: item.args?.aid ?? 0,
    durationStr: item.cover_right_text,
    title: String(item.title || ''),
    cover: String(item.cover || ''),
    author: { name: item.mask?.avatar.text, authorFace: item.mask?.avatar.cover || item.avatar?.cover || '', followed: ['已关注', '已關注'].includes(item.bottom_rcmd_reason || ''), mid: item.mask?.avatar.up_id },
    capsuleText: item.desc?.split('·')[1],
    bvid: item.bvid,
    viewStr: item.cover_left_text_1,
    danmakuStr: item.cover_left_text_2,
    cid: item.player_args?.cid,
    goto: item.goto,
    url: item.goto === 'bangumi' ? item.uri : '',
    type: item.card_goto === 'bangumi' ? 'bangumi' : isVerticalVideo(item.uri || '') ? 'vertical' : 'horizontal',
    threePointV2: item.three_point_v2 || [],
  } }
}
