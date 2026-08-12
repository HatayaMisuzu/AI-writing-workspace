import { randomUUID } from 'node:crypto'
import type { AITaskEnvelope, ChatMessage, ContextBundle } from '../../shared/domain'
import type { AppDatabase } from '../database/database'
import { ContextEngine } from './context-engine'
import { OpenAICompatibleAdapter, ProviderService, type ProviderMessage } from './provider'

const CORE_PRINCIPLES = `你是长期陪伴作者创作的 AI 助手，不是作品的作者本人。区分正文事实、作者确认、暂定、灵感、AI推测与废弃内容。未经作者明确确认，不写入设定或正文。不使用评分或机械化最佳方案。对话自然、具体。`

const MODE_RULES: Record<AITaskEnvelope['mode'], string> = {
  discussion: '陪作者讨论；默认只读，不自动记录新设定。',
  brainstorm: '扩展可能性；新内容一律是 suggested/idea，不当作事实。',
  generation: '生成候选文字；不要声称已写入正文。',
  editing: '只修改明确范围；输出局部替换建议，不扩张范围。',
  organization: '整理现有想法，不改变语义，不升级状态。',
  chapter_digest: '输出章节理解结构，不评分，不把候选升级为 confirmed。',
  proofreading: '区分确定错误与风格选择，不静默重写。',
  reader_review: '只基于给定 Reader Context，像普通读者一样说明理解问题。'
}

export class AICreativeRuntime {
  private readonly context: ContextEngine
  private readonly controllers = new Map<string, AbortController>()

  constructor(private readonly db: AppDatabase, private readonly providers: ProviderService) {
    this.context = new ContextEngine(db)
  }

  async *run(task: AITaskEnvelope, threadId: string): AsyncIterable<{ requestId: string; chunk: string; context?: ContextBundle }> {
    const requestId = randomUUID()
    const controller = new AbortController()
    this.controllers.set(requestId, controller)
    const model = this.providers.route(task.mode)
    const { config, apiKey } = this.providers.getWithSecret(model.providerId)
    const context = this.context.build(task)
    const messages = this.compose(task, context, threadId)
    this.persistMessage(task.projectId, threadId, 'user', task.userIntent, task.mode)
    let assistant = ''
    try {
      const adapter = new OpenAICompatibleAdapter(config.baseUrl, apiKey)
      let first = true
      for await (const chunk of adapter.chat({ model: model.modelId, messages, signal: controller.signal })) {
        assistant += chunk
        yield { requestId, chunk, context: first ? context : undefined }
        first = false
      }
      this.persistMessage(task.projectId, threadId, 'assistant', assistant, task.mode)
    } finally {
      this.controllers.delete(requestId)
    }
  }

  cancel(requestId: string): void {
    this.controllers.get(requestId)?.abort()
  }

  private compose(task: AITaskEnvelope, context: ContextBundle, threadId: string): ProviderMessage[] {
    const history = this.db.raw.prepare(`SELECT role, content FROM chat_messages WHERE project_id = ? AND thread_id = ? ORDER BY created_at DESC LIMIT 12`)
      .all(task.projectId, threadId) as Array<{ role: 'user' | 'assistant'; content: string }>
    const contextText = context.items.map((item) => `[${item.kind}] ${item.title}\n${item.content}`).join('\n\n')
    return [
      { role: 'system', content: `${CORE_PRINCIPLES}\n当前模式：${task.mode}。${MODE_RULES[task.mode]}\n写入权限：${task.writePermission}。\n上下文策略：${context.policy}。` },
      { role: 'system', content: `以下内容全部来自当前作品 ${task.projectId}，不可引用其他作品：\n${contextText}` },
      ...history.reverse(),
      { role: 'user', content: task.userIntent }
    ]
  }

  private persistMessage(projectId: string, threadId: string, role: ChatMessage['role'], content: string, mode: AITaskEnvelope['mode']): void {
    const now = Date.now()
    this.db.raw.prepare(`INSERT OR IGNORE INTO chat_threads(id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run(threadId, projectId, '创作讨论', now, now)
    this.db.raw.prepare(`INSERT INTO chat_messages(id, thread_id, project_id, role, content, task_mode, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'complete', ?)`)
      .run(randomUUID(), threadId, projectId, role, content, mode, now)
  }
}
