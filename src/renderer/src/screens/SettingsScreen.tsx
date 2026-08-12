import { Check, Database, Eye, Keyboard, Palette, Plus, Save, Server, TestTube2, XCircle } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { AIMode, ModelConfig, ProviderConfig } from '../../../shared/domain'

const defaultCapabilities = { streaming: true, tools: false, structuredOutput: false, cancellation: true }
const capabilityLabel = (capabilities: ModelConfig['capabilities']): string => [
  capabilities.streaming ? '流式' : undefined,
  capabilities.cancellation ? '可取消' : undefined,
  capabilities.tools ? '工具' : undefined,
  capabilities.structuredOutput ? '原生结构化输出' : undefined
].filter(Boolean).join(' · ')

export function SettingsScreen(): React.JSX.Element {
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [models, setModels] = useState<ModelConfig[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const selected = providers.find((item) => item.id === selectedId)
  const [form, setForm] = useState({ displayName: 'OpenAI-compatible', baseUrl: '', apiKey: '' })
  const [model, setModel] = useState({ modelId: '', displayName: '' })
  const [notice, setNotice] = useState<{ ok: boolean; text: string }>()

  const reload = useCallback(async (): Promise<void> => {
    const [nextProviders, nextModels] = await Promise.all([window.workspace.providers.list(), window.workspace.providers.models()])
    setProviders(nextProviders); setModels(nextModels)
    setSelectedId((current) => current ?? nextProviders[0]?.id)
  }, [])
  useEffect(() => { void reload() }, [reload])
  useEffect(() => { if (selected) setForm({ displayName: selected.displayName, baseUrl: selected.baseUrl, apiKey: '' }) }, [selected])

  const saveProvider = async (): Promise<void> => {
    const id = selectedId ?? crypto.randomUUID()
    await window.workspace.providers.save({ id, providerType: 'openai-compatible', displayName: form.displayName, baseUrl: form.baseUrl, apiKey: form.apiKey || undefined })
    setSelectedId(id); setNotice({ ok: true, text: '服务配置已安全保存到本机。' }); await reload()
  }
  const saveModel = async (): Promise<void> => {
    if (!selectedId || !model.modelId.trim()) return
    await window.workspace.providers.saveModel({ id: crypto.randomUUID(), providerId: selectedId, modelId: model.modelId.trim(), displayName: model.displayName.trim() || model.modelId.trim(), capabilities: defaultCapabilities, enabled: true, isDefault: models.length === 0 })
    setModel({ modelId: '', displayName: '' }); await reload()
  }
  const test = async (): Promise<void> => {
    const activeModel = models.find((item) => item.providerId === selectedId)
    if (!selectedId || !activeModel) return setNotice({ ok: false, text: '请先保存服务并添加至少一个模型。' })
    const result = await window.workspace.providers.test(selectedId, activeModel.modelId)
    setNotice({ ok: result.ok, text: result.ok ? '连接成功。' : `连接失败：${result.message ?? '未知错误'} 正文与本地保存不受影响。` })
  }

  return <main className="settings-screen">
    <aside className="settings-nav"><button disabled title="尚未实现"><Eye size={18} />写作</button><button disabled title="尚未实现"><Palette size={18} />外观</button><button className="active"><Server size={18} />模型与服务</button><button disabled title="尚未实现"><Keyboard size={18} />快捷键</button><button disabled title="尚未实现"><Database size={18} />数据与备份</button></aside>
    <section className="settings-content">
      <header><h1>模型与服务</h1><p>模型是可选能力。凭据仅保存在本机主进程；未配置模型时，写作、保存、检索与历史恢复仍可正常使用。</p></header>
      <div className="provider-layout">
        <aside className="provider-list"><h2>服务提供者</h2>{providers.map((provider) => <button key={provider.id} className={selectedId === provider.id ? 'active' : ''} onClick={() => setSelectedId(provider.id)}><Server size={16} /><span>{provider.displayName}</span></button>)}
          <button className="add-provider" onClick={() => { setSelectedId(undefined); setForm({ displayName: 'OpenAI-compatible', baseUrl: '', apiKey: '' }) }}><Plus size={16} />添加服务</button></aside>
        <div className="provider-form"><h2>{selected ? selected.displayName : '添加 OpenAI-compatible 服务'}</h2>
          <label><span>显示名称</span><input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} /></label>
          <label><span>API Base URL</span><input value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></label>
          <label><span>API Key</span><input type="password" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} placeholder={selected?.hasApiKey ? '已安全保存；留空保持不变' : '仅在本机加密保存'} /></label>
          <div className="secure-note"><Check size={15} />使用操作系统安全存储，Renderer 与日志无法读取明文。</div>
          <div className="form-actions"><button onClick={() => void test()}><TestTube2 size={16} />测试连接</button><button className="primary" onClick={() => void saveProvider()}><Save size={16} />保存服务</button></div>
        </div>
      </div>
      <section className="model-section"><h2>模型</h2><div className="model-head"><span>Model ID</span><span>显示名称</span><span>能力</span><span>默认</span></div>
        {models.filter((item) => item.providerId === selectedId).map((item) => <div className="model-row" key={item.id}><strong>{item.modelId}</strong><span>{item.displayName}</span><small>{capabilityLabel(item.capabilities)}</small><button className={item.isDefault ? 'default-model active' : 'default-model'} onClick={async () => { await window.workspace.providers.saveModel({ ...item, isDefault: true }); await reload() }}>{item.isDefault ? '默认模型' : '设为默认'}</button></div>)}
        {selectedId && <div className="model-add"><input value={model.modelId} onChange={(event) => setModel({ ...model, modelId: event.target.value })} placeholder="Model ID" /><input value={model.displayName} onChange={(event) => setModel({ ...model, displayName: event.target.value })} placeholder="显示名称（可选）" /><button onClick={() => void saveModel()}><Plus size={16} />添加模型</button></div>}
      </section>
      <section className="routing-section"><details><summary>任务模型路由（高级）<span>未单独设置的任务始终使用默认模型</span></summary><div className="route-grid">{(['discussion','generation','chapter_digest','proofreading','reader_review'] as AIMode[]).map((task) => <label key={task}><span>{task}</span><select defaultValue="default" onChange={(event) => void window.workspace.providers.setRoute({ taskType: task, modelId: event.target.value })}><option value="default">默认模型</option>{models.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>)}</div></details></section>
      {notice && <div className={notice.ok ? 'settings-notice ok' : 'settings-notice error'}>{notice.ok ? <Check size={17} /> : <XCircle size={17} />}{notice.text}</div>}
    </section>
  </main>
}
