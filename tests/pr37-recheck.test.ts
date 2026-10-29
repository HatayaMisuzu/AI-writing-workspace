// PR37 复验：超长单段分块、「应用」后增量更新提示、「全部接受」整批 1 快照 / 1 事务
import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { EditorState } from '@tiptap/pm/state'
import { createTestDb } from './helpers'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { PatchService } from '../src/main/services/patch-service'
import { LONG_PARAGRAPH_CHARS, chunkBoundaries, isChunkedParagraph, longParagraphChunksKey, longParagraphChunksPlugin } from '../src/renderer/src/services/long-paragraph-chunks'
import { shiftIssuesAfterEdit } from '../src/renderer/src/services/lint-incremental'
import type { LocalLintIssue } from '../src/shared/domain'

const schema = getSchema([StarterKit])
const seg = '林舟在会上说，他狠狠地看，又狠狠地走了。夜色很深，风也很大，远处灯。'

describe('超长单段分块', () => {
  it('短段落不分块；长段落在句末切开、块长有上限、边界升序', () => {
    expect(chunkBoundaries('短。'.repeat(100))).toEqual([])
    const text = seg.repeat(5852)
    const cuts = chunkBoundaries(text)
    expect(cuts.length).toBeGreaterThan(100)
    let previous = 0
    for (const cut of cuts) {
      expect(cut).toBeGreaterThan(previous)
      expect(cut - previous).toBeLessThanOrEqual(2000)
      expect('。！？!?；;…'.includes(text[cut - 1])).toBe(true)
      previous = cut
    }
    // 没有句末标点时在目标长度硬切
    expect(chunkBoundaries('字'.repeat(LONG_PARAGRAPH_CHARS + 3000))[0]).toBe(1500)
  })
  it('只装饰单个无格式文本节点的长段落；装饰覆盖整段、不改文档', () => {
    const long = seg.repeat(500)
    const doc = schema.nodeFromJSON({ type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: '短段。' }] },
      { type: 'paragraph', content: [{ type: 'text', text: long }] },
      { type: 'paragraph', content: [{ type: 'text', text: long.slice(0, 8000) }, { type: 'text', marks: [{ type: 'bold' }], text: '粗' }] }
    ] })
    expect([0, 1, 2].map((index) => isChunkedParagraph(doc.child(index)))).toEqual([false, true, false])
    const state = EditorState.create({ schema, doc, plugins: [longParagraphChunksPlugin()] })
    const decorations = longParagraphChunksKey.getState(state)!.find()
    expect(decorations.length).toBe(chunkBoundaries(long).length + 1)
    expect(decorations.map((item) => state.doc.textBetween(item.from, item.to)).join('')).toBe(long)
    const next = state.apply(state.tr.insertText('新', decorations[3].from))
    expect(longParagraphChunksKey.getState(next)!.find().map((item) => next.doc.textBetween(item.from, item.to)).join('')).toBe(next.doc.child(1).textContent)
  })
})

const issue = (id: string, from: number, originalText: string, occurrence: number, kind = 'wordlist'): LocalLintIssue => ({
  id, documentId: 'd', sourceRevision: 1, from, to: from + originalText.length, severity: 'info', kind, message: '', replacement: '很',
  sourceTextHash: 'old', originalText, ruleKey: `wordlist:${originalText}`, group: 'wordlist_replace', occurrence
})

describe('「应用」后增量更新提示', () => {
  it('删掉被应用的一条，后面的平移、同规则序号减 1，前面的不动，换新哈希', () => {
    const issues = [issue('a', 0, '狠狠', 1), issue('b', 10, '狠狠', 2), issue('c', 20, '狠狠', 3), issue('x', 25, '在坐', 1)]
    const next = shiftIssuesAfterEdit(issues, { issueId: 'b', from: 10, to: 12, replacementLength: 1 }, 'new')
    expect(next.map((item) => [item.id, item.from, item.to, item.occurrence, item.sourceTextHash])).toEqual([
      ['a', 0, 2, 1, 'new'], ['c', 19, 21, 2, 'new'], ['x', 24, 26, 1, 'new']
    ])
  })
  it('与改动区间重叠的提示失效删除', () => {
    const issues = [issue('a', 0, '狠狠', 1), issue('o', 1, '狠地', 1, 'other')]
    expect(shiftIssuesAfterEdit(issues, { issueId: 'a', from: 0, to: 2, replacementLength: 1 }, 'h').map((item) => item.id)).toEqual([])
  })
})

describe('「全部接受」整批', () => {
  const setup = () => {
    const db = createTestDb(); const project = new ProjectService(db).create({ title: '批量', projectType: 'novel' }); const docs = new DocumentService(db)
    const chapter = docs.listTree(project.id).find((node) => node.type === 'chapter')!
    docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc' }, plainText: '狠狠一狠狠二狠狠三' })
    const service = new PatchService(db)
    const propose = (fromPm: number) => service.propose({ projectId: project.id, documentId: chapter.id, documentRevision: 1, fromPm, toPm: fromPm + 2, originalText: '狠狠', replacement: '很' })
    return { db, project, docs, chapter, service, patches: [propose(1), propose(4), propose(7)] }
  }
  it('prepareBatch 只拍 1 个 ai_edit 快照（批量前原文），原文不符的标 stale', () => {
    const { project, docs, chapter, service, patches } = setup()
    const result = service.prepareBatch(project.id, chapter.id, 1, [
      { patchId: patches[0].id, currentText: '狠狠' }, { patchId: patches[1].id, currentText: '狠狠' }, { patchId: patches[2].id, currentText: '别的' }])
    expect(result.ready.map((patch) => patch.id)).toEqual([patches[0].id, patches[1].id])
    expect(result.stale.map((patch) => patch.id)).toEqual([patches[2].id])
    const snapshots = docs.listSnapshots(project.id, chapter.id).filter((item) => item.reason === 'ai_edit')
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0].plainText).toBe('狠狠一狠狠二狠狠三')
    expect(service.list(project.id, chapter.id).find((patch) => patch.id === patches[2].id)!.status).toBe('stale')
  })
  it('修订号不符整批 stale、不拍快照；completeBatch 要求保存已确认，一次写回状态', () => {
    const { project, docs, chapter, service, patches } = setup()
    expect(service.prepareBatch(project.id, chapter.id, 2, [{ patchId: patches[0].id, currentText: '狠狠' }]).ready).toEqual([])
    expect(docs.listSnapshots(project.id, chapter.id).filter((item) => item.reason === 'ai_edit')).toHaveLength(0)
    const ready = service.prepareBatch(project.id, chapter.id, 1, [{ patchId: patches[1].id, currentText: '狠狠' }, { patchId: patches[2].id, currentText: '狠狠' }]).ready
    expect(ready).toHaveLength(2)
    expect(() => service.completeBatch(project.id, 1, [patches[1].id], [])).toThrow('PATCH_SAVE_NOT_CONFIRMED')
    const saved = docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc' }, plainText: '狠狠一很二很三', expectedRevision: 1 })
    expect(service.completeBatch(project.id, saved.revision, [patches[1].id, patches[2].id], [])).toEqual({ accepted: 2, stale: 0 })
    expect(service.list(project.id, chapter.id).map((patch) => patch.status).sort()).toEqual(['accepted', 'accepted', 'stale'])
  })
})
