import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ANTHROPIC_DEFAULT_MAX_TOKENS, ANTHROPIC_VERSION, AnthropicAdapter, toAnthropicPayload } from '../src/main/ai/anthropic-adapter'
import { createProviderAdapter, OpenAICompatibleAdapter, withModelMaxTokens, ProviderService, type ProviderUsage } from '../src/main/ai/provider'
import { AICreativeRuntime } from '../src/main/ai/runtime'
import { ChatService } from '../src/main/services/chat-service'
import { DocumentService } from '../src/main/services/document-service'
import { ProjectService } from '../src/main/services/project-service'
import { providerInputSchema } from '../src/main/ipc/schemas'
import { createTestDb, testCodec } from './helpers'
import { installEgressGate } from '../src/main/net/egress-guard'
import { NetworkGate } from '../src/main/network-policy'

// P1-7：本地假 Anthropic SSE 服务器（127.0.0.1，随机端口）；不访问任何真实供应商。
type Captured = { url: string; headers: IncomingMessage['headers']; body: Record<string, unknown> }
type Scenario = (req: Captured, res: ServerResponse) => void
let server: Server; let base = ''; const captured: Captured[] = []; let scenario: Scenario = () => undefined

const sse = (type: string, data: Record<string, unknown>): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
const okStream = (texts: string[]): Scenario => (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(sse('message_start', { message: { id: 'msg_1', usage: { input_tokens: 42, output_tokens: 1 } } }))
  res.write(sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }))
  res.write(sse('ping', {}))
  for (const text of texts) res.write(sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }))
  res.write(sse('content_block_stop', { index: 0 }))
  res.write(sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }))
  res.end(sse('message_stop', {}))
}
const jsonError = (status: number, type: string): Scenario => (_req, res) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'error', error: { type, message: `upstream ${type} sk-ant-secret123456789` } }))
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const entry = { url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) as Record<string, unknown> : {} }
      captured.push(entry); scenario(entry, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  // P3-1：主进程出站经守门；本地假服务器视为已保存 Provider
  const gate = new NetworkGate(); gate.setSavedOrigins([new URL(base).origin]); installEgressGate(gate)
})
afterAll(async () => {
  installEgressGate(undefined); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) })

const collect = async (adapter: AnthropicAdapter, extra: Partial<Parameters<AnthropicAdapter['chat']>[0]> = {}): Promise<string> => {
  let out = ''
  for await (const chunk of adapter.chat({ model: 'claude-test', messages: [{ role: 'system', content: '你是写作助手' }, { role: 'user', content: '写一句' }], ...extra })) out += chunk
  return out
}

describe('P1-7 Anthropic 原生适配器（本地假 SSE 服务器）', () => {
  it('正常流式：拼接 text_delta、回报用量；请求头/体符合 Messages API', async () => {
    scenario = okStream(['风从', '门缝里', '进来。']); captured.length = 0
    const usage: ProviderUsage[] = []
    const text = await collect(new AnthropicAdapter(base, 'test-key'), { maxTokens: 1234, onUsage: (u) => usage.push(u) })
    expect(text).toBe('风从门缝里进来。')
    expect(usage).toEqual([{ inputTokens: 42, outputTokens: 7 }])
    const [req] = captured
    expect(req.url).toBe('/v1/messages')
    expect(req.headers['x-api-key']).toBe('test-key')
    expect(req.headers['anthropic-version']).toBe(ANTHROPIC_VERSION)
    expect(req.headers.authorization).toBeUndefined()
    expect(req.body).toEqual({ model: 'claude-test', system: '你是写作助手', messages: [{ role: 'user', content: '写一句' }], max_tokens: 1234, stream: true })
  })

  it('max_tokens 缺省取 DEFAULT_MAX_OUTPUT；无 system 时不发 system；空 key 不发 x-api-key', async () => {
    scenario = okStream(['好']); captured.length = 0
    const adapter = new AnthropicAdapter(base, '')
    let out = ''
    for await (const chunk of adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] })) out += chunk
    expect(out).toBe('好')
    expect(captured[0].body.max_tokens).toBe(ANTHROPIC_DEFAULT_MAX_TOKENS)
    expect('system' in captured[0].body).toBe(false)
    expect(captured[0].headers['x-api-key']).toBeUndefined()
  })

  it('消息转换：多条 system 合并为单独参数，相邻同角色合并，tool 归为 user', () => {
    expect(toAnthropicPayload([{ role: 'system', content: 'A' }, { role: 'user', content: 'u1' }, { role: 'tool', content: 't' }, { role: 'system', content: 'B' }, { role: 'assistant', content: 'a' }]))
      .toEqual({ system: 'A\n\nB', messages: [{ role: 'user', content: 'u1\n\nt' }, { role: 'assistant', content: 'a' }] })
  })

  it('取消：中途 abort 抛 PROVIDER_CANCELLED', async () => {
    scenario = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sse('message_start', { message: { usage: { input_tokens: 1 } } }))
      res.write(sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '一' } }))
      // 不结束，等待客户端取消
    }
    const controller = new AbortController()
    const chunks: string[] = []
    await expect((async () => {
      for await (const chunk of new AnthropicAdapter(base, 'k').chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], signal: controller.signal })) {
        chunks.push(chunk); controller.abort()
      }
    })()).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' })
    expect(chunks).toEqual(['一'])
  })

  it('首 token 超时沿用统一错误码', async () => {
    scenario = (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(sse('ping', {})) }
    await expect(collect(new AnthropicAdapter(base, 'k'), { firstTokenTimeoutMs: 50 })).rejects.toMatchObject({ code: 'PROVIDER_FIRST_TOKEN_TIMEOUT' })
  })

  it.each([
    [401, 'authentication_error', 'PROVIDER_UNAUTHORIZED', '凭据无效'],
    [429, 'rate_limit_error', 'PROVIDER_RATE_LIMITED', '请求过于频繁'],
    [529, 'overloaded_error', 'PROVIDER_OVERLOADED', '过载'],
    [400, 'invalid_request_error', 'PROVIDER_INVALID_REQUEST', '请求参数无效']
  ])('HTTP %i %s（JSON 错误体）归一为中文提示，原文脱敏仅进 details', async (status, type, code, text) => {
    scenario = jsonError(status, type)
    const error = await collect(new AnthropicAdapter(base, 'k')).catch((e: unknown) => e) as Error & { code: string; details?: string }
    expect(error.code).toBe(code); expect(error.message).toContain(text)
    expect(error.message).not.toContain('upstream'); expect(error.details).not.toContain('secret123456789')
  })

  it('非 JSON 错误体按状态码归一', async () => {
    scenario = (_req, res) => { res.writeHead(529, { 'content-type': 'text/plain' }); res.end('busy') }
    await expect(collect(new AnthropicAdapter(base, 'k'))).rejects.toMatchObject({ code: 'PROVIDER_OVERLOADED' })
  })

  it('流内 error 事件（overloaded）归一', async () => {
    scenario = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sse('message_start', { message: { usage: { input_tokens: 1 } } }))
      res.end(sse('error', { error: { type: 'overloaded_error', message: 'Overloaded' } }))
    }
    await expect(collect(new AnthropicAdapter(base, 'k'))).rejects.toMatchObject({ code: 'PROVIDER_OVERLOADED', message: '模型服务当前过载，请稍后重试。' })
  })

  it('缺 message_stop 视为意外中断', async () => {
    scenario = (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(sse('content_block_delta', { delta: { type: 'text_delta', text: '半' } })) }
    await expect(collect(new AnthropicAdapter(base, 'k'))).rejects.toMatchObject({ code: 'PROVIDER_UNEXPECTED_EOF' })
  })

  it('非流式 complete 与测试连接：成功、401 JSON 错误体', async () => {
    scenario = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 3, output_tokens: 1 } })) }
    captured.length = 0
    expect(await new AnthropicAdapter(base, 'k').testConnection('claude-test')).toEqual({ ok: true })
    expect(captured[0].body).toMatchObject({ model: 'claude-test', stream: false, max_tokens: 16 })
    expect(captured[0].headers['anthropic-version']).toBe(ANTHROPIC_VERSION)
    scenario = jsonError(401, 'authentication_error')
    expect(await createProviderAdapter('anthropic', base, 'bad').testConnection('claude-test')).toEqual({ ok: false, message: '凭据无效，请检查 API Key 后重试。' })
  })

  it('工厂：未知/缺省类型回落 openai-compatible；IPC schema 接受 anthropic', () => {
    expect(createProviderAdapter(undefined, base, '')).toBeInstanceOf(OpenAICompatibleAdapter)
    expect(createProviderAdapter('anthropic', base, '')).toBeInstanceOf(AnthropicAdapter)
    const openai = createProviderAdapter('openai-compatible', base, '')
    expect(withModelMaxTokens(openai, 'openai-compatible', 999)).toBe(openai) // OpenAI 兼容请求体不变
    expect(providerInputSchema.safeParse({ id: 'p', providerType: 'anthropic', displayName: 'A', baseUrl: base }).success).toBe(true)
    expect(providerInputSchema.safeParse({ id: 'p', providerType: 'gemini', displayName: 'A', baseUrl: base }).success).toBe(false)
  })

  it('集成：runtime 走 Anthropic（真实适配器 + 假服务器），续写只产出候选，正文不变，max_tokens=模型 max_output', async () => {
    scenario = okStream(['风沿着门缝', '钻进来。']); captured.length = 0
    const db = createTestDb(); const project = new ProjectService(db).create({ title: 'P1-7', projectType: 'novel' })
    const docs = new DocumentService(db); const chapter = docs.listOrderedChapters(project.id)[0]
    docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc' }, plainText: '风从门缝里进来。' })
    const providers = new ProviderService(db, testCodec)
    providers.save({ id: 'pa', providerType: 'anthropic', displayName: '作者配置的 Anthropic 端点', baseUrl: base, apiKey: 'author-key' })
    expect(providers.list()[0].providerType).toBe('anthropic')
    providers.saveModel({ id: 'ma', providerId: 'pa', modelId: 'claude-author', displayName: 'C', enabled: true, isDefault: true, maxOutput: 2048, contextWindow: 32_000,
      capabilities: { streaming: true, tools: false, structuredOutput: false, cancellation: true } })
    const runtime = new AICreativeRuntime(db, providers)
    const thread = new ChatService(db).createThread(project.id, 't')
    let candidates: string[] | undefined
    for await (const event of runtime.run('r1', { mode: 'generation', writePermission: 'proposal', userIntent: '续写一句', projectId: project.id, documentId: chapter.id }, thread.id, 'u1', 'a1'))
      if (event.candidates) candidates = event.candidates
    expect(candidates).toEqual(['风沿着门缝钻进来。'])
    expect(docs.getContent(project.id, chapter.id).plainText).toBe('风从门缝里进来。')
    const body = captured[0].body as { system?: string; messages: Array<{ role: string; content: string }>; max_tokens: number; model: string }
    expect(captured[0].headers['x-api-key']).toBe(providers.getWithSecret('pa').apiKey)
    expect(body.model).toBe('claude-author'); expect(body.max_tokens).toBe(2048)
    expect(typeof body.system).toBe('string'); expect(body.messages.every((m) => m.role !== 'system')).toBe(true)
    expect(body.messages.at(-1)?.content).toContain('续写一句')
  })
})
