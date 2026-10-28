#!/usr/bin/env node
/**
 * S2 / PRD §6 ④：依赖与源码不得出现 electron-updater、analytics/sentry 类出网依赖。
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const FORBIDDEN_DEP_NAMES = [
  'electron-updater',
  'electron-simple-updater',
  'update-electron-app',
  '@sentry/electron',
  '@sentry/node',
  '@sentry/browser',
  '@sentry/react',
  'sentry',
  'analytics',
  '@amplitude/analytics-browser',
  'amplitude-js',
  'mixpanel',
  'mixpanel-browser',
  'posthog-js',
  'posthog-node',
  '@segment/analytics-node',
  'applicationinsights',
  'newrelic',
  'bugsnag',
  '@bugsnag/js',
  'telemetry',
  'open-telemetry',
  '@opentelemetry/sdk-node'
]

const FORBIDDEN_SOURCE_PATTERNS = [
  /electron-updater/,
  /@sentry\//,
  /\bSentry\.init\b/,
  /\bmixpanel\b/i,
  /\bamplitude\b/i,
  /\bposthog\b/i,
  /applicationinsights/i,
  /update-electron-app/
]

const allDeps = {
  ...pkg.dependencies,
  ...pkg.devDependencies,
  ...pkg.optionalDependencies,
  ...pkg.peerDependencies
}

const badDeps = Object.keys(allDeps).filter((name) =>
  FORBIDDEN_DEP_NAMES.some((forbidden) => name === forbidden || name.startsWith(`${forbidden}/`))
)
assert.equal(badDeps.length, 0, `禁止的出网/遥测依赖：${badDeps.join(', ')}`)

const skipDirs = new Set(['node_modules', '.git', 'release', 'out', 'dist', 'coverage', '.vite'])
const sourceExt = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.html', '.yml', '.yaml'])

const walk = (dir, files = []) => {
  for (const name of readdirSync(dir)) {
    if (skipDirs.has(name)) continue
    const path = join(dir, name)
    const st = statSync(path)
    if (st.isDirectory()) walk(path, files)
    else if ([...sourceExt].some((ext) => name.endsWith(ext))) files.push(path)
  }
  return files
}

// 本脚本自身含匹配字面量，排除；测试夹具若仅断言「不得出现」也可排除该脚本路径
const selfRel = relative(root, fileURLToPath(import.meta.url))
const violations = []
for (const file of walk(root)) {
  const rel = relative(root, file)
  if (rel === selfRel) continue
  if (rel.startsWith(`scripts/ci${join('/', '')}`) && rel.endsWith('no-extra-network-deps.mjs')) continue
  const text = readFileSync(file, 'utf8')
  for (const pattern of FORBIDDEN_SOURCE_PATTERNS) {
    if (pattern.test(text)) violations.push(`${rel} ~ ${pattern}`)
  }
}
assert.equal(violations.length, 0, `源码命中禁止出网模式：\n${violations.join('\n')}`)

process.stdout.write('✓ no-extra-network-deps: package.json 与源码未发现 updater/analytics/sentry 类依赖\n')
