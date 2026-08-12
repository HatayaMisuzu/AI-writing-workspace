import type { AppErrorShape, ModelConfig, ProviderCapabilities, ProviderConfig, ProviderInput, RoutedTask } from '../../shared/domain'
import type { AppDatabase } from '../database/database'
import { randomUUID } from 'node:crypto'

export interface SecretCodec {
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

type ProviderRow = { id: string; provider_type: 'openai-compatible'; display_name: string; base_url: string; encrypted_api_key: Buffer | null; created_at: number; updated_at: number }

const normalizeBaseUrl = (url: string): string => url.trim().replace(/\/+$/, '')
export const adapterCapabilities: ProviderCapabilities = { streaming: true, tools: false, structuredOutput: false, cancellation: true }
const truthfulCapabilities = (capabilities: ProviderCapabilities): ProviderCapabilities => ({ ...capabilities, tools: false, structuredOutput: false, streaming: true, cancellation: true })
export const routedTasks: RoutedTask[] = ['discussion', 'brainstorm', 'generation', 'editing', 'organization', 'chapter_digest', 'proofreading']

export class ProviderService {
  constructor(private readonly db: AppDatabase, private readonly codec: SecretCodec) {}

  list(): ProviderConfig[] {
    const rows = this.db.raw.prepare('SELECT * FROM provider_configs ORDER BY updated_at DESC').all() as ProviderRow[]
    return rows.map((row) => ({ id: row.id, providerType: row.provider_type, displayName: row.display_name,
      baseUrl: row.base_url, hasApiKey: Boolean(row.encrypted_api_key), createdAt: row.created_at, updatedAt: row.updated_at }))
  }

  save(input: ProviderInput): ProviderConfig {
    const existing = this.db.raw.prepare('SELECT * FROM provider_configs WHERE id = ?').get(input.id) as ProviderRow | undefined
    const now = Date.now()
    const encrypted = input.apiKey ? this.codec.encrypt(input.apiKey) : existing?.encrypted_api_key ?? null
    this.db.raw.prepare(`INSERT INTO provider_configs
      (id, provider_type, display_name, base_url, encrypted_api_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET provider_type=excluded.provider_type, display_name=excluded.display_name,
      base_url=excluded.base_url, encrypted_api_key=excluded.encrypted_api_key, updated_at=excluded.updated_at`)
      .run(input.id || randomUUID(), input.providerType, input.displayName.trim(), normalizeBaseUrl(input.baseUrl), encrypted, existing?.created_at ?? now, now)
    return this.list().find((item) => item.id === input.id) ?? this.list()[0]
  }

  getWithSecret(providerId: string): { config: ProviderConfig; apiKey: string } {
    const row = this.db.raw.prepare('SELECT * FROM provider_configs WHERE id = ?').get(providerId) as ProviderRow | undefined
    if (!row) throw new Error('PROVIDER_NOT_FOUND')
    if (!row.encrypted_api_key) throw new Error('PROVIDER_KEY_MISSING')
    return {
      config: { id: row.id, providerType: row.provider_type, displayName: row.display_name, baseUrl: row.base_url,
        hasApiKey: true, createdAt: row.created_at, updatedAt: row.updated_at },
      apiKey: this.codec.decrypt(row.encrypted_api_key)
    }
  }

  listModels(): ModelConfig[] {
    const rows = this.db.raw.prepare('SELECT * FROM model_configs ORDER BY is_default DESC, display_name').all() as Array<Record<string, unknown>>
    return rows.map((row) => ({ id: row.id as string, providerId: row.provider_id as string, modelId: row.model_id as string,
      displayName: row.display_name as string, capabilities: truthfulCapabilities(JSON.parse(row.capabilities_json as string) as ProviderCapabilities),
      enabled: Boolean(row.enabled), isDefault: Boolean(row.is_default) }))
  }

  saveModel(model: ModelConfig): ModelConfig {
    if (model.isDefault) this.db.raw.prepare('UPDATE model_configs SET is_default = 0').run()
    this.db.raw.prepare(`INSERT INTO model_configs
      (id, provider_id, model_id, display_name, capabilities_json, enabled, is_default)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET provider_id=excluded.provider_id, model_id=excluded.model_id,
        display_name=excluded.display_name, capabilities_json=excluded.capabilities_json,
        enabled=excluded.enabled, is_default=excluded.is_default`)
      .run(model.id || randomUUID(), model.providerId, model.modelId, model.displayName, JSON.stringify(truthfulCapabilities(model.capabilities)), model.enabled ? 1 : 0, model.isDefault ? 1 : 0)
    if (!model.enabled) this.db.raw.prepare("UPDATE task_model_routes SET model_id = 'default' WHERE model_id = ?").run(model.id)
    return this.listModels().find((item) => item.id === model.id) ?? this.listModels()[0]
  }

  route(taskType: string): ModelConfig {
    const route = this.db.raw.prepare('SELECT model_id FROM task_model_routes WHERE task_type = ?').get(taskType) as { model_id: string } | undefined
    if (route && route.model_id !== 'default') {
      const routed = this.listModels().find((model) => model.id === route.model_id && model.enabled)
      if (routed) return routed
    }
    const model = this.listModels().find((item) => item.isDefault && item.enabled)
    if (!model) throw new Error('DEFAULT_MODEL_NOT_CONFIGURED')
    return model
  }

  listRoutes(): Record<RoutedTask, string | 'default'> {
    const rows = this.db.raw.prepare('SELECT task_type, model_id FROM task_model_routes').all() as Array<{ task_type: string; model_id: string }>
    const enabledIds = new Set(this.listModels().filter((model) => model.enabled).map((model) => model.id))
    return Object.fromEntries(routedTasks.map((task) => {
      const configured = rows.find((row) => row.task_type === task)?.model_id ?? 'default'
      return [task, configured === 'default' || enabledIds.has(configured) ? configured : 'default']
    })) as Record<RoutedTask, string | 'default'>
  }

  setRoute(taskType: RoutedTask, modelId: string | 'default'): void {
    if (!routedTasks.includes(taskType)) throw new Error('MODEL_ROUTE_TASK_UNSUPPORTED')
    if (modelId !== 'default' && !this.listModels().some((model) => model.id === modelId && model.enabled)) throw new Error('MODEL_ROUTE_MODEL_UNAVAILABLE')
    this.db.raw.prepare(`INSERT INTO task_model_routes(task_type, model_id) VALUES (?, ?)
      ON CONFLICT(task_type) DO UPDATE SET model_id=excluded.model_id`).run(taskType, modelId)
  }
}

export interface ProviderMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string }

export class OpenAICompatibleAdapter {
  constructor(private readonly baseUrl: string, private readonly apiKey: string, private readonly fetcher: typeof fetch = fetch) {}

  async *chat(input: { model: string; messages: ProviderMessage[]; signal?: AbortSignal }): AsyncIterable<string> {
    let response: Response
    try {
      response = await this.fetcher(`${normalizeBaseUrl(this.baseUrl)}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: input.model, messages: input.messages, stream: true }), signal: input.signal
      })
    } catch (error) {
      throw this.toNetworkError(error, input.signal)
    }
    if (!response.ok) throw this.toError(response.status)
    if (!response.body) throw new Error('EMPTY_RESPONSE_BODY')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const events = buffer.split('\n\n')
        buffer = events.pop() ?? ''
        for (const event of events) {
          for (const line of event.split('\n')) {
            if (!line.startsWith('data:')) continue
            const data = line.slice(5).trim()
            if (data === '[DONE]') return
            try {
              const json = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }
              const text = json.choices?.[0]?.delta?.content
              if (text) yield text
            } catch { /* Ignore provider heartbeat/non-JSON lines. */ }
          }
        }
      }
    } catch (error) { throw this.toNetworkError(error, input.signal) }
    finally { reader.releaseLock() }
  }

  async complete(input: { model: string; messages: ProviderMessage[]; signal?: AbortSignal }): Promise<string> {
    let response: Response
    try {
      response = await this.fetcher(`${normalizeBaseUrl(this.baseUrl)}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: input.model, messages: input.messages, stream: false }), signal: input.signal
      })
    } catch (error) { throw this.toNetworkError(error, input.signal) }
    if (!response.ok) throw this.toError(response.status)
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
    const content = payload.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) throw new Error('EMPTY_PROVIDER_MESSAGE')
    return content
  }

  async testConnection(model: string, signal?: AbortSignal): Promise<{ ok: boolean; message?: string }> {
    try {
      const response = await this.fetcher(`${normalizeBaseUrl(this.baseUrl)}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 4, stream: false }), signal
      })
      return response.ok ? { ok: true } : { ok: false, message: this.toError(response.status).message }
    } catch (error) {
      return { ok: false, message: this.toNetworkError(error, signal).message }
    }
  }

  private toNetworkError(error: unknown, signal?: AbortSignal): AppErrorShape & Error {
    if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      return Object.assign(new Error('请求已取消。'), { code: 'PROVIDER_CANCELLED', recoverable: true })
    }
    const details = error instanceof Error ? error.message : String(error)
    return Object.assign(new Error('无法连接模型服务，请检查网络与 Base URL。'), { code: 'PROVIDER_NETWORK_ERROR', recoverable: true, details })
  }

  private toError(status: number): AppErrorShape & Error {
    const table: Record<number, [string, string]> = {
      401: ['PROVIDER_UNAUTHORIZED', '凭据无效，请检查 API Key 后重试。'],
      429: ['PROVIDER_RATE_LIMITED', '请求过于频繁或额度不足，请稍后重试。']
    }
    const [code, message] = table[status] ?? ['PROVIDER_HTTP_ERROR', `模型服务返回 HTTP ${status}。`]
    return Object.assign(new Error(message), { code, recoverable: true })
  }
}
