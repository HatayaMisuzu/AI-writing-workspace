/**
 * F15 锁定可见性 + 锁定期间拒绝的出站请求清单（每项一条测试）。
 * 用真实 registerIpc（electron 以内存桩替代），从「另一本书」发起请求，证明：
 * - 任一作品锁定 → 拒绝；报错带被锁作品书名，且不带「FocusLockError:」前缀；
 * - 底层 fetch 调用 0 次（零 API 调用）。
 */
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
import { FOCUS_EXIT_PHRASE, FocusLockError, FocusLockService, focusLockedMessage } from '../src/main/services/focus-lock-service'
import { guardedFetch, installEgressGate, installFocusEgressLock, setRawFetchForTests } from '../src/main/net/egress-guard'
import { NetworkGate } from '../src/main/network-policy'
import { shouldOpenExternal } from '../src/main/external-url'
import { ProviderService } from '../src/main/ai/provider'
import { userErrorMessage } from '../src/shared/user-error'
import { handleModalEscape } from '../src/renderer/src/services/modal-escape'

const frame = { url: 'file:///app/out/renderer/index.html' }
const sent: unknown[] = []
const event = { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false, send: (_c: string, payload: unknown) => { sent.push(payload) } } }
const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const fn = ipc.handlers.get(channel)
  if (!fn) throw new Error(`no handler ${channel}`)
  return fn(event, ...args)
}
const rejection = async (channel: string, ...args: unknown[]): Promise<Error> => {
  try { await invoke(channel, ...args) } catch (error) { return error as Error }
  throw new Error(`${channel} 应被拒绝`)
}

let rawFetchCalls = 0
const setup = () => {
  ipc.handlers.clear(); ipc.listeners.clear(); sent.length = 0
  const db = createTestDb()
  const projects = new ProjectService(db)
  const locked = projects.create({ title: '雾港来信', projectType: 'novel' })
  const other = projects.create({ title: '另一本书', projectType: 'novel' })
  const docs = new DocumentService(db)
  const otherChapter = docs.listOrderedChapters(other.id)[0]
  docs.saveContent({ projectId: other.id, documentId: otherChapter.id, editorJson: { type: 'doc', content: [{ type: 'paragraph' }] }, plainText: '雨落在港口。'.repeat(20) })
  const providers = new ProviderService(db, testCodec)
  providers.save({ id: 'p', providerType: 'openai-compatible', displayName: 'mock', baseUrl: 'http://localhost:11434/v1', apiKey: 'k' })
  providers.saveModel({ id: 'm', providerId: 'p', modelId: 'mock', displayName: 'mock', enabled: true, isDefault: true, capabilities: { streaming: true, tools: false, structuredOutput: true, cancellation: true } })
  registerIpc(db, testCodec, { refreshNetworkAllowlist: () => {}, allowOriginTemporarily: () => () => {}, getBlockedLog: () => [] })
  installEgressGate({ decide: () => ({ allow: true }) })
  const focus = new FocusLockService(db)
  focus.start(locked.id, { mode: 'words', words: 100 })
  return { db, focus, locked, other, otherChapter }
}
const expectTitledNoPrefix = (error: Error): void => {
  expect(error.message).toContain('《雾港来信》')
  expect(String(error)).not.toMatch(/FocusLockError/)
  expect(userErrorMessage(new Error(`Error invoking remote method 'x': ${String(error)}`))).toBe(error.message)
}

beforeEach(() => { rawFetchCalls = 0; setRawFetchForTests(async () => { rawFetchCalls += 1; return new Response('{"data":[]}', { status: 200 }) }) })
afterEach(() => { installFocusEgressLock(undefined); installEgressGate(undefined); setRawFetchForTests(undefined) })

describe('F15 锁定可见性：书名、无前缀', () => {
  it('lockedProjects 列出被锁作品与书名；focus:locked-projects IPC 同值', async () => {
    const { focus, locked } = setup()
    expect(focus.lockedProjects()).toEqual([{ projectId: locked.id, title: '雾港来信' }])
    expect(await invoke('focus:locked-projects')).toEqual([{ projectId: locked.id, title: '雾港来信' }])
    focus.emergencyExit(locked.id, FOCUS_EXIT_PHRASE)
    expect(await invoke('focus:locked-projects')).toEqual([])
  })
  it('FocusLockError 序列化（Electron 的 `${error}`）只给文案，不带「FocusLockError:」', () => {
    const error = new FocusLockError('FOCUS_LOCKED', focusLockedMessage(['雾港来信']))
    expect(String(error)).toBe('《雾港来信》正在小黑屋中：锁定期间所有作品的 AI 功能都已关闭，回到《雾港来信》出屋后可用。')
    expect(userErrorMessage(new Error(`Error invoking remote method 'digests:run': FocusLockError: 旧文案`))).toBe('旧文案')
  })
  it('紧急出屋对话框：Esc 只调用关闭（不出屋），并阻止冒泡到工作区', () => {
    const calls: string[] = []
    const keyEvent = (key: string) => ({ key, isComposing: false, preventDefault: () => calls.push('prevent'), stopPropagation: () => calls.push('stop') })
    expect(handleModalEscape(keyEvent('Escape'), () => calls.push('close'))).toBe(true)
    expect(calls).toEqual(['prevent', 'stop', 'close'])
    expect(handleModalEscape(keyEvent('Enter'), () => calls.push('close'))).toBe(false)
    expect(handleModalEscape({ ...keyEvent('Escape'), isComposing: true }, () => calls.push('close'))).toBe(false)
    expect(calls).toHaveLength(3)
  })
})

describe('F15 锁定期间拒绝清单（从另一本书发起；全部拒绝是有意设计）', () => {
  it('R1 ai:start（讨论/生成/编辑/读者/一致性共用）→ error 事件 FOCUS_LOCKED，带书名，fetch 0 次', async () => {
    const { other, otherChapter } = setup()
    const listener = ipc.listeners.get('ai:start')!
    await listener(event, { requestId: 'r1', threadId: 't1', userMessageId: 'u1', assistantMessageId: 'a1', task: { mode: 'discussion', writePermission: 'none', userIntent: '聊聊', projectId: other.id, documentId: otherChapter.id } })
    expect(sent).toEqual([expect.objectContaining({ type: 'error', code: 'FOCUS_LOCKED', message: expect.stringContaining('《雾港来信》') })])
    expect(JSON.stringify(sent)).not.toMatch(/FocusLockError/)
    expect(rawFetchCalls).toBe(0)
  })
  it('R2 ai:preview-context（发送前的上下文预览）→ 拒绝', async () => {
    const { other, otherChapter } = setup()
    expectTitledNoPrefix(await rejection('ai:preview-context', { threadId: 't1', task: { mode: 'discussion', writePermission: 'none', userIntent: '聊聊', projectId: other.id, documentId: otherChapter.id } }))
    expect(rawFetchCalls).toBe(0)
  })
  it('R3 digests:run（章节理解）→ 拒绝', async () => {
    const { other, otherChapter } = setup()
    expectTitledNoPrefix(await rejection('digests:run', other.id, otherChapter.id))
    expect(rawFetchCalls).toBe(0)
  })
  it('R4 proofreading:run（AI 校对）→ 拒绝', async () => {
    const { other, otherChapter } = setup()
    expectTitledNoPrefix(await rejection('proofreading:run', other.id, otherChapter.id))
    expect(rawFetchCalls).toBe(0)
  })
  it('R5 memories:extract-intent（记忆意图抽取）→ 拒绝', async () => {
    const { other } = setup()
    expectTitledNoPrefix(await rejection('memories:extract-intent', other.id, 'msg-1', '记住：主角怕水'))
    expect(rawFetchCalls).toBe(0)
  })
  it('R6 providers:test（已保存服务测试连接）→ 拒绝', async () => {
    setup()
    expectTitledNoPrefix(await rejection('providers:test', 'p', 'mock'))
    expect(rawFetchCalls).toBe(0)
  })
  it('R7 providers:test-url（未保存地址测试连接）→ 拒绝；出屋后同一调用确实会出站（对照）', async () => {
    const { focus, locked } = setup()
    expectTitledNoPrefix(await rejection('providers:test-url', { baseUrl: 'http://localhost:11434/v1', apiKey: 'k', modelId: 'mock' }))
    expect(rawFetchCalls).toBe(0)
    focus.emergencyExit(locked.id, FOCUS_EXIT_PHRASE)
    await invoke('providers:test-url', { baseUrl: 'http://localhost:11434/v1', apiKey: 'k', modelId: 'mock' })
    expect(rawFetchCalls).toBeGreaterThan(0)
  })
  it('R8 主进程 guardedFetch（所有 Provider 适配器的唯一出口，兜底）→ EgressBlockedError focus-locked，带书名', async () => {
    setup()
    await expect(guardedFetch('http://localhost:11434/v1/models')).rejects.toMatchObject({ reason: 'focus-locked', message: expect.stringContaining('《雾港来信》') })
    expect(rawFetchCalls).toBe(0)
  })
  it('R9 渲染进程 session.webRequest：http/https/ws 一律 cancel（已保存 origin 也拒绝）；file:// 本地资源照常', () => {
    let locked = true
    const gate = new NetworkGate({ isFocusLocked: () => locked })
    gate.setSavedOrigins(['http://localhost:11434'])
    for (const url of ['http://localhost:11434/v1/models', 'https://example.com/a.png', 'wss://example.com/s']) {
      expect(gate.filter(url)).toEqual({ cancel: true })
    }
    expect(gate.getBlockedLog().every((entry) => entry.reason === 'focus-locked')).toBe(true)
    expect(gate.filter('file:///app/out/renderer/index.html')).toEqual({ cancel: false })
    locked = false
    expect(gate.filter('http://localhost:11434/v1/models')).toEqual({ cancel: false })
  })
  it('R10 window.open 外链（shell.openExternal 交系统浏览器）→ 锁定期间不打开', () => {
    expect(shouldOpenExternal('https://example.com', true)).toBe(false)
    expect(shouldOpenExternal('https://example.com', false)).toBe(true)
    expect(shouldOpenExternal('javascript:alert(1)', false)).toBe(false)
  })
})
