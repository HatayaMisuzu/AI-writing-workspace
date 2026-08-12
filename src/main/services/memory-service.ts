import { randomUUID } from 'node:crypto'
import type { Idea, MemoryIntentProposal, MemoryItem, MemoryProposal, MemoryStatus, MemoryType } from '../../shared/domain'
import type { AppDatabase } from '../database/database'
import { relevanceScore } from '../ai/relevance'

type MemoryRow = {
  id: string; project_id: string; type: MemoryType; content: string; status: MemoryStatus
  source_type: MemoryItem['sourceType']; source_id: string; source_location: string | null
  confidence: number | null; reader_visible_from: number | null; supersedes: string | null
  created_at: number; updated_at: number
}

const mapMemory = (row: MemoryRow): MemoryItem => ({
  id: row.id, projectId: row.project_id, type: row.type, content: row.content, status: row.status,
  sourceType: row.source_type, sourceId: row.source_id, sourceLocation: row.source_location ?? undefined,
  confidence: row.confidence ?? undefined, readerVisibleFrom: row.reader_visible_from ?? undefined,
  supersedes: row.supersedes ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at
})

export class MemoryService {
  constructor(private readonly db: AppDatabase) {}

  list(projectId: string, statuses?: MemoryStatus[], query?: string): MemoryItem[] {
    const statusSql = statuses?.length ? ` AND status IN (${statuses.map(() => '?').join(',')})` : ''
    const querySql = query?.trim() ? ' AND content LIKE ?' : ''
    const args: Array<string | number | null> = [projectId, ...(statuses ?? [])]
    if (query?.trim()) args.push(`%${query.trim()}%`)
    const rows = this.db.raw.prepare(`SELECT * FROM memories WHERE project_id = ?${statusSql}${querySql} ORDER BY updated_at DESC`)
      .all(...args) as MemoryRow[]
    return rows.map(mapMemory)
  }

  searchRelevant(projectId: string, statuses: MemoryStatus[], query: string, limit = 12): MemoryItem[] {
    return this.list(projectId, statuses)
      .map((memory) => ({ memory, score: relevanceScore(memory.content, query) + (memory.status === 'confirmed' ? 5 : memory.status === 'observed' ? 3 : 0) }))
      .filter((item) => item.score > 0)
      .toSorted((a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt)
      .slice(0, limit)
      .map((item) => item.memory)
  }

  create(input: {
    projectId: string; type: MemoryType; content: string; status: Exclude<MemoryStatus, 'confirmed'>
    sourceType: MemoryItem['sourceType']; sourceId: string; sourceLocation?: string
    confidence?: number; readerVisibleFrom?: number; supersedes?: string
  }): MemoryItem {
    const now = Date.now()
    const id = randomUUID()
    this.db.raw.prepare(`INSERT INTO memories
      (id, project_id, type, content, status, source_type, source_id, source_location, confidence, reader_visible_from, supersedes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.projectId, input.type, input.content, input.status, input.sourceType, input.sourceId,
        input.sourceLocation ?? null, input.confidence ?? null, input.readerVisibleFrom ?? null, input.supersedes ?? null, now, now)
    return this.get(input.projectId, id)
  }

  proposeFromChat(projectId: string, sourceId: string, rawContent: string): MemoryProposal | null {
    const strict = rawContent.match(/^(?:记一下[：:]|就这么定[，,：:]?)(.+?)(?:[，,]?这个记一下)?[。！!]?$/u)?.[1]?.trim()
    if (!strict || /不要记|别记|别定|不确定|要不要|如果/.test(rawContent)) return null
    return this.createProposals(projectId, sourceId, [{ type: 'fact', content: strict, confidence: 1 }])[0] ?? null
  }

  createProposals(projectId: string, sourceId: string, proposals: MemoryIntentProposal[]): MemoryProposal[] {
    if (!this.db.raw.prepare('SELECT 1 AS found FROM projects WHERE id = ?').get(projectId)) throw new Error('PROJECT_NOT_FOUND')
    return proposals.slice(0, 3).filter((proposal) => proposal.content.trim()).map((proposal) => this.create({
      projectId, type: proposal.type, content: proposal.content.trim(), status: 'suggested', sourceType: 'chat', sourceId,
      sourceLocation: proposal.supersedes ? '作者明确要求替代既有设定' : '作者明确要求记录', confidence: proposal.confidence,
      supersedes: proposal.supersedes
    }) as MemoryProposal)
  }

  confirm(projectId: string, memoryId: string, confirmedBy: 'user'): MemoryItem {
    if (confirmedBy !== 'user') throw new Error('CONFIRMED_REQUIRES_USER')
    const existing = this.get(projectId, memoryId)
    if (existing.status === 'confirmed') return existing
    if (existing.status === 'rejected' || existing.status === 'superseded') throw new Error('MEMORY_NOT_CONFIRMABLE')
    this.db.transaction(() => {
      if (existing.supersedes) {
        const previous = this.get(projectId, existing.supersedes)
        if (previous.status !== 'confirmed') throw new Error('MEMORY_REPLACEMENT_TARGET_CHANGED')
        this.db.raw.prepare('UPDATE memories SET status = ?, updated_at = ? WHERE id = ? AND project_id = ?')
          .run('superseded', Date.now(), previous.id, projectId)
      }
      this.db.raw.prepare('UPDATE memories SET status = ?, updated_at = ? WHERE id = ? AND project_id = ?')
        .run('confirmed', Date.now(), memoryId, projectId)
    })
    return this.get(projectId, memoryId)
  }

  reject(projectId: string, memoryId: string): MemoryItem {
    this.get(projectId, memoryId)
    this.db.raw.prepare('UPDATE memories SET status = ?, updated_at = ? WHERE id = ? AND project_id = ?')
      .run('rejected', Date.now(), memoryId, projectId)
    return this.get(projectId, memoryId)
  }

  retire(projectId: string, memoryId: string): MemoryItem {
    const existing = this.get(projectId, memoryId)
    if (existing.status !== 'confirmed') throw new Error('ONLY_CONFIRMED_MEMORY_CAN_BE_RETIRED')
    return this.reject(projectId, memoryId)
  }

  proposeReplacement(projectId: string, oldId: string, content: string): MemoryItem {
    const previous = this.get(projectId, oldId)
    if (previous.status !== 'confirmed') throw new Error('MEMORY_REPLACEMENT_REQUIRES_CONFIRMED_TARGET')
    if (!content.trim()) throw new Error('MEMORY_CONTENT_REQUIRED')
    return this.create({ projectId, type: previous.type, content: content.trim(), status: 'suggested', sourceType: 'author',
      sourceId: oldId, sourceLocation: '作者提出替代，确认后生效', supersedes: oldId })
  }

  findConfirmedMatch(projectId: string, content: string): MemoryItem | undefined {
    const normalized = content.trim().replace(/[。！!？?，,；;：:\s]/g, '')
    if (!normalized) return undefined
    const confirmed = this.list(projectId, ['confirmed']).map((item) => ({ item,
      normalized: item.content.replace(/[。！!？?，,；;：:\s]/g, '') }))
    const exact = confirmed.filter((candidate) => candidate.normalized === normalized)
    if (exact.length === 1) return exact[0].item
    const partial = confirmed.filter((candidate) => candidate.normalized.includes(normalized) || normalized.includes(candidate.normalized))
    return partial.length === 1 ? partial[0].item : undefined
  }

  private get(projectId: string, memoryId: string): MemoryItem {
    const row = this.db.raw.prepare('SELECT * FROM memories WHERE id = ? AND project_id = ?').get(memoryId, projectId) as MemoryRow | undefined
    if (!row) throw new Error('MEMORY_NOT_FOUND_IN_PROJECT')
    return mapMemory(row)
  }
}

export class IdeaService {
  constructor(private readonly db: AppDatabase) {}

  list(projectId: string): Idea[] {
    const rows = this.db.raw.prepare('SELECT * FROM ideas WHERE project_id = ? ORDER BY updated_at DESC').all(projectId) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: row.id as string, projectId: row.project_id as string, content: row.content as string,
      status: row.status as Idea['status'], tags: JSON.parse(row.tags_json as string) as string[],
      createdAt: row.created_at as number, updatedAt: row.updated_at as number
    }))
  }

  create(projectId: string, content: string, tags: string[] = []): Idea {
    const now = Date.now()
    const idea: Idea = { id: randomUUID(), projectId, content: content.trim(), status: 'active', tags, createdAt: now, updatedAt: now }
    this.db.raw.prepare(`INSERT INTO ideas (id, project_id, content, status, tags_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(idea.id, projectId, idea.content, idea.status, JSON.stringify(tags), now, now)
    return idea
  }
}
