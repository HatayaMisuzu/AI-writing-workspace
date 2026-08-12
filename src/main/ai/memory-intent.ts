import { z } from 'zod'
import type { MemoryIntentResult, MemoryType } from '../../shared/domain'
import type { AppDatabase } from '../database/database'
import { MemoryService } from '../services/memory-service'
import { OpenAICompatibleAdapter, ProviderService, type ProviderMessage } from './provider'

const proposalSchema = z.object({
  type: z.enum(['fact', 'event', 'character_state', 'relationship', 'decision', 'idea', 'question', 'foreshadowing']),
  content: z.string().trim().min(1).max(500),
  confidence: z.number().min(0).max(1).optional()
})
const resultSchema = z.object({ shouldPropose: z.boolean(), proposals: z.array(proposalSchema).max(3) })

const positiveHint = /记一下|记住这个|以后按这个|就这么定|设定为|确认采用|保留这个设定/
const replacementHint = /(.+?)(?:不要了|作废|废弃)[，,。；;\s]*(?:改成|替换为)(.+)/
const negativeHint = /不要记|别记|别定|先别定|不确定|没定|暂时(?:这么)?想|暂时想想|只是想想|假设|如果|要不要|不用记录|不必记录/
const quotedCommand = /(?:他说|她说|文中|台词)[^。！？]{0,30}[“"'].*(?:记住|记一下)/
const quotedReplacement = /(?:他说|她说|文中|台词)[^。！？]{0,30}[“"'].*(?:不要了|作废|废弃).*?(?:改成|替换为)/

export const shouldRunMemoryIntent = (text: string): boolean =>
  (positiveHint.test(text) || replacementHint.test(text)) &&
  !negativeHint.test(text) &&
  !quotedCommand.test(text) &&
  !quotedReplacement.test(text)

export const localReplacementIntent = (text: string): { previous: string; replacement: string } | undefined => {
  if (negativeHint.test(text) || quotedReplacement.test(text)) return undefined
  const match = text.match(replacementHint)
  const previous = match?.[1]?.trim().replace(/^(?:记一下|设定里|把)/, '').trim()
  const replacement = match?.[2]?.trim().replace(/[。！!\s]+$/, '')
  return previous && replacement ? { previous, replacement } : undefined
}

const classify = (content: string): MemoryType => {
  if (/姐妹|兄弟|母女|父子|夫妻|恋人|朋友|仇人|认识|关系/.test(content)) return 'relationship'
  if (/害怕|恐惧|受伤|失忆|怀孕|生病|状态|情绪/.test(content)) return 'character_state'
  if (/第[一二三四五六七八九十百\d]+章|离开|回来|死亡|失踪|发生|抵达|发现/.test(content)) return 'event'
  if (/采用|方案|决定|改成|选择/.test(content)) return 'decision'
  if (/伏笔|暗示|埋下/.test(content)) return 'foreshadowing'
  if (/问题|待定|为什么|如何/.test(content)) return 'question'
  if (/想法|点子|也许可以/.test(content)) return 'idea'
  return 'fact'
}

export const localMemoryIntent = (text: string): MemoryIntentResult => {
  if (!shouldRunMemoryIntent(text)) return { shouldPropose: false, proposals: [] }
  const patterns = [
    /就这么定[，,:：\s]*(.+?)(?:[，,；;\s]*(?:这个)?记一下)[。！!\s]*$/u,
    /以后按这个设定[：:\s]*(.+?)[。！!\s]*$/u,
    /确认采用[：:\s]*(.+?)(?:[，,；;\s]*记住)?[。！!\s]*$/u,
    /记一下[：:\s]+(.+?)[。！!\s]*$/u,
    /设定为[：:\s]*(.+?)[。！!\s]*$/u,
    /保留这个设定[：:\s]*(.+?)[。！!\s]*$/u
  ]
  const content = patterns.map((pattern) => text.match(pattern)?.[1]?.trim()).find(Boolean)
  if (!content) return { shouldPropose: false, proposals: [] }
  return { shouldPropose: true, proposals: [{ type: classify(content), content, confidence: 1 }] }
}

const CONTRACT = `判断作者是否明确要求把某项创作决定保存为长期记忆。只输出严格 JSON：
{"shouldPropose":true|false,"proposals":[{"type":"fact|event|character_state|relationship|decision|idea|question|foreshadowing","content":"简洁、可独立理解的中文事实","confidence":0.0}]}
只有作者明确说“保存、确定采用、以后按此设定”才 shouldPropose=true。疑问、否定、反事实、仅讨论可能性、“不要记/别定/暂时想想”、引用角色说“记住”都必须 false。最多3条。你不能确认记忆。`

type AdapterFactory = (baseUrl: string, apiKey: string) => Pick<OpenAICompatibleAdapter, 'complete'>

export class MemoryIntentRunner {
  private readonly memories: MemoryService
  constructor(private readonly db: AppDatabase, private readonly providers: ProviderService,
    private readonly adapterFactory: AdapterFactory = (baseUrl, apiKey) => new OpenAICompatibleAdapter(baseUrl, apiKey)) {
    this.memories = new MemoryService(db)
  }

  async extractAndCreate(projectId: string, sourceId: string, content: string): Promise<ReturnType<MemoryService['createProposals']>> {
    const replacement = localReplacementIntent(content)
    if (replacement) {
      const previous = this.memories.findConfirmedMatch(projectId, replacement.previous)
      if (!previous) return []
      return this.memories.createProposals(projectId, sourceId, [{ type: previous.type, content: replacement.replacement,
        confidence: 1, supersedes: previous.id }])
    }
    const fallback = localMemoryIntent(content)
    if (!shouldRunMemoryIntent(content)) return []
    let result = fallback
    try {
      const model = this.providers.route('discussion')
      const { config, apiKey } = this.providers.getWithSecret(model.providerId)
      const adapter = this.adapterFactory(config.baseUrl, apiKey)
      const messages: ProviderMessage[] = [{ role: 'system', content: CONTRACT }, { role: 'user', content }]
      const raw = await adapter.complete({ model: model.modelId, messages })
      result = await this.parseWithRepair(adapter, model.modelId, messages, raw)
    } catch { /* 没有可用模型或提取失败时，仅使用保守的本地显式命令。 */ }
    if (!result.shouldPropose) return []
    return this.memories.createProposals(projectId, sourceId, result.proposals)
  }

  private async parseWithRepair(adapter: Pick<OpenAICompatibleAdapter, 'complete'>, model: string, messages: ProviderMessage[], raw: string): Promise<MemoryIntentResult> {
    try { return resultSchema.parse(JSON.parse(raw)) }
    catch (error) {
      const repaired = await adapter.complete({ model, messages: [...messages, { role: 'assistant', content: raw },
        { role: 'user', content: `上次输出不符合 JSON Schema：${error instanceof Error ? error.message : String(error)}。只返回修复后的 JSON。` }] })
      return resultSchema.parse(JSON.parse(repaired))
    }
  }
}
