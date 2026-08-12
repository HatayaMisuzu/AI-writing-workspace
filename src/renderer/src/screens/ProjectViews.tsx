import { Check, Clock3, Lightbulb, Plus, RotateCcw, Save, Shield, Trash2, UserRound } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Character, DocumentNode, Idea, MemoryItem, ProjectNote, Snapshot, TextPatch } from '../../../shared/domain'

export function IdeasView({ projectId }: { projectId: string }): React.JSX.Element {
  const [ideas, setIdeas] = useState<Idea[]>([]); const [input, setInput] = useState('')
  const load = () => void window.workspace.ideas.list(projectId).then(setIdeas)
  useEffect(load, [projectId])
  return <section className="project-view"><header><div><h1>灵感</h1><p>先记下来，暂时不需要分类。</p></div></header><div className="idea-capture"><Lightbulb size={19} /><textarea value={input} onChange={(e) => setInput(e.target.value)} placeholder="记下一闪而过的想法…" /><button className="primary" onClick={async () => { if (input.trim()) { await window.workspace.ideas.create(projectId, input); setInput(''); load() } }}>保存</button></div><div className="idea-list">{ideas.map((idea) => <article key={idea.id}><p>{idea.content}</p><small>{new Date(idea.updatedAt).toLocaleString()}</small></article>)}</div></section>
}

export function MemoryView({ projectId }: { projectId: string }): React.JSX.Element {
  const [items, setItems] = useState<MemoryItem[]>([]); const load = () => void window.workspace.memories.list(projectId).then(setItems)
  useEffect(load, [projectId])
  return <section className="project-view"><header><div><h1>Story Memory</h1><p>这里保留事实层级与来源；“聊过”不等于“已经确定”。</p></div></header><div className="memory-list">{items.length === 0 ? <div className="empty-section"><Shield size={28} /><h3>还没有长期记忆</h3><p>章节理解与作者确认的内容会出现在这里。</p></div> : items.map((item) => <article key={item.id}><span className={`memory-status ${item.status}`}>{item.status}</span><p>{item.content}</p><small>{item.sourceType} · {item.sourceLocation ?? item.sourceId}</small>{item.status === 'suggested' && <div><button onClick={async () => { await window.workspace.memories.confirm(projectId, item.id); load() }}><Check size={14} />确认</button><button onClick={async () => { await window.workspace.memories.reject(projectId, item.id); load() }}><Trash2 size={14} />否决</button></div>}</article>)}</div></section>
}

export function NotesView({ projectId, section }: { projectId: string; section: ProjectNote['section'] }): React.JSX.Element {
  const [items, setItems] = useState<ProjectNote[]>([])
  const [draft, setDraft] = useState<{ id?: string; title: string; content: string }>({ title: '', content: '' })
  const load = () => void window.workspace.notes.list(projectId, section).then(setItems)
  useEffect(() => { load(); setDraft({ title: '', content: '' }) }, [projectId, section])
  const label = section === 'story' ? '故事笔记' : '参考资料'
  return <section className="project-view content-manager"><header><div><h1>{label}</h1><p>自由记录，不要求填写复杂结构。</p></div><button onClick={() => setDraft({ title: '', content: '' })}><Plus size={16} />新建</button></header><div className="content-manager-grid"><aside>{items.map((item) => <button key={item.id} className={draft.id === item.id ? 'active' : ''} onClick={() => setDraft({ id: item.id, title: item.title, content: item.content })}><strong>{item.title}</strong><small>{new Date(item.updatedAt).toLocaleDateString()}</small></button>)}</aside><div className="note-editor"><input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="标题" /><textarea value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} placeholder="从一段自由笔记开始……" /><div><button className="primary" onClick={async () => { const saved = await window.workspace.notes.save({ ...draft, projectId, section }); setDraft({ id: saved.id, title: saved.title, content: saved.content }); load() }}><Save size={15} />保存</button>{draft.id && <button onClick={async () => { if (confirm('删除这条笔记？')) { await window.workspace.notes.delete(projectId, draft.id!); setDraft({ title: '', content: '' }); load() } }}><Trash2 size={15} />删除</button>}</div></div></div></section>
}

export function CharactersView({ projectId }: { projectId: string }): React.JSX.Element {
  const [items, setItems] = useState<Character[]>([])
  const [draft, setDraft] = useState<{ id?: string; name: string; aliases: string; notes: string }>({ name: '', aliases: '', notes: '' })
  const load = () => void window.workspace.characters.list(projectId).then(setItems)
  useEffect(() => { load(); setDraft({ name: '', aliases: '', notes: '' }) }, [projectId])
  return <section className="project-view content-manager"><header><div><h1>人物</h1><p>只记录你真正需要的信息，所有字段都可留空。</p></div><button onClick={() => setDraft({ name: '', aliases: '', notes: '' })}><Plus size={16} />新建人物</button></header><div className="content-manager-grid"><aside>{items.map((item) => <button key={item.id} className={draft.id === item.id ? 'active' : ''} onClick={() => setDraft({ id: item.id, name: item.name, aliases: item.aliases.join('、'), notes: item.notes })}><UserRound size={16} /><strong>{item.name}</strong><small>{item.aliases.join('、') || '暂无别名'}</small></button>)}</aside><div className="note-editor character-editor"><label><span>姓名</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label><span>别名（用顿号分隔）</span><input value={draft.aliases} onChange={(event) => setDraft({ ...draft, aliases: event.target.value })} /></label><label><span>自由笔记</span><textarea value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label><div><button className="primary" onClick={async () => { const saved = await window.workspace.characters.save({ id: draft.id, projectId, name: draft.name, aliases: draft.aliases.split(/[、,，]/).map((item) => item.trim()).filter(Boolean), notes: draft.notes }); setDraft({ id: saved.id, name: saved.name, aliases: saved.aliases.join('、'), notes: saved.notes }); load() }}><Save size={15} />保存</button>{draft.id && <button onClick={async () => { if (confirm('删除这个人物？')) { await window.workspace.characters.delete(projectId, draft.id!); setDraft({ name: '', aliases: '', notes: '' }); load() } }}><Trash2 size={15} />删除</button>}</div></div></div></section>
}

export function HistoryView({ projectId, document }: { projectId: string; document?: DocumentNode }): React.JSX.Element {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const load = () => { if (document) void window.workspace.snapshots.list(projectId, document.id).then(setSnapshots) }
  useEffect(load, [projectId, document?.id])
  return <section className="project-view"><header><div><h1>历史</h1><p>{document ? `${document.title} 的可恢复版本` : '请先选择章节'}</p></div>{document && <button onClick={async () => { await window.workspace.snapshots.create(projectId, document.id, 'manual'); load() }}><Clock3 size={16} />手动快照</button>}</header><div className="history-list">{snapshots.map((snapshot) => <article key={snapshot.id}><div><strong>修订 {snapshot.revision}</strong><small>{new Date(snapshot.createdAt).toLocaleString()} · {snapshot.reason}</small></div><p>{snapshot.plainText.slice(0, 140) || '空文档'}{snapshot.plainText.length > 140 ? '…' : ''}</p><button onClick={async () => { if (confirm('恢复前会自动创建当前版本快照。继续吗？')) { await window.workspace.snapshots.restore(projectId, snapshot.id); load() } }}><RotateCcw size={14} />恢复此版本</button></article>)}</div></section>
}

export function PatchDrawer({ projectId, documentId, onClose, onApplied }: { projectId: string; documentId: string; onClose(): void; onApplied(): void }): React.JSX.Element {
  const [patches, setPatches] = useState<TextPatch[]>([]); const load = () => void window.workspace.patches.list(projectId, documentId).then(setPatches)
  useEffect(load, [projectId, documentId])
  return <aside className="patch-drawer"><header><h2>修改提案</h2><button onClick={onClose}>关闭</button></header>{patches.length === 0 ? <p className="empty-copy">还没有修改提案。选中文字后在“同行者”中选择“修改”。</p> : patches.map((patch) => <article key={patch.id}><span className={`patch-status ${patch.status}`}>{patch.status}</span><div className="diff-block"><del>{patch.originalText || '（空）'}</del><ins>{patch.replacement}</ins></div>{patch.status === 'proposed' && <div><button onClick={async () => { await window.workspace.patches.reject(projectId, patch.id); load() }}>拒绝</button><button className="primary" onClick={async () => { const result = await window.workspace.patches.accept(projectId, patch.id); if (result.status === 'stale') alert('目标文字已变化，提案已标记为 stale，请重新生成。'); load(); onApplied() }}>接受并应用</button></div>}</article>)}</aside>
}
