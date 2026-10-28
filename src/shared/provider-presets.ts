/** S7：Provider 预设（只填默认 Base URL，不内置任何 key）与上下文预算计算。 */

export type ProviderPresetId = 'ollama' | 'lmstudio' | 'openai' | 'deepseek' | 'openrouter' | 'custom'

export interface ProviderPreset {
  id: ProviderPresetId
  label: string
  displayName: string
  /** 空字符串表示自定义（作者自行填写）。 */
  baseUrl: string
  /** 本地预设允许空 key。 */
  allowEmptyKey: boolean
}

/** 预设模板：无 apiKey 字段。 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: 'ollama', label: 'Ollama', displayName: 'Ollama', baseUrl: 'http://localhost:11434/v1', allowEmptyKey: true },
  { id: 'lmstudio', label: 'LM Studio', displayName: 'LM Studio', baseUrl: 'http://localhost:1234/v1', allowEmptyKey: true },
  { id: 'openai', label: 'OpenAI', displayName: 'OpenAI', baseUrl: 'https://api.openai.com/v1', allowEmptyKey: false },
  { id: 'deepseek', label: 'DeepSeek', displayName: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', allowEmptyKey: false },
  { id: 'openrouter', label: 'OpenRouter', displayName: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', allowEmptyKey: false },
  { id: 'custom', label: '自定义', displayName: 'OpenAI-compatible', baseUrl: '', allowEmptyKey: false }
] as const

export const CONTEXT_BUDGET_MARGIN = 256
export const DEFAULT_CONTEXT_WINDOW = 16_000
export const DEFAULT_MAX_OUTPUT = 4_096
/** 本地首 token 默认 120s；远端 60s。 */
export const LOCAL_FIRST_TOKEN_TIMEOUT_MS = 120_000
export const REMOTE_FIRST_TOKEN_TIMEOUT_MS = 60_000
/** 总超时默认：本地 600s；远端 180s。 */
export const LOCAL_TOTAL_TIMEOUT_MS = 600_000
export const REMOTE_TOTAL_TIMEOUT_MS = 180_000

export const isLocalHostname = (hostname: string): boolean => {
  const host = hostname.trim().toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

export const isLocalBaseUrl = (baseUrl: string): boolean => {
  try {
    const url = new URL(baseUrl.includes('://') ? baseUrl : `http://${baseUrl}`)
    return isLocalHostname(url.hostname)
  } catch {
    return /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[?::1\]?)(:|\/|$)/i.test(baseUrl.trim())
  }
}

export const defaultTimeoutsForBaseUrl = (baseUrl: string): { firstTokenTimeoutMs: number; totalTimeoutMs: number } =>
  isLocalBaseUrl(baseUrl)
    ? { firstTokenTimeoutMs: LOCAL_FIRST_TOKEN_TIMEOUT_MS, totalTimeoutMs: LOCAL_TOTAL_TIMEOUT_MS }
    : { firstTokenTimeoutMs: REMOTE_FIRST_TOKEN_TIMEOUT_MS, totalTimeoutMs: REMOTE_TOTAL_TIMEOUT_MS }

/** 预算：窗口 − 最大输出 − 余量。 */
export const computeContextInputBudget = (
  contextWindow: number,
  maxOutput: number,
  margin: number = CONTEXT_BUDGET_MARGIN
): number => {
  const window = Math.max(0, Math.floor(contextWindow))
  const output = Math.max(0, Math.floor(maxOutput))
  const m = Math.max(0, Math.floor(margin))
  return Math.max(0, window - output - m)
}

export const localConnectionErrorMessage = (baseUrl: string): string | undefined => {
  try {
    const url = new URL(baseUrl.includes('://') ? baseUrl : `http://${baseUrl}`)
    if (!isLocalHostname(url.hostname)) return undefined
    const port = url.port || (url.protocol === 'https:' ? '443' : '80')
    return `无法连接 localhost:${port}`
  } catch {
    return undefined
  }
}
