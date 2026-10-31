import { PromptTemplateService, readGlobalTemplateFile } from '../services/prompt-template-service'
import { runManuscriptExport } from '../services/manuscript-export-flow'
import type { ExportChapterRange } from '../../shared/export-range'
import { BrowserWindow, dialog, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { AppDatabase } from '../database/database'
import { ProjectService } from '../services/project-service'
import { DocumentService } from '../services/document-service'
import { IdeaService, MemoryService } from '../services/memory-service'
import { PatchService } from '../services/patch-service'
import { LintService, readWordlistFile, type WordlistScope } from '../services/lint-service'
import { atomicWriteFile, BackupService } from '../services/backup-service'
import { createProviderAdapter, ProviderService, type SecretCodec } from '../ai/provider'
import { originFromBaseUrl } from '../network-policy'
import { checkBaseUrl, redactBaseUrl, restoreRedactedSecrets, sameEndpoint } from '../../shared/base-url'
import { baseUrlKeyDecision } from '../ai/base-url-confirm'
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
import { TimelineService } from '../services/timeline-service'
import { FocusLockError, FocusLockService, assertNoFocusLockAnywhere, assertNotFocusLocked, focusEgressCheck } from '../services/focus-lock-service'
import { readHoverPrefs, writeHoverPrefs } from '../services/hover-prefs-service'
import { installFocusEgressLock } from '../net/egress-guard'

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

/**
 * A·M1：带 API Key 发往新地址前的 main 侧原生确认框。默认按钮与取消按钮都是「取消」；只有点「确认发送」才返回 true。
 * 地址经 redactBaseUrl 脱敏（query 密钥参数、账号密码不显示）。
 */
const confirmKeyToNewBaseUrl = async (event: IpcMainInvokeEvent, nextUrl: string, previousUrl: string | undefined, mode: 'test' | 'save' = 'test'): Promise<boolean> => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const options = {
    type: 'warning' as const,
    buttons: ['取消', '确认发送'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: '确认发送 API Key',
    message: mode === 'save'
      ? '服务地址与上次保存的不同，保存后已保存的 API Key 将发往新地址。'
      : previousUrl ? '服务地址与上次保存的不同，API Key 将发往新地址。' : '这个服务地址还没有保存过，API Key 将发往该地址。',
    detail: mode === 'save'
      ? `上次保存的地址：${redactBaseUrl(previousUrl ?? '')}\n本次保存的地址：${redactBaseUrl(nextUrl)}\n\n请确认这是你信任的服务地址。地址填错或被替换时，Key 可能被他人获取。点「取消」则不保存，配置保持原样。`
      : `${previousUrl ? `上次保存的地址：${redactBaseUrl(previousUrl)}\n` : ''}本次测试的地址：${redactBaseUrl(nextUrl)}\n\n请确认这是你信任的服务地址。地址填错或被替换时，Key 可能被他人获取。点「取消」则不发送任何请求。`
  }
  const result = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
  return result.response === 1
}

const handle = <T extends unknown[], R>(channel: string, fn: (...args: T) => R | Promise<R>): void => {
  ipcMain.handle(channel, async (event, ...args: T) => {
    trustedSender(event)
    try { return await fn(...args) } catch (error) { throw toUserFacingIpcError(error) }
  })
}

import {
  idSchema, shortTextSchema, contentSchema, nonNegativeIntSchema, projectCreateSchema, documentCreateSchema, documentSaveSchema, noteSaveSchema, characterSaveSchema, providerInputSchema, modelSchema, routeSchema, patchProposalSchema, snapshotReasonSchema, aiStartSchema, aiPreviewContextSchema, noteSectionSchema, outlineSaveSchema, batchCreateChaptersSchema, writingGoalsInputSchema, chapterStatusSchema, foreshadowRegisterSchema, foreshadowSetStateSchema, foreshadowUpdateMetaSchema, timelineSortModeSchema, timelineEventSaveSchema, chapterWordRangeSchema, promptTemplateModeSchema, promptTemplateTextSchema, promptTemplateScopeSchema, promptCopySourceSchema, hoverPrefsSchema, lintRunSchema, wordlistTextSchema, wordlistScopeSchema, lintRulesSchema, lintIgnoreSchema, importTokenSchema, patchRebaseSchema, patchPrepareBatchSchema, patchCompleteBatchSchema, bookReplaceSchema
} from './schemas'
import { toUserFacingIpcError } from './validation-error'
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => schema.parse(value)

export type NetworkHooks = {
  refreshNetworkAllowlist(): void
  allowOriginTemporarily(origin: string): () => void
  getBlockedLog(): readonly { url: string; reason: string; at: number }[]
}

export type IpcOptions = {
  /** 注册诊断通道（diagnostics:*）。只在未打包构建（开发 / vitest / e2e）为 true；生产（app.isPackaged）为 false。默认 false。 */
  diagnostics?: boolean
}

export function registerIpc(db: AppDatabase, codec: SecretCodec, network?: NetworkHooks, options: IpcOptions = {}): void {
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
  const promptTemplates = new PromptTemplateService(db)
  const foreshadows = new ForeshadowService(db)
  const timeline = new TimelineService(db)
  const focus = new FocusLockService(db)
  installFocusEgressLock(focusEgressCheck(focus))
  handle('focus:status', (projectId: string) => focus.status(parse(idSchema, projectId)))
  handle('focus:restore', (projectId: string) => focus.restore(parse(idSchema, projectId)))
  handle('focus:start', (projectId: string, input: unknown) => focus.start(parse(idSchema, projectId), input))
  handle('focus:finish', (projectId: string) => focus.finish(parse(idSchema, projectId)))
  handle('focus:emergency-exit', (projectId: string, phrase: unknown) => focus.emergencyExit(parse(idSchema, projectId), phrase))
  handle('focus:locked-projects', () => focus.lockedProjects())
  handle('focus:last-session', (projectId: string) => focus.lastSession(parse(idSchema, projectId)) ?? null)

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
  // P3 PR-2b：全书替换 / 整批恢复。纯本地写库，和 documents:save 一样不加 assertNotFocusLocked（小黑屋内允许），无出站
  handle('documents:replaceBatch', (input: unknown) => documents.replaceBatch(parse(bookReplaceSchema, input)))
  handle('snapshots:restoreBatch', (projectId: unknown, batchId: unknown) => documents.restoreBatch(parse(idSchema, projectId), parse(idSchema, batchId)))
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
  // F14：悬停偏好（settings_json，无迁移）；纯本地，小黑屋内也允许（不改正文、不联网）
  handle('characters:hover-prefs', (projectId: string) => readHoverPrefs(db, parse(idSchema, projectId)))
  handle('characters:set-hover-prefs', (projectId: string, prefs: unknown) => writeHoverPrefs(db, parse(idSchema, projectId), parse(hoverPrefsSchema, prefs)))
  handle('characters:delete', (projectId: string, characterId: string) => projectContent.deleteCharacter(parse(idSchema, projectId), parse(idSchema, characterId)))
  handle('memories:list', (projectId: string) => memories.list(projectId))
  handle('memories:confirm', (projectId: string, memoryId: string) => memories.confirm(parse(idSchema, projectId), parse(idSchema, memoryId), 'user'))
  handle('memories:reject', (projectId: string, memoryId: string) => memories.reject(parse(idSchema, projectId), parse(idSchema, memoryId)))
  handle('memories:retire', (projectId: string, memoryId: string) => memories.retire(parse(idSchema, projectId), parse(idSchema, memoryId)))
  handle('memories:replace', (projectId: string, memoryId: string, content: string) => memories.proposeReplacement(parse(idSchema, projectId), parse(idSchema, memoryId), parse(contentSchema, content)))
  handle('memories:extract-intent', (projectId: string, sourceId: string, content: string) => { assertNotFocusLocked(focus, parse(idSchema, projectId)); return memoryIntent.extractAndCreate(parse(idSchema, projectId), parse(idSchema, sourceId), parse(contentSchema, content)) })
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

  handle('timeline:list', (projectId: string, mode?: string) => timeline.list(parse(idSchema, projectId), parse(timelineSortModeSchema.optional(), mode)))
  handle('timeline:list-for-chapter', (projectId: string, chapterId: string) => timeline.listForChapter(parse(idSchema, projectId), parse(idSchema, chapterId)))
  handle('timeline:list-for-character', (projectId: string, characterId: string) => timeline.listForCharacter(parse(idSchema, projectId), parse(idSchema, characterId)))
  handle('timeline:save', (input: unknown) => timeline.save(parse(timelineEventSaveSchema, input)))
  handle('timeline:delete', (projectId: string, eventId: string) => timeline.delete(parse(idSchema, projectId), parse(idSchema, eventId)))

  handle('chat:list-threads', (projectId: string) => chat.listThreads(projectId))
  handle('chat:list-messages', (projectId: string, threadId: string, before?: ChatCursor, limit?: number) => chat.listMessages(projectId, threadId, before, limit))
  handle('chat:new-thread', (projectId: string, title?: string) => chat.createThread(parse(idSchema, projectId), parse(shortTextSchema.optional(), title)))
  handle('patches:propose', (input: unknown) => patches.propose(parse(patchProposalSchema, input)))
  handle('patches:list', (projectId: string, documentId?: string) => patches.list(projectId, documentId))
  handle('patches:prepare', (projectId: string, patchId: string, revision: number, currentText: string) => patches.prepare(parse(idSchema, projectId), parse(idSchema, patchId), parse(nonNegativeIntSchema, revision), parse(contentSchema, currentText)))
  handle('patches:complete', (projectId: string, patchId: string, savedRevision: number) => patches.complete(parse(idSchema, projectId), parse(idSchema, patchId), parse(nonNegativeIntSchema, savedRevision)))
  handle('patches:prepare-batch', (input: unknown) => { const value = parse(patchPrepareBatchSchema, input); return patches.prepareBatch(value.projectId, value.documentId, value.documentRevision, value.items) })
  handle('patches:complete-batch', (input: unknown) => { const value = parse(patchCompleteBatchSchema, input); return patches.completeBatch(value.projectId, value.savedRevision, value.acceptedIds, value.staleIds) })
  handle('patches:rebase', (input: unknown) => patches.rebase(parse(patchRebaseSchema, input)))
  handle('patches:reject', (projectId: string, patchId: string) => patches.reject(parse(idSchema, projectId), parse(idSchema, patchId)))

  handle('writing:get-day', (projectId: string, date?: string) => writingDaily.getDay(parse(idSchema, projectId), date === undefined ? undefined : parse(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), date)))
  handle('writing:list-range', (projectId: string, fromDate: string, toDate: string) => writingDaily.listRange(parse(idSchema, projectId), parse(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), fromDate), parse(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), toDate)))
  handle('writing:get-goals', (projectId: string) => writingDaily.getGoals(parse(idSchema, projectId)))
  handle('writing:set-goals', (projectId: string, input: unknown) => writingDaily.setGoals(parse(idSchema, projectId), parse(writingGoalsInputSchema, input)))
  handle('writing:get-word-range', (projectId: string) => writingDaily.getChapterWordRange(parse(idSchema, projectId)))
  handle('writing:set-word-range', (projectId: string, range: unknown) => writingDaily.setChapterWordRange(parse(idSchema, projectId), parse(chapterWordRangeSchema, range)))
  handle('prompts:list', (projectId: string) => promptTemplates.list(parse(idSchema, projectId)))
  handle('prompts:set', (projectId: string, mode: unknown, text: unknown) => promptTemplates.set(parse(idSchema, projectId), parse(promptTemplateModeSchema, mode), parse(promptTemplateTextSchema, text)))
  handle('prompts:reset', (projectId: string, mode: unknown) => promptTemplates.reset(parse(idSchema, projectId), parse(promptTemplateModeSchema, mode)))
  handle('prompts:set-scope', (projectId: string, scope: unknown, choice?: unknown) => promptTemplates.setScope(parse(idSchema, projectId), parse(promptTemplateScopeSchema, scope), choice === undefined ? undefined : parse(z.enum(['restore', 'fromCurrent']), choice)))
  handle('prompts:global-export', async () => {
    const result = await dialog.showSaveDialog({ defaultPath: '全局提示词模板.aiwprompts', filters: [{ name: '墨记全局提示词模板', extensions: ['aiwprompts'] }] })
    if (result.canceled || !result.filePath) return null
    await atomicWriteFile(result.filePath, promptTemplates.exportGlobalFile())
    return result.filePath
  })
  // M2：预览时把文件内容留在主进程（按 token），确认时只传 token；渲染进程不能指定任意路径或内容。
  const pendingGlobalImports = new Map<string, string>()
  handle('prompts:global-import-preview', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '墨记全局提示词模板', extensions: ['aiwprompts', 'json'] }] })
    if (result.canceled || !result.filePaths[0]) return null
    const text = await readGlobalTemplateFile(result.filePaths[0])
    const preview = promptTemplates.previewGlobalImport(text)
    pendingGlobalImports.clear(); pendingGlobalImports.set(preview.token, text)
    return preview
  })
  handle('prompts:global-import-apply', (token: unknown) => {
    const key = parse(z.string().regex(/^[0-9a-f]{64}$/), token)
    const text = pendingGlobalImports.get(key)
    if (text === undefined) throw Object.assign(new Error('模板在预览后已变化，请重新预览后再确认。'), { code: 'PROMPT_COPY_STALE' })
    const entries = promptTemplates.applyGlobalImport(text, key)
    pendingGlobalImports.clear()
    return entries
  })
  handle('prompts:global-import-cancel', () => { pendingGlobalImports.clear(); return null })
  handle('prompts:global-list', () => promptTemplates.listGlobal())
  handle('prompts:global-set', (mode: unknown, text: unknown) => promptTemplates.setGlobal(parse(promptTemplateModeSchema, mode), parse(promptTemplateTextSchema, text)))
  handle('prompts:global-reset', (mode: unknown) => promptTemplates.resetGlobal(parse(promptTemplateModeSchema, mode)))
  handle('prompts:copy-preview', (projectId: string, source: unknown) => promptTemplates.previewCopy(parse(idSchema, projectId), parse(promptCopySourceSchema, source)))
  handle('prompts:copy-apply', (projectId: string, source: unknown, token: unknown) => promptTemplates.applyCopy(parse(idSchema, projectId), parse(promptCopySourceSchema, source), parse(z.string().regex(/^[0-9a-f]{64}$/), token)))
  // F13：本地规则 + 词表（不联网、不调 AI；小黑屋中不运行）
  const lint = new LintService(db, (projectId) => focus.isLocked(projectId))
  handle('linter:run', (...args: unknown[]) => { const [projectId, documentId, text, revision] = lintRunSchema.parse(args); return lint.run(projectId, documentId, text, revision) })
  handle('lint:rules', (projectId: unknown) => lint.getRules(parse(idSchema, projectId)))
  handle('lint:set-rules', (projectId: unknown, rules: unknown) => lint.setRules(parse(idSchema, projectId), parse(lintRulesSchema, rules)))
  handle('lint:ignore', (projectId: unknown, input: unknown) => lint.addIgnore(parse(idSchema, projectId), parse(lintIgnoreSchema, input)))
  handle('lint:disable-term', (projectId: unknown, term: unknown) => lint.disableTerm(parse(idSchema, projectId), parse(z.string().trim().min(1).max(50), term)))
  handle('wordlist:get', (projectId: unknown) => lint.getWordlists(parse(idSchema, projectId)))
  handle('wordlist:get-global', () => lint.getGlobalWordlist())
  handle('wordlist:save-project', (projectId: unknown, text: unknown) => lint.saveProject(parse(idSchema, projectId), parse(wordlistTextSchema, text)))
  handle('wordlist:save-global', (text: unknown) => lint.saveGlobal(parse(wordlistTextSchema, text)))
  const scopeArgs = (scope: unknown, projectId: unknown): { scope: WordlistScope; projectId?: string } => {
    const valid = parse(wordlistScopeSchema, scope)
    return valid === 'project' ? { scope: valid, projectId: parse(idSchema, projectId) } : { scope: valid }
  }
  handle('wordlist:export', async (scope: unknown, projectId?: unknown) => {
    const target = scopeArgs(scope, projectId)
    const name = target.scope === 'global' ? '全局词表' : `${projects.get(target.projectId!).title}-词表`
    const result = await dialog.showSaveDialog({ defaultPath: `${name}.txt`, filters: [{ name: '纯文本词表', extensions: ['txt'] }] })
    if (result.canceled || !result.filePath) return null
    await atomicWriteFile(result.filePath, lint.exportText(target.scope, target.projectId))
    return result.filePath
  })
  // 与全局提示词模板相同：预览时文件内容留在主进程（按 token），确认时只传 token
  const pendingWordlistImports = new Map<string, { scope: WordlistScope; projectId?: string; text: string }>()
  handle('wordlist:import-preview', async (scope: unknown, projectId?: unknown) => {
    const target = scopeArgs(scope, projectId)
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '纯文本词表', extensions: ['txt'] }] })
    if (result.canceled || !result.filePaths[0]) return null
    const text = await readWordlistFile(result.filePaths[0])
    const preview = lint.previewImport(target.scope, target.projectId, text)
    pendingWordlistImports.clear(); pendingWordlistImports.set(preview.token, { ...target, text })
    return preview
  })
  handle('wordlist:import-apply', (token: unknown) => {
    const key = parse(importTokenSchema, token)
    const pending = pendingWordlistImports.get(key)
    if (!pending) throw Object.assign(new Error('词表在预览后已变化，请重新预览后再确认。'), { code: 'WORDLIST_IMPORT_STALE' })
    const text = lint.applyImport(pending.scope, pending.projectId, pending.text, key)
    pendingWordlistImports.clear()
    return text
  })
  handle('wordlist:import-cancel', () => { pendingWordlistImports.clear(); return null })
  ipcMain.handle('lint:check-book', async (event, projectId: unknown, volumeId: unknown, runId: unknown) => {
    trustedSender(event)
    try {
      const id = parse(idSchema, projectId)
      assertNotFocusLocked(focus, id)
      const run = parse(idSchema, runId)
      return await lint.checkBook(id, { volumeId: parse(idSchema.optional(), volumeId ?? undefined), runId: run,
        onProgress: (done, total) => { if (!event.sender.isDestroyed()) event.sender.send('lint:book-progress', { runId: run, done, total }) } })
    } catch (error) { throw toUserFacingIpcError(error) }
  })
  handle('lint:check-book-cancel', (runId: unknown) => { lint.cancelBookCheck(parse(idSchema, runId)); return null })
  handle('digests:run', (projectId: string, chapterId: string) => { assertNotFocusLocked(focus, parse(idSchema, projectId)); return digestRunner.run(parse(idSchema, projectId), parse(idSchema, chapterId)) })
  handle('digests:list', (projectId: string, chapterId?: string) => digests.list(projectId, chapterId))
  handle('digests:status', (projectId: string, chapterId: string) => digests.status(projectId, chapterId))
  handle('proofreading:run', (projectId: string, documentId: string) => { assertNotFocusLocked(focus, parse(idSchema, projectId)); return proofreading.run(parse(idSchema, projectId), parse(idSchema, documentId)) })

  handle('providers:list', () => providers.list())
  // A·M1（保存）：Key 栏留空、要沿用已保存 Key，且归一化后的地址与已保存的不同（同一 scheme/host/port 下改了路径或查询串）时，
  // 先由 main 弹同一套原生确认框；取消则抛 PROVIDER_SAVE_CANCELLED，已保存配置一字不动。
  // 新填了 Key 按「第一次保存」规则：保存时不弹（测试连接时再按 providers:test-url 的规则确认）。换主机仍由 save() 拒绝沿用旧 Key。
  ipcMain.handle('providers:save', async (event, input: unknown) => {
    trustedSender(event)
    try {
      const body = parse(providerInputSchema, input as ProviderInput)
      const saved = body.id ? providers.savedEndpoint(body.id) : undefined
      if (!body.apiKey && saved?.hasApiKey && saved.baseUrl) {
        const restored = restoreRedactedSecrets(body.baseUrl, saved.baseUrl)
        const checked = restored === undefined ? undefined : checkBaseUrl(restored)
        // 还原失败、地址无效、换了主机：交给 save() 按原规则报错，不弹框
        if (checked?.ok && sameEndpoint(checked.url, saved.baseUrl) && baseUrlKeyDecision(checked.url, saved.baseUrl).needsConfirm) {
          const confirmed = await confirmKeyToNewBaseUrl(event, checked.url, saved.baseUrl, 'save')
          if (!confirmed) throw Object.assign(new Error('已取消保存，服务配置未改动，API Key 不会发往新地址。'), { code: 'PROVIDER_SAVE_CANCELLED' })
        }
      }
      const result = providers.save(body)
      network?.refreshNetworkAllowlist()
      return result
    } catch (error) { throw toUserFacingIpcError(error) }
  })
  handle('providers:models', () => providers.listModels())
  handle('providers:save-model', (model: ModelConfig) => providers.saveModel(parse(modelSchema, model)))
  handle('providers:routes', () => providers.listRoutes())
  handle('providers:set-route', (route: TaskModelRoute) => { const valid = parse(routeSchema, route); return providers.setRoute(valid.taskType, valid.modelId) })
  handle('providers:test', async (providerId: string, modelId: string) => {
    assertNoFocusLockAnywhere(focus)
    try {
      providerId = parse(idSchema, providerId); modelId = parse(idSchema, modelId)
      const { config, apiKey } = providers.getWithSecret(providerId)
      const origin = originFromBaseUrl(config.baseUrl)
      const revoke = origin && network ? network.allowOriginTemporarily(origin) : () => {}
      try { return await createProviderAdapter(config.providerType, config.baseUrl, apiKey).testConnection(modelId) }
      finally { revoke() }
    } catch (error) { return { ok: false, message: error instanceof Error ? error.message : '服务配置不可用' } }
  })
  // S2 / 决策 11：未保存地址仅在测试连接时临时放行（不写入白名单）
  // A·M1：要带 API Key 发往「与上次保存不同」的地址（或尚无已保存地址）时，先由 main 进程弹原生确认框；
  // 作者未点「确认发送」则不发任何请求（renderer 无法代为确认，也没有可重放的令牌）。
  ipcMain.handle('providers:test-url', async (event, input: unknown) => {
    trustedSender(event)
    try {
      assertNoFocusLockAnywhere(focus)
      const body = z.object({
        baseUrl: z.string().min(1).max(2000),
        apiKey: z.string().max(4000).optional(),
        modelId: z.string().min(1).max(200),
        providerType: z.enum(['openai-compatible', 'anthropic']).optional(),
        providerId: idSchema.optional()
      }).parse(input)
      const saved = body.providerId ? providers.getRawBaseUrlAndSecret(body.providerId) : undefined
      const restored = restoreRedactedSecrets(body.baseUrl, saved?.baseUrl)
      if (restored === undefined) return { ok: false, message: '地址中的密钥参数显示为 ***，与已保存地址不一致时无法还原，请重新填写完整地址。' }
      const checked = checkBaseUrl(restored)
      if (!checked.ok) return { ok: false, message: checked.message }
      const origin = originFromBaseUrl(checked.url)
      if (!origin) return { ok: false, message: '无法解析服务地址' }
      // 作者在 Key 栏填了就用填的；留空且指明了已保存服务时，只在同一 scheme/host/port 上沿用已保存的 Key（同 S1d-A2，
      // Key 只在 main 内解密，不回传 renderer）；换了主机则不带已保存 Key。
      const apiKey = body.apiKey ? body.apiKey : (saved?.baseUrl && sameEndpoint(checked.url, saved.baseUrl) ? saved.apiKey : '')
      if (apiKey) {
        const decision = baseUrlKeyDecision(checked.url, saved?.baseUrl)
        if (decision.needsConfirm) {
          const confirmed = await confirmKeyToNewBaseUrl(event, checked.url, saved?.baseUrl)
          if (!confirmed) return { ok: false, cancelled: true, message: '已取消测试连接，API Key 未发送。' }
        }
      }
      const revoke = network ? network.allowOriginTemporarily(origin) : () => {}
      try {
        return await createProviderAdapter(body.providerType, checked.url, apiKey).testConnection(body.modelId)
      } finally { revoke() }
    } catch (error) {
      if (error instanceof FocusLockError) throw toUserFacingIpcError(error)
      return { ok: false, message: error instanceof Error ? error.message : '服务配置不可用' }
    }
  })
  handle('network:blocked-log', () => network?.getBlockedLog() ?? [])
  // P3 PR-2b：后台 WAL 检查点状态（e2e 计时用；界面不展示）。仅 options.diagnostics 时注册，且不返回库路径（commits/releases 可保留）。
  if (options.diagnostics === true) {
    handle('diagnostics:wal-checkpoint', () => {
      const cp = db.checkpointer
      return { busy: cp?.busy ?? false, runs: cp?.runs ?? 0, last: cp?.last ?? null, walBytes: cp?.walBytes() ?? 0, autoCheckpoint: db.autoCheckpoint, commits: db.commits.slice(-20), releases: db.releases.slice(-10) }
    })
  }

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
  handle('backup:export-manuscript', async (projectId: string, format: 'txt' | 'md' | 'docx', onlyFinal?: boolean, range?: ExportChapterRange) => {
    projectId = parse(idSchema, projectId)
    format = parse(z.enum(['txt', 'md', 'docx']), format)
    const finalOnly = parse(z.boolean().optional(), onlyFinal) === true
    const chapterRange = parse(z.object({ from: z.number().int(), to: z.number().int() }).optional(), range)
    const project = projects.get(projectId)
    const suffix = `${chapterRange ? `-第${chapterRange.from}-${chapterRange.to}章` : ''}${finalOnly ? '-仅定稿' : ''}`
    return runManuscriptExport({
      countChapters: (options) => backup.selectManuscriptChapters(projectId, options).length,
      showSaveDialog: () => dialog.showSaveDialog({ defaultPath: `${project.title}${suffix}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] }),
      write: (filePath, options) => backup.exportManuscript(projectId, filePath, format, options)
    }, { onlyFinal: finalOnly, range: chapterRange })
  })

  ipcMain.on('ai:start', async (event, request: AIStartRequest) => {
    try {
      trustedSender(event)
      request = aiStartSchema.parse(request) as AIStartRequest
      assertNotFocusLocked(focus, request.task.projectId)
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
      const shaped = toUserFacingIpcError(error) as Error & { code?: string }
      if (!event.sender.isDestroyed()) event.sender.send('ai:event', { type: 'error', requestId: request?.requestId ?? 'invalid', message: shaped.message, code: shaped.code })
    }
  })
  handle('ai:preview-context', (request: AIPreviewContextRequest) => {
    const parsed = aiPreviewContextSchema.parse(request) as AIPreviewContextRequest
    assertNotFocusLocked(focus, parsed.task.projectId)
    return runtime.previewContext(parsed.task, parsed.threadId)
  })
  handle('ai:cancel', (requestId: string) => runtime.cancel(parse(idSchema, requestId)))
}
