import { describe, expect, it } from 'vitest'
import type { WritingDailyRow, WritingGoals } from '../src/shared/domain'
import {
  averageHumanWords,
  buildCalendarCells,
  calendarLevel,
  dateRangeEndingOn,
  draftToGoalsInput,
  goalsToFormDraft,
  localDateKey,
  shouldShowWordGoalProgress,
  wordGoalProgressPercent,
  wordGoalSuffix
} from '../src/renderer/src/services/daily-stats-view'

const disabledGoals = (): WritingGoals => ({
  dailyWordGoalEnabled: false,
  dailyWordGoal: null,
  dailyChapterGoalEnabled: false,
  dailyChapterGoal: null
})

describe('S10 日更面板 · §3.2 ⑦ 未启用目标时不渲染进度相关 UI', () => {
  it('默认空关：无进度、无「/ 目标」、无达成类判定', () => {
    const goals = disabledGoals()
    expect(shouldShowWordGoalProgress(goals)).toBe(false)
    expect(wordGoalSuffix(goals)).toBeNull()
    expect(wordGoalProgressPercent(1200, goals)).toBeNull()
    // 即使有码字也不应出现进度
    expect(wordGoalProgressPercent(9999, goals)).toBeNull()
  })

  it('仅 enabled 但目标为空 / 0 / 负：仍不渲染进度与「/ 目标」', () => {
    const emptyValue: WritingGoals = { ...disabledGoals(), dailyWordGoalEnabled: true, dailyWordGoal: null }
    expect(shouldShowWordGoalProgress(emptyValue)).toBe(false)
    expect(wordGoalSuffix(emptyValue)).toBeNull()
    expect(wordGoalProgressPercent(100, emptyValue)).toBeNull()

    const zero: WritingGoals = { ...disabledGoals(), dailyWordGoalEnabled: true, dailyWordGoal: 0 }
    expect(shouldShowWordGoalProgress(zero)).toBe(false)
    expect(wordGoalSuffix(zero)).toBeNull()

    const neg: WritingGoals = { ...disabledGoals(), dailyWordGoalEnabled: true, dailyWordGoal: -3 }
    expect(shouldShowWordGoalProgress(neg)).toBe(false)
    expect(wordGoalSuffix(neg)).toBeNull()
  })

  it('表单草稿不预置目标数字；关闭态输入为空串', () => {
    const draft = goalsToFormDraft(disabledGoals())
    expect(draft).toEqual({
      wordEnabled: false,
      wordGoal: '',
      chapterEnabled: false,
      chapterGoal: ''
    })
    expect(draft.wordGoal).not.toMatch(/2000|3000|4000|1000/)
    expect(draft.chapterGoal).toBe('')
  })
})

describe('S10 日更面板 · §3.2 ⑧ 开启正整数目标后显示进度，关闭后消失且统计逻辑不变', () => {
  it('启用并设定正整数后返回「/ 目标 Y」与 0–100 进度', () => {
    const goals: WritingGoals = {
      dailyWordGoalEnabled: true,
      dailyWordGoal: 2000,
      dailyChapterGoalEnabled: false,
      dailyChapterGoal: null
    }
    expect(shouldShowWordGoalProgress(goals)).toBe(true)
    expect(wordGoalSuffix(goals)).toBe('/ 目标 2000')
    expect(wordGoalProgressPercent(0, goals)).toBe(0)
    expect(wordGoalProgressPercent(1000, goals)).toBe(50)
    expect(wordGoalProgressPercent(2000, goals)).toBe(100)
    expect(wordGoalProgressPercent(5000, goals)).toBe(100) // 封顶，无「超额达成」文案
  })

  it('关闭目标后进度与后缀消失；码字数值由调用方原样展示（本函数不改写）', () => {
    const humanWords = 1500
    const enabled: WritingGoals = {
      dailyWordGoalEnabled: true,
      dailyWordGoal: 3000,
      dailyChapterGoalEnabled: false,
      dailyChapterGoal: null
    }
    expect(wordGoalProgressPercent(humanWords, enabled)).toBe(50)
    expect(wordGoalSuffix(enabled)).toBe('/ 目标 3000')

    const disabled: WritingGoals = { ...enabled, dailyWordGoalEnabled: false }
    expect(shouldShowWordGoalProgress(disabled)).toBe(false)
    expect(wordGoalProgressPercent(humanWords, disabled)).toBeNull()
    expect(wordGoalSuffix(disabled)).toBeNull()
    // 统计数值本身不变
    expect(humanWords).toBe(1500)
  })

  it('保存草稿：开启须正整数；0/负拒绝；关闭可保留空目标', () => {
    expect(() => draftToGoalsInput({
      wordEnabled: true, wordGoal: '0', chapterEnabled: false, chapterGoal: ''
    })).toThrow(/正整数/)
    expect(() => draftToGoalsInput({
      wordEnabled: true, wordGoal: '-1', chapterEnabled: false, chapterGoal: ''
    })).toThrow(/正整数/)
    expect(() => draftToGoalsInput({
      wordEnabled: true, wordGoal: '', chapterEnabled: false, chapterGoal: ''
    })).toThrow(/正整数|填写/)

    expect(draftToGoalsInput({
      wordEnabled: true, wordGoal: '2500', chapterEnabled: false, chapterGoal: ''
    })).toEqual({
      dailyWordGoalEnabled: true,
      dailyWordGoal: 2500,
      dailyChapterGoalEnabled: false,
      dailyChapterGoal: null
    })

    expect(draftToGoalsInput({
      wordEnabled: false, wordGoal: '', chapterEnabled: false, chapterGoal: ''
    })).toEqual({
      dailyWordGoalEnabled: false,
      dailyWordGoal: null,
      dailyChapterGoalEnabled: false,
      dailyChapterGoal: null
    })
  })
})

describe('S10 统计展示辅助（始终可算，与目标无关）', () => {
  it('近 7 日均值含空日按 0；日历 90 格', () => {
    const end = new Date(2026, 2, 10, 12, 0, 0)
    const { from, to } = dateRangeEndingOn(end, 7)
    expect(from).toBe('2026-03-04')
    expect(to).toBe('2026-03-10')
    const rows: WritingDailyRow[] = [
      { date: '2026-03-10', humanWordsAdded: 700, humanWordsDeleted: 0, humanWordsNetDisplay: 700, aiWordsAccepted: 0, activeSeconds: 0 },
      { date: '2026-03-08', humanWordsAdded: 700, humanWordsDeleted: 0, humanWordsNetDisplay: 700, aiWordsAccepted: 0, activeSeconds: 0 }
    ]
    // (700+0+700+0+0+0+0)/7 ≈ 200
    expect(averageHumanWords(rows, from, to)).toBe(200)

    const cells = buildCalendarCells(rows, end, 90)
    expect(cells).toHaveLength(90)
    expect(cells[cells.length - 1]).toMatchObject({ date: '2026-03-10', humanWords: 700, level: 2 })
    expect(localDateKey(end)).toBe('2026-03-10')
    expect(calendarLevel(0)).toBe(0)
    expect(calendarLevel(100)).toBe(1)
  })
})
