import { RotateCcw, Save } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { AIMode, Project } from '../../../shared/domain'
import { PROMPT_TEMPLATE_VARIABLES, validatePromptTemplate, type PromptTemplateEntry } from '../../../shared/prompt-templates'
import { userErrorMessage } from '../../../shared/user-error'

/** P1-4：每个 AI 角色一份默认模板；作者可覆盖、可恢复默认。模板只影响角色指令措辞。 */
export function PromptTemplatesView({ project }: { project: Project }): React.JSX.Element {
  const [entries, setEntries] = useState<PromptTemplateEntry[]>([])
  const [drafts, setDrafts] = useState<Partial<Record<AIMode, string>>>({})
  const [notice, setNotice] = useState<{ mode: AIMode; ok: boolean; text: string }>()
  const apply = useCallback((next: PromptTemplateEntry[]) => {
    setEntries(next)
    setDrafts(Object.fromEntries(next.map((entry) => [entry.mode, entry.override ?? entry.defaultTemplate])))
  }, [])
  useEffect(() => { void window.workspace.prompts.list(project.id).then(apply) }, [apply, project.id])
  const save = async (mode: AIMode): Promise<void> => {
    const text = drafts[mode] ?? ''
    const check = validatePromptTemplate(text)
    if (!check.ok) { setNotice({ mode, ok: false, text: check.error }); return }
    try { apply(await window.workspace.prompts.set(project.id, mode, text)); setNotice({ mode, ok: true, text: '已保存' }) }
    catch (error) { setNotice({ mode, ok: false, text: userErrorMessage(error) }) }
  }
  const reset = async (mode: AIMode): Promise<void> => {
    apply(await window.workspace.prompts.reset(project.id, mode)); setNotice({ mode, ok: true, text: '已恢复默认' })
  }
  return <section className="project-view" data-testid="prompt-templates-view">
    <header><div><h1>提示词</h1><p>每个 AI 角色的角色指令可按本作品覆盖。无论措辞如何，AI 产出只进入待确认/补丁，不直接写正文；上下文来源清单不变。可用变量：{PROMPT_TEMPLATE_VARIABLES.map((name) => `{{${name}}}`).join('、')}。</p></div></header>
    {entries.map((entry) => <div key={entry.mode} className="daily-goals-block">
      <header><h2>{entry.role}</h2><small>{entry.override === null ? '默认' : '已覆盖'}</small></header>
      <textarea rows={3} aria-label={`${entry.role}模板`} value={drafts[entry.mode] ?? ''} onChange={(event) => setDrafts({ ...drafts, [entry.mode]: event.target.value })} />
      {notice?.mode === entry.mode && (notice.ok ? <small className="daily-goals-saved">{notice.text}</small> : <div className="inline-error" role="alert">{notice.text}</div>)}
      <div className="daily-goals-actions">
        <button type="button" disabled={entry.override === null} onClick={() => void reset(entry.mode)}><RotateCcw size={14} />恢复默认</button>
        <button type="button" className="primary" onClick={() => void save(entry.mode)}><Save size={14} />保存</button>
      </div>
    </div>)}
  </section>
}
