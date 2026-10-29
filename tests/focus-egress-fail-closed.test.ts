import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EgressBlockedError, focusLockedTitles, guardedFetch, installEgressGate, installFocusEgressLock, setRawFetchForTests } from '../src/main/net/egress-guard'
import { FOCUS_LOCK_PLACEHOLDER_TITLE, focusEgressCheck } from '../src/main/services/focus-lock-service'
import { userErrorMessage } from '../src/shared/user-error'

const allowAll = { decide: () => ({ allow: true as const, reason: 'test' }) }
const spyFetch = () => { const spy = vi.fn(async () => new Response('ok', { status: 200 })); setRawFetchForTests(spy as unknown as typeof fetch); return spy }

afterEach(() => { installFocusEgressLock(undefined); installEgressGate(undefined); setRawFetchForTests(undefined) })

describe('focusLockedTitles fail-closed：只有明确的 false 才算未锁', () => {
  it('检查函数返回空数组 [] → 仍视为锁定，guardedFetch 拒绝且 fetch 调用 0 次', async () => {
    installEgressGate(allowAll); const spy = spyFetch()
    installFocusEgressLock(() => [])
    expect(focusLockedTitles()).toEqual([])
    await expect(guardedFetch('https://api.example.com/v1/chat')).rejects.toMatchObject({ reason: 'focus-locked' })
    expect(spy).toHaveBeenCalledTimes(0)
  })

  it('服务端已锁定但取不到书名（空书名）→ 占位书名，仍拒绝，fetch 0 次', async () => {
    installEgressGate(allowAll); const spy = spyFetch()
    installFocusEgressLock(focusEgressCheck({ lockedProjects: () => [{ projectId: 'p1', title: '' }] }))
    expect(focusLockedTitles()).toEqual([FOCUS_LOCK_PLACEHOLDER_TITLE])
    const error = await guardedFetch('https://api.example.com/v1/chat').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(EgressBlockedError)
    expect((error as EgressBlockedError).message).toContain(`《${FOCUS_LOCK_PLACEHOLDER_TITLE}》`)
    expect(spy).toHaveBeenCalledTimes(0)
  })

  it('查询锁定状态失败 / 检查函数抛错 / 返回 true → 按锁定处理，fetch 0 次', async () => {
    installEgressGate(allowAll); const spy = spyFetch()
    for (const check of [focusEgressCheck({ lockedProjects: () => { throw new Error('db closed') } }), () => { throw new Error('boom') }, () => true]) {
      installFocusEgressLock(check)
      expect(focusLockedTitles()).toEqual([])
      await expect(guardedFetch('https://api.example.com/v1/chat')).rejects.toMatchObject({ reason: 'focus-locked' })
    }
    expect(spy).toHaveBeenCalledTimes(0)
  })

  it('对照：未锁定（明确的 false）才放行', async () => {
    installEgressGate(allowAll); const spy = spyFetch()
    installFocusEgressLock(focusEgressCheck({ lockedProjects: () => [] }))
    expect(focusLockedTitles()).toBeUndefined()
    await guardedFetch('https://api.example.com/v1/chat')
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('AssistantPanel 记忆提案报错走 userErrorMessage', () => {
  it('源码使用 userErrorMessage，且去掉 IPC 包装前缀', () => {
    const source = readFileSync(join(__dirname, '../src/renderer/src/components/AssistantPanel.tsx'), 'utf8')
    expect(source).toContain('记忆提案创建失败：${userErrorMessage(error)}')
    expect(source).not.toMatch(/记忆提案创建失败：\$\{error instanceof Error/)
    expect(userErrorMessage(new Error("Error invoking remote method 'memories:extract-intent': FocusLockError: 《雾港》正在小黑屋中"))).toBe('《雾港》正在小黑屋中')
  })
})
