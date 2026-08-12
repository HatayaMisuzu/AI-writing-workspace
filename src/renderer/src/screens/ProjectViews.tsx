import { Check, Clock3, GitCompareArrows, Lightbulb, Plus, RotateCcw, Save, Shield, Trash2, UserRound } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Character, DocumentContent, DocumentNode, Idea, MemoryItem, ProjectNote, Snapshot, TextPatch } from '../../../shared/domain'
import { Modal } from '../components/Modal'
import { buildHistoryDiff } from '../services/history-diff'

const snapshotReason = (reason: Snapshot['reason']): string => ({
  interval: '定时保存', large_delete: '大段删除前', ai_edit: 'AI 修改前', manual: '手动快照', pre_restore: '恢复前备份'
}[reason])
const patchStatus = (status: TextPatch['status']): string => ({ proposed: '待审阅', accepted: '已接受', rejected: '已拒绝', stale: '已失效' }[status])

function ConfirmAction({ title, message, onConfirm, children }: { title: string; message: string; onConfirm(): Promise<void>; children: React.ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const confirmAction = async (): Promise<void> => {
    setBusy(true); setError(undefined)
    try { await onConfirm(); setOpen(false) }
    catch (nextError) { setError(nextError instanceof Error ? nextError.message : String(nextError)) }
    finally { setBusy(false) }
  }
  return <><button onClick={() => setOpen(true)}>{children}</button>{open && <Modal title={title} onClose={() => { if (!busy) setOpen(false) }}><p>{message}</p>{error && <div className="inline-error" role="alert">{error}</div>}<div className="modal-actions"><button disabled={busy} onClick={() => setOpen(false)}>取消</button><button className="primary" disabled={busy} onClick={() => void confirmAction()}>{busy ? '处理中…' : '确认'}</button></div></Modal>}</>
}

export function IdeasView({ projectId }: { projectId: string }): React.JSX.Element {
  const [ideas, setIdeas] = useState<Idea[]>([]); const [input, setInput] = useState('')
  const load = useCallback(() => void window.workspace.ideas.list(projectId).then(setIdeas), [projectId])
  useEffect(load, [load])
  return <section className="project-view"><header><div><h1>灵感</h1><p>先记下来，暂时不需要分类。</p></div></header><div className="idea-capture"><Lightbulb size={19} /><textarea value={input} onChange={(e) => setInput(e.target.value)} placeholder="记下一闪而过的想法…" /><button className="primary" onClick={async () => { if (input.trim()) { await window.workspace.ideas.create(projectId, input); setInput(''); load() } }}>保存</button></div><div className="idea-list">{ideas.map((idea) => <article key={idea.id}><p>{idea.content}</p><small>{new Date(idea.updatedAt).toLocaleString()}</small></article>)}</div></section>
}

export function MemoryView({ projectId }: { projectId: string }): React.JSX.Element {
  const [items, setItems] = useState<MemoryItem[]>([])
  const [replacement, setReplacement] = useState<{ id: string; content: string }>()
  const [replacementError, setReplacementError] = useState<string>()
  const load = useCallback(() => void window.workspace.memories.list(projectId).then(setItems), [projectId])
  useEffect(load, [load])
  const statusLabel: Record<MemoryItem['status'], string> = { observed: '已观察', confirmed: '已确认', tentative: '暂定', idea: '想法', suggested: '待确认', rejected: '已废弃', superseded: '已被替代' }
  return <section className="project-view"><header><div><h1>Story Memory</h1><p>确认后的设定才会长期生效；修改会先成为替代提案，旧记录仍可追溯。</p></div></header><div className="memory-list">{items.length === 0 ? <div className="empty-section"><Shield size={28} /><h3>还没有长期记忆</h3><p>章节理解与作者确认的内容会出现在这里。</p></div> : items.map((item) => {
    const previous = item.supersedes ? items.find((candidate) => candidate.id === item.supersedes) : undefined
    return <article key={item.id}><span className={`memory-status ${item.status}`}>{statusLabel[item.status]}</span><p>{item.content}</p><small>{item.sourceType} · {item.sourceLocation ?? item.sourceId}</small>{previous && <span className="memory-trace">确认后将替代：“{previous.content}”</span>}{item.status === 'suggested' && <div><button onClick={async () => { await window.workspace.memories.confirm(projectId, item.id); load() }}><Check size={14} />确认生效</button><button onClick={async () => { await window.workspace.memories.reject(projectId, item.id); load() }}><Trash2 size={14} />否决</button></div>}{item.status === 'confirmed' && <div><button onClick={() => { setReplacement({ id: item.id, content: item.content }); setReplacementError(undefined) }}><GitCompareArrows size={14} />修改 / 替代</button><ConfirmAction title="废弃这条设定" message="该记录会保留在历史中，但不再参与创作上下文。确定继续吗？" onConfirm={async () => { await window.workspace.memories.retire(projectId, item.id); load() }}><Trash2 size={14} />废弃</ConfirmAction></div>}</article>
  })}</div>{replacement && <Modal title="提出替代设定" onClose={() => setReplacement(undefined)}><div className="memory-replacement"><p>先创建待确认提案；只有确认后，旧设定才会标记为“已被替代”。</p><textarea value={replacement.content} autoFocus onChange={(event) => setReplacement({ ...replacement, content: event.target.value })} />{replacementError && <div className="inline-error" role="alert">{replacementError}</div>}<div className="modal-actions"><button onClick={() => setReplacement(undefined)}>取消</button><button className="primary" disabled={!replacement.content.trim()} onClick={() => void window.workspace.memories.replace(projectId, replacement.id, replacement.content).then(() => { setReplacement(undefined); load() }).catch((error) => setReplacementError(error instanceof Error ? error.message : String(error)))}>创建替代提案</button></div></div></Modal>}</section>
}

export function NotesView({ projectId, section }: { projectId: string; section: ProjectNote['section'] }): React.JSX.Element {
  const [items, setItems] = useState<ProjectNote[]>([])
  const [draft, setDraft] = useState<{ id?: string; title: string; content: string }>({ title: '', content: '' })
  const load = useCallback(() => void window.workspace.notes.list(projectId, section).then(setItems), [projectId, section])
  useEffect(() => { load(); setDraft({ title: '', content: '' }) }, [load])
  const label = section === 'story' ? '故事笔记' : '参考资料'
  return <section className="project-view content-manager"><header><div><h1>{label}</h1><p>自由记录，不要求填写复杂结构。</p></div><button onClick={() => setDraft({ title: '', content: '' })}><Plus size={16} />新建</button></header><div className="content-manager-grid"><aside>{items.map((item) => <button key={item.id} className={draft.id === item.id ? 'active' : ''} onClick={() => setDraft({ id: item.id, title: item.title, content: item.content })}><strong>{item.title}</strong><small>{new Date(item.updatedAt).toLocaleDateString()}</small></button>)}</aside><div className="note-editor"><input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="标题" /><textarea value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} placeholder="从一段自由笔记开始……" /><div><button className="primary" onClick={async () => { const saved = await window.workspace.notes.save({ ...draft, projectId, section }); setDraft({ id: saved.id, title: saved.title, content: saved.content }); load() }}><Save size={15} />保存</button>{draft.id && <ConfirmAction title="删除笔记" message="删除后无法恢复。确定删除这条笔记吗？" onConfirm={async () => { await window.workspace.notes.delete(projectId, draft.id!); setDraft({ title: '', content: '' }); load() }}><Trash2 size={15} />删除</ConfirmAction>}</div></div></div></section>
}

export function CharactersView({ projectId }: { projectId: string }): React.JSX.Element {
  const [items, setItems] = useState<Character[]>([])
  const [draft, setDraft] = useState<{ id?: string; name: string; aliases: string; notes: string }>({ name: '', aliases: '', notes: '' })
  const load = useCallback(() => void window.workspace.characters.list(projectId).then(setItems), [projectId])
  useEffect(() => { load(); setDraft({ name: '', aliases: '', notes: '' }) }, [load])
  return <section className="project-view content-manager"><header><div><h1>人物</h1><p>只记录你真正需要的信息，所有字段都可留空。</p></div><button onClick={() => setDraft({ name: '', aliases: '', notes: '' })}><Plus size={16} />新建人物</button></header><div className="content-manager-grid"><aside>{items.map((item) => <button key={item.id} className={draft.id === item.id ? 'active' : ''} onClick={() => setDraft({ id: item.id, name: item.name, aliases: item.aliases.join('、'), notes: item.notes })}><UserRound size={16} /><strong>{item.name}</strong><small>{item.aliases.join('、') || '暂无别名'}</small></button>)}</aside><div className="note-editor character-editor"><label><span>姓名</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label><span>别名（用顿号分隔）</span><input value={draft.aliases} onChange={(event) => setDraft({ ...draft, aliases: event.target.value })} /></label><label><span>自由笔记</span><textarea value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label><div><button className="primary" onClick={async () => { const saved = await window.workspace.characters.save({ id: draft.id, projectId, name: draft.name, aliases: draft.aliases.split(/[、,，]/).map((item) => item.trim()).filter(Boolean), notes: draft.notes }); setDraft({ id: saved.id, name: saved.name, aliases: saved.aliases.join('、'), notes: saved.notes }); load() }}><Save size={15} />保存</button>{draft.id && <ConfirmAction title="删除人物" message="确定删除这个人物吗？" onConfirm={async () => { await window.workspace.characters.delete(projectId, draft.id!); setDraft({ name: '', aliases: '', notes: '' }); load() }}><Trash2 size={15} />删除</ConfirmAction>}</div></div></div></section>
}

export function HistoryView({ projectId, document, currentContent, onRestored }: { projectId: string; document?: DocumentNode; currentContent?: DocumentContent; onRestored?(content: Awaited<ReturnType<typeof window.workspace.snapshots.restore>>): void }): React.JSX.Element {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [compareSnapshot, setCompareSnapshot] = useState<Snapshot>()
  const documentId = document?.id
  const load = useCallback(() => { if (documentId) void window.workspace.snapshots.list(projectId, documentId).then(setSnapshots) }, [projectId, documentId])
  useEffect(load, [load])
  const diff = useMemo(() => compareSnapshot ? buildHistoryDiff(compareSnapshot.plainText, currentContent?.plainText ?? '') : [], [compareSnapshot, currentContent?.plainText])
  return <section className="project-view"><header><div><h1>历史</h1><p>{document ? `${document.title} 的可恢复版本` : '请先选择章节'}</p></div>{document && <button onClick={async () => { await window.workspace.snapshots.create(projectId, document.id, 'manual'); load() }}><Clock3 size={16} />手动快照</button>}</header><div className="history-list">{snapshots.length === 0 && <div className="empty-section"><Clock3 size={28} /><h3>还没有历史快照</h3><p>手动创建，或在大段删除、定时保存和恢复前自动生成。</p></div>}{snapshots.map((snapshot) => <article key={snapshot.id}><div><strong>修订 {snapshot.revision}</strong><small>{new Date(snapshot.createdAt).toLocaleString()} · {snapshotReason(snapshot.reason)}</small></div><p>{snapshot.plainText.slice(0, 140) || '空文档'}{snapshot.plainText.length > 140 ? '…' : ''}</p><div className="history-actions"><button onClick={() => setCompareSnapshot(snapshot)}><GitCompareArrows size={14} />查看差异</button><ConfirmAction title="恢复历史版本" message="恢复前会自动创建当前版本快照。继续吗？" onConfirm={async () => { const restored = await window.workspace.snapshots.restore(projectId, snapshot.id); onRestored?.(restored); load() }}><RotateCcw size={14} />恢复此版本</ConfirmAction></div></article>)}</div>{compareSnapshot && <Modal title={`修订 ${compareSnapshot.revision} 与当前正文的差异`} onClose={() => setCompareSnapshot(undefined)} width={860}><div className="history-diff" aria-label="历史版本差异">{diff.length === 0 ? <p>两个版本没有文字差异。</p> : diff.map((segment, index) => segment.type === 'insert' ? <ins key={index}>{segment.value}</ins> : segment.type === 'delete' ? <del key={index}>{segment.value}</del> : <span key={index}>{segment.value}</span>)}</div><p className="diff-legend"><span className="insert">新增</span><span className="delete">删除</span> 差异只供查看，恢复前仍会保存当前版本。</p></Modal>}</section>
}

export function PatchDrawer({ projectId, documentId, onClose, onAccept }: { projectId: string; documentId: string; onClose(): void; onAccept(patch: TextPatch): Promise<TextPatch> }): React.JSX.Element {
  const [patches, setPatches] = useState<TextPatch[]>([]); const load = useCallback(() => void window.workspace.patches.list(projectId, documentId).then(setPatches), [projectId, documentId])
  const [error, setError] = useState<string>()
  useEffect(load, [load])
  return <aside className="patch-drawer"><header><h2>修改提案</h2><button onClick={onClose}>关闭</button></header>{error && <div className="inline-error" role="alert">{error}</div>}{patches.length === 0 ? <p className="empty-copy">还没有修改提案。选中文字后在“同行者”中选择“修改”。</p> : patches.map((patch) => <article key={patch.id}><span className={`patch-status ${patch.status}`}>{patchStatus(patch.status)}</span><div className="diff-block"><del>{patch.originalText || '（空）'}</del><ins>{patch.replacement}</ins></div>{patch.status === 'proposed' && <div><button onClick={async () => { await window.workspace.patches.reject(projectId, patch.id); load() }}>拒绝</button><button className="primary" onClick={async () => { try { const result = await onAccept(patch); setError(result.status === 'stale' ? '目标文字或章节版本已变化，提案已经失效，请重新生成。' : undefined); load() } catch (nextError) { setError(`应用失败：${nextError instanceof Error ? nextError.message : String(nextError)}`) } }}>接受并应用</button></div>}</article>)}</aside>
}
