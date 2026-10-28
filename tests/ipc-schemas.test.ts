import { describe, expect, it } from 'vitest'
import {
  aiStartSchema, characterSaveSchema, documentCreateSchema, documentSaveSchema, idSchema, modelSchema, noteSaveSchema,
  patchProposalSchema, projectCreateSchema, providerInputSchema, routeSchema, snapshotReasonSchema
} from '../src/main/ipc/schemas'

const rejects = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): boolean => !schema.safeParse(value).success
const doc = { type: 'doc', content: [] }
const caps = { streaming: true, tools: false, structuredOutput: false, cancellation: true }

describe('IPC zod schemas — rejection paths', () => {
  it('idSchema rejects empty, too long and non-string ids', () => {
    expect(rejects(idSchema, '')).toBe(true)
    expect(rejects(idSchema, 'x'.repeat(201))).toBe(true)
    expect(rejects(idSchema, 42)).toBe(true)
    expect(rejects(idSchema, null)).toBe(true)
    expect(idSchema.parse('ok')).toBe('ok')
  })

  it('projectCreateSchema rejects blank titles and unknown project types', () => {
    expect(rejects(projectCreateSchema, { title: '   ', projectType: 'novel' })).toBe(true)
    expect(rejects(projectCreateSchema, { title: 'x'.repeat(501), projectType: 'novel' })).toBe(true)
    expect(rejects(projectCreateSchema, { title: '书', projectType: 'poem' })).toBe(true)
    expect(rejects(projectCreateSchema, { title: '书', projectType: 'novel', description: 'x'.repeat(2_001) })).toBe(true)
    expect(projectCreateSchema.parse({ title: ' 书 ', projectType: 'webnovel' }).title).toBe('书')
  })

  it('documentCreateSchema / documentSaveSchema reject bad types, editor json and revisions', () => {
    expect(rejects(documentCreateSchema, { projectId: 'p', type: 'folder', title: 't' })).toBe(true)
    expect(rejects(documentCreateSchema, { projectId: 'p', type: 'chapter', title: '' })).toBe(true)
    const base = { projectId: 'p', documentId: 'd', editorJson: doc, plainText: '' }
    expect(rejects(documentSaveSchema, { ...base, editorJson: { type: 'paragraph', content: [] } })).toBe(true)
    expect(rejects(documentSaveSchema, { ...base, editorJson: { type: 'doc' } })).toBe(true)
    expect(rejects(documentSaveSchema, { ...base, expectedRevision: -1 })).toBe(true)
    expect(rejects(documentSaveSchema, { ...base, expectedRevision: 1.5 })).toBe(true)
    expect(rejects(documentSaveSchema, { ...base, styleSample: { origin: 'robot', text: '' } })).toBe(true)
    expect(documentSaveSchema.safeParse(base).success).toBe(true)
  })

  it('noteSaveSchema / characterSaveSchema reject invalid sections and names', () => {
    expect(rejects(noteSaveSchema, { projectId: 'p', section: 'secret', title: 't', content: '' })).toBe(true)
    expect(rejects(noteSaveSchema, { projectId: 'p', section: 'story', title: 'x'.repeat(2_001), content: '' })).toBe(true)
    expect(rejects(characterSaveSchema, { projectId: 'p', name: '  ' })).toBe(true)
    expect(rejects(characterSaveSchema, { projectId: 'p', name: '甲', aliases: ['a'.repeat(2_001)] })).toBe(true)
    expect(rejects(characterSaveSchema, { projectId: 'p', name: '甲', fields: { ['k'.repeat(501)]: 'v' } })).toBe(true)
  })

  it('providerInputSchema rejects unsupported provider types and malformed base URLs', () => {
    const base = { id: 'prov', providerType: 'openai-compatible', displayName: '本地', baseUrl: 'http://localhost:11434/v1' }
    expect(providerInputSchema.safeParse(base).success).toBe(true)
    expect(rejects(providerInputSchema, { ...base, providerType: 'anthropic' })).toBe(true)
    expect(rejects(providerInputSchema, { ...base, displayName: ' ' })).toBe(true)
    for (const baseUrl of ['', 'not a url', 'http://', 'https://exa mple.com', `http://a.com/${'x'.repeat(2_000)}`]) {
      expect(rejects(providerInputSchema, { ...base, baseUrl }), baseUrl).toBe(true)
    }
    expect(rejects(providerInputSchema, { ...base, apiKey: 'k'.repeat(20_001) })).toBe(true)
  })

  it('providerInputSchema only accepts http/https base URLs (S1c)', () => {
    const base = { id: 'prov', providerType: 'openai-compatible', displayName: 'x' }
    for (const baseUrl of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/plain,hi', 'ftp://example.com', 'mailto:a@b.com', 'ws://localhost:1', 'vbscript:x', 'localhost:11434', 'api.example.com/v1']) {
      expect(rejects(providerInputSchema, { ...base, baseUrl }), baseUrl).toBe(true)
    }
    for (const baseUrl of ['http://localhost', 'http://localhost:11434/v1', 'http://127.0.0.1:8080', 'https://api.example.com/v1/', 'HTTPS://API.EXAMPLE.COM']) {
      expect(providerInputSchema.safeParse({ ...base, baseUrl }).success, baseUrl).toBe(true)
    }
  })

  it('modelSchema / routeSchema reject bad capabilities and unknown tasks', () => {
    const model = { id: 'm', providerId: 'p', modelId: 'qwen', displayName: 'Q', capabilities: caps, enabled: true, isDefault: false }
    expect(modelSchema.safeParse(model).success).toBe(true)
    expect(rejects(modelSchema, { ...model, capabilities: { ...caps, maxContextTokens: 0 } })).toBe(true)
    expect(rejects(modelSchema, { ...model, capabilities: { streaming: true } })).toBe(true)
    expect(rejects(modelSchema, { ...model, enabled: 'yes' })).toBe(true)
    expect(rejects(routeSchema, { taskType: 'reader_review', modelId: 'm' })).toBe(true)
    expect(rejects(routeSchema, { taskType: 'discussion', modelId: '' })).toBe(true)
  })

  it('patchProposalSchema rejects reversed or negative ranges', () => {
    const base = { projectId: 'p', documentId: 'd', documentRevision: 1, fromPm: 5, toPm: 10, originalText: 'a', replacement: 'b' }
    expect(patchProposalSchema.safeParse(base).success).toBe(true)
    expect(rejects(patchProposalSchema, { ...base, toPm: 4 })).toBe(true)
    expect(rejects(patchProposalSchema, { ...base, fromPm: -1 })).toBe(true)
    expect(rejects(patchProposalSchema, { ...base, documentRevision: -1 })).toBe(true)
  })

  it('snapshotReasonSchema / aiStartSchema reject unknown enums and empty intent', () => {
    expect(rejects(snapshotReasonSchema, 'auto')).toBe(true)
    const start = { requestId: 'r', threadId: 't', userMessageId: 'u', assistantMessageId: 'a',
      task: { mode: 'discussion', writePermission: 'none', userIntent: '问', projectId: 'p' } }
    expect(aiStartSchema.safeParse(start).success).toBe(true)
    expect(rejects(aiStartSchema, { ...start, task: { ...start.task, mode: 'autocomplete' } })).toBe(true)
    expect(rejects(aiStartSchema, { ...start, task: { ...start.task, writePermission: 'direct' } })).toBe(true)
    expect(rejects(aiStartSchema, { ...start, task: { ...start.task, userIntent: '' } })).toBe(true)
    expect(rejects(aiStartSchema, { ...start, task: { ...start.task, selection: { from: -1, to: 0, text: '' } } })).toBe(true)
  })
})
