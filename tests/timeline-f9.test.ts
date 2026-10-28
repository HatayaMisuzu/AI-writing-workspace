import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppDatabase, CURRENT_SCHEMA_VERSION } from '../src/main/database/database'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { ProjectContentService } from '../src/main/services/project-content-service'
import { TimelineService } from '../src/main/services/timeline-service'
import { BackupService } from '../src/main/services/backup-service'
import { ContextEngine } from '../src/main/ai/context-engine'
import { timelineEventSaveSchema } from '../src/main/ipc/schemas'
import { sortTimelineEvents } from '../src/shared/timeline'
import type { TimelineEvent } from '../src/shared/domain'
import { createTestDb } from './helpers'

const ev = (id: string, sortKey: number, chapterId: string | null, createdAt = 0): TimelineEvent => ({
  id, projectId: 'p', storyTimeLabel: '', sortKey, title: id, chapterId, characterIds: [], createdAt, updatedAt: createdAt
})

const setup = (): { db: AppDatabase; projectId: string; c1: string; c2: string; c3: string; docs: DocumentService } => {
  const db = createTestDb()
  const project = new ProjectService(db).create({ title: '时间线书', projectType: 'novel' })
  const docs = new DocumentService(db)
  const first = docs.listOrderedChapters(project.id)[0]
  const c2 = docs.createNode({ projectId: project.id, parentId: first.parentId!, type: 'chapter', title: '第二章' })
  const c3 = docs.createNode({ projectId: project.id, parentId: first.parentId!, type: 'chapter', title: '第三章' })
  return { db, projectId: project.id, c1: first.id, c2: c2.id, c3: c3.id, docs }
}

describe('P1-1 F9 migration v10', () => {
  it('CURRENT is 10; fresh db has timeline_events', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(10)
    const db = createTestDb()
    expect(db.raw.prepare("SELECT value_json FROM app_settings WHERE key = 'schema_version'").get()).toEqual({ value_json: '10' })
    expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE name = 'timeline_events'").get()).toBeTruthy()
    db.close()
  })

  it('upgrades v9 → v10 and keeps old data', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inkstone-f9-mig-'))
    const path = join(dir, 'db.sqlite')
    try {
      const seed = new AppDatabase(path)
      const project = new ProjectService(seed).create({ title: '旧书', projectType: 'novel' })
      const chapter = new DocumentService(seed).listOrderedChapters(project.id)[0]
      new DocumentService(seed).saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc', content: [{ type: 'paragraph' }] }, plainText: '旧正文' })
      const character = new ProjectContentService(seed).saveCharacter({ projectId: project.id, name: '老角色' })
      seed.raw.exec('DROP TABLE timeline_events')
      seed.raw.prepare("UPDATE app_settings SET value_json = ? WHERE key = 'schema_version'").run(JSON.stringify(9))
      seed.close()
      const db = new AppDatabase(path)
      expect(db.raw.prepare("SELECT value_json FROM app_settings WHERE key = 'schema_version'").get()).toEqual({ value_json: '10' })
      expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE name = 'timeline_events'").get()).toBeTruthy()
      expect(new DocumentService(db).getContent(project.id, chapter.id).plainText).toBe('旧正文')
      expect(new ProjectContentService(db).listCharacters(project.id).map((item) => item.id)).toEqual([character.id])
      expect(new TimelineService(db).list(project.id)).toEqual([])
      new TimelineService(db).save({ projectId: project.id, sortKey: 1, title: '升级后事件', chapterId: chapter.id, characterIds: [character.id] })
      db.close()
      const reopened = new AppDatabase(path)
      expect(new TimelineService(reopened).list(project.id)).toHaveLength(1)
      reopened.close()
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

describe('P1-1 F9 sorting', () => {
  it('按故事时间：sort_key 升序，同键按章节顺序再按创建时间', () => {
    const events = [ev('a', 3, 'c1'), ev('b', 1, 'c3'), ev('c', 2, null), ev('d', 1, 'c2'), ev('e', 1, 'c2', 5)]
    expect(sortTimelineEvents(events, 'story', ['c1', 'c2', 'c3']).map((item) => item.id)).toEqual(['d', 'e', 'b', 'c', 'a'])
  })
  it('按章节顺序：章树顺序，未关联/已删章节排末尾，同章按 sort_key', () => {
    const events = [ev('a', 3, 'c1'), ev('b', 1, 'c3'), ev('c', 2, null), ev('d', 5, 'c1'), ev('x', 0, 'gone')]
    expect(sortTimelineEvents(events, 'chapter', ['c1', 'c2', 'c3']).map((item) => item.id)).toEqual(['a', 'd', 'b', 'x', 'c'])
  })
  it('service 两种排序随章树重排变化', () => {
    const { db, projectId, c1, c2, c3, docs } = setup()
    const timeline = new TimelineService(db)
    timeline.save({ projectId, sortKey: 30, title: '早章晚事', chapterId: c1 })
    timeline.save({ projectId, sortKey: 10, title: '晚章早事', chapterId: c3 })
    timeline.save({ projectId, sortKey: 20, title: '中', chapterId: c2 })
    expect(timeline.list(projectId, 'story').map((item) => item.title)).toEqual(['晚章早事', '中', '早章晚事'])
    expect(timeline.list(projectId, 'chapter').map((item) => item.title)).toEqual(['早章晚事', '中', '晚章早事'])
    const parentId = docs.listOrderedChapters(projectId)[0].parentId!
    docs.reorder(projectId, c3, parentId, 0)
    expect(timeline.list(projectId, 'chapter').map((item) => item.title)).toEqual(['晚章早事', '早章晚事', '中'])
    db.close()
  })
})

describe('P1-1 F9 links, isolation, deletion', () => {
  it('章节/人物侧可查到相关事件（双向跳转数据）', () => {
    const { db, projectId, c1, c2 } = setup()
    const lin = new ProjectContentService(db).saveCharacter({ projectId, name: '林' })
    const timeline = new TimelineService(db)
    const event = timeline.save({ projectId, storyTimeLabel: '三年前', sortKey: 1, title: '相遇', chapterId: c2, characterIds: [lin.id, lin.id] })
    expect(event.characterIds).toEqual([lin.id])
    expect(timeline.listForChapter(projectId, c2).map((item) => item.id)).toEqual([event.id])
    expect(timeline.listForChapter(projectId, c1)).toEqual([])
    expect(timeline.listForCharacter(projectId, lin.id).map((item) => item.id)).toEqual([event.id])
    db.close()
  })

  it('projectId 隔离：不能读写/关联其他项目的事件、章节、人物', () => {
    const { db, projectId, c1 } = setup()
    const other = new ProjectService(db).create({ title: '别的书', projectType: 'novel' })
    const otherChapter = new DocumentService(db).listOrderedChapters(other.id)[0]
    const otherChar = new ProjectContentService(db).saveCharacter({ projectId: other.id, name: '外人' })
    const timeline = new TimelineService(db)
    const mine = timeline.save({ projectId, sortKey: 1, title: '我的', chapterId: c1 })
    expect(timeline.list(other.id)).toEqual([])
    expect(() => timeline.save({ projectId, sortKey: 1, title: 'x', chapterId: otherChapter.id })).toThrow(/TIMELINE_CHAPTER_NOT_IN_PROJECT/)
    expect(() => timeline.save({ projectId, sortKey: 1, title: 'x', characterIds: [otherChar.id] })).toThrow(/TIMELINE_CHARACTER_NOT_IN_PROJECT/)
    expect(() => timeline.save({ id: mine.id, projectId: other.id, sortKey: 9, title: '篡改' })).toThrow(/TIMELINE_EVENT_NOT_FOUND_IN_PROJECT/)
    expect(() => timeline.delete(other.id, mine.id)).toThrow(/TIMELINE_EVENT_NOT_FOUND_IN_PROJECT/)
    expect(timeline.list(projectId)[0].title).toBe('我的')
    db.close()
  })

  it('章节删除 → chapter_id 置空；人物删除 → 从 character_ids 移除', () => {
    const { db, projectId, c2 } = setup()
    const content = new ProjectContentService(db)
    const a = content.saveCharacter({ projectId, name: '甲' })
    const b = content.saveCharacter({ projectId, name: '乙' })
    const timeline = new TimelineService(db)
    const event = timeline.save({ projectId, sortKey: 1, title: '事件', chapterId: c2, characterIds: [a.id, b.id] })
    new DocumentService(db).delete(projectId, c2)
    content.deleteCharacter(projectId, a.id)
    const [after] = timeline.list(projectId)
    expect(after.id).toBe(event.id)
    expect(after.chapterId).toBeNull()
    expect(after.characterIds).toEqual([b.id])
    expect(timeline.listForCharacter(projectId, a.id)).toEqual([])
    db.close()
  })
})

describe('P1-1 F9 backup & boundaries', () => {
  it('备份往返：事件、章节/人物关联随 id 重映射', async () => {
    const { db, projectId, c2 } = setup()
    const lin = new ProjectContentService(db).saveCharacter({ projectId, name: '林' })
    new TimelineService(db).save({ projectId, storyTimeLabel: '永和三年', sortKey: 2.5, title: '雨夜', chapterId: c2, characterIds: [lin.id] })
    new TimelineService(db).save({ projectId, sortKey: 1, title: '无关联' })
    const dir = await mkdtemp(join(tmpdir(), 'inkstone-f9-bak-'))
    const path = join(dir, 'b.aiwproj')
    try {
      const backup = new BackupService(db)
      await backup.exportProject(projectId, path)
      const payload = JSON.parse(await readFile(path, 'utf8')) as { timelineEvents: unknown[] }
      expect(payload.timelineEvents).toHaveLength(2)
      const imported = await backup.importProject(path)
      const events = new TimelineService(db).list(imported.id, 'story')
      expect(events.map((item) => item.title)).toEqual(['无关联', '雨夜'])
      const rain = events[1]
      const importedChapters = new DocumentService(db).listOrderedChapters(imported.id)
      expect(rain.chapterId).toBe(importedChapters.find((item) => item.title === '第二章')!.id)
      expect(rain.characterIds).toEqual([new ProjectContentService(db).listCharacters(imported.id)[0].id])
      expect(rain.storyTimeLabel).toBe('永和三年'); expect(rain.sortKey).toBe(2.5)
      expect(new TimelineService(db).list(projectId)).toHaveLength(2)

      // 旧备份（无 timelineEvents 字段）仍可导入
      const legacy = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      delete legacy.timelineEvents
      await writeFile(path, JSON.stringify(legacy))
      const legacyImported = await backup.importProject(path)
      expect(new TimelineService(db).list(legacyImported.id)).toEqual([])

      // 非法事件被拒绝
      await writeFile(path, JSON.stringify({ ...legacy, timelineEvents: [{ id: 'x', title: 't', sort_key: 'NaN', character_ids_json: '[]' }] }))
      await expect(backup.importProject(path)).rejects.toThrow(/BACKUP_INVALID_TIMELINE_SORT_KEY/)
    } finally { await rm(dir, { recursive: true, force: true }) }
    db.close()
  })

  it('IPC zod 校验拒绝非法输入', () => {
    expect(timelineEventSaveSchema.safeParse({ projectId: 'p', sortKey: 1, title: 't' }).success).toBe(true)
    expect(timelineEventSaveSchema.safeParse({ projectId: 'p', sortKey: Number.POSITIVE_INFINITY, title: 't' }).success).toBe(false)
    expect(timelineEventSaveSchema.safeParse({ projectId: 'p', sortKey: '1', title: 't' }).success).toBe(false)
    expect(timelineEventSaveSchema.safeParse({ projectId: 'p', sortKey: 1, title: 't', extra: 1 }).success).toBe(false)
  })

  it('时间线不进 AI 上下文', () => {
    const { db, projectId, c1 } = setup()
    new TimelineService(db).save({ projectId, sortKey: 1, title: '密谋红伞刺杀', chapterId: c1 })
    const bundle = new ContextEngine(db).build({ projectId, mode: 'discussion', writePermission: 'none', userIntent: '红伞 刺杀', documentId: c1 })
    expect(JSON.stringify(bundle)).not.toContain('密谋红伞刺杀')
    db.close()
  })
})
