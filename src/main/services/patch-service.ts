import { randomUUID } from 'node:crypto'
import type { TextPatch } from '../../shared/domain'
import type { AppDatabase } from '../database/database'
import { DocumentService } from './document-service'

type PatchRow = {
  id: string; project_id: string; document_id: string; block_id: string; from_pos: number; to_pos: number
  original_hash: string; original_text: string; replacement: string; status: TextPatch['status']; created_at: number
}
const mapPatch = (row: PatchRow): TextPatch => ({ id: row.id, projectId: row.project_id, documentId: row.document_id,
  blockId: row.block_id, from: row.from_pos, to: row.to_pos, originalHash: row.original_hash,
  originalText: row.original_text, replacement: row.replacement, status: row.status, createdAt: row.created_at })

const toEditorJson = (text: string): Record<string, unknown> => ({
  type: 'doc', content: text.split(/\n{2,}/).map((paragraph) => ({ type: 'paragraph', content: paragraph ? [{ type: 'text', text: paragraph }] : [] }))
})

export class PatchService {
  private readonly documents: DocumentService
  constructor(private readonly db: AppDatabase) { this.documents = new DocumentService(db) }

  propose(input: { projectId: string; documentId: string; blockId?: string; from: number; to: number; replacement: string }): TextPatch {
    const content = this.documents.getContent(input.projectId, input.documentId)
    const originalText = content.plainText.slice(input.from, input.to)
    const patch: TextPatch = { id: randomUUID(), projectId: input.projectId, documentId: input.documentId,
      blockId: input.blockId ?? 'plain-text', from: input.from, to: input.to,
      originalHash: this.documents.hashRange(originalText), originalText, replacement: input.replacement,
      status: 'proposed', createdAt: Date.now() }
    this.db.raw.prepare(`INSERT INTO text_patches
      (id, project_id, document_id, block_id, from_pos, to_pos, original_hash, original_text, replacement, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(patch.id, patch.projectId, patch.documentId, patch.blockId, patch.from, patch.to, patch.originalHash,
        patch.originalText, patch.replacement, patch.status, patch.createdAt)
    return patch
  }

  apply(projectId: string, patchId: string): TextPatch {
    const patch = this.get(projectId, patchId)
    if (patch.status !== 'proposed') throw new Error('PATCH_NOT_PROPOSED')
    const content = this.documents.getContent(projectId, patch.documentId)
    const currentRange = content.plainText.slice(patch.from, patch.to)
    if (this.documents.hashRange(currentRange) !== patch.originalHash) {
      this.setStatus(projectId, patchId, 'stale')
      return this.get(projectId, patchId)
    }
    this.documents.createSnapshot(projectId, patch.documentId, 'ai_edit', { patchId })
    const nextText = content.plainText.slice(0, patch.from) + patch.replacement + content.plainText.slice(patch.to)
    this.documents.saveContent({ projectId, documentId: patch.documentId, editorJson: toEditorJson(nextText), plainText: nextText, expectedRevision: content.revision })
    this.db.raw.prepare(`INSERT INTO text_origins(id,project_id,document_id,from_pos,to_pos,origin,created_at)
      VALUES (?,?,?,?,?,'ai',?)`).run(randomUUID(), projectId, patch.documentId, patch.from, patch.from + patch.replacement.length, Date.now())
    this.setStatus(projectId, patchId, 'accepted')
    return this.get(projectId, patchId)
  }

  reject(projectId: string, patchId: string): TextPatch {
    this.get(projectId, patchId)
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
