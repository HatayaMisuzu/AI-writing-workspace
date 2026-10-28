import { CalendarDays, ChartColumn, Target } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Project, WritingDailyRow, WritingGoals } from '../../../shared/domain'
import {
  averageHumanWords,
  buildCalendarCells,
  dateRangeEndingOn,
  draftToGoalsInput,
  goalsToFormDraft,
  shouldShowWordGoalProgress,
  wordGoalProgressPercent,
  wordGoalSuffix,
  type GoalsFormDraft
} from '../services/daily-stats-view'

const emptyGoals = (): WritingGoals => ({
  dailyWordGoalEnabled: false,
  dailyWordGoal: null,
  dailyChapterGoalEnabled: false,
  dailyChapterGoal: null
})

/**
 * S10 日更面板。
 * 硬约束：目标默认空关、不预置、不弹进度提醒/通知；未启用时无进度条、无「/ 目标」、无达成提示。
 */
export function DailyStatsView({ project }: { project: Project }): React.JSX.Element {
  const [today, setToday] = useState<WritingDailyRow>()
  const [rangeRows, setRangeRows] = useState<WritingDailyRow[]>([])
  const [goals, setGoals] = useState<WritingGoals>(emptyGoals)
  const [draft, setDraft] = useState<GoalsFormDraft>(goalsToFormDraft(emptyGoals()))
  const [goalError, setGoalError] = useState<string>()
  const [goalSavedHint, setGoalSavedHint] = useState<string>()
  const [loadError, setLoadError] = useState<string>()

  const load = useCallback(async (): Promise<void> => {
    setLoadError(undefined)
    try {
      const now = new Date()
      const range90 = dateRangeEndingOn(now, 90)
      const [day, rows, nextGoals] = await Promise.all([
        window.workspace.writing.getDay(project.id),
        window.workspace.writing.listRange(project.id, range90.from, range90.to),
        window.workspace.writing.getGoals(project.id)
      ])
      setToday(day)
      setRangeRows(rows)
      setGoals(nextGoals)
      setDraft(goalsToFormDraft(nextGoals))
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [project.id])

  useEffect(() => { void load() }, [load])

  const range7 = useMemo(() => dateRangeEndingOn(new Date(), 7), [])
  const avg7 = useMemo(() => averageHumanWords(rangeRows, range7.from, range7.to), [rangeRows, range7.from, range7.to])
  const cells = useMemo(() => buildCalendarCells(rangeRows, new Date(), 90), [rangeRows])
  const showProgress = shouldShowWordGoalProgress(goals)
  const progressPct = wordGoalProgressPercent(today?.humanWordsNetDisplay ?? 0, goals)
  const suffix = wordGoalSuffix(goals)

  const saveGoals = async (): Promise<void> => {
    setGoalError(undefined)
    setGoalSavedHint(undefined)
    try {
      const input = draftToGoalsInput(draft)
      const next = await window.workspace.writing.setGoals(project.id, input)
      setGoals(next)
      setDraft(goalsToFormDraft(next))
      setGoalSavedHint('已保存')
    } catch (error) {
      setGoalError(error instanceof Error ? error.message : String(error))
    }
  }

  const human = today?.humanWordsNetDisplay ?? 0
  const ai = today?.aiWordsAccepted ?? 0
  const deleted = today?.humanWordsDeleted ?? 0

  return <section className="project-view daily-stats-view" data-testid="daily-stats-view">
    <header>
      <div>
        <h1>日更</h1>
        <p>统计始终显示；日更目标可选，默认关闭，不提醒。</p>
      </div>
      <button type="button" onClick={() => void load()} title="刷新统计">刷新</button>
    </header>

    {loadError && <div className="inline-error" role="alert">{loadError}</div>}

    <div className="daily-stats-summary">
      <div className="daily-stat-card" data-testid="daily-human-words">
        <ChartColumn size={18} aria-hidden />
        <div>
          <span className="daily-stat-label">今日码字</span>
          <strong className="daily-stat-value">
            {human.toLocaleString()}
            {showProgress && suffix ? <span className="daily-goal-suffix" data-testid="daily-goal-suffix"> {suffix}</span> : null}
          </strong>
          {deleted > 0 && <small className="daily-stat-meta">今日删除 {deleted.toLocaleString()} 字</small>}
        </div>
      </div>
      <div className="daily-stat-card" data-testid="daily-ai-words">
        <div>
          <span className="daily-stat-label">采纳 AI 字数</span>
          <strong className="daily-stat-value">{ai.toLocaleString()}</strong>
          <small className="daily-stat-meta">不计入码字</small>
        </div>
      </div>
      <div className="daily-stat-card" data-testid="daily-book-total">
        <div>
          <span className="daily-stat-label">本书总字数</span>
          <strong className="daily-stat-value">{project.totalWordCount.toLocaleString()}</strong>
        </div>
      </div>
      <div className="daily-stat-card" data-testid="daily-avg-7">
        <div>
          <span className="daily-stat-label">近 7 日均值</span>
          <strong className="daily-stat-value">{avg7.toLocaleString()}</strong>
        </div>
      </div>
    </div>

    {/* 仅启用并设定正整数目标时渲染；无「已达成/未达成」文案，无通知 */}
    {showProgress && progressPct !== null && (
      <div className="daily-word-progress" data-testid="daily-word-progress" role="progressbar"
        aria-valuenow={progressPct} aria-valuemin={0} aria-valuemax={100}
        aria-label={`今日码字进度 ${progressPct}%`}>
        <div className="daily-word-progress-bar" style={{ width: `${progressPct}%` }} />
      </div>
    )}

    <div className="daily-calendar-block">
      <header><CalendarDays size={16} aria-hidden /><h2>近 90 天码字</h2></header>
      <div className="daily-calendar" data-testid="daily-calendar" role="img" aria-label="近九十天码字日历">
        {cells.map((cell) => (
          <span
            key={cell.date}
            className={`daily-calendar-cell level-${cell.level}`}
            title={`${cell.date}：${cell.humanWords} 字`}
            data-date={cell.date}
            data-words={cell.humanWords}
          />
        ))}
      </div>
      <div className="daily-calendar-legend" aria-hidden>
        <span>少</span>
        <span className="daily-calendar-cell level-0" />
        <span className="daily-calendar-cell level-1" />
        <span className="daily-calendar-cell level-2" />
        <span className="daily-calendar-cell level-3" />
        <span className="daily-calendar-cell level-4" />
        <span>多</span>
      </div>
    </div>

    <div className="daily-goals-block" data-testid="daily-goals-form">
      <header><Target size={16} aria-hidden /><h2>可选日更目标</h2></header>
      <p className="daily-goals-hint">默认关闭。开启后只显示进度，不会推送提醒或通知。</p>
      <label className="daily-goal-row">
        <input
          type="checkbox"
          checked={draft.wordEnabled}
          onChange={(event) => setDraft({ ...draft, wordEnabled: event.target.checked })}
          aria-label="启用字数目标"
        />
        <span>启用字数目标</span>
        <input
          type="text"
          inputMode="numeric"
          value={draft.wordGoal}
          placeholder="正整数，不预置"
          onChange={(event) => setDraft({ ...draft, wordGoal: event.target.value })}
          aria-label="日更字数目标"
          disabled={!draft.wordEnabled}
        />
      </label>
      <label className="daily-goal-row">
        <input
          type="checkbox"
          checked={draft.chapterEnabled}
          onChange={(event) => setDraft({ ...draft, chapterEnabled: event.target.checked })}
          aria-label="启用章数目标"
        />
        <span>启用章数目标</span>
        <input
          type="text"
          inputMode="numeric"
          value={draft.chapterGoal}
          placeholder="正整数，不预置"
          onChange={(event) => setDraft({ ...draft, chapterGoal: event.target.value })}
          aria-label="日更章数目标"
          disabled={!draft.chapterEnabled}
        />
      </label>
      {goalError && <div className="inline-error" role="alert">{goalError}</div>}
      {goalSavedHint && <small className="daily-goals-saved">{goalSavedHint}</small>}
      <div className="daily-goals-actions">
        <button type="button" className="primary" onClick={() => void saveGoals()}>保存目标</button>
      </div>
    </div>
  </section>
}
