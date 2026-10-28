import { randomUUID } from 'node:crypto'
import type { TimelineEvent, TimelineSortMode } from '../../shared/domain'
import { sortTimelineEvents } from '../../shared/timeline'
import type { AppDatabase } from '../database/database'
import { DocumentService } from './document-service'

type Row = {
  id: string; project_id: string; story_time_label: string; sort_key: number; title: string
  chapter_id: string | null; character_ids_json: string; created_at: number; updated_at: number
}

const parseIds = (json: string): string[] => {
  try { const value = JSON.parse(json || '[]') as unknown; return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [] } catch { return [] }
}
const mapRow = (row: Row): TimelineEvent => ({
  id: row.id, projectId: row.project_id, storyTimeLabel: row.story_time_label, sortKey: row.sort_key, title: row.title,
  chapterId: row.chapter_id, characterIds: parseIds(row.character_ids_json), createdAt: row.created_at, updatedAt: row.updated_at
})

/** P1-1 F9：时间线读写。纯手动录入；AI 链路（ContextEngine 等）不引用本表。 */
export class TimelineService {
  private readonly documents: DocumentService
  constructor(private readonly db: AppDatabase) { this.documents = new DocumentService(db) }

  list(projectId: string, mode: TimelineSortMode = 'story'): TimelineEvent[] {
    const rows = this.db.raw.prepare('SELECT * FROM timeline_events WHERE project_id = ?').all(projectId) as Row[]
    const chapterIds = this.documents.listOrderedChapters(projectId).map((chapter) => chapter.id)
    return sortTimelineEvents(rows.map(mapRow), mode, chapterIds)
  }

  listForChapter(projectId: string, chapterId: string): TimelineEvent[] {
    return this.list(projectId, 'story').filter((event) => event.chapterId === chapterId)
  }

  listForCharacter(projectId: string, characterId: string): TimelineEvent[] {
    return this.list(projectId, 'story').filter((event) => event.characterIds.includes(characterId))
  }

  save(input: { id?: string; projectId: string; storyTimeLabel?: string; sortKey: number; title: string; chapterId?: string | null; characterIds?: string[] }): TimelineEvent {
    const id = input.id ?? randomUUID()
    const existing = input.id ? this.db.raw.prepare('SELECT * FROM timeline_events WHERE id = ?').get(input.id) as Row | undefined : undefined
    if (input.id && (!existing || existing.project_id !== input.projectId)) throw new Error('TIMELINE_EVENT_NOT_FOUND_IN_PROJECT')
    const chapterId = input.chapterId ?? null
    if (chapterId) {
      const found = this.db.raw.prepare("SELECT 1 AS ok FROM document_nodes WHERE id = ? AND project_id = ? AND type = 'chapter'").get(chapterId, input.projectId)
      if (!found) throw new Error('TIMELINE_CHAPTER_NOT_IN_PROJECT')
    }
    const characterIds = [...new Set(input.characterIds ?? [])]
    const check = this.db.raw.prepare('SELECT 1 AS ok FROM characters WHERE id = ? AND project_id = ?')
    for (const characterId of characterIds) if (!check.get(characterId, input.projectId)) throw new Error('TIMELINE_CHARACTER_NOT_IN_PROJECT')
    const now = Date.now()
    this.db.raw.prepare(`INSERT INTO timeline_events(id,project_id,story_time_label,sort_key,title,chapter_id,character_ids_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET story_time_label=excluded.story_time_label,sort_key=excluded.sort_key,title=excluded.title,
        chapter_id=excluded.chapter_id,character_ids_json=excluded.character_ids_json,updated_at=excluded.updated_at
      WHERE project_id=excluded.project_id`)
      .run(id, input.projectId, (input.storyTimeLabel ?? '').trim(), input.sortKey, input.title.trim() || '未命名事件', chapterId, JSON.stringify(characterIds), existing?.created_at ?? now, now)
    return mapRow(this.db.raw.prepare('SELECT * FROM timeline_events WHERE id = ? AND project_id = ?').get(id, input.projectId) as Row)
  }

  delete(projectId: string, eventId: string): void {
    const result = this.db.raw.prepare('DELETE FROM timeline_events WHERE id = ? AND project_id = ?').run(eventId, projectId)
    if (result.changes !== 1) throw new Error('TIMELINE_EVENT_NOT_FOUND_IN_PROJECT')
  }
}

/** 人物删除时从时间线事件的 character_ids_json 中移除该人物（chapter_id 由外键 ON DELETE SET NULL 处理）。 */
export function detachCharacterFromTimeline(db: AppDatabase, projectId: string, characterId: string): void {
  const rows = db.raw.prepare('SELECT id, character_ids_json FROM timeline_events WHERE project_id = ?').all(projectId) as Array<{ id: string; character_ids_json: string }>
  const update = db.raw.prepare('UPDATE timeline_events SET character_ids_json = ?, updated_at = ? WHERE id = ? AND project_id = ?')
  for (const row of rows) {
    const ids = parseIds(row.character_ids_json)
    if (ids.includes(characterId)) update.run(JSON.stringify(ids.filter((id) => id !== characterId)), Date.now(), row.id, projectId)
  }
}
