import type { AIMode, ChatMessage, ModelConfig, RoutedTask } from '../../../shared/domain'

export interface AssistantHistoryMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  status?: 'streaming' | 'error' | 'cancelled'
  mode?: AIMode
  createdAt: number
  replyToUserId?: string
  historical?: boolean
  inserted?: boolean
}

export function mapChatHistory(messages: ChatMessage[]): AssistantHistoryMessage[] {
  let latestUserId: string | undefined
  return messages.map((message) => {
    if (message.role === 'user') latestUserId = message.id
    const statusNote = message.status === 'cancelled' ? '请求已取消。' : ''
    return {
      id: message.id,
      role: message.role,
      content: statusNote ? [message.content, statusNote].filter(Boolean).join('\n\n')
        : message.content || (message.status === 'error' ? '上次请求未完成。' : ''),
      status: message.status === 'streaming' || message.status === 'error' || message.status === 'cancelled' ? message.status : undefined,
      mode: message.taskMode,
      createdAt: message.createdAt,
      replyToUserId: message.role === 'assistant' ? latestUserId : undefined,
      historical: true
    }
  })
}

export function retryInputForMessage(messages: AssistantHistoryMessage[], failedMessageId: string): string {
  const failed = messages.find((message) => message.id === failedMessageId)
  if (!failed?.replyToUserId) return ''
  return messages.find((message) => message.id === failed.replyToUserId && message.role === 'user')?.content ?? ''
}

export function canInsertCandidate(message: AssistantHistoryMessage): boolean {
  return message.role === 'assistant' && message.mode === 'generation' && !message.status && !message.historical && !message.inserted && Boolean(message.content)
}

export function resolveModelDisplayName(mode: RoutedTask, models: ModelConfig[], routes: Record<RoutedTask, string | 'default'>): string {
  const route = routes[mode]
  const fallback = models.find((item) => item.isDefault && item.enabled)
  const model = route === 'default' ? fallback : models.find((item) => item.id === route && item.enabled) ?? fallback
  return model?.displayName ?? '未配置模型'
}

export function resolveDisplayedModelMode(inputMode: RoutedTask, activeRequestMode?: RoutedTask): RoutedTask {
  return activeRequestMode ?? inputMode
}
