import { AlertTriangle, BookmarkPlus, Check, Flag } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { DocumentNode, ForeshadowEntry, ForeshadowState, Project } from '../../../shared/domain'
import { FORESHADOW_STATE_LABEL, FORESHADOW_STATES } from '../../../shared/foreshadow'

/**
 * S12 伏笔台账：已确认列表（逾期置顶）+ 待确认 AI 候选（不混入已确认）。
 * 放弃须填原因；天数/提醒类文案不做。
 */
export function ForeshadowView({ project, chapters }: {
  project: Project
  chapters: DocumentNode[]
}): React.JSX.Element {
  const [ledger, setLedger] = useState<ForeshadowEntry[]>([])
  const [pending, setPending] = useState<ForeshadowEntry[]>([])
  const [error, setError] = useState<string>()
  const [abandonFor, setAbandonFor] = useState<string>()
  const [abandonReason, setAbandonReason] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setError(undefined)
    try {
      const [nextLedger, nextPending] = await Promise.all([
        window.workspace.foreshadows.listLedger(project.id),
        window.workspace.foreshadows.listPending(project.id)
      ])
      setLedger(nextLedger)
      setPending(nextPending)
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next))
    }
  }, [project.id])

  useEffect(() => { void load() }, [load, chapters])

  const chapterTitle = (id: string | null): string => {
    if (!id) return '（未设）'
    return chapters.find((chapter) => chapter.id === id)?.title ?? '（章节已删）'
  }

  const changeState = async (memoryId: string, state: ForeshadowState, reason?: string): Promise<void> => {
    setBusy(true); setError(undefined)
    try {
      await window.workspace.foreshadows.setState({
        projectId: project.id, memoryId, state, abandonReason: reason
      })
      setAbandonFor(undefined); setAbandonReason('')
      await load()
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next))
    } finally { setBusy(false) }
  }

  const confirmPending = async (memoryId: string): Promise<void> => {
    setBusy(true); setError(undefined)
    try {
      await window.workspace.memories.confirm(project.id, memoryId)
      await load()
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next))
    } finally { setBusy(false) }
  }

  const rejectPending = async (memoryId: string): Promise<void> => {
    setBusy(true); setError(undefined)
    try {
      await window.workspace.memories.reject(project.id, memoryId)
      await load()
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next))
    } finally { setBusy(false) }
  }

  return <section className="project-view foreshadow-view" data-testid="foreshadow-view">
    <header>
      <div>
        <h1>伏笔台账</h1>
        <p>本地登记与回收跟踪。AI 候选只在「待确认」；未确认不进创作上下文。</p>
      </div>
      <button type="button" onClick={() => void load()}>刷新</button>
    </header>
    {error && <div className="inline-error" role="alert">{error}</div>}

    <div className="foreshadow-section">
      <h2><Flag size={16} aria-hidden /> 已确认台账</h2>
      {ledger.length === 0
        ? <p className="empty-copy">还没有已确认伏笔。可在正文选区使用「登记为伏笔」。</p>
        : <ul className="foreshadow-list" data-testid="foreshadow-ledger">
          {ledger.map((entry) => (
            <li key={entry.memory.id} className={entry.overdue ? 'foreshadow-item is-overdue' : 'foreshadow-item'} data-overdue={entry.overdue ? '1' : '0'}>
              <div className="foreshadow-item-head">
                <strong>{entry.name}</strong>
                <span className={`foreshadow-state state-${entry.meta.state}`}>{FORESHADOW_STATE_LABEL[entry.meta.state]}</span>
                {entry.overdue && <span className="foreshadow-overdue" data-testid="foreshadow-overdue"><AlertTriangle size={13} />逾期</span>}
              </div>
              <p>{entry.memory.content}</p>
              <small>
                埋设：{chapterTitle(entry.memory.sourceId)}
                {typeof entry.selectionFrom === 'number' && typeof entry.selectionTo === 'number'
                  ? ` · 选区 ${entry.selectionFrom}–${entry.selectionTo}` : ''}
                {' · '}计划回收：{chapterTitle(entry.meta.plannedChapterId)}
                {' · '}实际回收：{chapterTitle(entry.meta.resolvedChapterId)}
              </small>
              {entry.meta.state === 'abandoned' && entry.meta.abandonReason && (
                <small className="foreshadow-abandon">放弃原因：{entry.meta.abandonReason}</small>
              )}
              <div className="foreshadow-actions">
                {FORESHADOW_STATES.filter((state) => state !== entry.meta.state && state !== 'abandoned').map((state) => (
                  <button key={state} type="button" disabled={busy} onClick={() => void changeState(entry.memory.id, state)}>
                    标为{FORESHADOW_STATE_LABEL[state]}
                  </button>
                ))}
                {entry.meta.state !== 'abandoned' && (
                  <button type="button" disabled={busy} onClick={() => { setAbandonFor(entry.memory.id); setAbandonReason('') }}>
                    放弃…
                  </button>
                )}
              </div>
              {abandonFor === entry.memory.id && (
                <div className="foreshadow-abandon-form">
                  <label>
                    <span>放弃原因（必填）</span>
                    <textarea value={abandonReason} onChange={(event) => setAbandonReason(event.target.value)} rows={2} />
                  </label>
                  <div className="modal-actions">
                    <button type="button" onClick={() => setAbandonFor(undefined)}>取消</button>
                    <button type="button" className="primary" disabled={busy || !abandonReason.trim()}
                      onClick={() => void changeState(entry.memory.id, 'abandoned', abandonReason)}>确认放弃</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>}
    </div>

    <div className="foreshadow-section">
      <h2><BookmarkPlus size={16} aria-hidden /> 待确认（AI / 记录员）</h2>
      <p className="daily-goals-hint">章节理解产出的伏笔只出现在这里；确认前不进台账、不进 AI 上下文。</p>
      {pending.length === 0
        ? <p className="empty-copy" data-testid="foreshadow-pending-empty">当前没有待确认伏笔。</p>
        : <ul className="foreshadow-list" data-testid="foreshadow-pending">
          {pending.map((entry) => (
            <li key={entry.memory.id} className="foreshadow-item is-pending">
              <div className="foreshadow-item-head">
                <strong>{entry.name}</strong>
                <span className="memory-status suggested">待确认</span>
              </div>
              <p>{entry.memory.content}</p>
              <small>来源章：{chapterTitle(entry.memory.sourceId)}</small>
              <div className="foreshadow-actions">
                <button type="button" className="primary" disabled={busy} onClick={() => void confirmPending(entry.memory.id)}>
                  <Check size={14} />确认进台账
                </button>
                <button type="button" disabled={busy} onClick={() => void rejectPending(entry.memory.id)}>否决</button>
              </div>
            </li>
          ))}
        </ul>}
    </div>
  </section>
}
