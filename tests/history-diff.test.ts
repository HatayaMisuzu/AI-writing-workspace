import { describe, expect, it } from 'vitest'
import { buildHistoryDiff } from '../src/renderer/src/services/history-diff'
import { DocumentService } from '../src/main/services/document-service'
import { ProjectService } from '../src/main/services/project-service'
import { createTestDb } from './helpers'

describe('history diff', () => {
  it('marks inserts, deletes and unchanged text without interpreting HTML', () => {
    const diff = buildHistoryDiff('她打开门。\n外面下雨。<script>', '她轻轻打开门。\n外面下着大雨。<script>')
    expect(diff.some((part) => part.type === 'insert')).toBe(true)
    expect(buildHistoryDiff('保留这一句，删除这一句。', '保留这一句。').some((part) => part.type === 'delete')).toBe(true)
    expect(diff.map((part) => part.value).join('')).toContain('<script>')
  })

  it('creates a pre_restore snapshot before restoring', () => {
    const db = createTestDb(); const project = new ProjectService(db).create({ title: '历史', projectType: 'novel' })
    const docs = new DocumentService(db); const chapter = docs.listOrderedChapters(project.id)[0]
    docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc' }, plainText: '旧版本' })
    const old = docs.createSnapshot(project.id, chapter.id, 'manual')
    docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc' }, plainText: '当前版本' })
    docs.restoreSnapshot(project.id, old.id)
    expect(docs.listSnapshots(project.id, chapter.id).some((snapshot) => snapshot.reason === 'pre_restore' && snapshot.plainText === '当前版本')).toBe(true)
  })

  it('persists a restorable ai_edit snapshot from before candidate insertion', () => {
    const db = createTestDb(); const project = new ProjectService(db).create({ title: '候选插入历史', projectType: 'novel' })
    const docs = new DocumentService(db); const chapter = docs.listOrderedChapters(project.id)[0]
    docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc' }, plainText: '插入前正文' })
    const beforeInsertion = docs.createSnapshot(project.id, chapter.id, 'ai_edit')
    docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc' }, plainText: '插入前正文候选续写' })

    const restarted = new DocumentService(db)
    expect(restarted.listSnapshots(project.id, chapter.id).find((snapshot) => snapshot.id === beforeInsertion.id))
      .toMatchObject({ reason: 'ai_edit', plainText: '插入前正文' })
    expect(restarted.restoreSnapshot(project.id, beforeInsertion.id).plainText).toBe('插入前正文')
  })
})
