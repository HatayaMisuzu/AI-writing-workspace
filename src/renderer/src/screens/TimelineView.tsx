import { CalendarClock, Plus, Save, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { Character, DocumentNode, Project, TimelineEvent, TimelineSortMode } from '../../../shared/domain'
import { TIMELINE_SORT_LABEL } from '../../../shared/timeline'

type Draft = { id?: string; storyTimeLabel: string; sortKey: string; title: string; chapterId: string; characterIds: string[] }
const emptyDraft = (): Draft => ({ storyTimeLabel: '', sortKey: '0', title: '', chapterId: '', characterIds: [] })

/**
 * P1-1 F9 时间线：作者手动录入；按故事时间 / 按章节顺序切换；不做甘特图。
 * 不调用 AI，不联网。
 */
export function TimelineView({ project, chapters, focusEventId, onOpenChapter, onOpenCharacter }: {
  project: Project
  chapters: DocumentNode[]
  focusEventId?: string
  onOpenChapter(chapterId: string): void
  onOpenCharacter(characterId: string): void
}): React.JSX.Element {
  const [mode, setMode] = useState<TimelineSortMode>('story')
  const [events, setEvents] = useState<TimelineEvent[]>([])
  const [characters, setCharacters] = useState<Character[]>([])
  const [draft, setDraft] = useState<Draft>(emptyDraft())
  const [error, setError] = useState<string>()

  const load = useCallback(async (): Promise<TimelineEvent[]> => {
    const [next, nextCharacters] = await Promise.all([window.workspace.timeline.list(project.id, mode), window.workspace.characters.list(project.id)])
    setEvents(next); setCharacters(nextCharacters)
    return next
  }, [mode, project.id])

  useEffect(() => {
    void load().then((next) => {
      const focus = focusEventId ? next.find((event) => event.id === focusEventId) : undefined
      if (focus) setDraft({ id: focus.id, storyTimeLabel: focus.storyTimeLabel, sortKey: String(focus.sortKey), title: focus.title, chapterId: focus.chapterId ?? '', characterIds: focus.characterIds })
    }).catch((next) => setError(String(next)))
  }, [focusEventId, load])

  const save = async (): Promise<void> => {
    setError(undefined)
    const sortKey = Number(draft.sortKey)
    if (!Number.isFinite(sortKey)) { setError('排序键须为数字。'); return }
    try {
      const saved = await window.workspace.timeline.save({ id: draft.id, projectId: project.id, storyTimeLabel: draft.storyTimeLabel, sortKey, title: draft.title, chapterId: draft.chapterId || null, characterIds: draft.characterIds })
      setDraft({ ...draft, id: saved.id }); await load()
    } catch (next) { setError(next instanceof Error ? next.message : String(next)) }
  }
  const remove = async (): Promise<void> => {
    if (!draft.id) return
    try { await window.workspace.timeline.delete(project.id, draft.id); setDraft(emptyDraft()); await load() } catch (next) { setError(String(next)) }
  }
  const chapterTitle = (id: string | null): string | undefined => id ? chapters.find((chapter) => chapter.id === id)?.title : undefined
  const characterName = (id: string): string => characters.find((item) => item.id === id)?.name ?? '（已删）'
  const toggleCharacter = (id: string): void => setDraft((prev) => ({ ...prev, characterIds: prev.characterIds.includes(id) ? prev.characterIds.filter((item) => item !== id) : [...prev.characterIds, id] }))

  return <section className="project-view timeline-view" data-testid="timeline-view">
    <header><div><h1>时间线</h1><p>作者手动录入的故事事件；AI 不读写，也不进入 AI 上下文。</p></div>
      <div className="timeline-mode" role="group" aria-label="排序方式">{(['story', 'chapter'] as TimelineSortMode[]).map((item) => <button key={item} className={mode === item ? 'active' : ''} aria-pressed={mode === item} onClick={() => setMode(item)}>{TIMELINE_SORT_LABEL[item]}</button>)}
        <button onClick={() => setDraft(emptyDraft())}><Plus size={16} />新建事件</button></div></header>
    {error && <div className="navigation-error" role="alert">{error}</div>}
    <div className="timeline-grid">
      <ol className="timeline-list">{events.length === 0 && <li className="timeline-empty">还没有事件。</li>}{events.map((event) => <li key={event.id} className={draft.id === event.id ? 'timeline-item active' : 'timeline-item'}>
        <button className="timeline-item-main" onClick={() => setDraft({ id: event.id, storyTimeLabel: event.storyTimeLabel, sortKey: String(event.sortKey), title: event.title, chapterId: event.chapterId ?? '', characterIds: event.characterIds })}><CalendarClock size={15} /><small>{event.storyTimeLabel || `#${event.sortKey}`}</small><strong>{event.title}</strong></button>
        <div className="timeline-links">{event.chapterId && chapterTitle(event.chapterId) && <button className="link" onClick={() => onOpenChapter(event.chapterId!)}>📖 {chapterTitle(event.chapterId)}</button>}{event.characterIds.map((id) => <button key={id} className="link" onClick={() => onOpenCharacter(id)}>👤 {characterName(id)}</button>)}</div>
      </li>)}</ol>
      <div className="note-editor timeline-editor">
        <label><span>标题</span><input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
        <label><span>故事时间（自由文本，如“三年前春”）</span><input value={draft.storyTimeLabel} onChange={(event) => setDraft({ ...draft, storyTimeLabel: event.target.value })} /></label>
        <label><span>排序键（数字，越小越早）</span><input type="number" value={draft.sortKey} onChange={(event) => setDraft({ ...draft, sortKey: event.target.value })} /></label>
        <label><span>关联章节</span><select value={draft.chapterId} onChange={(event) => setDraft({ ...draft, chapterId: event.target.value })}><option value="">（无）</option>{chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.title}</option>)}</select></label>
        <fieldset className="timeline-characters"><legend>关联人物</legend>{characters.length === 0 ? <small>暂无人物</small> : characters.map((item) => <label key={item.id}><input type="checkbox" checked={draft.characterIds.includes(item.id)} onChange={() => toggleCharacter(item.id)} />{item.name}</label>)}</fieldset>
        <div><button className="primary" onClick={() => void save()}><Save size={15} />保存</button>{draft.id && <button onClick={() => void remove()}><Trash2 size={15} />删除</button>}</div>
      </div>
    </div>
  </section>
}

/** 章节/人物侧：显示相关时间线事件，点击跳到时间线并定位。 */
export function RelatedTimelineEvents({ projectId, chapterId, characterId, onOpenEvent }: {
  projectId: string; chapterId?: string; characterId?: string; onOpenEvent(eventId: string): void
}): React.JSX.Element | null {
  const [events, setEvents] = useState<TimelineEvent[]>([])
  useEffect(() => {
    let active = true
    const request = chapterId ? window.workspace.timeline.listForChapter(projectId, chapterId)
      : characterId ? window.workspace.timeline.listForCharacter(projectId, characterId) : Promise.resolve([])
    void request.then((next) => { if (active) setEvents(next) }).catch(() => { if (active) setEvents([]) })
    return () => { active = false }
  }, [chapterId, characterId, projectId])
  if (events.length === 0) return null
  return <div className="timeline-related" data-testid="timeline-related"><h3><CalendarClock size={14} />相关时间线事件</h3>
    <ul>{events.map((event) => <li key={event.id}><button className="link" onClick={() => onOpenEvent(event.id)}>{event.storyTimeLabel ? `${event.storyTimeLabel} · ` : ''}{event.title}</button></li>)}</ul></div>
}
