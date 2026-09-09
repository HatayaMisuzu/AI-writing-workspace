import type { AppDatabase } from '../database/database'
import { chapterDigestSchema, ChapterDigestService, type ChapterDigestPayload } from './chapter-digest-service'
import { ContextEngine } from './context-engine'
import { OpenAICompatibleAdapter, ProviderService, type ProviderMessage } from './provider'
import { DocumentService } from '../services/document-service'
import { splitText } from './text-chunks'

const DIGEST_CONTRACT = `只输出一个 JSON 对象，不要 Markdown，不要解释。必须符合：
{"summary":"string","events":[],"characterChanges":[],"reveals":[],"openQuestions":[],"memoryCandidates":[{"type":"fact|event|character_state|relationship|decision|idea|question|foreshadowing|style_signal","content":"string","confidence":0.0,"readerVisibleFrom":1}],"possibleContradictions":[]}
所有数组允许为空。memoryCandidates 只是 suggested，禁止声称已确认。`

type AdapterFactory = (baseUrl: string, apiKey: string) => Pick<OpenAICompatibleAdapter, 'complete'>
const parseJson = (raw: string): unknown => JSON.parse(raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw)

export class ChapterDigestRunner {
  private readonly context: ContextEngine
  private readonly digests: ChapterDigestService
  private readonly requestSequence = new Map<string, number>()

  constructor(private readonly db: AppDatabase, private readonly providers: ProviderService,
    private readonly adapterFactory: AdapterFactory = (baseUrl, apiKey) => new OpenAICompatibleAdapter(baseUrl, apiKey)) {
    this.context = new ContextEngine(db); this.digests = new ChapterDigestService(db)
  }

  async run(projectId: string, chapterId: string): Promise<{ id: string; payload: unknown; repaired: boolean }> {
    const requestKey = `${projectId}:${chapterId}`
    const sequence = (this.requestSequence.get(requestKey) ?? 0) + 1
    this.requestSequence.set(requestKey, sequence)
    const assertLatest = (): void => {
      if (this.requestSequence.get(requestKey) !== sequence) throw new Error('DIGEST_REQUEST_SUPERSEDED')
    }
    const source = new DocumentService(this.db).getContent(projectId, chapterId)
    const sourceRevision = source.revision
    const model = this.providers.route('chapter_digest')
    const { config, apiKey } = this.providers.getWithSecret(model.providerId)
    const adapter = this.adapterFactory(config.baseUrl, apiKey)
    const context = this.context.build({ mode: 'chapter_digest', writePermission: 'none', userIntent: '理解并结构化当前章节', projectId, documentId: chapterId })
    const contextText = context.items.map((item) => `[${item.kind}] ${item.title}\n${item.content}`).join('\n\n')
    const maxChars = Math.max(128, Math.floor((model.capabilities.maxContextTokens ?? 16_000) * 0.6 * 2.2))
    const chunks = splitText(source.plainText, maxChars)
    if (chunks.length > 1) {
      const payloads: ChapterDigestPayload[] = []
      let repaired = false
      for (const [index, chunk] of chunks.entries()) {
        const messages: ProviderMessage[] = [{ role: 'system', content: DIGEST_CONTRACT },
          { role: 'user', content: `这是章节第 ${index + 1}/${chunks.length} 段，只总结本段：\n${chunk.text}` }]
        const result = await this.completePayload(adapter, model.modelId, messages)
        assertLatest()
        payloads.push(result.payload); repaired ||= result.repaired
      }
      const combined: ChapterDigestPayload = {
        summary: payloads.map((payload, index) => `第 ${index + 1} 段：${payload.summary}`).join('\n'),
        events: payloads.flatMap((payload) => payload.events), characterChanges: payloads.flatMap((payload) => payload.characterChanges),
        reveals: payloads.flatMap((payload) => payload.reveals), openQuestions: payloads.flatMap((payload) => payload.openQuestions),
        memoryCandidates: payloads.flatMap((payload) => payload.memoryCandidates),
        possibleContradictions: payloads.flatMap((payload) => payload.possibleContradictions)
      }
      assertLatest()
      const stored = this.digests.storeFromModel(projectId, chapterId, JSON.stringify(combined), sourceRevision)
      return { ...stored, repaired }
    }
    const messages: ProviderMessage[] = [{ role: 'system', content: DIGEST_CONTRACT }, { role: 'user', content: contextText }]
    const raw = await adapter.complete({ model: model.modelId, messages })
    try {
      assertLatest()
      const stored = this.digests.storeFromModel(projectId, chapterId, raw, sourceRevision)
      return { ...stored, repaired: false }
    } catch (firstError) {
      if (firstError instanceof Error && ['DIGEST_SOURCE_STALE', 'DIGEST_REQUEST_SUPERSEDED'].includes(firstError.message)) throw firstError
      const repairMessages: ProviderMessage[] = [{ role: 'system', content: `${DIGEST_CONTRACT}\n上一次输出无法解析。修复为严格 JSON；不得改变已给内容的事实。` },
        { role: 'user', content: `原始章节上下文：\n${contextText}\n\n无效输出：\n${raw}\n\n解析错误：${firstError instanceof Error ? firstError.message : String(firstError)}` }]
      const repairedRaw = await adapter.complete({ model: model.modelId, messages: repairMessages })
      try {
        assertLatest()
        const stored = this.digests.storeFromModel(projectId, chapterId, repairedRaw, sourceRevision)
        return { ...stored, repaired: true }
      } catch (error) {
        if (error instanceof Error && ['DIGEST_SOURCE_STALE', 'DIGEST_REQUEST_SUPERSEDED'].includes(error.message)) throw error
        throw Object.assign(new Error('章节理解失败，可重试。'), { code: 'DIGEST_INVALID_RESPONSE', cause: error })
      }
    }
  }

  private async completePayload(adapter: Pick<OpenAICompatibleAdapter, 'complete'>, model: string, messages: ProviderMessage[]): Promise<{ payload: ChapterDigestPayload; repaired: boolean }> {
    const raw = await adapter.complete({ model, messages })
    try { return { payload: chapterDigestSchema.parse(parseJson(raw)), repaired: false } }
    catch (error) {
      const repaired = await adapter.complete({ model, messages: [...messages, { role: 'assistant', content: raw },
        { role: 'user', content: `输出无效：${error instanceof Error ? error.message : String(error)}。只返回符合 Schema 的 JSON。` }] })
      return { payload: chapterDigestSchema.parse(parseJson(repaired)), repaired: true }
    }
  }
}
