import { ZodError, type core } from 'zod'

const FIELD_LABELS: Record<string, string> = { mode: '模式', format: '格式', min: '字数下限', max: '字数上限', userIntent: '输入内容', title: '标题' }

const fieldLabel = (path: PropertyKey[]): string => {
  if (!path.length) return ''
  const joined = path.map(String).join('.')
  const last = path.at(-1)
  const label = typeof last === 'string' ? FIELD_LABELS[last] : undefined
  return label ? `${label}（${joined}）` : joined
}

/** 修复 2：每条 issue 给出具体原因（自定义校验消息原样保留，如未知变量、下限>上限）。 */
const issueReason = (issue: core.$ZodIssue): string => {
  switch (issue.code) {
    case 'custom': return issue.message
    case 'too_big': return issue.origin === 'string' ? `超过长度上限 ${String(issue.maximum)} 字` : issue.origin === 'array' ? `条目过多（最多 ${String(issue.maximum)} 条）` : `不能大于 ${String(issue.maximum)}`
    case 'too_small': return issue.origin === 'string' ? (Number(issue.minimum) <= 1 ? '不能为空' : `至少 ${String(issue.minimum)} 字`) : issue.origin === 'array' ? `至少 ${String(issue.minimum)} 条` : `不能小于 ${String(issue.minimum)}`
    case 'invalid_value': return `取值无效，可选：${issue.values.map(String).join('、')}`
    case 'invalid_type': return `类型不正确（应为 ${issue.expected}）`
    case 'unrecognized_keys': return `未知字段：${issue.keys.join('、')}`
    case 'invalid_format': return '格式不正确'
    default: return '取值无效'
  }
}

/** Hygiene：IPC 入参 zod 校验失败时返回中文可读报错，而不是 ZodError 的 JSON 原文。其他错误原样返回。 */
export const toUserFacingIpcError = (error: unknown): unknown => {
  if (!(error instanceof ZodError)) return error
  const parts = [...new Set(error.issues.map((issue) => {
    const field = fieldLabel(issue.path)
    const reason = issueReason(issue).replace(/[。.]+$/, '')
    return field ? `${field}：${reason}` : reason
  }))].slice(0, 5)
  return Object.assign(new Error(`请求参数无效：${parts.join('；')}。`), { code: 'IPC_INVALID_INPUT' })
}
