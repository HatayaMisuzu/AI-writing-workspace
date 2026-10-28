import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppDatabase, CURRENT_SCHEMA_VERSION } from '../src/main/database/database'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService, countChineseWords } from '../src/main/services/document-service'
import { PatchService } from '../src/main/services/patch-service'
import { BackupService } from '../src/main/services/backup-service'
import { WritingDailyService, localDateKey } from '../src/main/services/writing-daily-service'
import { createTestDb } from './helpers'

const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] }

describe('S9 writing_daily migration (v6 → v7)', () => {
  const dirs: string[] = []
  afterEach(async () => { await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

  it('⑤ upgrades a v6 database, creates writing_daily, does not preset any goals', async () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(8)
    const dir = await mkdtemp(join(tmpdir(), 'inkstone-v6-s9-')); dirs.push(dir)
    const path = join(dir, 'v6.sqlite')

    // Seed a fresh DB then rewind schema_version to 6 and drop writing_daily to simulate pre-S9.
    const seed = new AppDatabase(path)
    const project = new ProjectService(seed).create({ title: '旧书无目标', projectType: 'webnovel' })
    const settingsBefore = seed.raw.prepare('SELECT settings_json FROM projects WHERE id = ?').get(project.id) as { settings_json: string }
    expect(settingsBefore.settings_json).toBe('{}')
    seed.raw.exec('DROP TABLE IF EXISTS writing_daily')
    seed.raw.prepare("UPDATE app_settings SET value_json = ? WHERE key = 'schema_version'")
      .run(JSON.stringify(6))
    seed.close()

    const db = new AppDatabase(path)
    expect(db.raw.prepare("SELECT value_json FROM app_settings WHERE key = 'schema_version'").get()).toEqual({ value_json: '8' })
    expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='writing_daily'").get()).toBeTruthy()
    expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_writing_daily_project_date'").get()).toBeTruthy()

    // ⑥ 迁移后旧项目：目标字段为空且未启用；settings 无任何默认目标数字
    const settingsAfter = db.raw.prepare('SELECT settings_json FROM projects WHERE id = ?').get(project.id) as { settings_json: string }
    expect(settingsAfter.settings_json).toBe('{}')
    const goals = new WritingDailyService(db).getGoals(project.id)
    expect(goals).toEqual({
      dailyWordGoalEnabled: false,
      dailyWordGoal: null,
      dailyChapterGoalEnabled: false,
      dailyChapterGoal: null
    })
    expect(JSON.stringify(goals)).not.toMatch(/\d{3,}/) // 无预置目标数字
    expect(db.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    db.close()
  })

  it('fresh database is at v7 with writing_daily and empty goals on create', () => {
    const db = createTestDb()
    expect(db.raw.prepare("SELECT value_json FROM app_settings WHERE key = 'schema_version'").get()).toEqual({ value_json: '8' })
    expect(db.raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'writing_daily'").get()).toBeTruthy()
    const project = new ProjectService(db).create({ title: '新书', projectType: 'novel' })
    const raw = db.raw.prepare('SELECT settings_json FROM projects WHERE id = ?').get(project.id) as { settings_json: string }
    expect(raw.settings_json).toBe('{}')
    // ⑥ 新建项目：目标空且未启用
    expect(new WritingDailyService(db).getGoals(project.id)).toEqual({
      dailyWordGoalEnabled: false,
      dailyWordGoal: null,
      dailyChapterGoalEnabled: false,
      dailyChapterGoal: null
    })
    db.close()
  })
})

describe('S9 writing_daily stats accounting (§3.2 ①–④)', () => {
  it('① human net words accumulate; local midnight splits days', () => {
    const db = createTestDb()
    let now = new Date(2026, 2, 1, 23, 50, 0) // local Mar 1 23:50
    const daily = new WritingDailyService(db, () => now)
    const projects = new ProjectService(db)
    const docs = new DocumentService(db, daily)
    const p = projects.create({ title: '跨午夜', projectType: 'webnovel' })
    const chapter = docs.listOrderedChapters(p.id)[0]

    const day1Text = '今天写了一百个汉字的正文内容用来测试码字统计功能是否按人工净增累计啊啊'
    expect(countChineseWords(day1Text)).toBeGreaterThan(20)
    docs.saveContent({ projectId: p.id, documentId: chapter.id, editorJson: emptyDoc, plainText: day1Text })
    const d1 = daily.getDay(p.id)
    expect(d1.date).toBe(localDateKey(now))
    expect(d1.humanWordsAdded).toBe(countChineseWords(day1Text))
    expect(d1.humanWordsDeleted).toBe(0)
    expect(d1.humanWordsNetDisplay).toBe(countChineseWords(day1Text))
    expect(d1.aiWordsAccepted).toBe(0)

    now = new Date(2026, 2, 2, 0, 10, 0) // local Mar 2 00:10
    const day2Extra = '跨过午夜后又写了若干汉字继续码字'
    const combined = day1Text + day2Extra
    docs.saveContent({ projectId: p.id, documentId: chapter.id, editorJson: emptyDoc, plainText: combined })
    const d2 = daily.getDay(p.id)
    expect(d2.date).toBe(localDateKey(now))
    expect(d2.date).not.toBe(localDateKey(new Date(2026, 2, 1, 23, 50, 0)))
    expect(d2.humanWordsAdded).toBe(countChineseWords(day2Extra))
    expect(d2.aiWordsAccepted).toBe(0)
    // 前日不变
    expect(daily.getDay(p.id, localDateKey(new Date(2026, 2, 1, 12, 0, 0))).humanWordsAdded).toBe(countChineseWords(day1Text))
    db.close()
  })

  it('② accepting AI patch adds ai_words only; human words unchanged', () => {
    const db = createTestDb()
    const daily = new WritingDailyService(db)
    const projects = new ProjectService(db)
    const docs = new DocumentService(db, daily)
    const patches = new PatchService(db, daily)
    const p = projects.create({ title: 'AI字数', projectType: 'webnovel' })
    const chapter = docs.listOrderedChapters(p.id)[0]

    const human = '作者自己写的开篇若干汉字作为基底文本'
    docs.saveContent({ projectId: p.id, documentId: chapter.id, editorJson: emptyDoc, plainText: human })
    const before = daily.getDay(p.id)
    expect(before.humanWordsAdded).toBe(countChineseWords(human))
    expect(before.aiWordsAccepted).toBe(0)

    const aiText = '甲'.repeat(500) // 500 汉字
    expect(countChineseWords(aiText)).toBe(500)
    const rev = docs.getContent(p.id, chapter.id).revision
    const patch = patches.propose({
      projectId: p.id, documentId: chapter.id, documentRevision: rev,
      fromPm: 0, toPm: 0, originalText: '', replacement: aiText
    })
    patches.prepare(p.id, patch.id, rev, '')
    // 模拟采纳保存：styleSample.origin=ai → 不计入人工码字
    const afterAiSave = docs.saveContent({
      projectId: p.id, documentId: chapter.id, editorJson: emptyDoc,
      plainText: human + aiText,
      styleSample: { origin: 'ai', text: aiText }
    })
    patches.complete(p.id, patch.id, afterAiSave.revision)

    const after = daily.getDay(p.id)
    expect(after.humanWordsAdded).toBe(before.humanWordsAdded) // 码字不变
    expect(after.aiWordsAccepted).toBe(500)
    db.close()
  })

  it('③ undo (restore ai_edit snapshot) rolls back AI words', () => {
    const db = createTestDb()
    const daily = new WritingDailyService(db)
    const projects = new ProjectService(db)
    const docs = new DocumentService(db, daily)
    const patches = new PatchService(db, daily)
    const p = projects.create({ title: '撤销AI', projectType: 'webnovel' })
    const chapter = docs.listOrderedChapters(p.id)[0]
    const human = '基底正文汉字若干'
    docs.saveContent({ projectId: p.id, documentId: chapter.id, editorJson: emptyDoc, plainText: human })

    const aiText = '乙'.repeat(120)
    const rev = docs.getContent(p.id, chapter.id).revision
    const patch = patches.propose({
      projectId: p.id, documentId: chapter.id, documentRevision: rev,
      fromPm: 0, toPm: 0, originalText: '', replacement: aiText
    })
    patches.prepare(p.id, patch.id, rev, '')
    const snap = docs.listSnapshots(p.id, chapter.id).find((s) => s.reason === 'ai_edit')!
    expect(snap.metadata.patchId).toBe(patch.id)
    const saved = docs.saveContent({
      projectId: p.id, documentId: chapter.id, editorJson: emptyDoc,
      plainText: human + aiText, styleSample: { origin: 'ai', text: aiText }
    })
    patches.complete(p.id, patch.id, saved.revision)
    expect(daily.getDay(p.id).aiWordsAccepted).toBe(120)

    docs.restoreSnapshot(p.id, snap.id)
    expect(daily.getDay(p.id).aiWordsAccepted).toBe(0)
    expect(daily.getDay(p.id).humanWordsAdded).toBe(countChineseWords(human)) // 恢复不误伤码字
    expect(docs.getContent(p.id, chapter.id).plainText).toBe(human)
    db.close()
  })

  it('④ negative net displays as 0; deletions kept separately', () => {
    const db = createTestDb()
    const daily = new WritingDailyService(db)
    const projects = new ProjectService(db)
    const docs = new DocumentService(db, daily)
    const p = projects.create({ title: '删字', projectType: 'novel' })
    const chapter = docs.listOrderedChapters(p.id)[0]
    const longText = '丙'.repeat(100)
    docs.saveContent({ projectId: p.id, documentId: chapter.id, editorJson: emptyDoc, plainText: longText })
    docs.saveContent({ projectId: p.id, documentId: chapter.id, editorJson: emptyDoc, plainText: '丙'.repeat(30) })
    const day = daily.getDay(p.id)
    expect(day.humanWordsAdded).toBe(100)
    expect(day.humanWordsDeleted).toBe(70)
    expect(day.humanWordsNetDisplay).toBe(30) // 100-70
    // 继续删到净增为负
    docs.saveContent({ projectId: p.id, documentId: chapter.id, editorJson: emptyDoc, plainText: '' })
    const day2 = daily.getDay(p.id)
    expect(day2.humanWordsAdded).toBe(100)
    expect(day2.humanWordsDeleted).toBe(100)
    expect(day2.humanWordsNetDisplay).toBe(0) // 负值显示 0
    db.close()
  })

  it('project isolation: stats do not leak across projects', () => {
    const db = createTestDb()
    const daily = new WritingDailyService(db)
    const projects = new ProjectService(db)
    const docs = new DocumentService(db, daily)
    const a = projects.create({ title: '甲书', projectType: 'novel' })
    const b = projects.create({ title: '乙书', projectType: 'novel' })
    const ca = docs.listOrderedChapters(a.id)[0]
    const cb = docs.listOrderedChapters(b.id)[0]
    docs.saveContent({ projectId: a.id, documentId: ca.id, editorJson: emptyDoc, plainText: '丁'.repeat(40) })
    docs.saveContent({ projectId: b.id, documentId: cb.id, editorJson: emptyDoc, plainText: '戊'.repeat(15) })
    expect(daily.getDay(a.id).humanWordsAdded).toBe(40)
    expect(daily.getDay(b.id).humanWordsAdded).toBe(15)
    db.raw.prepare('DELETE FROM projects WHERE id = ?').run(a.id)
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM writing_daily WHERE project_id = ?').get(a.id)).toEqual({ n: 0 })
    expect(daily.getDay(b.id).humanWordsAdded).toBe(15)
    db.close()
  })
})

describe('S9 writing goals — empty/disabled by default; reject 0/negative (§3.2 ⑥⑨)', () => {
  it('⑥ new project goals are empty and disabled; settings_json has no preset goal values', () => {
    const db = createTestDb()
    const p = new ProjectService(db).create({ title: '无目标书', projectType: 'webnovel' })
    const raw = db.raw.prepare('SELECT settings_json FROM projects WHERE id = ?').get(p.id) as { settings_json: string }
    expect(raw.settings_json).toBe('{}')
    const parsed = JSON.parse(raw.settings_json) as Record<string, unknown>
    expect(parsed).toEqual({})
    expect(parsed).not.toHaveProperty('dailyWordGoal')
    expect(parsed).not.toHaveProperty('dailyWordGoalEnabled')
    expect(parsed).not.toHaveProperty('dailyChapterGoal')
    expect(parsed).not.toHaveProperty('dailyChapterGoalEnabled')
    // 不得含常见预置数字（如 2000/3000/4000）
    expect(raw.settings_json).not.toMatch(/2000|3000|4000|1000/)

    const goals = new WritingDailyService(db).getGoals(p.id)
    expect(goals.dailyWordGoalEnabled).toBe(false)
    expect(goals.dailyWordGoal).toBeNull()
    expect(goals.dailyChapterGoalEnabled).toBe(false)
    expect(goals.dailyChapterGoal).toBeNull()
    db.close()
  })

  it('⑨ rejects 0 and negative goal values; accepts positive integers only', () => {
    const db = createTestDb()
    const daily = new WritingDailyService(db)
    const p = new ProjectService(db).create({ title: '校验目标', projectType: 'novel' })

    expect(() => daily.setGoals(p.id, { dailyWordGoal: 0 })).toThrow(/WRITING_GOAL_INVALID/)
    expect(() => daily.setGoals(p.id, { dailyWordGoal: -1 })).toThrow(/WRITING_GOAL_INVALID/)
    expect(() => daily.setGoals(p.id, { dailyChapterGoal: 0 })).toThrow(/WRITING_GOAL_INVALID/)
    expect(() => daily.setGoals(p.id, { dailyChapterGoal: -5 })).toThrow(/WRITING_GOAL_INVALID/)
    expect(() => daily.setGoals(p.id, { dailyWordGoalEnabled: true })).toThrow(/WRITING_GOAL_INVALID/) // 开启但无正整数

    // 拒绝后 settings 仍为空，未写入默认值
    expect(JSON.parse((db.raw.prepare('SELECT settings_json FROM projects WHERE id = ?').get(p.id) as { settings_json: string }).settings_json)).toEqual({})

    const ok = daily.setGoals(p.id, { dailyWordGoal: 3000, dailyWordGoalEnabled: true })
    expect(ok).toEqual({
      dailyWordGoalEnabled: true,
      dailyWordGoal: 3000,
      dailyChapterGoalEnabled: false,
      dailyChapterGoal: null
    })
    // 关闭后统计不受影响；不预置其它目标
    const closed = daily.setGoals(p.id, { dailyWordGoalEnabled: false })
    expect(closed.dailyWordGoalEnabled).toBe(false)
    expect(closed.dailyWordGoal).toBe(3000) // 值保留但未启用
    const stored = JSON.parse((db.raw.prepare('SELECT settings_json FROM projects WHERE id = ?').get(p.id) as { settings_json: string }).settings_json) as Record<string, unknown>
    expect(stored.dailyWordGoalEnabled).toBeUndefined()
    expect(stored.dailyWordGoal).toBe(3000)
    expect(stored.dailyChapterGoal).toBeUndefined()
    db.close()
  })

  it('data layer contains no default goal constants in service source', async () => {
    // 防守：实现文件不得出现把 2000/3000/4000 等当作默认目标写入的字面量赋值模式
    const src = await readFile(new URL('../src/main/services/writing-daily-service.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/dailyWordGoal\s*[:=]\s*(2000|3000|4000|1000)/)
    expect(src).not.toMatch(/dailyChapterGoal\s*[:=]\s*[1-9]/)
    expect(src).toMatch(/空且未启用|不预置|不得写回成默认/)
  })
})

describe('S9 writing_daily backup round-trip', () => {
  const dirs: string[] = []
  afterEach(async () => { await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

  it('exports and imports writing_daily rows; goals stay author-owned in settings_json', async () => {
    const db = createTestDb()
    const daily = new WritingDailyService(db)
    const projects = new ProjectService(db)
    const docs = new DocumentService(db, daily)
    const backup = new BackupService(db)
    const p = projects.create({ title: '备份日更', projectType: 'webnovel' })
    const chapter = docs.listOrderedChapters(p.id)[0]
    docs.saveContent({ projectId: p.id, documentId: chapter.id, editorJson: emptyDoc, plainText: '己'.repeat(50) })
    daily.setGoals(p.id, { dailyWordGoal: 2500, dailyWordGoalEnabled: true })

    const dir = await mkdtemp(join(tmpdir(), 'inkstone-s9-bak-')); dirs.push(dir)
    const path = join(dir, 'backup.json')
    await backup.exportProject(p.id, path)
    const payload = JSON.parse(await readFile(path, 'utf8')) as {
      writingDaily?: Array<Record<string, unknown>>
      project: { settings_json: string }
    }
    expect(payload.writingDaily?.length).toBe(1)
    expect(payload.writingDaily![0].human_words_added).toBe(50)
    const exportedSettings = JSON.parse(payload.project.settings_json) as Record<string, unknown>
    expect(exportedSettings.dailyWordGoal).toBe(2500)
    expect(exportedSettings.dailyWordGoalEnabled).toBe(true)
    // 备份不得偷偷塞入其它默认目标
    expect(exportedSettings.dailyChapterGoal).toBeUndefined()

    const imported = await backup.importProject(path)
    const goals = daily.getGoals(imported.id)
    expect(goals.dailyWordGoal).toBe(2500)
    expect(goals.dailyWordGoalEnabled).toBe(true)
    expect(goals.dailyChapterGoal).toBeNull()
    expect(goals.dailyChapterGoalEnabled).toBe(false)
    expect(daily.getDay(imported.id).humanWordsAdded).toBe(50)
    db.close()
  })
})
