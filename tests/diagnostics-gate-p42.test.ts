/**
 * P3 PR-42：diagnostics:wal-checkpoint 只在未打包构建注册，生产构建（app.isPackaged）不注册；注册时也不返回库路径。
 * 区分依据：现有 src/main/index.ts 已用 `!app.isPackaged` 判定开发态（NetworkGate isDev）；vitest 与 e2e 都直接运行
 * out/main/index.js（未打包），打包安装的生产构建 app.isPackaged=true。打包产物另由 tests/package-smoke.mjs 断言调用被拒绝。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ipc = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => { ipc.handlers.set(channel, fn) },
    on: () => {}
  },
  BrowserWindow: { getFocusedWindow: () => null, fromWebContents: () => null, getAllWindows: () => [] },
  dialog: {},
  app: { getPath: () => '/tmp' }
}))

import { createTestDb, testCodec } from './helpers'
import { registerIpc } from '../src/main/ipc/register'

const network = { refreshNetworkAllowlist: () => {}, allowOriginTemporarily: () => () => {}, getBlockedLog: () => [] }
const frame = { url: 'file:///app/out/renderer/index.html' }
const event = { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false, send: () => {} } }

describe('diagnostics:wal-checkpoint 注册门槛', () => {
  beforeEach(() => { ipc.handlers.clear() })

  it('默认（生产传 diagnostics:false / 不传）不注册诊断通道，其他通道照常注册', () => {
    registerIpc(createTestDb(), testCodec, network)
    expect(ipc.handlers.has('diagnostics:wal-checkpoint')).toBe(false)
    expect(ipc.handlers.has('projects:list')).toBe(true)
    ipc.handlers.clear()
    registerIpc(createTestDb(), testCodec, network, { diagnostics: false })
    expect(ipc.handlers.has('diagnostics:wal-checkpoint')).toBe(false)
    expect([...ipc.handlers.keys()].filter((c) => c.startsWith('diagnostics:'))).toEqual([])
  })

  it('diagnostics:true（未打包：开发 / e2e）才注册，且返回值不含 dbPath 或任何路径', async () => {
    registerIpc(createTestDb(), testCodec, network, { diagnostics: true })
    const fn = ipc.handlers.get('diagnostics:wal-checkpoint')
    expect(fn).toBeTypeOf('function')
    const result = await fn!(event) as Record<string, unknown>
    // #42 合入后保留 commits/releases；总管硬要求：不得含 dbPath
    expect(Object.keys(result).sort()).toEqual(['autoCheckpoint', 'busy', 'commits', 'last', 'releases', 'runs', 'walBytes'])
    expect(result).not.toHaveProperty('dbPath')
    expect(JSON.stringify(result)).not.toMatch(/sqlite|[\\/]/)
  })

  it('源码守卫：index.ts 以 !app.isPackaged 决定是否注册；register.ts 只在 options.diagnostics === true 时注册且不返回 db.path', () => {
    const index = readFileSync(resolve('src/main/index.ts'), 'utf8')
    expect(index).toMatch(/registerIpc\(database, codec, \{[\s\S]*?\}, \{[\s\S]*?diagnostics: !app\.isPackaged[\s\S]*?\}\)/)
    const register = readFileSync(resolve('src/main/ipc/register.ts'), 'utf8')
    expect(register).toMatch(/if \(options\.diagnostics === true\) \{\s*handle\('diagnostics:wal-checkpoint'/)
    expect(register.match(/handle\('diagnostics:/g)).toHaveLength(1)
    expect(register).not.toMatch(/dbPath|db\.path/)
  })
})
