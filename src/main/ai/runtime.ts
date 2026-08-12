import type { AITaskEnvelope, ContextBundle } from '../../shared/domain'
import type { AppDatabase } from '../database/database'
import { ContextEngine } from './context-engine'
import { historyPolicy } from './history-policy'
import { composeProviderMessages } from './prompt-composer'
import { OpenAICompatibleAdapter, ProviderService, type ProviderMessage } from './provider'
import { ChatService } from '../services/chat-service'

type RuntimeAdapter = Pick<OpenAICompatibleAdapter, 'chat'>
type RuntimeAdapterFactory = (baseUrl: string, apiKey: string) => RuntimeAdapter

export class AICreativeRuntime {
  private readonly context: ContextEngine
  private readonly chat: ChatService
  private readonly controllers = new Map<string, AbortController>()

  constructor(private readonly db: AppDatabase, private readonly providers: ProviderService,
    private readonly adapterFactory: RuntimeAdapterFactory = (baseUrl, apiKey) => new OpenAICompatibleAdapter(baseUrl, apiKey)) {
    this.context = new ContextEngine(db); this.chat = new ChatService(db)
  }

  async *run(requestId: string, task: AITaskEnvelope, threadId: string, userMessageId: string, assistantMessageId: string): AsyncIterable<{ requestId: string; chunk: string; context?: ContextBundle }> {
    if (this.controllers.has(requestId)) throw new Error('AI_REQUEST_ID_IN_USE')
    const controller = new AbortController()
    this.controllers.set(requestId, controller)
    let started = false
    let assistant = ''
    try {
      const model = this.providers.route(task.mode)
      const { config, apiKey } = this.providers.getWithSecret(model.providerId)
      const context = this.context.build(task, this.contextBudget(task.mode))
      const messages = this.buildMessages(task, context, threadId)
      this.chat.startTurn({ projectId: task.projectId, threadId, userMessageId, assistantMessageId, content: task.userIntent, mode: task.mode })
      started = true
      const adapter = this.adapterFactory(config.baseUrl, apiKey)
      let first = true
      for await (const chunk of adapter.chat({ model: model.modelId, messages, signal: controller.signal })) {
        assistant += chunk
        this.chat.updateAssistant(task.projectId, threadId, assistantMessageId, assistant, 'streaming')
        yield { requestId, chunk, context: first ? context : undefined }
        first = false
      }
      if (!assistant.trim()) throw new Error('模型没有返回可用内容。')
      this.chat.updateAssistant(task.projectId, threadId, assistantMessageId, assistant, 'complete')
    } catch (error) {
      if (!started) {
        this.chat.startTurn({ projectId: task.projectId, threadId, userMessageId, assistantMessageId, content: task.userIntent, mode: task.mode })
        started = true
      }
      const shaped = error as Error & { code?: string }
      const status = controller.signal.aborted || shaped.code === 'PROVIDER_CANCELLED' ? 'cancelled' : 'error'
      this.chat.updateAssistant(task.projectId, threadId, assistantMessageId, assistant || shaped.message, status)
      throw error
    } finally { this.controllers.delete(requestId) }
  }

  cancel(requestId: string): void { this.controllers.get(requestId)?.abort() }

  buildMessages(task: AITaskEnvelope, context: ContextBundle, threadId: string): ProviderMessage[] {
    const history = historyPolicy(task.mode) === 'creative-thread'
      ? (this.db.raw.prepare(`SELECT role, content FROM chat_messages WHERE project_id = ? AND thread_id = ? AND status = 'complete' ORDER BY created_at DESC LIMIT 12`)
        .all(task.projectId, threadId) as Array<{ role: ProviderMessage['role']; content: string }>).reverse().filter((message) => message.content.trim())
      : []
    return composeProviderMessages({ task, context, history })
  }

  private contextBudget(mode: AITaskEnvelope['mode']): number {
    if (mode === 'generation') return 16_000
    if (mode === 'chapter_digest') return 20_000
    if (mode === 'proofreading') return 16_000
    return 12_000
  }
}
