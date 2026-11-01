/**
 * P3 小黑屋只锁当前作品：主进程出站请求的「归属」标记（AsyncLocalStorage）。
 * - { projectId }：作品请求。IPC 入口在校验过作品确实存在后标记；checkEgress 在真正发出请求的那一刻只看这本是否在小黑屋。
 * - { nonWork: true }：与任何作品无关的请求，目前只给 providers:test / providers:test-url（有静态扫描测试锁住白名单）。
 * - 无标记：checkEgress 按全局兜底（任一作品锁定即拒绝），宁可多拦。
 * 标记随 async 调用链传播：await、定时器回调、async generator 的后续 next() 与二次出站都能读到。
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export type EgressContext = { readonly projectId: string } | { readonly nonWork: true }

const storage = new AsyncLocalStorage<EgressContext>()

export function runWithEgressContext<T>(context: EgressContext, fn: () => T): T {
  return storage.run(context, fn)
}

export function currentEgressContext(): EgressContext | undefined {
  return storage.getStore()
}

/**
 * 作品请求的标记：只有作品确实存在时才标 { projectId }；不存在（或查询失败）→ 不标记，交给全局兜底。
 * 防止伪造/过期的 projectId 借一本「没锁的书」绕过别处的锁。
 */
export function runWithWorkEgress<T>(projectExists: (projectId: string) => boolean, projectId: string, fn: () => T): T {
  let exists = false
  try { exists = projectExists(projectId) } catch { exists = false }
  return exists ? runWithEgressContext({ projectId }, fn) : fn()
}
