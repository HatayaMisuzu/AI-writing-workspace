import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electronRoot = join(repositoryRoot, 'node_modules', 'electron')
const electronPackagePath = join(electronRoot, 'package.json')
const electronPathFile = join(electronRoot, 'path.txt')
const electronVersionFile = join(electronRoot, 'dist', 'version')

assert(
  !process.env.ELECTRON_OVERRIDE_DIST_PATH,
  'Formal packaging does not allow ELECTRON_OVERRIDE_DIST_PATH; install the locked Electron runtime instead.'
)
assert(existsSync(electronPackagePath), 'Electron is not installed. Run npm ci before packaging.')
assert(existsSync(electronPathFile), 'Electron runtime path is missing. Run npm ci before packaging.')
assert(existsSync(electronVersionFile), 'Electron runtime is missing. Run npm ci before packaging.')

const packageVersion = JSON.parse(readFileSync(electronPackagePath, 'utf8')).version
const runtimeVersion = readFileSync(electronVersionFile, 'utf8').trim().replace(/^v/, '')
const runtimeExecutable = join(electronRoot, 'dist', readFileSync(electronPathFile, 'utf8').trim())

assert.equal(
  runtimeVersion,
  packageVersion,
  `Electron runtime ${runtimeVersion} does not match installed package ${packageVersion}. Run npm ci again.`
)
assert(existsSync(runtimeExecutable), `Electron runtime executable is missing: ${runtimeExecutable}`)

process.stdout.write(`✓ release runtime verified: Electron ${runtimeVersion}\n`)
