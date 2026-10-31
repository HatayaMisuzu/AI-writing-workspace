/**
 * P3 发布包（main/preload，A 级）：
 * 1. 主窗口 minWidth = 1000（Windows 1366×768 @125% 可用宽度约 1093 逻辑像素，需 ≤ 1093）。
 * 2. 开发用诊断接口 __devWalCheckpoint：只有 main 未打包时追加 DEV_DIAGNOSTICS_ARG，preload 才暴露；
 *    打包 / 生产模式下 preload 不暴露，IPC diagnostics:wal-checkpoint 不注册（register 侧见 diagnostics-gate-p42）。
 * 打包产物的真实行为另由 tests/package-smoke.mjs（CI package job）断言。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEV_DIAGNOSTICS_ARG } from '../src/shared/dev-diagnostics'

const bridge = vi.hoisted(() => ({ exposed: new Map<string, Record<string, unknown>>(), invoked: [] as unknown[][] }))
const ipc = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (key: string, api: Record<string, unknown>) => { bridge.exposed.set(key, api) } },
  ipcRenderer: { invoke: (...args: unknown[]) => { bridge.invoked.push(args); return Promise.resolve({ busy: false }) }, on: () => {}, removeListener: () => {} },
  ipcMain: { handle: (channel: string, fn: unknown) => { ipc.handlers.set(channel, fn) }, on: () => {} },
  BrowserWindow: { getFocusedWindow: () => null, fromWebContents: () => null, getAllWindows: () => [] },
  dialog: {},
  app: { getPath: () => '/tmp' }
}))

import { createTestDb, testCodec } from './helpers'
import { registerIpc } from '../src/main/ipc/register'

const MIN_WIDTH = 1000
const WIN_1366_AT_125_DIP = Math.floor(1366 / 1.25) // 1092.8 → 约 1093 逻辑像素

const loadPreload = async (argv: string[]): Promise<Record<string, unknown>> => {
  const saved = process.argv
  process.argv = [...saved, ...argv]
  try {
    vi.resetModules()
    bridge.exposed.clear()
    await import('../src/preload/index')
    const api = bridge.exposed.get('workspace')
    expect(api).toBeTypeOf('object')
    return api!
  } finally {
    process.argv = saved
  }
}

describe('P3 发布包：主窗口最小宽度', () => {
  it('BrowserWindow minWidth 为 1000，且不大于 1366×768@125% 的可用宽度（约 1093）', () => {
    const index = readFileSync(resolve('src/main/index.ts'), 'utf8')
    const matches = [...index.matchAll(/minWidth:\s*(\d+)/g)].map((m) => Number(m[1]))
    expect(matches).toEqual([MIN_WIDTH])
    expect(MIN_WIDTH).toBeLessThanOrEqual(WIN_1366_AT_125_DIP)
  })
})

describe('P3 发布包：开发用诊断接口 __devWalCheckpoint', () => {
  beforeEach(() => { bridge.invoked.length = 0; ipc.handlers.clear() })
  afterEach(() => { vi.resetModules() })

  it('生产模式（渲染进程 argv 无开发参数）：preload 不暴露 __devWalCheckpoint，也没有旧的 diagnostics 键', async () => {
    const api = await loadPreload([])
    expect(api).not.toHaveProperty('__devWalCheckpoint')
    expect(api).not.toHaveProperty('diagnostics')
    expect(Object.keys(api).filter((key) => key.startsWith('__dev'))).toEqual([])
  })

  it('生产模式：IPC diagnostics:wal-checkpoint 不注册（打包版传 diagnostics:false）', () => {
    registerIpc(createTestDb(), testCodec, { refreshNetworkAllowlist: () => {}, allowOriginTemporarily: () => () => {}, getBlockedLog: () => [] }, { diagnostics: false })
    expect(ipc.handlers.has('diagnostics:wal-checkpoint')).toBe(false)
    expect(ipc.handlers.has('projects:list')).toBe(true)
  })

  it('开发模式（main 追加 DEV_DIAGNOSTICS_ARG）：preload 暴露 __devWalCheckpoint，调用走 diagnostics:wal-checkpoint', async () => {
    const api = await loadPreload([DEV_DIAGNOSTICS_ARG])
    expect(api.__devWalCheckpoint).toBeTypeOf('function')
    expect(api).not.toHaveProperty('diagnostics')
    await (api.__devWalCheckpoint as () => Promise<unknown>)()
    expect(bridge.invoked).toEqual([['diagnostics:wal-checkpoint']])
  })

  it('源码守卫：参数只由 main 在 !app.isPackaged 时经 additionalArguments 追加；没有环境变量开关', () => {
    const index = readFileSync(resolve('src/main/index.ts'), 'utf8')
    expect(index).toMatch(/const devDiagnosticsEnabled = \(\): boolean => !app\.isPackaged\n/)
    expect(index).toMatch(/additionalArguments: devDiagnosticsEnabled\(\) \? \[DEV_DIAGNOSTICS_ARG\] : \[\]/)
    const preload = readFileSync(resolve('src/preload/index.ts'), 'utf8')
    expect(preload).toMatch(/if \(process\.argv\.includes\(DEV_DIAGNOSTICS_ARG\)\) api\.__devWalCheckpoint = /)
    expect(preload).not.toMatch(/walCheckpoint:/)
    expect(preload).not.toMatch(/process\.env/)
    expect(index).not.toMatch(/process\.env\.[A-Z_]*DIAG/)
  })
})
