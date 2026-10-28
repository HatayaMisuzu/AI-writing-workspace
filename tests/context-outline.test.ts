import { describe, expect, it } from 'vitest'
import { createTestDb, testCodec } from './helpers'
import { ProjectService } from '../src/main/services/project-service'
import { DocumentService } from '../src/main/services/document-service'
import { ProjectContentService } from '../src/main/services/project-content-service'
import { ChatService } from '../src/main/services/chat-service'
import { ContextEngine } from '../src/main/ai/context-engine'
import { ProviderService, type ProviderMessage } from '../src/main/ai/provider'
import { AICreativeRuntime } from '../src/main/ai/runtime'
import type { AITaskEnvelope, ContextBundle } from '../src/shared/domain'

/** S5：细纲进入 AI 上下文 — 优先级在选区之后；勾选后真发送；他书隔离。 */

const indexOfKind = (items: ContextBundle['items'], kind: string, id?: string): number =>
  items.findIndex((item) => item.kind === kind && (id === undefined || item.id === id))

describe('S5 细纲进入 AI 上下文', () => {
  it('有细纲且 includedIds 勾选时出现，排序在选区之后、当前章之前', () => {
    const db = createTestDb()
    const project = new ProjectService(db).create({ title: 'S5 本书', projectType: 'novel' })
    const docs = new DocumentService(db)
    const chapter = docs.listOrderedChapters(project.id)[0]
    const volume = docs.listTree(project.id).find((n) => n.type === 'volume')!
    docs.saveContent({
      projectId: project.id, documentId: chapter.id,
      editorJson: { type: 'doc' }, plainText: '本章正文：林舟推门。'
    })
    docs.saveOutline({
      projectId: project.id, nodeId: chapter.id,
      summary: '本章细纲：雨夜推门', beats: ['推门', '对视'], hook: '门外脚步'
    })
    docs.saveOutline({ projectId: project.id, nodeId: volume.id, summary: '卷梗概：旧书店线' })
    new ProjectContentService(db).saveNote({
      projectId: project.id, section: 'outline', title: '全书核心', content: '全书：小镇少年入世'
    })

    const chapterOutlineId = `outline:${chapter.id}`
    const volumeOutlineId = `outline:${volume.id}`
    const engine = new ContextEngine(db)
    const bundle = engine.build({
      mode: 'generation', writePermission: 'proposal', userIntent: '按细纲续写',
      projectId: project.id, documentId: chapter.id,
      selection: { text: '推门', from: 0, to: 2 },
      includedIds: [chapterOutlineId, volumeOutlineId]
    })

    const sel = indexOfKind(bundle.items, 'selection')
    const chapOutline = indexOfKind(bundle.items, 'outline', chapterOutlineId)
    const volOutline = indexOfKind(bundle.items, 'outline', volumeOutlineId)
    const doc = indexOfKind(bundle.items, 'document', chapter.id)

    expect(sel).toBeGreaterThanOrEqual(0)
    expect(chapOutline).toBeGreaterThanOrEqual(0)
    expect(volOutline).toBeGreaterThanOrEqual(0)
    expect(doc).toBeGreaterThanOrEqual(0)
    // 选区 > 本章细纲 > 卷梗概 > 当前章
    expect(sel).toBeLessThan(chapOutline)
    expect(chapOutline).toBeLessThan(volOutline)
    expect(volOutline).toBeLessThan(doc)
    expect(JSON.stringify(bundle.items)).toContain('本章细纲：雨夜推门')
    expect(JSON.stringify(bundle.items)).toContain('卷梗概：旧书店线')
  })

  it('未勾选时细纲不进发送清单（仍在 omitted / default_excluded）', () => {
    const db = createTestDb()
    const project = new ProjectService(db).create({ title: 'S5 默认排除', projectType: 'novel' })
    const docs = new DocumentService(db)
    const chapter = docs.listOrderedChapters(project.id)[0]
    docs.saveOutline({ projectId: project.id, nodeId: chapter.id, summary: '不该默认发送的细纲' })
    const outlineId = `outline:${chapter.id}`
    const bundle = new ContextEngine(db).build({
      mode: 'discussion', writePermission: 'none', userIntent: '参谋一下',
      projectId: project.id, documentId: chapter.id
    })
    expect(bundle.items.some((i) => i.id === outlineId)).toBe(false)
    expect(bundle.metadata.omitted).toContainEqual(
      expect.objectContaining({ id: outlineId, kind: 'outline', reason: 'default_excluded' })
    )
    expect(JSON.stringify(bundle.items)).not.toContain('不该默认发送的细纲')
  })

  it('隔离：他书细纲不出现在本书上下文', () => {
    const db = createTestDb()
    const projects = new ProjectService(db)
    const a = projects.create({ title: '书A', projectType: 'novel' })
    const b = projects.create({ title: '书B', projectType: 'novel' })
    const docs = new DocumentService(db)
    const aChapter = docs.listOrderedChapters(a.id)[0]
    const bChapter = docs.listOrderedChapters(b.id)[0]
    docs.saveContent({
      projectId: a.id, documentId: aChapter.id,
      editorJson: { type: 'doc' }, plainText: 'A 正文'
    })
    docs.saveOutline({ projectId: a.id, nodeId: aChapter.id, summary: 'A 细纲仅此书' })
    docs.saveOutline({ projectId: b.id, nodeId: bChapter.id, summary: 'B 他书细纲机密' })
    new ProjectContentService(db).saveNote({
      projectId: b.id, section: 'outline', title: 'B全书', content: 'B 全书核心大纲不该泄漏'
    })

    const aOutlineId = `outline:${aChapter.id}`
    const bOutlineId = `outline:${bChapter.id}`
    // 故意把他书 id 塞进 includedIds，仍不应出现（projectId 过滤）
    const bundle = new ContextEngine(db).build({
      mode: 'generation', writePermission: 'proposal', userIntent: '续写',
      projectId: a.id, documentId: aChapter.id,
      includedIds: [aOutlineId, bOutlineId]
    })

    expect(bundle.items.some((i) => i.id === aOutlineId)).toBe(true)
    expect(bundle.items.some((i) => i.id === bOutlineId)).toBe(false)
    expect(JSON.stringify(bundle.items)).toContain('A 细纲仅此书')
    expect(JSON.stringify(bundle.items)).not.toContain('B 他书细纲机密')
    expect(JSON.stringify(bundle.items)).not.toContain('B 全书核心大纲不该泄漏')
    expect(JSON.stringify(bundle.metadata.omitted ?? [])).not.toContain('B 他书细纲机密')
  })

  it('勾选后执笔/参谋实际发送 messages 含细纲正文', async () => {
    const db = createTestDb()
    const project = new ProjectService(db).create({ title: 'S5 发送', projectType: 'novel' })
    const docs = new DocumentService(db)
    const chapter = docs.listOrderedChapters(project.id)[0]
    docs.saveContent({
      projectId: project.id, documentId: chapter.id,
      editorJson: { type: 'doc' }, plainText: '正文片段'
    })
    docs.saveOutline({
      projectId: project.id, nodeId: chapter.id,
      summary: '发送验收细纲标记句', beats: ['节拍甲']
    })
    const outlineId = `outline:${chapter.id}`
    const providers = new ProviderService(db, testCodec)
    providers.save({ id: 'p', providerType: 'openai-compatible', displayName: 'fixture', baseUrl: 'http://fixture/v1', apiKey: 'k' })
    providers.saveModel({
      id: 'm', providerId: 'p', modelId: 'm', displayName: 'fixture', enabled: true, isDefault: true,
      capabilities: { streaming: true, tools: false, structuredOutput: false, cancellation: true, maxContextTokens: 16_000 }
    })
    const thread = new ChatService(db).createThread(project.id)
    const captured: ProviderMessage[][] = []
    const runtime = new AICreativeRuntime(db, providers, () => ({
      chat: async function * (input: { messages: ProviderMessage[] }) {
        captured.push(input.messages)
        yield '好'
      }
    }))

    for (const mode of ['generation', 'discussion'] as const) {
      captured.length = 0
      const task: AITaskEnvelope = {
        mode, writePermission: mode === 'generation' ? 'proposal' : 'none',
        userIntent: mode === 'generation' ? '按细纲起草' : '这一章细纲如何？',
        projectId: project.id, documentId: chapter.id,
        includedIds: [outlineId]
      }
      let sent: ContextBundle | undefined
      for await (const event of runtime.run(`r-${mode}`, task, thread.id, `u-${mode}`, `a-${mode}`)) {
        sent ??= event.context
      }
      expect(sent!.items.some((i) => i.id === outlineId && i.kind === 'outline')).toBe(true)
      expect(JSON.stringify(captured[0])).toContain('发送验收细纲标记句')
      const contextMessage = captured[0][1].content
      expect(contextMessage).toContain('[outline]')
      expect(contextMessage).toContain('发送验收细纲标记句')
    }
  })

  it('全书核心大纲 note 勾选后排序在选区之后、当前章之前', () => {
    const db = createTestDb()
    const project = new ProjectService(db).create({ title: 'S5 全书大纲', projectType: 'novel' })
    const docs = new DocumentService(db)
    const chapter = docs.listOrderedChapters(project.id)[0]
    docs.saveContent({
      projectId: project.id, documentId: chapter.id,
      editorJson: { type: 'doc' }, plainText: '正文'
    })
    const note = new ProjectContentService(db).saveNote({
      projectId: project.id, section: 'outline', title: '核心', content: '全书弧线：成长与归来'
    })
    const noteId = `outline-note:${note.id}`
    const bundle = new ContextEngine(db).build({
      mode: 'discussion', writePermission: 'none', userIntent: '参谋',
      projectId: project.id, documentId: chapter.id,
      selection: { text: '正文', from: 0, to: 2 },
      includedIds: [noteId]
    })
    const sel = indexOfKind(bundle.items, 'selection')
    const outline = indexOfKind(bundle.items, 'outline', noteId)
    const doc = indexOfKind(bundle.items, 'document', chapter.id)
    expect(sel).toBeLessThan(outline)
    expect(outline).toBeLessThan(doc)
    expect(JSON.stringify(bundle.items)).toContain('全书弧线：成长与归来')
  })
})
