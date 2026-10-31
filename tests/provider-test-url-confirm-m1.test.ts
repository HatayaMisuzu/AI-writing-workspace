/**
 * A·M1：测试连接时，地址与上次保存的不同 → main 进程先弹原生确认框，确认后才带 API Key 发请求。
 * 用真实 registerIpc（electron 以内存桩替代，dialog.showMessageBox 打桩），底层 fetch 打桩记录每次请求的 URL 与头。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  dialogCalls: [] as Array<{ message: string; detail: string; buttons: string[]; cancelId: number; defaultId: number }>,
  dialogResponse: 0
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => { ipc.handlers.set(channel, fn) },
    on: () => {}
  },
  BrowserWindow: { getFocusedWindow: () => null, fromWebContents: () => null, getAllWindows: () => [] },
  dialog: {
    showMessageBox: async (...args: unknown[]) => {
      const options = (args.length > 1 ? args[1] : args[0]) as { message: string; detail: string; buttons: string[]; cancelId: number; defaultId: number }
      ipc.dialogCalls.push(options)
      return { response: ipc.dialogResponse, checkboxChecked: false }
    }
  },
  app: { getPath: () => '/tmp' }
}))

import { createTestDb, testCodec } from './helpers'
import { registerIpc } from '../src/main/ipc/register'
import { ProviderService } from '../src/main/ai/provider'
import { installEgressGate, setRawFetchForTests } from '../src/main/net/egress-guard'
import { baseUrlKeyDecision, normalizeBaseUrlForCompare } from '../src/main/ai/base-url-confirm'

const frame = { url: 'file:///app/out/renderer/index.html' }
const event = { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false, send: () => {} } }
const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const fn = ipc.handlers.get(channel)
  if (!fn) throw new Error(`no handler ${channel}`)
  return fn(event, ...args)
}
type Req = { url: string; authorization?: string; apiKeyHeader?: string }
const requests: Req[] = []
const SAVED = 'https://api.saved.example/v1'
const OTHER = 'https://evil.other.example/v1'
const SECRET = 'sk-saved-secret'

const setup = () => {
  ipc.handlers.clear(); ipc.dialogCalls.length = 0; ipc.dialogResponse = 0; requests.length = 0
  const db = createTestDb()
  const providers = new ProviderService(db, testCodec)
  providers.save({ id: 'p', providerType: 'openai-compatible', displayName: '已存服务', baseUrl: SAVED, apiKey: SECRET })
  registerIpc(db, testCodec, { refreshNetworkAllowlist: () => {}, allowOriginTemporarily: () => () => {}, getBlockedLog: () => [] })
  installEgressGate({ decide: () => ({ allow: true }) })
}
beforeEach(() => {
  setRawFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    requests.push({ url: String(input instanceof Request ? input.url : input), authorization: headers.get('authorization') ?? undefined, apiKeyHeader: headers.get('x-api-key') ?? undefined })
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch)
})
afterEach(() => { installEgressGate(undefined); setRawFetchForTests(undefined) })

const testUrl = (input: Record<string, unknown>) => invoke('providers:test-url', { modelId: 'm', ...input }) as Promise<{ ok: boolean; message?: string; cancelled?: boolean }>

describe('A·M1 规范化与判定', () => {
  it('规范化：大小写主机、默认端口、末尾斜杠视为同一地址；path/query/端口不同视为不同', () => {
    expect(normalizeBaseUrlForCompare(' HTTPS://API.Saved.Example:443/v1/ ')).toBe(SAVED)
    expect(baseUrlKeyDecision('https://API.saved.example/v1/', SAVED)).toEqual({ needsConfirm: false, reason: 'same' })
    expect(baseUrlKeyDecision('https://api.saved.example/v2', SAVED).needsConfirm).toBe(true)
    expect(baseUrlKeyDecision('https://api.saved.example:8443/v1', SAVED).needsConfirm).toBe(true)
    expect(baseUrlKeyDecision('http://api.saved.example/v1', SAVED).needsConfirm).toBe(true)
    expect(baseUrlKeyDecision('https://api.saved.example/v1?x=1', SAVED).needsConfirm).toBe(true)
    expect(baseUrlKeyDecision(SAVED, undefined)).toEqual({ needsConfirm: true, reason: 'no-saved' })
  })
})

describe('A·M1 providers:test-url 确认闸门（main 侧）', () => {
  it('地址没变：不弹确认，直接带已保存 Key 发往已保存地址', async () => {
    setup()
    const result = await testUrl({ baseUrl: `${SAVED}/`, providerId: 'p' })
    expect(result.ok).toBe(true)
    expect(ipc.dialogCalls).toHaveLength(0)
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every((r) => r.url.startsWith(SAVED) && r.authorization === `Bearer ${SECRET}`)).toBe(true)
  })

  it('地址变了、作者取消：零请求、无 Authorization；返回 cancelled，文案说明 Key 未发送', async () => {
    setup()
    ipc.dialogResponse = 0
    const result = await testUrl({ baseUrl: OTHER, apiKey: 'sk-typed', providerId: 'p' })
    expect(result).toEqual({ ok: false, cancelled: true, message: '已取消测试连接，API Key 未发送。' })
    expect(ipc.dialogCalls).toHaveLength(1)
    expect(requests).toHaveLength(0)
    const box = ipc.dialogCalls[0]
    expect(box.buttons).toEqual(['取消', '确认发送'])
    expect(box.cancelId).toBe(0); expect(box.defaultId).toBe(0)
    expect(box.message).toContain('API Key 将发往新地址')
    expect(box.detail).toContain(`上次保存的地址：${SAVED}`)
    expect(box.detail).toContain(`本次测试的地址：${OTHER}`)
  })

  it('同主机换路径、Key 栏留空（沿用已存 Key）：取消时已存 Key 也不发出', async () => {
    setup()
    const result = await testUrl({ baseUrl: 'https://api.saved.example/v2', providerId: 'p' })
    expect(result.cancelled).toBe(true)
    expect(ipc.dialogCalls).toHaveLength(1)
    expect(requests).toHaveLength(0)
  })

  it('绕过界面直接调 IPC（未经确认）：main 仍弹框，未确认就不发', async () => {
    setup()
    const result = await invoke('providers:test-url', { baseUrl: OTHER, apiKey: 'sk-typed', modelId: 'm' }) as { cancelled?: boolean }
    expect(result.cancelled).toBe(true)
    expect(requests).toHaveLength(0)
    // 额外字段（伪造「已确认」）被 zod 忽略：照样弹框，未确认就不发
    const forged = await invoke('providers:test-url', { baseUrl: OTHER, apiKey: 'sk-typed', modelId: 'm', confirmed: true }) as { cancelled?: boolean }
    expect(forged.cancelled).toBe(true)
    expect(ipc.dialogCalls).toHaveLength(2)
    expect(requests).toHaveLength(0)
  })

  it('确认后才发，且只发往确认框里展示的那个地址', async () => {
    setup()
    ipc.dialogResponse = 1
    const result = await testUrl({ baseUrl: 'HTTPS://Evil.Other.Example/v1/', apiKey: 'sk-typed', providerId: 'p' })
    expect(result.ok).toBe(true)
    expect(ipc.dialogCalls).toHaveLength(1)
    expect(ipc.dialogCalls[0].detail).toContain(`本次测试的地址：${OTHER}`)
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every((r) => r.url.startsWith(OTHER) && r.authorization === 'Bearer sk-typed')).toBe(true)
  })

  it('每次都重新确认：上次确认不能复用到下一次（同地址或另一地址）', async () => {
    setup()
    ipc.dialogResponse = 1
    await testUrl({ baseUrl: OTHER, apiKey: 'sk-typed', providerId: 'p' })
    const sent = requests.length
    ipc.dialogResponse = 0
    expect((await testUrl({ baseUrl: OTHER, apiKey: 'sk-typed', providerId: 'p' })).cancelled).toBe(true)
    expect((await testUrl({ baseUrl: 'https://third.example/v1', apiKey: 'sk-typed', providerId: 'p' })).cancelled).toBe(true)
    expect(ipc.dialogCalls).toHaveLength(3)
    expect(requests).toHaveLength(sent)
  })

  it('换了主机且 Key 栏留空：不带已存 Key（同 S1d-A2），无 Key 可发也就不弹框', async () => {
    setup()
    await testUrl({ baseUrl: OTHER, providerId: 'p' })
    expect(ipc.dialogCalls).toHaveLength(0)
    expect(requests.every((r) => r.authorization === undefined)).toBe(true)
    expect(requests.some((r) => r.authorization?.includes(SECRET))).toBe(false)
  })

  it('首次保存前（无已保存地址）带 Key 测试：按安全侧也要确认；取消则零请求', async () => {
    setup()
    const result = await testUrl({ baseUrl: OTHER, apiKey: 'sk-new', providerType: 'anthropic' })
    expect(result.cancelled).toBe(true)
    expect(ipc.dialogCalls).toHaveLength(1)
    expect(ipc.dialogCalls[0].message).toContain('还没有保存过')
    expect(requests).toHaveLength(0)
  })

  it('确认框里的地址脱敏：query 密钥参数不显示', async () => {
    setup()
    await testUrl({ baseUrl: 'https://evil.other.example/v1?api_key=leak123', apiKey: 'sk-typed', providerId: 'p' })
    expect(ipc.dialogCalls[0].detail).not.toContain('leak123')
    expect(requests).toHaveLength(0)
  })

  it('已保存服务 providers:test（地址就是已保存值）照旧不弹框', async () => {
    setup()
    await invoke('providers:test', 'p', 'm')
    expect(ipc.dialogCalls).toHaveLength(0)
    expect(requests.every((r) => r.url.startsWith(SAVED))).toBe(true)
  })
})
