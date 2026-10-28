import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppDatabase, CURRENT_SCHEMA_VERSION } from '../src/main/database/database'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { ProjectContentService } from '../src/main/services/project-content-service'
import { MemoryService } from '../src/main/services/memory-service'
import { ForeshadowService } from '../src/main/services/foreshadow-service'
import { BackupService } from '../src/main/services/backup-service'
import { ChapterDigestService } from '../src/main/ai/chapter-digest-service'
import { ContextEngine } from '../src/main/ai/context-engine'
import { isForeshadowOverdue } from '../src/shared/foreshadow'
import { normalizeCharacterFields, mergeCharacterFields } from '../src/shared/character-fields'
import { CHARACTER_FIELD_KEYS } from '../src/shared/domain'
import { createTestDb } from './helpers'

const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] }

describe('S12 migration v9', () => {
  it('CURRENT is 9; creates foreshadow_meta', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(9)
    const db = createTestDb()
    expect(db.raw.prepare("SELECT value_json FROM app_settings WHERE key = 'schema_version'").get()).toEqual({ value_json: '9' })
    expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE name = 'foreshadow_meta'").get()).toBeTruthy()
    db.close()
  })

  it('upgrades v8 → v9 without touching character fields defaults', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inkstone-s12-mig-'))
    const path = join(dir, 'db.sqlite')
    try {
      const seed = new AppDatabase(path)
      expect(seed.raw.prepare("SELECT value_json FROM app_settings WHERE key = 'schema_version'").get()).toEqual({ value_json: '9' })
      seed.raw.exec('DROP TABLE IF EXISTS foreshadow_meta')
      seed.raw.prepare("UPDATE app_settings SET value_json = ? WHERE key = 'schema_version'").run(JSON.stringify(8))
      seed.close()
      const db = new AppDatabase(path)
      expect(db.raw.prepare("SELECT value_json FROM app_settings WHERE key = 'schema_version'").get()).toEqual({ value_json: '9' })
      expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE name = 'foreshadow_meta'").get()).toBeTruthy()
      db.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('S12 F8 伏笔 · §3.4 ①②③④', () => {
  it('① 选区登记：埋设章与选区位置正确', () => {
    const db = createTestDb()
    const project = new ProjectService(db).create({ title: '伏笔书', projectType: 'webnovel' })
    const docs = new DocumentService(db)
    const chapter = docs.listOrderedChapters(project.id)[0]
    docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: emptyDoc, plainText: '门后藏着红伞。' })
    const foreshadows = new ForeshadowService(db)
    const entry = foreshadows.registerFromSelection({
      projectId: project.id,
      chapterId: chapter.id,
      name: '红伞',
      content: '门后藏着红伞',
      fromPm: 3,
      toPm: 9
    })
    expect(entry.memory.type).toBe('foreshadowing')
    expect(entry.memory.status).toBe('confirmed')
    expect(entry.memory.sourceId).toBe(chapter.id)
    expect(entry.selectionFrom).toBe(3)
    expect(entry.selectionTo).toBe(9)
    expect(entry.name).toBe('红伞')
    expect(entry.meta.state).toBe('planted')
    expect(foreshadows.listLedger(project.id)).toHaveLength(1)
    db.close()
  })

  it('② 状态流转；放弃原因必填', () => {
    const db = createTestDb()
    const project = new ProjectService(db).create({ title: '流转', projectType: 'novel' })
    const chapter = new DocumentService(db).listOrderedChapters(project.id)[0]
    const foreshadows = new ForeshadowService(db)
    const entry = foreshadows.registerFromSelection({
      projectId: project.id, chapterId: chapter.id, content: '暗号是三下敲击', fromPm: 0, toPm: 7
    })
    expect(() => foreshadows.setState(project.id, entry.memory.id, 'abandoned')).toThrow(/FORESHADOW_ABANDON_REASON_REQUIRED/)
    expect(() => foreshadows.setState(project.id, entry.memory.id, 'abandoned', { abandonReason: '   ' }))
      .toThrow(/FORESHADOW_ABANDON_REASON_REQUIRED/)
    const hinting = foreshadows.setState(project.id, entry.memory.id, 'hinting')
    expect(hinting.meta.state).toBe('hinting')
    const resolved = foreshadows.setState(project.id, entry.memory.id, 'resolved', { resolvedChapterId: chapter.id })
    expect(resolved.meta.state).toBe('resolved')
    expect(resolved.meta.resolvedChapterId).toBe(chapter.id)
    const abandoned = foreshadows.setState(project.id, entry.memory.id, 'abandoned', { abandonReason: '改大纲删线' })
    expect(abandoned.meta.state).toBe('abandoned')
    expect(abandoned.meta.abandonReason).toBe('改大纲删线')
    db.close()
  })

  it('③ 逾期判定：最后有正文章序号超过计划回收章且未回收', () => {
    // 纯函数
    expect(isForeshadowOverdue({
      state: 'planted',
      plannedChapterId: 'c2',
      chapterIdsOrdered: ['c1', 'c2', 'c3'],
      chapterIdsWithBody: ['c1', 'c3']
    })).toBe(true)
    expect(isForeshadowOverdue({
      state: 'resolved',
      plannedChapterId: 'c2',
      chapterIdsOrdered: ['c1', 'c2', 'c3'],
      chapterIdsWithBody: ['c1', 'c3']
    })).toBe(false)
    expect(isForeshadowOverdue({
      state: 'planted',
      plannedChapterId: 'c3',
      chapterIdsOrdered: ['c1', 'c2', 'c3'],
      chapterIdsWithBody: ['c1', 'c2']
    })).toBe(false) // 最后有正文是 c2，未超过 c3

    const db = createTestDb()
    const project = new ProjectService(db).create({ title: '逾期', projectType: 'webnovel' })
    const docs = new DocumentService(db)
    const c1 = docs.listOrderedChapters(project.id)[0]
    docs.saveContent({ projectId: project.id, documentId: c1.id, editorJson: emptyDoc, plainText: '一' })
    const c2 = docs.createNode({ projectId: project.id, parentId: c1.parentId!, type: 'chapter', title: '第二章' })
    const c3 = docs.createNode({ projectId: project.id, parentId: c1.parentId!, type: 'chapter', title: '第三章' })
    docs.saveContent({ projectId: project.id, documentId: c3.id, editorJson: emptyDoc, plainText: '三章正文' })
    const foreshadows = new ForeshadowService(db)
    const entry = foreshadows.registerFromSelection({
      projectId: project.id, chapterId: c1.id, content: '计划二章回收', fromPm: 0, toPm: 5,
      plannedChapterId: c2.id
    })
    expect(foreshadows.evaluateOverdue(project.id, entry.memory.id)).toBe(true)
    const ledger = foreshadows.listLedger(project.id)
    expect(ledger[0].overdue).toBe(true)
    foreshadows.setState(project.id, entry.memory.id, 'resolved', { resolvedChapterId: c3.id })
    expect(foreshadows.evaluateOverdue(project.id, entry.memory.id)).toBe(false)
    db.close()
  })

  it('④ 待确认 AI 伏笔不进已确认列表、不进 AI 上下文', () => {
    const db = createTestDb()
    const project = new ProjectService(db).create({ title: '候选', projectType: 'novel' })
    const docs = new DocumentService(db)
    const chapter = docs.listOrderedChapters(project.id)[0]
    docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: emptyDoc, plainText: '雨夜有人撑红伞走过巷口。' })
    const digest = new ChapterDigestService(db)
    const raw = JSON.stringify({
      summary: '巷口出现红伞',
      events: [],
      characterChanges: [],
      reveals: [],
      openQuestions: [],
      memoryCandidates: [{ type: 'foreshadowing', content: '红伞可能是信号', confidence: 0.8 }],
      possibleContradictions: []
    })
    digest.storeFromModel(project.id, chapter.id, raw)
    const foreshadows = new ForeshadowService(db)
    expect(foreshadows.listLedger(project.id)).toHaveLength(0)
    const pending = foreshadows.listPending(project.id)
    expect(pending).toHaveLength(1)
    expect(pending[0].memory.status).toBe('suggested')

    const memories = new MemoryService(db)
    const suggested = memories.list(project.id, ['suggested']).filter((item) => item.type === 'foreshadowing')
    expect(suggested).toHaveLength(1)
    expect(memories.list(project.id, ['confirmed']).filter((item) => item.type === 'foreshadowing')).toHaveLength(0)

    const bundle = new ContextEngine(db).build({
      projectId: project.id,
      mode: 'discussion',
      writePermission: 'none',
      userIntent: '红伞 信号',
      documentId: chapter.id
    })
    const memorySources = bundle.items.filter((source) => source.kind === 'memory')
    expect(memorySources.every((source) => !source.content.includes('红伞可能是信号'))).toBe(true)
    expect(memorySources.every((source) => source.id !== suggested[0].id)).toBe(true)
    db.close()
  })
})

describe('S12 F4 人物卡固定字段', () => {
  it('读写固定字段；备份往返保留', async () => {
    expect(normalizeCharacterFields(undefined)).toEqual({
      identity: '', appearance: '', personality: '', goal: '', firstAppearanceChapter: '', currentState: ''
    })
    expect(mergeCharacterFields({ identity: '捕快' }, { appearance: '瘦高' }).identity).toBe('捕快')
    expect(CHARACTER_FIELD_KEYS).toHaveLength(6)

    const db = createTestDb()
    const project = new ProjectService(db).create({ title: '人物书', projectType: 'novel' })
    const content = new ProjectContentService(db)
    const saved = content.saveCharacter({
      projectId: project.id,
      name: '林舟',
      aliases: ['小舟'],
      notes: '自由笔记',
      fields: {
        identity: '书商',
        appearance: '青衫',
        personality: '沉稳',
        goal: '查明旧案',
        firstAppearanceChapter: '第一章',
        currentState: '在逃'
      }
    })
    expect(saved.fields).toMatchObject({
      identity: '书商', appearance: '青衫', personality: '沉稳',
      goal: '查明旧案', firstAppearanceChapter: '第一章', currentState: '在逃'
    })
    // 固定键始终在；额外键可保留（兼容扩展），局部更新不抹掉未传固定键
    const again = content.saveCharacter({
      id: saved.id, projectId: project.id, name: '林舟',
      fields: { identity: '书商', extraJunk: 'keep' } as Record<string, string>
    })
    expect(again.fields.extraJunk).toBe('keep')
    expect(again.fields.identity).toBe('书商')
    expect(again.fields.currentState).toBe('在逃')

    const dir = await mkdtemp(join(tmpdir(), 'inkstone-s12-char-'))
    const path = join(dir, 'b.aiwproj')
    try {
      const backup = new BackupService(db)
      await backup.exportProject(project.id, path)
      const payload = JSON.parse(await readFile(path, 'utf8')) as {
        characters: Array<{ name: string; fields_json: string }>
        foreshadowMeta?: unknown[]
      }
      const fields = JSON.parse(payload.characters.find((row) => row.name === '林舟')!.fields_json) as Record<string, string>
      expect(fields.identity).toBe('书商')
      expect(fields.currentState).toBe('在逃')

      // 一并验证伏笔 meta 往返
      const chapter = new DocumentService(db).listOrderedChapters(project.id)[0]
      const foreshadows = new ForeshadowService(db)
      foreshadows.registerFromSelection({
        projectId: project.id, chapterId: chapter.id, name: '旧案卷宗', content: '卷宗在井底', fromPm: 1, toPm: 6,
        characterIds: [saved.id]
      })
      await backup.exportProject(project.id, path)
      const withFs = JSON.parse(await readFile(path, 'utf8')) as { foreshadowMeta: Array<Record<string, unknown>> }
      expect(withFs.foreshadowMeta.length).toBe(1)
      const imported = await backup.importProject(path)
      const importedChars = new ProjectContentService(db).listCharacters(imported.id)
      const importedLin = importedChars.find((item) => item.name === '林舟')!
      expect(importedLin.fields.identity).toBe('书商')
      expect(importedLin.fields.currentState).toBe('在逃')
      const importedLedger = new ForeshadowService(db).listLedger(imported.id)
      expect(importedLedger).toHaveLength(1)
      expect(importedLedger[0].name).toBe('旧案卷宗')
      expect(importedLedger[0].meta.characterIds).toEqual([importedLin.id])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
    db.close()
  })
})
