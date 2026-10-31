import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright'

const requestedPath = process.env.INKSTONE_PACKAGED_EXE ?? process.argv[2]
assert(requestedPath, 'INKSTONE_PACKAGED_EXE must point to the packaged app executable (Windows .exe or Linux binary)')
const executablePath = resolve(requestedPath)
assert(existsSync(executablePath), 'INKSTONE_PACKAGED_EXE must point to the packaged app executable (Windows .exe or Linux binary)')
const expectedElectronVersion = JSON.parse(
  await readFile(resolve('node_modules/electron/package.json'), 'utf8')
).version
const userData = await mkdtemp(join(tmpdir(), 'inkstone-package-smoke-'))
let app
try {
  app = await electron.launch({ executablePath, args: [`--user-data-dir=${userData}`] })
  const runtimeElectronVersion = await app.evaluate(() => process.versions.electron)
  assert.equal(
    runtimeElectronVersion,
    expectedElectronVersion,
    `Packaged Electron ${runtimeElectronVersion} does not match installed package ${expectedElectronVersion}`
  )
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await page.getByRole('button', { name: '新建作品' }).first().waitFor()
  assert.equal(await page.title(), '墨记')
  // P3 发布包：打包版 app.isPackaged=true；preload 不暴露开发用诊断接口，main 也不注册对应 IPC
  assert.equal(await app.evaluate(({ app: electronApp }) => electronApp.isPackaged), true, 'package smoke must run a packaged build')
  const exposed = await page.evaluate(() => ({ dev: typeof window.workspace.__devWalCheckpoint, legacy: 'diagnostics' in window.workspace, keys: Object.keys(window.workspace).filter((key) => key.startsWith('__dev')) }))
  assert.deepEqual(exposed, { dev: 'undefined', legacy: false, keys: [] }, `packaged preload must not expose dev diagnostics, got: ${JSON.stringify(exposed)}`)
  // 公开行为：同一 channel 已有 handler 时 ipcMain.handle 会抛错。能注册成功 = 打包版 main 没注册该 IPC；探测后立即移除。
  const ipcProbe = await app.evaluate(({ ipcMain }) => {
    try { ipcMain.handle('diagnostics:wal-checkpoint', () => null) } catch (error) { return `REGISTERED: ${error?.message ?? error}` }
    ipcMain.removeHandler('diagnostics:wal-checkpoint')
    return 'NOT_REGISTERED'
  })
  assert.equal(ipcProbe, 'NOT_REGISTERED', `packaged build must not register diagnostics:wal-checkpoint, got: ${ipcProbe}`)
  process.stdout.write(`✓ packaged build: __devWalCheckpoint not exposed, diagnostics:wal-checkpoint not registered\n`)
  process.stdout.write(
    `✓ packaged app launched with Electron ${runtimeElectronVersion} and isolated userData: ${executablePath}\n`
  )
} finally {
  await app?.close()
  await rm(userData, { recursive: true, force: true })
}
