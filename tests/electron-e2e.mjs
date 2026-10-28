import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { _electron as electron, chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const bundledElectron = join(root, 'node_modules/electron/dist/electron.exe')
const executablePath = existsSync(bundledElectron) ? bundledElectron : process.env.INKSTONE_ELECTRON_EXECUTABLE
const userData = await mkdtemp(join(tmpdir(), 'inkstone-e2e-'))
const results = []
let streamDelay = 450

const fixture = createServer(async (request, response) => {
  let raw = ''
  for await (const chunk of request) raw += chunk
  const body = JSON.parse(raw || '{}')
  const messages = Array.isArray(body.messages) ? body.messages : []
  const system = String(messages.find((message) => message.role === 'system')?.content ?? '')
  const user = String([...messages].reverse().find((message) => message.role === 'user')?.content ?? '')
  if (!body.stream) {
    const content = system.includes('memoryCandidates')
      ? JSON.stringify({ summary: 'fixture digest', events: [], characterChanges: [], reveals: [], openQuestions: [], memoryCandidates: [], possibleContradictions: [] })
      : system.includes('shouldPropose')
        ? JSON.stringify({ shouldPropose: false, proposals: [] })
        : system.includes('issues') ? JSON.stringify({ issues: [] }) : 'fixture ok'
    if (system.includes('memoryCandidates')) await new Promise((done) => setTimeout(done, streamDelay))
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { content } }] }))
    return
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' })
  await new Promise((done) => setTimeout(done, streamDelay))
  if (user.includes('EOF 测试')) {
    response.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
    return
  }
  const content = user.includes('续写') || user.includes('候选') ? '续写候选' : '跨章改写'
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
  response.end('data: [DONE]\n\n')
})
fixture.listen(0, '127.0.0.1')
await once(fixture, 'listening')
const address = fixture.address()
assert(address && typeof address === 'object')
const baseUrl = `http://127.0.0.1:${address.port}/v1`

const record = async (name, operation) => {
  const started = Date.now()
  await operation()
  results.push({ name, durationMs: Date.now() - started })
  process.stdout.write(`✓ ${name}\n`)
}

// Linux：Playwright 的 Electron loader 会强制追加 --password-store=basic，safeStorage 因此不可用，
// 应用按设计拒绝保存（不降级明文）。所以 Linux 不经 loader，直接启动 Electron 并通过 CDP 连接，
// 使用 CI 中真实解锁的 gnome-keyring（libsecret）。应用代码不含任何测试后门。
const launchViaCdp = async () => {
  const exe = executablePath ?? (await import('electron')).default
  const args = [
    join(root, 'out/main/index.js'), `--user-data-dir=${userData}`,
    '--remote-debugging-port=0', '--password-store=gnome-libsecret',
    ...(process.env.INKSTONE_E2E_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])
  ]
  const child = spawn(exe, args, { cwd: root, env: { ...process.env, NODE_ENV: 'production', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }, stdio: ['ignore', 'inherit', 'pipe'] })
  const exited = new Promise((done) => child.once('exit', done))
  const wsEndpoint = await new Promise((done, fail) => {
    let buffer = ''
    const timer = setTimeout(() => fail(new Error('Electron 未输出 DevTools 地址')), 30_000)
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk)
      buffer += chunk
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/)
      if (match) { clearTimeout(timer); done(match[1]) }
    })
    child.once('exit', (code) => { clearTimeout(timer); fail(new Error(`Electron 提前退出：${code}`)) })
  })
  const browser = await chromium.connectOverCDP(wsEndpoint)
  const context = browser.contexts()[0]
  const page = context.pages().find((item) => !item.url().startsWith('devtools://')) ?? await context.waitForEvent('page')
  const app = {
    waitForEvent: async (name) => { assert.equal(name, 'close'); await exited },
    close: async () => { await browser.close().catch(() => {}); if (child.exitCode === null) child.kill(); await exited }
  }
  return { app, page }
}

const launch = async () => {
  if (process.platform === 'linux') {
    const { app, page } = await launchViaCdp()
    return finishLaunch(app, page)
  }
  const app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [join(root, 'out/main/index.js'), `--user-data-dir=${userData}`],
    cwd: root,
    env: { ...process.env, NODE_ENV: 'production', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
  })
  return finishLaunch(app, await app.firstWindow())
}

const finishLaunch = async (app, page) => {
  page.setDefaultTimeout(10_000)
  page.on('pageerror', (error) => process.stderr.write(`renderer error: ${error.stack ?? error.message}\n`))
  page.on('console', (message) => { if (message.type() === 'error') process.stderr.write(`renderer console: ${message.text()}\n`) })
  await page.waitForLoadState('domcontentloaded')
  process.stdout.write(`launched: ${await page.title()} ${page.url()}\n`)
  return { app, page }
}

const waitSaved = async (page) => {
  await page.getByText('已保存', { exact: true }).waitFor({ timeout: 10_000 })
}
const openChapter = (page, title) => page.locator('.chapter-row', { hasText: title }).locator('.chapter-open').click()

let running
try {
  running = await launch()
  await record('首次启动并创建作品', async () => {
    await running.page.getByRole('button', { name: '新建作品' }).first().click()
    await running.page.getByLabel('作品名称').fill('E2E 长篇')
    await running.page.getByRole('button', { name: '创建并开始写作' }).click()
    await running.page.locator('.manuscript-editor').waitFor()
  })

  await record('最后一次输入关闭后重启仍存在', async () => {
    await running.page.locator('.manuscript-editor').fill('同字原文。最后一次输入会保存。')
    await waitSaved(running.page)
    const closed = running.app.waitForEvent('close')
    await running.page.getByRole('button', { name: '关闭', exact: true }).click()
    await closed
    running = await launch()
    await running.page.getByRole('button', { name: '继续写作' }).click()
    await running.page.locator('.manuscript-editor').waitFor()
    assert.match(await running.page.locator('.manuscript-editor').innerText(), /最后一次输入会保存/)
  })

  const ids = await running.page.evaluate(async ({ baseUrl }) => {
    const [project] = await window.workspace.projects.list()
    const tree = await window.workspace.documents.tree(project.id)
    const volume = tree.find((item) => item.type === 'volume')
    const chapterA = tree.find((item) => item.type === 'chapter')
    if (!volume || !chapterA) throw new Error('默认卷章不存在')
    const chapterB = await window.workspace.documents.create({ projectId: project.id, parentId: volume.id, type: 'chapter', title: '第二章' })
    await window.workspace.documents.save({ projectId: project.id, documentId: chapterB.id,
      editorJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '同字原文。最后一次输入会保存。' }] }] },
      plainText: '同字原文。最后一次输入会保存。', expectedRevision: 0 })
    const providerId = crypto.randomUUID()
    await window.workspace.providers.save({ id: providerId, providerType: 'openai-compatible', displayName: 'E2E Fixture', baseUrl, apiKey: 'fixture-key' })
    await window.workspace.providers.saveModel({ id: crypto.randomUUID(), providerId, modelId: 'fixture-model', displayName: 'Fixture',
      capabilities: { streaming: true, tools: false, structuredOutput: false, cancellation: true, maxContextTokens: 8_000 }, enabled: true, isDefault: true })
    return { projectId: project.id, chapterA: chapterA.id, chapterB: chapterB.id }
  }, { baseUrl })
  await running.page.reload()
  await running.page.getByRole('button', { name: '继续写作' }).click()
  await running.page.locator('.manuscript-editor').waitFor()

  await record('U03 同字跨章编辑提案仍绑定来源章', async () => {
    await running.page.locator('.manuscript-editor').press('Control+A')
    await running.page.getByRole('button', { name: '修改', exact: true }).click()
    const input = running.page.getByPlaceholder('和同行者聊聊这部作品…')
    await input.fill('请修改选中的文字')
    await running.page.getByRole('button', { name: '发送' }).click()
    await openChapter(running.page, '第二章')
    await running.page.getByText('跨章改写', { exact: true }).waitFor({ timeout: 15_000 })
    await running.page.waitForTimeout(100)
    const counts = await running.page.evaluate(async ({ projectId, chapterA, chapterB }) => ({
      a: (await window.workspace.patches.list(projectId, chapterA)).length,
      b: (await window.workspace.patches.list(projectId, chapterB)).length
    }), ids)
    assert.equal(counts.a, 1)
    assert.equal(counts.b, 0)
    await running.page.locator('.patch-drawer').getByRole('button', { name: '关闭' }).click()
  })

  await record('U04 跨章续写候选不能插入当前章', async () => {
    await openChapter(running.page, '第一章')
    await running.page.getByRole('button', { name: '续写', exact: true }).click()
    await running.page.getByPlaceholder('和同行者聊聊这部作品…').fill('请续写一段候选')
    await running.page.getByRole('button', { name: '发送' }).click()
    await openChapter(running.page, '第二章')
    await running.page.getByText('续写候选', { exact: true }).waitFor({ timeout: 15_000 })
    await running.page.getByRole('button', { name: '插入候选' }).last().click()
    await running.page.getByText(/插入失败：请先打开候选所属章节/).waitFor()
    const before = await running.page.evaluate(({ projectId, chapterB }) => window.workspace.documents.get(projectId, chapterB), ids)
    assert.equal(before.plainText, '同字原文。最后一次输入会保存。')
    await running.page.getByRole('button', { name: '打开来源章节' }).last().click()
    await running.page.getByRole('button', { name: '插入候选' }).last().click()
    await running.page.getByText('已插入正文', { exact: true }).waitFor()
    const after = await running.page.evaluate(({ projectId, chapterA }) => window.workspace.documents.get(projectId, chapterA), ids)
    assert.match(after.plainText, /续写候选/)
  })

  await record('U01 编辑后旧本地校对结果立即失效', async () => {
    const editor = running.page.locator('.manuscript-editor')
    await editor.fill('他说。。')
    await waitSaved(running.page)
    await running.page.getByRole('button', { name: /校对 1/ }).click()
    await running.page.getByText('重复标点', { exact: true }).waitFor()
    await editor.press('Control+Home')
    await editor.type('后来，')
    await running.page.getByText('本地规则 0', { exact: true }).waitFor()
  })

  await record('辅助页草稿在正常导航时自动持久化', async () => {
    await running.page.getByRole('button', { name: '故事', exact: true }).click()
    await running.page.getByPlaceholder('标题').fill('未点保存的草稿')
    await running.page.getByPlaceholder('从一段自由笔记开始……').fill('切换页面前应自动保存。')
    await running.page.getByRole('button', { name: '人物', exact: true }).click()
    await running.page.getByRole('button', { name: '故事', exact: true }).click()
    await running.page.getByRole('button', { name: /未点保存的草稿/ }).waitFor()
  })

  await record('历史快照可通过 UI 恢复', async () => {
    await running.page.getByRole('button', { name: '正文', exact: true }).click()
    const editor = running.page.locator('.manuscript-editor')
    await editor.fill('快照版本一')
    await waitSaved(running.page)
    await running.page.evaluate(({ projectId, chapterA }) => window.workspace.snapshots.create(projectId, chapterA, 'manual'), ids)
    await editor.fill('快照版本二')
    await waitSaved(running.page)
    await running.page.getByRole('button', { name: '历史', exact: true }).click()
    await running.page.getByRole('button', { name: '恢复此版本' }).first().click()
    await running.page.getByRole('button', { name: '确认' }).click()
    await running.page.getByRole('button', { name: '正文', exact: true }).click()
    await running.page.locator('.manuscript-editor').waitFor()
    assert.equal((await running.page.locator('.manuscript-editor').innerText()).trim(), '快照版本一')
  })

  await record('摘要请求中正文变化不会写成 fresh', async () => {
    streamDelay = 2_000
    const editor = running.page.locator('.manuscript-editor')
    await running.page.getByRole('button', { name: '理解本章' }).click()
    await running.page.getByRole('button', { name: '理解中…' }).waitFor()
    await editor.fill('摘要请求发出后发生修改')
    await openChapter(running.page, '第二章')
    await running.page.getByText(/章节理解失败：/).waitFor({ timeout: 15_000 })
    const status = await running.page.evaluate(({ projectId, chapterA }) => window.workspace.digests.status(projectId, chapterA), ids)
    assert.notEqual(status.state, 'fresh')
    streamDelay = 450
  })

  await record('Provider 意外 EOF 在 UI 与持久层标为错误', async () => {
    await running.page.getByRole('button', { name: '续写', exact: true }).click()
    await running.page.getByPlaceholder('和同行者聊聊这部作品…').fill('EOF 测试')
    await running.page.getByRole('button', { name: '发送' }).click()
    await running.page.getByText(/模型流在完成标记前中断/).waitFor({ timeout: 15_000 })
    const state = await running.page.evaluate(async (projectId) => {
      const [thread] = await window.workspace.chat.listThreads(projectId)
      const messages = await window.workspace.chat.listMessages(projectId, thread.id, undefined, 50)
      return messages.at(-1)?.status
    }, ids.projectId)
    assert.equal(state, 'error')
  })

  await record('Provider 长请求可取消且不会标为完成', async () => {
    streamDelay = 2_000
    await running.page.getByPlaceholder('和同行者聊聊这部作品…').fill('请续写取消测试')
    await running.page.getByRole('button', { name: '发送' }).click()
    await running.page.getByTitle('取消请求').click()
    await running.page.getByText(/请求已取消/).waitFor({ timeout: 10_000 })
    const state = await running.page.evaluate(async (projectId) => {
      const [thread] = await window.workspace.chat.listThreads(projectId)
      const messages = await window.workspace.chat.listMessages(projectId, thread.id, undefined, 50)
      return messages.at(-1)?.status
    }, ids.projectId)
    assert.equal(state, 'cancelled')
  })

  process.stdout.write(`Electron E2E: ${results.length} passed\n`)
} finally {
  if (running?.app) await running.app.close().catch(() => {})
  fixture.close()
  await rm(userData, { recursive: true, force: true })
}
