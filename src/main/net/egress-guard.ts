/**
 * P3-1：主进程统一出站守门。
 * session.webRequest 只约束 renderer / session 请求，Node 全局 fetch 不受其约束；
 * 因此主进程所有外联必须经 guardedFetch：
 * - 仅 http(s)，且 origin 属于已保存 Provider Base URL 或本次「测试连接」临时放行的地址（与 S2 同源规则）；
 * - 未安装门闸时一律拒绝（fail-closed）；
 * - redirect: 'manual'，任何 3xx 都拒绝，不跟随到外部地址。
 */
import type { NetworkGate } from '../network-policy'

export type EgressDecider = Pick<NetworkGate, 'decide'>

export class EgressBlockedError extends Error {
  readonly code = 'EGRESS_BLOCKED'
  constructor(message: string, readonly reason: string) {
    super(message)
    this.name = 'EgressBlockedError'
  }
}

let installed: EgressDecider | undefined
let rawFetch: typeof fetch = (...args) => globalThis.fetch(...args)

/** 由 main/index.ts 在启动时安装（与 webRequest 共用同一个 NetworkGate）。传 undefined 卸载。 */
export function installEgressGate(gate: EgressDecider | undefined): void { installed = gate }

let focusLocked: () => boolean = () => false
/** F15：小黑屋锁定期间主进程一律不出站（与 IPC 层 FOCUS_LOCKED 双保险）。传 undefined 卸载。 */
export function installFocusEgressLock(check: (() => boolean) | undefined): void { focusLocked = check ?? (() => false) }

/** 仅测试用：替换底层 fetch。 */
export function setRawFetchForTests(fetcher: typeof fetch | undefined): void {
  rawFetch = fetcher ?? ((...args) => globalThis.fetch(...args))
}

const urlOf = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

export function checkEgress(rawUrl: string): void {
  let parsed: URL
  try { parsed = new URL(rawUrl) } catch { throw new EgressBlockedError('出站请求被拒绝：服务地址无法解析。', 'malformed-url') }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new EgressBlockedError('出站请求被拒绝：仅允许 http/https 服务地址。', `blocked-scheme:${parsed.protocol}`)
  }
  if (!installed) throw new EgressBlockedError('出站请求被拒绝：网络守门未就绪。', 'gate-not-installed')
  if (focusLocked()) throw new EgressBlockedError('出站请求被拒绝：小黑屋锁定中，不发起任何网络请求。', 'focus-locked')
  const decision = installed.decide(parsed.href)
  if (!decision.allow) {
    console.warn(`[egress-guard] blocked ${decision.reason}: ${parsed.origin}`)
    throw new EgressBlockedError(`出站请求被拒绝：${parsed.origin} 不在已配置的模型服务地址中。请先在设置中保存该服务地址，或使用「测试连接」。`, decision.reason)
  }
}

/** 主进程唯一允许的出站 fetch。 */
export const guardedFetch: typeof fetch = async (input, init) => {
  checkEgress(urlOf(input))
  const response = await rawFetch(input, { ...init, redirect: 'manual' })
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    try { await response.body?.cancel() } catch { /* ignore */ }
    throw new EgressBlockedError('出站请求被拒绝：模型服务返回了重定向，已阻止跳转。请直接填写最终服务地址。', 'redirect-blocked')
  }
  return response
}
