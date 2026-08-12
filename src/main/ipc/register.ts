import { BrowserWindow, dialog, ipcMain } from 'electron'
import { basename, extname, join } from 'node:path'
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
import { ProjectContentService } from '../services/project-content-service'
import type { AITaskEnvelope, ModelConfig, ProviderInput, TaskModelRoute } from '../../shared/domain'

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
  const projectContent = new ProjectContentService(db)

  handle('window:minimize', () => BrowserWindow.getFocusedWindow()?.minimize())
  handle('window:toggle-maximize', () => { const win = BrowserWindow.getFocusedWindow(); if (win) win.isMaximized() ? win.unmaximize() : win.maximize() })
  handle('window:close', () => BrowserWindow.getFocusedWindow()?.close())

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
  handle('patches:propose', (input: Parameters<PatchService['propose']>[0]) => patches.propose(input))
  handle('patches:list', (projectId: string, documentId?: string) => patches.list(projectId, documentId))
  handle('patches:accept', (projectId: string, patchId: string) => patches.apply(projectId, patchId))
  handle('patches:reject', (projectId: string, patchId: string) => patches.reject(projectId, patchId))
  handle('linter:run', (text: string) => lintChineseText(text))
  handle('digests:store', (projectId: string, chapterId: string, raw: string) => digests.storeFromModel(projectId, chapterId, raw))
  handle('digests:list', (projectId: string, chapterId?: string) => digests.list(projectId, chapterId))

  handle('providers:list', () => providers.list())
  handle('providers:save', (input: ProviderInput) => providers.save(input))
  handle('providers:models', () => providers.listModels())
  handle('providers:save-model', (model: ModelConfig) => providers.saveModel(model))
  handle('providers:set-route', (route: TaskModelRoute) => providers.setRoute(route.taskType, route.modelId))
  handle('providers:test', async (providerId: string, modelId: string) => {
    const { config, apiKey } = providers.getWithSecret(providerId)
    return new OpenAICompatibleAdapter(config.baseUrl, apiKey).testConnection(modelId)
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

  ipcMain.on('ai:start', async (event, request: { task: AITaskEnvelope; threadId: string }) => {
    let requestId = 'pending'
    try {
      for await (const result of runtime.run(request.task, request.threadId)) {
        requestId = result.requestId
        event.sender.send('ai:event', { type: 'chunk', requestId, chunk: result.chunk, context: result.context })
      }
      event.sender.send('ai:event', { type: 'done', requestId })
    } catch (error) {
      const shaped = error as Error & { code?: string }
      event.sender.send('ai:event', { type: 'error', requestId, message: shaped.message, code: shaped.code })
    }
  })
  handle('ai:cancel', (requestId: string) => runtime.cancel(requestId))
}
