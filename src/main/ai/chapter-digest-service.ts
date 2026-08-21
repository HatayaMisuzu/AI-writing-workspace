import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AppDatabase } from '../database/database'
import type { DigestStatus } from '../../shared/domain'
import { DocumentService } from '../services/document-service'
import { MemoryService } from '../services/memory-service'

const candidateSchema = z.object({
  type: z.enum(['fact','event','character_state','relationship','decision','idea','question','foreshadowing','style_signal']).default('fact'),
  content: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  readerVisibleFrom: z.number().int().positive().optional()
})

export const chapterDigestSchema = z.object({
  summary: z.string(),
  events: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).default([]),
  characterChanges: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).default([]),
  reveals: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).default([]),
  openQuestions: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).default([]),
  memoryCandidates: z.array(candidateSchema).default([]),
  possibleContradictions: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).default([])
})

export type ChapterDigestPayload = z.infer<typeof chapterDigestSchema>

const parseJson = (raw: string): unknown => {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  return JSON.parse(fenced ?? raw)
}

export class ChapterDigestService {
  private readonly documents: DocumentService
  private readonly memories: MemoryService
  constructor(private readonly db: AppDatabase) { this.documents = new DocumentService(db); this.memories = new MemoryService(db) }

  storeFromModel(projectId: string, chapterId: string, raw: string): { id: string; payload: ChapterDigestPayload } {
    const content = this.documents.getContent(projectId, chapterId)
    const payload = chapterDigestSchema.parse(parseJson(raw))
    const id = randomUUID()
    this.db.transaction(() => {
      this.db.raw.prepare('UPDATE chapter_digests SET stale = 1 WHERE project_id = ? AND chapter_id = ?').run(projectId, chapterId)
      this.db.raw.prepare(`UPDATE memories SET status = 'rejected', updated_at = ?
        WHERE project_id = ? AND source_type = 'chapter' AND source_id = ? AND status = 'suggested'`)
        .run(Date.now(), projectId, chapterId)
      this.db.raw.prepare(`INSERT INTO chapter_digests
        (id,project_id,chapter_id,chapter_revision,summary,structured_payload,stale,created_at)
        VALUES (?,?,?,?,?,?,0,?)`).run(id, projectId, chapterId, content.revision, payload.summary, JSON.stringify(payload), Date.now())
      payload.memoryCandidates.forEach((candidate) => this.memories.create({
        projectId, type: candidate.type, content: candidate.content, status: 'suggested', sourceType: 'chapter', sourceId: chapterId,
        confidence: candidate.confidence, readerVisibleFrom: candidate.readerVisibleFrom
      }))
    })
    return { id, payload }
  }

  list(projectId: string, chapterId?: string): Array<{ id: string; chapterId: string; revision: number; summary: string; payload: ChapterDigestPayload; stale: boolean; createdAt: number }> {
    const rows = (chapterId
      ? this.db.raw.prepare('SELECT * FROM chapter_digests WHERE project_id = ? AND chapter_id = ? ORDER BY created_at DESC').all(projectId, chapterId)
      : this.db.raw.prepare('SELECT * FROM chapter_digests WHERE project_id = ? ORDER BY created_at DESC').all(projectId)) as Array<Record<string, unknown>>
    return rows.map((row) => ({ id: row.id as string, chapterId: row.chapter_id as string, revision: row.chapter_revision as number,
      summary: row.summary as string, payload: chapterDigestSchema.parse(JSON.parse(row.structured_payload as string)),
      stale: Boolean(row.stale), createdAt: row.created_at as number }))
  }

  status(projectId: string, chapterId: string): DigestStatus {
    const current = this.documents.getContent(projectId, chapterId)
    const latest = this.list(projectId, chapterId)[0]
    if (!latest) return { state: 'missing' }
    if (!latest.stale && latest.revision === current.revision) return { state: 'fresh', digestId: latest.id, chapterRevision: latest.revision }
    // 摘要已过期：其产生的未确认候选随之失效（确认过的候选不受影响）
    this.db.raw.prepare(`UPDATE memories SET status = 'rejected', updated_at = ?
      WHERE project_id = ? AND source_type = 'chapter' AND source_id = ? AND status = 'suggested'`)
      .run(Date.now(), projectId, chapterId)
    return { state: 'stale', digestId: latest.id, digestRevision: latest.revision, currentRevision: current.revision }
  }
}
