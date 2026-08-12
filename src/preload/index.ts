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
    delete: (projectId, documentId) => invoke('documents:delete', projectId, documentId), save: (input) => invoke('documents:save', input),
    search: (projectId, query) => invoke('documents:search', projectId, query)
  },
  snapshots: {
    create: (projectId, documentId, reason) => invoke('snapshots:create', projectId, documentId, reason),
    list: (projectId, documentId) => invoke('snapshots:list', projectId, documentId),
    restore: (projectId, snapshotId) => invoke('snapshots:restore', projectId, snapshotId)
  },
  ideas: { list: (projectId) => invoke('ideas:list', projectId), create: (projectId, content, tags) => invoke('ideas:create', projectId, content, tags) },
  notes: { list: (projectId, section) => invoke('notes:list', projectId, section), save: (input) => invoke('notes:save', input), delete: (projectId, id) => invoke('notes:delete', projectId, id) },
  characters: { list: (projectId) => invoke('characters:list', projectId), save: (input) => invoke('characters:save', input), delete: (projectId, id) => invoke('characters:delete', projectId, id) },
  memories: { list: (projectId) => invoke('memories:list', projectId), confirm: (projectId, id) => invoke('memories:confirm', projectId, id), reject: (projectId, id) => invoke('memories:reject', projectId, id), proposeFromChat: (projectId, sourceId, content) => invoke('memories:propose-from-chat', projectId, sourceId, content) },
  patches: {
    propose: (input) => invoke('patches:propose', input), list: (projectId, documentId) => invoke('patches:list', projectId, documentId),
    prepare: (projectId, id, revision, currentText) => invoke('patches:prepare', projectId, id, revision, currentText),
    complete: (projectId, id, revision) => invoke('patches:complete', projectId, id, revision), reject: (projectId, id) => invoke('patches:reject', projectId, id)
  },
  linter: { run: (text) => invoke('linter:run', text) },
  digests: { store: (projectId, chapterId, raw) => invoke('digests:store', projectId, chapterId, raw), run: (projectId, chapterId) => invoke('digests:run', projectId, chapterId), list: (projectId, chapterId) => invoke('digests:list', projectId, chapterId) },
  providers: {
    list: () => invoke('providers:list'), save: (input) => invoke('providers:save', input), models: () => invoke('providers:models'),
    saveModel: (model) => invoke('providers:save-model', model), setRoute: (route) => invoke('providers:set-route', route),
    test: (providerId, modelId) => invoke('providers:test', providerId, modelId)
  },
  backup: {
    exportProject: (projectId) => invoke('backup:export-project', projectId), importProject: () => invoke('backup:import-project'),
    importManuscript: () => invoke('backup:import-manuscript'),
    exportManuscript: (projectId, format) => invoke('backup:export-manuscript', projectId, format)
  },
  ai: {
    start: (request, onEvent) => {
      const cleanup = aiEvents.register(request.requestId, onEvent)
      ipcRenderer.send('ai:start', request)
      return cleanup
    },
    cancel: (requestId) => invoke('ai:cancel', requestId)
  }
}

contextBridge.exposeInMainWorld('workspace', api)
