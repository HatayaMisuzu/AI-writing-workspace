import { randomUUID } from 'node:crypto'
import type { AITaskEnvelope, ChatMessage, ContextBundle } from '../../shared/domain'
import type { AppDatabase } from '../database/database'
import { ContextEngine } from './context-engine'
import { historyPolicy } from './history-policy'
import { composeProviderMessages } from './prompt-composer'
import { OpenAICompatibleAdapter, ProviderService, type ProviderMessage } from './provider'

export class AICreativeRuntime {
  private readonly context: ContextEngine
  private readonly controllers = new Map<string, AbortController>()

  constructor(private readonly db: AppDatabase, private readonly providers: ProviderService) { this.context = new ContextEngine(db) }

  async *run(requestId: string, task: AITaskEnvelope, threadId: string, userMessageId: string = randomUUID()): AsyncIterable<{ requestId: string; chunk: string; context?: ContextBundle }> {
    if (this.controllers.has(requestId)) throw new Error('AI_REQUEST_ID_IN_USE')
    const controller = new AbortController()
    this.controllers.set(requestId, controller)
    try {
      const model = this.providers.route(task.mode)
      const { config, apiKey } = this.providers.getWithSecret(model.providerId)
      const context = this.context.build(task)
      const messages = this.buildMessages(task, context, threadId)
      this.persistMessage(userMessageId, task.projectId, threadId, 'user', task.userIntent, task.mode)
      let assistant = ''
      const adapter = new OpenAICompatibleAdapter(config.baseUrl, apiKey)
      let first = true
      for await (const chunk of adapter.chat({ model: model.modelId, messages, signal: controller.signal })) {
        assistant += chunk
        yield { requestId, chunk, context: first ? context : undefined }
        first = false
      }
      this.persistMessage(randomUUID(), task.projectId, threadId, 'assistant', assistant, task.mode)
    } finally { this.controllers.delete(requestId) }
  }

  cancel(requestId: string): void { this.controllers.get(requestId)?.abort() }

  buildMessages(task: AITaskEnvelope, context: ContextBundle, threadId: string): ProviderMessage[] {
    const history = historyPolicy(task.mode) === 'creative-thread'
      ? (this.db.raw.prepare(`SELECT role, content FROM chat_messages WHERE project_id = ? AND thread_id = ? ORDER BY created_at DESC LIMIT 12`)
        .all(task.projectId, threadId) as Array<{ role: ProviderMessage['role']; content: string }>).reverse()
      : []
    return composeProviderMessages({ task, context, history })
  }

  private persistMessage(id: string, projectId: string, threadId: string, role: ChatMessage['role'], content: string, mode: AITaskEnvelope['mode']): void {
    const now = Date.now()
    this.db.raw.prepare(`INSERT OR IGNORE INTO chat_threads(id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run(threadId, projectId, '创作讨论', now, now)
    this.db.raw.prepare(`INSERT INTO chat_messages(id, thread_id, project_id, role, content, task_mode, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'complete', ?)`)
      .run(id, threadId, projectId, role, content, mode, now)
  }
}
