import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import JSZip from 'jszip'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { BackupService } from '../src/main/services/backup-service'
import { selectExportChapters, validateExportRange } from '../src/shared/export-range'
import { createTestDb } from './helpers'

const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] }
const ch = (n: number, status = 'draft'): { n: number; status: string } => ({ n, status })

describe('P1-2 F12 selectExportChapters', () => {
  const list = [ch(1, 'final'), ch(2), ch(3, 'final'), ch(4, 'final'), ch(5)]
  it('N>M 拒绝', () => { expect(() => selectExportChapters(list, { range: { from: 3, to: 2 } })).toThrow(/不能大于/) })
  it('越界拒绝（<1、>总数、非整数）', () => {
    expect(() => selectExportChapters(list, { range: { from: 0, to: 2 } })).toThrow(/超出/)
    expect(() => selectExportChapters(list, { range: { from: 4, to: 6 } })).toThrow(/超出/)
    expect(() => validateExportRange({ from: 1.5, to: 2 }, 5)).toThrow(/整数/)
    expect(() => selectExportChapters([], { range: { from: 1, to: 1 } })).toThrow(/超出/)
  })
  it('单章 N=M、首尾边界', () => {
    expect(selectExportChapters(list, { range: { from: 2, to: 2 } }).map((c) => c.n)).toEqual([2])
    expect(selectExportChapters(list, { range: { from: 1, to: 5 } }).map((c) => c.n)).toEqual([1, 2, 3, 4, 5])
  })
  it('范围 + 仅定稿组合，保持顺序', () => {
    expect(selectExportChapters(list, { range: { from: 2, to: 5 }, onlyFinal: true }).map((c) => c.n)).toEqual([3, 4])
    expect(selectExportChapters(list, { range: { from: 2, to: 2 }, onlyFinal: true })).toEqual([])
    expect(selectExportChapters(list, { onlyFinal: true }).map((c) => c.n)).toEqual([1, 3, 4])
    expect(selectExportChapters(list).map((c) => c.n)).toEqual([1, 2, 3, 4, 5])
  })
})

async function setup(): Promise<{ db: ReturnType<typeof createTestDb>; projectId: string }> {
  const db = createTestDb()
  const docs = new DocumentService(db)
  const project = new ProjectService(db).create({ title: '导出范围', projectType: 'novel' })
  const first = docs.listOrderedChapters(project.id)[0]
  const vol1 = first.parentId!
  const save = (id: string, text: string, final: boolean): void => {
    docs.saveContent({ projectId: project.id, documentId: id, editorJson: emptyDoc, plainText: text })
    if (final) docs.setChapterStatus(project.id, id, 'final')
  }
  save(first.id, '正文一', true)
  const c2 = docs.createNode({ projectId: project.id, parentId: vol1, type: 'chapter', title: '第二章' }); save(c2.id, '正文二', false)
  const vol2 = docs.createNode({ projectId: project.id, parentId: null, type: 'volume', title: '第二卷' })
  const c3 = docs.createNode({ projectId: project.id, parentId: vol2.id, type: 'chapter', title: '第三章' }); save(c3.id, '正文三', true)
  const c4 = docs.createNode({ projectId: project.id, parentId: vol2.id, type: 'chapter', title: '第四章' }); save(c4.id, '正文四', true)
  return { db, projectId: project.id }
}

async function docxParagraphs(path: string): Promise<string[]> {
  const zip = await JSZip.loadAsync(await readFile(path))
  const xml = await zip.file('word/document.xml')!.async('string')
  return [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((m) => [...m[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((t) => t[1]).join(''))
}

describe('P1-2 F12 exportManuscript 范围 × 仅定稿 × 格式', () => {
  it('TXT/MD 按章树顺序截取并组合仅定稿；越界抛错', async () => {
    const { db, projectId } = await setup()
    const dir = await mkdtemp(join(tmpdir(), 'inkstone-f12-'))
    try {
      const backup = new BackupService(db)
      const md = join(dir, 'r.md')
      await backup.exportManuscript(projectId, md, 'md', { range: { from: 2, to: 3 } })
      const text = await readFile(md, 'utf8')
      expect(text).not.toContain('正文一'); expect(text).not.toContain('正文四')
      expect(text.indexOf('正文二')).toBeLessThan(text.indexOf('## 第三章'))
      const txt = join(dir, 'f.txt')
      await backup.exportManuscript(projectId, txt, 'txt', { range: { from: 2, to: 4 }, onlyFinal: true })
      const t = await readFile(txt, 'utf8')
      expect(t).not.toContain('正文二')
      expect(t.indexOf('正文三')).toBeLessThan(t.indexOf('正文四'))
      await expect(backup.exportManuscript(projectId, join(dir, 'x.txt'), 'txt', { range: { from: 1, to: 9 } })).rejects.toThrow(/超出/)
    } finally { await rm(dir, { recursive: true, force: true }); db.close() }
  })

  it('DOCX 重新解析：卷/章标题与正文顺序与章树一致', async () => {
    const { db, projectId } = await setup()
    const dir = await mkdtemp(join(tmpdir(), 'inkstone-f12-docx-'))
    try {
      const backup = new BackupService(db)
      const all = join(dir, 'all.docx')
      await backup.exportManuscript(projectId, all, 'docx')
      const paras = (await docxParagraphs(all)).filter(Boolean)
      const order = ['第二章', '正文二', '第二卷', '第三章', '正文三', '第四章', '正文四']
      const idx = order.map((value) => paras.indexOf(value))
      expect(idx.every((i) => i >= 0)).toBe(true)
      expect([...idx].sort((a, b) => a - b)).toEqual(idx)
      expect(paras.indexOf('正文一')).toBeLessThan(paras.indexOf('第二章'))

      const ranged = join(dir, 'ranged.docx')
      await backup.exportManuscript(projectId, ranged, 'docx', { range: { from: 1, to: 3 }, onlyFinal: true })
      const rp = (await docxParagraphs(ranged)).filter(Boolean)
      expect(rp).toContain('正文一'); expect(rp).toContain('正文三')
      expect(rp).not.toContain('正文二'); expect(rp).not.toContain('正文四')
      expect(rp.indexOf('正文一')).toBeLessThan(rp.indexOf('第三章'))
      expect(rp.indexOf('第三章')).toBeLessThan(rp.indexOf('正文三'))
    } finally { await rm(dir, { recursive: true, force: true }); db.close() }
  })
})

describe('P1-2 PR20 遗留', () => {
  it('窗口宽<1100 时时间线单列；删除事件需二次确认', async () => {
    const css = await readFile(join(__dirname, '../src/renderer/src/styles.css'), 'utf8')
    expect(css).toMatch(/@media \(max-width: 1099px\) \{ \.timeline-grid \{ grid-template-columns: minmax\(0, 1fr\); \} \}/)
    const view = await readFile(join(__dirname, '../src/renderer/src/screens/TimelineView.tsx'), 'utf8')
    expect(view).toMatch(/<ConfirmAction title="删除时间线事件"[^>]*onConfirm=\{remove\}/)
  })
})
