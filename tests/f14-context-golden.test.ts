/**
 * F14 验收第 8 条：context-engine 换成 name-matcher 后，发给 provider 的 messages 与 base（46a3577）逐字一致；
 * 仅 allowDiff 列出的条目（单字名/别名等）允许「失去本章提及」带来的差异（白名单见 normalizeAllowed）。
 * 只依赖 base 已有接口：AICreativeRuntime / ChapterDigestRunner / ProofreadingRunner / ProviderService / ProjectService / DocumentService / ChatService。
 * 生成 golden：UPDATE_GOLDEN=1 npx vitest run tests/f14-context-golden.test.ts （在 base 上执行）
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createTestDb, testCodec } from './helpers'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { ChatService } from '../src/main/services/chat-service'
import { ProviderService } from '../src/main/ai/provider'
import { AICreativeRuntime } from '../src/main/ai/runtime'
import { ChapterDigestRunner } from '../src/main/ai/digest-runner'
import { ProofreadingRunner } from '../src/main/ai/proofreading-runner'

type Fixture = {
  name: string; singleChar?: boolean; allowDiff?: string[]; chapter: string; pinned?: string[]; contextWindow?: number
  characters: Array<{ id: string; name: string; aliases: string[]; notes: string; fields: Record<string, string>; updatedAt: number }>
  memories?: Array<{ id: string; content: string; t: number }>
}
type Captured = Record<string, unknown>
const DIR = join(__dirname, 'fixtures', 'f14-context')
const GOLDEN = join(DIR, 'golden.json')
const fixtures: Fixture[] = readdirSync(DIR).filter((file) => file.endsWith('.json') && file !== 'golden.json').sort()
  .map((file) => JSON.parse(readFileSync(join(DIR, file), 'utf8')) as Fixture)
const MODES = ['discussion', 'brainstorm', 'generation', 'editing', 'organization', 'consistency_check', 'reader_review'] as const

const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
/** 随机 id 按出现顺序替换成稳定占位，保证 base 与新分支可比。 */
const stable = (value: unknown): unknown => {
  const seen = new Map<string, string>()
  return JSON.parse(JSON.stringify(value).replace(uuid, (id) => { if (!seen.has(id)) seen.set(id, `<id${seen.size + 1}>`); return seen.get(id)! }))
}

async function capture(fixture: Fixture): Promise<Captured> {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 9, 29, 12, 0, 0))
  try {
    const db = createTestDb()
    const project = new ProjectService(db).create({ title: fixture.name, projectType: 'novel' })
    const docs = new DocumentService(db)
    const chapter = docs.listOrderedChapters(project.id)[0]
    docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc' }, plainText: fixture.chapter })
    for (const c of fixture.characters) {
      db.raw.prepare('INSERT INTO characters(id,project_id,name,aliases_json,notes,fields_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(c.id, project.id, c.name, JSON.stringify(c.aliases), c.notes, JSON.stringify(c.fields), c.updatedAt, c.updatedAt)
    }
    for (const m of fixture.memories ?? []) {
      db.raw.prepare(`INSERT INTO memories(id,project_id,type,content,status,source_type,source_id,created_at,updated_at) VALUES (?,?,'fact',?,'confirmed','author','a',?,?)`)
        .run(m.id, project.id, m.content, m.t, m.t)
    }
    const providers = new ProviderService(db, testCodec)
    providers.save({ id: 'p', providerType: 'openai-compatible', displayName: 'mock', baseUrl: 'http://localhost:11434/v1', apiKey: '' })
    providers.saveModel({ id: 'm', providerId: 'p', modelId: 'mock', displayName: 'mock', enabled: true, isDefault: true,
      contextWindow: fixture.contextWindow, maxOutput: fixture.contextWindow ? 64 : undefined,
      capabilities: { streaming: true, tools: false, structuredOutput: false, cancellation: true } })
    const out: Captured = {}
    let sent: unknown[] = []
    const runtime = new AICreativeRuntime(db, providers, () => ({ chat: async function* (input: { messages: unknown[] }) { sent.push(input.messages); yield '好的' } }) as never)
    const thread = new ChatService(db).createThread(project.id, 'golden')
    for (const mode of MODES) {
      sent = []
      const selection = mode === 'editing' ? { from: 1, to: 1 + Math.min(4, fixture.chapter.length), text: fixture.chapter.slice(0, 4) } : undefined
      const task = { mode, writePermission: mode === 'editing' || mode === 'generation' ? 'proposal' : 'none', userIntent: '请看看这一章', projectId: project.id,
        documentId: chapter.id, selection, includedIds: fixture.pinned, throughChapterNumber: mode === 'reader_review' ? 1 : undefined }
      try { for await (const item of runtime.run(`r-${mode}`, task as never, thread.id, `u-${mode}`, `a-${mode}`)) void item } catch (error) { sent.push({ error: String(error) }) }
      out[mode] = sent
    }
    const completer = () => ({ complete: async (input: { messages: unknown[] }) => { sent.push(input.messages); return '{}' } }) as never
    for (const [mode, run] of [
      ['chapter_digest', () => new ChapterDigestRunner(db, providers, completer).run(project.id, chapter.id)],
      ['proofreading', () => new ProofreadingRunner(db, providers, completer).run(project.id, chapter.id)]
    ] as const) {
      sent = []
      try { await run() } catch { /* 解析失败无妨：只比较已发出的 messages */ }
      out[mode] = sent
    }
    return stable(out) as Captured
  } finally { vi.useRealTimers() }
}

/**
 * 白名单：只允许 allowDiff 条目「失去本章提及」带来的差异——
 * 把这些条目的整块（「[kind] 标题」起、到下一个「[kind] 」前）以及所有「本章提及」依据标签从两边同时抹去后，必须逐字一致。
 */
const normalizeAllowed = (value: unknown, fixture: Fixture): unknown => {
  const titles = [
    ...fixture.characters.filter((c) => fixture.allowDiff?.includes(c.id)).map((c) => `人物 · ${c.name}`),
    ...(fixture.memories ?? []).filter((m) => fixture.allowDiff?.includes(m.id)).map((m) => `设定 · ${m.content.split(/[：:]/)[0]}`)
  ]
  const scrub = (text: string): string => {
    let next = text
    for (const title of titles) {
      const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // 来源块格式：「[kind] 标题\n内容…」，块以空行结束（块内无空行）
      next = next.replace(new RegExp(`\\[[a-z_]+\\] ${escaped}\\n(?:[^\\n]+(?:\\n|$))*`, 'g'), '')
    }
    // 记忆块标题是「type · status」，按首行内容定位白名单记忆
    for (const memory of (fixture.memories ?? []).filter((m) => fixture.allowDiff?.includes(m.id))) {
      const escaped = memory.content.split('\n')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      next = next.replace(new RegExp(`\\[memory\\] [^\\n]+\\n${escaped}(?:\\n|$)(?:[^\\n]+(?:\\n|$))*`, 'g'), '')
    }
    // 白名单条目排名变化会连带改变「按类别轮转」的相对位置：白名单 fixture 只比较来源块的多重集合（顺序由严格 fixture 保证）
    return next.replace(/本章提及[、，,]?/g, '').split(/\n{2,}/).flatMap((block) => block.split(/\n(?=\[[a-z_]+\] )/))
      .map((block) => block.trim()).filter(Boolean).toSorted().join('\n\n')
  }
  return JSON.parse(JSON.stringify(value), (_key, item) => typeof item === 'string' ? scrub(item) : item)
}

const results = new Map<string, Captured>()
afterAll(() => {
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(Object.fromEntries(results), null, 1)}\n`)
})

describe('F14 ⑧ context golden（provider mock 截获，不联网）', () => {
  const golden = process.env.UPDATE_GOLDEN === '1' ? {} : JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, Captured>
  for (const fixture of fixtures) {
    it(`${fixture.name}${fixture.allowDiff?.length ? `（白名单：${fixture.allowDiff.join(',')}）` : '（逐字一致）'}`, async () => {
      const captured = await capture(fixture)
      results.set(fixture.name, captured)
      if (process.env.UPDATE_GOLDEN === '1') return
      expect(golden[fixture.name], `golden 缺少 ${fixture.name}`).toBeDefined()
      for (const mode of [...MODES, 'chapter_digest', 'proofreading']) expect((captured[mode] as unknown[]).length, `${fixture.name}/${mode} 应截获请求`).toBeGreaterThan(0)
      if (!fixture.allowDiff?.length) expect(captured).toStrictEqual(golden[fixture.name])
      else expect(normalizeAllowed(captured, fixture)).toStrictEqual(normalizeAllowed(golden[fixture.name], fixture))
    })
  }
})
