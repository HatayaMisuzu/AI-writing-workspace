import type {
  AITaskEnvelope, Character, ChatMessage, ChatThread, DigestStatus, DocumentContent, DocumentNode, Idea, LocalLintIssue,
  MemoryItem, MemoryProposal, ModelConfig, Project, ProjectNote, ProjectType, ProofreadIssue, ProviderConfig,
  ProviderInput, RoutedTask, SearchResult, Snapshot, TaskModelRoute, TextOrigin, TextPatch
} from './domain'

export interface WorkspaceApi {
  window: {
    minimize(): Promise<void>; toggleMaximize(): Promise<void>; close(): Promise<void>
    confirmClose(): Promise<void>; cancelClose(): Promise<void>; onBeforeClose(handler: () => void): () => void
  }
  projects: {
    list(includeArchived?: boolean): Promise<Project[]>
    create(input: { title: string; projectType: ProjectType; description?: string }): Promise<Project>
    touch(projectId: string): Promise<void>
    rename(projectId: string, title: string): Promise<Project>
    archive(projectId: string, archived: boolean): Promise<void>
    delete(projectId: string): Promise<void>
  }
  documents: {
    tree(projectId: string): Promise<DocumentNode[]>
    get(projectId: string, documentId: string): Promise<DocumentContent>
    create(input: { projectId: string; parentId?: string | null; type: DocumentNode['type']; title: string }): Promise<DocumentNode>
    rename(projectId: string, documentId: string, title: string): Promise<void>
    reorder(projectId: string, documentId: string, parentId: string | null, orderIndex: number): Promise<void>
    delete(projectId: string, documentId: string): Promise<void>
    save(input: { projectId: string; documentId: string; editorJson: Record<string, unknown>; plainText: string; expectedRevision?: number; styleSample?: { origin: TextOrigin; text: string } }): Promise<DocumentContent>
    search(projectId: string, query: string): Promise<SearchResult[]>
  }
  snapshots: {
    create(projectId: string, documentId: string, reason: Snapshot['reason']): Promise<Snapshot>
    list(projectId: string, documentId: string): Promise<Snapshot[]>
    restore(projectId: string, snapshotId: string): Promise<DocumentContent>
  }
  ideas: { list(projectId: string): Promise<Idea[]>; create(projectId: string, content: string, tags?: string[]): Promise<Idea> }
  notes: {
    list(projectId: string, section: ProjectNote['section']): Promise<ProjectNote[]>
    save(input: { id?: string; projectId: string; section: ProjectNote['section']; title: string; content: string }): Promise<ProjectNote>
    delete(projectId: string, noteId: string): Promise<void>
  }
  characters: {
    list(projectId: string): Promise<Character[]>
    save(input: { id?: string; projectId: string; name: string; aliases?: string[]; notes?: string; fields?: Record<string, string> }): Promise<Character>
    delete(projectId: string, characterId: string): Promise<void>
  }
  memories: {
    list(projectId: string): Promise<MemoryItem[]>
    confirm(projectId: string, memoryId: string): Promise<MemoryItem>
    reject(projectId: string, memoryId: string): Promise<MemoryItem>
    retire(projectId: string, memoryId: string): Promise<MemoryItem>
    replace(projectId: string, memoryId: string, content: string): Promise<MemoryItem>
    proposeFromChat(projectId: string, sourceId: string, content: string): Promise<MemoryProposal | null>
    extractIntent(projectId: string, sourceId: string, content: string): Promise<MemoryProposal[]>
  }
  chat: {
    listThreads(projectId: string): Promise<ChatThread[]>
    listMessages(projectId: string, threadId: string, before?: number, limit?: number): Promise<ChatMessage[]>
    newThread(projectId: string, title?: string): Promise<ChatThread>
  }
  patches: {
    propose(input: { projectId: string; documentId: string; documentRevision: number; fromPm: number; toPm: number; originalText: string; replacement: string }): Promise<TextPatch>
    list(projectId: string, documentId?: string): Promise<TextPatch[]>
    prepare(projectId: string, patchId: string, documentRevision: number, currentText: string): Promise<TextPatch>
    complete(projectId: string, patchId: string, savedRevision: number): Promise<TextPatch>
    reject(projectId: string, patchId: string): Promise<TextPatch>
  }
  linter: { run(text: string): Promise<LocalLintIssue[]> }
  digests: {
    store(projectId: string, chapterId: string, raw: string): Promise<{ id: string; payload: unknown }>
    run(projectId: string, chapterId: string): Promise<{ id: string; payload: unknown; repaired: boolean }>
    list(projectId: string, chapterId?: string): Promise<Array<{ id: string; chapterId: string; revision: number; summary: string; stale: boolean; createdAt: number }>>
    status(projectId: string, chapterId: string): Promise<DigestStatus>
  }
  proofreading: { run(projectId: string, documentId: string): Promise<ProofreadIssue[]> }
  providers: {
    list(): Promise<ProviderConfig[]>
    save(input: ProviderInput): Promise<ProviderConfig>
    models(): Promise<ModelConfig[]>
    saveModel(model: ModelConfig): Promise<ModelConfig>
    routes(): Promise<Record<RoutedTask, string | 'default'>>
    setRoute(route: TaskModelRoute): Promise<void>
    test(providerId: string, modelId: string): Promise<{ ok: boolean; message?: string }>
  }
  backup: {
    exportProject(projectId: string): Promise<string | null>
    importProject(): Promise<Project | null>
    importManuscript(): Promise<Project | null>
    exportManuscript(projectId: string, format: 'txt' | 'md' | 'docx'): Promise<string | null>
  }
  ai: {
    start(request: AIStartRequest, onEvent: (event: AIStreamEvent) => void): () => void
    cancel(requestId: string): Promise<void>
  }
}

export interface AIStartRequest {
  requestId: string
  task: AITaskEnvelope
  threadId: string
  userMessageId: string
  assistantMessageId: string
}

export type AIStreamEvent =
  | { type: 'chunk'; requestId: string; chunk: string; context?: unknown }
  | { type: 'done'; requestId: string }
  | { type: 'error'; requestId: string; message: string; code?: string }
