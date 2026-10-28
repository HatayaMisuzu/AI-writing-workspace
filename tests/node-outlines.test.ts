import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppDatabase, CURRENT_SCHEMA_VERSION } from '../src/main/database/database'
import { schema } from '../src/main/database/schema'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { ProjectContentService } from '../src/main/services/project-content-service'
import { BackupService } from '../src/main/services/backup-service'
import { createTestDb } from './helpers'

/** 还原 v4 schema：无 node_outlines、无 status 列、无 writing_daily；project_notes CHECK 不含 outline。 */
const v4Schema = (): string => {
  let result = schema.replace(/CREATE TABLE IF NOT EXISTS node_outlines \([\s\S]*?\);\nCREATE INDEX IF NOT EXISTS idx_node_outlines_project ON node_outlines\(project_id\);\n/, '')
  result = result.replace("CHECK(section IN ('story','reference','outline'))", "CHECK(section IN ('story','reference'))")
  result = result.replace(/\n {2}status TEXT NOT NULL DEFAULT 'outline' CHECK\(status IN \('outline','draft','final'\)\),/, '')
  result = result.replace(/CREATE TABLE IF NOT EXISTS writing_daily \([\s\S]*?\);\nCREATE INDEX IF NOT EXISTS idx_writing_daily_project_date ON writing_daily\(project_id, date\);\n/, '')
  if (result.includes('node_outlines') || result.includes("'outline'") || result.includes('writing_daily') || /status TEXT NOT NULL DEFAULT 'outline'/.test(result)) {
    throw new Error('v4 schema fixture out of date')
  }
  return result
}

describe('S3 node_outlines migration (v4 → v5)', () => {
  const dirs: string[] = []
  afterEach(async () => { await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

  it('upgrades a v4 database, preserves old data and accepts outline notes', async () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(8)
    const dir = await mkdtemp(join(tmpdir(), 'inkstone-v4-outline-')); dirs.push(dir); const path = join(dir, 'v4.sqlite')
    const old = new DatabaseSync(path)
    old.exec(v4Schema())
    old.exec(`INSERT INTO projects(id,title,project_type,created_at,updated_at,last_opened_at) VALUES ('p1','旧书','webnovel',1,1,1);
      INSERT INTO document_nodes(id,project_id,parent_id,type,title,order_index,created_at,updated_at) VALUES ('v1','p1',NULL,'volume','第一卷',0,1,1);
      INSERT INTO document_nodes(id,project_id,parent_id,type,title,order_index,created_at,updated_at) VALUES ('c1','p1','v1','chapter','第一章',0,1,1);
      INSERT INTO document_contents(document_id,project_id,editor_json,plain_text,word_count,revision,updated_at) VALUES ('c1','p1','{"type":"doc"}','旧正文',3,2,1);
      INSERT INTO project_notes(id,project_id,section,title,content,created_at,updated_at) VALUES ('n1','p1','story','旧笔记','旧内容',1,2);
      INSERT INTO project_notes(id,project_id,section,title,content,created_at,updated_at) VALUES ('n2','p1','reference','旧资料','资料',1,3);
      INSERT INTO app_settings(key,value_json,updated_at) VALUES ('schema_version','4',1);`)
    expect(() => old.exec("INSERT INTO project_notes(id,project_id,section,title,content,created_at,updated_at) VALUES ('x','p1','outline','t','',1,1)")).toThrow()
    old.close()

    const db = new AppDatabase(path)
    expect(db.raw.prepare("SELECT value_json FROM app_settings WHERE key = 'schema_version'").get()).toEqual({ value_json: '8' })
    const content = new ProjectContentService(db)
    expect(content.listNotes('p1', 'story')).toMatchObject([{ id: 'n1', title: '旧笔记', content: '旧内容', createdAt: 1, updatedAt: 2 }])
    expect(content.listNotes('p1', 'reference')).toMatchObject([{ id: 'n2', title: '旧资料' }])
    expect(new DocumentService(db).getContent('p1', 'c1').plainText).toBe('旧正文')
    const outlineNote = content.saveNote({ projectId: 'p1', section: 'outline', title: '全书大纲', content: '主角从小镇出发' })
    expect(content.listNotes('p1', 'outline')).toEqual([outlineNote])
    expect(() => db.raw.prepare("INSERT INTO project_notes(id,project_id,section,title,content,created_at,updated_at) VALUES ('bad','p1','other','t','',1,1)").run()).toThrow()
    expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_notes_project_section'").get()).toBeTruthy()
    expect(db.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    const outline = new DocumentService(db).saveOutline({ projectId: 'p1', nodeId: 'c1', summary: '开篇', beats: ['相遇', '冲突'], hook: '门外有人' })
    expect(outline).toMatchObject({ nodeId: 'c1', beats: ['相遇', '冲突'], hook: '门外有人' })
    // 删除项目时级联删除笔记（重建后外键仍生效）
    db.raw.prepare("DELETE FROM projects WHERE id = 'p1'").run()
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM project_notes').get()).toEqual({ n: 0 })
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM node_outlines').get()).toEqual({ n: 0 })
    db.close()

    const reopened = new AppDatabase(path)
    expect(reopened.raw.prepare("SELECT value_json FROM app_settings WHERE key = 'schema_version'").get()).toEqual({ value_json: '8' })
    reopened.close()
  })

  it('fresh database is created at v5 with outline support', () => {
    const db = createTestDb()
    const sql = (db.raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'project_notes'").get() as { sql: string }).sql
    expect(sql).toContain("'outline'")
    expect(db.raw.prepare("SELECT value_json FROM app_settings WHERE key = 'schema_version'").get()).toEqual({ value_json: '8' })
    db.close()
  })
})

describe('S3 node_outlines service, isolation and backup', () => {
  it('saves volume summaries and chapter beats, rejects non volume/chapter nodes and partial updates keep fields', () => {
    const db = createTestDb(); const projects = new ProjectService(db); const docs = new DocumentService(db)
    const p = projects.create({ title: '细纲书', projectType: 'webnovel' })
    const volume = docs.listTree(p.id).find((node) => node.type === 'volume')!
    const chapter = docs.listOrderedChapters(p.id)[0]
    docs.saveOutline({ projectId: p.id, nodeId: volume.id, summary: '卷一：入门' })
    docs.saveOutline({ projectId: p.id, nodeId: chapter.id, summary: '初到宗门', beats: ['拜师', '测灵根'], hook: '灵根测出异象' })
    docs.saveOutline({ projectId: p.id, nodeId: chapter.id, hook: '新的钩子' })
    expect(docs.getOutline(p.id, chapter.id)).toMatchObject({ summary: '初到宗门', beats: ['拜师', '测灵根'], hook: '新的钩子' })
    expect(docs.listOutlines(p.id)).toHaveLength(2)
    const note = docs.createNode({ projectId: p.id, type: 'note', title: '杂记' })
    expect(() => docs.saveOutline({ projectId: p.id, nodeId: note.id, summary: 'x' })).toThrow('OUTLINE_NODE_TYPE_INVALID')
    docs.delete(p.id, chapter.id)
    expect(docs.getOutline(p.id, chapter.id)).toBeNull()
    db.close()
  })

  it('isolates outlines by projectId', () => {
    const db = createTestDb(); const projects = new ProjectService(db); const docs = new DocumentService(db)
    const a = projects.create({ title: 'A', projectType: 'novel' }); const b = projects.create({ title: 'B', projectType: 'novel' })
    const aChapter = docs.listOrderedChapters(a.id)[0]
    docs.saveOutline({ projectId: a.id, nodeId: aChapter.id, summary: 'A 的细纲' })
    expect(docs.getOutline(b.id, aChapter.id)).toBeNull()
    expect(docs.listOutlines(b.id)).toEqual([])
    expect(() => docs.saveOutline({ projectId: b.id, nodeId: aChapter.id, summary: '越权' })).toThrow('DOCUMENT_NOT_FOUND_IN_PROJECT')
    expect(docs.getOutline(a.id, aChapter.id)?.summary).toBe('A 的细纲')
    const content = new ProjectContentService(db)
    content.saveNote({ projectId: a.id, section: 'outline', title: 'A 大纲', content: '' })
    expect(content.listNotes(b.id, 'outline')).toEqual([])
    db.close()
  })

  it('round-trips outlines and outline notes through .aiwproj backup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inkstone-outline-backup-'))
    try {
      const db = createTestDb(); const projects = new ProjectService(db); const docs = new DocumentService(db)
      const content = new ProjectContentService(db); const backup = new BackupService(db)
      const p = projects.create({ title: '往返书', projectType: 'webnovel' })
      const volume = docs.listTree(p.id).find((node) => node.type === 'volume')!
      const chapter = docs.listOrderedChapters(p.id)[0]
      docs.saveOutline({ projectId: p.id, nodeId: volume.id, summary: '卷梗概' })
      docs.saveOutline({ projectId: p.id, nodeId: chapter.id, summary: '章梗概', beats: ['一', '二', '三'], hook: '悬念' })
      content.saveNote({ projectId: p.id, section: 'outline', title: '全书大纲', content: '核心冲突' })
      const file = join(dir, 'book.aiwproj')
      await backup.exportProject(p.id, file)
      const imported = await backup.importProject(file)
      const importedVolume = docs.listTree(imported.id).find((node) => node.type === 'volume')!
      const importedChapter = docs.listOrderedChapters(imported.id)[0]
      expect(importedChapter.id).not.toBe(chapter.id)
      expect(docs.getOutline(imported.id, importedVolume.id)).toMatchObject({ projectId: imported.id, summary: '卷梗概', beats: [], hook: '' })
      expect(docs.getOutline(imported.id, importedChapter.id)).toMatchObject({ projectId: imported.id, summary: '章梗概', beats: ['一', '二', '三'], hook: '悬念' })
      expect(content.listNotes(imported.id, 'outline')).toMatchObject([{ title: '全书大纲', content: '核心冲突' }])
      expect(docs.listOutlines(p.id)).toHaveLength(2)
      db.close()
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('rejects backups whose outlines reference unknown nodes, and still imports backups without outlines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inkstone-outline-bad-'))
    try {
      const db = createTestDb(); const projects = new ProjectService(db); const docs = new DocumentService(db); const backup = new BackupService(db)
      const p = projects.create({ title: '坏备份', projectType: 'novel' })
      docs.saveOutline({ projectId: p.id, nodeId: docs.listOrderedChapters(p.id)[0].id, summary: 's' })
      const file = join(dir, 'b.aiwproj'); await backup.exportProject(p.id, file)
      const { readFile, writeFile } = await import('node:fs/promises')
      const payload = JSON.parse(await readFile(file, 'utf8')) as { outlines?: Array<Record<string, unknown>> }
      const bad = structuredClone(payload); bad.outlines![0].node_id = 'missing'
      await writeFile(join(dir, 'bad.aiwproj'), JSON.stringify(bad))
      await expect(backup.importProject(join(dir, 'bad.aiwproj'))).rejects.toThrow('BACKUP_INVALID_OUTLINE_REFERENCE')
      const legacy = structuredClone(payload); delete legacy.outlines
      await writeFile(join(dir, 'legacy.aiwproj'), JSON.stringify(legacy))
      const imported = await backup.importProject(join(dir, 'legacy.aiwproj'))
      expect(docs.listOutlines(imported.id)).toEqual([])
      db.close()
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
