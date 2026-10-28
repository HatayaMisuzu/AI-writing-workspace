import { z } from 'zod'

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
}).strict()
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
  id: idSchema, providerType: z.literal('openai-compatible'), displayName: z.string().trim().min(1).max(500),
  baseUrl: z.string().url().max(2_000), apiKey: z.string().max(20_000).optional()
})
export const capabilitiesSchema = z.object({
  streaming: z.boolean(), tools: z.boolean(), structuredOutput: z.boolean(), cancellation: z.boolean(),
  maxContextTokens: z.number().int().positive().max(10_000_000).optional()
})
export const modelSchema = z.object({
  id: idSchema, providerId: idSchema, modelId: z.string().trim().min(1).max(500),
  displayName: z.string().trim().min(1).max(500), capabilities: capabilitiesSchema,
  enabled: z.boolean(), isDefault: z.boolean()
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
export const aiStartSchema = z.object({
  requestId: idSchema, threadId: idSchema, userMessageId: idSchema, assistantMessageId: idSchema,
  task: z.object({
    mode: z.enum(['discussion','brainstorm','generation','editing','organization','chapter_digest','proofreading','reader_review']),
    writePermission: z.enum(['none','proposal','authorized']), userIntent: z.string().min(1).max(200_000),
    projectId: idSchema, documentId: idSchema.optional(), throughChapterId: idSchema.optional(),
    selection: z.object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative(), text: z.string().max(200_000) }).optional(),
    target: z.object({ requestId: idSchema, projectId: idSchema, documentId: idSchema, sourceRevision: z.number().int().nonnegative(),
      selection: z.object({ fromPm: z.number().int().nonnegative(), toPm: z.number().int().nonnegative(), text: z.string().max(200_000), originalHash: z.string().min(1).max(200) }).optional() }).optional()
  })
})
