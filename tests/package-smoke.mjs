import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright'

const requestedPath = process.env.INKSTONE_PACKAGED_EXE ?? process.argv[2]
assert(requestedPath, 'INKSTONE_PACKAGED_EXE must point to the packaged Windows executable')
const executablePath = resolve(requestedPath)
assert(existsSync(executablePath), 'INKSTONE_PACKAGED_EXE must point to the packaged Windows executable')
const userData = await mkdtemp(join(tmpdir(), 'inkstone-package-smoke-'))
let app
try {
  app = await electron.launch({ executablePath, args: [`--user-data-dir=${userData}`] })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await page.getByRole('button', { name: '新建作品' }).first().waitFor()
  assert.equal(await page.title(), '墨记')
  process.stdout.write(`✓ packaged app launched with isolated userData: ${executablePath}\n`)
} finally {
  await app?.close()
  await rm(userData, { recursive: true, force: true })
}
