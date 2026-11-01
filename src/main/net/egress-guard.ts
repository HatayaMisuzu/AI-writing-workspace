/**
 * P3-1：主进程统一出站守门。
 * session.webRequest 只约束 renderer / session 请求，Node 全局 fetch 不受其约束；
 * 因此主进程所有外联必须经 guardedFetch：
 * - 仅 http(s)，且 origin 属于已保存 Provider Base URL 或本次「测试连接」临时放行的地址（与 S2 同源规则）；
 * - 未安装门闸时一律拒绝（fail-closed）；
 * - redirect: 'manual'，任何 3xx 都拒绝，不跟随到外部地址。
 */
import type { NetworkGate } from '../network-policy'
import { currentEgressContext } from './egress-context'

/**
 * 主进程出站优先用 decideAllowlist（只看地址白名单；锁判定在 checkFocusEgress 里按作品做）。
 * 只有 decide 的门闸（测试桩）退回 decide。
 */
export type EgressDecider = Pick<NetworkGate, 'decide'> & Partial<Pick<NetworkGate, 'decideAllowlist'>>

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

/**
 * 返回值语义（fail-closed）：只有明确的 false 才算未锁定；true 或任意数组（包括空数组）都算锁定中。
 * 检查函数抛错也按锁定处理。
 */
type FocusLockCheck = () => boolean | readonly string[]
/**
 * 按作品判定：未锁定 → false（唯一的「未锁」值）；锁定 → 书名（取不到书名可为空串）。
 * 检查函数抛错按锁定处理（fail-closed）。
 */
type ProjectFocusLockCheck = (projectId: string) => false | string
let focusLocked: FocusLockCheck = () => false
let projectFocusLocked: ProjectFocusLockCheck | undefined
/**
 * F15 / P3：小黑屋只锁当前作品（与 IPC 层 FOCUS_LOCKED 双保险）。
 * - check：全局判定，供无标记出站兜底与 renderer 网络策略；
 * - projectCheck：带 { projectId } 标记的出站只看这本书；未安装时带标记的请求也按全局兜底。
 * 传 undefined 卸载。
 */
export function installFocusEgressLock(check: FocusLockCheck | undefined, projectCheck?: ProjectFocusLockCheck): void {
  focusLocked = check ?? (() => false)
  projectFocusLocked = check ? projectCheck : undefined
}
/** 锁定中的书名（未锁定 → undefined；锁定但取不到书名 → []）。供 webRequest / openExternal 共用。 */
export function focusLockedTitles(): readonly string[] | undefined {
  let value: boolean | readonly string[]
  try { value = focusLocked() } catch { return [] }
  if (value === false) return undefined
  if (Array.isArray(value)) return value.filter((title) => typeof title === 'string' && title.trim())
  return []
}
export const isFocusEgressLocked = (): boolean => focusLockedTitles() !== undefined

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
  checkFocusEgress()
  const decision = installed.decideAllowlist ? installed.decideAllowlist(parsed.href) : installed.decide(parsed.href)
  if (!decision.allow) {
    console.warn(`[egress-guard] blocked ${decision.reason}: ${parsed.origin}`)
    throw new EgressBlockedError(`出站请求被拒绝：${parsed.origin} 不在已配置的模型服务地址中。请先在设置中保存该服务地址，或使用「测试连接」。`, decision.reason)
  }
}

const focusBlocked = (titles: readonly string[], scope: 'work' | 'global'): EgressBlockedError => {
  const named = titles.length ? titles.map((title) => `《${title}》`).join('、') : '某部作品'
  const tail = scope === 'work' ? '这本书锁定期间不发起网络请求' : '未标明所属作品的请求在锁定期间一律不发起'
  return new EgressBlockedError(`出站请求被拒绝：${named}正在小黑屋中，${tail}。`, 'focus-locked')
}

/** 判定发生在真正发出请求的这一刻（每次 guardedFetch 都重新读锁状态与标记）。 */
function checkFocusEgress(): void {
  const context = currentEgressContext()
  if (context && 'nonWork' in context && context.nonWork === true) return
  if (context && 'projectId' in context && projectFocusLocked) {
    let title: false | string
    try { title = projectFocusLocked(context.projectId) } catch { title = '' }
    if (title !== false) throw focusBlocked(title.trim() ? [title.trim()] : [], 'work')
    return
  }
  const lockedTitles = focusLockedTitles()
  if (lockedTitles) throw focusBlocked(lockedTitles, 'global')
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
