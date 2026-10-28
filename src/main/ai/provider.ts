import type { AppErrorShape, ModelConfig, ProviderCapabilities, ProviderConfig, ProviderInput, RoutedTask } from '../../shared/domain'
import { checkBaseUrl, displayBaseUrl } from '../../shared/base-url'
import type { AppDatabase } from '../database/database'
import { randomUUID } from 'node:crypto'

export interface SecretCodec {
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

type ProviderRow = { id: string; provider_type: 'openai-compatible'; display_name: string; base_url: string; encrypted_api_key: Buffer | null; created_at: number; updated_at: number }

const baseUrlIssue = (url: string): { baseUrlError?: string } => { const check = checkBaseUrl(url); return check.ok ? {} : { baseUrlError: check.message } }
const normalizeBaseUrl = (url: string): string => url.trim().replace(/\/+$/, '')
/** S1c：任何请求前都校验 Base URL；不合法则抛错且不调用 fetch、不解密密钥。 */
const requireValidBaseUrl = (url: string): string => {
  const check = checkBaseUrl(url)
  if (!check.ok) throw Object.assign(new Error(`服务地址需要修正：${check.message}`), { code: 'PROVIDER_BASE_URL_INVALID' })
  return check.url
}
export const adapterCapabilities: ProviderCapabilities = { streaming: true, tools: false, structuredOutput: false, cancellation: true }
const truthfulCapabilities = (capabilities: ProviderCapabilities): ProviderCapabilities => ({ ...capabilities, tools: false, structuredOutput: false, streaming: true, cancellation: true })
export const routedTasks: RoutedTask[] = ['discussion', 'brainstorm', 'generation', 'editing', 'organization', 'chapter_digest', 'proofreading']

export class ProviderService {
  constructor(private readonly db: AppDatabase, private readonly codec: SecretCodec) {}

  list(): ProviderConfig[] {
    const rows = this.db.raw.prepare('SELECT * FROM provider_configs ORDER BY updated_at DESC').all() as ProviderRow[]
    return rows.map((row) => ({ id: row.id, providerType: row.provider_type, displayName: row.display_name,
      baseUrl: displayBaseUrl(row.base_url), ...baseUrlIssue(row.base_url), hasApiKey: Boolean(row.encrypted_api_key), createdAt: row.created_at, updatedAt: row.updated_at }))
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
      .run(input.id || randomUUID(), input.providerType, input.displayName.trim(), requireValidBaseUrl(input.baseUrl), encrypted, existing?.created_at ?? now, now)
    return this.list().find((item) => item.id === input.id) ?? this.list()[0]
  }

  getWithSecret(providerId: string): { config: ProviderConfig; apiKey: string } {
    const row = this.db.raw.prepare('SELECT * FROM provider_configs WHERE id = ?').get(providerId) as ProviderRow | undefined
    if (!row) throw new Error('PROVIDER_NOT_FOUND')
    if (!row.encrypted_api_key) throw new Error('PROVIDER_KEY_MISSING')
    requireValidBaseUrl(row.base_url)
    return {
      config: { id: row.id, providerType: row.provider_type, displayName: row.display_name, baseUrl: requireValidBaseUrl(row.base_url),
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
    if (!this.db.raw.prepare('SELECT 1 AS found FROM provider_configs WHERE id = ?').get(model.providerId)) throw new Error('PROVIDER_NOT_FOUND')
    if (!model.modelId.trim() || !model.displayName.trim()) throw new Error('MODEL_FIELDS_REQUIRED')
    const id = model.id || randomUUID()
    this.db.transaction(() => {
      if (model.isDefault && model.enabled) this.db.raw.prepare('UPDATE model_configs SET is_default = 0').run()
      this.db.raw.prepare(`INSERT INTO model_configs
        (id, provider_id, model_id, display_name, capabilities_json, enabled, is_default)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET provider_id=excluded.provider_id, model_id=excluded.model_id,
          display_name=excluded.display_name, capabilities_json=excluded.capabilities_json,
          enabled=excluded.enabled, is_default=excluded.is_default`)
        .run(id, model.providerId, model.modelId.trim(), model.displayName.trim(), JSON.stringify(truthfulCapabilities(model.capabilities)),
          model.enabled ? 1 : 0, model.enabled && model.isDefault ? 1 : 0)
      if (!model.enabled) {
        this.db.raw.prepare("UPDATE task_model_routes SET model_id = 'default' WHERE model_id = ?").run(id)
        const fallback = this.db.raw.prepare('SELECT id FROM model_configs WHERE id != ? AND enabled = 1 ORDER BY is_default DESC, rowid LIMIT 1').get(id) as { id: string } | undefined
        if (model.isDefault && fallback) this.db.raw.prepare('UPDATE model_configs SET is_default = 1 WHERE id = ?').run(fallback.id)
      }
    })
    return this.listModels().find((item) => item.id === id)!
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

const providerError = (code: string, message: string): AppErrorShape & Error =>
  Object.assign(new Error(message), { code, recoverable: true })

function deadlineSignal(external?: AbortSignal, timeoutMs = 60_000): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const onAbort = (): void => controller.abort(external?.reason ?? providerError('PROVIDER_CANCELLED', '请求已取消。'))
  external?.addEventListener('abort', onAbort, { once: true })
  if (external?.aborted) onAbort()
  const timer = setTimeout(() => controller.abort(providerError('PROVIDER_TIMEOUT', '模型服务响应超时，请重试。')), timeoutMs)
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); external?.removeEventListener('abort', onAbort) } }
}

export class OpenAICompatibleAdapter {
  private readonly baseUrl: string
  constructor(baseUrl: string, private readonly apiKey: string, private readonly fetcher: typeof fetch = fetch) { this.baseUrl = requireValidBaseUrl(baseUrl) }

  async *chat(input: { model: string; messages: ProviderMessage[]; signal?: AbortSignal; timeoutMs?: number }): AsyncIterable<string> {
    const request = deadlineSignal(input.signal, input.timeoutMs)
    let response: Response
    try {
      response = await this.fetcher(`${normalizeBaseUrl(this.baseUrl)}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: input.model, messages: input.messages, stream: true }), signal: request.signal
      })
    } catch (error) {
      request.dispose()
      throw this.toNetworkError(error, request.signal)
    }
    if (!response.ok) { request.dispose(); throw this.toError(response.status) }
    if (!response.body) { request.dispose(); throw providerError('PROVIDER_PROTOCOL_ERROR', '模型服务没有返回响应流。') }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''; let sawDone = false
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const events = buffer.split(/\r?\n\r?\n/)
        buffer = events.pop() ?? ''
        for (const event of events) {
          for (const line of event.split(/\r?\n/)) {
            if (!line.startsWith('data:')) continue
            const data = line.slice(5).trim()
            if (!data) continue
            if (data === '[DONE]') { sawDone = true; break }
            try {
              const json = JSON.parse(data) as { error?: { message?: string } | string; choices?: Array<{ delta?: { content?: string } }> }
              if (json.error) throw providerError('PROVIDER_STREAM_ERROR', typeof json.error === 'string' ? json.error : json.error.message ?? '模型服务返回流错误。')
              if (!Array.isArray(json.choices)) throw providerError('PROVIDER_PROTOCOL_ERROR', '模型服务返回了无法识别的流事件。')
              const text = json.choices?.[0]?.delta?.content
              if (text) yield text
            } catch (error) {
              if (error instanceof Error && typeof (error as Error & { code?: unknown }).code === 'string') throw error
              throw providerError('PROVIDER_PROTOCOL_ERROR', '模型服务返回了无效 SSE 数据。')
            }
          }
          if (sawDone) break
        }
        if (sawDone) break
      }
      if (!sawDone) throw providerError('PROVIDER_UNEXPECTED_EOF', '模型流在完成标记前中断。')
    } catch (error) {
      if (error instanceof Error && typeof (error as Error & { code?: unknown }).code === 'string') throw error
      throw this.toNetworkError(error, request.signal)
    }
    finally {
      buffer += decoder.decode()
      reader.releaseLock()
      request.dispose()
    }
  }

  async complete(input: { model: string; messages: ProviderMessage[]; signal?: AbortSignal; timeoutMs?: number }): Promise<string> {
    const request = deadlineSignal(input.signal, input.timeoutMs)
    let response: Response
    try {
      response = await this.fetcher(`${normalizeBaseUrl(this.baseUrl)}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: input.model, messages: input.messages, stream: false }), signal: request.signal
      })
      if (!response.ok) throw this.toError(response.status)
      const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
      const content = payload.choices?.[0]?.message?.content
      if (typeof content !== 'string' || !content.trim()) throw providerError('PROVIDER_PROTOCOL_ERROR', '模型服务没有返回有效消息。')
      return content
    } catch (error) {
      if (error instanceof Error && typeof (error as Error & { code?: unknown }).code === 'string') throw error
      throw this.toNetworkError(error, request.signal)
    } finally { request.dispose() }
  }

  async testConnection(model: string, signal?: AbortSignal): Promise<{ ok: boolean; message?: string }> {
    try {
      await this.complete({ model, messages: [{ role: 'user', content: 'Reply with OK.' }], signal })
      return { ok: true }
    } catch (error) {
      const shaped = error instanceof Error && typeof (error as Error & { code?: unknown }).code === 'string'
        ? error : this.toNetworkError(error, signal)
      return { ok: false, message: shaped.message }
    }
  }

  private toNetworkError(error: unknown, signal?: AbortSignal): AppErrorShape & Error {
    if (signal?.aborted && signal.reason instanceof Error && typeof (signal.reason as Error & { code?: unknown }).code === 'string') return signal.reason as AppErrorShape & Error
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
