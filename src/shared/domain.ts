export type ProjectType = 'novel' | 'webnovel' | 'screenplay' | 'other'
export type DocumentType = 'volume' | 'chapter' | 'scene' | 'note'
export type AIMode =
  | 'discussion'
  | 'brainstorm'
  | 'generation'
  | 'editing'
  | 'organization'
  | 'chapter_digest'
  | 'proofreading'
  | 'reader_review'
export type RoutedTask = Exclude<AIMode, 'reader_review'>
export type WritePermission = 'none' | 'proposal' | 'authorized'
export type MemoryStatus = 'observed' | 'confirmed' | 'tentative' | 'idea' | 'suggested' | 'rejected' | 'superseded'
export type MemoryType = 'fact' | 'event' | 'character_state' | 'relationship' | 'decision' | 'idea' | 'question' | 'foreshadowing' | 'style_signal'
export type TextOrigin = 'human' | 'ai' | 'ai_edited_by_human' | 'mixed'

export interface Project {
  id: string
  title: string
  projectType: ProjectType
  description: string
  coverSeed: string
  createdAt: number
  updatedAt: number
  lastOpenedAt: number
  archived: boolean
  totalWordCount: number
}

export interface DocumentNode {
  id: string
  projectId: string
  parentId: string | null
  type: DocumentType
  title: string
  orderIndex: number
  wordCount: number
  revision: number
  createdAt: number
  updatedAt: number
}

export interface DocumentContent {
  documentId: string
  projectId: string
  editorJson: Record<string, unknown>
  plainText: string
  wordCount: number
  revision: number
  updatedAt: number
}

export interface Idea {
  id: string
  projectId: string
  content: string
  status: 'active' | 'used' | 'archived'
  tags: string[]
  createdAt: number
  updatedAt: number
}

export interface ProjectNote {
  id: string
  projectId: string
  section: 'story' | 'reference'
  title: string
  content: string
  createdAt: number
  updatedAt: number
}

export interface Character {
  id: string
  projectId: string
  name: string
  aliases: string[]
  notes: string
  fields: Record<string, string>
  createdAt: number
  updatedAt: number
}

export interface MemoryItem {
  id: string
  projectId: string
  type: MemoryType
  content: string
  status: MemoryStatus
  sourceType: 'chapter' | 'note' | 'chat' | 'author'
  sourceId: string
  sourceLocation?: string
  confidence?: number
  readerVisibleFrom?: number
  supersedes?: string
  createdAt: number
  updatedAt: number
}

export interface Snapshot {
  id: string
  projectId: string
  documentId: string
  reason: 'interval' | 'large_delete' | 'ai_edit' | 'manual' | 'pre_restore'
  revision: number
  content: string
  plainText: string
  metadata: Record<string, unknown>
  createdAt: number
}

export interface ProviderConfig {
  id: string
  providerType: 'openai-compatible'
  displayName: string
  baseUrl: string
  hasApiKey: boolean
  createdAt: number
  updatedAt: number
}

export interface ProviderInput extends Omit<ProviderConfig, 'hasApiKey' | 'createdAt' | 'updatedAt'> {
  apiKey?: string
}

export interface ProviderCapabilities {
  streaming: boolean
  tools: boolean
  structuredOutput: boolean
  cancellation: boolean
  maxContextTokens?: number
}

export interface ModelConfig {
  id: string
  providerId: string
  modelId: string
  displayName: string
  capabilities: ProviderCapabilities
  enabled: boolean
  isDefault: boolean
}

export interface TaskModelRoute {
  taskType: RoutedTask
  modelId: string | 'default'
}

export interface ChatThread {
  id: string
  projectId: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface TextPatch {
  id: string
  projectId: string
  documentId: string
  documentRevision: number
  fromPm: number
  toPm: number
  originalHash: string
  originalText: string
  replacement: string
  status: 'proposed' | 'accepted' | 'rejected' | 'stale'
  createdAt: number
}

export interface MemoryProposal extends MemoryItem {
  sourceType: 'chat'
  status: 'suggested'
}

export interface AITaskEnvelope {
  mode: AIMode
  writePermission: WritePermission
  userIntent: string
  projectId: string
  documentId?: string
  selection?: { from: number; to: number; text: string }
  throughChapterId?: string
}

export interface ContextItem {
  id: string
  kind: 'selection' | 'document' | 'nearby' | 'memory' | 'note' | 'search' | 'style' | 'character' | 'digest' | 'reference'
  title: string
  content: string
  projectId: string
  reason: string
}

export interface ContextBundle {
  projectId: string
  policy: 'creative' | 'reader'
  items: ContextItem[]
  metadata: { estimatedTokens: number; sourceIds: string[]; excludedKinds: string[] }
}

export interface SearchResult {
  projectId: string
  documentId: string
  title: string
  snippet: string
  rank: number
}

export interface ChatMessage {
  id: string
  threadId: string
  projectId: string
  role: 'user' | 'assistant'
  content: string
  taskMode: AIMode
  createdAt: number
  status: 'streaming' | 'complete' | 'error' | 'cancelled'
}

export interface MemoryIntentProposal {
  type: MemoryType
  content: string
  confidence?: number
}

export interface MemoryIntentResult {
  shouldPropose: boolean
  proposals: MemoryIntentProposal[]
}

export type DigestStatus =
  | { state: 'missing' }
  | { state: 'fresh'; digestId: string; chapterRevision: number }
  | { state: 'stale'; digestId: string; digestRevision: number; currentRevision: number }

export type ProofreadCategory = 'punctuation' | 'spacing' | 'typo' | 'grammar' | 'reference' | 'repetition' | 'format' | 'other'

export interface ProofreadIssue {
  id: string
  source: 'local' | 'ai'
  category: ProofreadCategory
  originalText: string
  suggestion?: string
  reason: string
  confidence?: number
  documentRevision: number
  from?: number
  to?: number
}

export interface StyleSample {
  id: string
  projectId: string
  documentId?: string
  origin: TextOrigin
  text: string
  sourceRevision?: number
  createdAt: number
  updatedAt: number
}

export interface DiffSegment {
  value: string
  type: 'equal' | 'insert' | 'delete'
}

export interface LocalLintIssue {
  id: string
  from: number
  to: number
  severity: 'info' | 'warning'
  kind: string
  message: string
  replacement?: string
}

export interface AppErrorShape {
  code: string
  message: string
  recoverable: boolean
  details?: string
}
