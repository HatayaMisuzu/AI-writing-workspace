import type { ForeshadowState } from './domain'

export const FORESHADOW_STATE_LABEL: Record<ForeshadowState, string> = {
  planted: '埋设',
  hinting: '暗示中',
  resolved: '已回收',
  abandoned: '放弃'
}

export const FORESHADOW_STATES: ForeshadowState[] = ['planted', 'hinting', 'resolved', 'abandoned']

export type ForeshadowLocation = {
  name: string
  from?: number
  to?: number
}

/** 解析 memories.source_location（作者选区登记的 JSON）；非法则回退。 */
export function parseForeshadowLocation(raw: string | null | undefined, fallbackName: string): ForeshadowLocation {
  if (!raw) return { name: fallbackName }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>
      const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : fallbackName
      const from = typeof obj.from === 'number' && Number.isInteger(obj.from) ? obj.from : undefined
      const to = typeof obj.to === 'number' && Number.isInteger(obj.to) ? obj.to : undefined
      return { name, from, to }
    }
  } catch { /* plain string fallback */ }
  return { name: fallbackName }
}

export function encodeForeshadowLocation(input: ForeshadowLocation): string {
  const payload: Record<string, unknown> = { name: input.name }
  if (typeof input.from === 'number') payload.from = input.from
  if (typeof input.to === 'number') payload.to = input.to
  return JSON.stringify(payload)
}

/**
 * 逾期：已有正文的最后一章序号 > 计划回收章序号，且状态仍非已回收/放弃。
 * chapterIdsOrdered = 章树顺序；chaptersWithBody = 有正文章的 id 集合。
 */
export function isForeshadowOverdue(input: {
  state: ForeshadowState
  plannedChapterId: string | null | undefined
  chapterIdsOrdered: string[]
  chapterIdsWithBody: Iterable<string>
}): boolean {
  if (input.state === 'resolved' || input.state === 'abandoned') return false
  const planned = input.plannedChapterId
  if (!planned) return false
  const plannedIndex = input.chapterIdsOrdered.indexOf(planned)
  if (plannedIndex < 0) return false
  const withBody = new Set(input.chapterIdsWithBody)
  let lastBodyIndex = -1
  for (let i = 0; i < input.chapterIdsOrdered.length; i += 1) {
    if (withBody.has(input.chapterIdsOrdered[i])) lastBodyIndex = i
  }
  return lastBodyIndex > plannedIndex
}

/** 台账排序：逾期置顶，其余按更新时间倒序（由调用方传入 updatedAt）。 */
export function compareForeshadowEntries(
  a: { overdue: boolean; updatedAt: number },
  b: { overdue: boolean; updatedAt: number }
): number {
  if (a.overdue !== b.overdue) return a.overdue ? -1 : 1
  return b.updatedAt - a.updatedAt
}
