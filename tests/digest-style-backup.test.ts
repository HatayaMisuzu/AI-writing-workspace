import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTestDb } from './helpers'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { ChapterDigestService } from '../src/main/ai/chapter-digest-service'
import { StyleEngine } from '../src/main/ai/style-engine'
import { BackupService } from '../src/main/services/backup-service'
import { ProjectContentService } from '../src/main/services/project-content-service'
import { StyleSampleService } from '../src/main/services/style-sample-service'

describe('digest, style retrieval, reorder and complete project backup', () => {
  const tempDirs: string[] = []
  afterEach(async () => { await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

  it('stores validated digest candidates as suggested, never confirmed', () => {
    const db = createTestDb(); const project = new ProjectService(db).create({ title: 'Digest', projectType: 'novel' })
    const chapter = new DocumentService(db).listTree(project.id).find((node) => node.type === 'chapter')!
    const result = new ChapterDigestService(db).storeFromModel(project.id, chapter.id, JSON.stringify({
      summary: '本章出现红伞。', events: ['红伞出现'], characterChanges: [], reveals: [], openQuestions: ['谁留下红伞？'],
      memoryCandidates: [{ type: 'foreshadowing', content: '红伞可能是信号', confidence: 0.7 }], possibleContradictions: []
    }))
    expect(result.payload.summary).toContain('红伞')
    const memory = db.raw.prepare('SELECT status, source_id FROM memories WHERE project_id = ?').get(project.id) as { status: string; source_id: string }
    expect(memory).toEqual({ status: 'suggested', source_id: chapter.id })
  })

  it('uses confirmed human style samples and excludes raw AI samples', () => {
    const db = createTestDb(); const project = new ProjectService(db).create({ title: 'Style', projectType: 'novel' }); const docs = new DocumentService(db)
    const chapter = docs.listTree(project.id).find((node) => node.type === 'chapter')!
    const authorText = '这是作者亲手写下的一段安静文字。'.repeat(12)
    docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc' }, plainText: authorText })
    new StyleSampleService(db).record({ projectId: project.id, documentId: chapter.id, origin: 'ai', text: '这是未经作者修改的模型生成文字，绝不能成为风格样本。' })
    const samples = new StyleEngine(db).retrieve(project.id)
    expect(samples[0].origin).toBe('human')
    expect(samples.some((sample) => sample.origin === 'ai')).toBe(false)
  })

  it('reorders chapters without transient unique conflicts', () => {
    const db = createTestDb(); const project = new ProjectService(db).create({ title: 'Order', projectType: 'novel' }); const docs = new DocumentService(db)
    const volume = docs.listTree(project.id).find((node) => node.type === 'volume')!
    const first = docs.listTree(project.id).find((node) => node.type === 'chapter')!
    const second = docs.createNode({ projectId: project.id, parentId: volume.id, type: 'chapter', title: '第二章' })
    docs.reorder(project.id, second.id, volume.id, 0)
    const chapters = docs.listTree(project.id).filter((node) => node.type === 'chapter').toSorted((a, b) => a.orderIndex - b.orderIndex)
    expect(chapters.map((node) => node.id)).toEqual([second.id, first.id])
  })

  it('round-trips project content and keeps the imported project isolated', async () => {
    const db = createTestDb(); const project = new ProjectService(db).create({ title: '备份作品', projectType: 'novel' }); const docs = new DocumentService(db)
    const chapter = docs.listTree(project.id).find((node) => node.type === 'chapter')!
    docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc' }, plainText: '只属于原作品的备份正文。' })
    docs.createSnapshot(project.id, chapter.id, 'manual')
    new ProjectContentService(db).saveNote({ projectId: project.id, section: 'story', title: '备份故事笔记', content: '随项目一起恢复。' })
    const dir = await mkdtemp(join(tmpdir(), 'inkstone-backup-test-')); tempDirs.push(dir)
    const path = join(dir, 'project.aiwproj'); const backup = new BackupService(db)
    await backup.exportProject(project.id, path)
    const imported = await backup.importProject(path)
    expect(imported.id).not.toBe(project.id)
    const importedChapter = docs.listTree(imported.id).find((node) => node.type === 'chapter')!
    expect(docs.getContent(imported.id, importedChapter.id).plainText).toContain('备份正文')
    expect(() => docs.getContent(imported.id, chapter.id)).toThrow('DOCUMENT_NOT_FOUND_IN_PROJECT')
    expect(docs.listSnapshots(imported.id, importedChapter.id)).toHaveLength(1)
    expect(new ProjectContentService(db).listNotes(imported.id, 'story')[0].title).toBe('备份故事笔记')
  })

  it('imports TXT and structured Markdown as independent works', async () => {
    const db = createTestDb(); const backup = new BackupService(db); const docs = new DocumentService(db)
    const dir = await mkdtemp(join(tmpdir(), 'inkstone-manuscript-test-')); tempDirs.push(dir)
    const txtPath = join(dir, '短篇.txt'); const mdPath = join(dir, '长篇.md')
    await writeFile(txtPath, '只有短篇作品能检索到的灯塔。', 'utf8')
    await writeFile(mdPath, '# 上卷\n\n## 第一章\n\n上卷第一章的潮声。\n\n## 第二章\n\n上卷第二章的雨。\n\n# 下卷\n\n## 尾声\n\n下卷尾声的船。', 'utf8')

    const txtProject = await backup.importManuscript(txtPath)
    const mdProject = await backup.importManuscript(mdPath)
    const mdTree = docs.listTree(mdProject.id)
    expect(mdTree.filter((node) => node.type === 'volume').map((node) => node.title)).toEqual(['上卷', '下卷'])
    expect(mdTree.filter((node) => node.type === 'chapter').map((node) => node.title)).toEqual(['第一章', '第二章', '尾声'])
    expect(docs.search(txtProject.id, '灯塔')).toHaveLength(1)
    expect(docs.search(mdProject.id, '灯塔')).toHaveLength(0)
    expect(docs.search(mdProject.id, '潮声')[0].projectId).toBe(mdProject.id)
  })

  it('exports complete manuscripts to TXT, Markdown and DOCX', async () => {
    const db = createTestDb(); const project = new ProjectService(db).create({ title: '导出作品', projectType: 'novel' })
    const docs = new DocumentService(db); const chapter = docs.listTree(project.id).find((node) => node.type === 'chapter')!
    docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc' }, plainText: '需要完整导出的正文。' })
    const dir = await mkdtemp(join(tmpdir(), 'inkstone-export-test-')); tempDirs.push(dir)
    const txtPath = join(dir, 'work.txt'); const mdPath = join(dir, 'work.md'); const docxPath = join(dir, 'work.docx')
    const backup = new BackupService(db)
    await backup.exportManuscript(project.id, txtPath, 'txt')
    await backup.exportManuscript(project.id, mdPath, 'md')
    await backup.exportManuscript(project.id, docxPath, 'docx')
    expect(await readFile(txtPath, 'utf8')).toContain('需要完整导出的正文')
    expect(await readFile(mdPath, 'utf8')).toContain('## 第一章')
    expect((await readFile(docxPath)).subarray(0, 2).toString()).toBe('PK')
    expect((await stat(docxPath)).size).toBeGreaterThan(1000)
  })
})
