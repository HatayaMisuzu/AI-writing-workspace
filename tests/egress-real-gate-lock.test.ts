import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { guardedFetch, installEgressGate, installFocusEgressLock, isFocusEgressLocked, setRawFetchForTests } from '../src/main/net/egress-guard'
import { runWithEgressContext } from '../src/main/net/egress-context'
import { NetworkGate } from '../src/main/network-policy'

/**
 * P3：用真实 NetworkGate（isFocusLocked 接真实全局锁）+ 真实 installFocusEgressLock，不用放行桩。
 * 之前 R6/R7 等用 { decide: () => allow } 桩，没走 NetworkGate 的 focus-locked 分支，主进程测试连接被拒的缺口没被发现。
 */
const URL_OK = 'http://localhost:11434/v1/models'
const LOCKED = 'locked-book'
const OTHER = 'other-book'
let calls = 0
let gate: NetworkGate
beforeEach(() => {
  calls = 0
  setRawFetchForTests(async () => { calls += 1; return new Response('{"data":[]}', { status: 200 }) })
  installFocusEgressLock(() => ['雾港来信'], (projectId) => projectId === LOCKED ? '雾港来信' : false)
  gate = new NetworkGate({ isFocusLocked: isFocusEgressLocked })
  gate.setSavedOrigins(['http://localhost:11434'])
  installEgressGate(gate)
})
afterEach(() => { installFocusEgressLock(undefined); installEgressGate(undefined); setRawFetchForTests(undefined) })

describe('P3 真实 NetworkGate + 真实锁：主进程只按白名单 + checkFocusEgress，renderer 仍全局拒', () => {
  it('RG1 锁定时 nonWork（测试连接）放行并出站', async () => {
    await runWithEgressContext({ nonWork: true }, () => guardedFetch(URL_OK))
    expect(calls).toBe(1)
  })
  it('RG2 被锁作品拒绝（focus-locked），出站 0 次', async () => {
    await expect(runWithEgressContext({ projectId: LOCKED }, () => guardedFetch(URL_OK))).rejects.toMatchObject({ reason: 'focus-locked' })
    expect(calls).toBe(0)
  })
  it('RG3 另一本书放行并出站', async () => {
    await runWithEgressContext({ projectId: OTHER }, () => guardedFetch(URL_OK))
    expect(calls).toBe(1)
  })
  it('RG4 无标记请求在锁定时拒绝（全局兜底），出站 0 次', async () => {
    await expect(guardedFetch(URL_OK)).rejects.toMatchObject({ reason: 'focus-locked' })
    expect(calls).toBe(0)
  })
  it('RG5 锁定时 renderer 路径（NetworkGate.decide / filter）仍为 focus-locked', () => {
    expect(gate.decide(URL_OK)).toEqual({ allow: false, reason: 'focus-locked' })
    expect(gate.filter(URL_OK)).toEqual({ cancel: true })
    expect(gate.decideAllowlist(URL_OK)).toEqual({ allow: true })
  })
})
