import { BrowserWindow, dialog, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { AppDatabase } from '../database/database'
import { ProjectService } from '../services/project-service'
import { DocumentService } from '../services/document-service'
import { IdeaService, MemoryService } from '../services/memory-service'
import { PatchService } from '../services/patch-service'
import { lintChineseText } from '../services/local-linter'
import { BackupService } from '../services/backup-service'
import { OpenAICompatibleAdapter, ProviderService, type SecretCodec } from '../ai/provider'
import { AICreativeRuntime } from '../ai/runtime'
import { ChapterDigestService } from '../ai/chapter-digest-service'
import { ChapterDigestRunner } from '../ai/digest-runner'
import { ProjectContentService } from '../services/project-content-service'
import type { ChatCursor, ModelConfig, ProviderInput, TaskModelRoute } from '../../shared/domain'
import type { AIStartRequest } from '../../shared/ipc'
import { cancelClose, confirmClose } from '../window-close'
import { ChatService } from '../services/chat-service'
import { MemoryIntentRunner } from '../ai/memory-intent'
import { ProofreadingRunner } from '../ai/proofreading-runner'

const trustedSender = (event: IpcMainInvokeEvent | IpcMainEvent): void => {
  if (event.senderFrame !== event.sender.mainFrame) throw new Error('IPC_UNTRUSTED_FRAME')
  const current = event.senderFrame.url
  const dev = process.env.ELECTRON_RENDERER_URL
  if (dev) {
    if (new URL(current).origin !== new URL(dev).origin) throw new Error('IPC_UNTRUSTED_ORIGIN')
  } else if (!current.startsWith('file:') || !/\/renderer\/index\.html(?:$|[?#])/i.test(current.replace(/\\/g, '/'))) {
    throw new Error('IPC_UNTRUSTED_ORIGIN')
  }
}

const handle = <T extends unknown[], R>(channel: string, fn: (...args: T) => R | Promise<R>): void => {
  ipcMain.handle(channel, (event, ...args: T) => { trustedSender(event); return fn(...args) })
}

const idSchema = z.string().min(1).max(200)
const shortTextSchema = z.string().max(2_000)
const contentSchema = z.string().max(5_000_000)
const nonNegativeIntSchema = z.number().int().nonnegative().max(2_147_483_647)
const editorDocumentSchema = z.object({ type: z.literal('doc'), content: z.array(z.unknown()).max(200_000) }).passthrough()
const projectCreateSchema = z.object({
  title: z.string().trim().min(1).max(500),
  projectType: z.enum(['novel', 'webnovel', 'screenplay', 'other']),
  description: shortTextSchema.optional()
})
const documentCreateSchema = z.object({
  projectId: idSchema, parentId: idSchema.nullish(), type: z.enum(['volume', 'chapter', 'scene', 'note']),
  title: z.string().trim().min(1).max(500)
})
const documentSaveSchema = z.object({
  projectId: idSchema, documentId: idSchema, editorJson: editorDocumentSchema, plainText: contentSchema,
  expectedRevision: nonNegativeIntSchema.optional(),
  styleSample: z.object({ origin: z.enum(['human', 'ai', 'ai_edited_by_human', 'mixed']), text: contentSchema }).optional()
})
const noteSaveSchema = z.object({
  id: idSchema.optional(), projectId: idSchema, section: z.enum(['story', 'reference']),
  title: shortTextSchema, content: contentSchema
})
const characterSaveSchema = z.object({
  id: idSchema.optional(), projectId: idSchema, name: z.string().trim().min(1).max(500),
  aliases: z.array(shortTextSchema).max(1_000).optional(), notes: contentSchema.optional(),
  fields: z.record(z.string().max(500), contentSchema).optional()
})
const providerInputSchema = z.object({
  id: idSchema, providerType: z.literal('openai-compatible'), displayName: z.string().trim().min(1).max(500),
  baseUrl: z.string().url().max(2_000), apiKey: z.string().max(20_000).optional()
})
const capabilitiesSchema = z.object({
  streaming: z.boolean(), tools: z.boolean(), structuredOutput: z.boolean(), cancellation: z.boolean(),
  maxContextTokens: z.number().int().positive().max(10_000_000).optional()
})
const modelSchema = z.object({
  id: idSchema, providerId: idSchema, modelId: z.string().trim().min(1).max(500),
  displayName: z.string().trim().min(1).max(500), capabilities: capabilitiesSchema,
  enabled: z.boolean(), isDefault: z.boolean()
})
const routeSchema = z.object({
  taskType: z.enum(['discussion', 'brainstorm', 'generation', 'editing', 'organization', 'chapter_digest', 'proofreading']),
  modelId: z.union([idSchema, z.literal('default')])
})
const patchProposalSchema = z.object({
  projectId: idSchema, documentId: idSchema, documentRevision: nonNegativeIntSchema,
  fromPm: nonNegativeIntSchema, toPm: nonNegativeIntSchema, originalText: contentSchema, replacement: contentSchema
}).refine((value) => value.toPm >= value.fromPm, { message: 'PATCH_PM_RANGE_INVALID' })
const snapshotReasonSchema = z.enum(['interval', 'large_delete', 'ai_edit', 'manual', 'pre_restore'])
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => schema.parse(value)
const aiStartSchema = z.object({
  requestId: idSchema, threadId: idSchema, userMessageId: idSchema, assistantMessageId: idSchema,
  task: z.object({
    mode: z.enum(['discussion','brainstorm','generation','editing','organization','chapter_digest','proofreading','reader_review']),
    writePermission: z.enum(['none','proposal','authorized']), userIntent: z.string().min(1).max(200_000),
    projectId: idSchema, documentId: idSchema.optional(), throughChapterId: idSchema.optional(),
    selection: z.object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative(), text: z.string().max(200_000) }).optional(),
    target: z.object({ requestId: idSchema, projectId: idSchema, documentId: idSchema, sourceRevision: z.number().int().nonnegative(),
      selection: z.object({ fromPm: z.number().int().nonnegative(), toPm: z.number().int().nonnegative(), text: z.string().max(200_000), originalHash: z.string().min(1).max(200) }).optional() }).optional()
  })
})

export function registerIpc(db: AppDatabase, codec: SecretCodec): void {
  const projects = new ProjectService(db)
  const documents = new DocumentService(db)
  const ideas = new IdeaService(db)
  const memories = new MemoryService(db)
  const patches = new PatchService(db)
  const providers = new ProviderService(db, codec)
  const backup = new BackupService(db)
  const runtime = new AICreativeRuntime(db, providers)
  const digests = new ChapterDigestService(db)
  const digestRunner = new ChapterDigestRunner(db, providers)
  const projectContent = new ProjectContentService(db)
  const chat = new ChatService(db)
  const memoryIntent = new MemoryIntentRunner(db, providers)
  const proofreading = new ProofreadingRunner(db, providers)

  handle('window:minimize', () => BrowserWindow.getFocusedWindow()?.minimize())
  handle('window:toggle-maximize', () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  handle('window:close', () => BrowserWindow.getFocusedWindow()?.close())
  ipcMain.handle('window:confirm-close', (event) => { trustedSender(event); return confirmClose(event.sender) })
  ipcMain.handle('window:cancel-close', (event) => { trustedSender(event); return cancelClose(event.sender) })

  handle('projects:list', (includeArchived?: boolean) => projects.list(includeArchived))
  handle('projects:create', (input: unknown) => projects.create(parse(projectCreateSchema, input)))
  handle('projects:touch', (projectId: string) => projects.touch(parse(idSchema, projectId)))
  handle('projects:rename', (projectId: string, title: string) => projects.rename(parse(idSchema, projectId), parse(shortTextSchema, title)))
  handle('projects:archive', (projectId: string, archived: boolean) => projects.archive(parse(idSchema, projectId), parse(z.boolean(), archived)))
  handle('projects:delete', (projectId: string) => projects.deletePermanently(parse(idSchema, projectId)))

  handle('documents:tree', (projectId: string) => documents.listTree(projectId))
  handle('documents:get', (projectId: string, documentId: string) => documents.getContent(projectId, documentId))
  handle('documents:create', (input: unknown) => documents.createNode(parse(documentCreateSchema, input)))
  handle('documents:rename', (projectId: string, documentId: string, title: string) => documents.rename(parse(idSchema, projectId), parse(idSchema, documentId), parse(shortTextSchema, title)))
  handle('documents:reorder', (projectId: string, documentId: string, parentId: string | null, orderIndex: number) => documents.reorder(parse(idSchema, projectId), parse(idSchema, documentId), parse(idSchema.nullable(), parentId), parse(nonNegativeIntSchema, orderIndex)))
  handle('documents:delete', (projectId: string, documentId: string) => documents.delete(parse(idSchema, projectId), parse(idSchema, documentId)))
  handle('documents:save', (input: unknown) => documents.saveContent(parse(documentSaveSchema, input)))
  handle('documents:search', (projectId: string, query: string) => documents.search(projectId, query))

  handle('snapshots:create', (projectId: string, documentId: string, reason: Parameters<DocumentService['createSnapshot']>[2]) => documents.createSnapshot(parse(idSchema, projectId), parse(idSchema, documentId), parse(snapshotReasonSchema, reason)))
  handle('snapshots:list', (projectId: string, documentId: string) => documents.listSnapshots(projectId, documentId))
  handle('snapshots:restore', (projectId: string, snapshotId: string) => documents.restoreSnapshot(parse(idSchema, projectId), parse(idSchema, snapshotId)))
  handle('ideas:list', (projectId: string) => ideas.list(projectId))
  handle('ideas:create', (projectId: string, content: string, tags?: string[]) => ideas.create(parse(idSchema, projectId), parse(contentSchema, content), parse(z.array(shortTextSchema).max(1_000).optional(), tags)))
  handle('notes:list', (projectId: string, section: 'story' | 'reference') => projectContent.listNotes(projectId, section))
  handle('notes:save', (input: unknown) => projectContent.saveNote(parse(noteSaveSchema, input)))
  handle('notes:delete', (projectId: string, noteId: string) => projectContent.deleteNote(parse(idSchema, projectId), parse(idSchema, noteId)))
  handle('characters:list', (projectId: string) => projectContent.listCharacters(projectId))
  handle('characters:save', (input: unknown) => projectContent.saveCharacter(parse(characterSaveSchema, input)))
  handle('characters:delete', (projectId: string, characterId: string) => projectContent.deleteCharacter(parse(idSchema, projectId), parse(idSchema, characterId)))
  handle('memories:list', (projectId: string) => memories.list(projectId))
  handle('memories:confirm', (projectId: string, memoryId: string) => memories.confirm(parse(idSchema, projectId), parse(idSchema, memoryId), 'user'))
  handle('memories:reject', (projectId: string, memoryId: string) => memories.reject(parse(idSchema, projectId), parse(idSchema, memoryId)))
  handle('memories:retire', (projectId: string, memoryId: string) => memories.retire(parse(idSchema, projectId), parse(idSchema, memoryId)))
  handle('memories:replace', (projectId: string, memoryId: string, content: string) => memories.proposeReplacement(parse(idSchema, projectId), parse(idSchema, memoryId), parse(contentSchema, content)))
  handle('memories:extract-intent', (projectId: string, sourceId: string, content: string) => memoryIntent.extractAndCreate(parse(idSchema, projectId), parse(idSchema, sourceId), parse(contentSchema, content)))
  handle('chat:list-threads', (projectId: string) => chat.listThreads(projectId))
  handle('chat:list-messages', (projectId: string, threadId: string, before?: ChatCursor, limit?: number) => chat.listMessages(projectId, threadId, before, limit))
  handle('chat:new-thread', (projectId: string, title?: string) => chat.createThread(parse(idSchema, projectId), parse(shortTextSchema.optional(), title)))
  handle('patches:propose', (input: unknown) => patches.propose(parse(patchProposalSchema, input)))
  handle('patches:list', (projectId: string, documentId?: string) => patches.list(projectId, documentId))
  handle('patches:prepare', (projectId: string, patchId: string, revision: number, currentText: string) => patches.prepare(parse(idSchema, projectId), parse(idSchema, patchId), parse(nonNegativeIntSchema, revision), parse(contentSchema, currentText)))
  handle('patches:complete', (projectId: string, patchId: string, savedRevision: number) => patches.complete(parse(idSchema, projectId), parse(idSchema, patchId), parse(nonNegativeIntSchema, savedRevision)))
  handle('patches:reject', (projectId: string, patchId: string) => patches.reject(parse(idSchema, projectId), parse(idSchema, patchId)))
  handle('linter:run', (text: string) => lintChineseText(text))
  handle('digests:run', (projectId: string, chapterId: string) => digestRunner.run(parse(idSchema, projectId), parse(idSchema, chapterId)))
  handle('digests:list', (projectId: string, chapterId?: string) => digests.list(projectId, chapterId))
  handle('digests:status', (projectId: string, chapterId: string) => digests.status(projectId, chapterId))
  handle('proofreading:run', (projectId: string, documentId: string) => proofreading.run(parse(idSchema, projectId), parse(idSchema, documentId)))

  handle('providers:list', () => providers.list())
  handle('providers:save', (input: ProviderInput) => providers.save(parse(providerInputSchema, input)))
  handle('providers:models', () => providers.listModels())
  handle('providers:save-model', (model: ModelConfig) => providers.saveModel(parse(modelSchema, model)))
  handle('providers:routes', () => providers.listRoutes())
  handle('providers:set-route', (route: TaskModelRoute) => { const valid = parse(routeSchema, route); return providers.setRoute(valid.taskType, valid.modelId) })
  handle('providers:test', async (providerId: string, modelId: string) => {
    try {
      providerId = parse(idSchema, providerId); modelId = parse(idSchema, modelId)
      const { config, apiKey } = providers.getWithSecret(providerId)
      return new OpenAICompatibleAdapter(config.baseUrl, apiKey).testConnection(modelId)
    } catch (error) { return { ok: false, message: error instanceof Error ? error.message : '服务配置不可用' } }
  })

  handle('backup:export-project', async (projectId: string) => {
    projectId = parse(idSchema, projectId)
    const project = projects.get(projectId)
    const result = await dialog.showSaveDialog({ defaultPath: `${project.title}.aiwproj`, filters: [{ name: '墨记项目备份', extensions: ['aiwproj'] }] })
    if (result.canceled || !result.filePath) return null
    await backup.exportProject(projectId, result.filePath)
    return result.filePath
  })
  handle('backup:import-project', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '墨记项目备份', extensions: ['aiwproj'] }] })
    if (result.canceled || !result.filePaths[0]) return null
    return backup.importProject(result.filePaths[0])
  })
  handle('backup:import-manuscript', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '文本或 Markdown', extensions: ['txt', 'md', 'markdown'] }] })
    if (result.canceled || !result.filePaths[0]) return null
    return backup.importManuscript(result.filePaths[0])
  })
  handle('backup:export-manuscript', async (projectId: string, format: 'txt' | 'md' | 'docx') => {
    projectId = parse(idSchema, projectId)
    format = parse(z.enum(['txt', 'md', 'docx']), format)
    const project = projects.get(projectId)
    const result = await dialog.showSaveDialog({ defaultPath: `${project.title}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] })
    if (result.canceled || !result.filePath) return null
    await backup.exportManuscript(projectId, result.filePath, format)
    return result.filePath
  })

  ipcMain.on('ai:start', async (event, request: AIStartRequest) => {
    try {
      trustedSender(event)
      request = aiStartSchema.parse(request) as AIStartRequest
      const target = request.task.target
      if (target && (target.requestId !== request.requestId || target.projectId !== request.task.projectId || target.documentId !== request.task.documentId)) {
        throw new Error('AI_TARGET_IDENTITY_INVALID')
      }
      for await (const result of runtime.run(request.requestId, request.task, request.threadId, request.userMessageId, request.assistantMessageId)) {
        if (!event.sender.isDestroyed()) event.sender.send('ai:event', { type: 'chunk', requestId: request.requestId, chunk: result.chunk, context: result.context })
      }
      if (!event.sender.isDestroyed()) event.sender.send('ai:event', { type: 'done', requestId: request.requestId })
    } catch (error) {
      const shaped = error as Error & { code?: string }
      if (!event.sender.isDestroyed()) event.sender.send('ai:event', { type: 'error', requestId: request?.requestId ?? 'invalid', message: shaped.message, code: shaped.code })
    }
  })
  handle('ai:cancel', (requestId: string) => runtime.cancel(parse(idSchema, requestId)))
}
