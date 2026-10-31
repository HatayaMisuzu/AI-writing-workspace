import { Check, Plus, Save, Server, TestTube2, XCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ModelConfig, ProviderConfig, ProviderType, RoutedTask } from '../../../shared/domain'
import { SETTINGS_PROJECT_HINTS } from '../services/settings-hints'
import { baseUrlAfterProviderSave, isProviderSaveCancelledMessage } from '../services/provider-save-revert'
import { userErrorMessage } from '../../../shared/user-error'
import { BASE_URL_QUERY_SECRET_HINT, checkBaseUrl, hasSecretQuery } from '../../../shared/base-url'
import {
  DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT, PROVIDER_PRESETS, defaultTimeoutsForBaseUrl, isLocalBaseUrl, type ProviderPreset
} from '../../../shared/provider-presets'

const defaultCapabilities = { streaming: true, tools: false, structuredOutput: false, cancellation: true }
const routedTasks: Array<[RoutedTask, string]> = [
  ['discussion', '讨论'], ['brainstorm', '脑暴'], ['generation', '续写'], ['editing', '修改'],
  ['organization', '整理 / 一致性检查'], ['chapter_digest', '章节理解'], ['proofreading', '校对']
]
const emptyRoutes = Object.fromEntries(routedTasks.map(([task]) => [task, 'default'])) as Record<RoutedTask, string | 'default'>
const capabilityLabel = (capabilities: ModelConfig['capabilities']): string => [
  capabilities.streaming ? '流式' : undefined, capabilities.cancellation ? '可取消' : undefined
].filter(Boolean).join(' · ')

type ProviderForm = {
  providerType: ProviderType; displayName: string; baseUrl: string; apiKey: string
  firstTokenTimeoutMs: string; totalTimeoutMs: string
}

const blankForm = (): ProviderForm => ({
  providerType: 'openai-compatible', displayName: 'OpenAI-compatible', baseUrl: '', apiKey: '', firstTokenTimeoutMs: '', totalTimeoutMs: ''
})

const formFromProvider = (selected: ProviderConfig): ProviderForm => ({
  providerType: selected.providerType, displayName: selected.displayName, baseUrl: selected.baseUrl, apiKey: '',
  firstTokenTimeoutMs: selected.firstTokenTimeoutMs ? String(selected.firstTokenTimeoutMs) : '',
  totalTimeoutMs: selected.totalTimeoutMs ? String(selected.totalTimeoutMs) : ''
})

const formFromPreset = (preset: ProviderPreset): ProviderForm => {
  const timeouts = preset.baseUrl ? defaultTimeoutsForBaseUrl(preset.baseUrl) : defaultTimeoutsForBaseUrl('http://localhost')
  return {
    providerType: 'openai-compatible', displayName: preset.displayName, baseUrl: preset.baseUrl, apiKey: '',
    firstTokenTimeoutMs: String(timeouts.firstTokenTimeoutMs),
    totalTimeoutMs: String(timeouts.totalTimeoutMs)
  }
}

export function SettingsScreen(): React.JSX.Element {
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [models, setModels] = useState<ModelConfig[]>([])
  const [routes, setRoutes] = useState<Record<RoutedTask, string | 'default'>>(emptyRoutes)
  const [selectedId, setSelectedId] = useState<string>()
  const selected = providers.find((item) => item.id === selectedId)
  const [form, setForm] = useState<ProviderForm>(blankForm)
  const [model, setModel] = useState({ modelId: '', displayName: '', contextWindow: String(DEFAULT_CONTEXT_WINDOW), maxOutput: String(DEFAULT_MAX_OUTPUT) })
  const [notice, setNotice] = useState<{ ok: boolean; text: string }>()
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async (): Promise<void> => {
    const [nextProviders, nextModels, nextRoutes] = await Promise.all([
      window.workspace.providers.list(), window.workspace.providers.models(), window.workspace.providers.routes()
    ])
    setProviders(nextProviders); setModels(nextModels); setRoutes(nextRoutes)
    setSelectedId((current) => current ?? nextProviders[0]?.id)
  }, [])
  useEffect(() => { void reload().catch((error) => setNotice({ ok: false, text: `读取配置失败：${String(error)}` })) }, [reload])
  useEffect(() => { if (selected) setForm(formFromProvider(selected)) }, [selected])

  const timeoutHints = useMemo(() => defaultTimeoutsForBaseUrl(form.baseUrl || 'https://example.com/v1'), [form.baseUrl])
  const localKeyOk = isLocalBaseUrl(form.baseUrl)

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try { await action() }
    catch (error) { setNotice({ ok: false, text: `操作失败：${userErrorMessage(error)}` }) }
    finally { setBusy(false) }
  }
  const saveProvider = (): Promise<void> => run(async () => {
    if (!form.displayName.trim() || !form.baseUrl.trim()) throw new Error('请填写服务名称和 Base URL。')
    const urlCheck = checkBaseUrl(form.baseUrl)
    if (!urlCheck.ok) throw new Error(urlCheck.message)
    if (!form.apiKey && !localKeyOk && !selected?.hasApiKey) throw new Error('远端服务需要填写 API Key。本地服务（localhost）可留空。')
    const id = selectedId ?? crypto.randomUUID()
    const firstTokenTimeoutMs = form.firstTokenTimeoutMs.trim() ? Number(form.firstTokenTimeoutMs) : undefined
    const totalTimeoutMs = form.totalTimeoutMs.trim() ? Number(form.totalTimeoutMs) : undefined
    if (firstTokenTimeoutMs !== undefined && (!Number.isFinite(firstTokenTimeoutMs) || firstTokenTimeoutMs <= 0)) throw new Error('首 token 超时须为正整数毫秒。')
    if (totalTimeoutMs !== undefined && (!Number.isFinite(totalTimeoutMs) || totalTimeoutMs <= 0)) throw new Error('总超时须为正整数毫秒。')
    try {
      await window.workspace.providers.save({
        id, providerType: form.providerType, displayName: form.displayName, baseUrl: form.baseUrl,
        apiKey: form.apiKey || undefined, firstTokenTimeoutMs, totalTimeoutMs
      })
    } catch (error) {
      // A·M1：作者在确认框里点了「取消」——不是故障，配置保持原样
      if (isProviderSaveCancelledMessage(userErrorMessage(error))) {
        // 配置没变：地址栏回到已保存的值（只回滚地址栏，其他字段保持作者输入）
        const savedBaseUrl = selected?.baseUrl
        setForm((current) => ({ ...current, baseUrl: baseUrlAfterProviderSave('cancelled', current.baseUrl, savedBaseUrl) }))
        setNotice({ ok: false, text: '已取消保存，服务配置未改动。' }); return
      }
      // 其他失败：地址栏保持作者新填的值（baseUrlAfterProviderSave('failed', …) 即原值），方便修改
      throw error
    }
    setSelectedId(id)
    setNotice({ ok: true, text: hasSecretQuery(form.baseUrl) ? `服务配置已安全保存到本机。${BASE_URL_QUERY_SECRET_HINT}` : '服务配置已安全保存到本机。' })
    await reload()
  })
  const saveModel = (): Promise<void> => run(async () => {
    if (!selectedId) throw new Error('请先保存一个服务。')
    if (!model.modelId.trim()) throw new Error('请填写 Model ID。')
    const contextWindow = Number(model.contextWindow) || DEFAULT_CONTEXT_WINDOW
    const maxOutput = Number(model.maxOutput) || DEFAULT_MAX_OUTPUT
    if (contextWindow <= 0 || maxOutput <= 0) throw new Error('上下文窗口与最大输出须为正整数。')
    await window.workspace.providers.saveModel({
      id: crypto.randomUUID(), providerId: selectedId, modelId: model.modelId.trim(),
      displayName: model.displayName.trim() || model.modelId.trim(),
      capabilities: { ...defaultCapabilities, maxContextTokens: contextWindow },
      enabled: true, isDefault: !models.some((item) => item.isDefault && item.enabled),
      contextWindow, maxOutput
    })
    setModel({ modelId: '', displayName: '', contextWindow: String(DEFAULT_CONTEXT_WINDOW), maxOutput: String(DEFAULT_MAX_OUTPUT) })
    setNotice({ ok: true, text: '模型已添加。' }); await reload()
  })
  const test = (): Promise<void> => run(async () => {
    const activeModel = models.find((item) => item.providerId === selectedId && item.enabled)
    const draftModelId = activeModel?.modelId || model.modelId.trim()
    if (!form.baseUrl.trim()) throw new Error('请填写 Base URL。')
    const urlCheck = checkBaseUrl(form.baseUrl)
    if (!urlCheck.ok) throw new Error(urlCheck.message)
    if (!draftModelId) throw new Error('请先填写 Model ID，或保存服务并添加已启用模型。')
    const savedSame = Boolean(selectedId && selected && !selected.baseUrlError && form.baseUrl === selected.baseUrl && form.providerType === selected.providerType)
    const result = savedSame && selectedId && activeModel
      ? await window.workspace.providers.test(selectedId, activeModel.modelId)
      : await window.workspace.providers.testUrl({ baseUrl: form.baseUrl, apiKey: form.apiKey || undefined, modelId: draftModelId, providerType: form.providerType, providerId: selected ? selectedId : undefined })
    // A·M1：地址与上次保存不同时由 main 进程弹确认框；取消时不发请求
    if ('cancelled' in result && result.cancelled) { setNotice({ ok: false, text: result.message ?? '已取消测试连接，API Key 未发送。' }); return }
    setNotice({ ok: result.ok, text: result.ok ? '连接成功。' : `连接失败：${result.message ?? '未知错误'} 正文与本地保存不受影响。` })
  })
  const updateModel = (item: ModelConfig, changes: Partial<ModelConfig>): Promise<void> => run(async () => {
    await window.workspace.providers.saveModel({ ...item, ...changes }); await reload()
  })
  const updateRoute = (taskType: RoutedTask, modelId: string): Promise<void> => run(async () => {
    await window.workspace.providers.setRoute({ taskType, modelId }); await reload()
    setNotice({ ok: true, text: '任务模型路由已保存。' })
  })
  const applyPreset = (preset: ProviderPreset): void => {
    setSelectedId(undefined)
    setForm(formFromPreset(preset))
    setNotice({ ok: true, text: `已套用「${preset.label}」预设（未内置任何 Key）。` })
  }

  const enabledModels = models.filter((item) => item.enabled)
  const defaultModel = enabledModels.find((item) => item.isDefault)
  return <main className="settings-screen">
    <aside className="settings-nav"><div className="settings-nav-label">应用设置</div><button className="active"><Server size={18} />模型与服务</button><div className="settings-nav-label">作品内设置</div>{SETTINGS_PROJECT_HINTS.map((hint) => <p key={hint} className="settings-nav-hint" data-testid="settings-project-hint">{hint}</p>)}</aside>
    <section className="settings-content">
      <header>
        <h1>模型与服务</h1>
        <p>模型是可选能力。未配置时，写作、保存、检索、历史恢复与导出仍可正常使用。</p>
        <p className="privacy-note" role="note">正文会发送到你配置的地址；本地模型不出本机。</p>
      </header>
      <div className="provider-presets" aria-label="服务预设">
        <span className="presets-label">快速预设</span>
        {PROVIDER_PRESETS.map((preset) => <button key={preset.id} type="button" disabled={busy} onClick={() => applyPreset(preset)}>{preset.label}</button>)}
      </div>
      <div className="provider-layout">
        <aside className="provider-list"><h2>服务提供者</h2>{providers.map((provider) => <button key={provider.id} className={selectedId === provider.id ? 'active' : ''} onClick={() => setSelectedId(provider.id)}><Server size={16} /><span>{provider.displayName}</span>{provider.baseUrlError && <small className="provider-warning" title={provider.baseUrlError}>需修正地址</small>}</button>)}
          <button className="add-provider" onClick={() => { setSelectedId(undefined); setForm(blankForm()) }}><Plus size={16} />添加服务</button></aside>
        <div className="provider-form"><h2>{selected ? selected.displayName : '添加 API 服务'}</h2>
          <label><span>API 格式</span><select data-testid="provider-type" value={form.providerType} onChange={(event) => setForm({ ...form, providerType: event.target.value === 'anthropic' ? 'anthropic' : 'openai-compatible' })}><option value="openai-compatible">OpenAI-compatible（/chat/completions）</option><option value="anthropic">Anthropic Messages（/messages，max_tokens 取模型最大输出）</option></select></label>
          <label><span>显示名称</span><input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} /></label>
          <label><span>API Base URL</span><input value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} placeholder={form.providerType === 'anthropic' ? 'Anthropic 服务地址，含 /v1' : 'https://api.example.com/v1'} /></label>
          {form.baseUrl.trim() && !checkBaseUrl(form.baseUrl).ok ? <div className="inline-error" role="alert">{(checkBaseUrl(form.baseUrl) as { message: string }).message}</div>
            : hasSecretQuery(form.baseUrl) ? <div className="context-note" role="note">{BASE_URL_QUERY_SECRET_HINT}</div>
            : selected?.baseUrlError && form.baseUrl === selected.baseUrl ? <div className="inline-error" role="alert">需修正地址：{selected.baseUrlError} 原地址已隐藏，请重新填写地址，并在 Key 栏重新填写 Key 后再保存；在此之前不会发送任何请求。</div> : null}
          <label><span>API Key{localKeyOk ? '（本地可留空）' : ''}</span><input type="password" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} placeholder={selected?.hasApiKey ? '已安全保存；留空保持不变' : localKeyOk ? '本地服务可不填' : '仅在本机加密保存'} /></label>
          <div className="secure-note"><Check size={15} />密钥由操作系统安全存储，界面与日志无法读取明文。本地空 key 不写入安全存储。</div>
          <label><span>首 token 超时（毫秒）</span><input inputMode="numeric" value={form.firstTokenTimeoutMs} onChange={(event) => setForm({ ...form, firstTokenTimeoutMs: event.target.value })} placeholder={`默认 ${timeoutHints.firstTokenTimeoutMs}`} /></label>
          <label><span>总超时（毫秒）</span><input inputMode="numeric" value={form.totalTimeoutMs} onChange={(event) => setForm({ ...form, totalTimeoutMs: event.target.value })} placeholder={`默认 ${timeoutHints.totalTimeoutMs}`} /></label>
          <div className="form-actions"><button disabled={busy} onClick={() => void test()}><TestTube2 size={16} />测试连接</button><button className="primary" disabled={busy} onClick={() => void saveProvider()}><Save size={16} />保存服务</button></div>
        </div>
      </div>
      <section className="model-section"><div className="section-heading"><div><h2>模型</h2><p>当前默认：{defaultModel?.displayName ?? '尚未设置'} · 预算 = 窗口 − 最大输出 − 余量</p></div></div>
        <div className="model-head"><span>Model ID</span><span>显示名称</span><span>窗口</span><span>最大输出</span><span>能力</span><span>默认</span><span>状态</span></div>
        {models.filter((item) => item.providerId === selectedId).map((item) => <div className="model-row" key={item.id}>
          <strong>{item.modelId}</strong><span>{item.displayName}</span>
          <span>{item.contextWindow ?? item.capabilities.maxContextTokens ?? DEFAULT_CONTEXT_WINDOW}</span>
          <span>{item.maxOutput ?? DEFAULT_MAX_OUTPUT}</span>
          <small>{capabilityLabel(item.capabilities)}</small>
          <button disabled={!item.enabled || busy} className={item.isDefault ? 'default-model active' : 'default-model'} onClick={() => void updateModel(item, { isDefault: true })}>{item.isDefault ? '默认模型' : '设为默认'}</button>
          <button disabled={busy} onClick={() => void updateModel(item, { enabled: !item.enabled, isDefault: item.enabled ? false : item.isDefault })}>{item.enabled ? '停用' : '启用'}</button>
        </div>)}
        {selectedId && <div className="model-add">
          <input value={model.modelId} onChange={(event) => setModel({ ...model, modelId: event.target.value })} placeholder="Model ID" />
          <input value={model.displayName} onChange={(event) => setModel({ ...model, displayName: event.target.value })} placeholder="显示名称（可选）" />
          <input inputMode="numeric" value={model.contextWindow} onChange={(event) => setModel({ ...model, contextWindow: event.target.value })} placeholder="上下文窗口" title="context_window" />
          <input inputMode="numeric" value={model.maxOutput} onChange={(event) => setModel({ ...model, maxOutput: event.target.value })} placeholder="最大输出" title="max_output" />
          <button disabled={busy} onClick={() => void saveModel()}><Plus size={16} />添加模型</button>
        </div>}
      </section>
      <section className="routing-section"><details><summary>任务模型路由（高级）<span>默认全部使用默认模型；只有你主动指定时才覆盖</span></summary><div className="route-grid">{routedTasks.map(([task, label]) => <label key={task}><span>{label}</span><select value={routes[task]} disabled={busy} onChange={(event) => void updateRoute(task, event.target.value)}><option value="default">使用默认模型</option>{enabledModels.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>)}</div></details></section>
      {notice && <div className={notice.ok ? 'settings-notice ok' : 'settings-notice error'} role="status">{notice.ok ? <Check size={17} /> : <XCircle size={17} />}{notice.text}</div>}
    </section>
  </main>
}
