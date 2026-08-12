import type { AIMode } from '../../shared/domain'

export type HistoryPolicy = 'creative-thread' | 'none'

export const historyPolicy = (mode: AIMode): HistoryPolicy => {
  if (mode === 'reader_review' || mode === 'chapter_digest' || mode === 'proofreading') return 'none'
  return 'creative-thread'
}
