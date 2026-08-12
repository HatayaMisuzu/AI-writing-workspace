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
    const hash = createHash('sha256').update(`${input.documentId ?? 'project'}\0${text}`).digest('hex')
    const latest = this.db.raw.prepare('SELECT MAX(updated_at) AS updated_at FROM style_samples WHERE project_id = ? AND document_id IS ? AND origin = ?')
      .get(input.projectId, input.documentId ?? null, input.origin) as { updated_at: number | null }
    const now = Math.max(Date.now(), (latest.updated_at ?? 0) + 1); const id = randomUUID()
    this.db.raw.prepare(`INSERT INTO style_samples(id,project_id,document_id,origin,text,text_hash,source_revision,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,origin,text_hash) DO UPDATE SET
        document_id=excluded.document_id, source_revision=excluded.source_revision, updated_at=excluded.updated_at`)
      .run(id, input.projectId, input.documentId ?? null, input.origin, text, hash, input.sourceRevision ?? null, now, now)
    if (input.documentId) {
      const keep = input.origin === 'ai' ? 4 : 3
      this.db.raw.prepare(`DELETE FROM style_samples WHERE project_id = ? AND document_id = ? AND origin = ? AND id NOT IN (
        SELECT id FROM style_samples WHERE project_id = ? AND document_id = ? AND origin = ? ORDER BY updated_at DESC LIMIT ?
      )`).run(input.projectId, input.documentId, input.origin, input.projectId, input.documentId, input.origin, keep)
    }
    const row = this.db.raw.prepare('SELECT * FROM style_samples WHERE project_id = ? AND origin = ? AND text_hash = ?')
      .get(input.projectId, input.origin, hash) as SampleRow
    return mapSample(row)
  }

  list(projectId: string): StyleSample[] {
    return (this.db.raw.prepare('SELECT * FROM style_samples WHERE project_id = ? ORDER BY updated_at DESC').all(projectId) as SampleRow[]).map(mapSample)
  }

  recordHumanIfSafe(projectId: string, documentId: string, text: string, sourceRevision: number): StyleSample | undefined {
    if (text.trim().length < 120) return undefined
    const aiSamples = this.db.raw.prepare(`SELECT * FROM style_samples WHERE project_id = ? AND document_id = ? AND origin = 'ai'
      ORDER BY COALESCE(source_revision, 0) DESC, updated_at DESC LIMIT 4`).all(projectId, documentId) as SampleRow[]
    if (!aiSamples.length) return this.record({ projectId, documentId, origin: 'human', text, sourceRevision })
    const newestAiRevision = Math.max(...aiSamples.map((sample) => sample.source_revision ?? sourceRevision))
    if (sourceRevision < newestAiRevision + 2 || aiSamples.some((sample) => text.includes(sample.text))) return undefined
    return this.record({ projectId, documentId, origin: 'ai_edited_by_human', text, sourceRevision })
  }
}
