import { randomUUID } from 'node:crypto'
import type { TextPatch } from '../../shared/domain'
import type { AppDatabase } from '../database/database'
import { DocumentService, countChineseWords } from './document-service'
import { WritingDailyService } from './writing-daily-service'

type PatchRow = {
  id: string; project_id: string; document_id: string; document_revision: number; from_pos: number; to_pos: number
  original_hash: string; original_text: string; replacement: string; status: TextPatch['status']; created_at: number
}

const mapPatch = (row: PatchRow): TextPatch => ({
  id: row.id, projectId: row.project_id, documentId: row.document_id, documentRevision: row.document_revision,
  fromPm: row.from_pos, toPm: row.to_pos, originalHash: row.original_hash, originalText: row.original_text,
  replacement: row.replacement, status: row.status, createdAt: row.created_at
})

export class PatchService {
  private readonly documents: DocumentService
  private readonly writingDaily: WritingDailyService
  constructor(private readonly db: AppDatabase, writingDaily?: WritingDailyService) {
    this.writingDaily = writingDaily ?? new WritingDailyService(db)
    this.documents = new DocumentService(db, this.writingDaily)
  }

  propose(input: {
    projectId: string; documentId: string; documentRevision: number; fromPm: number; toPm: number
    originalText: string; replacement: string
  }): TextPatch {
    const content = this.documents.getContent(input.projectId, input.documentId)
    if (content.revision !== input.documentRevision) throw new Error('PATCH_REVISION_STALE')
    if (!Number.isInteger(input.fromPm) || !Number.isInteger(input.toPm) || input.fromPm < 0 || input.toPm < input.fromPm) {
      throw new Error('PATCH_PM_RANGE_INVALID')
    }
    const patch: TextPatch = {
      id: randomUUID(), projectId: input.projectId, documentId: input.documentId,
      documentRevision: input.documentRevision, fromPm: input.fromPm, toPm: input.toPm,
      originalHash: this.documents.hashRange(input.originalText), originalText: input.originalText,
      replacement: input.replacement, status: 'proposed', createdAt: Date.now()
    }
    this.db.raw.prepare(`INSERT INTO text_patches
      (id, project_id, document_id, block_id, document_revision, from_pos, to_pos, original_hash, original_text, replacement, status, created_at)
      VALUES (?, ?, ?, 'pm-range', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(patch.id, patch.projectId, patch.documentId, patch.documentRevision, patch.fromPm, patch.toPm,
        patch.originalHash, patch.originalText, patch.replacement, patch.status, patch.createdAt)
    return patch
  }

  prepare(projectId: string, patchId: string, documentRevision: number, currentText: string): TextPatch {
    const patch = this.get(projectId, patchId)
    if (patch.status !== 'proposed') throw new Error('PATCH_NOT_PROPOSED')
    const persisted = this.documents.getContent(projectId, patch.documentId)
    if (persisted.revision !== patch.documentRevision || documentRevision !== patch.documentRevision ||
      this.documents.hashRange(currentText) !== patch.originalHash) {
      this.setStatus(projectId, patchId, 'stale')
      return this.get(projectId, patchId)
    }
    this.documents.createSnapshot(projectId, patch.documentId, 'ai_edit', { patchId, coordinateSystem: 'prosemirror' })
    return patch
  }

  complete(projectId: string, patchId: string, savedRevision: number): TextPatch {
    const patch = this.get(projectId, patchId)
    if (patch.status !== 'proposed') throw new Error('PATCH_NOT_PROPOSED')
    const persisted = this.documents.getContent(projectId, patch.documentId)
    if (persisted.revision !== savedRevision || savedRevision <= patch.documentRevision) throw new Error('PATCH_SAVE_NOT_CONFIRMED')
    this.setStatus(projectId, patchId, 'accepted')
    // 采纳 AI 字数单独累计，不计入人工码字
    const aiWords = countChineseWords(patch.replacement)
    if (aiWords > 0) this.writingDaily.addAiAcceptedWords(projectId, aiWords)
    return this.get(projectId, patchId)
  }

  /**
   * F13 批量应用（组长决定 1，方案 c）：同一批提案逐条接受，每接受一条，剩下的按新修订号重算位置。
   * 只改 revision 与 PM 区间；originalText / originalHash 不变，prepare 仍会校验当前文字，位置算错只会变 stale，不会改错字。
   */
  rebase(input: { projectId: string; patchId: string; fromRevision: number; toRevision: number; fromPm: number; toPm: number }): TextPatch {
    const patch = this.get(input.projectId, input.patchId)
    if (patch.status !== 'proposed') throw new Error('PATCH_NOT_PROPOSED')
    if (patch.documentRevision !== input.fromRevision || input.toRevision <= input.fromRevision) throw new Error('PATCH_REVISION_STALE')
    const persisted = this.documents.getContent(input.projectId, patch.documentId)
    if (persisted.revision !== input.toRevision) throw new Error('PATCH_REVISION_STALE')
    if (input.toPm < input.fromPm) throw new Error('PATCH_PM_RANGE_INVALID')
    this.db.raw.prepare('UPDATE text_patches SET document_revision = ?, from_pos = ?, to_pos = ? WHERE id = ? AND project_id = ? AND status = \'proposed\'')
      .run(input.toRevision, input.fromPm, input.toPm, input.patchId, input.projectId)
    return this.get(input.projectId, input.patchId)
  }

  reject(projectId: string, patchId: string): TextPatch {
    const patch = this.get(projectId, patchId)
    if (patch.status !== 'proposed') throw new Error('PATCH_NOT_PROPOSED')
    this.setStatus(projectId, patchId, 'rejected')
    return this.get(projectId, patchId)
  }

  list(projectId: string, documentId?: string): TextPatch[] {
    const rows = (documentId
      ? this.db.raw.prepare('SELECT * FROM text_patches WHERE project_id = ? AND document_id = ? ORDER BY created_at DESC').all(projectId, documentId)
      : this.db.raw.prepare('SELECT * FROM text_patches WHERE project_id = ? ORDER BY created_at DESC').all(projectId)) as PatchRow[]
    return rows.map(mapPatch)
  }

  private get(projectId: string, patchId: string): TextPatch {
    const row = this.db.raw.prepare('SELECT * FROM text_patches WHERE id = ? AND project_id = ?').get(patchId, projectId) as PatchRow | undefined
    if (!row) throw new Error('PATCH_NOT_FOUND_IN_PROJECT')
    return mapPatch(row)
  }

  private setStatus(projectId: string, patchId: string, status: TextPatch['status']): void {
    this.db.raw.prepare('UPDATE text_patches SET status = ? WHERE id = ? AND project_id = ?').run(status, patchId, projectId)
  }
}
