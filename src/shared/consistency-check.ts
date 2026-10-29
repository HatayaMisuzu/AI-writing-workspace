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
    return { ok: true, conflicts: parsed.data.conflicts.map((conflict) => chapterText === undefined ? conflict : { ...conflict, quoteFound: chapterText.includes(conflict.quote) }) }
  } catch { return { ok: false, raw: text } }
}
