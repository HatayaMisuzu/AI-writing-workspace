import type { AITaskEnvelope, ContextBundle } from '../../shared/domain'
import type { AppDatabase } from '../database/database'
import { ContextEngine } from './context-engine'
import { historyPolicy } from './history-policy'
import { composeProviderMessages } from './prompt-composer'
import { OpenAICompatibleAdapter, ProviderService, type ProviderMessage } from './provider'
import { ChatService } from '../services/chat-service'
import { DocumentService } from '../services/document-service'

const estimateTokens = (text: string): number => Math.ceil(text.length / 2.2)

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
      if (task.target) {
        const source = new DocumentService(this.db).getContent(task.target.projectId, task.target.documentId)
        if (source.revision !== task.target.sourceRevision) throw Object.assign(new Error('来源章节已变化，请重新发送请求。'), { code: 'AI_SOURCE_STALE' })
      }
      const model = this.providers.route(task.mode)
      const { config, apiKey } = this.providers.getWithSecret(model.providerId)
      const { messages, context } = this.plan(task, threadId, model.capabilities.maxContextTokens)
      this.chat.startTurn({ projectId: task.projectId, threadId, userMessageId, assistantMessageId, content: task.userIntent, mode: task.mode, target: task.target, contextSnapshot: this.contextSnapshot(context) })
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
        this.chat.startTurn({ projectId: task.projectId, threadId, userMessageId, assistantMessageId, content: task.userIntent, mode: task.mode, target: task.target })
        started = true
      }
      const shaped = error as Error & { code?: string }
      const status = controller.signal.aborted || shaped.code === 'PROVIDER_CANCELLED' ? 'cancelled' : 'error'
      this.chat.updateAssistant(task.projectId, threadId, assistantMessageId, assistant || shaped.message, status)
      throw error
    } finally { this.controllers.delete(requestId) }
  }

  /**
   * R4：发送前预览将发送的上下文清单。与 run() 走同一 plan()，
   * 因此在模型/输入/排除项/历史不变时，预览条目 = 实际发送条目。
   * 不解密 API Key、不发起网络请求；未配置模型时按默认窗口估算。
   */
  previewContext(task: AITaskEnvelope, threadId: string): ContextBundle {
    let maxContextTokens: number | undefined
    try { maxContextTokens = this.providers.route(task.mode).capabilities.maxContextTokens } catch { maxContextTokens = undefined }
    return this.plan(task, threadId, maxContextTokens).context
  }

  private plan(task: AITaskEnvelope, threadId: string, modelMaxContext: number | undefined): { messages: ProviderMessage[]; context: ContextBundle } {
    const maxContextTokens = Math.max(512, modelMaxContext ?? 16_000)
    const responseReserve = Math.min(4_096, Math.max(256, Math.floor(maxContextTokens * 0.2)), maxContextTokens - 256)
    const inputLimit = maxContextTokens - responseReserve
    const systemOnly = this.messageTokens(composeProviderMessages({ task: { ...task, userIntent: '' }, context: {
      projectId: task.projectId, policy: task.mode === 'reader_review' ? 'reader' : 'creative', items: [],
      metadata: { estimatedTokens: 0, sourceIds: [], excludedKinds: [] }
    }, history: [] }))
    if (systemOnly >= inputLimit) throw Object.assign(new Error('模型上下文窗口过小，无法容纳基础任务指令。'), { code: 'MODEL_CONTEXT_WINDOW_TOO_SMALL' })
    const userBudget = Math.min(Math.floor(inputLimit * 0.5), inputLimit - systemOnly)
    const providerTask = { ...task, userIntent: task.userIntent.slice(0, Math.max(1, Math.floor(userBudget * 2.2))) }
    const history = this.fitHistory(this.loadHistory(providerTask, threadId), Math.floor(inputLimit * 0.25))
    const emptyContext: ContextBundle = { projectId: task.projectId, policy: task.mode === 'reader_review' ? 'reader' : 'creative',
      items: [], metadata: { estimatedTokens: 0, sourceIds: [], excludedKinds: [] } }
    const fixedTokens = this.messageTokens(composeProviderMessages({ task: providerTask, context: emptyContext, history }))
    const builtContext = this.context.build(providerTask, Math.max(0, inputLimit - fixedTokens))
    return this.fitFinalMessages(providerTask, builtContext, history, inputLimit)
  }


  private contextSnapshot(context: ContextBundle): { sources: Array<{ id: string; kind: string }>; omitted: Array<{ id: string; kind: string; reason: string }> } {
    return {
      sources: context.items.map((item) => ({ id: item.id, kind: item.kind })),
      omitted: (context.metadata.omitted ?? []).map((item) => ({ id: item.id, kind: item.kind, reason: item.reason }))
    }
  }

  cancel(requestId: string): void { this.controllers.get(requestId)?.abort() }

  buildMessages(task: AITaskEnvelope, context: ContextBundle, threadId: string): ProviderMessage[] {
    const history = this.loadHistory(task, threadId)
    return composeProviderMessages({ task, context, history })
  }

  private loadHistory(task: AITaskEnvelope, threadId: string): ProviderMessage[] {
    return historyPolicy(task.mode) === 'creative-thread'
      ? (this.db.raw.prepare(`SELECT role, content FROM chat_messages WHERE project_id = ? AND thread_id = ? AND status = 'complete' ORDER BY created_at DESC, id DESC LIMIT 12`)
        .all(task.projectId, threadId) as Array<{ role: ProviderMessage['role']; content: string }>).reverse().filter((message) => message.content.trim())
      : []
  }

  private fitHistory(history: ProviderMessage[], budget: number): ProviderMessage[] {
    const result: ProviderMessage[] = []
    let used = 0
    for (const message of history.toReversed()) {
      const tokens = estimateTokens(message.content)
      if (used + tokens > budget) continue
      result.unshift(message); used += tokens
    }
    return result
  }

  private messageTokens(messages: ProviderMessage[]): number {
    return messages.reduce((sum, message) => sum + estimateTokens(message.content) + 4, 0)
  }

  private fitFinalMessages(task: AITaskEnvelope, source: ContextBundle, history: ProviderMessage[], limit: number): { messages: ProviderMessage[]; context: ContextBundle } {
    const context: ContextBundle = { ...source, items: source.items.map((item) => ({ ...item })), metadata: { ...source.metadata, omitted: [...(source.metadata.omitted ?? [])] } }
    const fittedHistory = [...history]
    while (context.items.length) {
      const messages = composeProviderMessages({ task, context, history: fittedHistory })
      const overflow = this.messageTokens(messages) - limit
      if (overflow <= 0) return { messages, context }
      const last = context.items.at(-1)!
      const keepTokens = estimateTokens(last.content) - overflow - 8
      if (keepTokens <= 0) { context.items.pop(); context.metadata.omitted!.push({ id: last.id, kind: last.kind, title: last.title, reason: 'budget' }) }
      else { last.content = last.content.slice(0, Math.floor(keepTokens * 2.2)); last.truncated = true }
      context.metadata.estimatedTokens = context.items.reduce((sum, item) => sum + estimateTokens(item.content), 0)
      context.metadata.sourceIds = context.items.map((item) => item.id)
    }
    let messages = composeProviderMessages({ task, context, history: fittedHistory })
    while (this.messageTokens(messages) > limit && fittedHistory.length) {
      fittedHistory.shift()
      messages = composeProviderMessages({ task, context, history: fittedHistory })
    }
    if (this.messageTokens(messages) > limit) throw Object.assign(new Error('模型输入超出上下文预算。'), { code: 'MODEL_CONTEXT_BUDGET_EXCEEDED' })
    return { messages, context }
  }
}
