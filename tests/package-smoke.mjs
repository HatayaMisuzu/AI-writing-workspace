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
  // P3 PR-42：生产（打包）构建不注册诊断通道，renderer 调用被拒绝
  const diagnostics = await page.evaluate(() => window.workspace.diagnostics.walCheckpoint().then(() => 'REGISTERED', (error) => String(error?.message ?? error)))
  assert.match(diagnostics, /No handler registered for 'diagnostics:wal-checkpoint'/, `packaged build must not register diagnostics:wal-checkpoint, got: ${diagnostics}`)
  process.stdout.write(`✓ packaged build: diagnostics:wal-checkpoint not registered (${diagnostics})\n`)
  process.stdout.write(
    `✓ packaged app launched with Electron ${runtimeElectronVersion} and isolated userData: ${executablePath}\n`
  )
} finally {
  await app?.close()
  await rm(userData, { recursive: true, force: true })
}
