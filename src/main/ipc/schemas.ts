import { PROMPT_TEMPLATE_MAX_LENGTH, validatePromptTemplate } from '../../shared/prompt-templates'
import { z } from 'zod'
import { checkBaseUrl } from '../../shared/base-url'

/** IPC 入参 zod 校验（从 register.ts 抽出以便单测，行为不变）。 */
export const idSchema = z.string().min(1).max(200)
export const shortTextSchema = z.string().max(2_000)
export const contentSchema = z.string().max(5_000_000)
export const nonNegativeIntSchema = z.number().int().nonnegative().max(2_147_483_647)
export const editorDocumentSchema = z.object({ type: z.literal('doc'), content: z.array(z.unknown()).max(200_000) }).passthrough()
export const projectCreateSchema = z.object({
  title: z.string().trim().min(1).max(500),
  projectType: z.enum(['novel', 'webnovel', 'screenplay', 'other']),
  description: shortTextSchema.optional()
})
export const documentCreateSchema = z.object({
  projectId: idSchema, parentId: idSchema.nullish(), type: z.enum(['volume', 'chapter', 'scene', 'note']),
  title: z.string().trim().min(1).max(500)
})
export const documentSaveSchema = z.object({
  projectId: idSchema, documentId: idSchema, editorJson: editorDocumentSchema, plainText: contentSchema,
  expectedRevision: nonNegativeIntSchema.optional(),
  styleSample: z.object({ origin: z.enum(['human', 'ai', 'ai_edited_by_human', 'mixed']), text: contentSchema }).optional()
})
// S3：大纲作为 project_notes 的一个 section；节点大纲（summary/beats/hook）走 outlineSaveSchema
export const noteSectionSchema = z.enum(['story', 'reference', 'outline'])
export const outlineSaveSchema = z.object({
  projectId: idSchema, nodeId: idSchema, summary: contentSchema.optional(),
  beats: z.array(shortTextSchema).max(1_000).optional(), hook: shortTextSchema.optional()
})
/** S4：批量建章 — 每行一条细纲 summary */
export const batchCreateChaptersSchema = z.object({
  projectId: idSchema,
  volumeId: idSchema,
  lines: z.array(z.string().trim().min(1).max(2_000)).min(1).max(200)
})
export const noteSaveSchema = z.object({
  id: idSchema.optional(), projectId: idSchema, section: noteSectionSchema,
  title: shortTextSchema, content: contentSchema
})
export const characterSaveSchema = z.object({
  id: idSchema.optional(), projectId: idSchema, name: z.string().trim().min(1).max(500),
  aliases: z.array(shortTextSchema).max(1_000).optional(), notes: contentSchema.optional(),
  fields: z.record(z.string().max(500), contentSchema).optional()
})
export const providerInputSchema = z.object({
  id: idSchema, providerType: z.enum(['openai-compatible', 'anthropic']), displayName: z.string().trim().min(1).max(500),
  baseUrl: z.string().superRefine((value, ctx) => {
    const check = checkBaseUrl(value)
    if (!check.ok) ctx.addIssue({ code: 'custom', message: check.message })
  }), apiKey: z.string().max(20_000).optional(),
  firstTokenTimeoutMs: z.number().int().positive().max(3_600_000).optional(),
  totalTimeoutMs: z.number().int().positive().max(3_600_000).optional()
})
export const capabilitiesSchema = z.object({
  streaming: z.boolean(), tools: z.boolean(), structuredOutput: z.boolean(), cancellation: z.boolean(),
  maxContextTokens: z.number().int().positive().max(10_000_000).optional()
})
export const modelSchema = z.object({
  id: idSchema, providerId: idSchema, modelId: z.string().trim().min(1).max(500),
  displayName: z.string().trim().min(1).max(500), capabilities: capabilitiesSchema,
  enabled: z.boolean(), isDefault: z.boolean(),
  contextWindow: z.number().int().positive().max(10_000_000).optional(),
  maxOutput: z.number().int().positive().max(10_000_000).optional()
})
export const routeSchema = z.object({
  taskType: z.enum(['discussion', 'brainstorm', 'generation', 'editing', 'organization', 'chapter_digest', 'proofreading']),
  modelId: z.union([idSchema, z.literal('default')])
})
export const patchProposalSchema = z.object({
  projectId: idSchema, documentId: idSchema, documentRevision: nonNegativeIntSchema,
  fromPm: nonNegativeIntSchema, toPm: nonNegativeIntSchema, originalText: contentSchema, replacement: contentSchema
}).refine((value) => value.toPm >= value.fromPm, { message: 'PATCH_PM_RANGE_INVALID' })
export const snapshotReasonSchema = z.enum(['interval', 'large_delete', 'ai_edit', 'manual', 'pre_restore'])
// R4/S6：上下文来源 id（如 `selection:<docId>`），作者可逐条排除。
export const contextSourceIdSchema = z.string().min(1).max(300)
export const aiTaskSchema = z.object({
  mode: z.enum(['discussion','brainstorm','generation','editing','organization','chapter_digest','proofreading','reader_review','consistency_check']),
  writePermission: z.enum(['none','proposal','authorized']), userIntent: z.string().min(1).max(200_000),
  projectId: idSchema, documentId: idSchema.optional(), throughChapterId: idSchema.optional(), throughChapterNumber: z.number().optional(),
  selection: z.object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative(), text: z.string().max(200_000) }).optional(),
  target: z.object({ requestId: idSchema, projectId: idSchema, documentId: idSchema, sourceRevision: z.number().int().nonnegative(),
    selection: z.object({ fromPm: z.number().int().nonnegative(), toPm: z.number().int().nonnegative(), text: z.string().max(200_000), originalHash: z.string().min(1).max(200) }).optional() }).optional(),
  excludedIds: z.array(contextSourceIdSchema).max(500).optional(),
  includedIds: z.array(contextSourceIdSchema).max(500).optional(),
  /** S8：执笔候选数 1–3；缺省由 runtime 归一为 1。 */
  candidateCount: z.number().int().min(1).max(3).optional()
})
export const aiStartSchema = z.object({
  requestId: idSchema, threadId: idSchema, userMessageId: idSchema, assistantMessageId: idSchema,
  task: aiTaskSchema
})
// 发送前预览：输入框可能为空，故 userIntent 允许空串；其余字段与发送一致。
export const aiPreviewContextSchema = z.object({
  threadId: idSchema,
  task: aiTaskSchema.extend({ userIntent: z.string().max(200_000) })
})

// S9：日更目标写入。0/负数拒绝；缺省字段不预置默认目标值。
export const writingGoalsInputSchema = z.object({
  dailyWordGoalEnabled: z.boolean().optional(),
  dailyWordGoal: z.number().int().nullable().optional(),
  dailyChapterGoalEnabled: z.boolean().optional(),
  dailyChapterGoal: z.number().int().nullable().optional()
}).strict()

// P1-4：提示词模板（变量与长度由 validatePromptTemplate 校验，未知变量拒绝保存）
export const promptTemplateModeSchema = z.enum(['discussion','brainstorm','generation','editing','organization','chapter_digest','proofreading','reader_review','consistency_check'])
export const promptTemplateScopeSchema = z.enum(['global', 'project'])
export const promptCopySourceSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('global') }).strict(), z.object({ kind: z.literal('project'), projectId: z.string().min(1).max(200) }).strict()])
export const promptTemplateTextSchema = z.string().max(PROMPT_TEMPLATE_MAX_LENGTH).superRefine((text, ctx) => {
  const check = validatePromptTemplate(text)
  if (!check.ok) ctx.addIssue({ code: 'custom', message: check.error })
})

// P1-3 F10：章节字数区间（正整数，可只设一端，下限≤上限）
const optionalPositiveInt = z.number().int().positive().nullable()
export const chapterWordRangeSchema = z.object({ min: optionalPositiveInt, max: optionalPositiveInt }).strict()
  .refine((range) => range.min === null || range.max === null || range.min <= range.max, { message: '字数下限不能大于上限' })

// S11：章节状态与连载进度指针
export const chapterStatusSchema = z.enum(['outline', 'draft', 'final'])
export const serialProgressSchema = z.object({
  progressChapterId: idSchema.nullable()
}).strict()

export const foreshadowStateSchema = z.enum(['planted', 'hinting', 'resolved', 'abandoned'])
export const foreshadowRegisterSchema = z.object({
  projectId: idSchema,
  chapterId: idSchema,
  name: z.string().trim().max(200).optional(),
  content: contentSchema,
  fromPm: z.number().int().nonnegative(),
  toPm: z.number().int().nonnegative(),
  plannedChapterId: idSchema.nullable().optional(),
  characterIds: z.array(idSchema).max(100).optional()
}).strict()
export const foreshadowSetStateSchema = z.object({
  projectId: idSchema,
  memoryId: idSchema,
  state: foreshadowStateSchema,
  abandonReason: z.string().max(5_000).optional(),
  resolvedChapterId: idSchema.nullable().optional(),
  plannedChapterId: idSchema.nullable().optional(),
  characterIds: z.array(idSchema).max(100).optional()
}).strict()
export const foreshadowUpdateMetaSchema = z.object({
  projectId: idSchema,
  memoryId: idSchema,
  plannedChapterId: idSchema.nullable().optional(),
  resolvedChapterId: idSchema.nullable().optional(),
  characterIds: z.array(idSchema).max(100).optional()
}).strict()

export const timelineSortModeSchema = z.enum(['story', 'chapter'])
export const timelineEventSaveSchema = z.object({
  id: idSchema.optional(),
  projectId: idSchema,
  storyTimeLabel: z.string().max(200).optional(),
  sortKey: z.number().finite(),
  title: z.string().max(500),
  chapterId: idSchema.nullable().optional(),
  characterIds: z.array(idSchema).max(100).optional()
}).strict()

/** F14 人物悬停偏好：条目上限防止 settings_json 被无限撑大。 */
const hoverTermRefSchema = z.object({ characterId: idSchema, term: z.string().trim().min(1).max(100) }).strict()
export const hoverPrefsSchema = z.object({
  enabled: z.boolean(),
  ignoredTerms: z.array(hoverTermRefSchema).max(10_000),
  enabledSingleTerms: z.array(hoverTermRefSchema).max(10_000)
}).strict()

/** F13 本地校对 / 词表 */
export const lintRunSchema = z.tuple([idSchema, idSchema, contentSchema, z.number().int().min(-1).max(2_147_483_647).optional()])
export const wordlistTextSchema = z.string().max(1_000_000, '词表超过 1MB')
export const wordlistScopeSchema = z.enum(['global', 'project'])
export const lintRulesSchema = z.object({
  punctuation: z.boolean(), wordlist: z.boolean(), halfwidth: z.boolean(), repeatChar: z.boolean(),
  repeatChars: z.array(z.string().min(1).max(2)).max(50),
  reduplicationWhitelist: z.array(z.string().min(1).max(20)).max(2000)
}).strict()
export const lintIgnoreSchema = z.object({
  documentId: idSchema, ruleKey: z.string().min(1).max(200), originalText: z.string().min(1).max(200), occurrence: z.number().int().min(1).max(1_000_000)
}).strict()
export const importTokenSchema = z.string().regex(/^[0-9a-f]{64}$/)
export const patchRebaseSchema = z.object({
  projectId: idSchema, patchId: idSchema, fromRevision: nonNegativeIntSchema, toRevision: nonNegativeIntSchema,
  fromPm: nonNegativeIntSchema, toPm: nonNegativeIntSchema
}).strict()
export const patchPrepareBatchSchema = z.object({
  projectId: idSchema, documentId: idSchema, documentRevision: nonNegativeIntSchema,
  items: z.array(z.object({ patchId: idSchema, currentText: contentSchema }).strict()).min(1).max(500)
}).strict()
export const patchCompleteBatchSchema = z.object({
  projectId: idSchema, savedRevision: nonNegativeIntSchema, acceptedIds: z.array(idSchema).max(500), staleIds: z.array(idSchema).max(500)
}).strict()
