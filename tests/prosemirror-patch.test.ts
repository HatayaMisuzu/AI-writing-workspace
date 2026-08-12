import { describe, expect, it } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { createTestDb } from './helpers'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { PatchService } from '../src/main/services/patch-service'

const schema = new Schema({
  nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*', group: 'block' }, text: { group: 'inline' } },
  marks: { bold: {} }
})
const fixture = { type: 'doc', content: [
  { type: 'paragraph', content: [{ type: 'text', text: '第一段普通文本' }] },
  { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: '第二段粗体保留' }] },
  { type: 'paragraph', content: [{ type: 'text', text: '第三段结束' }] }
] }

const findRange = (doc: ReturnType<typeof schema.nodeFromJSON>, target: string): { from: number; to: number } => {
  let found: { from: number; to: number } | undefined
  doc.descendants((node, pos) => { const index = node.isText ? (node.text ?? '').indexOf(target) : -1; if (index >= 0) found = { from: pos + index, to: pos + index + target.length } })
  if (!found) throw new Error('target missing')
  return found
}

describe('ProseMirror-safe patch', () => {
  it('uses PM coordinates, preserves untouched marks and records a snapshot', () => {
    const db = createTestDb(); const project = new ProjectService(db).create({ title: '富文本', projectType: 'novel' })
    const docs = new DocumentService(db); const chapter = docs.listOrderedChapters(project.id)[0]
    const doc = schema.nodeFromJSON(fixture); const plainText = doc.textBetween(0, doc.content.size, '\n\n')
    const saved = docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: fixture, plainText })
    const range = findRange(doc, '普通')
    const original = doc.textBetween(range.from, range.to, '\n')
    expect(plainText.slice(range.from, range.to)).not.toBe(original)
    const service = new PatchService(db)
    const patch = service.propose({ projectId: project.id, documentId: chapter.id, documentRevision: saved.revision,
      fromPm: range.from, toPm: range.to, originalText: original, replacement: '安静' })
    expect(service.prepare(project.id, patch.id, saved.revision, original).status).toBe('proposed')
    const nextDoc = EditorState.create({ schema, doc }).tr.insertText('安静', range.from, range.to).doc
    const nextJson = nextDoc.toJSON() as Record<string, unknown>
    const nextText = nextDoc.textBetween(0, nextDoc.content.size, '\n\n')
    const persisted = docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: nextJson, plainText: nextText, expectedRevision: saved.revision })
    expect(service.complete(project.id, patch.id, persisted.revision).status).toBe('accepted')
    expect(JSON.stringify(nextJson)).toContain('bold')
    expect((nextJson.content as unknown[])).toHaveLength(3)
    expect(nextText).toContain('第一段安静文本')
    expect(docs.listSnapshots(project.id, chapter.id)[0].reason).toBe('ai_edit')
  })

  it('marks target text or document revision changes stale without overwriting', () => {
    const db = createTestDb(); const project = new ProjectService(db).create({ title: '陈旧', projectType: 'novel' })
    const docs = new DocumentService(db); const chapter = docs.listOrderedChapters(project.id)[0]
    const saved = docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: fixture, plainText: '第一段普通文本\n\n第二段粗体保留\n\n第三段结束' })
    const service = new PatchService(db)
    const patch = service.propose({ projectId: project.id, documentId: chapter.id, documentRevision: saved.revision, fromPm: 4, toPm: 6, originalText: '普通', replacement: '安静' })
    expect(service.prepare(project.id, patch.id, saved.revision, '变化').status).toBe('stale')
    expect(docs.getContent(project.id, chapter.id).plainText).toContain('普通')

    const patch2 = service.propose({ projectId: project.id, documentId: chapter.id, documentRevision: saved.revision, fromPm: 4, toPm: 6, originalText: '普通', replacement: '安静' })
    docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: fixture, plainText: `${saved.plainText}。`, expectedRevision: saved.revision })
    expect(service.prepare(project.id, patch2.id, saved.revision, '普通').status).toBe('stale')
  })
})
