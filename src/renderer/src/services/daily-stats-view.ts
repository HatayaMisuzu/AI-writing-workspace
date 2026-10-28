import type { WritingDailyRow, WritingGoals } from '../../../shared/domain'

/** 本机时区 YYYY-MM-DD（与主进程 writing_daily 切分一致）。 */
export function localDateKey(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 含 end 在内、向前共 `days` 天的起止（本地日期）。 */
export function dateRangeEndingOn(end: Date, days: number): { from: string; to: string } {
  const to = new Date(end.getFullYear(), end.getMonth(), end.getDate())
  const from = new Date(to)
  from.setDate(from.getDate() - (days - 1))
  return { from: localDateKey(from), to: localDateKey(to) }
}

export function shiftLocalDate(dateKey: string, deltaDays: number): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + deltaDays)
  return localDateKey(dt)
}

/**
 * §3.2：仅当作者开启并设定正整数字数目标时，才显示「/ 目标 Y」与进度条。
 * 未启用 / 目标为空 / 非正整数 → 不渲染进度相关 UI。
 */
export function shouldShowWordGoalProgress(goals: WritingGoals): boolean {
  return goals.dailyWordGoalEnabled === true
    && typeof goals.dailyWordGoal === 'number'
    && Number.isInteger(goals.dailyWordGoal)
    && goals.dailyWordGoal > 0
}

/** 进度百分比 0–100；未达显示条件时返回 null（调用方不得渲染进度条）。 */
export function wordGoalProgressPercent(humanWordsNet: number, goals: WritingGoals): number | null {
  if (!shouldShowWordGoalProgress(goals) || goals.dailyWordGoal == null) return null
  const raw = (Math.max(0, humanWordsNet) / goals.dailyWordGoal) * 100
  return Math.max(0, Math.min(100, Math.round(raw)))
}

/** 「/ 目标 Y」文案；未启用时返回 null，禁止渲染。 */
export function wordGoalSuffix(goals: WritingGoals): string | null {
  if (!shouldShowWordGoalProgress(goals) || goals.dailyWordGoal == null) return null
  return `/ 目标 ${goals.dailyWordGoal}`
}

/** 近 N 日人工码字均值（含无记录日按 0；用净值显示值）。 */
export function averageHumanWords(rows: WritingDailyRow[], fromDate: string, toDate: string): number {
  const byDate = new Map(rows.map((row) => [row.date, row.humanWordsNetDisplay]))
  let sum = 0
  let count = 0
  let cursor = fromDate
  while (cursor <= toDate) {
    sum += byDate.get(cursor) ?? 0
    count += 1
    cursor = shiftLocalDate(cursor, 1)
  }
  if (count === 0) return 0
  return Math.round(sum / count)
}

export type CalendarCell = {
  date: string
  humanWords: number
  /** 0–4 热力档，0 表示无码字 */
  level: 0 | 1 | 2 | 3 | 4
}

export function calendarLevel(words: number): CalendarCell['level'] {
  if (words <= 0) return 0
  if (words < 500) return 1
  if (words < 2000) return 2
  if (words < 4000) return 3
  return 4
}

/** 近 `days` 天日历格（含今日），按日期升序。 */
export function buildCalendarCells(rows: WritingDailyRow[], end: Date, days: number): CalendarCell[] {
  const { from, to } = dateRangeEndingOn(end, days)
  const byDate = new Map(rows.map((row) => [row.date, row.humanWordsNetDisplay]))
  const cells: CalendarCell[] = []
  let cursor = from
  while (cursor <= to) {
    const humanWords = byDate.get(cursor) ?? 0
    cells.push({ date: cursor, humanWords, level: calendarLevel(humanWords) })
    cursor = shiftLocalDate(cursor, 1)
  }
  return cells
}

/**
 * 表单草稿：不预置任何默认目标数字；null → 输入框空串。
 * 禁止把 2000/3000/4000 等写进初始值。
 */
export function goalsToFormDraft(goals: WritingGoals): {
  wordEnabled: boolean
  wordGoal: string
  chapterEnabled: boolean
  chapterGoal: string
} {
  return {
    wordEnabled: goals.dailyWordGoalEnabled === true,
    wordGoal: goals.dailyWordGoal == null ? '' : String(goals.dailyWordGoal),
    chapterEnabled: goals.dailyChapterGoalEnabled === true,
    chapterGoal: goals.dailyChapterGoal == null ? '' : String(goals.dailyChapterGoal)
  }
}

export type GoalsFormDraft = ReturnType<typeof goalsToFormDraft>

/** 解析正整数；空串 → null；0/负/非整数 → 抛错文案（由 UI 展示，不弹通知）。 */
export function parsePositiveIntOrEmpty(raw: string, label: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (!/^\d+$/.test(trimmed)) throw new Error(`${label}须为正整数`)
  const value = Number(trimmed)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label}须为正整数`)
  return value
}

export function draftToGoalsInput(draft: GoalsFormDraft): {
  dailyWordGoalEnabled: boolean
  dailyWordGoal: number | null
  dailyChapterGoalEnabled: boolean
  dailyChapterGoal: number | null
} {
  const dailyWordGoal = parsePositiveIntOrEmpty(draft.wordGoal, '日更字数目标')
  const dailyChapterGoal = parsePositiveIntOrEmpty(draft.chapterGoal, '日更章数目标')
  if (draft.wordEnabled && dailyWordGoal === null) throw new Error('启用字数目标时请填写正整数')
  if (draft.chapterEnabled && dailyChapterGoal === null) throw new Error('启用章数目标时请填写正整数')
  return {
    dailyWordGoalEnabled: draft.wordEnabled,
    dailyWordGoal,
    dailyChapterGoalEnabled: draft.chapterEnabled,
    dailyChapterGoal
  }
}
