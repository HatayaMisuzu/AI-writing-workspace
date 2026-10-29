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
  running.app.process().kill('SIGKILL')
  await closed
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
    for (const [name, message] of Object.entries(rejected)) assert.match(message, /FOCUS_LOCKED/, `${name} 应返回 FOCUS_LOCKED，实际 ${message}`)
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
