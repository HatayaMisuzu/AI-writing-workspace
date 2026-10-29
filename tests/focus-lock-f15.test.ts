import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestDb, testCodec } from './helpers'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { WritingDailyService } from '../src/main/services/writing-daily-service'
import { ChatService } from '../src/main/services/chat-service'
import { ProviderService } from '../src/main/ai/provider'
import { AICreativeRuntime } from '../src/main/ai/runtime'
import {
  FOCUS_EXIT_PHRASE, FocusLockError, FocusLockService, assertNoFocusLockAnywhere, assertNotFocusLocked, validateFocusInput
} from '../src/main/services/focus-lock-service'
import { guardedFetch, installEgressGate, installFocusEgressLock, setRawFetchForTests } from '../src/main/net/egress-guard'
import type { AITaskEnvelope } from '../src/shared/domain'

const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] }
const MIN = 60_000

const setup = (start = new Date(2026, 9, 29, 10, 0, 0).getTime()) => {
  const db = createTestDb()
  const clock = { now: start }
  const daily = new WritingDailyService(db, () => new Date(clock.now))
  const docs = new DocumentService(db, daily)
  const project = new ProjectService(db).create({ title: '小黑屋', projectType: 'novel' })
  const chapter = docs.listOrderedChapters(project.id)[0]
  const focus = new FocusLockService(db, () => clock.now)
  const save = (plainText: string, extra: Record<string, unknown> = {}) => docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: emptyDoc, plainText, ...extra })
  return { db, clock, daily, docs, project, chapter, focus, save }
}
const codeOf = (fn: () => unknown): string | undefined => { try { fn(); return undefined } catch (error) { return (error as FocusLockError).code } }

afterEach(() => { installFocusEgressLock(undefined); installEgressGate(undefined); setRawFetchForTests(undefined); vi.restoreAllMocks() })

describe('F15 ① 条件校验：每次填写，超限拒绝不修正', () => {
  it('缺值 / 非整数 / 0 / 负数 / 模式字段错配都拒绝', () => {
    for (const bad of [undefined, {}, { mode: 'words' }, { mode: 'words', words: 0 }, { mode: 'words', words: -5 }, { mode: 'words', words: 1.5 }, { mode: 'words', words: '100' },
      { mode: 'minutes' }, { mode: 'minutes', minutes: 30, words: 10 }, { mode: 'words', words: 10, minutes: 5 }, { mode: 'combo', words: 10, minutes: 5 },
      { mode: 'combo', words: 10, minutes: 5, combine: 'either' }, { mode: 'words', words: 10, combine: 'all' }]) {
      expect(codeOf(() => validateFocusInput(bad))).toBe('FOCUS_INVALID')
    }
    expect(validateFocusInput({ mode: 'combo', words: 10, minutes: 5, combine: 'any' })).toEqual({ mode: 'combo', words: 10, minutes: 5, combine: 'any' })
  })
  it('⑥d 边界：50000 字 / 600 分钟接受，50001 / 601 拒绝（不截断成上限）', () => {
    const { focus, project } = setup()
    expect(validateFocusInput({ mode: 'words', words: 50_000 }).words).toBe(50_000)
    expect(validateFocusInput({ mode: 'minutes', minutes: 600 }).minutes).toBe(600)
    expect(codeOf(() => focus.start(project.id, { mode: 'words', words: 50_001 }))).toBe('FOCUS_INVALID')
    expect(codeOf(() => focus.start(project.id, { mode: 'minutes', minutes: 601 }))).toBe('FOCUS_INVALID')
    expect(focus.status(project.id).locked).toBe(false)
    expect(focus.start(project.id, { mode: 'combo', words: 50_000, minutes: 600, combine: 'all' }).lock).toMatchObject({ words: 50_000, minutes: 600 })
  })
  it('进入即写 settings_json.focusLock，重复进入拒绝', () => {
    const { focus, project, db } = setup()
    focus.start(project.id, { mode: 'words', words: 10 })
    const raw = JSON.parse((db.raw.prepare('SELECT settings_json FROM projects WHERE id = ?').get(project.id) as { settings_json: string }).settings_json)
    expect(raw.focusLock).toMatchObject({ mode: 'words', words: 10, baseAdded: 0, baseDeleted: 0, sessionDate: '2026-10-29' })
    expect(typeof raw.focusLock.startedAt).toBe('number')
    expect(codeOf(() => focus.start(project.id, { mode: 'words', words: 10 }))).toBe('FOCUS_ALREADY_LOCKED')
  })
})

describe('F15 ② 进度 = 锁定后已保存的净新增', () => {
  it('+500 −200 = 300；锁前已有正文删 100 = 0（不为负）', () => {
    const a = setup()
    a.focus.start(a.project.id, { mode: 'words', words: 1000 })
    a.save('甲'.repeat(500)); expect(a.focus.status(a.project.id).progressWords).toBe(500)
    a.save('甲'.repeat(300)); expect(a.focus.status(a.project.id).progressWords).toBe(300)
    const b = setup()
    b.save('乙'.repeat(400))
    b.focus.start(b.project.id, { mode: 'words', words: 10 })
    expect(b.focus.status(b.project.id).progressWords).toBe(0)
    b.save('乙'.repeat(300))
    expect(b.focus.status(b.project.id).progressWords).toBe(0)
  })
  it('writingStats=skip 与 AI 来源保存不计入', () => {
    const { focus, project, save } = setup()
    focus.start(project.id, { mode: 'words', words: 10 })
    save('丙'.repeat(200), { writingStats: 'skip' })
    save('丙'.repeat(200) + '丁'.repeat(300), { styleSample: { origin: 'ai', text: '丁'.repeat(300) } })
    expect(focus.status(project.id).progressWords).toBe(0)
    expect(focus.status(project.id).reached).toBe(false)
  })
  it('⑥c 一次粘贴 3000 字计入（D2）', () => {
    const { focus, project, save } = setup()
    focus.start(project.id, { mode: 'words', words: 3000 })
    save('粘'.repeat(3000))
    expect(focus.status(project.id)).toMatchObject({ progressWords: 3000, reached: true })
  })
})

describe('F15 ③ 判定：all / any，注入 now()', () => {
  it('字数 / 时间 / 组合', () => {
    const t = setup()
    t.focus.start(t.project.id, { mode: 'minutes', minutes: 30 })
    t.clock.now += 30 * MIN - 1; expect(t.focus.status(t.project.id)).toMatchObject({ reached: false, remainingMs: 1 })
    t.clock.now += 1; expect(t.focus.status(t.project.id)).toMatchObject({ reached: true, remainingMs: 0 })

    const all = setup()
    all.focus.start(all.project.id, { mode: 'combo', words: 100, minutes: 10, combine: 'all' })
    all.save('戊'.repeat(100)); expect(all.focus.status(all.project.id).reached).toBe(false)
    all.clock.now += 10 * MIN; expect(all.focus.status(all.project.id).reached).toBe(true)

    const any = setup()
    any.focus.start(any.project.id, { mode: 'combo', words: 100, minutes: 10, combine: 'any' })
    any.clock.now += 10 * MIN; expect(any.focus.status(any.project.id).reached).toBe(true)
    const any2 = setup()
    any2.focus.start(any2.project.id, { mode: 'combo', words: 100, minutes: 10, combine: 'any' })
    any2.save('己'.repeat(100)); expect(any2.focus.status(any2.project.id).reached).toBe(true)
  })
  it('未达成不能正常出屋；达成后出屋写 focusLastSession（达成）', () => {
    const { focus, project, save, clock } = setup()
    focus.start(project.id, { mode: 'words', words: 50 })
    expect(codeOf(() => focus.finish(project.id))).toBe('FOCUS_NOT_REACHED')
    save('庚'.repeat(60)); clock.now += 5 * MIN
    expect(focus.finish(project.id).locked).toBe(false)
    expect(focus.lastSession(project.id)).toMatchObject({ mode: 'words', words: 50, netWords: 60, endedBy: 'reached', endedAt: clock.now })
  })
})

describe('F15 ④ 锁定期间 AI 主进程入口返回 FOCUS_LOCKED，Provider mock 调用 0 次', () => {
  it('previewContext / run / provider 测试连接 / 出站 fetch 全部在触达 Provider 前拒绝', async () => {
    const { db, focus, project, chapter } = setup()
    const providers = new ProviderService(db, testCodec)
    providers.save({ id: 'p', providerType: 'openai-compatible', displayName: 'mock', baseUrl: 'http://localhost:11434/v1', apiKey: '' })
    providers.saveModel({ id: 'm', providerId: 'p', modelId: 'mock', displayName: 'mock', enabled: true, isDefault: true, capabilities: { streaming: true, tools: false, structuredOutput: false, cancellation: true } })
    let providerCalls = 0
    const runtime = new AICreativeRuntime(db, providers, () => ({ chat: async function* () { providerCalls += 1; yield 'x' } }))
    const thread = new ChatService(db).createThread(project.id, 't')
    const task: AITaskEnvelope = { mode: 'discussion', writePermission: 'none', userIntent: '聊聊', projectId: project.id, documentId: chapter.id }
    // 与 register.ts 相同的守门顺序：先 assertNotFocusLocked 再进 runtime
    const preview = () => { assertNotFocusLocked(focus, task.projectId); return runtime.previewContext(task, thread.id) }
    const start = async () => { assertNotFocusLocked(focus, task.projectId); const chunks: string[] = []; for await (const item of runtime.run('r1', task, thread.id, 'u1', 'a1')) chunks.push(item.chunk); return chunks }
    let rawFetchCalls = 0
    setRawFetchForTests(async () => { rawFetchCalls += 1; return new Response('{}') })
    installEgressGate({ decide: () => ({ allow: true, reason: 'test' }) })
    installFocusEgressLock(() => focus.anyLocked())

    focus.start(project.id, { mode: 'words', words: 10 })
    expect(codeOf(preview)).toBe('FOCUS_LOCKED')
    await expect(start()).rejects.toMatchObject({ code: 'FOCUS_LOCKED' })
    expect(codeOf(() => assertNoFocusLockAnywhere(focus))).toBe('FOCUS_LOCKED')
    await expect(guardedFetch('http://localhost:11434/v1/models')).rejects.toMatchObject({ reason: 'focus-locked' })
    expect(providerCalls).toBe(0)
    expect(rawFetchCalls).toBe(0)

    focus.emergencyExit(project.id, FOCUS_EXIT_PHRASE)
    await start()
    await guardedFetch('http://localhost:11434/v1/models')
    expect(providerCalls).toBe(1)
    expect(rawFetchCalls).toBe(1)
  })
  it('有意全局：任一作品锁定 → 另一作品的 AI 入口同样拒绝（与出站兜底一致），报错带被锁书名', () => {
    const { db, focus, project } = setup()
    const other = new ProjectService(db).create({ title: '另一本', projectType: 'novel' })
    focus.start(project.id, { mode: 'words', words: 10 })
    expect(codeOf(() => assertNotFocusLocked(focus, other.id))).toBe('FOCUS_LOCKED')
    expect(() => assertNotFocusLocked(focus, other.id)).toThrow('《小黑屋》')
  })
})

describe('F15 ⑤ 恢复 / 跨午夜 / 损坏', () => {
  it('重建服务后恢复锁；跨午夜后进度把两天合计（减基线）', () => {
    const { db, daily, project, save, clock, focus } = setup(new Date(2026, 9, 29, 23, 50).getTime())
    save('辛'.repeat(100))
    focus.start(project.id, { mode: 'words', words: 500 })
    save('辛'.repeat(250))
    clock.now = new Date(2026, 9, 30, 0, 20).getTime()
    save('辛'.repeat(400))
    const again = new FocusLockService(db, () => clock.now)
    expect(again.restore(project.id)).toMatchObject({ locked: true, progressWords: 300, reached: false })
    expect(daily.getDay(project.id, '2026-10-30').humanWordsAdded).toBe(150)
  })
  it('重启时已达成 → 直接视为结束并记录「达成」', () => {
    const { db, focus, project, clock } = setup()
    focus.start(project.id, { mode: 'minutes', minutes: 5 })
    clock.now += 6 * MIN
    const restored = new FocusLockService(db, () => clock.now).restore(project.id)
    expect(restored.locked).toBe(false)
    expect(focus.lastSession(project.id)).toMatchObject({ endedBy: 'reached', minutes: 5 })
  })
  it('数据损坏 → 视为未锁定并记日志，书稿照常可打开', () => {
    const { db, focus, project, docs, chapter } = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const broken of [{ focusLock: 'garbage' }, { focusLock: { mode: 'words', words: 999_999, startedAt: 1, baseAdded: 0, baseDeleted: 0, sessionDate: '2026-10-29' } }, { focusLock: { mode: 'words', words: 10 } }]) {
      db.raw.prepare('UPDATE projects SET settings_json = ? WHERE id = ?').run(JSON.stringify(broken), project.id)
      expect(focus.restore(project.id).locked).toBe(false)
      expect(focus.anyLocked()).toBe(false)
    }
    db.raw.prepare('UPDATE projects SET settings_json = ? WHERE id = ?').run('{not json', project.id)
    expect(focus.status(project.id).locked).toBe(false)
    expect(() => assertNotFocusLocked(focus, project.id)).not.toThrow()
    expect(docs.getContent(project.id, chapter.id)).toBeTruthy()
    expect(warn).toHaveBeenCalled()
    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toContain('[focus-lock]')
  })
})

describe('F15 ⑥ 紧急出口与墙钟', () => {
  it('⑥a 短语必须是「我要出屋」，无冷却，记录「紧急」', () => {
    const { focus, project, save } = setup()
    focus.start(project.id, { mode: 'words', words: 1000 })
    save('壬'.repeat(12))
    for (const wrong of ['', '我要出去', '出屋', undefined, 42]) expect(codeOf(() => focus.emergencyExit(project.id, wrong))).toBe('FOCUS_PHRASE_MISMATCH')
    expect(focus.status(project.id).locked).toBe(true)
    expect(focus.emergencyExit(project.id, '我要出屋').locked).toBe(false)
    expect(focus.lastSession(project.id)).toMatchObject({ endedBy: 'emergency', netWords: 12, words: 1000 })
    // 无冷却：可立刻再次进入
    expect(focus.start(project.id, { mode: 'words', words: 5 }).locked).toBe(true)
  })
  it('⑥b 休眠：now()=T+M 即达成；重建服务后同样成立', () => {
    const { db, focus, project, clock } = setup()
    const T = clock.now
    focus.start(project.id, { mode: 'minutes', minutes: 45 })
    clock.now = T + 45 * MIN
    expect(focus.status(project.id).reached).toBe(true)
    expect(new FocusLockService(db, () => T + 45 * MIN).status(project.id)).toMatchObject({ locked: true, reached: true, elapsedMs: 45 * MIN })
    expect(new FocusLockService(db, () => T + 45 * MIN - 1000).status(project.id).reached).toBe(false)
  })
})
