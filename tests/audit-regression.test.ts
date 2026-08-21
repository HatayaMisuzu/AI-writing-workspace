import { describe, it, expect } from 'vitest'
import { AppDatabase } from '../src/main/database/database'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { BackupService } from '../src/main/services/backup-service'
import { ChapterDigestService } from '../src/main/ai/chapter-digest-service'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 回归：审计 H-2（导出丢章）、H-3（GBK/BOM 解码）、M-1（自动保存误杀记忆候选）

const digestRaw = JSON.stringify({
  summary: '摘要', events: [], characterChanges: [], reveals: [], openQuestions: [],
  memoryCandidates: [{ type: 'fact', content: '主角有一把红伞', confidence: 0.9 }], possibleContradictions: []
})

function setup() {
  const db = new AppDatabase(':memory:')
  const projects = new ProjectService(db)
  const docs = new DocumentService(db)
  const backup = new BackupService(db)
  const project = projects.create({ title: 'T', projectType: 'novel', description: '' })
  const tree = docs.listTree(project.id)
  const volume = tree.find((n) => n.type === 'volume')!
  const chapter = tree.find((n) => n.type === 'chapter')!
  return { db, projects, docs, backup, project, volume, chapter }
}

describe('稿件导出完整性（审计 H-2 回归）', () => {
  it('无 contents 行的章节不再被静默丢弃，输出占位提示', async () => {
    const s = setup()
    s.docs.saveContent({ projectId: s.project.id, documentId: s.chapter.id, editorJson: { type: 'doc' }, plainText: '第一章正文' })
    const c2 = s.docs.createNode({ projectId: s.project.id, parentId: s.volume.id, type: 'chapter', title: '第二章' })
    s.db.raw.prepare('DELETE FROM document_contents WHERE document_id = ?').run(c2.id)

    const dir = mkdtempSync(join(tmpdir(), 'inkstone-audit-'))
    try {
      const txtPath = join(dir, 'out.txt')
      await s.backup.exportManuscript(s.project.id, txtPath, 'txt')
      const content = readFileSync(txtPath, 'utf8')
      expect(content).toContain('第二章')
      expect(content).toContain('本章内容缺失')
    } finally { rmSync(dir, { recursive: true, force: true }) }
    s.db.close()
  })
})

describe('导入编码探测（审计 H-3 回归）', () => {
  it('GBK 编码文件不再乱码入库', async () => {
    const s = setup()
    const dir = mkdtempSync(join(tmpdir(), 'inkstone-audit-'))
    try {
      // 「你好，世界」的 GBK 编码字节
      const gbk = Buffer.from([0xC4, 0xE3, 0xBA, 0xC3, 0xA3, 0xAC, 0xCA, 0xC0, 0xBD, 0xE7])
      const p = join(dir, 'gbk.txt')
      writeFileSync(p, gbk)
      const imported = await s.backup.importManuscript(p)
      const importedChapter = s.docs.listOrderedChapters(imported.id)[0]
      const content = s.docs.getContent(imported.id, importedChapter.id)
      expect(content.plainText).toContain('你好')
      expect(content.plainText).not.toContain('\uFFFD')
    } finally { rmSync(dir, { recursive: true, force: true }) }
    s.db.close()
  })
  it('带 UTF-8 BOM 的文件首行标题正常解析', async () => {
    const s = setup()
    const dir = mkdtempSync(join(tmpdir(), 'inkstone-audit-'))
    try {
      const p = join(dir, 'bom.md')
      writeFileSync(p, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# 第一卷\n\n## 第一章\n\n正文内容', 'utf8')]))
      const imported = await s.backup.importManuscript(p)
      const chapters = s.docs.listOrderedChapters(imported.id)
      expect(chapters.some((c) => c.title === '第一章')).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
    s.db.close()
  })
})

describe('自动保存与记忆候选（审计 M-1 回归）', () => {
  it('digest 产生的候选不再被下一次自动保存静默拒绝', () => {
    const s = setup()
    const digests = new ChapterDigestService(s.db)
    s.docs.saveContent({ projectId: s.project.id, documentId: s.chapter.id, editorJson: { type: 'doc' }, plainText: '第一章内容' })
    digests.storeFromModel(s.project.id, s.chapter.id, digestRaw)
    const before = s.db.raw.prepare("SELECT status FROM memories WHERE content LIKE '%红伞%'").get() as { status: string }
    expect(before.status).toBe('suggested')
    // 用户继续写作触发自动保存
    s.docs.saveContent({ projectId: s.project.id, documentId: s.chapter.id, editorJson: { type: 'doc' }, plainText: '第一章内容，他撑开了伞' })
    const after = s.db.raw.prepare("SELECT status FROM memories WHERE content LIKE '%红伞%'").get() as { status: string }
    expect(after.status).toBe('suggested')
    s.db.close()
  })
})
