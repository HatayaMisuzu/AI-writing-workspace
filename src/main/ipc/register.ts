import { BrowserWindow, dialog, ipcMain } from 'electron'
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
import type { ModelConfig, ProviderInput, TaskModelRoute } from '../../shared/domain'
import type { AIStartRequest } from '../../shared/ipc'
import { cancelClose, confirmClose } from '../window-close'
import { ChatService } from '../services/chat-service'
import { MemoryIntentRunner } from '../ai/memory-intent'
import { ProofreadingRunner } from '../ai/proofreading-runner'

const handle = <T extends unknown[], R>(channel: string, fn: (...args: T) => R | Promise<R>): void => {
  ipcMain.handle(channel, (_event, ...args: T) => fn(...args))
}

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
  ipcMain.handle('window:confirm-close', (event) => confirmClose(event.sender))
  ipcMain.handle('window:cancel-close', (event) => cancelClose(event.sender))

  handle('projects:list', (includeArchived?: boolean) => projects.list(includeArchived))
  handle('projects:create', (input: Parameters<ProjectService['create']>[0]) => projects.create(input))
  handle('projects:touch', (projectId: string) => projects.touch(projectId))
  handle('projects:rename', (projectId: string, title: string) => projects.rename(projectId, title))
  handle('projects:archive', (projectId: string, archived: boolean) => projects.archive(projectId, archived))
  handle('projects:delete', (projectId: string) => projects.deletePermanently(projectId))

  handle('documents:tree', (projectId: string) => documents.listTree(projectId))
  handle('documents:get', (projectId: string, documentId: string) => documents.getContent(projectId, documentId))
  handle('documents:create', (input: Parameters<DocumentService['createNode']>[0]) => documents.createNode(input))
  handle('documents:rename', (projectId: string, documentId: string, title: string) => documents.rename(projectId, documentId, title))
  handle('documents:reorder', (projectId: string, documentId: string, parentId: string | null, orderIndex: number) => documents.reorder(projectId, documentId, parentId, orderIndex))
  handle('documents:delete', (projectId: string, documentId: string) => documents.delete(projectId, documentId))
  handle('documents:save', (input: Parameters<DocumentService['saveContent']>[0]) => documents.saveContent(input))
  handle('documents:search', (projectId: string, query: string) => documents.search(projectId, query))

  handle('snapshots:create', (projectId: string, documentId: string, reason: Parameters<DocumentService['createSnapshot']>[2]) => documents.createSnapshot(projectId, documentId, reason))
  handle('snapshots:list', (projectId: string, documentId: string) => documents.listSnapshots(projectId, documentId))
  handle('snapshots:restore', (projectId: string, snapshotId: string) => documents.restoreSnapshot(projectId, snapshotId))
  handle('ideas:list', (projectId: string) => ideas.list(projectId))
  handle('ideas:create', (projectId: string, content: string, tags?: string[]) => ideas.create(projectId, content, tags))
  handle('notes:list', (projectId: string, section: 'story' | 'reference') => projectContent.listNotes(projectId, section))
  handle('notes:save', (input: Parameters<ProjectContentService['saveNote']>[0]) => projectContent.saveNote(input))
  handle('notes:delete', (projectId: string, noteId: string) => projectContent.deleteNote(projectId, noteId))
  handle('characters:list', (projectId: string) => projectContent.listCharacters(projectId))
  handle('characters:save', (input: Parameters<ProjectContentService['saveCharacter']>[0]) => projectContent.saveCharacter(input))
  handle('characters:delete', (projectId: string, characterId: string) => projectContent.deleteCharacter(projectId, characterId))
  handle('memories:list', (projectId: string) => memories.list(projectId))
  handle('memories:confirm', (projectId: string, memoryId: string) => memories.confirm(projectId, memoryId, 'user'))
  handle('memories:reject', (projectId: string, memoryId: string) => memories.reject(projectId, memoryId))
  handle('memories:propose-from-chat', (projectId: string, sourceId: string, content: string) => memories.proposeFromChat(projectId, sourceId, content))
  handle('memories:extract-intent', (projectId: string, sourceId: string, content: string) => memoryIntent.extractAndCreate(projectId, sourceId, content))
  handle('chat:list-threads', (projectId: string) => chat.listThreads(projectId))
  handle('chat:list-messages', (projectId: string, threadId: string, before?: number, limit?: number) => chat.listMessages(projectId, threadId, before, limit))
  handle('chat:new-thread', (projectId: string, title?: string) => chat.createThread(projectId, title))
  handle('patches:propose', (input: Parameters<PatchService['propose']>[0]) => patches.propose(input))
  handle('patches:list', (projectId: string, documentId?: string) => patches.list(projectId, documentId))
  handle('patches:prepare', (projectId: string, patchId: string, revision: number, currentText: string) => patches.prepare(projectId, patchId, revision, currentText))
  handle('patches:complete', (projectId: string, patchId: string, savedRevision: number) => patches.complete(projectId, patchId, savedRevision))
  handle('patches:reject', (projectId: string, patchId: string) => patches.reject(projectId, patchId))
  handle('linter:run', (text: string) => lintChineseText(text))
  handle('digests:store', (projectId: string, chapterId: string, raw: string) => digests.storeFromModel(projectId, chapterId, raw))
  handle('digests:run', (projectId: string, chapterId: string) => digestRunner.run(projectId, chapterId))
  handle('digests:list', (projectId: string, chapterId?: string) => digests.list(projectId, chapterId))
  handle('digests:status', (projectId: string, chapterId: string) => digests.status(projectId, chapterId))
  handle('proofreading:run', (projectId: string, documentId: string) => proofreading.run(projectId, documentId))

  handle('providers:list', () => providers.list())
  handle('providers:save', (input: ProviderInput) => providers.save(input))
  handle('providers:models', () => providers.listModels())
  handle('providers:save-model', (model: ModelConfig) => providers.saveModel(model))
  handle('providers:routes', () => providers.listRoutes())
  handle('providers:set-route', (route: TaskModelRoute) => providers.setRoute(route.taskType, route.modelId))
  handle('providers:test', async (providerId: string, modelId: string) => {
    try {
      const { config, apiKey } = providers.getWithSecret(providerId)
      return new OpenAICompatibleAdapter(config.baseUrl, apiKey).testConnection(modelId)
    } catch (error) { return { ok: false, message: error instanceof Error ? error.message : '服务配置不可用' } }
  })

  handle('backup:export-project', async (projectId: string) => {
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
    const project = projects.get(projectId)
    const result = await dialog.showSaveDialog({ defaultPath: `${project.title}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] })
    if (result.canceled || !result.filePath) return null
    await backup.exportManuscript(projectId, result.filePath, format)
    return result.filePath
  })

  ipcMain.on('ai:start', async (event, request: AIStartRequest) => {
    try {
      for await (const result of runtime.run(request.requestId, request.task, request.threadId, request.userMessageId, request.assistantMessageId)) {
        event.sender.send('ai:event', { type: 'chunk', requestId: request.requestId, chunk: result.chunk, context: result.context })
      }
      event.sender.send('ai:event', { type: 'done', requestId: request.requestId })
    } catch (error) {
      const shaped = error as Error & { code?: string }
      event.sender.send('ai:event', { type: 'error', requestId: request.requestId, message: shaped.message, code: shaped.code })
    }
  })
  handle('ai:cancel', (requestId: string) => runtime.cancel(requestId))
}
