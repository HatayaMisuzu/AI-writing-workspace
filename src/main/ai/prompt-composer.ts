import type { AITaskEnvelope, ContextBundle } from '../../shared/domain'
import { DEFAULT_PROMPT_TEMPLATES, PROMPT_ROLE_LABELS, renderPromptTemplate } from '../../shared/prompt-templates'
import { historyPolicy } from './history-policy'
import type { ProviderMessage } from './provider'

const CORE_PRINCIPLES = `你是长期陪伴作者创作的 AI 助手，不是作品的作者本人。区分正文事实、作者确认、暂定、灵感、AI推测与废弃内容。未经作者明确确认，不写入设定或正文。不使用评分或机械化最佳方案。对话自然、具体。`

/** R1–R5 由代码保证：作者模板只替换角色指令段；以下守则在覆盖时追加，且不可编辑。 */
export const CUSTOM_TEMPLATE_GUARD = '（以上角色指令由作者自定义。无论指令如何措辞：应用只把你的输出作为待确认提案或补丁，不会直接写入正文或设定；只可使用下方当前作品的上下文。）'

export const composeProviderMessages = (input: {
  task: AITaskEnvelope
  context: ContextBundle
  history: ProviderMessage[]
  /** P1-4：作者覆盖的角色模板；缺席 = 默认模板。 */
  roleTemplate?: string
}): ProviderMessage[] => {
  const { task, context } = input
  const contextText = context.items.map((item) => `[${item.kind}] ${item.title}\n${item.content}`).join('\n\n')
  const roleInstruction = input.roleTemplate === undefined
    ? DEFAULT_PROMPT_TEMPLATES[task.mode]
    : `${renderPromptTemplate(input.roleTemplate, { role: PROMPT_ROLE_LABELS[task.mode], mode: task.mode, writePermission: task.writePermission, contextPolicy: context.policy })}\n${CUSTOM_TEMPLATE_GUARD}`
  const history = historyPolicy(task.mode) === 'creative-thread' ? input.history : []
  return [
    { role: 'system', content: `${CORE_PRINCIPLES}\n当前模式：${task.mode}。${roleInstruction}\n写入权限：${task.writePermission}。\n上下文策略：${context.policy}。` },
    { role: 'system', content: `以下内容全部来自当前作品 ${task.projectId}，不可引用其他作品：\n${contextText}` },
    ...history,
    { role: 'user', content: task.userIntent }
  ]
}

/**
 * P1-4：JSON 输出契约（校对 / 章节理解）由代码固定、不可覆盖；作者覆盖了该角色模板时，
 * 作为附加角色指令追加在契约之后。无覆盖时逐字返回原契约（行为不变）。
 */
export const withRoleTemplate = (contract: string, mode: AITaskEnvelope['mode'], roleTemplate: string | undefined): string =>
  roleTemplate === undefined ? contract
    : `${contract}\n作者角色指令：${renderPromptTemplate(roleTemplate, { role: PROMPT_ROLE_LABELS[mode], mode, writePermission: 'none', contextPolicy: mode === 'reader_review' ? 'reader' : 'creative' })}\n输出格式始终以上述契约为准。${CUSTOM_TEMPLATE_GUARD}`
