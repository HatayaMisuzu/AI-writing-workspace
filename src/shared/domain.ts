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



/** S9：日更统计行（显示用净值已夹到 ≥0；删除数单独保留）。 */
export interface WritingDailyRow {
  date: string
  humanWordsAdded: number
  humanWordsDeleted: number
  humanWordsNetDisplay: number
  aiWordsAccepted: number
  activeSeconds: number
}

/**
 * S9：可选日更目标视图。
 * 数据层不预置任何默认目标值；settings_json 缺席字段 = 空且未启用。
 * false/null 仅为读出派生，不得写回成默认目标数字。
 */
export interface WritingGoals {
  dailyWordGoalEnabled: boolean
  dailyWordGoal: number | null
  dailyChapterGoalEnabled: boolean
  dailyChapterGoal: number | null
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
  section: 'story' | 'reference' | 'outline'
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
  sourceRevision?: number
  sourceDigestId?: string
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
  /** S1c：存量配置的地址不合法时给出原因；此时不会发起任何请求，需作者修正。 */
  baseUrlError?: string
  hasApiKey: boolean
  /** S7：首 token 超时（ms）；未设则按本地/远端默认。 */
  firstTokenTimeoutMs?: number
  /** S7：整次请求总超时（ms）。 */
  totalTimeoutMs?: number
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
  /** S7：上下文窗口（tokens）；预算 = 窗口 − 最大输出 − 余量。 */
  contextWindow?: number
  /** S7：最大输出（tokens）。 */
  maxOutput?: number
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

export interface DocumentTaskTarget {
  requestId: string
  projectId: string
  documentId: string
  sourceRevision: number
  selection?: { fromPm: number; toPm: number; text: string; originalHash: string }
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
  target?: DocumentTaskTarget
  selection?: { from: number; to: number; text: string }
  throughChapterId?: string
  /** R4：作者在上下文清单中排除的来源 id（ContextItem.id）；同 id 的所有条目都不会发送。 */
  excludedIds?: string[]
  /** S6：默认不发送的来源（如大纲）被作者勾选后列入；只作用于单次请求。 */
  includedIds?: string[]
  /** S8：执笔（generation）候选数，默认 1、最多 3；其他模式忽略。 */
  candidateCount?: number
}

export interface ContextItem {
  id: string
  kind: 'selection' | 'document' | 'nearby' | 'memory' | 'note' | 'search' | 'style' | 'character' | 'digest' | 'reference' | 'outline'
  title: string
  content: string
  projectId: string
  reason: string
  /** 因预算被截断（只发送了部分内容）。 */
  truncated?: boolean
}

/** 未发送的候选来源。reason：作者排除 / 超出预算被省略（S7 的“已省略”标注复用此结构）。 */
export interface ContextOmission {
  id: string
  kind: ContextItem['kind']
  title: string
  reason: 'user_excluded' | 'budget' | 'default_excluded'
}

export interface ContextBundle {
  projectId: string
  policy: 'creative' | 'reader'
  items: ContextItem[]
  metadata: { estimatedTokens: number; sourceIds: string[]; excludedKinds: string[]; omitted?: ContextOmission[] }
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
  target?: DocumentTaskTarget
}

export interface ChatCursor { createdAt: number; id: string }

export interface MemoryIntentProposal {
  type: MemoryType
  content: string
  confidence?: number
  supersedes?: string
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
  /** 1-based occurrence of originalText in the proofread revision. */
  occurrence?: number
  contextBefore?: string
  contextAfter?: string
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
  documentId: string
  sourceRevision: number
  from: number
  to: number
  severity: 'info' | 'warning'
  kind: string
  message: string
  replacement?: string
  sourceTextHash: string
  originalText: string
}

export interface AppErrorShape {
  code: string
  message: string
  recoverable: boolean
  details?: string
}

/** 卷梗概 / 章细纲（node_outlines，S3）。beats 为细纲要点列表，hook 为章末钩子。 */
export interface NodeOutline {
  nodeId: string
  projectId: string
  summary: string
  beats: string[]
  hook: string
  updatedAt: number
}
