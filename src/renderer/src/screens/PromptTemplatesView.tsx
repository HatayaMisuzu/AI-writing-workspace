import { displayProjectTitle } from '../services/project-title'
import { Copy, RotateCcw, Save } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { AIMode, Project } from '../../../shared/domain'
import {
  PROMPT_SOURCE_LABELS, PROMPT_TEMPLATE_VARIABLES, validatePromptTemplate,
  type GlobalImportPreview, type GlobalPromptTemplateEntry, type PromptCopyPreview, type PromptScopeChoice, type PromptCopySource, type PromptTemplateEntry
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
  const [choosingScope, setChoosingScope] = useState(false)
  const [globalImport, setGlobalImport] = useState<GlobalImportPreview>()
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
  const dormantCount = scope === 'global' ? entries.filter((entry) => entry.override !== null).length : 0
  const toProject = async (choice?: PromptScopeChoice): Promise<void> => {
    const ok = choice === 'restore' ? `已恢复上次的本书设置（${dormantCount} 个角色）；其余角色使用内置默认`
      : choice === 'fromCurrent' ? `已从当前生效内容开始；本书旧的 ${dormantCount} 个角色覆盖已被替换` : '已切换为本书自定义（以当前生效内容为起点）'
    await guard('scope', async () => { apply(await window.workspace.prompts.setScope(project.id, 'project', choice)); setChoosingScope(false) }, ok)
  }
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
  const sourceName = copyFrom === 'global' ? '全局模板' : `《${displayProjectTitle(others.find((item) => item.id === copyFrom)?.title ?? '其他作品')}》`
  const label = (entry: PromptTemplateEntry): string => entry.source === 'builtin' ? '内置默认' : `${PROMPT_SOURCE_LABELS[entry.source]}${entry.source === 'project' ? '覆盖' : '模板'}`

  return <section className="project-view" data-testid="prompt-templates-view">
    <header><div><h1>提示词</h1><p>每个 AI 角色的角色指令。无论措辞如何，AI 产出只进入待确认/补丁，不直接写正文；上下文来源清单不变。可用变量：{PROMPT_TEMPLATE_VARIABLES.map((name) => `{{${name}}}`).join('、')}。</p></div></header>

    <div className="daily-goals-block" data-testid="prompt-scope">
      <header><h2>本书使用</h2></header>
      <label><input type="radio" name="prompt-scope" checked={scope === 'global'} onChange={() => void guard('scope', async () => apply(await window.workspace.prompts.setScope(project.id, 'global')), '已切换为沿用全局')} />沿用全局</label>
      <label><input type="radio" name="prompt-scope" checked={scope === 'project'} onChange={() => { if (dormantCount > 0) setChoosingScope(true); else void toProject() }} />本书自定义</label>
      {choosingScope && <div className="prompt-copy-preview" data-testid="prompt-scope-choice">
        <p>本书保留有上次的本书自定义（{dormantCount} 个角色）。请选择：</p>
        <button type="button" onClick={() => void toProject('restore')}>恢复上次的本书设置</button>
        <small>恢复之前保存的 {dormantCount} 个角色；其余角色使用内置默认。</small>
        <button type="button" onClick={() => void toProject('fromCurrent')}>从当前生效内容开始</button>
        <small>以当前生效内容（全局 / 内置默认）为起点；本书旧的 {dormantCount} 个角色覆盖将被替换，无法找回。</small>
        <button type="button" onClick={() => setChoosingScope(false)}>取消</button>
      </div>}
      {notice?.key === 'scope' && <small className="daily-goals-saved">{notice.text}</small>}
    </div>

    <div className="daily-goals-block" data-testid="prompt-copy">
      <header><h2>从其他作品复制</h2><small>先预览，确认后才写入；写入后本书切换为「本书自定义」</small></header>
      <select aria-label="复制来源" value={copyFrom} onChange={(event) => { setCopyFrom(event.target.value); setPreview(undefined) }}>
        <option value="global">全局模板</option>
        {others.map((item) => <option key={item.id} value={item.id}>{displayProjectTitle(item.title)}</option>)}
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
      {scope === 'project' && entry.override === null && <small data-testid={`builtin-note-${entry.mode}`}>本书未自定义此角色：使用内置默认（本书自定义模式下不跟随全局）。</small>}
      {scope === 'project' && <div className="daily-goals-actions">
        <button type="button" disabled={entry.override === null} onClick={() => void guard(entry.mode, async () => apply(await window.workspace.prompts.reset(project.id, entry.mode)), '已恢复内置默认')}><RotateCcw size={14} />恢复内置默认</button>
        <button type="button" disabled={entry.effective === (entry.globalOverride ?? entry.defaultTemplate)} onClick={() => void guard(entry.mode, async () => apply(await window.workspace.prompts.set(project.id, entry.mode, entry.globalOverride ?? entry.defaultTemplate)), '已改为当前全局内容（之后全局再改不影响本书）')}>改为全局内容</button>
        <button type="button" className="primary" onClick={() => void save(entry.mode)}><Save size={14} />保存</button>
      </div>}
    </div>)}

    <h2>全局默认模板（应用级，所有「沿用全局」的作品共用）</h2>
    <div className="daily-goals-block" data-testid="global-transfer">
      <small>全局模板不随作品备份；换电脑时请用单独文件导出 / 导入。</small>
      <button type="button" onClick={() => void guard('gfile', async () => { await window.workspace.prompts.exportGlobal() }, '已导出全局模板')}>导出全局模板</button>
      <button type="button" onClick={() => void guard('gfile', async () => { const next = await window.workspace.prompts.previewGlobalImport(); if (next) setGlobalImport(next) }, '已读取文件，尚未写入；请核对差异后确认')}>导入全局模板</button>
      {globalImport && <div className="prompt-copy-preview" data-testid="global-import-preview">
        <p>导入将用文件内容替换当前全局，改变 {globalImport.changedCount} 个角色（文件未列出的角色回到内置默认）：</p>
        <ul>{globalImport.changes.filter((item) => item.changed).map((item) => <li key={item.mode}><strong>{item.role}</strong><div>当前：{item.current}</div><div>导入后：{item.incoming}</div></li>)}</ul>
        <button type="button" onClick={() => { void window.workspace.prompts.cancelGlobalImport(); setGlobalImport(undefined); setNotice({ key: 'gfile', ok: true, text: '已取消，未写入' }) }}>取消</button>
        <button type="button" className="primary" onClick={() => void guard('gfile', async () => { applyGlobal(await window.workspace.prompts.applyGlobalImport(globalImport.token)); setGlobalImport(undefined); apply(await window.workspace.prompts.list(project.id)) }, '已导入全局模板')}>确认导入</button>
      </div>}
      {notice?.key === 'gfile' && (notice.ok ? <small className="daily-goals-saved">{notice.text}</small> : <div className="inline-error" role="alert">{notice.text}</div>)}
    </div>
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
