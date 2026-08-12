import { createHash, randomUUID } from 'node:crypto'
import type { StyleSample, TextOrigin } from '../../shared/domain'
import type { AppDatabase } from '../database/database'

type SampleRow = { id: string; project_id: string; document_id: string | null; origin: TextOrigin; text: string; source_revision: number | null; created_at: number; updated_at: number }
const mapSample = (row: SampleRow): StyleSample => ({ id: row.id, projectId: row.project_id, documentId: row.document_id ?? undefined,
  origin: row.origin, text: row.text, sourceRevision: row.source_revision ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at })

export class StyleSampleService {
  constructor(private readonly db: AppDatabase) {}

  record(input: { projectId: string; documentId?: string; origin: TextOrigin; text: string; sourceRevision?: number }): StyleSample | undefined {
    const text = input.text.trim().slice(-2_000)
    if (text.length < 12) return undefined
    const hash = createHash('sha256').update(text).digest('hex'); const now = Date.now(); const id = randomUUID()
    this.db.raw.prepare(`INSERT INTO style_samples(id,project_id,document_id,origin,text,text_hash,source_revision,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,origin,text_hash) DO UPDATE SET updated_at=excluded.updated_at`)
      .run(id, input.projectId, input.documentId ?? null, input.origin, text, hash, input.sourceRevision ?? null, now, now)
    const row = this.db.raw.prepare('SELECT * FROM style_samples WHERE project_id = ? AND origin = ? AND text_hash = ?')
      .get(input.projectId, input.origin, hash) as SampleRow
    return mapSample(row)
  }

  list(projectId: string): StyleSample[] {
    return (this.db.raw.prepare('SELECT * FROM style_samples WHERE project_id = ? ORDER BY updated_at DESC').all(projectId) as SampleRow[]).map(mapSample)
  }

  recordHumanIfSafe(projectId: string, documentId: string, text: string, sourceRevision: number): StyleSample | undefined {
    if (text.trim().length < 120) return undefined
    const hasKnownAi = this.db.raw.prepare("SELECT 1 AS found FROM style_samples WHERE project_id = ? AND document_id = ? AND origin = 'ai' LIMIT 1")
      .get(projectId, documentId)
    if (hasKnownAi) return undefined
    return this.record({ projectId, documentId, origin: 'human', text, sourceRevision })
  }
}
