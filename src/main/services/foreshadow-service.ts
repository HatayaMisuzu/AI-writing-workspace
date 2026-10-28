import { randomUUID } from 'node:crypto'
import type { ForeshadowEntry, ForeshadowMeta, ForeshadowState, MemoryItem } from '../../shared/domain'
import {
  compareForeshadowEntries,
  encodeForeshadowLocation,
  isForeshadowOverdue,
  parseForeshadowLocation
} from '../../shared/foreshadow'
import type { AppDatabase } from '../database/database'
import { DocumentService } from './document-service'
import { MemoryService } from './memory-service'

type MetaRow = {
  memory_id: string
  project_id: string
  planned_chapter_id: string | null
  resolved_chapter_id: string | null
  state: ForeshadowState
  abandon_reason: string
  character_ids_json: string
}

const mapMeta = (row: MetaRow): ForeshadowMeta => ({
  memoryId: row.memory_id,
  projectId: row.project_id,
  plannedChapterId: row.planned_chapter_id,
  resolvedChapterId: row.resolved_chapter_id,
  state: row.state,
  abandonReason: row.abandon_reason ?? '',
  characterIds: JSON.parse(row.character_ids_json || '[]') as string[]
})

const truncateName = (text: string): string => {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (!compact) return '未命名伏笔'
  return compact.length > 24 ? `${compact.slice(0, 24)}…` : compact
}

export class ForeshadowService {
  private readonly memories: MemoryService
  private readonly documents: DocumentService

  constructor(private readonly db: AppDatabase) {
    this.memories = new MemoryService(db)
    this.documents = new DocumentService(db)
  }

  private getMeta(projectId: string, memoryId: string): ForeshadowMeta | null {
    const row = this.db.raw.prepare(
      'SELECT * FROM foreshadow_meta WHERE memory_id = ? AND project_id = ?'
    ).get(memoryId, projectId) as MetaRow | undefined
    return row ? mapMeta(row) : null
  }

  private upsertMeta(input: {
    memoryId: string
    projectId: string
    plannedChapterId?: string | null
    resolvedChapterId?: string | null
    state: ForeshadowState
    abandonReason?: string
    characterIds?: string[]
  }): ForeshadowMeta {
    const existing = this.getMeta(input.projectId, input.memoryId)
    const planned = input.plannedChapterId === undefined ? existing?.plannedChapterId ?? null : input.plannedChapterId
    const resolved = input.resolvedChapterId === undefined ? existing?.resolvedChapterId ?? null : input.resolvedChapterId
    const reason = input.abandonReason === undefined ? existing?.abandonReason ?? '' : input.abandonReason
    const characters = input.characterIds === undefined ? existing?.characterIds ?? [] : input.characterIds
    if (planned) this.assertChapter(input.projectId, planned)
    if (resolved) this.assertChapter(input.projectId, resolved)
    for (const characterId of characters) {
      const found = this.db.raw.prepare('SELECT 1 AS ok FROM characters WHERE id = ? AND project_id = ?')
        .get(characterId, input.projectId)
      if (!found) throw new Error('FORESHADOW_CHARACTER_NOT_IN_PROJECT')
    }
    this.db.raw.prepare(`
INSERT INTO foreshadow_meta(memory_id, project_id, planned_chapter_id, resolved_chapter_id, state, abandon_reason, character_ids_json)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(memory_id) DO UPDATE SET
  planned_chapter_id=excluded.planned_chapter_id,
  resolved_chapter_id=excluded.resolved_chapter_id,
  state=excluded.state,
  abandon_reason=excluded.abandon_reason,
  character_ids_json=excluded.character_ids_json
`).run(
      input.memoryId, input.projectId, planned, resolved, input.state, reason, JSON.stringify(characters)
    )
    return this.getMeta(input.projectId, input.memoryId)!
  }

  private assertChapter(projectId: string, chapterId: string): void {
    const row = this.db.raw.prepare(
      `SELECT type FROM document_nodes WHERE id = ? AND project_id = ?`
    ).get(chapterId, projectId) as { type: string } | undefined
    if (!row || row.type !== 'chapter') throw new Error('FORESHADOW_CHAPTER_REQUIRED')
  }

  private overdueContext(projectId: string): { chapterIdsOrdered: string[]; chapterIdsWithBody: string[] } {
    const chapters = this.documents.listOrderedChapters(projectId)
    return {
      chapterIdsOrdered: chapters.map((chapter) => chapter.id),
      chapterIdsWithBody: chapters.filter((chapter) => chapter.wordCount > 0).map((chapter) => chapter.id)
    }
  }

  private toEntry(memory: MemoryItem, meta: ForeshadowMeta, ctx: ReturnType<ForeshadowService['overdueContext']>): ForeshadowEntry {
    const fallback = truncateName(memory.content)
    const location = parseForeshadowLocation(memory.sourceLocation, fallback)
    return {
      memory,
      meta,
      name: location.name,
      selectionFrom: location.from,
      selectionTo: location.to,
      overdue: isForeshadowOverdue({
        state: meta.state,
        plannedChapterId: meta.plannedChapterId,
        chapterIdsOrdered: ctx.chapterIdsOrdered,
        chapterIdsWithBody: ctx.chapterIdsWithBody
      })
    }
  }

  /**
   * ① 正文选区登记为伏笔：作者动作 → memory 直接 confirmed（非 AI）；埋设章=当前章，位置写入 source_location。
   */
  registerFromSelection(input: {
    projectId: string
    chapterId: string
    name?: string
    content: string
    fromPm: number
    toPm: number
    plannedChapterId?: string | null
    characterIds?: string[]
  }): ForeshadowEntry {
    const content = input.content.trim()
    if (!content) throw new Error('FORESHADOW_CONTENT_REQUIRED')
    if (!Number.isInteger(input.fromPm) || !Number.isInteger(input.toPm) || input.toPm < input.fromPm) {
      throw new Error('FORESHADOW_SELECTION_INVALID')
    }
    this.assertChapter(input.projectId, input.chapterId)
    const name = (input.name?.trim() || truncateName(content))
    const location = encodeForeshadowLocation({ name, from: input.fromPm, to: input.toPm })
    let entry!: ForeshadowEntry
    this.db.transaction(() => {
      // 作者显式登记：直接 confirmed（R2 约束的是 AI，不是作者）
      const now = Date.now()
      const id = randomUUID()
      this.db.raw.prepare(`INSERT INTO memories
        (id, project_id, type, content, status, source_type, source_id, source_location, confidence, reader_visible_from, supersedes, source_revision, source_digest_id, created_at, updated_at)
        VALUES (?, ?, 'foreshadowing', ?, 'confirmed', 'author', ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`)
        .run(id, input.projectId, content, input.chapterId, location, now, now)
      const meta = this.upsertMeta({
        memoryId: id,
        projectId: input.projectId,
        plannedChapterId: input.plannedChapterId ?? null,
        resolvedChapterId: null,
        state: 'planted',
        abandonReason: '',
        characterIds: input.characterIds ?? []
      })
      const memory = this.memories.list(input.projectId).find((item) => item.id === id)
      if (!memory) throw new Error('FORESHADOW_CREATE_FAILED')
      entry = this.toEntry(memory, meta, this.overdueContext(input.projectId))
    })
    return entry
  }

  /** digest / AI 候选：只建 suggested memory + meta；不进已确认台账、不进 AI 上下文。 */
  attachSuggestedMeta(projectId: string, memoryId: string, extras?: {
    plannedChapterId?: string | null
    characterIds?: string[]
  }): ForeshadowMeta {
    const memory = this.memories.list(projectId).find((item) => item.id === memoryId)
    if (!memory) throw new Error('MEMORY_NOT_FOUND')
    if (memory.type !== 'foreshadowing') throw new Error('FORESHADOW_TYPE_REQUIRED')
    if (memory.status !== 'suggested') throw new Error('FORESHADOW_SUGGESTED_ONLY')
    return this.upsertMeta({
      memoryId,
      projectId,
      plannedChapterId: extras?.plannedChapterId ?? (memory.sourceType === 'chapter' ? memory.sourceId : null),
      state: 'planted',
      characterIds: extras?.characterIds ?? []
    })
  }

  /** 已确认台账（不含 suggested）；逾期置顶。 */
  listLedger(projectId: string): ForeshadowEntry[] {
    const ctx = this.overdueContext(projectId)
    const memories = this.memories.list(projectId).filter(
      (item) => item.type === 'foreshadowing' && item.status === 'confirmed'
    )
    const entries: ForeshadowEntry[] = []
    for (const memory of memories) {
      let meta = this.getMeta(projectId, memory.id)
      if (!meta) {
        meta = this.upsertMeta({
          memoryId: memory.id,
          projectId,
          plannedChapterId: null,
          state: 'planted'
        })
      }
      entries.push(this.toEntry(memory, meta, ctx))
    }
    return entries.toSorted((a, b) => compareForeshadowEntries(
      { overdue: a.overdue, updatedAt: a.memory.updatedAt },
      { overdue: b.overdue, updatedAt: b.memory.updatedAt }
    ))
  }

  /** 待确认 AI 伏笔（suggested），不进台账确认列表。 */
  listPending(projectId: string): ForeshadowEntry[] {
    const ctx = this.overdueContext(projectId)
    const memories = this.memories.list(projectId, ['suggested']).filter((item) => item.type === 'foreshadowing')
    return memories.map((memory) => {
      let meta = this.getMeta(projectId, memory.id)
      if (!meta) {
        meta = this.upsertMeta({
          memoryId: memory.id,
          projectId,
          plannedChapterId: memory.sourceType === 'chapter' ? memory.sourceId : null,
          state: 'planted'
        })
      }
      return this.toEntry(memory, meta, ctx)
    })
  }

  setState(projectId: string, memoryId: string, state: ForeshadowState, options?: {
    abandonReason?: string
    resolvedChapterId?: string | null
    plannedChapterId?: string | null
    characterIds?: string[]
  }): ForeshadowEntry {
    const memory = this.memories.list(projectId).find((item) => item.id === memoryId)
    if (!memory || memory.type !== 'foreshadowing') throw new Error('FORESHADOW_NOT_FOUND')
    if (memory.status !== 'confirmed') throw new Error('FORESHADOW_NOT_CONFIRMED')
    if (state === 'abandoned') {
      const reason = options?.abandonReason?.trim() ?? ''
      if (!reason) throw new Error('FORESHADOW_ABANDON_REASON_REQUIRED')
    }
    const meta = this.upsertMeta({
      memoryId,
      projectId,
      state,
      abandonReason: state === 'abandoned' ? options?.abandonReason!.trim() : '',
      resolvedChapterId: state === 'resolved'
        ? (options?.resolvedChapterId ?? memory.sourceId)
        : (options?.resolvedChapterId === undefined ? undefined : options.resolvedChapterId),
      plannedChapterId: options?.plannedChapterId,
      characterIds: options?.characterIds
    })
    return this.toEntry(memory, meta, this.overdueContext(projectId))
  }

  updateMeta(projectId: string, memoryId: string, patch: {
    plannedChapterId?: string | null
    resolvedChapterId?: string | null
    characterIds?: string[]
  }): ForeshadowEntry {
    const memory = this.memories.list(projectId).find((item) => item.id === memoryId)
    if (!memory || memory.type !== 'foreshadowing') throw new Error('FORESHADOW_NOT_FOUND')
    if (memory.status !== 'confirmed') throw new Error('FORESHADOW_NOT_CONFIRMED')
    const existing = this.getMeta(projectId, memoryId)
    if (!existing) throw new Error('FORESHADOW_META_MISSING')
    const meta = this.upsertMeta({
      memoryId,
      projectId,
      state: existing.state,
      plannedChapterId: patch.plannedChapterId,
      resolvedChapterId: patch.resolvedChapterId,
      characterIds: patch.characterIds,
      abandonReason: existing.abandonReason
    })
    return this.toEntry(memory, meta, this.overdueContext(projectId))
  }

  /** 纯函数封装，供单测直接断言逾期逻辑。 */
  evaluateOverdue(projectId: string, memoryId: string): boolean {
    const entry = this.listLedger(projectId).find((item) => item.memory.id === memoryId)
      ?? this.listPending(projectId).find((item) => item.memory.id === memoryId)
    if (!entry) throw new Error('FORESHADOW_NOT_FOUND')
    return entry.overdue
  }
}

