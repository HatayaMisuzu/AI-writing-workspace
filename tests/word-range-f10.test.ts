import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { BackupService } from '../src/main/services/backup-service'
import { WritingDailyService } from '../src/main/services/writing-daily-service'
import { runManuscriptExport } from '../src/main/services/manuscript-export-flow'
import { chapterWordRangeSchema } from '../src/main/ipc/schemas'
import { chapterWordRangeHint, draftToWordRange } from '../src/renderer/src/services/chapter-word-range-view'
import { userErrorMessage } from '../src/shared/user-error'
import { createTestDb } from './helpers'

const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] }

describe('P1-3 F10 章节字数区间提示', () => {
  it('未设区间不渲染任何提示', () => {
    expect(chapterWordRangeHint(0, undefined)).toBeNull()
    expect(chapterWordRangeHint(3000, { min: null, max: null })).toBeNull()
  })
  it('区间内 / 低于下限 / 高于上限；只设一端', () => {
    const range = { min: 2000, max: 4000 }
    expect(chapterWordRangeHint(2000, range)?.state).toBe('in')
    expect(chapterWordRangeHint(4000, range)?.state).toBe('in')
    expect(chapterWordRangeHint(1999, range)?.state).toBe('below')
    expect(chapterWordRangeHint(4001, range)?.state).toBe('above')
    expect(chapterWordRangeHint(10, { min: 100, max: null })?.state).toBe('below')
    expect(chapterWordRangeHint(10, { min: null, max: 100 })?.state).toBe('in')
  })
  it('settings_json 默认空；保存后读回；关闭区间后提示消失', () => {
    const db = createTestDb()
    const project = new ProjectService(db).create({ title: '区间', projectType: 'novel' })
    const writing = new WritingDailyService(db)
    expect(writing.getChapterWordRange(project.id)).toEqual({ min: null, max: null })
    expect(chapterWordRangeHint(5000, writing.getChapterWordRange(project.id))).toBeNull()
    writing.setChapterWordRange(project.id, { min: 2000, max: 3000 })
    expect(chapterWordRangeHint(5000, writing.getChapterWordRange(project.id))?.state).toBe('above')
    writing.setChapterWordRange(project.id, { min: null, max: null })
    expect(chapterWordRangeHint(5000, writing.getChapterWordRange(project.id))).toBeNull()
    const row = db.raw.prepare('SELECT settings_json FROM projects WHERE id = ?').get(project.id) as { settings_json: string }
    expect(JSON.parse(row.settings_json)).toEqual({})
    expect(() => writing.setChapterWordRange(project.id, { min: 5, max: 1 })).toThrow(/下限/)
  })
  it('zod 校验：正整数、下限≤上限、允许只设一端', () => {
    expect(chapterWordRangeSchema.safeParse({ min: 1, max: null }).success).toBe(true)
    expect(chapterWordRangeSchema.safeParse({ min: null, max: 1 }).success).toBe(true)
    expect(chapterWordRangeSchema.safeParse({ min: 3, max: 3 }).success).toBe(true)
    expect(chapterWordRangeSchema.safeParse({ min: 4, max: 3 }).success).toBe(false)
    expect(chapterWordRangeSchema.safeParse({ min: 0, max: null }).success).toBe(false)
    expect(chapterWordRangeSchema.safeParse({ min: 1.5, max: null }).success).toBe(false)
    expect(() => draftToWordRange({ min: '9', max: '3' })).toThrow(/下限/)
    expect(draftToWordRange({ min: '', max: '' })).toEqual({ min: null, max: null })
  })
})

describe('PR21 遗留：导出流程', () => {
  it('越界错误文案去掉 Electron IPC 前缀', () => {
    expect(userErrorMessage(new Error("Error invoking remote method 'backup:export-manuscript': Error: 章节范围超出 1–4"))).toBe('章节范围超出 1–4')
  })
  it('范围校验在保存框之前', async () => {
    const showSaveDialog = vi.fn()
    const write = vi.fn()
    await expect(runManuscriptExport({ countChapters: () => { throw new Error('章节范围超出 1–4') }, showSaveDialog, write }, { range: { from: 1, to: 9 } })).rejects.toThrow(/超出/)
    expect(showSaveDialog).not.toHaveBeenCalled()
  })
  it('范围 + 仅定稿为空：不弹保存框、不写文件', async () => {
    const db = createTestDb()
    const docs = new DocumentService(db)
    const project = new ProjectService(db).create({ title: '空导出', projectType: 'novel' })
    const first = docs.listOrderedChapters(project.id)[0]
    docs.saveContent({ projectId: project.id, documentId: first.id, editorJson: emptyDoc, plainText: '草稿' })
    const backup = new BackupService(db)
    const dir = await mkdtemp(join(tmpdir(), 'inkstone-f10-empty-'))
    try {
      const showSaveDialog = vi.fn(async () => ({ canceled: false, filePath: join(dir, 'out.txt') }))
      const write = vi.fn((filePath: string, options: object) => backup.exportManuscript(project.id, filePath, 'txt', options))
      const result = await runManuscriptExport({ countChapters: (options) => backup.selectManuscriptChapters(project.id, options).length, showSaveDialog, write }, { range: { from: 1, to: 1 }, onlyFinal: true })
      expect(result).toEqual({ status: 'empty' })
      expect(showSaveDialog).not.toHaveBeenCalled()
      expect(write).not.toHaveBeenCalled()
      expect(await readdir(dir)).toEqual([])
      await expect(backup.exportManuscript(project.id, join(dir, 'x.txt'), 'txt', { range: { from: 1, to: 1 }, onlyFinal: true })).rejects.toThrow('EXPORT_EMPTY')
      expect(await readdir(dir)).toEqual([])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
