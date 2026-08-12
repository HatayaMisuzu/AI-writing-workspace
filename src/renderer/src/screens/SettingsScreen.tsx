import { Check, Plus, Save, Server, TestTube2, XCircle } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { ModelConfig, ProviderConfig, RoutedTask } from '../../../shared/domain'

const defaultCapabilities = { streaming: true, tools: false, structuredOutput: false, cancellation: true }
const routedTasks: Array<[RoutedTask, string]> = [
  ['discussion', '讨论'], ['brainstorm', '脑暴'], ['generation', '续写'], ['editing', '修改'],
  ['organization', '整理'], ['chapter_digest', '章节理解'], ['proofreading', '校对']
]
const emptyRoutes = Object.fromEntries(routedTasks.map(([task]) => [task, 'default'])) as Record<RoutedTask, string | 'default'>
const capabilityLabel = (capabilities: ModelConfig['capabilities']): string => [
  capabilities.streaming ? '流式' : undefined, capabilities.cancellation ? '可取消' : undefined
].filter(Boolean).join(' · ')

export function SettingsScreen(): React.JSX.Element {
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [models, setModels] = useState<ModelConfig[]>([])
  const [routes, setRoutes] = useState<Record<RoutedTask, string | 'default'>>(emptyRoutes)
  const [selectedId, setSelectedId] = useState<string>()
  const selected = providers.find((item) => item.id === selectedId)
  const [form, setForm] = useState({ displayName: 'OpenAI-compatible', baseUrl: '', apiKey: '' })
  const [model, setModel] = useState({ modelId: '', displayName: '' })
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
  useEffect(() => { if (selected) setForm({ displayName: selected.displayName, baseUrl: selected.baseUrl, apiKey: '' }) }, [selected])

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try { await action() }
    catch (error) { setNotice({ ok: false, text: `操作失败：${error instanceof Error ? error.message : String(error)}` }) }
    finally { setBusy(false) }
  }
  const saveProvider = (): Promise<void> => run(async () => {
    if (!form.displayName.trim() || !form.baseUrl.trim()) throw new Error('请填写服务名称和 Base URL。')
    const id = selectedId ?? crypto.randomUUID()
    await window.workspace.providers.save({ id, providerType: 'openai-compatible', displayName: form.displayName, baseUrl: form.baseUrl, apiKey: form.apiKey || undefined })
    setSelectedId(id); setNotice({ ok: true, text: '服务配置已安全保存到本机。' }); await reload()
  })
  const saveModel = (): Promise<void> => run(async () => {
    if (!selectedId) throw new Error('请先保存一个服务。')
    if (!model.modelId.trim()) throw new Error('请填写 Model ID。')
    await window.workspace.providers.saveModel({ id: crypto.randomUUID(), providerId: selectedId, modelId: model.modelId.trim(),
      displayName: model.displayName.trim() || model.modelId.trim(), capabilities: defaultCapabilities, enabled: true,
      isDefault: !models.some((item) => item.isDefault && item.enabled) })
    setModel({ modelId: '', displayName: '' }); setNotice({ ok: true, text: '模型已添加。' }); await reload()
  })
  const test = (): Promise<void> => run(async () => {
    const activeModel = models.find((item) => item.providerId === selectedId && item.enabled)
    if (!selectedId || !activeModel) throw new Error('请先保存服务并添加至少一个已启用模型。')
    const result = await window.workspace.providers.test(selectedId, activeModel.modelId)
    setNotice({ ok: result.ok, text: result.ok ? '连接成功。' : `连接失败：${result.message ?? '未知错误'} 正文与本地保存不受影响。` })
  })
  const updateModel = (item: ModelConfig, changes: Partial<ModelConfig>): Promise<void> => run(async () => {
    await window.workspace.providers.saveModel({ ...item, ...changes }); await reload()
  })
  const updateRoute = (taskType: RoutedTask, modelId: string): Promise<void> => run(async () => {
    await window.workspace.providers.setRoute({ taskType, modelId }); await reload()
    setNotice({ ok: true, text: '任务模型路由已保存。' })
  })

  const enabledModels = models.filter((item) => item.enabled)
  const defaultModel = enabledModels.find((item) => item.isDefault)
  return <main className="settings-screen">
    <aside className="settings-nav"><div className="settings-nav-label">应用设置</div><button className="active"><Server size={18} />模型与服务</button></aside>
    <section className="settings-content">
      <header><h1>模型与服务</h1><p>模型是可选能力。未配置时，写作、保存、检索、历史恢复与导出仍可正常使用。</p></header>
      <div className="provider-layout">
        <aside className="provider-list"><h2>服务提供者</h2>{providers.map((provider) => <button key={provider.id} className={selectedId === provider.id ? 'active' : ''} onClick={() => setSelectedId(provider.id)}><Server size={16} /><span>{provider.displayName}</span></button>)}
          <button className="add-provider" onClick={() => { setSelectedId(undefined); setForm({ displayName: 'OpenAI-compatible', baseUrl: '', apiKey: '' }) }}><Plus size={16} />添加服务</button></aside>
        <div className="provider-form"><h2>{selected ? selected.displayName : '添加 API 服务'}</h2>
          <label><span>API 格式</span><input value="OpenAI-compatible" disabled /></label>
          <label><span>显示名称</span><input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} /></label>
          <label><span>API Base URL</span><input value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></label>
          <label><span>API Key</span><input type="password" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} placeholder={selected?.hasApiKey ? '已安全保存；留空保持不变' : '仅在本机加密保存'} /></label>
          <div className="secure-note"><Check size={15} />密钥由操作系统安全存储，界面与日志无法读取明文。</div>
          <div className="form-actions"><button disabled={busy} onClick={() => void test()}><TestTube2 size={16} />测试连接</button><button className="primary" disabled={busy} onClick={() => void saveProvider()}><Save size={16} />保存服务</button></div>
        </div>
      </div>
      <section className="model-section"><div className="section-heading"><div><h2>模型</h2><p>当前默认：{defaultModel?.displayName ?? '尚未设置'}</p></div></div><div className="model-head"><span>Model ID</span><span>显示名称</span><span>能力</span><span>默认</span><span>状态</span></div>
        {models.filter((item) => item.providerId === selectedId).map((item) => <div className="model-row" key={item.id}><strong>{item.modelId}</strong><span>{item.displayName}</span><small>{capabilityLabel(item.capabilities)}</small><button disabled={!item.enabled || busy} className={item.isDefault ? 'default-model active' : 'default-model'} onClick={() => void updateModel(item, { isDefault: true })}>{item.isDefault ? '默认模型' : '设为默认'}</button><button disabled={busy} onClick={() => void updateModel(item, { enabled: !item.enabled, isDefault: item.enabled ? false : item.isDefault })}>{item.enabled ? '停用' : '启用'}</button></div>)}
        {selectedId && <div className="model-add"><input value={model.modelId} onChange={(event) => setModel({ ...model, modelId: event.target.value })} placeholder="Model ID" /><input value={model.displayName} onChange={(event) => setModel({ ...model, displayName: event.target.value })} placeholder="显示名称（可选）" /><button disabled={busy} onClick={() => void saveModel()}><Plus size={16} />添加模型</button></div>}
      </section>
      <section className="routing-section"><details><summary>任务模型路由（高级）<span>默认全部使用默认模型；只有你主动指定时才覆盖</span></summary><div className="route-grid">{routedTasks.map(([task, label]) => <label key={task}><span>{label}</span><select value={routes[task]} disabled={busy} onChange={(event) => void updateRoute(task, event.target.value)}><option value="default">使用默认模型</option>{enabledModels.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>)}</div></details></section>
      {notice && <div className={notice.ok ? 'settings-notice ok' : 'settings-notice error'} role="status">{notice.ok ? <Check size={17} /> : <XCircle size={17} />}{notice.text}</div>}
    </section>
  </main>
}
