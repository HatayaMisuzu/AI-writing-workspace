import { guardedFetch } from '../net/egress-guard'
import type { AppErrorShape } from '../../shared/domain'
import { redactSecretsInText } from '../../shared/base-url'
import { DEFAULT_MAX_OUTPUT, defaultTimeoutsForBaseUrl } from '../../shared/provider-presets'
import {
  deadlineSignal, endpointUrl, providerError, requireValidBaseUrl, toNetworkError,
  type ProviderAdapter, type ProviderChatInput, type ProviderMessage
} from './provider'

/** P1-7：Anthropic Messages API 版本头（固定值，随请求发送）。 */
export const ANTHROPIC_VERSION = '2023-06-01'
/** 模型未配置 max_output 时的 max_tokens 缺省值（与设置页“最大输出”缺省 DEFAULT_MAX_OUTPUT=4096 一致）。 */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = DEFAULT_MAX_OUTPUT

type AnthropicRole = 'user' | 'assistant'
const isCoded = (error: unknown): error is AppErrorShape & Error => error instanceof Error && typeof (error as Error & { code?: unknown }).code === 'string'

/** system 抽成单独参数；tool 视作 user；相邻同角色合并（Messages API 要求 user/assistant 交替且以 user 开头）。 */
export function toAnthropicPayload(messages: ProviderMessage[]): { system?: string; messages: Array<{ role: AnthropicRole; content: string }> } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).filter((c) => c.trim()).join('\n\n')
  const out: Array<{ role: AnthropicRole; content: string }> = []
  for (const message of messages) {
    if (message.role === 'system') continue
    const role: AnthropicRole = message.role === 'assistant' ? 'assistant' : 'user'
    const last = out[out.length - 1]
    if (last && last.role === role) last.content = `${last.content}\n\n${message.content}`
    else out.push({ role, content: message.content })
  }
  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: '（继续）' })
  return { ...(system ? { system } : {}), messages: out }
}

const ERROR_TYPES: Record<string, [string, string]> = {
  authentication_error: ['PROVIDER_UNAUTHORIZED', '凭据无效，请检查 API Key 后重试。'],
  permission_error: ['PROVIDER_FORBIDDEN', '当前 API Key 无权使用该模型或资源。'],
  not_found_error: ['PROVIDER_NOT_FOUND', '找不到该模型或接口，请检查 Base URL 与 Model ID。'],
  rate_limit_error: ['PROVIDER_RATE_LIMITED', '请求过于频繁或额度不足，请稍后重试。'],
  overloaded_error: ['PROVIDER_OVERLOADED', '模型服务当前过载，请稍后重试。'],
  invalid_request_error: ['PROVIDER_INVALID_REQUEST', '请求参数无效，请检查模型 ID 与最大输出设置。'],
  request_too_large: ['PROVIDER_REQUEST_TOO_LARGE', '请求内容过大，请缩小上下文后重试。'],
  api_error: ['PROVIDER_SERVER_ERROR', '模型服务内部错误，请稍后重试。']
}
const STATUS_TYPES: Record<number, string> = {
  400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error',
  413: 'request_too_large', 429: 'rate_limit_error', 500: 'api_error', 529: 'overloaded_error'
}

/** Anthropic 错误类型 → 统一 code + 中文提示；供应商原文脱敏后只放 details。 */
export function anthropicError(type: string | undefined, status?: number, detail?: string): AppErrorShape & Error {
  const resolved = (type && ERROR_TYPES[type]) ? type : status !== undefined ? STATUS_TYPES[status] : undefined
  const [code, message] = (resolved && ERROR_TYPES[resolved])
    ?? ['PROVIDER_HTTP_ERROR', status !== undefined ? `模型服务返回 HTTP ${status}。` : '模型服务返回流错误。']
  return Object.assign(new Error(message), { code, recoverable: true, ...(detail ? { details: redactSecretsInText(detail).replace(/\b(sk-[\w-]{6,}|[A-Za-z0-9_-]{32,})/g, '***') } : {}) })
}

async function errorFromResponse(response: Response): Promise<AppErrorShape & Error> {
  let type: string | undefined; let detail: string | undefined
  try {
    const json = await response.json() as { error?: { type?: string; message?: string } }
    type = json.error?.type; detail = json.error?.message
  } catch { /* 非 JSON 错误体：按状态码归一 */ }
  return anthropicError(type, response.status, detail)
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly providerType = 'anthropic' as const
  private readonly baseUrl: string
  constructor(baseUrl: string, private readonly apiKey: string, private readonly fetcher: typeof fetch = guardedFetch) { this.baseUrl = requireValidBaseUrl(baseUrl) }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION }
    if (this.apiKey) headers['x-api-key'] = this.apiKey
    return headers
  }

  private body(input: ProviderChatInput, stream: boolean): string {
    const maxTokens = input.maxTokens && input.maxTokens > 0 ? Math.floor(input.maxTokens) : ANTHROPIC_DEFAULT_MAX_TOKENS
    return JSON.stringify({ model: input.model, ...toAnthropicPayload(input.messages), max_tokens: maxTokens, stream })
  }

  async *chat(input: ProviderChatInput): AsyncIterable<string> {
    const defaults = defaultTimeoutsForBaseUrl(this.baseUrl)
    const request = deadlineSignal(input.signal, input.timeoutMs ?? defaults.totalTimeoutMs)
    const firstTokenMs = input.firstTokenTimeoutMs ?? defaults.firstTokenTimeoutMs
    let response: Response
    try {
      response = await this.fetcher(endpointUrl(this.baseUrl, 'messages'), { method: 'POST', headers: this.headers(), body: this.body(input, true), signal: request.signal })
    } catch (error) {
      request.dispose()
      throw toNetworkError(this.baseUrl, error, request.signal)
    }
    if (!response.ok) { const error = await errorFromResponse(response).finally(() => request.dispose()); throw error }
    if (!response.body) { request.dispose(); throw providerError('PROVIDER_PROTOCOL_ERROR', '模型服务没有返回响应流。') }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''; let sawStop = false; let gotFirst = false
    const usage: { inputTokens?: number; outputTokens?: number } = {}
    const firstTimer = setTimeout(() => {
      if (!gotFirst) {
        void reader.cancel().catch(() => undefined)
        request.fail(providerError('PROVIDER_FIRST_TOKEN_TIMEOUT', '等待模型首个输出超时，请重试。'))
      }
    }, firstTokenMs)
    try {
      while (!sawStop) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const events = buffer.split(/\r?\n\r?\n/)
        buffer = events.pop() ?? ''
        for (const event of events) {
          const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
          if (!data) continue
          let json: { type?: string; delta?: { type?: string; text?: string }; usage?: { input_tokens?: number; output_tokens?: number }
            message?: { usage?: { input_tokens?: number; output_tokens?: number } }; error?: { type?: string; message?: string } }
          try { json = JSON.parse(data) } catch { throw providerError('PROVIDER_PROTOCOL_ERROR', '模型服务返回了无效 SSE 数据。') }
          switch (json.type) {
            case 'message_start':
              usage.inputTokens = json.message?.usage?.input_tokens ?? usage.inputTokens
              usage.outputTokens = json.message?.usage?.output_tokens ?? usage.outputTokens
              break
            case 'content_block_delta': {
              const text = json.delta?.type === 'text_delta' ? json.delta.text : undefined
              if (text) {
                if (!gotFirst) { gotFirst = true; clearTimeout(firstTimer) }
                yield text
              }
              break
            }
            case 'message_delta':
              if (json.usage?.output_tokens !== undefined) usage.outputTokens = json.usage.output_tokens
              if (json.usage?.input_tokens !== undefined) usage.inputTokens = json.usage.input_tokens
              break
            case 'message_stop': sawStop = true; break
            case 'error': throw anthropicError(json.error?.type, undefined, json.error?.message)
            case 'ping': case 'content_block_start': case 'content_block_stop': break
            default: break // 未来新增事件类型：忽略（官方版本策略要求客户端容忍未知事件）
          }
          if (sawStop) break
        }
      }
      if (!sawStop) {
        if (request.signal.aborted && isCoded(request.signal.reason)) throw request.signal.reason
        throw providerError('PROVIDER_UNEXPECTED_EOF', '模型流在完成标记前中断。')
      }
      input.onUsage?.(usage)
    } catch (error) {
      if (request.signal.aborted && isCoded(request.signal.reason)) throw request.signal.reason
      if (isCoded(error)) throw error
      throw toNetworkError(this.baseUrl, error, request.signal)
    } finally {
      clearTimeout(firstTimer)
      try { await reader.cancel() } catch { /* already closed */ }
      try { reader.releaseLock() } catch { /* already released */ }
      request.dispose()
    }
  }

  async complete(input: ProviderChatInput): Promise<string> {
    const defaults = defaultTimeoutsForBaseUrl(this.baseUrl)
    const request = deadlineSignal(input.signal, input.timeoutMs ?? defaults.totalTimeoutMs)
    try {
      const response = await this.fetcher(endpointUrl(this.baseUrl, 'messages'), { method: 'POST', headers: this.headers(), body: this.body(input, false), signal: request.signal })
      if (!response.ok) throw await errorFromResponse(response)
      const payload = await response.json() as { type?: string; error?: { type?: string; message?: string }; content?: Array<{ type?: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } }
      if (payload.type === 'error') throw anthropicError(payload.error?.type, undefined, payload.error?.message)
      const content = (payload.content ?? []).filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('')
      if (!content.trim()) throw providerError('PROVIDER_PROTOCOL_ERROR', '模型服务没有返回有效消息。')
      input.onUsage?.({ inputTokens: payload.usage?.input_tokens, outputTokens: payload.usage?.output_tokens })
      return content
    } catch (error) {
      if (isCoded(error)) throw error
      throw toNetworkError(this.baseUrl, error, request.signal)
    } finally { request.dispose() }
  }

  async testConnection(model: string, signal?: AbortSignal): Promise<{ ok: boolean; message?: string }> {
    try {
      // 测试连接只要极少输出，避免消耗额度
      await this.complete({ model, messages: [{ role: 'user', content: 'Reply with OK.' }], signal, maxTokens: 16 })
      return { ok: true }
    } catch (error) {
      return { ok: false, message: (isCoded(error) ? error : toNetworkError(this.baseUrl, error, signal)).message }
    }
  }
}
