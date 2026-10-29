import type { PromptTemplateEntry } from './prompt-templates'
import type { AIMode, ProviderType } from './domain'
import type { ExportChapterRange } from './export-range'
import type {
  ContextBundle,
  AITaskEnvelope, Character, ChatCursor, ChatMessage, ChatThread, DigestStatus, DocumentContent, DocumentNode, Idea, LocalLintIssue,
  MemoryItem, MemoryProposal, ModelConfig, NodeOutline, Project, ProjectNote, ProjectType, ProofreadIssue, ProviderConfig,
  ProviderInput, RoutedTask, SearchResult, Snapshot, TaskModelRoute, TextOrigin, TextPatch, WritingDailyRow, WritingGoals, ChapterWordRange, ChapterStatus, SerialProgress, StockpileSummary, ForeshadowEntry, ForeshadowState, TimelineEvent, TimelineSortMode
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
    /** S4：按细纲行批量建空章（构思） */
    batchCreateChapters(input: { projectId: string; volumeId: string; lines: string[] }): Promise<DocumentNode[]>
    setStatus(projectId: string, documentId: string, status: ChapterStatus): Promise<DocumentNode>
    getStockpile(projectId: string): Promise<StockpileSummary>
    getSerialProgress(projectId: string): Promise<SerialProgress>
    setSerialProgress(projectId: string, progressChapterId: string | null): Promise<SerialProgress>
  }
  snapshots: {
    create(projectId: string, documentId: string, reason: Snapshot['reason']): Promise<Snapshot>
    list(projectId: string, documentId: string): Promise<Snapshot[]>
    restore(projectId: string, snapshotId: string): Promise<DocumentContent>
  }
  ideas: { list(projectId: string): Promise<Idea[]>; create(projectId: string, content: string, tags?: string[]): Promise<Idea> }
  outlines: {
    get(projectId: string, nodeId: string): Promise<NodeOutline | null>
    list(projectId: string): Promise<NodeOutline[]>
    save(input: { projectId: string; nodeId: string; summary?: string; beats?: string[]; hook?: string }): Promise<NodeOutline>
  }
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
  foreshadows: {
    listLedger(projectId: string): Promise<ForeshadowEntry[]>
    listPending(projectId: string): Promise<ForeshadowEntry[]>
    register(input: {
      projectId: string; chapterId: string; name?: string; content: string
      fromPm: number; toPm: number; plannedChapterId?: string | null; characterIds?: string[]
    }): Promise<ForeshadowEntry>
    setState(input: {
      projectId: string; memoryId: string; state: ForeshadowState
      abandonReason?: string; resolvedChapterId?: string | null
      plannedChapterId?: string | null; characterIds?: string[]
    }): Promise<ForeshadowEntry>
    updateMeta(input: {
      projectId: string; memoryId: string
      plannedChapterId?: string | null; resolvedChapterId?: string | null; characterIds?: string[]
    }): Promise<ForeshadowEntry>
  }
  timeline: {
    list(projectId: string, mode?: TimelineSortMode): Promise<TimelineEvent[]>
    listForChapter(projectId: string, chapterId: string): Promise<TimelineEvent[]>
    listForCharacter(projectId: string, characterId: string): Promise<TimelineEvent[]>
    save(input: { id?: string; projectId: string; storyTimeLabel?: string; sortKey: number; title: string; chapterId?: string | null; characterIds?: string[] }): Promise<TimelineEvent>
    delete(projectId: string, eventId: string): Promise<void>
  }
  memories: {
    list(projectId: string): Promise<MemoryItem[]>
    confirm(projectId: string, memoryId: string): Promise<MemoryItem>
    reject(projectId: string, memoryId: string): Promise<MemoryItem>
    retire(projectId: string, memoryId: string): Promise<MemoryItem>
    replace(projectId: string, memoryId: string, content: string): Promise<MemoryItem>
    extractIntent(projectId: string, sourceId: string, content: string): Promise<MemoryProposal[]>
  }
  chat: {
    listThreads(projectId: string): Promise<ChatThread[]>
    listMessages(projectId: string, threadId: string, before?: ChatCursor, limit?: number): Promise<ChatMessage[]>
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
    /** S2：未保存地址的临时测连（仅临时放行 origin，不写入白名单） */
    testUrl(input: { baseUrl: string; apiKey?: string; modelId: string; providerType?: ProviderType }): Promise<{ ok: boolean; message?: string }>
  }
  /** S2 e2e：读取 webRequest 拦截日志 */
  network: { blockedLog(): Promise<Array<{ url: string; reason: string; at: number }>> }
  /** S9：日更统计与可选目标（数据层无默认目标；UI 在 S10）。 */
  writing: {
    getDay(projectId: string, date?: string): Promise<WritingDailyRow>
    listRange(projectId: string, fromDate: string, toDate: string): Promise<WritingDailyRow[]>
    getGoals(projectId: string): Promise<WritingGoals>
    setGoals(projectId: string, input: {
      dailyWordGoalEnabled?: boolean
      dailyWordGoal?: number | null
      dailyChapterGoalEnabled?: boolean
      dailyChapterGoal?: number | null
    }): Promise<WritingGoals>
    getChapterWordRange(projectId: string): Promise<ChapterWordRange>
    setChapterWordRange(projectId: string, range: ChapterWordRange): Promise<ChapterWordRange>
  }
  prompts: {
    list(projectId: string): Promise<PromptTemplateEntry[]>
    set(projectId: string, mode: AIMode, text: string): Promise<PromptTemplateEntry[]>
    reset(projectId: string, mode: AIMode): Promise<PromptTemplateEntry[]>
    setScope(projectId: string, scope: import('./prompt-templates').PromptTemplateScope, choice?: import('./prompt-templates').PromptScopeChoice): Promise<PromptTemplateEntry[]>
    exportGlobal(): Promise<string | null>
    previewGlobalImport(): Promise<import('./prompt-templates').GlobalImportPreview | null>
    applyGlobalImport(token: string): Promise<import('./prompt-templates').GlobalPromptTemplateEntry[]>
    cancelGlobalImport(): Promise<null>
    listGlobal(): Promise<import('./prompt-templates').GlobalPromptTemplateEntry[]>
    setGlobal(mode: AIMode, text: string): Promise<import('./prompt-templates').GlobalPromptTemplateEntry[]>
    resetGlobal(mode: AIMode): Promise<import('./prompt-templates').GlobalPromptTemplateEntry[]>
    previewCopy(projectId: string, source: import('./prompt-templates').PromptCopySource): Promise<import('./prompt-templates').PromptCopyPreview>
    applyCopy(projectId: string, source: import('./prompt-templates').PromptCopySource, token: string): Promise<PromptTemplateEntry[]>
  }
  backup: {
    exportProject(projectId: string): Promise<string | null>
    importProject(): Promise<(Project & { importNotice?: string }) | null>
    importManuscript(): Promise<Project | null>
    exportManuscript(projectId: string, format: 'txt' | 'md' | 'docx', onlyFinal?: boolean, range?: ExportChapterRange): Promise<import('./export-range').ManuscriptExportResult>
  }
  ai: {
    start(request: AIStartRequest, onEvent: (event: AIStreamEvent) => void): () => void
    cancel(requestId: string): Promise<void>
    /** R4：发送前预览上下文清单（与实际发送同一规划逻辑）。 */
    previewContext(request: AIPreviewContextRequest): Promise<ContextBundle>
  }
}

export interface AIPreviewContextRequest {
  task: AITaskEnvelope
  threadId: string
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
  | { type: 'done'; requestId: string; candidates?: string[] }
  | { type: 'error'; requestId: string; message: string; code?: string }
