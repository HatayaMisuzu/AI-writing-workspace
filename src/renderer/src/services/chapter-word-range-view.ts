import type { ChapterWordRange } from '../../../shared/domain'
import { parsePositiveIntOrEmpty } from './daily-stats-view'

export type ChapterWordRangeHint = { state: 'in' | 'below' | 'above'; text: string }

/**
 * P1-3 F10：状态栏静默提示本章是否在字数区间内。
 * 未设区间（两端皆空）→ null，调用方不得渲染任何提示；不弹窗、不催促。
 */
export function chapterWordRangeHint(wordCount: number, range: ChapterWordRange | null | undefined): ChapterWordRangeHint | null {
  if (!range || (range.min === null && range.max === null)) return null
  const label = range.min !== null && range.max !== null ? `${range.min}–${range.max}` : range.min !== null ? `≥${range.min}` : `≤${range.max}`
  if (range.min !== null && wordCount < range.min) return { state: 'below', text: `区间 ${label}：未到下限` }
  if (range.max !== null && wordCount > range.max) return { state: 'above', text: `区间 ${label}：超出上限` }
  return { state: 'in', text: `区间 ${label}：在区间内` }
}

export function wordRangeToDraft(range: ChapterWordRange): { min: string; max: string } {
  return { min: range.min === null ? '' : String(range.min), max: range.max === null ? '' : String(range.max) }
}

/** 正整数、可只设一端、下限≤上限；错误以文案抛出，由 UI 内联显示。 */
export function draftToWordRange(draft: { min: string; max: string }): ChapterWordRange {
  const min = parsePositiveIntOrEmpty(draft.min, '字数下限')
  const max = parsePositiveIntOrEmpty(draft.max, '字数上限')
  if (min !== null && max !== null && min > max) throw new Error('字数下限不能大于上限')
  return { min, max }
}
