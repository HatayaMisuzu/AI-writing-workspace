/**
 * L4 对照夹具：同一组输入在 base（f5d422d）与本分支上构造相同书稿并跑 runtime，
 * 记录实发 messages 的 md5（UUID 按出现顺序归一化，其余逐字）。条目 id 为确定值。
 */
import { createHash } from 'node:crypto'
import { createTestDb, testCodec } from './helpers'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { ChatService } from '../src/main/services/chat-service'
import { ProviderService, type ProviderMessage } from '../src/main/ai/provider'
import { AICreativeRuntime } from '../src/main/ai/runtime'
import type { AIMode, AITaskEnvelope, ContextBundle } from '../src/shared/domain'

export type L4Db = ReturnType<typeof createTestDb>

export const buildL4Book = (opts: { settings?: number; memories?: number; timeline?: number; characters?: number; longMemories?: boolean } = {}) => {
  const db = createTestDb()
  const project = new ProjectService(db).create({ title: 'L4', projectType: 'novel' })
  const docs = new DocumentService(db)
  const chapter = docs.listOrderedChapters(project.id)[0]
  docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc' }, plainText: '林舟握紧赤霄剑，灵脉翻涌。人物零一与人物零二并肩。' })
  const insertMemory = db.raw.prepare("INSERT INTO memories(id,project_id,type,content,status,source_type,source_id,created_at,updated_at) VALUES (?,?,?,?,?,'author','a',?,?)")
  for (let i = 0; i < (opts.settings ?? 0); i += 1) insertMemory.run(`set-${String(i).padStart(4, '0')}`, project.id, 'fact', `设定${i}：赤霄剑相关设定第 ${i} 条。`, 'confirmed', 1_000 + i, 1_000 + i)
  for (let i = 0; i < (opts.memories ?? 0); i += 1) insertMemory.run(`mem-${String(i).padStart(5, '0')}`, project.id, 'fact',
    `记忆${i}：灵脉 第 ${i} 条${opts.longMemories ? '很长的描述'.repeat(40) : ''}`, i % 3 === 0 ? 'confirmed' : 'observed', 5_000 + i, 5_000 + i)
  const insertEvent = db.raw.prepare('INSERT INTO timeline_events(id,project_id,story_time_label,sort_key,title,chapter_id,character_ids_json,created_at,updated_at) VALUES (?,?,?,?,?,NULL,\'[]\',?,?)')
  for (let i = 0; i < (opts.timeline ?? 0); i += 1) insertEvent.run(`tl-${String(i).padStart(5, '0')}`, project.id, `第${i}日`, i, `事件${i}`, 1, 1)
  const insertCharacter = db.raw.prepare("INSERT INTO characters(id,project_id,name,aliases_json,notes,fields_json,created_at,updated_at) VALUES (?,?,?,'[]',?, '{}',?,?)")
  const cn = ['零一', '零二', '零三', '零四', '零五', '零六', '零七', '零八', '零九', '一零', '一一', '一二']
  const names = Array.from({ length: opts.characters ?? 0 }, (_, i) => `人物${cn[i % cn.length]}${i >= cn.length ? i : ''}`)
  if (names.length) docs.saveContent({ projectId: project.id, documentId: chapter.id, editorJson: { type: 'doc' }, plainText: `林舟握紧赤霄剑，灵脉翻涌。${names.join('、')}一同出场。` })
  for (let i = 0; i < (opts.characters ?? 0); i += 1) insertCharacter.run(`ch-${String(i).padStart(3, '0')}`, project.id, `人物${cn[i % cn.length]}${i >= cn.length ? i : ''}`, `备注${i}`, 2_000 + i, 2_000 + i)
  return { db, project, chapterId: chapter.id }
}

export const l4Task = (projectId: string, documentId: string, mode: AIMode, extra: Partial<AITaskEnvelope> = {}): AITaskEnvelope =>
  ({ mode, writePermission: mode === 'generation' ? 'proposal' : 'none', userIntent: mode === 'consistency_check' ? '检查一致性' : '灵脉和人物零一怎么写', projectId, documentId, ...extra })

const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
export const normalizedMd5 = (messages: ProviderMessage[]): string => {
  const seen = new Map<string, string>()
  const text = JSON.stringify(messages).replace(uuidRe, (id) => { if (!seen.has(id)) seen.set(id, `<uuid${seen.size}>`); return seen.get(id)! })
  return createHash('md5').update(text).digest('hex')
}

export const runL4 = async (db: L4Db, task: AITaskEnvelope, tag: string) => {
  const providers = new ProviderService(db, testCodec)
  if (!providers.list().length) {
    providers.save({ id: 'p', providerType: 'openai-compatible', displayName: 'mock', baseUrl: 'http://localhost:11434/v1', apiKey: '' })
    providers.saveModel({ id: 'm', providerId: 'p', modelId: 'mock', displayName: 'mock', enabled: true, isDefault: true, capabilities: { streaming: true, tools: false, structuredOutput: false, cancellation: true } })
  }
  const sent: ProviderMessage[][] = []
  const runtime = new AICreativeRuntime(db, providers, () => ({ chat: async function* (input: { messages: ProviderMessage[] }) { sent.push(input.messages); yield JSON.stringify({ conflicts: [] }) } }))
  const thread = new ChatService(db).createThread(task.projectId, tag)
  const preview = runtime.previewContext(task, thread.id)
  let context: ContextBundle | undefined
  for await (const chunk of runtime.run(`r-${tag}`, task, thread.id, `u-${tag}`, `a-${tag}`)) context ??= chunk.context
  const row = db.raw.prepare('SELECT context_snapshot_json FROM chat_messages WHERE id IN (?, ?) AND context_snapshot_json IS NOT NULL').get(`u-${tag}`, `a-${tag}`) as { context_snapshot_json: string }
  return { sent: sent[0], md5: normalizedMd5(sent[0]), preview, context: context!, snapshot: JSON.parse(row.context_snapshot_json) as Record<string, unknown> }
}

export const L4_SCENARIOS = [
  { name: 'consistency-66-settings', book: { settings: 66 }, mode: 'consistency_check' as const },
  { name: 'discussion-20-memories', book: { memories: 20 }, mode: 'discussion' as const },
  { name: 'consistency-250-timeline', book: { timeline: 250 }, mode: 'consistency_check' as const },
  { name: 'generation-12-characters', book: { characters: 12, memories: 15 }, mode: 'generation' as const }
]
