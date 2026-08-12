import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ProofreadIssue } from '../../shared/domain'
import type { AppDatabase } from '../database/database'
import { DocumentService } from '../services/document-service'
import { OpenAICompatibleAdapter, ProviderService, type ProviderMessage } from './provider'

const issueSchema = z.object({
  category: z.enum(['punctuation', 'spacing', 'typo', 'grammar', 'reference', 'repetition', 'format', 'other']),
  originalText: z.string().min(1).max(300),
  suggestion: z.string().max(300).optional(),
  reason: z.string().min(1).max(500),
  confidence: z.number().min(0).max(1).optional()
})
const responseSchema = z.object({ issues: z.array(issueSchema).max(30) })
const CONTRACT = `你是谨慎的中文校对助手。只输出严格 JSON：{"issues":[{"category":"punctuation|spacing|typo|grammar|reference|repetition|format|other","originalText":"正文中的精确原句","suggestion":"建议文本","reason":"简短原因","confidence":0.0}]}。
只报告错别字、的地得、病句、指代不清、不自然重复或明确语病。短句、留白、语气和风格选择不是错误。originalText 必须能在正文中逐字找到。不要整章改写，没问题就返回空数组。`

const parseJson = (raw: string): unknown => JSON.parse(raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw)
type AdapterFactory = (baseUrl: string, apiKey: string) => Pick<OpenAICompatibleAdapter, 'complete'>

export class ProofreadingRunner {
  private readonly documents: DocumentService
  constructor(private readonly db: AppDatabase, private readonly providers: ProviderService,
    private readonly adapterFactory: AdapterFactory = (baseUrl, apiKey) => new OpenAICompatibleAdapter(baseUrl, apiKey)) {
    this.documents = new DocumentService(db)
  }

  async run(projectId: string, documentId: string): Promise<ProofreadIssue[]> {
    const content = this.documents.getContent(projectId, documentId)
    const model = this.providers.route('proofreading')
    const { config, apiKey } = this.providers.getWithSecret(model.providerId)
    const adapter = this.adapterFactory(config.baseUrl, apiKey)
    const messages: ProviderMessage[] = [{ role: 'system', content: CONTRACT }, { role: 'user', content: content.plainText }]
    const raw = await adapter.complete({ model: model.modelId, messages })
    let parsed: z.infer<typeof responseSchema>
    try { parsed = responseSchema.parse(parseJson(raw)) }
    catch (firstError) {
      const repaired = await adapter.complete({ model: model.modelId, messages: [...messages, { role: 'assistant', content: raw },
        { role: 'user', content: `输出无效：${firstError instanceof Error ? firstError.message : String(firstError)}。只返回符合 Schema 的 JSON。` }] })
      try { parsed = responseSchema.parse(parseJson(repaired)) }
      catch (error) { throw Object.assign(new Error('AI 校对结果无法解析，正文没有被修改，请重试。'), { code: 'PROOFREAD_INVALID_RESPONSE', cause: error }) }
    }
    return parsed.issues.filter((issue) => content.plainText.includes(issue.originalText)).map((issue) => ({
      id: randomUUID(), source: 'ai', ...issue, documentRevision: content.revision
    }))
  }
}
