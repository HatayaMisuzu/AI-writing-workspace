import type { TextOrigin } from '../../shared/domain'
import type { AppDatabase } from '../database/database'

const rank: Record<TextOrigin, number> = { human: 100, ai_edited_by_human: 75, mixed: 50, ai: 10 }

export interface StyleSample { id: string; documentId: string; text: string; origin: TextOrigin; score: number }

export class StyleEngine {
  constructor(private readonly db: AppDatabase) {}

  retrieve(projectId: string, limit = 8): StyleSample[] {
    const rows = this.db.raw.prepare(`
      SELECT o.id, o.document_id, o.from_pos, o.to_pos, o.origin, c.plain_text
      FROM text_origins o JOIN document_contents c ON c.document_id = o.document_id AND c.project_id = o.project_id
      WHERE o.project_id = ? ORDER BY o.created_at DESC
    `).all(projectId) as Array<{ id: string; document_id: string; from_pos: number; to_pos: number; origin: TextOrigin; plain_text: string }>
    return rows.map((row) => ({ id: row.id, documentId: row.document_id,
      text: row.plain_text.slice(row.from_pos, Math.min(row.to_pos, row.plain_text.length)), origin: row.origin, score: rank[row.origin] }))
      .filter((sample) => sample.text.trim().length >= 12)
      .toSorted((a, b) => b.score - a.score)
      .slice(0, limit)
  }
}
