import type { AIMode } from './domain'

/**
 * P1-4 提示词模板：每个 AI 角色（= AIMode）一份默认「角色指令」。
 * 作者覆盖存于 projects.settings_json.promptTemplates[mode]；缺席 = 使用默认。
 * 模板只替换角色指令段；核心原则、写入权限、上下文隔离与输出契约由代码固定，
 * R1–R5 不依赖模板措辞。
 */
export const PROMPT_TEMPLATE_MODES: AIMode[] = [
  'discussion', 'brainstorm', 'generation', 'editing', 'organization', 'chapter_digest', 'proofreading', 'reader_review', 'consistency_check'
]

export const PROMPT_ROLE_LABELS: Record<AIMode, string> = {
  discussion: '参谋', brainstorm: '点子', generation: '执笔', editing: '润色',
  organization: '记录员·整理', chapter_digest: '记录员·章节理解', proofreading: '校对', reader_review: '读者视角审稿', consistency_check: '记录员·一致性检查'
}

/** 默认模板 = 原硬编码 MODE_RULES，逐字不变。 */
export const DEFAULT_PROMPT_TEMPLATES: Record<AIMode, string> = {
  discussion: '陪作者讨论；不直接改正文。若作者明确要求记录设定，应用会另行生成待确认提案；不要声称已写入，也不要声称记录能力不存在。',
  brainstorm: '扩展可能性；新内容一律是 suggested/idea，不当作事实。',
  generation: '生成候选文字；不要声称已写入正文。',
  editing: '只修改明确范围；只输出可替换的候选文字，不扩张范围。',
  organization: '整理现有想法，不改变语义，不升级状态。',
  chapter_digest: '输出符合任务契约的章节理解结构，不评分，不升级记忆状态。',
  proofreading: '区分确定错误与风格选择，不静默重写。',
  reader_review: '只基于给定 Reader Context（第 1..N 章正文），像普通读者一样输出只读审稿报告：分「读者疑问」「追读风险」两部分，每条注明具体章节；不提供改写稿或补丁，不建议修改设定。',
  consistency_check: '只基于给定的本章正文与已确认设定、人物卡、时间线，找出本章正文与它们之间的矛盾；每条冲突引用本章原文并注明与哪条设定/人物/时间线事件冲突。只读：不改写正文、不建议修改设定、不提出补丁或记忆提案；没有冲突就返回空列表。'
}

/** 允许的模板变量（{{name}}）。 */
export const PROMPT_TEMPLATE_VARIABLES = ['role', 'mode', 'writePermission', 'contextPolicy'] as const
export type PromptTemplateVariable = typeof PROMPT_TEMPLATE_VARIABLES[number]
export const PROMPT_TEMPLATE_MAX_LENGTH = 4000

export type PromptTemplateValidation = { ok: true } | { ok: false; error: string; unknownVariables?: string[] }

/** 保存前校验：非空、长度上限、花括号成对、只允许已知变量。未知变量 → 拒绝保存。 */
export const validatePromptTemplate = (text: string): PromptTemplateValidation => {
  if (!text.trim()) return { ok: false, error: '模板不能为空；如需默认内容请使用「恢复默认」。' }
  if (text.length > PROMPT_TEMPLATE_MAX_LENGTH) return { ok: false, error: `模板不能超过 ${PROMPT_TEMPLATE_MAX_LENGTH} 字。` }
  const unknown = new Set<string>()
  const stripped = text.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (_match, name: string) => {
    if (!(PROMPT_TEMPLATE_VARIABLES as readonly string[]).includes(name)) unknown.add(name || '（空）')
    return ''
  })
  if (stripped.includes('{{') || stripped.includes('}}')) return { ok: false, error: '模板中的 {{ }} 没有成对闭合。' }
  if (unknown.size) {
    const list = [...unknown]
    return { ok: false, error: `未知变量：${list.map((name) => `{{${name}}}`).join('、')}。可用变量：${PROMPT_TEMPLATE_VARIABLES.map((name) => `{{${name}}}`).join('、')}。`, unknownVariables: list }
  }
  return { ok: true }
}

/** 渲染：只替换已知变量（已通过保存校验）；残留未知占位原样保留，不抛错。 */
export const renderPromptTemplate = (text: string, values: Record<PromptTemplateVariable, string>): string =>
  text.replace(/\{\{\s*([A-Za-z]+)\s*\}\}/g, (match, name: string) =>
    (PROMPT_TEMPLATE_VARIABLES as readonly string[]).includes(name) ? values[name as PromptTemplateVariable] : match)

export type PromptTemplateOverrides = Partial<Record<AIMode, string>>

/** 从 settings_json 中读取覆盖，过滤非法条目。 */
export const readPromptTemplateOverrides = (settings: Record<string, unknown>): PromptTemplateOverrides => {
  const raw = settings.promptTemplates
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const result: PromptTemplateOverrides = {}
  for (const mode of PROMPT_TEMPLATE_MODES) {
    const value = (raw as Record<string, unknown>)[mode]
    if (typeof value === 'string' && validatePromptTemplate(value).ok) result[mode] = value
  }
  return result
}

export interface PromptTemplateEntry { mode: AIMode; role: string; defaultTemplate: string; override: string | null }
