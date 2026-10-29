import { Copy, RotateCcw, Save } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { AIMode, Project } from '../../../shared/domain'
import {
  PROMPT_SOURCE_LABELS, PROMPT_TEMPLATE_VARIABLES, validatePromptTemplate,
  type GlobalPromptTemplateEntry, type PromptCopyPreview, type PromptCopySource, type PromptTemplateEntry
} from '../../../shared/prompt-templates'
import { userErrorMessage } from '../../../shared/user-error'

type Notice = { key: string; ok: boolean; text: string }

/**
 * P1-4 / P3：本书开关（沿用全局 / 本书自定义）+ 全局默认模板 + 从其他作品复制（先预览、再确认）。
 * 模板只影响角色指令措辞；R1–R5 由代码保证。
 */
export function PromptTemplatesView({ project }: { project: Project }): React.JSX.Element {
  const [entries, setEntries] = useState<PromptTemplateEntry[]>([])
  const [globals, setGlobals] = useState<GlobalPromptTemplateEntry[]>([])
  const [drafts, setDrafts] = useState<Partial<Record<AIMode, string>>>({})
  const [globalDrafts, setGlobalDrafts] = useState<Partial<Record<AIMode, string>>>({})
  const [others, setOthers] = useState<Project[]>([])
  const [copyFrom, setCopyFrom] = useState('global')
  const [preview, setPreview] = useState<PromptCopyPreview>()
  const [notice, setNotice] = useState<Notice>()
  const apply = useCallback((next: PromptTemplateEntry[]) => {
    setEntries(next); setDrafts(Object.fromEntries(next.map((entry) => [entry.mode, entry.override ?? entry.effective])))
  }, [])
  const applyGlobal = useCallback((next: GlobalPromptTemplateEntry[]) => {
    setGlobals(next); setGlobalDrafts(Object.fromEntries(next.map((entry) => [entry.mode, entry.override ?? entry.defaultTemplate])))
  }, [])
  useEffect(() => {
    void window.workspace.prompts.list(project.id).then(apply)
    void window.workspace.prompts.listGlobal().then(applyGlobal)
    void window.workspace.projects.list().then((list) => setOthers(list.filter((item) => item.id !== project.id)))
  }, [apply, applyGlobal, project.id])
  const scope = entries[0]?.scope ?? 'global'
  const guard = async (key: string, action: () => Promise<void>, ok: string): Promise<void> => {
    try { await action(); setNotice({ key, ok: true, text: ok }) } catch (error) { setNotice({ key, ok: false, text: userErrorMessage(error) }) }
  }
  const save = async (mode: AIMode): Promise<void> => {
    const text = drafts[mode] ?? ''
    const check = validatePromptTemplate(text)
    if (!check.ok) { setNotice({ key: mode, ok: false, text: check.error }); return }
    await guard(mode, async () => apply(await window.workspace.prompts.set(project.id, mode, text)), '已保存（本书）')
  }
  const saveGlobal = async (mode: AIMode): Promise<void> => {
    const text = globalDrafts[mode] ?? ''
    const check = validatePromptTemplate(text)
    if (!check.ok) { setNotice({ key: `g:${mode}`, ok: false, text: check.error }); return }
    await guard(`g:${mode}`, async () => { applyGlobal(await window.workspace.prompts.setGlobal(mode, text)); apply(await window.workspace.prompts.list(project.id)) }, '已保存（全局，所有沿用全局的作品立即生效）')
  }
  const copySource = (): PromptCopySource => copyFrom === 'global' ? { kind: 'global' } : { kind: 'project', projectId: copyFrom }
  const sourceName = copyFrom === 'global' ? '全局模板' : `《${others.find((item) => item.id === copyFrom)?.title ?? '其他作品'}》`
  const label = (entry: PromptTemplateEntry): string => entry.source === 'builtin' ? '内置默认' : `${PROMPT_SOURCE_LABELS[entry.source]}${entry.source === 'project' ? '覆盖' : '模板'}`

  return <section className="project-view" data-testid="prompt-templates-view">
    <header><div><h1>提示词</h1><p>每个 AI 角色的角色指令。无论措辞如何，AI 产出只进入待确认/补丁，不直接写正文；上下文来源清单不变。可用变量：{PROMPT_TEMPLATE_VARIABLES.map((name) => `{{${name}}}`).join('、')}。</p></div></header>

    <div className="daily-goals-block" data-testid="prompt-scope">
      <header><h2>本书使用</h2></header>
      <label><input type="radio" name="prompt-scope" checked={scope === 'global'} onChange={() => void guard('scope', async () => apply(await window.workspace.prompts.setScope(project.id, 'global')), '已切换为沿用全局')} />沿用全局</label>
      <label><input type="radio" name="prompt-scope" checked={scope === 'project'} onChange={() => void guard('scope', async () => apply(await window.workspace.prompts.setScope(project.id, 'project')), '已切换为本书自定义（以当前生效内容为起点）')} />本书自定义</label>
      {notice?.key === 'scope' && <small className="daily-goals-saved">{notice.text}</small>}
    </div>

    <div className="daily-goals-block" data-testid="prompt-copy">
      <header><h2>从其他作品复制</h2><small>先预览，确认后才写入；写入后本书切换为「本书自定义」</small></header>
      <select aria-label="复制来源" value={copyFrom} onChange={(event) => { setCopyFrom(event.target.value); setPreview(undefined) }}>
        <option value="global">全局模板</option>
        {others.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select>
      <button type="button" onClick={() => void guard('copy', async () => setPreview(await window.workspace.prompts.previewCopy(project.id, copySource())), '已生成预览（尚未写入）')}><Copy size={14} />预览</button>
      {preview && <div className="prompt-copy-preview" data-testid="prompt-copy-preview">
        <p>从{sourceName}复制将改变 {preview.changedCount} 个角色：</p>
        <ul>{preview.changes.filter((item) => item.changed).map((item) => <li key={item.mode}><strong>{item.role}</strong><div>当前（{PROMPT_SOURCE_LABELS[item.currentSource]}）：{item.current}</div><div>复制后：{item.incoming}</div></li>)}</ul>
        <button type="button" onClick={() => setPreview(undefined)}>取消</button>
        <button type="button" className="primary" disabled={!preview.changedCount && scope === 'project'} onClick={() => void guard('copy', async () => { apply(await window.workspace.prompts.applyCopy(project.id, preview.source, preview.token)); setPreview(undefined) }, '已复制到本书')}>确认复制</button>
      </div>}
      {notice?.key === 'copy' && (notice.ok ? <small className="daily-goals-saved">{notice.text}</small> : <div className="inline-error" role="alert">{notice.text}</div>)}
    </div>

    <h2>本书模板{scope === 'global' ? '（当前沿用全局，只读；切换为本书自定义后可编辑）' : ''}</h2>
    {entries.map((entry) => <div key={entry.mode} className="daily-goals-block">
      <header><h2>{entry.role}</h2><small>生效：{label(entry)}</small></header>
      <textarea rows={3} aria-label={`${entry.role}模板`} readOnly={scope === 'global'} value={scope === 'global' ? entry.effective : drafts[entry.mode] ?? ''} onChange={(event) => setDrafts({ ...drafts, [entry.mode]: event.target.value })} />
      {notice?.key === entry.mode && (notice.ok ? <small className="daily-goals-saved">{notice.text}</small> : <div className="inline-error" role="alert">{notice.text}</div>)}
      {scope === 'project' && <div className="daily-goals-actions">
        <button type="button" disabled={entry.override === null} onClick={() => void guard(entry.mode, async () => apply(await window.workspace.prompts.reset(project.id, entry.mode)), '已恢复内置默认')}><RotateCcw size={14} />恢复默认</button>
        <button type="button" className="primary" onClick={() => void save(entry.mode)}><Save size={14} />保存</button>
      </div>}
    </div>)}

    <h2>全局默认模板（应用级，所有「沿用全局」的作品共用）</h2>
    {globals.map((entry) => <div key={`g:${entry.mode}`} className="daily-goals-block" data-testid={`global-template-${entry.mode}`}>
      <header><h2>{entry.role}</h2><small>{entry.override === null ? '内置默认' : '已修改'}</small></header>
      <textarea rows={3} aria-label={`全局${entry.role}模板`} value={globalDrafts[entry.mode] ?? ''} onChange={(event) => setGlobalDrafts({ ...globalDrafts, [entry.mode]: event.target.value })} />
      {notice?.key === `g:${entry.mode}` && (notice.ok ? <small className="daily-goals-saved">{notice.text}</small> : <div className="inline-error" role="alert">{notice.text}</div>)}
      <div className="daily-goals-actions">
        <button type="button" disabled={entry.override === null} onClick={() => void guard(`g:${entry.mode}`, async () => { applyGlobal(await window.workspace.prompts.resetGlobal(entry.mode)); apply(await window.workspace.prompts.list(project.id)) }, '全局已恢复内置默认')}><RotateCcw size={14} />恢复内置默认</button>
        <button type="button" className="primary" onClick={() => void saveGlobal(entry.mode)}><Save size={14} />保存全局</button>
      </div>
    </div>)}
  </section>
}
