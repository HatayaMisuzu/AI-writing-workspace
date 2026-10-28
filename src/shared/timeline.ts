import type { TimelineEvent, TimelineSortMode } from './domain'

export const TIMELINE_SORT_LABEL: Record<TimelineSortMode, string> = { story: '按故事时间', chapter: '按章节顺序' }

/**
 * 时间线排序（纯函数）。
 * - story：sort_key 升序；同键按章节顺序，再按创建时间。
 * - chapter：按章树顺序；未关联章节（或章节已删）排末尾；同章内按 sort_key。
 */
export function sortTimelineEvents(events: TimelineEvent[], mode: TimelineSortMode, chapterIdsOrdered: string[]): TimelineEvent[] {
  const order = new Map(chapterIdsOrdered.map((id, index) => [id, index]))
  const chapterRank = (event: TimelineEvent): number => (event.chapterId && order.has(event.chapterId) ? order.get(event.chapterId)! : Number.MAX_SAFE_INTEGER)
  const tail = (a: TimelineEvent, b: TimelineEvent): number => a.createdAt - b.createdAt || a.id.localeCompare(b.id)
  return [...events].sort((a, b) => mode === 'story'
    ? a.sortKey - b.sortKey || chapterRank(a) - chapterRank(b) || tail(a, b)
    : chapterRank(a) - chapterRank(b) || a.sortKey - b.sortKey || tail(a, b))
}
