import type { AppDatabase } from '../database/database'
import { ChapterDigestService } from './chapter-digest-service'
import { ContextEngine } from './context-engine'
import { OpenAICompatibleAdapter, ProviderService, type ProviderMessage } from './provider'

const DIGEST_CONTRACT = `只输出一个 JSON 对象，不要 Markdown，不要解释。必须符合：
{"summary":"string","events":[],"characterChanges":[],"reveals":[],"openQuestions":[],"memoryCandidates":[{"type":"fact|event|character_state|relationship|decision|idea|question|foreshadowing|style_signal","content":"string","confidence":0.0,"readerVisibleFrom":1}],"possibleContradictions":[]}
所有数组允许为空。memoryCandidates 只是 suggested，禁止声称已确认。`

type AdapterFactory = (baseUrl: string, apiKey: string) => Pick<OpenAICompatibleAdapter, 'complete'>

export class ChapterDigestRunner {
  private readonly context: ContextEngine
  private readonly digests: ChapterDigestService

  constructor(private readonly db: AppDatabase, private readonly providers: ProviderService,
    private readonly adapterFactory: AdapterFactory = (baseUrl, apiKey) => new OpenAICompatibleAdapter(baseUrl, apiKey)) {
    this.context = new ContextEngine(db); this.digests = new ChapterDigestService(db)
  }

  async run(projectId: string, chapterId: string): Promise<{ id: string; payload: unknown; repaired: boolean }> {
    const model = this.providers.route('chapter_digest')
    const { config, apiKey } = this.providers.getWithSecret(model.providerId)
    const adapter = this.adapterFactory(config.baseUrl, apiKey)
    const context = this.context.build({ mode: 'chapter_digest', writePermission: 'none', userIntent: '理解并结构化当前章节', projectId, documentId: chapterId })
    const contextText = context.items.map((item) => `[${item.kind}] ${item.title}\n${item.content}`).join('\n\n')
    const messages: ProviderMessage[] = [{ role: 'system', content: DIGEST_CONTRACT }, { role: 'user', content: contextText }]
    const raw = await adapter.complete({ model: model.modelId, messages })
    try {
      const stored = this.digests.storeFromModel(projectId, chapterId, raw)
      return { ...stored, repaired: false }
    } catch (firstError) {
      const repairMessages: ProviderMessage[] = [{ role: 'system', content: `${DIGEST_CONTRACT}\n上一次输出无法解析。修复为严格 JSON；不得改变已给内容的事实。` },
        { role: 'user', content: `原始章节上下文：\n${contextText}\n\n无效输出：\n${raw}\n\n解析错误：${firstError instanceof Error ? firstError.message : String(firstError)}` }]
      const repairedRaw = await adapter.complete({ model: model.modelId, messages: repairMessages })
      try {
        const stored = this.digests.storeFromModel(projectId, chapterId, repairedRaw)
        return { ...stored, repaired: true }
      } catch (error) {
        throw Object.assign(new Error('章节理解失败，可重试。'), { code: 'DIGEST_INVALID_RESPONSE', cause: error })
      }
    }
  }
}
