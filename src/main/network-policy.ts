/**
 * S2 / PRD §6：网络白名单策略（纯函数 + 可变门闸）。
 * 只放行 file://、devtools（仅开发）、已保存 Provider origin；
 * 未保存地址仅在「测试连接」期间经 temporaryOrigins 临时放行。
 */

export type NetworkDecision = { allow: true } | { allow: false; reason: string }

export type NetworkPolicyInput = {
  /** 已保存 Provider 的 origin（小写 scheme://host:port） */
  savedOrigins: ReadonlySet<string> | readonly string[]
  /** 测试连接期间临时放行的 origin */
  temporaryOrigins?: ReadonlySet<string> | readonly string[]
  /** 是否开发态（放行 devtools://） */
  isDev?: boolean
}

const toSet = (value: ReadonlySet<string> | readonly string[] | undefined): ReadonlySet<string> => {
  if (!value) return new Set()
  return value instanceof Set ? value : new Set(value)
}

/** 从 Base URL 提取 origin；非法则返回 undefined（不放行）。 */
export const originFromBaseUrl = (baseUrl: string): string | undefined => {
  try {
    const parsed = new URL(baseUrl.trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    if (!parsed.hostname) return undefined
    return parsed.origin
  } catch {
    return undefined
  }
}

/** 从 provider_configs.base_url 列表收集合法 origin。 */
export const originsFromProviderBaseUrls = (baseUrls: readonly string[]): Set<string> => {
  const origins = new Set<string>()
  for (const baseUrl of baseUrls) {
    const origin = originFromBaseUrl(baseUrl)
    if (origin) origins.add(origin)
  }
  return origins
}

/**
 * 判断请求 URL 是否允许通过 session.webRequest。
 * 放行：file://；devtools://（仅 isDev）；saved / temporary origin 的 http(s)。
 */
export const decideNetworkRequest = (rawUrl: string, input: NetworkPolicyInput): NetworkDecision => {
  let parsed: URL
  try { parsed = new URL(rawUrl) } catch {
    return { allow: false, reason: 'malformed-url' }
  }
  const protocol = parsed.protocol
  if (protocol === 'file:') return { allow: true }
  if (protocol === 'devtools:') {
    return input.isDev ? { allow: true } : { allow: false, reason: 'devtools-in-production' }
  }
  // Chromium / Electron 内部资源；不视为出网
  if (protocol === 'chrome-extension:' || protocol === 'chrome:' || protocol === 'data:' || protocol === 'blob:' || protocol === 'about:') {
    return { allow: true }
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    return { allow: false, reason: `blocked-scheme:${protocol}` }
  }
  const saved = toSet(input.savedOrigins)
  const temporary = toSet(input.temporaryOrigins)
  if (saved.has(parsed.origin) || temporary.has(parsed.origin)) return { allow: true }
  return { allow: false, reason: 'origin-not-allowlisted' }
}

export type BlockedNetworkEntry = { url: string; reason: string; at: number }

/** 运行时门闸：维护已保存 / 临时 origin，并记录拦截。 */
export class NetworkGate {
  private savedOrigins = new Set<string>()
  private temporaryOrigins = new Set<string>()
  private readonly blocked: BlockedNetworkEntry[] = []
  private readonly isDev: boolean
  private readonly onBlocked?: (entry: BlockedNetworkEntry) => void
  private readonly isFocusLocked: () => boolean

  constructor(options?: { isDev?: boolean; onBlocked?: (entry: BlockedNetworkEntry) => void; isFocusLocked?: () => boolean }) {
    this.isDev = Boolean(options?.isDev)
    this.onBlocked = options?.onBlocked
    this.isFocusLocked = options?.isFocusLocked ?? (() => false)
  }

  setSavedOrigins(origins: Iterable<string>): void {
    this.savedOrigins = new Set(origins)
  }

  /** 测试连接：临时放行 origin，返回撤销函数。 */
  allowTemporarily(origin: string): () => void {
    this.temporaryOrigins.add(origin)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.temporaryOrigins.delete(origin)
    }
  }

  decide(rawUrl: string): NetworkDecision {
    // F15：小黑屋锁定期间，渲染进程（session.webRequest）的 http/https/ws 一律拒绝，已保存 origin 也不例外。
    if (/^(https?|wss?):/i.test(rawUrl.trim()) && this.isFocusLocked()) return { allow: false, reason: 'focus-locked' }
    return this.decideAllowlist(rawUrl)
  }

  /**
   * P3：只按地址白名单判定，不看小黑屋锁。仅供主进程 guardedFetch 使用——
   * 主进程出站的锁判定由 egress-guard 的 checkFocusEgress 按作品标记做（无标记仍按全局兜底）。
   * renderer（webRequest）路径仍走 decide()，任一作品锁定即拒绝。
   */
  decideAllowlist(rawUrl: string): NetworkDecision {
    return decideNetworkRequest(rawUrl, {
      savedOrigins: this.savedOrigins,
      temporaryOrigins: this.temporaryOrigins,
      isDev: this.isDev
    })
  }

  /** webRequest 回调：返回 cancel 与否；拒绝时记日志。 */
  filter(rawUrl: string): { cancel: boolean } {
    const decision = this.decide(rawUrl)
    if (decision.allow) return { cancel: false }
    const entry: BlockedNetworkEntry = { url: rawUrl, reason: decision.reason, at: Date.now() }
    this.blocked.push(entry)
    this.onBlocked?.(entry)
    return { cancel: true }
  }

  getBlockedLog(): readonly BlockedNetworkEntry[] {
    return this.blocked
  }

  getBlockedCount(): number {
    return this.blocked.length
  }

  /** 测试用：清空拦截记录。 */
  clearBlockedLog(): void {
    this.blocked.length = 0
  }
}
