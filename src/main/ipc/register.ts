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
import { originFromBaseUrl } from '../network-policy'
import { checkBaseUrl } from '../../shared/base-url'
import { AICreativeRuntime } from '../ai/runtime'
import { ChapterDigestService } from '../ai/chapter-digest-service'
import { ChapterDigestRunner } from '../ai/digest-runner'
import { ProjectContentService } from '../services/project-content-service'
import type { ChatCursor, ModelConfig, ProviderInput, TaskModelRoute } from '../../shared/domain'
import type { AIPreviewContextRequest, AIStartRequest } from '../../shared/ipc'
import { cancelClose, confirmClose } from '../window-close'
import { ChatService } from '../services/chat-service'
import { MemoryIntentRunner } from '../ai/memory-intent'
import { ProofreadingRunner } from '../ai/proofreading-runner'
import { WritingDailyService } from '../services/writing-daily-service'
import { ForeshadowService } from '../services/foreshadow-service'

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

import {
  idSchema, shortTextSchema, contentSchema, nonNegativeIntSchema, projectCreateSchema, documentCreateSchema, documentSaveSchema, noteSaveSchema, characterSaveSchema, providerInputSchema, modelSchema, routeSchema, patchProposalSchema, snapshotReasonSchema, aiStartSchema, aiPreviewContextSchema, noteSectionSchema, outlineSaveSchema, batchCreateChaptersSchema, writingGoalsInputSchema, chapterStatusSchema, foreshadowRegisterSchema, foreshadowSetStateSchema, foreshadowUpdateMetaSchema
} from './schemas'
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => schema.parse(value)

export type NetworkHooks = {
  refreshNetworkAllowlist(): void
  allowOriginTemporarily(origin: string): () => void
  getBlockedLog(): readonly { url: string; reason: string; at: number }[]
}

export function registerIpc(db: AppDatabase, codec: SecretCodec, network?: NetworkHooks): void {
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
  const writingDaily = new WritingDailyService(db)
  const foreshadows = new ForeshadowService(db)

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
  handle('notes:list', (projectId: string, section: unknown) => projectContent.listNotes(parse(idSchema, projectId), parse(noteSectionSchema, section)))
  handle('outlines:get', (projectId: string, nodeId: string) => documents.getOutline(parse(idSchema, projectId), parse(idSchema, nodeId)))
  handle('outlines:list', (projectId: string) => documents.listOutlines(parse(idSchema, projectId)))
  handle('outlines:save', (input: unknown) => documents.saveOutline(parse(outlineSaveSchema, input)))
  handle('documents:batch-create-chapters', (input: unknown) => documents.batchCreateChaptersFromOutlines(parse(batchCreateChaptersSchema, input)))
  handle('documents:set-status', (projectId: string, documentId: string, status: unknown) => documents.setChapterStatus(parse(idSchema, projectId), parse(idSchema, documentId), parse(chapterStatusSchema, status)))
  handle('documents:get-stockpile', (projectId: string) => documents.getStockpile(parse(idSchema, projectId)))
  handle('documents:get-serial-progress', (projectId: string) => documents.getSerialProgress(parse(idSchema, projectId)))
  handle('documents:set-serial-progress', (projectId: string, progressChapterId: unknown) => documents.setSerialProgress(parse(idSchema, projectId), parse(idSchema.nullable(), progressChapterId)))
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
  handle('foreshadows:list-ledger', (projectId: string) => foreshadows.listLedger(parse(idSchema, projectId)))
  handle('foreshadows:list-pending', (projectId: string) => foreshadows.listPending(parse(idSchema, projectId)))
  handle('foreshadows:register', (input: unknown) => {
    const parsed = parse(foreshadowRegisterSchema, input)
    return foreshadows.registerFromSelection(parsed)
  })
  handle('foreshadows:set-state', (input: unknown) => {
    const parsed = parse(foreshadowSetStateSchema, input)
    return foreshadows.setState(parsed.projectId, parsed.memoryId, parsed.state, {
      abandonReason: parsed.abandonReason,
      resolvedChapterId: parsed.resolvedChapterId,
      plannedChapterId: parsed.plannedChapterId,
      characterIds: parsed.characterIds
    })
  })
  handle('foreshadows:update-meta', (input: unknown) => {
    const parsed = parse(foreshadowUpdateMetaSchema, input)
    return foreshadows.updateMeta(parsed.projectId, parsed.memoryId, {
      plannedChapterId: parsed.plannedChapterId,
      resolvedChapterId: parsed.resolvedChapterId,
      characterIds: parsed.characterIds
    })
  })

  handle('chat:list-threads', (projectId: string) => chat.listThreads(projectId))
  handle('chat:list-messages', (projectId: string, threadId: string, before?: ChatCursor, limit?: number) => chat.listMessages(projectId, threadId, before, limit))
  handle('chat:new-thread', (projectId: string, title?: string) => chat.createThread(parse(idSchema, projectId), parse(shortTextSchema.optional(), title)))
  handle('patches:propose', (input: unknown) => patches.propose(parse(patchProposalSchema, input)))
  handle('patches:list', (projectId: string, documentId?: string) => patches.list(projectId, documentId))
  handle('patches:prepare', (projectId: string, patchId: string, revision: number, currentText: string) => patches.prepare(parse(idSchema, projectId), parse(idSchema, patchId), parse(nonNegativeIntSchema, revision), parse(contentSchema, currentText)))
  handle('patches:complete', (projectId: string, patchId: string, savedRevision: number) => patches.complete(parse(idSchema, projectId), parse(idSchema, patchId), parse(nonNegativeIntSchema, savedRevision)))
  handle('patches:reject', (projectId: string, patchId: string) => patches.reject(parse(idSchema, projectId), parse(idSchema, patchId)))

  handle('writing:get-day', (projectId: string, date?: string) => writingDaily.getDay(parse(idSchema, projectId), date === undefined ? undefined : parse(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), date)))
  handle('writing:list-range', (projectId: string, fromDate: string, toDate: string) => writingDaily.listRange(parse(idSchema, projectId), parse(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), fromDate), parse(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), toDate)))
  handle('writing:get-goals', (projectId: string) => writingDaily.getGoals(parse(idSchema, projectId)))
  handle('writing:set-goals', (projectId: string, input: unknown) => writingDaily.setGoals(parse(idSchema, projectId), parse(writingGoalsInputSchema, input)))
  handle('linter:run', (text: string) => lintChineseText(text))
  handle('digests:run', (projectId: string, chapterId: string) => digestRunner.run(parse(idSchema, projectId), parse(idSchema, chapterId)))
  handle('digests:list', (projectId: string, chapterId?: string) => digests.list(projectId, chapterId))
  handle('digests:status', (projectId: string, chapterId: string) => digests.status(projectId, chapterId))
  handle('proofreading:run', (projectId: string, documentId: string) => proofreading.run(parse(idSchema, projectId), parse(idSchema, documentId)))

  handle('providers:list', () => providers.list())
  handle('providers:save', (input: ProviderInput) => {
    const saved = providers.save(parse(providerInputSchema, input))
    network?.refreshNetworkAllowlist()
    return saved
  })
  handle('providers:models', () => providers.listModels())
  handle('providers:save-model', (model: ModelConfig) => providers.saveModel(parse(modelSchema, model)))
  handle('providers:routes', () => providers.listRoutes())
  handle('providers:set-route', (route: TaskModelRoute) => { const valid = parse(routeSchema, route); return providers.setRoute(valid.taskType, valid.modelId) })
  handle('providers:test', async (providerId: string, modelId: string) => {
    try {
      providerId = parse(idSchema, providerId); modelId = parse(idSchema, modelId)
      const { config, apiKey } = providers.getWithSecret(providerId)
      const origin = originFromBaseUrl(config.baseUrl)
      const revoke = origin && network ? network.allowOriginTemporarily(origin) : () => {}
      try { return await new OpenAICompatibleAdapter(config.baseUrl, apiKey).testConnection(modelId) }
      finally { revoke() }
    } catch (error) { return { ok: false, message: error instanceof Error ? error.message : '服务配置不可用' } }
  })
  // S2 / 决策 11：未保存地址仅在测试连接时临时放行（不写入白名单）
  handle('providers:test-url', async (input: { baseUrl: string; apiKey?: string; modelId: string }) => {
    try {
      const body = z.object({
        baseUrl: z.string().min(1).max(2000),
        apiKey: z.string().max(4000).optional(),
        modelId: z.string().min(1).max(200)
      }).parse(input)
      const checked = checkBaseUrl(body.baseUrl)
      if (!checked.ok) return { ok: false, message: checked.message }
      const origin = originFromBaseUrl(checked.url)
      if (!origin) return { ok: false, message: '无法解析服务地址' }
      const revoke = network ? network.allowOriginTemporarily(origin) : () => {}
      try {
        return await new OpenAICompatibleAdapter(checked.url, body.apiKey ?? '').testConnection(body.modelId)
      } finally { revoke() }
    } catch (error) { return { ok: false, message: error instanceof Error ? error.message : '服务配置不可用' } }
  })
  handle('network:blocked-log', () => network?.getBlockedLog() ?? [])

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
  handle('backup:export-manuscript', async (projectId: string, format: 'txt' | 'md' | 'docx', onlyFinal?: boolean) => {
    projectId = parse(idSchema, projectId)
    format = parse(z.enum(['txt', 'md', 'docx']), format)
    const finalOnly = parse(z.boolean().optional(), onlyFinal) === true
    const project = projects.get(projectId)
    const suffix = finalOnly ? '-仅定稿' : ''
    const result = await dialog.showSaveDialog({ defaultPath: `${project.title}${suffix}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] })
    if (result.canceled || !result.filePath) return null
    await backup.exportManuscript(projectId, result.filePath, format, { onlyFinal: finalOnly })
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
      let candidates: string[] | undefined
      for await (const result of runtime.run(request.requestId, request.task, request.threadId, request.userMessageId, request.assistantMessageId)) {
        if (result.candidates) candidates = result.candidates
        if (result.chunk && !event.sender.isDestroyed()) {
          event.sender.send('ai:event', { type: 'chunk', requestId: request.requestId, chunk: result.chunk, context: result.context })
        }
      }
      if (!event.sender.isDestroyed()) event.sender.send('ai:event', { type: 'done', requestId: request.requestId, candidates })
    } catch (error) {
      const shaped = error as Error & { code?: string }
      if (!event.sender.isDestroyed()) event.sender.send('ai:event', { type: 'error', requestId: request?.requestId ?? 'invalid', message: shaped.message, code: shaped.code })
    }
  })
  handle('ai:preview-context', (request: AIPreviewContextRequest) => {
    const parsed = aiPreviewContextSchema.parse(request) as AIPreviewContextRequest
    return runtime.previewContext(parsed.task, parsed.threadId)
  })
  handle('ai:cancel', (requestId: string) => runtime.cancel(parse(idSchema, requestId)))
}
