import type { ProviderType } from '../../shared/domain'
import type { AITaskEnvelope, ContextBundle } from '../../shared/domain'
import type { AppDatabase } from '../database/database'
import { ContextEngine } from './context-engine'
import { historyPolicy } from './history-policy'
import { composeProviderMessages } from './prompt-composer'
import { createProviderAdapter, ProviderService, withModelMaxTokens, type ProviderAdapter, type ProviderMessage } from './provider'
import { computeContextInputBudget, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT } from '../../shared/provider-presets'
import { normalizeCandidateCount } from '../../shared/candidate-count'
import { CONSISTENCY_WINDOW_TOO_SMALL, truncateBySide, truncationSideFor } from '../../shared/consistency-check'
import { ChatService } from '../services/chat-service'
import { DocumentService } from '../services/document-service'
import { PromptTemplateService } from '../services/prompt-template-service'

const estimateTokens = (text: string): number => Math.ceil(text.length / 2.2)
const policyFor = (mode: AITaskEnvelope['mode']): ContextBundle['policy'] => mode === 'reader_review' ? 'reader' : mode === 'consistency_check' ? 'consistency' : 'creative'
/** P1-6：一致性检查是记录员（organization）的子任务，复用其模型路由，不新增调用通道。 */
const routeKey = (mode: AITaskEnvelope['mode']): string => mode === 'consistency_check' ? 'organization' : mode

type RuntimeAdapter = Pick<ProviderAdapter, 'chat'>
type RuntimeAdapterFactory = (baseUrl: string, apiKey: string, providerType?: ProviderType) => RuntimeAdapter

export class AICreativeRuntime {
  private readonly context: ContextEngine
  private readonly chat: ChatService
  private readonly templates: PromptTemplateService
  private readonly controllers = new Map<string, AbortController>()

  constructor(private readonly db: AppDatabase, private readonly providers: ProviderService,
    private readonly adapterFactory: RuntimeAdapterFactory = (baseUrl, apiKey, providerType) => createProviderAdapter(providerType, baseUrl, apiKey)) {
    this.context = new ContextEngine(db); this.chat = new ChatService(db); this.templates = new PromptTemplateService(db)
  }

  async *run(requestId: string, task: AITaskEnvelope, threadId: string, userMessageId: string, assistantMessageId: string): AsyncIterable<{ requestId: string; chunk: string; context?: ContextBundle; candidates?: string[] }> {
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
      const model = this.providers.route(routeKey(task.mode))
      const { config, apiKey } = this.providers.getWithSecret(model.providerId)
      const timeouts = this.providers.resolveTimeouts(model.providerId)
      const { messages, context } = this.plan(task, threadId, model)
      this.chat.startTurn({ projectId: task.projectId, threadId, userMessageId, assistantMessageId, content: task.userIntent, mode: task.mode, target: task.target, contextSnapshot: { ...this.contextSnapshot(context), template: this.templates.resolve(task.projectId, task.mode) } })
      started = true
      const adapter = withModelMaxTokens(this.adapterFactory(config.baseUrl, apiKey, config.providerType), config.providerType, model.maxOutput)
      // S8：仅 generation 使用候选数；其余模式固定 1 次请求。
      const count = task.mode === 'generation' ? normalizeCandidateCount(task.candidateCount) : 1
      const candidates: string[] = []
      for (let index = 0; index < count; index += 1) {
        let text = ''
        let firstChunk = true
        for await (const chunk of adapter.chat({
          model: model.modelId, messages, signal: controller.signal,
          timeoutMs: timeouts.totalTimeoutMs, firstTokenTimeoutMs: timeouts.firstTokenTimeoutMs
        })) {
          text += chunk
          if (index === 0) {
            assistant = text
            this.chat.updateAssistant(task.projectId, threadId, assistantMessageId, assistant, 'streaming')
            yield { requestId, chunk, context: firstChunk ? context : undefined }
            firstChunk = false
          }
        }
        if (!text.trim()) throw new Error(count > 1 ? `第 ${index + 1} 个候选没有可用内容。` : '模型没有返回可用内容。')
        candidates.push(text)
      }
      assistant = candidates[0] ?? ''
      this.chat.updateAssistant(task.projectId, threadId, assistantMessageId, assistant, 'complete')
      if (task.mode === 'generation') yield { requestId, chunk: '', candidates }
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
    try { return this.plan(task, threadId, this.providers.route(routeKey(task.mode))).context }
    catch { return this.plan(task, threadId, undefined).context }
  }

  private plan(task: AITaskEnvelope, threadId: string, model: { contextWindow?: number; maxOutput?: number; capabilities?: { maxContextTokens?: number } } | undefined): { messages: ProviderMessage[]; context: ContextBundle } {
    const contextWindow = Math.max(512, model?.contextWindow ?? model?.capabilities?.maxContextTokens ?? DEFAULT_CONTEXT_WINDOW)
    const maxOutput = Math.max(1, model?.maxOutput ?? Math.min(DEFAULT_MAX_OUTPUT, Math.floor(contextWindow * 0.2)))
    // S7：预算 = 窗口 − 最大输出 − 余量
    const inputLimit = Math.max(256, computeContextInputBudget(contextWindow, maxOutput))
    const systemOnly = this.messageTokens(composeProviderMessages({ roleTemplate: this.templates.getOverride(task.projectId, task.mode), task: { ...task, userIntent: '' }, context: {
      projectId: task.projectId, policy: policyFor(task.mode), items: [],
      metadata: { estimatedTokens: 0, sourceIds: [], excludedKinds: [] }
    }, history: [] }))
    if (systemOnly >= inputLimit) throw Object.assign(new Error('模型上下文窗口过小，无法容纳基础任务指令。'), { code: 'MODEL_CONTEXT_WINDOW_TOO_SMALL' })
    const userBudget = Math.min(Math.floor(inputLimit * 0.5), inputLimit - systemOnly)
    const providerTask = { ...task, userIntent: task.userIntent.slice(0, Math.max(1, Math.floor(userBudget * 2.2))) }
    const history = this.fitHistory(this.loadHistory(providerTask, threadId), Math.floor(inputLimit * 0.25))
    const emptyContext: ContextBundle = { projectId: task.projectId, policy: policyFor(task.mode),
      items: [], metadata: { estimatedTokens: 0, sourceIds: [], excludedKinds: [] } }
    const fixedTokens = this.messageTokens(composeProviderMessages({ task: providerTask, context: emptyContext, history, roleTemplate: this.templates.getOverride(task.projectId, task.mode) }))
    const builtContext = this.context.build(providerTask, Math.max(0, inputLimit - fixedTokens))
    return this.fitFinalMessages(providerTask, builtContext, history, inputLimit)
  }


  private contextSnapshot(context: ContextBundle): { sources: Array<{ id: string; kind: string; truncated?: true; basis?: string[] }>; omitted: Array<{ id: string; kind: string; reason: string; basis?: string[] }>; overflow?: Array<{ kind: string; limit: number; total: number; ids: string[] }> } {
    return {
      // 修复 3：snapshot 记录哪些来源（如哪章）被截断；P3-e：并记录入选/省略依据（与发送内容同一份 context）
      sources: context.items.map((item) => ({ id: item.id, kind: item.kind, ...(item.truncated ? { truncated: true as const } : {}), ...(item.basis ? { basis: item.basis } : {}) })),
      omitted: (context.metadata.omitted ?? []).map((item) => ({ id: item.id, kind: item.kind, reason: item.reason, ...(item.basis ? { basis: [...item.basis, ...(item.reason === 'budget' ? ['预算不足省略'] : [])] } : {}) })),
      // L4：上限外条目只记类别 / 计数 / 清单所列 id（与预览同一份 context；不进发送内容）
      ...(context.metadata.overflow?.length ? { overflow: context.metadata.overflow.map((item) => ({ kind: item.kind, limit: item.limit, total: item.total, ids: item.items.map((entry) => entry.id) })) } : {})
    }
  }

  cancel(requestId: string): void { this.controllers.get(requestId)?.abort() }

  buildMessages(task: AITaskEnvelope, context: ContextBundle, threadId: string): ProviderMessage[] {
    const history = this.loadHistory(task, threadId)
    return composeProviderMessages({ task, context, history, roleTemplate: this.templates.getOverride(task.projectId, task.mode) })
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
    const roleTemplate = this.templates.getOverride(task.projectId, task.mode)
    if (task.mode === 'consistency_check') return this.fitConsistency(task, context, fittedHistory, roleTemplate, limit)
    while (context.items.length) {
      const messages = composeProviderMessages({ task, context, history: fittedHistory, roleTemplate })
      const overflow = this.messageTokens(messages) - limit
      if (overflow <= 0) return { messages, context }
      // P1-5：读者审稿按章序排列，优先裁最早的章节（保留靠近第 N 章的正文，且保留章节末尾）
      const reader = task.mode === 'reader_review'
      const last = (reader ? context.items[0] : context.items.at(-1))!
      const keepTokens = estimateTokens(last.content) - overflow - 8
      if (keepTokens <= 0) {
        if (reader) context.items.shift(); else context.items.pop()
        context.metadata.omitted!.push({ id: last.id, kind: last.kind, title: last.title, reason: 'budget', ...(last.basis ? { basis: last.basis } : {}) })
      } else {
        const keep = Math.floor(keepTokens * 2.2)
        // P2-1：保留端与 context-engine 同源（truncationSideFor），两次截断叠加后仍保留同一端
        last.content = truncateBySide(last.content, keep, truncationSideFor(context.policy)); last.truncated = true
      }
      context.metadata.estimatedTokens = context.items.reduce((sum, item) => sum + estimateTokens(item.content), 0)
      context.metadata.sourceIds = context.items.map((item) => item.id)
    }
    let messages = composeProviderMessages({ task, context, history: fittedHistory, roleTemplate })
    while (this.messageTokens(messages) > limit && fittedHistory.length) {
      fittedHistory.shift()
      messages = composeProviderMessages({ task, context, history: fittedHistory, roleTemplate })
    }
    if (this.messageTokens(messages) > limit) throw Object.assign(new Error('模型输入超出上下文预算。'), { code: 'MODEL_CONTEXT_BUDGET_EXCEEDED' })
    return { messages, context }
  }

  /**
   * PR25 P2-3：一致性检查的第二层裁剪也守住本章保底（min(本章, 25% 预算)）。
   * 先把本章截到保底为止（保留开头），再从末尾裁引用（引用已按 设定/人物卡/时间线 轮转排列，
   * 末尾裁剪仍保持类别均衡，且至少保留一条）；仍放不下 → 不发请求，直接报「上下文窗口太小」。
   */
  private fitConsistency(task: AITaskEnvelope, context: ContextBundle, history: ProviderMessage[], roleTemplate: string | undefined, limit: number): { messages: ProviderMessage[]; context: ContextBundle } {
    const tooSmall = (): Error => Object.assign(new Error(`${CONSISTENCY_WINDOW_TOO_SMALL}（需能容纳本章保底正文和至少一类设定/人物卡/时间线）。`), { code: 'CONSISTENCY_CONTEXT_WINDOW_TOO_SMALL' })
    const chapter = context.items.find((item) => item.kind === 'document')
    if (!chapter || !context.items.some((item) => item.kind !== 'document')) throw tooSmall()
    const floor = Math.max(1, Math.min(estimateTokens(chapter.content), Math.floor(limit * 0.25)))
    const side = truncationSideFor(context.policy)
    const sync = (): void => {
      context.metadata.estimatedTokens = context.items.reduce((sum, item) => sum + estimateTokens(item.content), 0)
      context.metadata.sourceIds = context.items.map((item) => item.id)
    }
    for (;;) {
      const messages = composeProviderMessages({ task, context, history, roleTemplate })
      const overflow = this.messageTokens(messages) - limit
      if (overflow <= 0) return { messages, context }
      const refs = context.items.filter((item) => item.kind !== 'document')
      const chapterTokens = estimateTokens(chapter.content)
      if (chapterTokens > floor) {
        const keepTokens = Math.max(floor, chapterTokens - overflow - 8)
        chapter.content = truncateBySide(chapter.content, keepTokens * 2.2, side); chapter.truncated = true
      } else if (refs.length > 1) {
        const last = refs.at(-1)!
        const keepTokens = estimateTokens(last.content) - overflow - 8
        if (keepTokens <= 0) {
          context.items.splice(context.items.indexOf(last), 1)
          context.metadata.omitted!.push({ id: last.id, kind: last.kind, title: last.title, reason: 'budget', ...(last.basis ? { basis: last.basis } : {}) })
        } else { last.content = truncateBySide(last.content, keepTokens * 2.2, side); last.truncated = true }
      } else if (history.length) history.shift()
      else throw tooSmall()
      sync()
    }
  }
}
