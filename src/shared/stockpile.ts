import type { ChapterStatus } from './domain'

export type StockpileChapter = {
  id: string
  title: string
  status: ChapterStatus
  wordCount: number
}

export type StockpileInput = {
  /** 章树顺序（卷内 order） */
  chapters: StockpileChapter[]
  /** 已更新到的章节 id；null/undefined = 指针空，从第 1 章起算 */
  progressChapterId: string | null | undefined
  dailyChapterGoalEnabled: boolean
  dailyChapterGoal: number | null | undefined
}

export type StockpileResult = {
  chapterCount: number
  wordCount: number
  /** 仅当开启并设定正整数日更章数目标时有值；否则 null（UI 不渲染天数） */
  daysRemaining: number | null
  chapters: Array<{ id: string; title: string; wordCount: number }>
}

/**
 * 存稿 = 进度指针之后、连续定稿章；遇第一个非定稿即停。
 * 指针空 → 从第 1 章起。不预设章数目标；未启用时 daysRemaining=null。
 */
export function computeStockpile(input: StockpileInput): StockpileResult {
  const ordered = input.chapters
  let start = 0
  if (input.progressChapterId) {
    const idx = ordered.findIndex((chapter) => chapter.id === input.progressChapterId)
    start = idx >= 0 ? idx + 1 : ordered.length // 指针指向未知章 → 无后续存稿
  }
  const stock: Array<{ id: string; title: string; wordCount: number }> = []
  for (let i = start; i < ordered.length; i += 1) {
    const chapter = ordered[i]
    if (chapter.status !== 'final') break
    stock.push({ id: chapter.id, title: chapter.title, wordCount: chapter.wordCount })
  }
  const chapterCount = stock.length
  const wordCount = stock.reduce((sum, chapter) => sum + chapter.wordCount, 0)
  const goalEnabled = input.dailyChapterGoalEnabled === true
  const goal = input.dailyChapterGoal
  const daysRemaining =
    goalEnabled && typeof goal === 'number' && Number.isInteger(goal) && goal > 0
      ? Math.floor(chapterCount / goal)
      : null
  return { chapterCount, wordCount, daysRemaining, chapters: stock }
}

export const CHAPTER_STATUS_LABEL: Record<ChapterStatus, string> = {
  outline: '构思',
  draft: '草稿',
  final: '定稿'
}

export const CHAPTER_STATUSES: ChapterStatus[] = ['outline', 'draft', 'final']
