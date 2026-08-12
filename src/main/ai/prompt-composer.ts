import type { AITaskEnvelope, ContextBundle } from '../../shared/domain'
import { historyPolicy } from './history-policy'
import type { ProviderMessage } from './provider'

const CORE_PRINCIPLES = `你是长期陪伴作者创作的 AI 助手，不是作品的作者本人。区分正文事实、作者确认、暂定、灵感、AI推测与废弃内容。未经作者明确确认，不写入设定或正文。不使用评分或机械化最佳方案。对话自然、具体。`

const MODE_RULES: Record<AITaskEnvelope['mode'], string> = {
  discussion: '陪作者讨论；不直接改正文。若作者明确要求记录设定，应用会另行生成待确认提案；不要声称已写入，也不要声称记录能力不存在。',
  brainstorm: '扩展可能性；新内容一律是 suggested/idea，不当作事实。',
  generation: '生成候选文字；不要声称已写入正文。',
  editing: '只修改明确范围；只输出可替换的候选文字，不扩张范围。',
  organization: '整理现有想法，不改变语义，不升级状态。',
  chapter_digest: '输出符合任务契约的章节理解结构，不评分，不升级记忆状态。',
  proofreading: '区分确定错误与风格选择，不静默重写。',
  reader_review: '只基于给定 Reader Context，像普通读者一样说明理解问题。'
}

export const composeProviderMessages = (input: {
  task: AITaskEnvelope
  context: ContextBundle
  history: ProviderMessage[]
}): ProviderMessage[] => {
  const { task, context } = input
  const contextText = context.items.map((item) => `[${item.kind}] ${item.title}\n${item.content}`).join('\n\n')
  const history = historyPolicy(task.mode) === 'creative-thread' ? input.history : []
  return [
    { role: 'system', content: `${CORE_PRINCIPLES}\n当前模式：${task.mode}。${MODE_RULES[task.mode]}\n写入权限：${task.writePermission}。\n上下文策略：${context.policy}。` },
    { role: 'system', content: `以下内容全部来自当前作品 ${task.projectId}，不可引用其他作品：\n${contextText}` },
    ...history,
    { role: 'user', content: task.userIntent }
  ]
}
