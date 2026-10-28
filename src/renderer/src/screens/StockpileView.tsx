import { BookMarked, Layers3 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { DocumentNode, Project, StockpileSummary } from '../../../shared/domain'
import { CHAPTER_STATUS_LABEL } from '../../../shared/stockpile'
import { shouldShowStockpileDays } from '../services/stockpile-view'

/**
 * S11 存稿面板。
 * 始终显示存稿章数/字数；可撑天数仅在开启正整数日更章数目标时渲染。
 * 不预置章数目标，不提示「存稿不足」。
 */
export function StockpileView({ project, chapters, onProgressChanged }: {
  project: Project
  chapters: DocumentNode[]
  onProgressChanged?(): void
}): React.JSX.Element {
  const [summary, setSummary] = useState<StockpileSummary>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setError(undefined)
    try {
      setSummary(await window.workspace.documents.getStockpile(project.id))
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next))
    }
  }, [project.id])

  useEffect(() => { void load() }, [load, chapters])

  const setProgress = async (chapterId: string | null): Promise<void> => {
    setBusy(true); setError(undefined)
    try {
      await window.workspace.documents.setSerialProgress(project.id, chapterId)
      await load()
      onProgressChanged?.()
    } catch (next) {
      setError(next instanceof Error ? next.message : String(next))
    } finally { setBusy(false) }
  }

  const showDays = summary ? shouldShowStockpileDays(summary) : false
  const chapterOnly = chapters.filter((node) => node.type === 'chapter')

  return <section className="project-view stockpile-view" data-testid="stockpile-view">
    <header>
      <div>
        <h1>存稿</h1>
        <p>本地连载进度与连续定稿章。天数仅在开启日更章数目标后显示，不推送提醒。</p>
      </div>
      <button type="button" onClick={() => void load()}>刷新</button>
    </header>
    {error && <div className="inline-error" role="alert">{error}</div>}

    <div className="stockpile-summary">
      <div className="daily-stat-card" data-testid="stockpile-chapter-count">
        <Layers3 size={18} aria-hidden />
        <div>
          <span className="daily-stat-label">存稿章数</span>
          <strong className="daily-stat-value">{(summary?.chapterCount ?? 0).toLocaleString()}</strong>
        </div>
      </div>
      <div className="daily-stat-card" data-testid="stockpile-word-count">
        <BookMarked size={18} aria-hidden />
        <div>
          <span className="daily-stat-label">存稿字数</span>
          <strong className="daily-stat-value">{(summary?.wordCount ?? 0).toLocaleString()}</strong>
        </div>
      </div>
      {showDays && (
        <div className="daily-stat-card" data-testid="stockpile-days">
          <div>
            <span className="daily-stat-label">可撑天数</span>
            <strong className="daily-stat-value">{summary!.daysRemaining!.toLocaleString()}</strong>
          </div>
        </div>
      )}
    </div>

    <div className="stockpile-progress-block">
      <h2>连载进度指针</h2>
      <p className="daily-goals-hint">标记「已更新到」哪一章；存稿从下一章起连续定稿计数。可空。</p>
      <label className="stockpile-progress-row">
        <span>已更新到</span>
        <select
          aria-label="连载进度指针"
          disabled={busy}
          value={summary?.progress.progressChapterId ?? ''}
          onChange={(event) => void setProgress(event.target.value || null)}
        >
          <option value="">（未设置，从第 1 章起算）</option>
          {chapterOnly.map((chapter, index) => (
            <option key={chapter.id} value={chapter.id}>
              第{index + 1}章 · {chapter.title}（{CHAPTER_STATUS_LABEL[chapter.status]}）
            </option>
          ))}
        </select>
      </label>
    </div>

    <div className="stockpile-list-block">
      <h2>连续定稿存稿</h2>
      {(summary?.chapters.length ?? 0) === 0
        ? <p className="empty-copy" data-testid="stockpile-empty">当前没有连续定稿存稿。</p>
        : <ul className="stockpile-chapter-list" data-testid="stockpile-chapter-list">
            {summary!.chapters.map((chapter) => (
              <li key={chapter.id}><strong>{chapter.title}</strong><small>{chapter.wordCount.toLocaleString()} 字</small></li>
            ))}
          </ul>}
    </div>
  </section>
}
