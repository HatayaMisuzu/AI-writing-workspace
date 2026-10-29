import { z } from 'zod'

/**
 * P1-6 记录员·一致性检查：输出契约由代码固定、不可被模板覆盖。
 * 报告只读：不改正文/设定，不产补丁，不产记忆提案。
 */
export const CONSISTENCY_OUTPUT_CONTRACT = '输出契约：只输出一个 JSON 对象，不要输出其他文字：{"conflicts":[{"quote":"本章原文中的连续片段（逐字照抄）","location":"原文位置，如 第3段","conflictWith":{"kind":"setting|character|timeline","title":"冲突的设定/人物/时间线事件标题"},"explanation":"冲突说明"}]}。没有冲突时输出 {"conflicts":[]}。'

export const CONSISTENCY_DEFAULT_INTENT = '请检查本章正文与已确认设定、人物卡、时间线是否一致，输出只读冲突报告。'

const conflictSchema = z.object({
  quote: z.string().min(1),
  location: z.string().optional().default(''),
  conflictWith: z.object({ kind: z.enum(['setting', 'character', 'timeline']), title: z.string().min(1) }),
  explanation: z.string().optional().default('')
})
const reportSchema = z.object({ conflicts: z.array(conflictSchema) })
export type ConsistencyConflict = z.infer<typeof conflictSchema> & { quoteFound?: boolean }
export type ConsistencyReport = { ok: true; conflicts: ConsistencyConflict[] } | { ok: false; raw: string }

export const CONSISTENCY_KIND_LABELS: Record<ConsistencyConflict['conflictWith']['kind'], string> = { setting: '设定', character: '人物', timeline: '时间线' }

/** 解析模型输出；容忍 ```json 围栏与前后杂字。解析或结构校验失败 → { ok:false, raw }（界面退化为原文展示）。 */
export const parseConsistencyReport = (text: string, chapterText?: string): ConsistencyReport => {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1]
  const body = fenced ?? text
  const start = body.indexOf('{'); const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return { ok: false, raw: text }
  try {
    const parsed = reportSchema.safeParse(JSON.parse(body.slice(start, end + 1)))
    if (!parsed.success) return { ok: false, raw: text }
    const haystack = chapterText === undefined ? undefined : normalizeQuote(chapterText)
    return { ok: true, conflicts: parsed.data.conflicts.map((conflict) => haystack === undefined ? conflict : { ...conflict, quoteFound: quoteInChapter(conflict.quote, haystack) }) }
  } catch { return { ok: false, raw: text } }
}

/** 引用比对的归一化：去掉所有空白（含全角空格、换行），避免排版差异导致误判。 */
export const normalizeQuote = (text: string): string => text.replace(/[\s\u3000]+/g, '')
const quoteInChapter = (quote: string, normalizedChapter: string): boolean => {
  const needle = normalizeQuote(quote).replace(/^[「“"']+|[」”"']+$/g, '')
  return needle.length > 0 && normalizedChapter.includes(needle)
}

/** 冲突对象标题去掉与类别重复的前缀：「人物 · 林舟」→「林舟」。 */
export const conflictTargetLabel = (conflict: ConsistencyConflict): string => {
  const label = CONSISTENCY_KIND_LABELS[conflict.conflictWith.kind]
  let title = conflict.conflictWith.title.trim()
  for (const prefix of Object.values(CONSISTENCY_KIND_LABELS)) {
    const re = new RegExp(`^${prefix}\\s*[·:：]\\s*`)
    while (re.test(title)) title = title.replace(re, '')
  }
  return `${label} · ${title || conflict.conflictWith.title}`
}

const REF_KINDS: Record<string, ConsistencyConflict['conflictWith']['kind']> = { memory: 'setting', character: 'character', timeline: 'timeline' }

/** 本次一致性检查的比对覆盖情况（来自上下文清单或持久化的 snapshot）。 */
export interface ConsistencyCoverage {
  documentId?: string
  chapterTruncated: boolean
  chapterOmitted: boolean
  omittedRefs: Record<ConsistencyConflict['conflictWith']['kind'], number>
}

export const consistencyCoverage = (snapshot: { sources: Array<{ id: string; kind: string; truncated?: boolean }>; omitted: Array<{ id: string; kind: string }> }): ConsistencyCoverage => {
  const omittedRefs = { setting: 0, character: 0, timeline: 0 }
  for (const item of snapshot.omitted) { const kind = REF_KINDS[item.kind]; if (kind) omittedRefs[kind] += 1 }
  const doc = snapshot.sources.find((item) => item.kind === 'document')
  const omittedDoc = snapshot.omitted.find((item) => item.kind === 'document')
  return { documentId: doc?.id ?? omittedDoc?.id, chapterTruncated: Boolean(doc?.truncated), chapterOmitted: !doc, omittedRefs }
}

/** 覆盖不完整时的报告顶部警告；完整时返回空数组。 */
export const coverageWarnings = (coverage: ConsistencyCoverage | undefined): string[] => {
  if (!coverage) return []
  const warnings: string[] = []
  const parts = (Object.entries(coverage.omittedRefs) as Array<[ConsistencyConflict['conflictWith']['kind'], number]>)
    .filter(([, count]) => count > 0).map(([kind, count]) => `${CONSISTENCY_KIND_LABELS[kind]}×${count}`)
  if (parts.length) warnings.push(`部分设定因上下文窗口不足未参与比对，结果不完整（未比对：${parts.join('、')}）。`)
  if (coverage.chapterOmitted) warnings.push('本章正文因上下文窗口不足未发送，本次检查无效。')
  else if (coverage.chapterTruncated) warnings.push('本章过长，只检查了开头部分正文，结果不完整。')
  return warnings
}

/** 上下文条目截断：只此一处决定保留哪一端。读者审稿保留结尾（贴近第 N 章阅读位置），其余保留开头。 */
export type TruncationSide = 'head' | 'tail'
export const truncationSideFor = (policy: 'creative' | 'reader' | 'consistency'): TruncationSide => policy === 'reader' ? 'tail' : 'head'
export const truncateBySide = (text: string, keepChars: number, side: TruncationSide): string => {
  const keep = Math.max(1, Math.floor(keepChars))
  return side === 'tail' ? text.slice(-keep) : text.slice(0, keep)
}

/**
 * PR25 P3-a：把冲突分为「确切冲突 / 引用未在本章找到 / 未校验」。
 * verifiable=false（报告所属章节不是当前打开的章节，无从比对正文）时一律标「未校验」，不计入确切冲突数。
 */
export const classifyConflicts = (conflicts: ConsistencyConflict[], verifiable: boolean): { confirmed: ConsistencyConflict[]; notFound: ConsistencyConflict[]; unchecked: ConsistencyConflict[] } =>
  verifiable
    ? { confirmed: conflicts.filter((conflict) => conflict.quoteFound !== false), notFound: conflicts.filter((conflict) => conflict.quoteFound === false), unchecked: [] }
    : { confirmed: [], notFound: [], unchecked: conflicts }

export const CONSISTENCY_WINDOW_TOO_SMALL = '上下文窗口太小，无法做一致性检查'
