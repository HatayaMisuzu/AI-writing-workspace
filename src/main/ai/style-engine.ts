import type { TextOrigin } from '../../shared/domain'
import type { AppDatabase } from '../database/database'

const rank: Record<TextOrigin, number> = { human: 100, ai_edited_by_human: 75, mixed: 50, ai: 10 }

export interface StyleSample { id: string; documentId: string; text: string; origin: TextOrigin; score: number }

export class StyleEngine {
  constructor(private readonly db: AppDatabase) {}

  retrieve(projectId: string, limit = 8): StyleSample[] {
    const rows = this.db.raw.prepare(`
      SELECT id, document_id, origin, text FROM style_samples
      WHERE project_id = ? AND origin != 'ai' ORDER BY updated_at DESC
    `).all(projectId) as Array<{ id: string; document_id: string | null; origin: TextOrigin; text: string }>
    return rows.map((row) => ({ id: row.id, documentId: row.document_id ?? '',
      text: row.text, origin: row.origin, score: rank[row.origin] }))
      .toSorted((a, b) => b.score - a.score)
      .slice(0, limit)
  }
}
