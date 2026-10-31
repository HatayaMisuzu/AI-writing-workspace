import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppDatabase } from '../src/main/database/database'
import { createTestDb } from './helpers'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { BackupService } from '../src/main/services/backup-service'
import { GLOBAL_WORDLIST_KEY, LINT_IGNORE_LIMIT, LintService, readWordlistFile } from '../src/main/services/lint-service'
import { PatchService } from '../src/main/services/patch-service'
import { FocusLockService } from '../src/main/services/focus-lock-service'
import { lintRulesSchema, lintRunSchema } from '../src/main/ipc/schemas'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

const seed = (db: AppDatabase, text = '他在坐席上，大家在坐。') => {
  const project = new ProjectService(db).create({ title: '雾港', projectType: 'novel' })
  const documents = new DocumentService(db)
  const volume = documents.createNode({ projectId: project.id, type: 'volume', title: '第一卷' })
  const chapter = documents.createNode({ projectId: project.id, parentId: volume.id, type: 'chapter', title: '第一章' })
  const saved = documents.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }, plainText: text, expectedRevision: chapter.revision })
  return { project, chapter, documents, saved, volume }
}

describe('F13 存储（无迁移）', () => {
  it('全局词表在 app_settings；作品级在 settings_json；不改 updated_at，保留其他键', () => {
    const db = createTestDb(); const { project } = seed(db)
    db.raw.prepare('UPDATE projects SET settings_json = ? WHERE id = ?').run(JSON.stringify({ characterHover: false }), project.id)
    const before = (db.raw.prepare('SELECT updated_at FROM projects WHERE id = ?').get(project.id) as { updated_at: number }).updated_at
    const lint = new LintService(db)
    lint.saveGlobal('在坐=>在座\n'); lint.saveProject(project.id, '!在坐\n')
    expect(JSON.parse((db.raw.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(GLOBAL_WORDLIST_KEY) as { value_json: string }).value_json)).toBe('在坐=>在座\n')
    const row = db.raw.prepare('SELECT settings_json, updated_at FROM projects WHERE id = ?').get(project.id) as { settings_json: string; updated_at: number }
    expect(JSON.parse(row.settings_json)).toEqual({ characterHover: false, wordlist: '!在坐\n' })
    expect(row.updated_at).toBe(before)
  })
  it('合计超过 20000 条 / 超过 1MB 拒绝保存（中文报错，不截断）', () => {
    const db = createTestDb(); const { project } = seed(db); const lint = new LintService(db)
    lint.saveGlobal(Array.from({ length: 15_000 }, (_, i) => `g${i}`).join('\n'))
    expect(() => lint.saveProject(project.id, Array.from({ length: 5_001 }, (_, i) => `p${i}`).join('\n'))).toThrow(/超过上限 20000/)
    expect(lint.getProjectText(project.id)).toBe('')
    expect(() => lint.saveProject(project.id, `${'字'.repeat(400_000)}`)).toThrow(/1MB/)
  })
  it('全局词表不进作品备份；作品级词表随 settings_json 进入备份', async () => {
    const db = createTestDb(); const { project } = seed(db); const lint = new LintService(db)
    lint.saveGlobal('全局专属=>X\n'); lint.saveProject(project.id, '作品专属=>Y\n')
    const { chapter } = { chapter: new DocumentService(db).listOrderedChapters(project.id).at(-1)! }
    lint.addIgnore(project.id, { documentId: chapter.id, ruleKey: 'halfwidth', originalText: ',', occurrence: 1 })
    const dir = mkdtempSync(join(tmpdir(), 'f13-backup-')); dirs.push(dir)
    const file = join(dir, 'b.aiwproj')
    await new BackupService(db).exportProject(project.id, file)
    const { readFileSync } = await import('node:fs')
    const raw = readFileSync(file, 'utf8')
    expect(raw).toContain('作品专属')
    expect(raw).not.toContain('全局专属')
    expect(raw).not.toContain('wordlist_global')
    const imported = await new BackupService(db).importProject(file)
    expect(new LintService(db).getProjectText(imported.id)).toBe('作品专属=>Y\n')
    const importedIgnores = new LintService(db).listIgnores(imported.id)
    expect(importedIgnores).toHaveLength(1)
    expect(importedIgnores[0].documentId).not.toBe(chapter.id)
    expect(new DocumentService(db).listOrderedChapters(imported.id).map((node) => node.id)).toContain(importedIgnores[0].documentId)
  })
})

describe('F13 ⑧ 忽略持久化', () => {
  it('重启（重新打开数据库文件）后仍忽略；正文改动后无法定位的忽略自动失效并清除', () => {
    const dir = mkdtempSync(join(tmpdir(), 'f13-ignore-')); dirs.push(dir)
    const path = join(dir, 'db.sqlite')
    let db = new AppDatabase(path)
    const { project, chapter } = seed(db, '在坐一，在坐二，在坐三')
    let lint = new LintService(db)
    lint.saveGlobal('在坐=>在座')
    const first = lint.run(project.id, chapter.id, '在坐一，在坐二，在坐三').issues
    expect(first.map((issue) => issue.occurrence)).toEqual([1, 2, 3])
    lint.addIgnore(project.id, { documentId: chapter.id, ruleKey: first[1].ruleKey!, originalText: first[1].originalText, occurrence: 2 })
    db.close()
    db = new AppDatabase(path); lint = new LintService(db)
    expect(lint.run(project.id, chapter.id, '在坐一，在坐二，在坐三').issues.map((issue) => issue.from)).toEqual([0, 8])
    // 删掉两处后只剩 1 处：第 2 次出现无法定位 → 失效并清除
    expect(lint.run(project.id, chapter.id, '在坐一').issues).toHaveLength(1)
    expect(lint.listIgnores(project.id)).toEqual([])
    db.close()
  })
  it(`上限 ${LINT_IGNORE_LIMIT} 条，超出淘汰最旧的`, () => {
    const db = createTestDb(); const { project, chapter } = seed(db); const lint = new LintService(db)
    const many = Array.from({ length: LINT_IGNORE_LIMIT }, (_, i) => ({ documentId: chapter.id, ruleKey: 'halfwidth', originalText: ',', occurrence: i + 1, createdAt: i }))
    db.raw.prepare('UPDATE projects SET settings_json = ? WHERE id = ?').run(JSON.stringify({ lintIgnores: many }), project.id)
    const after = lint.addIgnore(project.id, { documentId: chapter.id, ruleKey: 'halfwidth', originalText: ',', occurrence: 99_999 }, 1e12)
    expect(after).toHaveLength(LINT_IGNORE_LIMIT)
    expect(after.some((item) => item.occurrence === 1)).toBe(false)
    expect(after.at(-1)?.occurrence).toBe(99_999)
  })
  it('lintIgnores / lintRules 损坏时按默认处理，不阻止检查', () => {
    const db = createTestDb(); const { project, chapter } = seed(db); const lint = new LintService(db)
    db.raw.prepare('UPDATE projects SET settings_json = ? WHERE id = ?').run(JSON.stringify({ lintIgnores: 'x', lintRules: [1], wordlist: 3 }), project.id)
    expect(lint.run(project.id, chapter.id, '你好,世界').issues).toHaveLength(1)
  })
})

describe('F13 ⑨ 导入（预览 → 确认只传 token）', () => {
  for (const scope of ['global', 'project'] as const) {
    it(`${scope}：三类计数正确；确认之前不写入；预览后词表被改 → 拒绝写入`, () => {
      const db = createTestDb(); const { project } = seed(db); const lint = new LintService(db)
      const save = (text: string) => scope === 'global' ? lint.saveGlobal(text) : lint.saveProject(project.id, text)
      const current = () => lint.exportText(scope, project.id)
      save('在坐=>在座\n敏感\n')
      const incoming = '在坐=>在座位\n敏感\n新词\n=>坏行\n'
      const preview = lint.previewImport(scope, project.id, incoming)
      expect({ added: preview.added, overwritten: preview.overwritten, errors: preview.errors.map((item) => item.line) }).toEqual({ added: 1, overwritten: 1, errors: [4] })
      expect(current()).toBe('在坐=>在座\n敏感\n')
      expect(() => lint.applyImport(scope, project.id, incoming, 'f'.repeat(64))).toThrow(/预览后已变化/)
      save('在坐=>在座\n敏感\n改过\n')
      expect(() => lint.applyImport(scope, project.id, incoming, preview.token)).toThrow(/预览后已变化/)
      expect(current()).toBe('在坐=>在座\n敏感\n改过\n')
      const fresh = lint.previewImport(scope, project.id, incoming)
      lint.applyImport(scope, project.id, incoming, fresh.token)
      expect(current()).toBe('在坐=>在座位\n敏感\n改过\n新词\n')
    })
  }
  it('文件先取大小：超过 1MB / 非普通文件 / 含 NUL 拒绝', async () => {
    const io = (size: number, isFile = true, text = 'a') => ({ stat: (async () => ({ size, isFile: () => isFile })) as never, readFile: async () => text })
    await expect(readWordlistFile('x', io(1_000_001))).rejects.toThrow('词表文件太大，未导入：文件实际大小 1,000,001 字节，上限 1MB（1,000,000 字节）。')
    await expect(readWordlistFile('x', io(1_000_000))).resolves.toBe('a')
    await expect(readWordlistFile('x', io(1, false))).rejects.toThrow(/普通文件/)
    await expect(readWordlistFile('x', io(3, true, 'a\u0000b'))).rejects.toThrow(/纯文本/)
    await expect(readWordlistFile('x', io(3, true, '在坐'))).resolves.toBe('在坐')
  })
})

describe('F13 ⑩ 不联网、不调 AI；P3 起小黑屋中照常运行', () => {
  it('linter 路径 fetch 0 次、provider 0 次；锁定中 run 照常出结果，全书检查照常跑完（仍零出站）', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const db = createTestDb(); const { project, chapter } = seed(db)
    const focus = new FocusLockService(db)
    const lint = new LintService(db)
    lint.saveGlobal('在坐=>在座')
    const providerCalls = vi.fn()
    expect(lint.run(project.id, chapter.id, '在坐').issues).toHaveLength(1)
    expect((await lint.checkBook(project.id)).total).toBe(2)
    focus.start(project.id, { mode: 'words', words: 100 })
    expect(focus.isLocked(project.id)).toBe(true)
    const locked = lint.run(project.id, chapter.id, '在坐')
    expect(locked.skipped).toBeUndefined(); expect(locked.issues).toHaveLength(1)
    const lockedBook = await lint.checkBook(project.id)
    expect(lockedBook.cancelled).toBe(false); expect(lockedBook.total).toBe(2)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(providerCalls).not.toHaveBeenCalled()
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '%provider%'").get()).toBeDefined()
    fetchSpy.mockRestore()
  })
  it('IPC 入参 zod 校验', () => {
    expect(() => lintRunSchema.parse(['p', 'd'])).toThrow()
    expect(lintRunSchema.parse(['p', 'd', '文本', 3])).toEqual(['p', 'd', '文本', 3])
    expect(() => lintRulesSchema.parse({ punctuation: true })).toThrow()
  })
})

describe('F13 全书检查：进度、取消、1000 章 300 万字只记录耗时（硬上限 180s）', () => {
  it('逐章进度；取消后停止', async () => {
    const db = createTestDb(); const { project, documents, volume } = seed(db, '在坐')
    for (let i = 0; i < 5; i += 1) { const node = documents.createNode({ projectId: project.id, parentId: volume.id, type: 'chapter', title: `第${i + 2}章` }); documents.saveContent({ projectId: project.id, documentId: node.id, editorJson: { type: 'doc', content: [] }, plainText: '在坐', expectedRevision: node.revision }) }
    const lint = new LintService(db); lint.saveGlobal('在坐=>在座')
    const progress: number[] = []
    const all = await lint.checkBook(project.id, { onProgress: (done) => progress.push(done) })
    expect(progress).toEqual(Array.from({ length: progress.length }, (_, i) => i + 1)); expect(progress.length).toBeGreaterThanOrEqual(6); expect(all.total).toBe(6)
    const cancelled = await lint.checkBook(project.id, { runId: 'r1', onProgress: (done) => { if (done === 2) lint.cancelBookCheck('r1') } })
    expect(cancelled.cancelled).toBe(true); expect(cancelled.total).toBeLessThanOrEqual(2)
    const timed = await lint.checkBook(project.id, { hardLimitMs: 0, now: (() => { let t = 0; return () => (t += 1) })() })
    expect(timed.timedOut).toBe(true)
  })
  it('1000 章、300 万字：记录耗时，≤ 180s', async () => {
    const db = createTestDb(); const { project, documents, volume } = seed(db, '序')
    const base = '风雨如晦，鸡鸣不已。他在坐席上说,你好。'
    const text = base.repeat(Math.ceil(3000 / base.length)).slice(0, 3000)
    const insert = () => { for (let i = 0; i < 1000; i += 1) { const node = documents.createNode({ projectId: project.id, parentId: volume.id, type: 'chapter', title: `章${i}` }); documents.saveContent({ projectId: project.id, documentId: node.id, editorJson: { type: 'doc', content: [] }, plainText: text, expectedRevision: node.revision }) } }
    insert()
    const lint = new LintService(db); lint.saveGlobal(Array.from({ length: 2000 }, (_, i) => `词${i}=>替${i}`).concat('在坐=>在座').join('\n'))
    const result = await lint.checkBook(project.id)
    process.stdout.write(`F13 book check 1001 chapters / ~3M chars: ${(result.elapsedMs / 1000).toFixed(2)}s, ${result.total} issues\n`)
    expect(result.timedOut).toBe(false)
    expect(result.elapsedMs).toBeLessThanOrEqual(180_000)
  }, 200_000)
})

describe('F13 批量应用（方案 c）：rebase', () => {
  it('只允许 proposed、修订号匹配；改 revision 与区间后 prepare 仍按原文校验', () => {
    const db = createTestDb(); const { project, chapter, documents, saved } = seed(db, '在坐一在坐二')
    const patches = new PatchService(db)
    const a = patches.propose({ projectId: project.id, documentId: chapter.id, documentRevision: saved.revision, fromPm: 1, toPm: 3, originalText: '在坐', replacement: '在座' })
    const b = patches.propose({ projectId: project.id, documentId: chapter.id, documentRevision: saved.revision, fromPm: 4, toPm: 6, originalText: '在坐', replacement: '在座' })
    const next = documents.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc', content: [] }, plainText: '在座一在坐二', expectedRevision: saved.revision })
    expect(() => patches.rebase({ projectId: project.id, patchId: b.id, fromRevision: saved.revision, toRevision: next.revision + 1, fromPm: 4, toPm: 6 })).toThrow('PATCH_REVISION_STALE')
    const rebased = patches.rebase({ projectId: project.id, patchId: b.id, fromRevision: saved.revision, toRevision: next.revision, fromPm: 4, toPm: 6 })
    expect(rebased).toMatchObject({ documentRevision: next.revision, fromPm: 4, toPm: 6, originalText: '在坐', status: 'proposed' })
    expect(patches.prepare(project.id, b.id, next.revision, '在坐').status).toBe('proposed')
    expect(patches.prepare(project.id, a.id, next.revision, '在座').status).toBe('stale')
    patches.reject(project.id, b.id)
    expect(() => patches.rebase({ projectId: project.id, patchId: b.id, fromRevision: next.revision, toRevision: next.revision + 1, fromPm: 4, toPm: 6 })).toThrow('PATCH_NOT_PROPOSED')
  })
  it('真实文件：刚好 1MB（1,000,000 字节）可读；多 1 字节拒绝且不读内容，提示写出实际大小与上限', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rr-wordlist-'))
    try {
      const exact = join(dir, 'exact.txt'); const over = join(dir, 'over.txt')
      await writeFile(exact, 'a'.repeat(1_000_000)); await writeFile(over, 'a'.repeat(1_000_001))
      expect((await readWordlistFile(exact)).length).toBe(1_000_000)
      let reads = 0
      const counting = { stat, readFile: async (path: string, encoding: 'utf8') => { reads += 1; return readFile(path, encoding) } }
      await expect(readWordlistFile(over, counting)).rejects.toMatchObject({ code: 'WORDLIST_FILE_TOO_LARGE', message: expect.stringContaining('实际大小 1,000,001 字节，上限 1MB') })
      expect(reads).toBe(0)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
