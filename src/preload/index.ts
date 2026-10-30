import { contextBridge, ipcRenderer } from 'electron'
import type { AIStreamEvent, WorkspaceApi } from '../shared/ipc'
import { AIEventRouter } from './ai-event-router'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>
const aiEvents = new AIEventRouter()
ipcRenderer.on('ai:event', (_event, payload: AIStreamEvent) => aiEvents.dispatch(payload))

const api: WorkspaceApi = {
  window: {
    minimize: () => invoke('window:minimize'), toggleMaximize: () => invoke('window:toggle-maximize'), close: () => invoke('window:close'),
    confirmClose: () => invoke('window:confirm-close'), cancelClose: () => invoke('window:cancel-close'),
    onBeforeClose: (handler) => { const listener = (): void => handler(); ipcRenderer.on('window:before-close', listener); return () => ipcRenderer.removeListener('window:before-close', listener) }
  },
  projects: {
    list: (includeArchived) => invoke('projects:list', includeArchived), create: (input) => invoke('projects:create', input),
    touch: (id) => invoke('projects:touch', id), rename: (id, title) => invoke('projects:rename', id, title),
    archive: (id, archived) => invoke('projects:archive', id, archived), delete: (id) => invoke('projects:delete', id)
  },
  documents: {
    tree: (projectId) => invoke('documents:tree', projectId), get: (projectId, documentId) => invoke('documents:get', projectId, documentId),
    create: (input) => invoke('documents:create', input), rename: (projectId, documentId, title) => invoke('documents:rename', projectId, documentId, title),
    reorder: (projectId, documentId, parentId, orderIndex) => invoke('documents:reorder', projectId, documentId, parentId, orderIndex),
    delete: (projectId, documentId) => invoke('documents:delete', projectId, documentId), save: (input) => invoke('documents:save', input), replaceBatch: (input) => invoke('documents:replaceBatch', input),
    search: (projectId, query) => invoke('documents:search', projectId, query),
    batchCreateChapters: (input) => invoke('documents:batch-create-chapters', input),
    setStatus: (projectId, documentId, status) => invoke('documents:set-status', projectId, documentId, status),
    getStockpile: (projectId) => invoke('documents:get-stockpile', projectId),
    getSerialProgress: (projectId) => invoke('documents:get-serial-progress', projectId),
    setSerialProgress: (projectId, progressChapterId) => invoke('documents:set-serial-progress', projectId, progressChapterId)
  },
  snapshots: {
    create: (projectId, documentId, reason) => invoke('snapshots:create', projectId, documentId, reason),
    list: (projectId, documentId) => invoke('snapshots:list', projectId, documentId),
    restore: (projectId, snapshotId) => invoke('snapshots:restore', projectId, snapshotId),
    restoreBatch: (projectId, batchId) => invoke('snapshots:restoreBatch', projectId, batchId)
  },
  ideas: { list: (projectId) => invoke('ideas:list', projectId), create: (projectId, content, tags) => invoke('ideas:create', projectId, content, tags) },
  outlines: { get: (projectId, nodeId) => invoke('outlines:get', projectId, nodeId), list: (projectId) => invoke('outlines:list', projectId), save: (input) => invoke('outlines:save', input) },
  notes: { list: (projectId, section) => invoke('notes:list', projectId, section), save: (input) => invoke('notes:save', input), delete: (projectId, id) => invoke('notes:delete', projectId, id) },
  characters: { list: (projectId) => invoke('characters:list', projectId), save: (input) => invoke('characters:save', input), delete: (projectId, id) => invoke('characters:delete', projectId, id), hoverPrefs: (projectId) => invoke('characters:hover-prefs', projectId), setHoverPrefs: (projectId, prefs) => invoke('characters:set-hover-prefs', projectId, prefs) },
  foreshadows: {
    listLedger: (projectId) => invoke('foreshadows:list-ledger', projectId),
    listPending: (projectId) => invoke('foreshadows:list-pending', projectId),
    register: (input) => invoke('foreshadows:register', input),
    setState: (input) => invoke('foreshadows:set-state', input),
    updateMeta: (input) => invoke('foreshadows:update-meta', input)
  },
  timeline: {
    list: (projectId, mode) => invoke('timeline:list', projectId, mode),
    listForChapter: (projectId, chapterId) => invoke('timeline:list-for-chapter', projectId, chapterId),
    listForCharacter: (projectId, characterId) => invoke('timeline:list-for-character', projectId, characterId),
    save: (input) => invoke('timeline:save', input),
    delete: (projectId, eventId) => invoke('timeline:delete', projectId, eventId)
  },
  memories: { list: (projectId) => invoke('memories:list', projectId), confirm: (projectId, id) => invoke('memories:confirm', projectId, id), reject: (projectId, id) => invoke('memories:reject', projectId, id), retire: (projectId, id) => invoke('memories:retire', projectId, id), replace: (projectId, id, content) => invoke('memories:replace', projectId, id, content), extractIntent: (projectId, sourceId, content) => invoke('memories:extract-intent', projectId, sourceId, content) },
  chat: { listThreads: (projectId) => invoke('chat:list-threads', projectId), listMessages: (projectId, threadId, before, limit) => invoke('chat:list-messages', projectId, threadId, before, limit), newThread: (projectId, title) => invoke('chat:new-thread', projectId, title) },
  patches: {
    propose: (input) => invoke('patches:propose', input), list: (projectId, documentId) => invoke('patches:list', projectId, documentId),
    prepare: (projectId, id, revision, currentText) => invoke('patches:prepare', projectId, id, revision, currentText),
    complete: (projectId, id, revision) => invoke('patches:complete', projectId, id, revision), reject: (projectId, id) => invoke('patches:reject', projectId, id),
    rebase: (input) => invoke('patches:rebase', input),
    prepareBatch: (input) => invoke('patches:prepare-batch', input), completeBatch: (input) => invoke('patches:complete-batch', input)
  },
  linter: { run: (projectId, documentId, text, sourceRevision) => invoke('linter:run', projectId, documentId, text, sourceRevision) },
  lint: {
    rules: (projectId) => invoke('lint:rules', projectId), setRules: (projectId, rules) => invoke('lint:set-rules', projectId, rules),
    ignore: (projectId, input) => invoke('lint:ignore', projectId, input), disableTerm: (projectId, term) => invoke('lint:disable-term', projectId, term),
    checkBook: async (projectId, volumeId, runId, onProgress) => {
      const listener = (_event: unknown, payload: { runId: string; done: number; total: number }): void => { if (payload.runId === runId) onProgress?.(payload.done, payload.total) }
      ipcRenderer.on('lint:book-progress', listener)
      try { return await invoke('lint:check-book', projectId, volumeId ?? null, runId) } finally { ipcRenderer.removeListener('lint:book-progress', listener) }
    },
    cancelBookCheck: (runId) => invoke('lint:check-book-cancel', runId)
  },
  wordlist: {
    get: (projectId) => invoke('wordlist:get', projectId), getGlobal: () => invoke('wordlist:get-global'),
    saveProject: (projectId, text) => invoke('wordlist:save-project', projectId, text), saveGlobal: (text) => invoke('wordlist:save-global', text),
    exportFile: (scope, projectId) => invoke('wordlist:export', scope, projectId), previewImport: (scope, projectId) => invoke('wordlist:import-preview', scope, projectId),
    applyImport: (token) => invoke('wordlist:import-apply', token), cancelImport: () => invoke('wordlist:import-cancel')
  },
  digests: { run: (projectId, chapterId) => invoke('digests:run', projectId, chapterId), list: (projectId, chapterId) => invoke('digests:list', projectId, chapterId), status: (projectId, chapterId) => invoke('digests:status', projectId, chapterId) },
  proofreading: { run: (projectId, documentId) => invoke('proofreading:run', projectId, documentId) },
  providers: {
    list: () => invoke('providers:list'), save: (input) => invoke('providers:save', input), models: () => invoke('providers:models'),
    saveModel: (model) => invoke('providers:save-model', model), routes: () => invoke('providers:routes'), setRoute: (route) => invoke('providers:set-route', route),
    test: (providerId, modelId) => invoke('providers:test', providerId, modelId),
    testUrl: (input) => invoke('providers:test-url', input)
  },
  network: { blockedLog: () => invoke('network:blocked-log') },
  diagnostics: { walCheckpoint: () => invoke('diagnostics:wal-checkpoint'), saveTrace: () => invoke('diagnostics:save-trace') },
  writing: {
    getDay: (projectId, date) => invoke('writing:get-day', projectId, date),
    listRange: (projectId, fromDate, toDate) => invoke('writing:list-range', projectId, fromDate, toDate),
    getGoals: (projectId) => invoke('writing:get-goals', projectId),
    setGoals: (projectId, input) => invoke('writing:set-goals', projectId, input),
    getChapterWordRange: (projectId) => invoke('writing:get-word-range', projectId),
    setChapterWordRange: (projectId, range) => invoke('writing:set-word-range', projectId, range)
  },
  focus: {
    status: (projectId) => invoke('focus:status', projectId), restore: (projectId) => invoke('focus:restore', projectId),
    start: (projectId, input) => invoke('focus:start', projectId, input), finish: (projectId) => invoke('focus:finish', projectId),
    emergencyExit: (projectId, phrase) => invoke('focus:emergency-exit', projectId, phrase), lastSession: (projectId) => invoke('focus:last-session', projectId),
    lockedProjects: () => invoke('focus:locked-projects')
  },
  prompts: {
    list: (projectId) => invoke('prompts:list', projectId),
    set: (projectId, mode, text) => invoke('prompts:set', projectId, mode, text),
    reset: (projectId, mode) => invoke('prompts:reset', projectId, mode),
    setScope: (projectId, scope, choice) => invoke('prompts:set-scope', projectId, scope, choice),
    exportGlobal: () => invoke('prompts:global-export'),
    previewGlobalImport: () => invoke('prompts:global-import-preview'),
    applyGlobalImport: (token) => invoke('prompts:global-import-apply', token),
    cancelGlobalImport: () => invoke('prompts:global-import-cancel'),
    listGlobal: () => invoke('prompts:global-list'),
    setGlobal: (mode, text) => invoke('prompts:global-set', mode, text),
    resetGlobal: (mode) => invoke('prompts:global-reset', mode),
    previewCopy: (projectId, source) => invoke('prompts:copy-preview', projectId, source),
    applyCopy: (projectId, source, token) => invoke('prompts:copy-apply', projectId, source, token)
  },
  backup: {
    exportProject: (projectId) => invoke('backup:export-project', projectId), importProject: () => invoke('backup:import-project'),
    importManuscript: () => invoke('backup:import-manuscript'),
    exportManuscript: (projectId, format, onlyFinal, range) => invoke('backup:export-manuscript', projectId, format, onlyFinal, range)
  },
  ai: {
    start: (request, onEvent) => {
      const cleanup = aiEvents.register(request.requestId, onEvent)
      ipcRenderer.send('ai:start', request)
      return cleanup
    },
    cancel: (requestId) => invoke('ai:cancel', requestId),
    previewContext: (request) => invoke('ai:preview-context', request)
  }
}

contextBridge.exposeInMainWorld('workspace', api)
