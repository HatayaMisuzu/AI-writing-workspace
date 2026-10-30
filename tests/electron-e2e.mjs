import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { _electron as electron, chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const bundledElectron = join(root, 'node_modules/electron/dist/electron.exe')
const executablePath = existsSync(bundledElectron) ? bundledElectron : process.env.INKSTONE_ELECTRON_EXECUTABLE
const userData = await mkdtemp(join(tmpdir(), 'inkstone-e2e-'))
const results = []
let streamDelay = 450

let fixtureHits = 0
const fixture = createServer(async (request, response) => {
  fixtureHits += 1
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

// P1-7：本地假 Anthropic Messages 服务器（只在 127.0.0.1）；记录请求头/体供断言。
const anthropicRequests = []
const anthropicFixture = createServer(async (request, response) => {
  let raw = ''
  for await (const chunk of request) raw += chunk
  const body = JSON.parse(raw || '{}')
  anthropicRequests.push({ url: request.url, headers: request.headers, body })
  if (!body.stream) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 1, output_tokens: 1 } }))
    return
  }
  const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.write(event('message_start', { message: { usage: { input_tokens: 10, output_tokens: 1 } } }))
  response.write(event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Anthropic' } }))
  response.write(event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: ' 候选' } }))
  response.write(event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }))
  response.end(event('message_stop', {}))
})
anthropicFixture.listen(0, '127.0.0.1')
await once(anthropicFixture, 'listening')
const anthropicBaseUrl = `http://127.0.0.1:${anthropicFixture.address().port}/v1`

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
    close: async () => { await browser.close().catch(() => {}); if (child.exitCode === null) child.kill(); await exited },
    kill: async () => { if (child.exitCode === null) child.kill('SIGKILL'); await exited; await browser.close().catch(() => {}) }
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

// F15：模拟强杀进程（不走关闭流程）
const killApp = async (running) => {
  if (running.app.kill) return running.app.kill()
  const closed = running.app.waitForEvent('close').catch(() => {})
  const pid = running.app.process().pid
  // Windows：只杀主进程会留下 GPU/渲染子进程占用 userData，强杀整棵进程树（仍不经关闭流程）
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  else running.app.process().kill('SIGKILL')
  await closed
  await new Promise((done) => setTimeout(done, 1500))
}
// F15：renderer 侧请求计数（本地 file/data/blob/devtools 资源除外）
const rendererRequests = []
const watchRendererRequests = (page) => page.on('request', (request) => {
  const url = request.url()
  if (!/^(file|data|blob|devtools|chrome-extension):/.test(url)) rendererRequests.push(url)
})
const waitSaved = async (page) => {
  await page.getByText('已保存', { exact: true }).waitFor({ timeout: 10_000 })
}
// L2：点抽屉里第一条词表替换的「应用」→ 本地规则总数变成 expectCount 且再过两帧，页面内计时
const timeApplyFirst = (page, expectCount) => page.evaluate(async (expectCount) => {
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()))
  const count = () => document.querySelector('[data-testid="local-lint"] h3 > span')?.textContent
  const button = [...document.querySelectorAll('.lint-group[data-group="wordlist_replace"] .proofread-issue button')].find((item) => item.textContent === '应用')
  if (!button) throw new Error('apply button not found')
  const started = performance.now()
  button.click()
  while (count() !== expectCount) { if (performance.now() - started > 60_000) throw new Error(`apply timeout, count=${count()}`); await frame() }
  await frame(); await frame()
  return performance.now() - started
}, expectCount)
// 诊断：围绕一段操作抓渲染进程 CPU profile，把自身耗时 top 函数和调用栈打印到 CI 日志
const cpuProfile = async (page, label, run) => {
  let session
  try { session = await page.context().newCDPSession(page); await session.send('Profiler.enable'); await session.send('Profiler.setSamplingInterval', { interval: 500 }); await session.send('Profiler.start') } catch (error) { process.stdout.write(`P3 cpu-profile ${label}: unavailable (${error.message})\n`); return run() }
  try { return await run() } finally {
    const { profile } = await session.send('Profiler.stop')
    const byId = new Map(profile.nodes.map((node) => [node.id, node]))
    const parent = new Map(); for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)
    const self = new Map(); profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000))
    const name = (node) => { const f = node.callFrame; return `${f.functionName || '(anon)'} ${(f.url || '').split('/').pop()}:${f.lineNumber + 1}` }
    const total = [...self.values()].reduce((a, b) => a + b, 0)
    const byFn = new Map(); for (const [id, ms] of self) { const key = name(byId.get(id)); byFn.set(key, (byFn.get(key) ?? 0) + ms) }
    const top = [...byFn].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([fn, ms]) => `${ms.toFixed(0)}ms ${fn}`)
    const stacks = [...self].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, ms]) => { const chain = []; let cur = id; while (cur !== undefined && chain.length < 14) { chain.push(name(byId.get(cur))); cur = parent.get(cur) } return `${ms.toFixed(0)}ms ${chain.join(' < ')}` })
    process.stdout.write(`P3 cpu-profile ${label}: total ${total.toFixed(0)}ms\n  top self: ${top.join(' | ')}\n  stacks:\n    ${stacks.join('\n    ')}\n`)
    await session.detach().catch(() => undefined)
  }
}
// 对照：不开查找面板，普通编辑（全选输入一个字替换整段）后 Ctrl+Z，测「撤销键 → 保存请求发出」
const undoSaveControl = async (page, label, restoredText) => {
  await page.locator('.manuscript-editor').click()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('换')
  await waitSaved(page)
  await page.evaluate(() => {
    const t0 = performance.now(); const trace = [{ t: 0, event: 'undo-key' }]
    const stateOf = () => { const el = document.querySelector('.save-indicator'); return el ? `${[...el.classList].filter((c) => c !== 'save-indicator').join('.')}:${el.textContent}` : 'missing' }
    let last = stateOf(); trace.push({ t: 0, event: `state ${last}` })
    const observer = new MutationObserver(() => { const now = stateOf(); if (now !== last) { last = now; trace.push({ t: Math.round(performance.now() - t0), event: `state ${now}` }) } })
    observer.observe(document.querySelector('.editor-toolbar'), { subtree: true, attributes: true, childList: true, characterData: true })
    const longTasks = new PerformanceObserver((list) => { for (const e of list.getEntries()) trace.push({ t: Math.round(e.startTime - t0), event: `longtask ${Math.round(e.duration)}ms` }) })
    try { longTasks.observe({ type: 'longtask' }) } catch { trace.push({ t: 0, event: 'longtask-unsupported' }) }
    window.__p3SaveTrace = { t0, trace, observer, longTasks }
  })
  await cpuProfile(page, `undo-control ${label}`, async () => {
    await page.keyboard.press('Control+z')
    await page.waitForFunction((text) => document.querySelector('.manuscript-editor').textContent.includes(text), restoredText, { timeout: 30_000 })
    await page.evaluate(() => { const d = window.__p3SaveTrace; d.trace.push({ t: Math.round(performance.now() - d.t0), event: 'undo-done' }) })
    await page.waitForFunction(() => window.__p3SaveTrace.trace.some((item) => item.event.startsWith('state saving')), undefined, { timeout: 30_000 })
    await waitSaved(page)
  })
  const trace = await page.evaluate(() => { const d = window.__p3SaveTrace; d.observer.disconnect(); d.longTasks.disconnect(); d.trace.sort((x, y) => x.t - y.t); return d.trace })
  const sentMs = trace.find((item) => item.event.startsWith('state saving'))?.t
  process.stdout.write(`P3 undo-save-control ${label}: undo-key→save-sent ${sentMs}ms; trace ${JSON.stringify(trace)}\n`)
  return sentMs
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
    assert.match(await running.page.locator('.manuscript-editor').textContent(), /最后一次输入会保存/)
  })

  // S2 / §6 ②：未配置 Provider 时完整写作旅程 — 拦截日志被拒=0，fixture 收 0 请求
  await record('S2 未配置 Provider 时无出网', async () => {
    const editor = running.page.locator('.manuscript-editor')
    await editor.fill('同字原文。最后一次输入会保存。离线旅程补一段。')
    await waitSaved(running.page)
    await running.page.getByRole('button', { name: '故事', exact: true }).click()
    await running.page.getByPlaceholder('标题').fill('离线笔记')
    await running.page.getByPlaceholder('从一段自由笔记开始……').fill('未配置模型也应可写。')
    await running.page.getByRole('button', { name: '正文', exact: true }).click()
    await running.page.locator('.manuscript-editor').waitFor()
    const blocked = await running.page.evaluate(() => window.workspace.network.blockedLog())
    assert.equal(blocked.length, 0, `未配置 Provider 时不应有被拒出网：${JSON.stringify(blocked)}`)
    assert.equal(fixtureHits, 0, '未配置 Provider 时网络 fixture 应收到 0 个请求')
  })


  // S4：建细纲后侧栏（大纲视图 + 编辑器侧栏）可见
  await record('S4 建细纲后侧栏可见', async () => {
    await running.page.evaluate(async () => {
      const [project] = await window.workspace.projects.list()
      const tree = await window.workspace.documents.tree(project.id)
      const chapter = tree.find((item) => item.type === 'chapter')
      if (!chapter) throw new Error('无章节')
      await window.workspace.outlines.save({ projectId: project.id, nodeId: chapter.id, summary: 'S4侧栏细纲验收', beats: ['要点甲'], hook: '钩子乙' })
    })
    await running.page.getByRole('button', { name: '大纲', exact: true }).click()
    await running.page.getByText('S4侧栏细纲验收', { exact: false }).waitFor({ timeout: 10_000 })
    await running.page.getByRole('button', { name: '正文', exact: true }).click()
    await running.page.locator('.manuscript-editor').waitFor()
    await running.page.locator('.chapter-outline-aside').getByText('S4侧栏细纲验收').waitFor({ timeout: 10_000 })
    await running.page.locator('.chapter-outline-aside').getByText('要点甲').waitFor()
  })

  await record('S4 全书大纲可看改保存', async () => {
    await running.page.getByRole('button', { name: '大纲', exact: true }).click()
    const slot = running.page.locator('.book-outline-slot')
    await slot.getByRole('heading', { name: '全书大纲' }).waitFor({ timeout: 10_000 })
    await slot.getByPlaceholder('标题').fill('全书核心大纲验收')
    await slot.getByPlaceholder('从一段自由笔记开始……').fill('主角从小镇出发，核心冲突已定')
    await slot.getByRole('button', { name: '保存', exact: true }).click()
    await slot.getByText('全书核心大纲验收', { exact: true }).waitFor({ timeout: 10_000 })
    // 离开再进入，证明落库可回读
    await running.page.getByRole('button', { name: '正文', exact: true }).click()
    await running.page.locator('.manuscript-editor').waitFor()
    await running.page.getByRole('button', { name: '大纲', exact: true }).click()
    const slot2 = running.page.locator('.book-outline-slot')
    await slot2.getByText('全书核心大纲验收', { exact: true }).waitFor({ timeout: 10_000 })
    await slot2.getByRole('button', { name: /全书核心大纲验收/ }).click()
    const body = await slot2.locator('textarea').inputValue()
    if (!body.includes('核心冲突已定')) throw new Error('全书大纲正文未回填: ' + body)
    const persisted = await running.page.evaluate(async () => {
      const [project] = await window.workspace.projects.list()
      const notes = await window.workspace.notes.list(project.id, 'outline')
      return notes.some((n) => n.title === '全书核心大纲验收' && n.content.includes('核心冲突已定') && n.section === 'outline')
    })
    if (!persisted) throw new Error('notes.list(outline) 未回读到刚保存的全书大纲')
  })


  // S10：日更面板 — 未设目标只显示统计；开启正整数目标后进度出现，关闭后消失
  await record('S10 日更面板未设目标无进度、开启后进度正确', async () => {
    await running.page.getByRole('button', { name: '正文', exact: true }).click()
    const editor = running.page.locator('.manuscript-editor')
    await editor.waitFor()
    // 追加一段确定字数，保证今日码字 > 0（净值随旅程累加，以 IPC 为准）
    const body = `${(await editor.innerText()).trim()}\n${'日'.repeat(40)}`
    await editor.fill(body)
    await waitSaved(running.page)

    const day = await running.page.evaluate(async () => {
      const [project] = await window.workspace.projects.list()
      const goals = await window.workspace.writing.getGoals(project.id)
      const today = await window.workspace.writing.getDay(project.id)
      return { projectId: project.id, goals, today }
    })
    assert.equal(day.goals.dailyWordGoalEnabled, false)
    assert.equal(day.goals.dailyWordGoal, null)
    assert.ok(day.today.humanWordsNetDisplay > 0, `写字后今日码字应 > 0，实际 ${day.today.humanWordsNetDisplay}`)

    await running.page.getByRole('button', { name: '日更', exact: true }).click()
    const panel = running.page.locator('.daily-stats-view')
    await panel.waitFor({ timeout: 10_000 })
    // 面板 load 是异步的，等到码字卡片出现后刷新一次确保对齐
    await panel.getByTestId('daily-human-words').waitFor()
    await panel.getByRole('button', { name: '刷新' }).click()
    await panel.getByTestId('daily-ai-words').waitFor()
    await panel.getByText('今日码字', { exact: false }).waitFor()
    await panel.getByText('采纳 AI 字数', { exact: false }).waitFor()
    await panel.getByTestId('daily-calendar').waitFor()

    // ⑦ 未启用：无进度条、无「/ 目标」、无达成提示
    assert.equal(await panel.locator('.daily-word-progress').count(), 0, '未设目标不应渲染进度条')
    assert.equal(await panel.locator('[data-testid="daily-goal-suffix"]').count(), 0, '未设目标不应出现 / 目标')
    assert.equal(await panel.getByText('已达成').count(), 0)
    assert.equal(await panel.getByText('未达成').count(), 0)

    const humanLabel = String(day.today.humanWordsNetDisplay)
    const humanBefore = (await panel.getByTestId('daily-human-words').innerText()).replace(/\s+/g, ' ')
    assert.ok(humanBefore.includes(humanLabel), `面板码字应显示 ${humanLabel}，实际：${humanBefore}`)

    // ⑧ 目标设为 2× 今日码字 → 进度 50%
    const goal = day.today.humanWordsNetDisplay * 2
    await panel.getByLabel('启用字数目标').check()
    await panel.getByLabel('日更字数目标').fill(String(goal))
    await panel.getByRole('button', { name: '保存目标' }).click()
    await panel.locator('.daily-word-progress').waitFor({ timeout: 10_000 })
    await panel.getByTestId('daily-goal-suffix').getByText(`/ 目标 ${goal}`).waitFor()
    const pct = await panel.locator('.daily-word-progress').getAttribute('aria-valuenow')
    assert.equal(pct, '50', `${day.today.humanWordsNetDisplay}/${goal} 进度应为 50%，实际 ${pct}`)

    // 关闭后进度消失，统计数值仍在
    await panel.getByLabel('启用字数目标').uncheck()
    await panel.getByRole('button', { name: '保存目标' }).click()
    await panel.locator('.daily-word-progress').waitFor({ state: 'detached', timeout: 10_000 })
    assert.equal(await panel.locator('[data-testid="daily-goal-suffix"]').count(), 0)
    const humanAfter = (await panel.getByTestId('daily-human-words').innerText()).replace(/\s+/g, ' ')
    assert.ok(humanAfter.includes(humanLabel), `关闭目标后码字应不变（${humanLabel}），实际：${humanAfter}`)
    assert.equal(await panel.getByText('已达成').count(), 0)
    assert.equal(await panel.getByText('未达成').count(), 0)
  })

  const fixtureHitsBeforeProvider = fixtureHits
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

  // S2 / §6 ③：配置本地 fixture Provider 后，只有该 origin 收到请求（AI 走已保存 origin；非白名单由单测覆盖）
  await record('S2 仅 fixture origin 收到请求', async () => {
    assert.ok(fixtureHits > fixtureHitsBeforeProvider, `配置 Provider 后 fixture 应收到请求，实际 hits=${fixtureHits}`)
  })

  // S8：续写候选须「采用为补丁」才 propose；未接受前正文不变；补丁只绑来源章
  await record('U04 跨章续写候选采用为补丁只写来源章', async () => {
    await openChapter(running.page, '第一章')
    await running.page.getByRole('button', { name: '续写', exact: true }).click()
    await running.page.getByPlaceholder('和同行者聊聊这部作品…').fill('请续写一段候选')
    await running.page.getByRole('button', { name: '发送' }).click()
    await openChapter(running.page, '第二章')
    await running.page.getByText('续写候选', { exact: true }).waitFor({ timeout: 15_000 })
    await running.page.getByRole('button', { name: '采用为补丁' }).last().click()
    await running.page.getByText('已提出补丁', { exact: true }).waitFor()
    const mid = await running.page.evaluate(async ({ projectId, chapterA, chapterB }) => {
      const patchesA = await window.workspace.patches.list(projectId, chapterA)
      const patchesB = await window.workspace.patches.list(projectId, chapterB)
      return {
        generationProposed: patchesA.filter((patch) => patch.status === 'proposed' && patch.replacement.includes('续写候选')).length,
        bProposed: patchesB.filter((patch) => patch.status === 'proposed').length,
        bodyA: (await window.workspace.documents.get(projectId, chapterA)).plainText,
        bodyB: (await window.workspace.documents.get(projectId, chapterB)).plainText
      }
    }, ids)
    assert.equal(mid.generationProposed, 1, '来源章应有 1 条续写 proposed 补丁')
    assert.equal(mid.bProposed, 0, '当前章不应有补丁')
    assert.equal(mid.bodyB, '同字原文。最后一次输入会保存。')
    assert.ok(!mid.bodyA.includes('续写候选'), '接受前来源章正文不应写入候选')
    // createPatch 会打开提案抽屉，挡住「打开来源章节」；先关再回来源章
    const drawer = running.page.locator('.patch-drawer')
    if (await drawer.count()) await drawer.getByRole('button', { name: '关闭' }).click()
    await openChapter(running.page, '第一章')
    await running.page.getByRole('button', { name: '修改提案' }).click()
    const genCard = running.page.locator('.patch-drawer article').filter({ hasText: '续写候选' })
    await genCard.getByRole('button', { name: '接受并应用' }).click()
    await genCard.getByText('已接受', { exact: true }).waitFor({ timeout: 10_000 })
    const after = await running.page.evaluate(({ projectId, chapterA }) => window.workspace.documents.get(projectId, chapterA), ids)
    assert.match(after.plainText, /续写候选/)
    await running.page.locator('.patch-drawer').getByRole('button', { name: '关闭' }).click()
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
    await running.page.locator('.manuscript-editor', { hasText: '快照版本一' }).waitFor({ timeout: 5_000 }).catch(() => {})
    assert.equal((await running.page.locator('.manuscript-editor').textContent()).trim(), '快照版本一')
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

  await record('P1-7 Anthropic 协议：测试连接 + 续写走 /messages（system 单独、max_tokens、头）', async () => {
    streamDelay = 0
    const tested = await running.page.evaluate(async ({ anthropicBaseUrl }) => {
      const providerId = crypto.randomUUID()
      const unsaved = await window.workspace.providers.testUrl({ baseUrl: anthropicBaseUrl, apiKey: 'anthropic-fixture-key', modelId: 'claude-fixture', providerType: 'anthropic' })
      await window.workspace.providers.save({ id: providerId, providerType: 'anthropic', displayName: 'E2E Anthropic', baseUrl: anthropicBaseUrl, apiKey: 'anthropic-fixture-key' })
      await window.workspace.providers.saveModel({ id: crypto.randomUUID(), providerId, modelId: 'claude-fixture', displayName: 'Claude Fixture',
        capabilities: { streaming: true, tools: false, structuredOutput: false, cancellation: true, maxContextTokens: 8_000 }, enabled: true, isDefault: true, contextWindow: 8_000, maxOutput: 1_500 })
      const saved = await window.workspace.providers.test(providerId, 'claude-fixture')
      return { unsaved, saved }
    }, { anthropicBaseUrl })
    assert.deepEqual(tested, { unsaved: { ok: true }, saved: { ok: true } })
    await running.page.getByPlaceholder('和同行者聊聊这部作品…').fill('请续写 Anthropic 一句')
    await running.page.getByRole('button', { name: '发送' }).click()
    await running.page.getByText('Anthropic 候选', { exact: true }).first().waitFor({ timeout: 15_000 })
    const streamed = anthropicRequests.find((item) => item.body.stream === true)
    assert.ok(streamed, '应收到 Anthropic 流式请求')
    assert.equal(streamed.url, '/v1/messages')
    assert.equal(streamed.headers['x-api-key'], 'anthropic-fixture-key')
    assert.equal(streamed.headers['anthropic-version'], '2023-06-01')
    assert.equal(streamed.body.max_tokens, 1_500)
    assert.equal(typeof streamed.body.system, 'string')
    assert.ok(streamed.body.messages.every((message) => message.role !== 'system'))
  })

  // 窄屏（≤1080px）：同行者默认收起，抽屉覆盖在编辑区上方；上下文清单 / 钉住在抽屉里可用；编辑区宽度不变
  await record('窄屏 900/1024：同行者抽屉可开关、清单可钉住、编辑区宽度不变', async () => {
    const page = running.page
    const editor = page.locator('.manuscript-editor')
    const original = page.viewportSize()
    await page.setViewportSize({ width: 1400, height: 860 })
    await editor.click(); await page.keyboard.press('End'); await page.keyboard.type('窄屏甲登场。')
    await waitSaved(page)
    await page.evaluate(async () => {
      const [project] = await window.workspace.projects.list()
      await window.workspace.characters.save({ projectId: project.id, name: '窄屏甲', notes: '窄屏抽屉验收人物' })
    })
    const shotDir = process.env.INKSTONE_E2E_SHOT_DIR
    for (const width of [900, 1024]) {
      await page.setViewportSize({ width, height: 800 })
      const openButton = page.getByRole('button', { name: '打开同行者' })
      await openButton.waitFor()
      assert.equal(await page.locator('.assistant-panel').count(), 0, `${width}px：面板默认收起`)
      assert.equal(await openButton.getAttribute('aria-expanded'), 'false')
      const before = (await editor.boundingBox()).width
      // 编辑区宽度以「抽屉收起时」为准（本章细纲侧栏在窄屏下本就占宽，非本 PR 范围，见 PR 正文遗留问题）
      assert.ok(before > 0, `${width}px：编辑区可见（${before}）`)
      if (width === 900) { await openButton.focus(); await page.keyboard.press('Enter') } else await openButton.click()
      const drawer = page.getByRole('dialog', { name: '同行者' })
      await drawer.waitFor()
      assert.equal(await openButton.getAttribute('aria-expanded'), 'true')
      assert.equal((await editor.boundingBox()).width, before, `${width}px：抽屉打开时编辑区宽度不变`)
      const contextButton = drawer.getByRole('button', { name: /^上下文/ })
      if (!(await drawer.locator('.context-sources').isVisible())) await contextButton.click()
      const row = drawer.locator('.context-sources li', { hasText: '人物 · 窄屏甲' })
      await row.waitFor({ timeout: 10_000 })
      const labelBefore = await contextButton.innerText()
      await row.getByRole('button', { name: '钉住', exact: true }).click()
      await page.waitForFunction((prev) => [...document.querySelectorAll('.assistant-drawer button')].some((b) => /^上下文/.test(b.textContent ?? '') && b.textContent !== prev && /钉住 1/.test(b.textContent ?? '')), labelBefore)
      assert.match(await contextButton.innerText(), /钉住 1/)
      if (shotDir) await page.screenshot({ path: join(shotDir, `narrow-${width}.png`) })
      // 焦点陷阱：连续 Tab / Shift+Tab 焦点始终在抽屉内
      const inDrawer = () => page.evaluate(() => Boolean(document.querySelector('.assistant-drawer')?.contains(document.activeElement)))
      const tabStops = await drawer.evaluate((node) => node.querySelectorAll('button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])').length)
      for (let i = 0; i < tabStops + 3; i += 1) { await page.keyboard.press('Tab'); assert.ok(await inDrawer(), `${width}px：Tab 第 ${i + 1} 次焦点仍在抽屉内`) }
      for (let i = 0; i < 5; i += 1) { await page.keyboard.press('Shift+Tab'); assert.ok(await inDrawer(), `${width}px：Shift+Tab 第 ${i + 1} 次焦点仍在抽屉内`) }
      // 在抽屉里排除一条上下文，「排除 N」计数变化，再恢复
      const firstCheckbox = drawer.locator('.context-sources li input[type="checkbox"]:not([disabled])').first()
      await firstCheckbox.uncheck()
      await page.waitForFunction(() => [...document.querySelectorAll('.assistant-drawer button')].some((b) => /^上下文（.*排除 1/.test(b.textContent ?? '')))
      await drawer.locator('.context-sources li input[type="checkbox"]:not(:checked):not([disabled])').first().check()
      await page.waitForFunction(() => [...document.querySelectorAll('.assistant-drawer button')].some((b) => /^上下文/.test(b.textContent ?? '') && !/排除/.test(b.textContent ?? '')))
      await drawer.locator('.context-sources li', { hasText: '人物 · 窄屏甲' }).getByRole('button', { name: '取消钉住' }).click()
      await page.waitForFunction(() => [...document.querySelectorAll('.assistant-drawer button')].some((b) => (b.textContent ?? '') === '上下文'))
      if (width === 900) await page.keyboard.press('Escape')
      else await page.getByTestId('assistant-backdrop').click({ position: { x: 20, y: 400 } })
      await drawer.waitFor({ state: 'detached' })
      assert.equal(await page.locator('.assistant-backdrop').count(), 0)
      assert.equal((await editor.boundingBox()).width, before, `${width}px：关闭后编辑区宽度正常`)
      await editor.click(); await page.keyboard.press('End'); await page.keyboard.type(`宽${width}`)
      assert.match(await editor.innerText(), new RegExp(`宽${width}`))
      // 关闭按钮也可关闭
      await openButton.click(); await drawer.waitFor()
      await drawer.getByRole('button', { name: '关闭同行者' }).click(); await drawer.waitFor({ state: 'detached' })
    }
    await waitSaved(page)
    await page.setViewportSize(original ?? { width: 1400, height: 860 })
    await page.locator('.assistant-panel').waitFor()
  })


  // ───── F15 小黑屋（e2e ⑦–⑪）。锁定期间统计：主进程实发（fixture 命中）、渲染进程请求、webRequest 拦截日志 ─────
  const typeAtEnd = async (page, text) => {
    const editor = page.locator('.manuscript-editor')
    await editor.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(text)
    await waitSaved(page)
  }
  const enterBlackroom = async (page, fill) => {
    await page.getByRole('button', { name: '小黑屋', exact: true }).click()
    const dialog = page.getByTestId('blackroom-entry')
    // 不预填：未选方式、无输入框
    assert.equal(await dialog.locator('input[type="radio"]:checked').count(), 0)
    assert.equal(await dialog.getByLabel('目标字数').count(), 0)
    await fill(dialog)
    await dialog.getByRole('button', { name: '锁定并开始' }).click()
    await page.getByTestId('blackroom-bar').waitFor()
  }
  const lockedNetwork = { fixture: 0, anthropic: 0, renderer: 0, blocked: 0 }
  const snapshotNetwork = async (page) => ({ fixture: fixtureHits, anthropic: anthropicRequests.length, renderer: rendererRequests.length, blocked: (await page.evaluate(() => window.workspace.network.blockedLog())).length })
  const addLockedDelta = async (page, before) => {
    const after = await snapshotNetwork(page)
    for (const key of Object.keys(lockedNetwork)) lockedNetwork[key] += after[key] - before[key]
  }
  await running.page.locator('.manuscript-editor').waitFor()
  watchRendererRequests(running.page)

  await record('F15 ⑦ 小黑屋隐藏项全部消失、Esc 不退出、AI IPC 返回 FOCUS_LOCKED', async () => {
    const page = running.page
    // 超限拒绝不修正
    await page.getByRole('button', { name: '小黑屋', exact: true }).click()
    const dialog = page.getByTestId('blackroom-entry')
    await dialog.getByLabel('写满字数').check()
    await dialog.getByLabel('目标字数').fill('50001')
    await dialog.getByRole('button', { name: '锁定并开始' }).click()
    await dialog.getByRole('alert').filter({ hasText: '1–50000' }).waitFor()
    await dialog.getByRole('button', { name: '取消' }).click()
    await enterBlackroom(page, async (d) => { await d.getByLabel('写满字数').check(); await d.getByLabel('目标字数').fill('8') })
    const before = await snapshotNetwork(page)
    for (const name of ['全文检索', '修改提案', '校对', '专注', '小黑屋', '退出专注']) assert.equal(await page.locator('button', { hasText: new RegExp(`^${name}`) }).count(), 0, `锁定期间不应出现「${name}」`)
    for (const selector of ['.assistant-panel', '.project-sidebar', '.works-rail', '.manuscript-aside-stack', '.proofread-drawer']) assert.equal(await page.locator(selector).count(), 0, `锁定期间不应渲染 ${selector}`)
    assert.match(await page.getByTestId('blackroom-words').innerText(), /已写 0 \/ 8 字/)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+Shift+F')
    assert.equal(await page.getByTestId('blackroom-bar').count(), 1, 'Esc 不应退出小黑屋')
    assert.equal(await page.getByRole('dialog').count(), 0, '锁定期间 Ctrl+Shift+F 不应打开检索')
    // Ctrl J 快速灵感仍可用（只记录）
    await page.keyboard.press('Control+j')
    await page.getByPlaceholder('记下一闪而过的想法…').waitFor()
    await page.getByRole('button', { name: '取消' }).click()
    const rejected = await page.evaluate(async ({ projectId, chapterId }) => {
      const out = {}
      const capture = async (name, fn) => { try { await fn(); out[name] = 'resolved' } catch (error) { out[name] = String(error?.message ?? error) } }
      const task = { mode: 'discussion', writePermission: 'none', userIntent: '锁定中试探', projectId, documentId: chapterId }
      await capture('preview', () => window.workspace.ai.previewContext({ threadId: crypto.randomUUID(), task }))
      await capture('digest', () => window.workspace.digests.run(projectId, chapterId))
      await capture('proofread', () => window.workspace.proofreading.run(projectId, chapterId))
      await capture('extract', () => window.workspace.memories.extractIntent(projectId, chapterId, '记住：锁定中试探'))
      const [provider] = await window.workspace.providers.list()
      const [model] = await window.workspace.providers.models()
      await capture('providerTest', () => window.workspace.providers.test(provider.id, model.modelId))
      await capture('providerTestUrl', () => window.workspace.providers.testUrl({ baseUrl: provider.baseUrl, apiKey: 'x', modelId: model.modelId }))
      out.start = await new Promise((done) => {
        const requestId = crypto.randomUUID()
        window.workspace.ai.start({ requestId, threadId: crypto.randomUUID(), userMessageId: crypto.randomUUID(), assistantMessageId: crypto.randomUUID(), task }, (event) => { if (event.type === 'error') done(`${event.code}:${event.message}`); if (event.type === 'done') done('done') })
      })
      return out
    }, { projectId: ids.projectId, chapterId: ids.chapterA })
    // 渲染进程拿不到 error.code（Electron 只传文案）：invoke 类断言带书名、无「FocusLockError:」前缀；ai:start 事件带 code
    const lockedTitle = await page.evaluate(async (projectId) => (await window.workspace.projects.list(true)).find((item) => item.id === projectId).title, ids.projectId)
    assert.match(rejected.start, /^FOCUS_LOCKED:/, `start 应返回 FOCUS_LOCKED，实际 ${rejected.start}`)
    for (const [name, message] of Object.entries(rejected)) {
      assert.ok(message.includes(`《${lockedTitle}》正在小黑屋中`), `${name} 报错应带书名，实际 ${message}`)
      assert.doesNotMatch(message, /FocusLockError/, `${name} 报错不应带 FocusLockError 前缀`)
    }
    await addLockedDelta(page, before)
  })

  await record('F15 ⑧ 写够 N 字并保存后「出屋」出现，点击才退出', async () => {
    const page = running.page
    const before = await snapshotNetwork(page)
    assert.equal(await page.getByTestId('blackroom-finish').count(), 0)
    await typeAtEnd(page, '小黑屋里写下')
    await page.waitForTimeout(1500)
    assert.equal(await page.getByTestId('blackroom-finish').count(), 0, '未达 8 字不应出现出屋')
    await typeAtEnd(page, '整整八个字了')
    await page.getByTestId('blackroom-finish').waitFor({ timeout: 5_000 })
    assert.match(await page.getByTestId('blackroom-words').innerText(), /已写 1[0-9] \/ 8 字/)
    await addLockedDelta(page, before)
    await page.getByTestId('blackroom-finish').click()
    await page.locator('.assistant-panel').waitFor()
    await page.locator('.works-rail').waitFor()
    assert.equal(await page.getByTestId('blackroom-bar').count(), 0)
    const last = await page.evaluate((projectId) => window.workspace.focus.lastSession(projectId), ids.projectId)
    assert.equal(last.endedBy, 'reached')
    assert.ok(last.netWords >= 8)
  })

  await record('F15 ⑨ 锁定中强杀进程重启后仍锁定，紧急出口输入「我要出屋」离开', async () => {
    let page = running.page
    await enterBlackroom(page, async (d) => { await d.getByLabel('写满字数').check(); await d.getByLabel('目标字数').fill('500') })
    let before = await snapshotNetwork(page)
    await typeAtEnd(page, '强杀前已保存')
    await addLockedDelta(page, before)
    await killApp(running)
    running = await launch()
    page = running.page
    watchRendererRequests(page)
    before = { fixture: fixtureHits, anthropic: anthropicRequests.length, renderer: rendererRequests.length, blocked: 0 }
    await page.getByRole('button', { name: '继续写作' }).click()
    await page.getByTestId('blackroom-bar').waitFor()
    assert.match(await page.getByTestId('blackroom-words').innerText(), /已写 [1-9]\d* \/ 500 字/)
    assert.equal(await page.locator('.assistant-panel').count(), 0)
    assert.equal(await page.locator('.works-rail').count(), 0)
    const persisted = await page.evaluate(async ({ projectId, chapterA, chapterB }) => (await Promise.all([chapterA, chapterB].map((id) => window.workspace.documents.get(projectId, id)))).map((doc) => doc.plainText).join('\n'), ids)
    assert.match(persisted, /强杀前已保存/, '强杀前已保存的正文应保留')
    await addLockedDelta(page, before)
    before = await snapshotNetwork(page)
    await page.getByRole('button', { name: '紧急出口' }).click()
    await page.getByLabel('紧急出屋确认').fill('我要出去')
    assert.equal(await page.getByRole('button', { name: '确认出屋' }).isDisabled(), true)
    await page.getByLabel('紧急出屋确认').fill('我要出屋')
    await addLockedDelta(page, before)
    await page.getByRole('button', { name: '确认出屋' }).click()
    await page.locator('.assistant-panel').waitFor()
    const last = await page.evaluate((projectId) => window.workspace.focus.lastSession(projectId), ids.projectId)
    assert.equal(last.endedBy, 'emergency')
  })

  await record('F15 ⑪ 1 分钟时间锁：时间走完「出屋」出现（剩余倒计时）', async () => {
    const page = running.page
    await enterBlackroom(page, async (d) => { await d.getByLabel('写满时间').check(); await d.getByLabel('分钟数').fill('1') })
    const before = await snapshotNetwork(page)
    assert.match(await page.getByTestId('blackroom-remaining').innerText(), /剩余 0[01]:\d\d/)
    assert.equal(await page.getByTestId('blackroom-finish').count(), 0)
    await page.getByTestId('blackroom-finish').waitFor({ timeout: 75_000 })
    assert.match(await page.getByTestId('blackroom-remaining').innerText(), /剩余 00:00/)
    await addLockedDelta(page, before)
    await page.getByTestId('blackroom-finish').click()
    await page.locator('.assistant-panel').waitFor()
  })

  await record('F15 × 窄屏 900px：抽屉开着时进入小黑屋 → 抽屉关闭、打开按钮不可见、网络 0', async () => {
    const page = running.page
    const original = page.viewportSize()
    await page.setViewportSize({ width: 900, height: 800 })
    const openButton = page.getByRole('button', { name: '打开同行者' })
    await openButton.click()
    const drawer = page.getByRole('dialog', { name: '同行者' })
    await drawer.waitFor()
    // 抽屉遮罩覆盖编辑区工具栏，鼠标点不到「小黑屋」；这里以 DOM click 事件触发同一按钮，验证「抽屉开着时上锁」这一状态组合
    await page.locator('.editor-toolbar button', { hasText: '小黑屋' }).dispatchEvent('click')
    const dialog = page.getByTestId('blackroom-entry')
    await dialog.getByLabel('写满字数').check()
    await dialog.getByLabel('目标字数').fill('1000')
    await dialog.getByRole('button', { name: '锁定并开始' }).click()
    await page.getByTestId('blackroom-bar').waitFor()
    const before = await snapshotNetwork(page)
    await drawer.waitFor({ state: 'detached' })
    assert.equal(await page.locator('.assistant-drawer').count(), 0, '锁定后抽屉应关闭')
    assert.equal(await page.locator('.assistant-backdrop').count(), 0, '锁定后遮罩应消失')
    assert.equal(await openButton.count(), 0, '锁定后「打开同行者」按钮不可见')
    assert.equal(await page.locator('.assistant-panel').count(), 0)
    await page.waitForTimeout(1500)
    assert.equal(await openButton.count(), 0)
    await page.getByRole('button', { name: '紧急出口' }).click()
    await page.getByLabel('紧急出屋确认').fill('我要出屋')
    await addLockedDelta(page, before)
    await page.getByRole('button', { name: '确认出屋' }).click()
    await page.getByTestId('blackroom-bar').waitFor({ state: 'detached' })
    await openButton.waitFor()
    assert.equal(await page.locator('.assistant-drawer').count(), 0, '出屋后抽屉保持关闭')
    await page.setViewportSize(original ?? { width: 1400, height: 860 })
    await page.locator('.assistant-panel').waitFor()
  })

  // ───── F14 人物悬停（e2e ⑨–⑫）。只读卡片、此别名不提示（重启保持）、小黑屋内悬停且网络 0、20 万字降级 ─────
  const f14 = await running.page.evaluate(async ({ projectId }) => {
    const tree = await window.workspace.documents.tree(projectId)
    const volume = tree.find((item) => item.type === 'volume')
    const para = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
    const hover = await window.workspace.documents.create({ projectId, parentId: volume.id, type: 'chapter', title: '悬停章' })
    await window.workspace.documents.save({ projectId, documentId: hover.id, editorJson: { type: 'doc', content: [para('林栀推门进来，阿栀笑了。'), para('顾言没有出场。')] },
      plainText: '林栀推门进来，阿栀笑了。\n\n顾言没有出场。', expectedRevision: 0 })
    // 20 万字以上：2100 段 × 96 字
    const lines = Array.from({ length: 2100 }, (_, i) => `第${String(i).padStart(4, "0")}段阿栀${'雾'.repeat(88)}`)
    const big = await window.workspace.documents.create({ projectId, parentId: volume.id, type: 'chapter', title: '长章' })
    await window.workspace.documents.save({ projectId, documentId: big.id, editorJson: { type: 'doc', content: lines.map(para) }, plainText: lines.join('\n\n'), expectedRevision: 0 })
    const character = await window.workspace.characters.save({ projectId, name: '林栀', aliases: ['阿栀', '栀'], notes: '雾港来的姑娘，'.repeat(30), fields: { identity: '药铺学徒', appearance: '青衣', personality: '倔强', goal: '找到父亲', currentState: '藏身码头' } })
    return { hover: hover.id, big: big.id, characterId: character.id }
  }, { projectId: ids.projectId })
  await running.page.reload()
  await running.page.getByRole('button', { name: '继续写作' }).click()
  await running.page.locator('.manuscript-editor').waitFor()
  const hitLocator = (page, text) => page.locator('.manuscript-editor .character-hit', { hasText: text })
  const docState = (page, documentId) => page.evaluate(async ({ projectId, documentId }) => { const doc = await window.workspace.documents.get(projectId, documentId); return { json: JSON.stringify(doc.editorJson), revision: doc.revision } }, { projectId: ids.projectId, documentId })

  await record('F14 ⑨ 悬停「林栀」弹出只读卡片；Esc 关闭；Ctrl+Shift+K 打开；editor_json 与 revision 不变', async () => {
    const page = running.page
    await openChapter(page, '悬停章')
    await hitLocator(page, '林栀').first().waitFor()
    assert.equal(await hitLocator(page, '顾言').count(), 0)
    // 单字别名「栀」默认不参与：全文只有「林栀」「阿栀」两处下划线
    assert.deepEqual(await page.locator('.manuscript-editor .character-hit').allInnerTexts(), ['林栀', '阿栀'])
    const before = await docState(page, f14.hover)
    await hitLocator(page, '林栀').first().hover()
    const card = page.getByTestId('character-hover-card')
    await card.waitFor({ timeout: 2_000 })
    const text = await card.innerText()
    assert.match(text, /林栀/)
    assert.match(text, /药铺学徒/)
    assert.ok(text.includes('找到父亲') && !text.includes('藏身码头'), '只显示前 4 个字段')
    assert.match(text, /…/, '笔记截断到 120 字')
    assert.equal(await card.getByRole('button', { name: '打开人物卡' }).count(), 1)
    assert.equal(await card.locator('input, textarea, [contenteditable="true"]').count(), 0, '卡片只读')
    await page.keyboard.press('Escape')
    await card.waitFor({ state: 'detached' })
    // 鼠标移出也关闭
    await hitLocator(page, '阿栀').hover(); await card.waitFor()
    assert.match(await card.innerText(), /匹配别名：阿栀/)
    await page.mouse.move(5, 5); await card.waitFor({ state: 'detached' })
    // Ctrl+Shift+K：光标在命中上时打开
    await hitLocator(page, '林栀').first().click()
    await page.keyboard.press('Control+Shift+K')
    await card.waitFor({ timeout: 2_000 })
    await page.keyboard.press('Escape')
    await card.waitFor({ state: 'detached' })
    await page.waitForTimeout(1_500)
    assert.equal(await page.getByText('已保存', { exact: true }).count(), 1)
    assert.deepEqual(await docState(page, f14.hover), before, '悬停/快捷键前后 editor_json 和 revision 不变')
  })

  await record('F14 ⑩ 「此别名不提示」后下划线消失，重启后仍不提示', async () => {
    let page = running.page
    await hitLocator(page, '林栀').first().hover()
    const card = page.getByTestId('character-hover-card')
    await card.waitFor()
    await card.getByRole('button', { name: '此别名不提示' }).click()
    await card.waitFor({ state: 'detached' })
    await page.waitForFunction(() => document.querySelectorAll('.manuscript-editor .character-hit').length === 1)
    assert.deepEqual(await page.locator('.manuscript-editor .character-hit').allInnerTexts(), ['阿栀'], '其他别名仍提示')
    const closed = running.app.waitForEvent('close')
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await closed
    running = await launch()
    page = running.page
    watchRendererRequests(page)
    await page.getByRole('button', { name: '继续写作' }).click()
    await page.locator('.manuscript-editor').waitFor()
    await openChapter(page, '悬停章')
    await hitLocator(page, '阿栀').waitFor()
    assert.equal(await hitLocator(page, '林栀').count(), 0, '重启后「林栀」仍不提示')
    const prefs = await page.evaluate((projectId) => window.workspace.characters.hoverPrefs(projectId), ids.projectId)
    assert.deepEqual(prefs.ignoredTerms, [{ characterId: f14.characterId, term: '林栀' }])
  })

  await record('F14 ⑫ 20 万字章节显示降级提示，开启悬停的按键到绘制 p95 ≤ 50ms 且不明显高于关闭悬停基线', async () => {
    const page = running.page
    await openChapter(page, '长章')
    await page.getByTestId('hover-degraded').waitFor({ timeout: 15_000 })
    assert.equal(await page.getByTestId('hover-degraded').innerText(), '人物悬停：仅可见区域')
    await page.waitForFunction(() => document.querySelectorAll('.manuscript-editor .character-hit').length > 0)
    const decorated = await page.locator('.manuscript-editor .character-hit').count()
    assert.ok(decorated < 2100, `降级后只装饰可见区域附近（${decorated} < 2100）`)
    await page.locator('.manuscript-editor p').first().click()
    await page.keyboard.press('End')
    await page.evaluate(() => {
      window.__f14Latency = []
      window.addEventListener('keydown', (event) => { const start = event.timeStamp; requestAnimationFrame(() => window.__f14Latency.push(performance.now() - start)) }, true)
    })
    const measure = async () => {
      await page.evaluate(() => { window.__f14Latency = [] })
      for (let i = 0; i < 40; i += 1) { await page.keyboard.press('a'); await page.waitForTimeout(60) }
      await page.waitForTimeout(800)
      const samples = await page.evaluate(() => window.__f14Latency.toSorted((a, b) => a - b))
      assert.ok(samples.length >= 38)
      return { p50: samples[Math.floor((samples.length - 1) / 2)], p95: samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)], max: samples.at(-1), n: samples.length }
    }
    await measure() // 预热（首轮含 JIT / 首次布局）
    // 交替测 3 轮「开 / 关」，各取 p95 的中位数，减少机器抖动影响
    const toggleHover = async (on) => {
      await page.getByRole('button', { name: '人物悬停' }).click()
      await page.getByTestId('hover-degraded').waitFor({ state: on ? 'visible' : 'detached' })
      await page.locator('.manuscript-editor p').first().click(); await page.keyboard.press('End')
    }
    const onRuns = []; const offRuns = []
    for (let round = 0; round < 3; round += 1) {
      await page.locator('.manuscript-editor p').first().click(); await page.keyboard.press('End')
      onRuns.push(await measure())
      await toggleHover(false); offRuns.push(await measure()); await toggleHover(true)
    }
    const median = (runs, key = 'p95') => runs.map((run) => run[key]).toSorted((x, y) => x - y)[1]
    const withHover = { p95: median(onRuns), max: Math.max(...onRuns.map((run) => run.max)) }
    const baseline = { p95: median(offRuns), max: Math.max(...offRuns.map((run) => run.max)) }
    process.stdout.write(`F14 200k keypress→paint p95: hover on ${withHover.p95.toFixed(1)}ms (max ${withHover.max.toFixed(1)}), hover off ${baseline.p95.toFixed(1)}ms (max ${baseline.max.toFixed(1)})\n`)
    process.stdout.write(`F14 200k keypress→paint p50: hover on ${median(onRuns, 'p50').toFixed(1)}ms, hover off ${median(offRuns, 'p50').toFixed(1)}ms\n`)
    // spec ⑫：开启悬停 p95 ≤ 50ms（屏外段落 content-visibility 跳过布局、字数延后统计之后可达），同时仍要求不明显高于关闭基线
    assert.ok(withHover.p95 <= 50, `开启悬停 p95 ${withHover.p95.toFixed(1)}ms 应 ≤ 50ms`)
    assert.ok(withHover.p95 <= baseline.p95 * 1.25 + 10, `开启悬停 p95 ${withHover.p95.toFixed(1)}ms 不应明显高于基线 ${baseline.p95.toFixed(1)}ms`)
    // 滚动到中间后，附近段落也有下划线
    await page.locator('.manuscript-editor').evaluate((editor) => { let element = editor; while (element && element.scrollHeight <= element.clientHeight + 10) element = element.parentElement; (element ?? document.scrollingElement).scrollTop = (element ?? document.scrollingElement).scrollHeight / 2 })
    await page.waitForTimeout(1_500)
    const middle = await page.evaluate(() => { const hits = [...document.querySelectorAll('.manuscript-editor .character-hit')]; const view = window.innerHeight; return hits.some((hit) => { const rect = hit.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= view }) })
    assert.ok(middle, '滚动后可见区域内有下划线')
    await waitSaved(page)
  })

  // 滑块可见跳动阈值：单步总高变化 > 0.1%（约 600px / 60 万 px，滑块在 800px 轨道上约 1px）记为一次「明显跳动」
  const SCROLL_JUMP_RATIO = 0.001
  const SCROLL_MAX_JUMPS = 0
  const SCROLL_MAX_DELTA_RATIO = 0.002
  const SCROLL_MAX_RANGE_RATIO = 0.01
  await record('M-1 20 万字滚动条稳定：首屏 scrollHeight 与真实值偏差 ≤ 10%，从头滚到尾无明显跳动（单步 >0.1% 的次数为 0、单步 ≤0.2%、极差 ≤1%）', async () => {
    const page = running.page
    await page.getByRole('button', { name: '正文', exact: true }).click().catch(() => {})
    await openChapter(page, '悬停章')
    await page.locator('.manuscript-editor', { hasText: '林栀推门进来' }).waitFor()
    await openChapter(page, '长章')
    await page.locator('.manuscript-editor', { hasText: '第0000段' }).waitFor()
    await page.waitForTimeout(800)
    const stats = await page.evaluate(async (jumpRatio) => {
      const frame = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
      const scroller = document.querySelector('.writing-scroll')
      scroller.scrollTo({ top: 0, behavior: 'instant' }); await frame()
      const heights = [scroller.scrollHeight]
      while (scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 2) {
        scroller.scrollTo({ top: scroller.scrollTop + scroller.clientHeight * 0.9, behavior: 'instant' })
        await frame()
        heights.push(scroller.scrollHeight)
        if (heights.length > 5000) break
      }
      const style = document.createElement('style')
      style.textContent = '.manuscript-editor > * { content-visibility: visible !important; }'
      document.head.append(style); await frame()
      const truth = scroller.scrollHeight
      style.remove(); await frame()
      scroller.scrollTo({ top: 0, behavior: 'instant' })
      let changes = 0; let maxDelta = 0; let jumps = 0
      for (let i = 1; i < heights.length; i += 1) { const delta = Math.abs(heights[i] - heights[i - 1]); if (delta > 0) changes += 1; if (delta > truth * jumpRatio) jumps += 1; maxDelta = Math.max(maxDelta, delta) }
      return { first: heights[0], truth, steps: heights.length, distinct: new Set(heights).size, changes, jumps, maxDelta, range: Math.max(...heights) - Math.min(...heights), last: heights.at(-1), estimate: document.querySelector('.writing-page')?.style.getPropertyValue('--block-estimate') }
    }, SCROLL_JUMP_RATIO)
    const deviation = Math.abs(stats.first - stats.truth) / stats.truth
    const maxDeltaRatio = stats.maxDelta / stats.truth
    process.stdout.write(`M-1 scroll: ${JSON.stringify(stats)} firstDeviation=${(deviation * 100).toFixed(2)}% maxDelta=${(maxDeltaRatio * 100).toFixed(3)}%\n`)
    assert.ok(deviation <= 0.10, `首屏 scrollHeight ${stats.first} 与真实 ${stats.truth} 偏差 ${(deviation * 100).toFixed(1)}% 应 ≤ 10%`)
    assert.ok(stats.jumps <= SCROLL_MAX_JUMPS, `滚动中明显跳动（单步 > ${SCROLL_JUMP_RATIO * 100}%）${stats.jumps} 次应 ≤ ${SCROLL_MAX_JUMPS}（总变化 ${stats.changes} 次，均为像素级）`)
    assert.ok(stats.range / stats.truth <= SCROLL_MAX_RANGE_RATIO, `滚动全程总高极差 ${stats.range}px 应 ≤ ${SCROLL_MAX_RANGE_RATIO * 100}%`)
    assert.ok(maxDeltaRatio <= SCROLL_MAX_DELTA_RATIO, `单步最大变化 ${stats.maxDelta}px（${(maxDeltaRatio * 100).toFixed(2)}%）应 ≤ ${SCROLL_MAX_DELTA_RATIO * 100}%`)
  })

  // 按键性能 PR：自动保存改为「停顿 700ms / 连续输入最迟 2000ms」（save-coordinator.ts SAVE_MAX_WAIT_MS）。
  // 数据丢失上限：强杀时最多丢「最近 2000ms 内的输入 + 一次进行中的保存」。这里给进行中的保存 + 按键投递留 500ms 余量。
  const SAVE_MAX_WAIT_MS = 2000
  const KILL_LOSS_BOUND_MS = SAVE_MAX_WAIT_MS + 500
  await record('按键性能：输入后立即切章 / 回作品库都会先落盘（不等防抖）', async () => {
    const page = running.page
    const made = await page.evaluate(async (projectId) => {
      const tree = await window.workspace.documents.tree(projectId)
      const volume = tree.find((item) => item.type === 'volume')
      const a = await window.workspace.documents.create({ projectId, parentId: volume.id, type: 'chapter', title: '强杀章' })
      return { kill: a.id }
    }, ids.projectId)
    f14.kill = made.kill
    await page.reload(); await page.getByRole('button', { name: '继续写作' }).click(); await page.locator('.manuscript-editor').waitFor()
    await openChapter(page, '强杀章')
    await page.locator('.manuscript-editor').click()
    await page.keyboard.type('切章前一刻')
    await openChapter(page, '悬停章') // 不等待：切章必须先 flush
    await page.locator('.manuscript-editor', { hasText: '林栀推门进来' }).waitFor()
    const afterSwitch = await page.evaluate(async ({ projectId, id }) => (await window.workspace.documents.get(projectId, id)).plainText, { projectId: ids.projectId, id: made.kill })
    assert.equal(afterSwitch, '切章前一刻')
    await openChapter(page, '强杀章')
    await page.locator('.manuscript-editor', { hasText: '切章前一刻' }).waitFor()
    await page.locator('.manuscript-editor').click(); await page.keyboard.press('Control+End')
    await page.keyboard.type('回库前一刻')
    await page.locator('.works-rail button[title="作品库"]').click()
    await page.getByRole('button', { name: '继续写作' }).first().waitFor()
    const afterLeave = await page.evaluate(async ({ projectId, id }) => (await window.workspace.documents.get(projectId, id)).plainText, { projectId: ids.projectId, id: made.kill })
    assert.equal(afterLeave, '切章前一刻回库前一刻')
    await page.getByRole('button', { name: '继续写作' }).first().click(); await page.locator('.manuscript-editor').waitFor()
  })

  await record(`按键性能：连续输入中强杀进程，重启后丢失的只有最后 ≤${KILL_LOSS_BOUND_MS}ms 的输入`, async () => {
    let page = running.page
    await openChapter(page, '强杀章')
    await page.locator('.manuscript-editor', { hasText: '切章前一刻回库前一刻' }).waitFor()
    await page.locator('.manuscript-editor').click(); await page.keyboard.press('Control+End')
    await page.keyboard.press('Enter')
    const typedAt = []
    // 每 50ms 一键、约 5 秒不停顿：旧逻辑（只有 700ms 停顿防抖）在这期间一次都不会保存
    for (let i = 0; i < 80; i += 1) { typedAt.push(Date.now()); await page.keyboard.type(String(i % 10)); await page.waitForTimeout(50) }
    const killAt = Date.now()
    await killApp(running)
    running = await launch()
    page = running.page
    watchRendererRequests(page)
    const persisted = await page.evaluate(async ({ projectId, id }) => (await window.workspace.documents.get(projectId, id)).plainText, { projectId: ids.projectId, id: f14.kill })
    // 之前的段落不含数字：只取数字串比较，与光标落在段首/段尾无关
    const typed = (persisted.match(/[0-9]+/g) ?? []).join('')
    const expected = Array.from({ length: 80 }, (_, i) => String(i % 10)).join('')
    assert.ok(expected.startsWith(typed), `落盘内容必须是已输入内容的前缀：${typed}`)
    const kept = typed.length
    const lostWindowMs = kept >= 80 ? 0 : killAt - typedAt[kept]
    process.stdout.write(`kill-loss: typed 80 over ${killAt - typedAt[0]}ms, persisted ${kept}, lost ${80 - kept} (window ${lostWindowMs}ms, bound ${KILL_LOSS_BOUND_MS}ms)\n`)
    assert.ok(kept > 0, '连续输入期间也必须有中途保存（最迟 2000ms）')
    assert.ok(lostWindowMs <= KILL_LOSS_BOUND_MS, `丢失窗口 ${lostWindowMs}ms 超过上限 ${KILL_LOSS_BOUND_MS}ms`)
    assert.ok(persisted.includes('切章前一刻回库前一刻'), '强杀前已保存的正文保留')
    await page.getByRole('button', { name: '继续写作' }).click()
    await page.locator('.manuscript-editor').waitFor()
  })

  await record('F14 ⑪ 小黑屋内能悬停，看不到「打开人物卡」，网络请求为 0', async () => {
    const page = running.page
    await openChapter(page, '悬停章')
    await page.locator('.manuscript-editor', { hasText: '林栀推门进来' }).waitFor()
    await page.waitForFunction(() => document.querySelectorAll('.manuscript-editor .character-hit').length === 1)
    await enterBlackroom(page, async (d) => { await d.getByLabel('写满字数').check(); await d.getByLabel('目标字数').fill('1000') })
    const before = await snapshotNetwork(page)
    await hitLocator(page, '阿栀').hover()
    const card = page.getByTestId('character-hover-card')
    await card.waitFor({ timeout: 2_000 })
    assert.match(await card.innerText(), /林栀/)
    assert.equal(await card.getByRole('button', { name: '打开人物卡' }).count(), 0, '小黑屋内隐藏跳转')
    await page.keyboard.press('Escape')
    await card.waitFor({ state: 'detached' })
    await page.mouse.move(5, 5)
    await page.waitForTimeout(400)
    await hitLocator(page, '阿栀').click()
    await page.mouse.move(5, 5)
    await page.waitForTimeout(400)
    await card.waitFor({ state: 'detached' })
    await page.keyboard.press('Control+Shift+K')
    await card.waitFor({ timeout: 2_000 })
    assert.equal(await card.getByRole('button', { name: '打开人物卡' }).count(), 0)
    await page.keyboard.press('Escape')
    assert.equal(await page.getByTestId('blackroom-bar').count(), 1, 'Esc 只关卡片，不退出小黑屋')
    await page.waitForTimeout(1_000)
    const after = await snapshotNetwork(page)
    const delta = Object.fromEntries(Object.keys(before).map((key) => [key, after[key] - before[key]]))
    process.stdout.write(`F14 ⑪ locked hover network delta: ${JSON.stringify(delta)}\n`)
    assert.deepEqual(delta, { fixture: 0, anthropic: 0, renderer: 0, blocked: 0 })
    await page.getByRole('button', { name: '紧急出口' }).click()
    await page.getByLabel('紧急出屋确认').fill('我要出屋')
    await addLockedDelta(page, before)
    await page.getByRole('button', { name: '确认出屋' }).click()
    await page.getByTestId('blackroom-bar').waitFor({ state: 'detached' })
    await page.locator('.assistant-panel').waitFor()
  })

  // ───── F13 校对词表（e2e ⑪–⑭ + 忽略重启保持）。批量只生成提案、全部接受、快照恢复原文、单条 Ctrl+Z、小黑屋不自动校对且网络 0 ─────
  const f13 = await running.page.evaluate(async ({ projectId }) => {
    const tree = await window.workspace.documents.tree(projectId)
    const volume = tree.find((item) => item.type === 'volume')
    const para = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
    const make = async (title, text) => {
      const node = await window.workspace.documents.create({ projectId, parentId: volume.id, type: 'chapter', title })
      await window.workspace.documents.save({ projectId, documentId: node.id, editorJson: { type: 'doc', content: text.split('\n\n').map(para) }, plainText: text, expectedRevision: 0 })
      return node.id
    }
    await window.workspace.wordlist.saveGlobal('在坐=>在座\n')
    return {
      batch: await make('词表批量章', '他在坐一。\n\n众人在坐二。\n\n仍旧在坐三。'),
      single: await make('词表单条章', '宾客在坐。'),
      locked: await make('黑屋校对章', '干净的一段。'),
      ignore: await make('词表忽略章', '在坐甲。在坐乙。')
    }
  }, { projectId: ids.projectId })
  // 校对抽屉在窄于宽屏断点时覆盖侧栏；F13 用例统一在宽屏下跑（窄屏组合由上面的窄屏用例覆盖）
  const f13Viewport = running.page.viewportSize()
  await running.page.setViewportSize({ width: 1600, height: 900 })
  await running.page.reload()
  await running.page.getByRole('button', { name: '继续写作' }).click()
  await running.page.locator('.manuscript-editor').waitFor()
  // 段落带 content-visibility:auto（#36 M-1），首帧布局前 innerText 会把被跳过渲染的段落读成空串；
  // 正文断言只关心文档内容，按段落 textContent 拼接，与布局时机无关
  const editorText = (page) => page.locator('.manuscript-editor').evaluate((el) => Array.from(el.children, (block) => block.textContent ?? '').join('\n')).then((text) => text.replace(/\n+/g, '\n').trim())
  const localLintCount = (page) => page.getByTestId('local-lint').locator('h3 > span').innerText().then(Number)
  const openLint = async (page) => {
    await page.locator('.editor-toolbar button', { hasText: /^校对/ }).click()
    await page.getByRole('button', { name: '重新检查本地规则' }).click()
  }

  await record('F13 ⑪ 本章批量应用只生成提案、接受前正文不变；全部接受后全部替换；有 AI 修改前快照，历史恢复回原文', async () => {
    const page = running.page
    await openChapter(page, '词表批量章')
    await page.locator('.manuscript-editor', { hasText: '他在坐一' }).waitFor()
    const original = await editorText(page)
    await openLint(page)
    await page.waitForFunction(() => document.querySelector('[data-testid="local-lint"] h3 > span')?.textContent === '3')
    await page.getByRole('button', { name: '本章批量应用「在坐→在座」（3 处，生成修改提案）' }).click()
    const drawer = page.locator('.patch-drawer')
    await drawer.waitFor()
    await drawer.getByRole('button', { name: '全部接受（3 条）' }).waitFor()
    assert.equal(await editorText(page), original, '接受前正文不变')
    // 记录全部接受过程中编辑器里「在座」的个数：逐条接受只能单调增加，出现回落 = 编辑器被旧 content 覆盖过
    await page.evaluate(() => {
      const editor = document.querySelector('.manuscript-editor')
      const count = () => (editor.textContent.match(/在座/g) ?? []).length
      window.__f13Counts = [count()]
      window.__f13Observer = new MutationObserver(() => { const next = count(); if (next !== window.__f13Counts.at(-1)) window.__f13Counts.push(next) })
      window.__f13Observer.observe(editor, { subtree: true, childList: true, characterData: true })
    })
    await drawer.getByRole('button', { name: '全部接受（3 条）' }).click()
    await page.locator('.manuscript-editor', { hasText: '仍旧在座三' }).waitFor().catch(async (error) => {
      // 失败时把渲染层与持久层状态打到日志里（CI 只有日志可看），再原样抛出
      const state = await page.evaluate(async ({ projectId, documentId }) => ({
        editor: document.querySelector('.manuscript-editor')?.textContent,
        drawer: document.querySelector('.patch-drawer')?.textContent,
        alerts: [...document.querySelectorAll('[role="alert"]')].map((node) => node.textContent),
        saveState: document.querySelector('.save-state, .editor-toolbar')?.textContent,
        doc: await window.workspace.documents.get(projectId, documentId).then((doc) => ({ revision: doc.revision, plainText: doc.plainText })),
        patches: (await window.workspace.patches.list(projectId, documentId)).map((patch) => ({ status: patch.status, rev: patch.documentRevision, fromPm: patch.fromPm, toPm: patch.toPm }))
      }), { projectId: ids.projectId, documentId: f13.batch }).catch((evalError) => ({ evalError: String(evalError) }))
      process.stdout.write(`F13 ⑪ diagnostics: ${JSON.stringify(state)}\n`)
      throw error
    })
    await page.waitForTimeout(300)
    const counts = await page.evaluate(() => { window.__f13Observer.disconnect(); return window.__f13Counts })
    process.stdout.write(`F13 ⑪ 在座 count sequence during accept-all: ${JSON.stringify(counts)}\n`)
    assert.ok(counts.every((value, index) => index === 0 || value > counts[index - 1]), `全部接受过程中正文不应回退，实际序列 ${JSON.stringify(counts)}`)
    const after = await editorText(page)
    assert.ok(!after.includes('在坐') && (after.match(/在座/g) ?? []).length === 3, `全部接受后应替换 3 处，实际 ${after}`)
    assert.equal(await drawer.locator('.patch-status.stale').count(), 0, '无失效提案')
    await waitSaved(page)
    await drawer.getByRole('button', { name: '关闭' }).click()
    const snapshots = await page.evaluate(({ projectId, documentId }) => window.workspace.snapshots.list(projectId, documentId), { projectId: ids.projectId, documentId: f13.batch })
    const aiEdits = snapshots.filter((item) => item.reason === 'ai_edit')
    assert.ok(aiEdits.length >= 1, '应有 AI 修改前快照')
    const preBatch = aiEdits.find((item) => item.plainText.replace(/\n+/g, '\n').trim() === original)
    assert.ok(preBatch, '最早的 AI 修改前快照应是批量前原文')
    await page.getByRole('button', { name: '历史', exact: true }).click()
    const article = page.locator('.history-list article', { hasText: `修订 ${preBatch.revision}` }).filter({ hasText: 'AI 修改前' })
    await article.getByRole('button', { name: '恢复此版本' }).click()
    await page.getByRole('button', { name: '确认' }).click()
    await page.getByRole('button', { name: '正文', exact: true }).click()
    await page.locator('.manuscript-editor', { hasText: '他在坐一' }).waitFor()
    assert.equal(await editorText(page), original, '恢复后回到原文')
  })

  await record('F13 ⑫ 单条应用后 Ctrl+Z 恢复原文', async () => {
    const page = running.page
    await openChapter(page, '词表单条章')
    await page.locator('.manuscript-editor', { hasText: '宾客在坐' }).waitFor()
    await openLint(page)
    const issue = page.locator('.lint-group[data-group="wordlist_replace"] .proofread-issue').first()
    await issue.getByRole('button', { name: '应用' }).click()
    await page.locator('.manuscript-editor', { hasText: '宾客在座' }).waitFor()
    await page.getByRole('button', { name: '关闭校对' }).click()
    await page.locator('.manuscript-editor').click()
    await page.keyboard.press('Control+z')
    await page.locator('.manuscript-editor', { hasText: '宾客在坐' }).waitFor()
    await waitSaved(page)
  })

  await record('F13 ⑬ 小黑屋内不自动校对、无校对入口与计数，网络 0；出屋后计数正确', async () => {
    const page = running.page
    await openChapter(page, '黑屋校对章')
    await page.locator('.manuscript-editor', { hasText: '干净的一段' }).waitFor()
    await enterBlackroom(page, async (d) => { await d.getByLabel('写满字数').check(); await d.getByLabel('目标字数').fill('1000') })
    const before = await snapshotNetwork(page)
    await typeAtEnd(page, '甲,乙在坐')
    await page.waitForTimeout(1_000)
    assert.equal(await page.locator('button', { hasText: /^校对/ }).count(), 0, '锁定期间无校对按钮')
    assert.equal(await page.locator('.proofread-count').count(), 0, '锁定期间无校对计数')
    assert.equal(await page.locator('.proofread-drawer').count(), 0)
    const skipped = await page.evaluate(({ projectId, documentId }) => window.workspace.linter.run(projectId, documentId, '甲,乙', 0), { projectId: ids.projectId, documentId: f13.locked })
    assert.equal(skipped.skipped, 'focus-locked', '主进程锁定时跳过校对')
    const after = await snapshotNetwork(page)
    const delta = Object.fromEntries(Object.keys(before).map((key) => [key, after[key] - before[key]]))
    process.stdout.write(`F13 ⑬ locked lint network delta: ${JSON.stringify(delta)}\n`)
    assert.deepEqual(delta, { fixture: 0, anthropic: 0, renderer: 0, blocked: 0 })
    await page.getByRole('button', { name: '紧急出口' }).click()
    await page.getByLabel('紧急出屋确认').fill('我要出屋')
    await addLockedDelta(page, before)
    await page.getByRole('button', { name: '确认出屋' }).click()
    await page.getByTestId('blackroom-bar').waitFor({ state: 'detached' })
    await page.locator('.proofread-count', { hasText: '2 条校对提示' }).waitFor({ timeout: 5_000 })
  })

  await record('F13 「忽略这一处」重启后仍生效', async () => {
    let page = running.page
    await openChapter(page, '词表忽略章')
    await page.locator('.manuscript-editor', { hasText: '在坐甲' }).waitFor()
    await page.locator('.proofread-count', { hasText: '2 条校对提示' }).waitFor({ timeout: 5_000 })
    await page.locator('.proofread-count').click()
    await page.locator('.lint-group[data-group="wordlist_replace"] .proofread-issue').first().getByRole('button', { name: '忽略这一处' }).click()
    await page.locator('.proofread-count', { hasText: '1 条校对提示' }).waitFor()
    await running.app.close()
    running = await launch()
    page = running.page
    watchRendererRequests(page)
    await page.setViewportSize({ width: 1600, height: 900 })
    await page.getByRole('button', { name: '继续写作' }).click()
    await page.locator('.manuscript-editor').waitFor()
    await openChapter(page, '词表忽略章')
    await page.locator('.manuscript-editor', { hasText: '在坐甲' }).waitFor()
    await page.locator('.proofread-count', { hasText: '1 条校对提示' }).waitFor({ timeout: 5_000 })
    await page.locator('.proofread-count').click()
    const remaining = await page.locator('.lint-group[data-group="wordlist_replace"] .proofread-issue small').allInnerTexts()
    assert.equal(remaining.length, 1)
    await page.getByRole('button', { name: '关闭校对' }).click()
  })

  await record('F13 ⑭ 词表界面保存后重新打开内容一致（作品叠加全局、!词）；全书检查完成并显示耗时', async () => {
    const page = running.page
    await page.locator('.project-sidebar button', { hasText: '校对词表' }).click()
    const project = page.getByLabel('本作品词表')
    await project.fill('# 作品词\n狠狠=>很\n!在坐\n')
    await page.getByRole('button', { name: '保存本作品词表' }).click()
    await page.getByText('本作品词表已保存').waitFor()
    const stored = await page.evaluate(({ projectId }) => window.workspace.wordlist.get(projectId), { projectId: ids.projectId })
    assert.equal(stored.projectText, '# 作品词\n狠狠=>很\n!在坐\n')
    assert.equal(stored.globalText, '在坐=>在座\n')
    await page.getByRole('button', { name: '正文', exact: true }).click()
    await page.locator('.project-sidebar button', { hasText: '校对词表' }).click()
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="全局词表"]')?.value !== '', null, { timeout: 5_000 })
    assert.equal(await page.getByLabel('本作品词表').inputValue(), '# 作品词\n狠狠=>很\n!在坐\n', '重新打开后内容一致')
    assert.equal(await page.getByLabel('全局词表').inputValue(), '在坐=>在座\n')
    await page.getByRole('button', { name: '开始检查' }).click()
    const result = page.getByTestId('book-check-result')
    await result.waitFor({ timeout: 30_000 })
    assert.match(await result.innerText(), /检查完成。共 \d+ 条，耗时 [\d.]+ 秒/)
    process.stdout.write(`F13 ⑭ book check: ${(await result.locator('p').innerText()).slice(0, 80)}\n`)
    await page.getByRole('button', { name: '正文', exact: true }).click()
    await page.locator('.manuscript-editor').waitFor()
    if (f13Viewport) await page.setViewportSize(f13Viewport)
  })

  await record('F13 L2 命中 11704 条：抽屉分页（先 200 条 + 总数 +「更多」），打开与点击响应 ≤1s；批量应用单次最多 500 处并明确提示', async () => {
    const page = running.page
    // 作品词表（⑭ 保存）含「狠狠=>很」：5852 段 × 2 处 = 11704 条命中，约 6.4 万字（低于 20 万字长章节阈值，词表检查照常运行）
    await page.evaluate(async ({ projectId }) => {
      const tree = await window.workspace.documents.tree(projectId)
      const volume = tree.find((item) => item.type === 'volume')
      const lines = Array.from({ length: 5852 }, () => '他狠狠地看，狠狠地走。')
      const node = await window.workspace.documents.create({ projectId, parentId: volume.id, type: 'chapter', title: '万条命中章' })
      await window.workspace.documents.save({ projectId, documentId: node.id, editorJson: { type: 'doc', content: lines.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })) }, plainText: lines.join('\n\n'), expectedRevision: 0 })
    }, { projectId: ids.projectId })
    const viewport = page.viewportSize()
    await page.setViewportSize({ width: 1600, height: 900 })
    await page.reload()
    await page.getByRole('button', { name: '继续写作' }).click()
    await page.locator('.manuscript-editor').waitFor()
    await openChapter(page, '万条命中章')
    await page.locator('.editor-status .proofread-count', { hasText: '11704 条校对提示' }).waitFor({ timeout: 30_000 })
    // 在页面内计时：点击 → 目标 DOM 出现 → 再等两帧（确保已绘制）
    const timeClick = (selector, expectCount) => page.evaluate(async ({ selector, expectCount }) => {
      const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()))
      const button = [...document.querySelectorAll('button')].find((item) => item.matches(selector.button) && item.textContent.includes(selector.text))
      if (!button) throw new Error(`button not found: ${selector.text}`)
      const started = performance.now()
      button.click()
      while (document.querySelectorAll('.proofread-drawer .proofread-issue').length !== expectCount) {
        if (performance.now() - started > 15_000) throw new Error(`timeout waiting for ${expectCount} issues, got ${document.querySelectorAll('.proofread-drawer .proofread-issue').length}`)
        await frame()
      }
      await frame(); await frame()
      return performance.now() - started
    }, { selector, expectCount })
    const openMs = await timeClick({ button: '.editor-status .proofread-count', text: '11704 条校对提示' }, 200)
    assert.equal(await page.getByTestId('lint-page-status').innerText(), '共 11704 条，已显示前 200 条')
    assert.equal(await page.locator('[data-testid="local-lint"] h3 > span').innerText(), '11704')
    const batch = page.getByRole('button', { name: '本章批量应用「狠狠→很」（前 500 处 / 共 11704 处，生成修改提案）' })
    await batch.waitFor()
    assert.match(await page.getByTestId('batch-limit-notice').innerText(), /单次最多 500 处：本次只为前 500 处生成提案，其余 11204 处/)
    const moreMs = await timeClick({ button: '.proofread-drawer button', text: '更多（再显示 200 条，剩余 11504 条）' }, 400)
    assert.equal(await page.getByTestId('lint-page-status').innerText(), '共 11704 条，已显示前 400 条')
    // 「忽略这一处」：点击后列表仍保持 400 条（后面的顶上来），总数减 1
    const ignoreMs = await page.evaluate(async () => {
      const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()))
      const count = () => document.querySelector('[data-testid="local-lint"] h3 > span')?.textContent
      const button = [...document.querySelectorAll('.proofread-drawer .proofread-issue button')].find((item) => item.textContent === '忽略这一处')
      const started = performance.now()
      button.click()
      while (count() !== '11703') { if (performance.now() - started > 15_000) throw new Error(`ignore timeout, count=${count()}`); await frame() }
      await frame(); await frame()
      return performance.now() - started
    })
    const applyMs = await timeApplyFirst(page, '11702')
    process.stdout.write(`F13 L2 drawer (11704 hits): open ${openMs.toFixed(1)}ms, more ${moreMs.toFixed(1)}ms, ignore ${ignoreMs.toFixed(1)}ms, apply ${applyMs.toFixed(1)}ms (limit 1000ms)\n`)
    assert.ok(openMs <= 1000, `抽屉打开 ${openMs.toFixed(1)}ms 应 ≤1000ms`)
    assert.ok(moreMs <= 1000, `点「更多」响应 ${moreMs.toFixed(1)}ms 应 ≤1000ms`)
    assert.ok(ignoreMs <= 1000, `点「忽略这一处」响应 ${ignoreMs.toFixed(1)}ms 应 ≤1000ms`)
    assert.ok(applyMs <= 1000, `点「应用」响应 ${applyMs.toFixed(1)}ms 应 ≤1000ms`)
    await waitSaved(page)
    await page.getByRole('button', { name: '关闭校对' }).click()
    await openChapter(page, '词表批量章')
    await page.locator('.manuscript-editor', { hasText: '他在坐一' }).waitFor()
    if (viewport) await page.setViewportSize(viewport)
  })

  await record('F13 L2 单段长章（19.9 万字一段、11704 条命中）：打开 / 更多 / 忽略 / 应用 ≤1s；全部接受 500 条 ≤30s、1 个快照、Ctrl+Z 一步回到批量前；第 2 轮提示「其余 N 处」刷新', async () => {
    const page = running.page
    // 与复验同形：一整段 198968 字（34 字一句 × 5852，每句 2 处「狠狠」= 11704 条），低于 20 万字长章节阈值
    const seg = '林舟在会上说，他狠狠地看，又狠狠地走了。夜色很深，风也很大，远处灯。'
    const chapterId = await page.evaluate(async ({ projectId, seg }) => {
      const tree = await window.workspace.documents.tree(projectId)
      const volume = tree.find((item) => item.type === 'volume')
      const text = seg.repeat(5852)
      const node = await window.workspace.documents.create({ projectId, parentId: volume.id, type: 'chapter', title: '单段长章' })
      await window.workspace.documents.save({ projectId, documentId: node.id, editorJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }, plainText: text, expectedRevision: 0 })
      return node.id
    }, { projectId: ids.projectId, seg })
    const viewport = page.viewportSize()
    await page.setViewportSize({ width: 1600, height: 900 })
    await page.reload()
    await page.getByRole('button', { name: '继续写作' }).click()
    await page.locator('.manuscript-editor').waitFor()
    await openChapter(page, '单段长章')
    await page.locator('.editor-status .proofread-count', { hasText: '11704 条校对提示' }).waitFor({ timeout: 60_000 })
    assert.ok(await page.locator('.manuscript-editor .long-paragraph-chunk').count() > 100, '超长单段应分块显示')
    const clickAndWait = (spec) => page.evaluate(async (spec) => {
      const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()))
      const count = () => document.querySelector('[data-testid="local-lint"] h3 > span')?.textContent
      const shown = () => document.querySelectorAll('.proofread-drawer .proofread-issue').length
      const button = [...document.querySelectorAll(spec.selector)].find((item) => item.textContent.includes(spec.text))
      if (!button) throw new Error(`button not found: ${spec.text}`)
      const started = performance.now()
      button.click()
      while (!((spec.shown === undefined || shown() === spec.shown) && (spec.count === undefined || count() === spec.count))) {
        if (performance.now() - started > 30_000) throw new Error(`timeout: ${spec.text} shown=${shown()} count=${count()}`)
        await frame()
      }
      await frame(); await frame()
      return performance.now() - started
    }, spec)
    const openMs = await clickAndWait({ selector: '.editor-status .proofread-count', text: '11704 条校对提示', shown: 200 })
    const moreMs = await clickAndWait({ selector: '.proofread-drawer button', text: '更多（再显示 200 条，剩余 11504 条）', shown: 400 })
    const ignoreMs = await clickAndWait({ selector: '.proofread-drawer .proofread-issue button', text: '忽略这一处', count: '11703', shown: 400 })
    const applyMs = await timeApplyFirst(page, '11702')
    process.stdout.write(`F13 L2 single paragraph (198968 chars, 11704 hits): open ${openMs.toFixed(1)}ms, more ${moreMs.toFixed(1)}ms, ignore ${ignoreMs.toFixed(1)}ms, apply ${applyMs.toFixed(1)}ms (limit 1000ms)\n`)
    assert.ok(openMs <= 1000, `单段长章 抽屉打开 ${openMs.toFixed(1)}ms 应 ≤1000ms`)
    assert.ok(moreMs <= 1000, `单段长章 点「更多」${moreMs.toFixed(1)}ms 应 ≤1000ms`)
    assert.ok(ignoreMs <= 1000, `单段长章 点「忽略这一处」${ignoreMs.toFixed(1)}ms 应 ≤1000ms`)
    assert.ok(applyMs <= 1000, `单段长章 点「应用」${applyMs.toFixed(1)}ms 应 ≤1000ms`)
    await waitSaved(page)
    const hits = () => page.evaluate(() => (document.querySelector('.manuscript-editor').textContent.match(/很地/g) ?? []).length)
    assert.equal(await hits(), 1)
    const preBatch = await editorText(page)
    const snapshotsBefore = await page.evaluate(({ projectId, documentId }) => window.workspace.snapshots.list(projectId, documentId), { projectId: ids.projectId, documentId: chapterId })
    // 第 1 轮：前 500 处生成提案 → 全部接受（计时）
    assert.match(await page.locator('[data-testid="batch-limit-notice"][data-rule="wordlist:狠狠"]').innerText(), /「狠狠→很」单次最多 500 处：本次只为前 500 处生成提案，其余 11202 处/)
    await page.getByRole('button', { name: '本章批量应用「狠狠→很」（前 500 处 / 共 11702 处，生成修改提案）' }).click()
    const drawer = page.locator('.patch-drawer')
    await drawer.getByRole('button', { name: '全部接受（500 条）' }).waitFor({ timeout: 60_000 })
    const acceptStarted = Date.now()
    await drawer.getByRole('button', { name: '全部接受（500 条）' }).click()
    await page.waitForFunction(() => (document.querySelector('.manuscript-editor').textContent.match(/很地/g) ?? []).length === 501, undefined, { timeout: 60_000 })
    await waitSaved(page)
    await page.waitForFunction(() => !document.querySelector('.patch-drawer button.primary')?.textContent?.startsWith('全部接受'), undefined, { timeout: 60_000 })
    const acceptMs = Date.now() - acceptStarted
    const patches = await page.evaluate(({ projectId, documentId }) => window.workspace.patches.list(projectId, documentId), { projectId: ids.projectId, documentId: chapterId })
    const snapshotsAfter = await page.evaluate(({ projectId, documentId }) => window.workspace.snapshots.list(projectId, documentId), { projectId: ids.projectId, documentId: chapterId })
    const newAiEdits = snapshotsAfter.filter((item) => item.reason === 'ai_edit').length - snapshotsBefore.filter((item) => item.reason === 'ai_edit').length
    process.stdout.write(`F13 L2 single paragraph accept-all 500: ${acceptMs}ms (limit 30000ms), accepted ${patches.filter((patch) => patch.status === 'accepted').length}, new ai_edit snapshots ${newAiEdits}\n`)
    assert.ok(acceptMs <= 30_000, `全部接受 500 条 ${acceptMs}ms 应 ≤30000ms`)
    assert.equal(patches.filter((patch) => patch.status === 'accepted').length, 500)
    assert.equal(newAiEdits, 1, '整批只拍 1 个 AI 修改前快照')
    const beforeIds = new Set(snapshotsBefore.map((item) => item.id))
    assert.equal(snapshotsAfter.find((item) => item.reason === 'ai_edit' && !beforeIds.has(item.id)).plainText, preBatch, '这个快照就是批量前原文')
    await drawer.getByRole('button', { name: '关闭' }).click()
    // ③ 第 2 轮：重新检查后提示里的「其余 N 处」随之刷新（11702 − 500 = 11202 处，前 500 → 其余 10702）
    await page.locator('.editor-status .proofread-count', { hasText: '11202 条校对提示' }).waitFor({ timeout: 60_000 })
    await openLint(page)
    await page.locator('[data-testid="batch-limit-notice"][data-rule="wordlist:狠狠"]', { hasText: '其余 10702 处' }).waitFor({ timeout: 30_000 })
    assert.equal(await page.locator('[data-testid="batch-limit-notice"]').count(), 1)
    await page.getByRole('button', { name: '本章批量应用「狠狠→很」（前 500 处 / 共 11202 处，生成修改提案）' }).waitFor()
    await page.getByRole('button', { name: '关闭校对' }).click()
    // 撤销：一次 Ctrl+Z 回到批量之前
    await page.locator('.manuscript-editor').click()
    await page.keyboard.press('Control+z')
    await page.waitForFunction(() => (document.querySelector('.manuscript-editor').textContent.match(/很地/g) ?? []).length === 1, undefined, { timeout: 30_000 })
    assert.equal(await editorText(page), preBatch, '一次撤销回到批量前正文')
    await waitSaved(page)
    await openChapter(page, '词表批量章')
    await page.locator('.manuscript-editor', { hasText: '他在坐一' }).waitFor()
    if (viewport) await page.setViewportSize(viewport)
  })

  const seg34 = '林舟在会上说，他狠狠地看，又狠狠地走了。夜色很深，风也很大，远处灯。'
  // ───── P3 PR-1 章内查找替换 / 本章大纲（纯本地）。计时都在页面内 performance.now，含 150ms 输入去抖 ─────
  const findCount = (page) => page.getByTestId('find-count').innerText()
  // 在页面内执行一步操作，等条件成立再过两帧，返回毫秒（渲染进程 CSP 禁 eval，所以步骤写死在这里）
  const timeFindStep = (page, step, arg) => page.evaluate(async ({ step, arg }) => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()))
    const panel = () => document.querySelector('[data-testid="find-panel"]')
    const count = () => document.querySelector('[data-testid="find-count"]')?.textContent ?? ''
    const actions = {
      open: () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', ctrlKey: true, bubbles: true })),
      input: () => { const input = panel().querySelector('input[aria-label="查找"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, arg.query); input.dispatchEvent(new Event('input', { bubbles: true })) },
      prev: () => panel().querySelector('button[aria-label="上一处"]').click(),
      next: () => panel().querySelector('button[aria-label="下一处"]').click(),
      replaceAll: () => [...panel().querySelectorAll('button')].find((button) => button.textContent === '全部替换').click(),
    }
    const done = {
      open: () => Boolean(panel()?.querySelector('input[aria-label="替换为"]')),
      input: () => count().includes(`共 ${arg?.expect ?? 1000} 处`),
      next: () => { const box = document.querySelector('.writing-scroll').getBoundingClientRect(); const range = [...(CSS.highlights.get('find-current') ?? [])][0]; const rect = range?.getBoundingClientRect(); return Boolean(rect && rect.height > 0 && rect.top >= box.top && rect.bottom <= box.bottom) },
      prev: () => count() === '第 1000 / 共 1000 处',
      replaceAll: () => /已替换 1000 处/.test(document.querySelector('[data-testid="find-notice"]')?.textContent ?? ''),
    }
    const started = performance.now()
    actions[step]()
    while (!done[step]()) { if (performance.now() - started > 30_000) throw new Error(`timeout: ${step} (${count()})`); await frame() }
    await frame(); await frame()
    return performance.now() - started
  }, { step, arg })
  const createChapter = (page, title, blocks) => page.evaluate(async ({ projectId, title, blocks }) => {
    const tree = await window.workspace.documents.tree(projectId)
    const volume = tree.find((item) => item.type === 'volume')
    const node = await window.workspace.documents.create({ projectId, parentId: volume.id, type: 'chapter', title })
    const content = blocks.map((block) => block.heading ? { type: 'heading', attrs: { level: block.heading }, content: [{ type: 'text', text: block.text }] } : { type: 'paragraph', content: block.text ? [{ type: 'text', text: block.text }] : [] })
    await window.workspace.documents.save({ projectId, documentId: node.id, editorJson: { type: 'doc', content }, plainText: blocks.map((block) => block.text).join('\n\n'), expectedRevision: 0 })
    return node.id
  }, { projectId: ids.projectId, title, blocks })
  const openFresh = async (page, title, hasText) => {
    await page.reload()
    await page.getByRole('button', { name: '继续写作' }).click()
    await page.locator('.manuscript-editor').waitFor()
    await openChapter(page, title)
    await page.locator('.manuscript-editor', { hasText }).waitFor({ timeout: 30_000 })
  }

  await record('P3 查找：Ctrl+F 计数「第 i / 共 n 处」、Enter / Shift+Enter 循环、正则错误提示不崩、Esc 关闭', async () => {
    const page = running.page
    await createChapter(page, '查找短章', [{ text: '林舟推门进来。Lin 说：林舟，你来了。' }, { text: '***' }, { text: '林舟没有回答。' }])
    await openFresh(page, '查找短章', '林舟没有回答')
    await page.locator('.manuscript-editor').click()
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('Control+f')
    const input = page.getByLabel('查找', { exact: true })
    await input.waitFor()
    await input.fill('林舟')
    await page.getByTestId('find-count').filter({ hasText: '第 1 / 共 3 处' }).waitFor()
    await input.press('Enter')
    assert.equal(await findCount(page), '第 2 / 共 3 处')
    await input.press('Shift+Enter'); await input.press('Shift+Enter')
    assert.equal(await findCount(page), '第 3 / 共 3 处', 'Shift+Enter 从第 1 处回绕到最后')
    assert.equal(await page.evaluate(() => CSS.highlights.get('find-hit')?.size), 2, '其余命中高亮')
    await input.fill('lin')
    await page.getByTestId('find-count').filter({ hasText: '共 1 处' }).waitFor()
    await page.getByLabel('正则').check()
    await input.fill('(林')
    await page.getByRole('alert').filter({ hasText: '正则有误' }).waitFor()
    await input.fill('林.')
    await page.getByTestId('find-count').filter({ hasText: '共 3 处' }).waitFor()
    await input.press('Escape')
    await page.getByTestId('find-panel').waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => CSS.highlights.has('find-hit')), false, '关闭后清除高亮')
  })

  await record('P3 替换：替换当前一处、全部替换后一次 Ctrl+Z 恢复，并经现有保存路径落盘', async () => {
    const page = running.page
    const chapterId = await createChapter(page, '替换短章', [{ text: '林舟推门。林舟坐下。' }, { text: '林舟没有回答。' }])
    await openFresh(page, '替换短章', '林舟没有回答')
    const original = await editorText(page)
    await page.locator('.manuscript-editor').click()
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('Control+h')
    await page.getByLabel('查找', { exact: true }).fill('林舟')
    await page.getByTestId('find-count').filter({ hasText: '第 1 / 共 3 处' }).waitFor()
    await page.getByLabel('替换为').fill('沈砚')
    await page.getByRole('button', { name: '替换当前' }).click()
    await page.getByTestId('find-count').filter({ hasText: '第 1 / 共 2 处' }).waitFor()
    assert.equal(await editorText(page), '沈砚推门。林舟坐下。\n林舟没有回答。')
    await page.getByRole('button', { name: '全部替换' }).click()
    await page.getByTestId('find-notice').filter({ hasText: '已替换 2 处' }).waitFor()
    await page.getByTestId('find-count').filter({ hasText: '无匹配' }).waitFor()
    assert.equal(await editorText(page), '沈砚推门。沈砚坐下。\n沈砚没有回答。')
    await waitSaved(page)
    const saved = await page.evaluate(async ({ projectId, chapterId }) => (await window.workspace.documents.get(projectId, chapterId)).plainText, { projectId: ids.projectId, chapterId })
    assert.ok(!saved.includes('林舟'), '全部替换经保存路径落盘')
    await page.getByLabel('查找', { exact: true }).press('Escape')
    await page.keyboard.press('Control+z')
    assert.equal(await editorText(page), '沈砚推门。林舟坐下。\n林舟没有回答。', '一次撤销恢复全部替换')
    await page.keyboard.press('Control+z')
    assert.equal(await editorText(page), original, '再一次撤销恢复「替换当前」')
    await waitSaved(page)
  })

  await record('P3 本章大纲：列出标题与场景分隔（带预览），点击跳转并放置光标', async () => {
    const page = running.page
    const filler = '风从山口吹下来，雨点打在窗上。'.repeat(40)
    const blocks = [{ heading: 2, text: '一、夜行' }, ...Array.from({ length: 60 }, () => ({ text: filler })), { text: '◇' }, { text: '天亮时他回到旧宅。' }, ...Array.from({ length: 60 }, () => ({ text: filler })), { text: '* * *' }, { text: '尾声的第一句话。' }]
    await createChapter(page, '大纲长章', blocks)
    await openFresh(page, '大纲长章', '一、夜行')
    await page.getByRole('button', { name: '章内大纲', exact: true }).click()
    const panel = page.getByTestId('chapter-headings')
    await panel.waitFor()
    const entries = await panel.locator('li button').allInnerTexts()
    assert.equal(entries.length, 3)
    assert.match(entries[1], /场景 ◇[\s\S]*天亮时他回到旧宅/)
    await panel.locator('li button', { hasText: '尾声的第一句话' }).click()
    // revealPos 是逐帧校正的异步滚动（最多 4 帧），等它稳定后再读位置
    const target = await page.waitForFunction(() => {
      const selection = window.getSelection()
      const block = selection.anchorNode?.parentElement?.closest('.manuscript-editor > *')
      const scroller = document.querySelector('.writing-scroll').getBoundingClientRect()
      const rect = block?.getBoundingClientRect()
      const visible = Boolean(rect && rect.top >= scroller.top && rect.bottom <= scroller.bottom)
      return visible ? { text: block.textContent, visible } : false
    }, undefined, { timeout: 5_000 }).then((handle) => handle.jsonValue()).catch(async () => page.evaluate(() => {
      const block = window.getSelection().anchorNode?.parentElement?.closest('.manuscript-editor > *')
      return { text: block?.textContent, visible: false, rect: JSON.stringify(block?.getBoundingClientRect()), scroller: JSON.stringify(document.querySelector('.writing-scroll').getBoundingClientRect()), scrollTop: document.querySelector('.writing-scroll').scrollTop }
    }))
    assert.equal(target.text, '尾声的第一句话。', '光标放在分隔后的正文')
    assert.ok(target.visible, `跳转后目标段在可视区：${JSON.stringify(target)}`)
    await page.keyboard.type('Z')
    await page.locator('.manuscript-editor p', { hasText: 'Z尾声的第一句话' }).waitFor()
    await waitSaved(page)
    await page.getByRole('button', { name: '关闭本章大纲' }).click()
  })

  await record('P3 小黑屋内查找 / 大纲可用，网络 0', async () => {
    const page = running.page
    await openFresh(page, '大纲长章', '一、夜行')
    await enterBlackroom(page, async (d) => { await d.getByLabel('写满字数').check(); await d.getByLabel('目标字数').fill('1000') })
    const before = await snapshotNetwork(page)
    await page.locator('.manuscript-editor').click()
    await page.keyboard.press('Control+f')
    await page.getByLabel('查找', { exact: true }).fill('天亮时')
    await page.getByTestId('find-count').filter({ hasText: '共 1 处' }).waitFor()
    await page.getByLabel('查找', { exact: true }).press('Escape')
    await page.getByRole('button', { name: '章内大纲', exact: true }).click()
    await page.getByTestId('chapter-headings').locator('li button', { hasText: '一、夜行' }).click()
    await page.getByRole('button', { name: '关闭本章大纲' }).click()
    // 全书查找（PR-2a）在小黑屋内同样可用：纯本地，点命中跳回本章并定位
    await page.getByRole('button', { name: '全书查找', exact: true }).click()
    await page.getByLabel('全书查找', { exact: true }).fill('天亮时')
    await page.locator('[data-testid="book-find-summary"][data-done="true"]').waitFor()
    const outlineGroup = page.getByTestId('book-find-group').filter({ hasText: '大纲长章' })
    await outlineGroup.locator('.book-find-hit').first().click()
    await page.getByTestId('find-count').filter({ hasText: '共 1 处' }).waitFor()
    assert.equal(await page.getByLabel('查找', { exact: true }).inputValue(), '天亮时', '跳转后章内查找预填查询')
    assert.equal(await page.evaluate(() => window.getSelection()?.toString()), '天亮时', '跳转后选中该处命中')
    await page.getByLabel('查找', { exact: true }).press('Escape')
    await page.waitForTimeout(500)
    const after = await snapshotNetwork(page)
    for (const key of Object.keys(before)) assert.equal(after[key] - before[key], 0, `小黑屋内查找/大纲 ${key} 网络应为 0`)
    await page.getByRole('button', { name: '紧急出口' }).click()
    await page.getByLabel('紧急出屋确认').fill('我要出屋')
    await page.getByRole('button', { name: '确认出屋' }).click()
    await page.getByTestId('blackroom-bar').waitFor({ state: 'detached' })
  })

  const findPerf = async (page, label, { enforceLimit = true, title, profile = false } = {}) => {
    const chapterId = await page.evaluate(async ({ projectId, title }) => (await window.workspace.documents.tree(projectId)).find((item) => item.title === title).id, { projectId: ids.projectId, title })
    const readSaved = () => page.evaluate(async ({ projectId, chapterId }) => { const doc = await window.workspace.documents.get(projectId, chapterId); return { revision: doc.revision, plainText: doc.plainText } }, { projectId: ids.projectId, chapterId })
    const original = await readSaved()
    await page.locator('.manuscript-editor').click()
    await page.keyboard.press('Control+Home')
    const openMs = await timeFindStep(page, 'open')
    // 跳到段末唯一命中（光标在开头，需滚过整章）；再查 1000 处并从第 1 处 Shift+Enter 回绕到第 1000 处
    await timeFindStep(page, 'input', { query: '砚台石', expect: 1 })
    const endMs = await timeFindStep(page, 'next')
    const inputMs = await timeFindStep(page, 'input', { query: '远处星' })
    const jumpMs = await timeFindStep(page, 'prev')
    await page.getByLabel('替换为').fill('远处月')
    const replaceMs = await timeFindStep(page, 'replaceAll')
    process.stdout.write(`P3 find ${label}: open ${openMs.toFixed(1)}ms, input ${inputMs.toFixed(1)}ms, jump-to-end ${endMs.toFixed(1)}ms, jump-wrap-to-1000 ${jumpMs.toFixed(1)}ms, replace-all 1000 ${replaceMs.toFixed(1)}ms (limit 1000ms${enforceLimit ? '' : '; replace-all record only'})\n`)
    // 跳转（段末、回绕）在所有长章里都 ≤1s；含格式长段落的全部替换只记录
    const limited = [['打开', openMs], ['输入后刷新', inputMs], ['跳到段末', endMs], ['Shift+Enter 回绕到第 1000 处', jumpMs], ...(enforceLimit ? [['全部替换 1000 处', replaceMs]] : [])]
    for (const [name, ms] of limited) assert.ok(ms <= 1000, `${label} ${name} ${ms.toFixed(1)}ms 应 ≤1000ms`)
    await page.getByTestId('find-count').filter({ hasText: '无匹配' }).waitFor()
    const replaced = await page.evaluate(() => document.querySelector('.manuscript-editor').textContent)
    assert.equal((replaced.match(/远处月/g) ?? []).length, 1000, '1000 处全部替换')
    assert.equal((replaced.match(/远处星/g) ?? []).length, 0)
    await page.getByLabel('查找', { exact: true }).press('Escape')
    // 撤销后保存诊断：记录保存状态字每次变化（dirty → saving = 保存请求发出；saving → 其他 = 请求返回）、撤销完成时间、库里 revision
    await page.evaluate(() => {
      const t0 = performance.now(); const trace = [{ t: 0, event: 'undo-key' }]
      const indicator = () => document.querySelector('.save-indicator')
      const stateOf = () => { const el = indicator(); return el ? `${[...el.classList].filter((c) => c !== 'save-indicator').join('.')}:${el.textContent}` : 'missing' }
      let last = stateOf(); trace.push({ t: 0, event: `state ${last}` })
      const observer = new MutationObserver(() => { const now = stateOf(); if (now !== last) { last = now; trace.push({ t: Math.round(performance.now() - t0), event: `state ${now}` }) } })
      observer.observe(document.querySelector('.editor-toolbar'), { subtree: true, attributes: true, childList: true, characterData: true })
      // 主线程长任务（>50ms）：区分「保存计时器被阻塞」与保存本身慢
      const longTasks = new PerformanceObserver((list) => { for (const e of list.getEntries()) trace.push({ t: Math.round(e.startTime - t0), event: `longtask ${Math.round(e.duration)}ms` }) })
      try { longTasks.observe({ type: 'longtask' }) } catch { trace.push({ t: 0, event: 'longtask-unsupported' }) }
      window.__p3SaveTrace = { t0, trace, observer, longTasks }
    })
    const savedBeforeUndo = await readSaved()
    let saveError
    const undoAndSave = async () => {
      await page.keyboard.press('Control+z')
      await page.waitForFunction(() => (document.querySelector('.manuscript-editor').textContent.match(/远处星/g) ?? []).length === 1000, undefined, { timeout: 30_000 })
      await page.evaluate(() => { const d = window.__p3SaveTrace; d.trace.push({ t: Math.round(performance.now() - d.t0), event: 'undo-done' }) })
      await waitSaved(page).catch((error) => { saveError = error })
    }
    if (profile) await cpuProfile(page, `find-undo ${label}`, undoAndSave); else await undoAndSave()
    assert.equal(await page.evaluate(() => (document.querySelector('.manuscript-editor').textContent.match(/远处月/g) ?? []).length), 0, '一次撤销完全恢复')
    const trace = await page.evaluate(() => { const d = window.__p3SaveTrace; d.observer.disconnect(); d.longTasks.disconnect(); d.trace.sort((x, y) => x.t - y.t); d.trace.push({ t: Math.round(performance.now() - d.t0), event: 'diag-end' }); return d.trace })
    const savedAfter = await readSaved()
    const events = trace.map((item) => item.event)
    const undoAt = trace.findIndex((item) => item.event === 'undo-done')
    const sentAfterUndo = trace.slice(1).some((item) => item.event.startsWith('state saving'))
    const lastState = [...events].reverse().find((event) => event.startsWith('state ')) ?? ''
    const dbMatches = savedAfter.plainText === original.plainText
    const verdict = !saveError ? 'ok' : !sentAfterUndo ? '没触发保存' : lastState.startsWith('state saving') ? '保存慢（请求未返回）' : dbMatches ? '已保存但状态字没更新' : `保存返回但库内容不符（${lastState}）`
    process.stdout.write(`P3 save-diag ${label}: verdict=${verdict}; revision before-undo=${savedBeforeUndo.revision} after=${savedAfter.revision}; db==original ${dbMatches}; undo-done index ${undoAt}; trace ${JSON.stringify(trace)}\n`)
    if (saveError) throw saveError
    const saveSentMs = trace.find((item) => item.event.startsWith('state saving'))?.t ?? Infinity
    process.stdout.write(`P3 undo→save-sent ${label}: ${saveSentMs}ms (limit 2000ms)\n`)
    assert.ok(saveSentMs <= 2000, `${label} 撤销到保存请求发出 ${saveSentMs}ms，应 ≤2s（不被渲染长任务推迟）`)
    assert.equal(savedAfter.plainText, original.plainText, `${label} 撤销后落盘内容与替换前一致`)
    assert.ok(savedAfter.revision > savedBeforeUndo.revision, '撤销经保存路径落盘（revision 前进）')
    return { openMs, inputMs, jumpMs, replaceMs }
  }
  // 5852 句里恰好 1000 句的「远处灯」换成「远处星」
  const perfSentences = Array.from({ length: 5852 }, (_, i) => Math.floor((i + 1) * 1000 / 5852) > Math.floor(i * 1000 / 5852) ? seg34.replace('远处灯', '远处星') : seg34)

  await record('P3 性能：19.9 万字单段（分块）查找打开 / 输入刷新 / 跳转 / 全部替换 1000 处各 ≤1s，撤销一步恢复', async () => {
    const page = running.page
    const viewport = page.viewportSize()
    await page.setViewportSize({ width: 1600, height: 900 })
    await createChapter(page, '查找单段长章', [{ text: perfSentences.join('') + '末尾砚台石。' }])
    await openFresh(page, '查找单段长章', '林舟在会上说')
    await findPerf(page, 'single paragraph 198968 chars', { title: '查找单段长章' })
    if (viewport) await page.setViewportSize(viewport)
  })

  await record('P3 性能：多段长章（5852 段）查找打开 / 输入刷新 / 跳转 / 全部替换 1000 处各 ≤1s，撤销一步恢复', async () => {
    const page = running.page
    const viewport = page.viewportSize()
    await page.setViewportSize({ width: 1600, height: 900 })
    await createChapter(page, '查找多段长章', [...perfSentences.map((text) => ({ text })), { text: '末尾砚台石。' }])
    await openFresh(page, '查找多段长章', '林舟在会上说')
    await findPerf(page, 'multi paragraph 5852 blocks', { title: '查找多段长章' })
    if (viewport) await page.setViewportSize(viewport)
  })

  await record('P3 性能：含粗体的 19.9 万字长段落查找打开 / 刷新 / 跳到段末 / Shift+Enter 回绕到第 1000 处各 ≤1s；全部替换 1000 处（逐处慢路径）只记录耗时，断言正确与一次撤销恢复', async () => {
    const page = running.page
    const viewport = page.viewportSize()
    await page.setViewportSize({ width: 1600, height: 900 })
    // 每 100 句插一处粗体：段落含多个带格式文本节点，不走单文本节点批量路径，也不分块
    const content = perfSentences.map((text, i) => i % 100 === 0 ? { type: 'text', text, marks: [{ type: 'bold' }] } : { type: 'text', text })
    const merged = []
    for (const item of content) { const last = merged.at(-1); if (last && !last.marks && !item.marks) last.text += item.text; else merged.push({ ...item }) }
    merged.at(-1).text += '末尾砚台石。'
    await page.evaluate(async ({ projectId, merged }) => {
      const tree = await window.workspace.documents.tree(projectId)
      const volume = tree.find((item) => item.type === 'volume')
      const node = await window.workspace.documents.create({ projectId, parentId: volume.id, type: 'chapter', title: '查找粗体长段' })
      await window.workspace.documents.save({ projectId, documentId: node.id, editorJson: { type: 'doc', content: [{ type: 'paragraph', content: merged }] }, plainText: merged.map((item) => item.text).join(''), expectedRevision: 0 })
    }, { projectId: ids.projectId, merged })
    await openFresh(page, '查找粗体长段', '林舟在会上说')
    assert.ok(await page.locator('.manuscript-editor strong').count() > 0, '段内确有粗体')
    await findPerf(page, 'bold long paragraph (record only)', { enforceLimit: false, title: '查找粗体长段', profile: true })
    // 对照：同一粗体长段，不开查找面板，普通编辑后撤销
    await openFresh(page, '查找粗体长段', '林舟在会上说')
    await undoSaveControl(page, 'bold long paragraph pr39', '末尾砚台石。')
    if (viewport) await page.setViewportSize(viewport)
  })

  await record('P3 全书查找：1000 章按章分组，首批分组可见 ≤1s、全量 ≤5s、搜索期间单个主线程任务 ≤200ms；超 10 万处截断并禁用；点命中定位', async () => {
    const page = running.page
    const mainTitle = await page.evaluate(async (projectId) => (await window.workspace.projects.list(true)).find((item) => item.id === projectId).title, ids.projectId)
    // 1000 章 × 约 3000 字（88 句 × 34 字），每章 10 处「远处星」；只有第 997 章含「砚台石」
    const book = await page.evaluate(async (seg) => {
      const project = await window.workspace.projects.create({ title: '全书查找千章', projectType: 'novel', description: '' })
      const tree = await window.workspace.documents.tree(project.id)
      const volume = tree.find((item) => item.type === 'volume')
      const started = performance.now()
      for (let n = 1; n <= 1000; n += 1) {
        const sentences = Array.from({ length: 88 }, (_, i) => i % 9 === 0 && i < 90 ? seg.replace('远处灯', '远处星') : seg)
        if (n === 997) sentences[40] = sentences[40].replace('夜色', '砚台石')
        const text = sentences.join('')
        const node = await window.workspace.documents.create({ projectId: project.id, parentId: volume.id, type: 'chapter', title: `第${n}章` })
        await window.workspace.documents.save({ projectId: project.id, documentId: node.id, editorJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }, plainText: text, expectedRevision: 0 })
      }
      return { id: project.id, seedMs: Math.round(performance.now() - started) }
    }, seg34)
    await page.reload()
    await page.locator('.work-row', { hasText: '全书查找千章' }).getByRole('button', { name: '继续写作' }).click()
    await page.getByRole('navigation', { name: '作品内容区' }).getByRole('button', { name: '全书查找' }).click()
    const input = page.getByLabel('全书查找', { exact: true })
    await input.waitFor()
    // 页面内计时：从输入事件起（含 150ms 去抖），到首个分组出现 / 全部完成；同时记录主线程长任务
    const timeBookFind = (query) => page.evaluate(async (query) => {
      const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()))
      const longTasks = []
      const observer = new PerformanceObserver((list) => { for (const entry of list.getEntries()) longTasks.push(Math.round(entry.duration)) })
      observer.observe({ type: 'longtask' })
      const el = document.querySelector('input[aria-label="全书查找"]')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      const started = performance.now()
      setter.call(el, query); el.dispatchEvent(new Event('input', { bubbles: true }))
      let firstMs
      while (true) {
        if (firstMs === undefined && document.querySelector('[data-testid="book-find-group"]')) firstMs = performance.now() - started
        if (document.querySelector('[data-testid="book-find-summary"][data-done="true"]') && firstMs !== undefined) break
        if (performance.now() - started > 60_000) throw new Error('book find timeout')
        await frame()
      }
      const doneMs = performance.now() - started
      await frame(); await frame()
      observer.disconnect()
      return { firstMs: Math.round(firstMs), doneMs: Math.round(doneMs), maxLongTask: longTasks.length ? Math.max(...longTasks) : 0, longTasks: longTasks.length,
        summary: document.querySelector('[data-testid="book-find-summary"]').textContent, groups: document.querySelectorAll('[data-testid="book-find-group"]').length }
    }, query)
    const all = await timeBookFind('远处星')
    process.stdout.write(`P3 book-find 1000 chapters: seed ${book.seedMs}ms; first-group ${all.firstMs}ms (limit 1000ms), done ${all.doneMs}ms (limit 5000ms), max long task ${all.maxLongTask}ms over ${all.longTasks} (limit 200ms); ${all.summary}\n`)
    assert.equal(all.summary, '1000 章 · 共 10,000 处')
    assert.equal(all.groups, 200, '一次只渲染前 200 章')
    assert.ok(all.firstMs <= 1000, `首批分组可见 ${all.firstMs}ms 应 ≤1s`)
    assert.ok(all.doneMs <= 5000, `全量搜索 ${all.doneMs}ms 应 ≤5s`)
    assert.ok(all.maxLongTask <= 200, `搜索期间最长主线程任务 ${all.maxLongTask}ms 应 ≤200ms`)
    // 截断：「狠狠」每章 176 处 × 1000 = 17.6 万处 > 10 万
    const over = await timeBookFind('狠狠')
    process.stdout.write(`P3 book-find truncated: done ${over.doneMs}ms, max long task ${over.maxLongTask}ms; ${over.summary}\n`)
    assert.match(over.summary, /共 100,000 处.*请缩小查找范围/)
    assert.equal(await page.getByRole('button', { name: /替换/ }).count(), 0, '2a 没有替换入口')
    // 唯一命中：第 997 章，点击跳转并定位
    const one = await timeBookFind('砚台石')
    process.stdout.write(`P3 book-find single hit: done ${one.doneMs}ms, max long task ${one.maxLongTask}ms; ${one.summary}\n`)
    assert.equal(one.summary, '1 章 · 共 1 处')
    await page.getByTestId('book-find-group').filter({ hasText: '第997章' }).locator('.book-find-hit').click()
    await page.getByTestId('find-count').filter({ hasText: '第 1 / 共 1 处' }).waitFor()
    assert.equal(await page.evaluate(() => window.getSelection()?.toString()), '砚台石')
    await page.getByLabel('查找', { exact: true }).press('Escape')
    // 收尾：归档千章书，回到主作品
    await page.evaluate((id) => window.workspace.projects.archive(id, true), book.id)
    await page.reload()
    await page.locator('.work-row', { hasText: mainTitle }).getByRole('button', { name: '继续写作' }).click()
    await page.locator('.manuscript-editor').waitFor()
  })

  await record('F15 ⑫ 锁定可见性：作品库 / 其他作品显示被锁书名与回去入口；AI 报错带书名无前缀；Esc 只关紧急出口对话框', async () => {
    const page = running.page
    const other = await page.evaluate(() => window.workspace.projects.create({ title: '旁边的书', projectType: 'novel', description: '' }))
    const lockedTitle = await page.evaluate(async (projectId) => (await window.workspace.projects.list(true)).find((item) => item.id === projectId).title, ids.projectId)
    await enterBlackroom(page, async (d) => { await d.getByLabel('写满字数').check(); await d.getByLabel('目标字数').fill('1000') })
    let before = await snapshotNetwork(page)
    // 在被锁的书里不显示「其他书被锁」提示
    assert.equal(await page.getByTestId('focus-lock-notice').count(), 0)
    // Esc：只关闭紧急出口对话框，仍在小黑屋（焦点在输入框里、以及输入一半时都试一次）
    for (const typed of ['', '我要']) {
      await page.getByRole('button', { name: '紧急出口' }).click()
      const input = page.getByLabel('紧急出屋确认')
      await input.waitFor()
      if (typed) await input.fill(typed)
      await page.keyboard.press('Escape')
      await page.getByRole('dialog', { name: '紧急出屋' }).waitFor({ state: 'detached', timeout: 3_000 })
      assert.equal(await page.getByTestId('blackroom-bar').count(), 1, 'Esc 关闭对话框后仍应在小黑屋')
      assert.equal((await page.evaluate((projectId) => window.workspace.focus.status(projectId), ids.projectId)).locked, true, 'Esc 不应解锁')
    }
    await addLockedDelta(page, before)
    // 回到作品库（重新载入界面 = 从作品库开始）
    await page.reload()
    before = await snapshotNetwork(page)
    const libraryNotice = page.getByTestId('focus-lock-notice')
    await libraryNotice.waitFor()
    assert.match(await libraryNotice.innerText(), new RegExp(`《${lockedTitle}》正在小黑屋中`))
    // 打开另一本书：提示仍在，AI 报错带书名、无前缀
    await page.locator('.work-row', { hasText: '旁边的书' }).getByRole('button', { name: '继续写作' }).click()
    await page.locator('.assistant-panel').waitFor()
    await page.getByTestId('focus-lock-notice').waitFor()
    assert.match(await page.getByTestId('focus-lock-notice').innerText(), new RegExp(`《${lockedTitle}》`))
    await page.getByRole('button', { name: '理解本章' }).click()
    const digestError = page.locator('.message-content', { hasText: '章节理解失败' })
    await digestError.waitFor({ timeout: 5_000 })
    const digestText = await digestError.innerText()
    assert.ok(digestText.includes(`章节理解失败：《${lockedTitle}》正在小黑屋中`), `理解本章报错应带书名且无前缀，实际 ${digestText}`)
    assert.doesNotMatch(digestText, /FocusLockError|Error invoking/)
    await page.getByPlaceholder('和同行者聊聊这部作品…').fill('锁定时在另一本书里提问')
    await page.getByRole('button', { name: '发送' }).click()
    const chatError = page.locator('.message-content', { hasText: '正在小黑屋中' }).last()
    await page.waitForFunction(() => [...document.querySelectorAll('.message-content')].filter((node) => node.textContent?.includes('正在小黑屋中')).length >= 2, null, { timeout: 5_000 })
    const chatText = await chatError.innerText()
    assert.ok(chatText.startsWith(`《${lockedTitle}》正在小黑屋中`), `对话报错应带书名且无前缀，实际 ${chatText}`)
    assert.doesNotMatch(chatText, /FocusLockError|FOCUS_LOCKED/)
    // 回去入口：跳回被锁那本书的小黑屋，在那里出屋
    await page.getByTestId('focus-lock-return').click()
    await page.getByTestId('blackroom-bar').waitFor()
    assert.equal(await page.getByTestId('focus-lock-notice').count(), 0)
    assert.equal(await page.locator('.assistant-panel').count(), 0)
    await page.getByRole('button', { name: '紧急出口' }).click()
    await page.getByLabel('紧急出屋确认').fill('我要出屋')
    await addLockedDelta(page, before)
    await page.getByRole('button', { name: '确认出屋' }).click()
    await page.locator('.assistant-panel').waitFor()
    assert.deepEqual(await page.evaluate(() => window.workspace.focus.lockedProjects()), [])
    await page.evaluate((id) => window.workspace.projects.archive(id, true), other.id)
  })

  await record('F15 ⑩ 锁定期间网络请求为 0（主进程 fixture 命中 / 渲染进程请求 / 拦截日志）', async () => {
    process.stdout.write(`F15 locked network deltas: ${JSON.stringify(lockedNetwork)}\n`)
    assert.deepEqual(lockedNetwork, { fixture: 0, anthropic: 0, renderer: 0, blocked: 0 })
    // 对照：出屋后同一 Provider 测试连接确实会出网（计数手段有效）
    const hits = fixtureHits + anthropicRequests.length
    await running.page.evaluate(async () => { const [provider] = await window.workspace.providers.list(); const [model] = await window.workspace.providers.models(); await window.workspace.providers.test(provider.id, model.modelId) })
    assert.ok(fixtureHits + anthropicRequests.length > hits, '出屋后测试连接应命中 fixture（证明计数器有效）')
  })

  process.stdout.write(`Electron E2E: ${results.length} passed\n`)
} finally {
  if (running?.app) await running.app.close().catch(() => {})
  fixture.close()
  anthropicFixture.close()
  await rm(userData, { recursive: true, force: true })
}
