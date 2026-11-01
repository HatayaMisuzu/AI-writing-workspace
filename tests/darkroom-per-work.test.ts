/**
 * P3 小黑屋只锁当前作品（p3-darkroom-per-work）：红证见提交 76cfd34（run 41227094178），实现与本文件补充在后一提交。
 * 需求（组长 2026-10-31）：
 * - AI 入口给出站请求标上 projectId（AsyncLocalStorage），checkEgress 按「这本作品是否在小黑屋」判断；锁的是这一本。
 * - 测试连接、openExternal 标成「非作品」，直接放行；renderer 网络策略原样不动。
 * - 没有标记的出站请求仍按全局判断兜底；每条会出站的 IPC 都必须带标记；流式请求单独覆盖。
 * - linter:run 与整本检查在锁定时放开，且不出站。
 * 标记机制：src/main/net/egress-context.ts 导出
 *   runWithEgressContext(ctx, fn) / currentEgressContext()，ctx 为 { projectId } 或 { nonWork: true }。
 * 用真实 registerIpc（electron 以内存桩替代），底层 fetch 用 setRawFetchForTests 计数。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  listeners: new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => { ipc.handlers.set(channel, fn) },
    on: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => { ipc.listeners.set(channel, fn) }
  },
  BrowserWindow: { getFocusedWindow: () => null, fromWebContents: () => null, getAllWindows: () => [] },
  dialog: {},
  app: { getPath: () => '/tmp' }
}))

import { createTestDb, testCodec } from './helpers'
import { registerIpc } from '../src/main/ipc/register'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { ChatService } from '../src/main/services/chat-service'
import { FocusLockService } from '../src/main/services/focus-lock-service'
import { guardedFetch, installEgressGate, installFocusEgressLock, isFocusEgressLocked, setRawFetchForTests } from '../src/main/net/egress-guard'
import { NetworkGate } from '../src/main/network-policy'
import { ProviderService } from '../src/main/ai/provider'
import * as egressContext from '../src/main/net/egress-context'

type EgressContext = egressContext.EgressContext
/**
 * 红证提交里模块尚不存在，曾用 import(join(__dirname, …)) 运行时加载；该写法在 Windows 上会变成 /@id/D:\… 而加载失败。
 * 模块已实现，改为静态导入（不再拼文件系统路径）。保留 async 形状以免改动各用例。
 */
const loadEgressContext = async (): Promise<typeof egressContext> => egressContext

const frame = { url: 'file:///app/out/renderer/index.html' }
const sent: Array<Record<string, unknown>> = []
const event = { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false, send: (_c: string, payload: Record<string, unknown>) => { sent.push(payload) } } }
const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const fn = ipc.handlers.get(channel)
  if (!fn) throw new Error(`no handler ${channel}`)
  return fn(event, ...args)
}
const settle = async (channel: string, ...args: unknown[]): Promise<{ value?: unknown; error?: Error }> => {
  try { return { value: await invoke(channel, ...args) } } catch (error) { return { error: error as Error } }
}
const notFocusLocked = (error: Error | undefined): void => {
  if (!error) return
  expect((error as Error & { code?: string }).code).not.toBe('FOCUS_LOCKED')
  expect(error.message).not.toMatch(/小黑屋/)
}

let rawFetchCalls = 0
let onRawFetch: (() => void) | undefined
const SSE = 'data: {"choices":[{"delta":{"content":"雨"}}]}\n\ndata: {"choices":[{"delta":{"content":"停了"}}]}\n\ndata: [DONE]\n\n'
const mockResponse = (init?: RequestInit): Response => {
  const body = typeof init?.body === 'string' ? init.body : ''
  if (body.includes('"stream":true')) return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  return new Response(JSON.stringify({ choices: [{ message: { content: '{"memories":[]}' } }], data: [{ id: 'mock' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
}

/** 必须命中 memory-intent.ts 的 positiveHint，否则 extractAndCreate 在出站前本地短路，「出站 0 次」类断言白过。「记住：」是否算意图属产品问题，0.4.1 待议。 */
const MEMORY_INTENT_INPUT = '记一下：主角怕水'
const CHAPTER_TEXT = '他在坐席上，雨落在港口。'
const setup = () => {
  ipc.handlers.clear(); ipc.listeners.clear(); sent.length = 0
  const db = createTestDb()
  const projects = new ProjectService(db)
  const docs = new DocumentService(db)
  const make = (title: string) => {
    const project = projects.create({ title, projectType: 'novel' })
    const chapter = docs.listOrderedChapters(project.id)[0]
    docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: CHAPTER_TEXT }] }] }, plainText: CHAPTER_TEXT })
    return { project, chapter }
  }
  const a = make('雾港来信')
  const b = make('另一本书')
  const providers = new ProviderService(db, testCodec)
  providers.save({ id: 'p', providerType: 'openai-compatible', displayName: 'mock', baseUrl: 'http://localhost:11434/v1', apiKey: 'k' })
  providers.saveModel({ id: 'm', providerId: 'p', modelId: 'mock', displayName: 'mock', enabled: true, isDefault: true, capabilities: { streaming: true, tools: false, structuredOutput: true, cancellation: true } })
  registerIpc(db, testCodec, { refreshNetworkAllowlist: () => {}, allowOriginTemporarily: () => () => {}, getBlockedLog: () => [] })
  installEgressGate({ decide: () => ({ allow: true }) })
  const focus = new FocusLockService(db)
  const chat = new ChatService(db)
  return { db, focus, chat, a, b }
}
const lockA = (env: ReturnType<typeof setup>): void => { env.focus.start(env.a.project.id, { mode: 'words', words: 100 }) }
const aiStart = async (env: ReturnType<typeof setup>, target: { project: { id: string }; chapter: { id: string } }, requestId: string): Promise<void> => {
  const thread = env.chat.createThread(target.project.id, '小黑屋')
  const listener = ipc.listeners.get('ai:start')!
  await listener(event, { requestId, threadId: thread.id, userMessageId: `u-${requestId}`, assistantMessageId: `a-${requestId}`,
    task: { mode: 'discussion', writePermission: 'none', userIntent: '聊聊这一章', projectId: target.project.id, documentId: target.chapter.id } })
}
const errorEvents = () => sent.filter((item) => item.type === 'error')

beforeEach(() => {
  rawFetchCalls = 0; onRawFetch = undefined
  setRawFetchForTests(async (_input, init) => { rawFetchCalls += 1; onRawFetch?.(); return mockResponse(init) })
})
afterEach(() => { installFocusEgressLock(undefined); installEgressGate(undefined); setRawFetchForTests(undefined); vi.restoreAllMocks() })

describe('DR1 按作品判断：A 在小黑屋、B 不在', () => {
  it('DR1-1 B 的 ai:start（流式）放行：无 FOCUS_LOCKED，底层 fetch 有调用，收到 chunk 与 done', async () => {
    const env = setup(); lockA(env)
    await aiStart(env, env.b, 'rb1')
    expect(errorEvents()).toEqual([])
    expect(rawFetchCalls).toBeGreaterThan(0)
    expect(sent.some((item) => item.type === 'chunk')).toBe(true)
    expect(sent.some((item) => item.type === 'done')).toBe(true)
  })
  it('DR1-2 B 的 ai:preview-context 放行', async () => {
    const env = setup(); lockA(env)
    const thread = env.chat.createThread(env.b.project.id, '预览')
    const result = await settle('ai:preview-context', { threadId: thread.id, task: { mode: 'discussion', writePermission: 'none', userIntent: '聊聊', projectId: env.b.project.id, documentId: env.b.chapter.id } })
    expect(result.error).toBeUndefined()
  })
  it('DR1-3 B 的 digests:run 放行并出站', async () => {
    const env = setup(); lockA(env)
    notFocusLocked((await settle('digests:run', env.b.project.id, env.b.chapter.id)).error)
    expect(rawFetchCalls).toBeGreaterThan(0)
  })
  it('DR1-4 B 的 proofreading:run 放行并出站', async () => {
    const env = setup(); lockA(env)
    notFocusLocked((await settle('proofreading:run', env.b.project.id, env.b.chapter.id)).error)
    expect(rawFetchCalls).toBeGreaterThan(0)
  })
  it('DR1-5 B 的 memories:extract-intent 放行并出站', async () => {
    const env = setup(); lockA(env)
    notFocusLocked((await settle('memories:extract-intent', env.b.project.id, 'msg-1', MEMORY_INTENT_INPUT)).error)
    expect(rawFetchCalls).toBeGreaterThan(0)
  })
})

describe('DR2 A 在小黑屋：A 自己的请求仍被拦，零出站', () => {
  it('DR2-1 A 的 ai:start（流式）→ error FOCUS_LOCKED，fetch 0 次，无 chunk', async () => {
    const env = setup(); lockA(env)
    await aiStart(env, env.a, 'ra1')
    expect(errorEvents()).toEqual([expect.objectContaining({ code: 'FOCUS_LOCKED', message: expect.stringContaining('《雾港来信》') })])
    expect(sent.some((item) => item.type === 'chunk')).toBe(false)
    expect(rawFetchCalls).toBe(0)
  })
  it('DR2-2 A 的 preview / digests / proofreading / memories 全部 FOCUS_LOCKED，fetch 0 次', async () => {
    const env = setup(); lockA(env)
    const thread = env.chat.createThread(env.a.project.id, '预览')
    const calls: Array<[string, ...unknown[]]> = [
      ['ai:preview-context', { threadId: thread.id, task: { mode: 'discussion', writePermission: 'none', userIntent: '聊聊', projectId: env.a.project.id, documentId: env.a.chapter.id } }],
      ['digests:run', env.a.project.id, env.a.chapter.id],
      ['proofreading:run', env.a.project.id, env.a.chapter.id],
      ['memories:extract-intent', env.a.project.id, 'msg-1', MEMORY_INTENT_INPUT]
    ]
    for (const [channel, ...args] of calls) {
      const { error } = await settle(channel, ...args)
      expect(error, channel).toBeDefined()
      expect(error!.message, channel).toContain('《雾港来信》')
    }
    expect(rawFetchCalls).toBe(0)
  })
})

describe('DR3 流式请求按作品判断（标记要穿过 async generator 与流读取）', () => {
  it('DR3-1 B 的流式请求在发起 fetch 时带 { projectId: B }', async () => {
    const ctx = await loadEgressContext()
    const env = setup(); lockA(env)
    const seen: Array<EgressContext | undefined> = []
    onRawFetch = () => { seen.push(ctx.currentEgressContext()) }
    await aiStart(env, env.b, 'rb-stream')
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((item) => item !== undefined && 'projectId' in item && item.projectId === env.b.project.id)).toBe(true)
  })
  it('DR3-2 绕过入口直接在 A 的标记下流式出站 → guardedFetch 拒绝 focus-locked；同一时刻 B 的标记放行', async () => {
    const ctx = await loadEgressContext()
    const env = setup(); lockA(env)
    async function* stream(projectLabel: string) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      const response = await guardedFetch('http://localhost:11434/v1/chat/completions', { method: 'POST', body: JSON.stringify({ stream: true, who: projectLabel }) })
      yield await response.text()
    }
    const drain = async (projectId: string) => ctx.runWithEgressContext({ projectId }, async () => { const out: string[] = []; for await (const piece of stream(projectId)) out.push(piece); return out })
    await expect(drain(env.a.project.id)).rejects.toMatchObject({ reason: 'focus-locked' })
    expect(rawFetchCalls).toBe(0)
    await expect(drain(env.b.project.id)).resolves.toEqual([SSE])
    expect(rawFetchCalls).toBe(1)
  })
  it('DR3-3 未带标记的出站仍按全局兜底：A 被锁时拒绝 focus-locked（对照，现状应为绿）', async () => {
    const env = setup(); lockA(env)
    await expect(guardedFetch('http://localhost:11434/v1/chat/completions')).rejects.toMatchObject({ reason: 'focus-locked' })
    expect(rawFetchCalls).toBe(0)
  })
})

describe('DR4 非作品请求不受锁影响', () => {
  it('DR4-1 providers:test 在 A 被锁时放行并出站', async () => {
    const env = setup(); lockA(env)
    const { value, error } = await settle('providers:test', 'p', 'mock')
    expect(error).toBeUndefined()
    expect(value).toEqual({ ok: true })
    expect(rawFetchCalls).toBeGreaterThan(0)
  })
  it('DR4-2 providers:test-url 在 A 被锁时放行并出站', async () => {
    const env = setup(); lockA(env)
    const { value, error } = await settle('providers:test-url', { baseUrl: 'http://localhost:11434/v1', apiKey: 'k', modelId: 'mock', providerId: 'p' })
    expect(error).toBeUndefined()
    expect(value).toMatchObject({ ok: true })
    expect(rawFetchCalls).toBeGreaterThan(0)
  })
  it('DR4-3 { nonWork: true } 标记下 guardedFetch 在 A 被锁时放行', async () => {
    const ctx = await loadEgressContext()
    const env = setup(); lockA(env)
    await ctx.runWithEgressContext({ nonWork: true }, () => guardedFetch('http://localhost:11434/v1/models'))
    expect(rawFetchCalls).toBe(1)
  })
  it('DR4-4 openExternal（window open handler）不再看小黑屋锁', () => {
    const source = readFileSync(join(__dirname, '../src/main/index.ts'), 'utf8')
    const lines = source.split('\n').filter((line) => line.includes('shouldOpenExternal('))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line).not.toMatch(/focus/i)
  })
  it('DR4-5 renderer 网络策略原样不动：仍按全局锁拦截（对照，现状应为绿）', () => {
    const env = setup(); lockA(env)
    const source = readFileSync(join(__dirname, '../src/main/index.ts'), 'utf8')
    expect(source).toMatch(/isFocusLocked:\s*isFocusEgressLocked/)
    expect(isFocusEgressLocked()).toBe(true)
    const gate = new NetworkGate({ isFocusLocked: isFocusEgressLocked })
    gate.setSavedOrigins(['http://localhost:11434'])
    expect(gate.filter('http://localhost:11434/v1/models')).toEqual({ cancel: true })
  })
})

/** 会出站的 IPC 全集（静态扫描 register.ts 与此表必须一致），以及每条出站时应带的标记。 */
const OUTBOUND_IPC = ['ai:start', 'digests:run', 'memories:extract-intent', 'proofreading:run', 'providers:test', 'providers:test-url'] as const
const OUTBOUND_CALL = /\b(?:runtime\.run|digestRunner\.run|proofreading\.run|memoryIntent\.\w+|createProviderAdapter)\(/

describe('DR5 枚举出站 IPC：每条都带 projectId 或「非作品」标记', () => {
  it('DR5-1 register.ts 中会触达 Provider 的 IPC 恰为 OUTBOUND_IPC（新增出站入口须同步登记）', () => {
    const source = readFileSync(join(__dirname, '../src/main/ipc/register.ts'), 'utf8')
    const found = new Set<string>()
    let channel: string | undefined
    for (const line of source.split('\n')) {
      const opened = /(?:\bhandle|ipcMain\.(?:handle|on))\('([^']+)'/.exec(line)
      if (opened) channel = opened[1]
      if (OUTBOUND_CALL.test(line) && channel) found.add(channel)
    }
    expect([...found].sort()).toEqual([...OUTBOUND_IPC].sort())
  })
  it('DR5-2 无锁时逐条调用：每次底层 fetch 都带标记（作品入口 = 本书 projectId；测试连接 = nonWork）', async () => {
    const ctx = await loadEgressContext()
    const env = setup()
    const seen = new Map<string, Array<EgressContext | undefined>>()
    let current = ''
    onRawFetch = () => { const list = seen.get(current) ?? []; list.push(ctx.currentEgressContext()); seen.set(current, list) }
    const bId = env.b.project.id
    const expected: Record<(typeof OUTBOUND_IPC)[number], EgressContext> = {
      'ai:start': { projectId: bId }, 'digests:run': { projectId: bId }, 'memories:extract-intent': { projectId: bId },
      'proofreading:run': { projectId: bId }, 'providers:test': { nonWork: true }, 'providers:test-url': { nonWork: true }
    }
    for (const channel of OUTBOUND_IPC) {
      current = channel
      if (channel === 'ai:start') await aiStart(env, env.b, 'enum-1')
      else if (channel === 'digests:run' || channel === 'proofreading:run') await settle(channel, bId, env.b.chapter.id)
      else if (channel === 'memories:extract-intent') await settle(channel, bId, 'msg-1', MEMORY_INTENT_INPUT)
      else if (channel === 'providers:test') await settle(channel, 'p', 'mock')
      else await settle(channel, { baseUrl: 'http://localhost:11434/v1', apiKey: 'k', modelId: 'mock', providerId: 'p' })
      const list = seen.get(channel) ?? []
      expect(list.length, `${channel} 应有出站`).toBeGreaterThan(0)
      for (const item of list) expect(item, channel).toEqual(expected[channel])
    }
  })
})

describe('DR6 本地检查在锁定时放开，且零出站', () => {
  it('DR6-1 linter:run：A 被锁时照常返回问题（不再 skipped），fetch 0 次', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const env = setup(); lockA(env)
    await invoke('wordlist:save-global', '在坐=>在座')
    const result = await invoke('linter:run', env.a.project.id, env.a.chapter.id, CHAPTER_TEXT) as { issues: unknown[]; skipped?: string }
    expect(result.skipped).toBeUndefined()
    expect(result.issues.length).toBeGreaterThan(0)
    expect(rawFetchCalls).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
  it('DR6-2 lint:check-book：A 被锁时整本检查跑完（cancelled=false），有进度事件，fetch 0 次', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const env = setup(); lockA(env)
    await invoke('wordlist:save-global', '在坐=>在座')
    const result = await invoke('lint:check-book', env.a.project.id, undefined, 'book-a') as { cancelled?: boolean; total: number }
    expect(result.cancelled).not.toBe(true)
    expect(result.total).toBeGreaterThan(0)
    expect(sent.some((item) => item.runId === 'book-a' && item.done === item.total)).toBe(true)
    expect(rawFetchCalls).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
  it('DR6-3 lint:check-book：A 被锁时 B 的整本检查同样可用', async () => {
    const env = setup(); lockA(env)
    await invoke('wordlist:save-global', '在坐=>在座')
    const result = await invoke('lint:check-book', env.b.project.id, undefined, 'book-b') as { cancelled?: boolean; total: number }
    expect(result.cancelled).not.toBe(true)
    expect(result.total).toBeGreaterThan(0)
    expect(rawFetchCalls).toBe(0)
  })
})

describe('DR7 标记只用确实存在的作品：不存在的 projectId 不标记，出站按全局兜底', () => {
  it('DR7-1 runWithWorkEgress：作品存在 → { projectId }；不存在或查询抛错 → 无标记', () => {
    const exists = (id: string) => id === 'real'
    expect(egressContext.runWithWorkEgress(exists, 'real', () => egressContext.currentEgressContext())).toEqual({ projectId: 'real' })
    expect(egressContext.runWithWorkEgress(exists, 'ghost', () => egressContext.currentEgressContext())).toBeUndefined()
    expect(egressContext.runWithWorkEgress(() => { throw new Error('db') }, 'real', () => egressContext.currentEgressContext())).toBeUndefined()
  })
  it('DR7-2 A 被锁时，以不存在的作品 id 调 memories:extract-intent：入口不拦，但出站无标记 → 全局兜底拒绝，fetch 0 次', async () => {
    const env = setup(); lockA(env)
    expect(env.focus.isLocked('ghost-project')).toBe(false)
    await settle('memories:extract-intent', 'ghost-project', 'msg-1', MEMORY_INTENT_INPUT)
    expect(rawFetchCalls).toBe(0)
  })
  it('DR7-3 对照：无锁时同一调用确实出站，且出站时无标记（证明 DR7-2 的 0 次来自兜底而非提前失败）', async () => {
    setup()
    const seen: Array<EgressContext | undefined> = []
    onRawFetch = () => { seen.push(egressContext.currentEgressContext()) }
    await settle('memories:extract-intent', 'ghost-project', 'msg-1', MEMORY_INTENT_INPUT)
    expect(rawFetchCalls).toBeGreaterThan(0)
    expect(seen.every((item) => item === undefined)).toBe(true)
  })
})

describe('DR8 二次出站：标记穿过 await / 定时器回调，判定发生在每次出站那一刻', () => {
  /**
   * 说明：Provider 层没有自动重试。这里用真实存在的「第二次出站」代替重试：
   * memories:extract-intent 第一次返回无法解析的 JSON 时，parseWithRepair 会再发一次 complete（修复请求）。
   * mock 在两次之间经过 setTimeout 回调与 await，确认标记仍在。
   */
  const brokenThenValid = (between?: () => void) => {
    let call = 0
    setRawFetchForTests(async () => {
      rawFetchCalls += 1; onRawFetch?.()
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
      call += 1
      if (call === 1) between?.()
      const content = call === 1 ? '这不是 JSON' : '{"memories":[]}'
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
  }
  it('DR8-1 B 的记忆抽取发生两次出站（首次 + 修复），两次都带 { projectId: B }', async () => {
    const env = setup(); lockA(env)
    const seen: Array<EgressContext | undefined> = []
    onRawFetch = () => { seen.push(egressContext.currentEgressContext()) }
    brokenThenValid()
    notFocusLocked((await settle('memories:extract-intent', env.b.project.id, 'msg-1', MEMORY_INTENT_INPUT)).error)
    expect(rawFetchCalls).toBe(2)
    expect(seen).toEqual([{ projectId: env.b.project.id }, { projectId: env.b.project.id }])
  })
  it('DR8-2 B 的第一次出站进行中 B 进了小黑屋 → 第二次出站在发出那一刻被拒（只发出 1 次）', async () => {
    const env = setup()
    brokenThenValid(() => { env.focus.start(env.b.project.id, { mode: 'words', words: 100 }) })
    await settle('memories:extract-intent', env.b.project.id, 'msg-1', MEMORY_INTENT_INPUT)
    expect(env.focus.isLocked(env.b.project.id)).toBe(true)
    expect(rawFetchCalls).toBe(1)
  })
  it('DR8-3 定时器回调里发起的出站同样带标记', async () => {
    const env = setup(); lockA(env)
    const seen: Array<EgressContext | undefined> = []
    onRawFetch = () => { seen.push(egressContext.currentEgressContext()) }
    await egressContext.runWithEgressContext({ projectId: env.b.project.id }, () => new Promise<void>((resolve, reject) => {
      setTimeout(() => { guardedFetch('http://localhost:11434/v1/models').then(() => resolve(), reject) }, 1)
    }))
    expect(seen).toEqual([{ projectId: env.b.project.id }])
    await expect(egressContext.runWithEgressContext({ projectId: env.a.project.id }, () => new Promise<void>((resolve, reject) => {
      setTimeout(() => { guardedFetch('http://localhost:11434/v1/models').then(() => resolve(), reject) }, 1)
    }))).rejects.toMatchObject({ reason: 'focus-locked' })
    expect(rawFetchCalls).toBe(1)
  })
})

const listSources = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: 'utf8' })
  .filter((file) => /\.tsx?$/.test(file)).map((file) => file.replace(/\\/g, '/'))

describe('DR9 「非作品」标记白名单：只有 providers:test 与 providers:test-url', () => {
  it('DR9-1 src 中出现 nonWork 的文件只有 egress-context.ts（定义）、egress-guard.ts（判定）、register.ts；register.ts 中恰两处，分属两个测试连接 IPC', () => {
    const root = join(__dirname, '../src')
    const files = listSources(root).filter((file) => /\bnonWork\b/.test(readFileSync(join(root, file), 'utf8'))).sort()
    expect(files).toEqual(['main/ipc/register.ts', 'main/net/egress-context.ts', 'main/net/egress-guard.ts'])
    const channels: string[] = []
    let channel: string | undefined
    for (const line of readFileSync(join(root, 'main/ipc/register.ts'), 'utf8').split('\n')) {
      const opened = /(?:\bhandle|ipcMain\.(?:handle|on))\('([^']+)'/.exec(line)
      if (opened) channel = opened[1]
      if (/\bnonWork\b/.test(line) && !/^\s*\/\//.test(line)) channels.push(channel ?? '(none)')
    }
    expect(channels.sort()).toEqual(['providers:test', 'providers:test-url'])
  })
})

describe('DR10 主进程无标记出站路径清单（除 renderer 与 openExternal 外应为 0）', () => {
  it('DR10-1 原始 fetch 只在 egress-guard.ts；guardedFetch 只被 Provider 适配器使用；Runner 只在 register.ts 构造', () => {
    const root = join(__dirname, '../src/main')
    const files = listSources(root)
    const read = (file: string) => readFileSync(join(root, file), 'utf8')
    const rawNet = files.filter((file) => /\bglobalThis\.fetch\b|(?<![\w.])fetch\(|\bnet\.request\(|\bnew WebSocket\(|\bhttps?\.request\(|\bundici\b/.test(read(file)))
    expect(rawNet).toEqual(['net/egress-guard.ts'])
    expect(files.filter((file) => /\bguardedFetch\b/.test(read(file))).sort()).toEqual(['ai/anthropic-adapter.ts', 'ai/provider.ts', 'net/egress-guard.ts'])
    expect(files.filter((file) => /\bnew (?:AICreativeRuntime|ChapterDigestRunner|MemoryIntentRunner|ProofreadingRunner)\(/.test(read(file)))).toEqual(['ipc/register.ts'])
    expect(files.filter((file) => /\bcreateProviderAdapter\(/.test(read(file))).sort())
      .toEqual(['ai/digest-runner.ts', 'ai/memory-intent.ts', 'ai/proofreading-runner.ts', 'ai/provider.ts', 'ai/runtime.ts', 'ipc/register.ts'])
  })
  it('DR10-2 register.ts 中每一处触达 Provider 的调用都在标记包裹内（同一行带 runWithWorkEgress / runWithEgressContext）', () => {
    const lines = readFileSync(join(__dirname, '../src/main/ipc/register.ts'), 'utf8').split('\n').filter((line) => OUTBOUND_CALL.test(line))
    expect(lines.length).toBe(OUTBOUND_IPC.length)
    for (const line of lines) expect(line).toMatch(/\brunWith(?:WorkEgress|EgressContext)\(/)
  })
})
