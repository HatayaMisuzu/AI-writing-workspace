import { Check, Clock3, GitCompareArrows, Lightbulb, ListTree, Plus, RotateCcw, Save, Shield, Trash2, UserRound } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Character, CharacterHoverPrefs, DocumentContent, DocumentNode, Idea, MemoryItem, NodeOutline, ProjectNote, Snapshot, TextPatch } from '../../../shared/domain'
import { Modal } from '../components/Modal'
import { snapshotReason } from '../services/snapshot-label'
import { buildHistoryDiff } from '../services/history-diff'
import { buildOutlineCards, noteSectionLabel, outlinePreviewText, parseBatchOutlineLines } from '../services/outline-view'
import { CHARACTER_FIELD_KEYS, CHARACTER_FIELD_LABELS, type CharacterFieldKey } from '../../../shared/domain'
import { normalizeCharacterFields, readFixedCharacterFields } from '../../../shared/character-fields'
import { RelatedTimelineEvents } from './TimelineView'
import { ConfirmAction } from '../components/ConfirmAction'
import { isSingleCharTerm } from '../../../shared/name-matcher'
import { notifyCharactersChanged } from '../services/character-hover'

const patchStatus = (status: TextPatch['status']): string => ({ proposed: '待审阅', accepted: '已接受', rejected: '已拒绝', stale: '已失效' }[status])


type FlushRegistration = { onRegisterFlush(handler?: () => Promise<void>): void }

export function IdeasView({ projectId, onRegisterFlush }: { projectId: string } & FlushRegistration): React.JSX.Element {
  const [ideas, setIdeas] = useState<Idea[]>([]); const [input, setInput] = useState('')
  const inputRef = useRef('')
  const load = useCallback(() => void window.workspace.ideas.list(projectId).then(setIdeas), [projectId])
  useEffect(load, [load])
  useEffect(() => { inputRef.current = input }, [input])
  const flush = useCallback(async (): Promise<void> => {
    const value = inputRef.current.trim()
    if (!value) return
    await window.workspace.ideas.create(projectId, value)
    inputRef.current = ''; setInput(''); load()
  }, [load, projectId])
  useEffect(() => { onRegisterFlush(flush); return () => onRegisterFlush(undefined) }, [flush, onRegisterFlush])
  return <section className="project-view"><header><div><h1>灵感</h1><p>先记下来，暂时不需要分类。</p></div></header><div className="idea-capture"><Lightbulb size={19} /><textarea value={input} onChange={(e) => setInput(e.target.value)} placeholder="记下一闪而过的想法…" /><button className="primary" onClick={() => void flush()}>保存</button></div><div className="idea-list">{ideas.map((idea) => <article key={idea.id}><p>{idea.content}</p><small>{new Date(idea.updatedAt).toLocaleString()}</small></article>)}</div></section>
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

export function NotesView({ projectId, section, onRegisterFlush }: { projectId: string; section: ProjectNote['section'] } & FlushRegistration): React.JSX.Element {
  const [items, setItems] = useState<ProjectNote[]>([])
  const [draft, setDraft] = useState<{ id?: string; title: string; content: string }>({ title: '', content: '' })
  const draftRef = useRef(draft); const savedRef = useRef(JSON.stringify(draft))
  const load = useCallback(() => void window.workspace.notes.list(projectId, section).then(setItems), [projectId, section])
  useEffect(() => { load(); const empty = { title: '', content: '' }; setDraft(empty); savedRef.current = JSON.stringify(empty) }, [load])
  useEffect(() => { draftRef.current = draft }, [draft])
  const selectDraft = useCallback((next: { id?: string; title: string; content: string }): void => { setDraft(next); draftRef.current = next; savedRef.current = JSON.stringify(next) }, [])
  const flush = useCallback(async (): Promise<void> => {
    const current = draftRef.current
    if (JSON.stringify(current) === savedRef.current || (!current.id && !current.title.trim() && !current.content.trim())) return
    const saved = await window.workspace.notes.save({ ...current, projectId, section })
    selectDraft({ id: saved.id, title: saved.title, content: saved.content }); load()
  }, [load, projectId, section, selectDraft])
  useEffect(() => { onRegisterFlush(flush); return () => onRegisterFlush(undefined) }, [flush, onRegisterFlush])
  const label = noteSectionLabel(section)
  return <section className="project-view content-manager"><header><div><h1>{label}</h1><p>自由记录，不要求填写复杂结构。</p></div><button onClick={() => void flush().then(() => selectDraft({ title: '', content: '' }))}><Plus size={16} />新建</button></header><div className="content-manager-grid"><aside>{items.map((item) => <button key={item.id} className={draft.id === item.id ? 'active' : ''} onClick={() => void flush().then(() => selectDraft({ id: item.id, title: item.title, content: item.content }))}><strong>{item.title}</strong><small>{new Date(item.updatedAt).toLocaleDateString()}</small></button>)}</aside><div className="note-editor"><input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="标题" /><textarea value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} placeholder="从一段自由笔记开始……" /><div><button className="primary" onClick={() => void flush()}><Save size={15} />保存</button>{draft.id && <ConfirmAction title="删除笔记" message="删除后无法恢复。确定删除这条笔记吗？" onConfirm={async () => { await window.workspace.notes.delete(projectId, draft.id!); selectDraft({ title: '', content: '' }); load() }}><Trash2 size={15} />删除</ConfirmAction>}</div></div></div></section>
}

export function CharactersView({ projectId, onRegisterFlush, focusCharacterId, onOpenTimelineEvent }: { projectId: string; focusCharacterId?: string; onOpenTimelineEvent?(eventId: string): void } & FlushRegistration): React.JSX.Element {
  const emptyFields = (): Record<CharacterFieldKey, string> => readFixedCharacterFields({})
  const [items, setItems] = useState<Character[]>([])
  const [draft, setDraft] = useState<{ id?: string; name: string; aliases: string; notes: string; fields: Record<CharacterFieldKey, string> }>({
    name: '', aliases: '', notes: '', fields: emptyFields()
  })
  const draftRef = useRef(draft); const savedRef = useRef(JSON.stringify(draft))
  const load = useCallback(() => void window.workspace.characters.list(projectId).then(setItems), [projectId])
  useEffect(() => { load(); const empty = { name: '', aliases: '', notes: '', fields: emptyFields() }; setDraft(empty); savedRef.current = JSON.stringify(empty) }, [load])
  useEffect(() => { draftRef.current = draft }, [draft])
  const selectDraft = useCallback((next: { id?: string; name: string; aliases: string; notes: string; fields: Record<CharacterFieldKey, string> }): void => {
    setDraft(next); draftRef.current = next; savedRef.current = JSON.stringify(next)
  }, [])
  const flush = useCallback(async (): Promise<void> => {
    const current = draftRef.current
    if (JSON.stringify(current) === savedRef.current || (!current.id && !current.name.trim() && !current.notes.trim() && !current.aliases.trim() && CHARACTER_FIELD_KEYS.every((key) => !current.fields[key].trim()))) return
    const saved = await window.workspace.characters.save({
      id: current.id, projectId, name: current.name, aliases: current.aliases.split('、').map((part) => part.trim()).filter(Boolean),
      notes: current.notes, fields: normalizeCharacterFields(current.fields)
    })
    selectDraft({ id: saved.id, name: saved.name, aliases: saved.aliases.join('、'), notes: saved.notes, fields: readFixedCharacterFields(saved.fields) }); load(); notifyCharactersChanged(projectId)
  }, [load, projectId, selectDraft])
  useEffect(() => { onRegisterFlush(flush); return () => onRegisterFlush(undefined) }, [flush, onRegisterFlush])
  useEffect(() => {
    const focus = focusCharacterId ? items.find((item) => item.id === focusCharacterId) : undefined
    if (focus && draftRef.current.id !== focus.id) selectDraft({ id: focus.id, name: focus.name, aliases: focus.aliases.join('、'), notes: focus.notes, fields: readFixedCharacterFields(focus.fields) })
  }, [focusCharacterId, items, selectDraft])
  const setField = (key: CharacterFieldKey, value: string): void => {
    setDraft((prev) => ({ ...prev, fields: { ...prev.fields, [key]: value } }))
  }
  return <section className="project-view content-manager" data-testid="characters-view"><header><div><h1>人物</h1><p>固定字段均可留空；不预置身份文案。所有内容只属于当前作品。</p></div><button onClick={() => void flush().then(() => selectDraft({ name: '', aliases: '', notes: '', fields: emptyFields() }))}><Plus size={16} />新建人物</button></header><div className="content-manager-grid"><aside>{items.map((item) => <button key={item.id} className={draft.id === item.id ? 'active' : ''} onClick={() => void flush().then(() => selectDraft({ id: item.id, name: item.name, aliases: item.aliases.join('、'), notes: item.notes, fields: readFixedCharacterFields(item.fields) }))}><UserRound size={16} /><strong>{item.name}</strong><small>{item.aliases.join('、') || item.fields.identity || '暂无别名'}</small></button>)}</aside><div className="note-editor character-editor"><label><span>姓名</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label><span>别名（用顿号分隔）</span><input value={draft.aliases} onChange={(event) => setDraft({ ...draft, aliases: event.target.value })} /></label>{draft.id && <SingleCharHoverTerms projectId={projectId} character={items.find((item) => item.id === draft.id)} />}{CHARACTER_FIELD_KEYS.map((key) => <label key={key}><span>{CHARACTER_FIELD_LABELS[key]}</span>{key === 'currentState' || key === 'appearance' || key === 'personality' || key === 'goal' ? <textarea value={draft.fields[key]} onChange={(event) => setField(key, event.target.value)} rows={2} /> : <input value={draft.fields[key]} onChange={(event) => setField(key, event.target.value)} />}</label>)}<label><span>自由笔记</span><textarea value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label>{draft.id && onOpenTimelineEvent && <RelatedTimelineEvents projectId={projectId} characterId={draft.id} onOpenEvent={onOpenTimelineEvent} />}<div><button className="primary" onClick={() => void flush()}><Save size={15} />保存</button>{draft.id && <ConfirmAction title="删除人物" message="确定删除这个人物吗？" onConfirm={async () => { await window.workspace.characters.delete(projectId, draft.id!); selectDraft({ name: '', aliases: '', notes: '', fields: emptyFields() }); load(); notifyCharactersChanged(projectId) }}><Trash2 size={15} />删除</ConfirmAction>}</div></div></div></section>
}

/** F14 Q1：单字名/别名默认不参与悬停与「本章提及」，作者可按别名打开（存 settings_json）。 */
function SingleCharHoverTerms({ projectId, character }: { projectId: string; character?: Character }): React.JSX.Element | null {
  const [prefs, setPrefs] = useState<CharacterHoverPrefs>()
  useEffect(() => { void window.workspace.characters.hoverPrefs(projectId).then(setPrefs) }, [projectId])
  const terms = character ? [...new Set([character.name, ...character.aliases].map((term) => term.trim()).filter((term) => isSingleCharTerm(term)))] : []
  if (!character || !terms.length || !prefs) return null
  const enabled = (term: string): boolean => prefs.enabledSingleTerms.some((item) => item.characterId === character.id && item.term === term)
  const toggle = async (term: string): Promise<void> => {
    const rest = prefs.enabledSingleTerms.filter((item) => !(item.characterId === character.id && item.term === term))
    const next = await window.workspace.characters.setHoverPrefs(projectId, { ...prefs, enabledSingleTerms: enabled(term) ? rest : [...rest, { characterId: character.id, term }] })
    setPrefs(next); notifyCharactersChanged(projectId)
  }
  return <div className="single-char-hover" data-testid="single-char-hover"><small>单字别名不参与悬停</small>{terms.map((term) => <label key={term} className="inline-check"><input type="checkbox" checked={enabled(term)} onChange={() => void toggle(term)} />让「{term}」参与悬停和本章提及</label>)}</div>
}

export function HistoryView({ projectId, document, currentContent, onRestored }: { projectId: string; document?: DocumentNode; currentContent?: DocumentContent; onRestored?(content: Awaited<ReturnType<typeof window.workspace.snapshots.restore>>): void }): React.JSX.Element {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [compareSnapshot, setCompareSnapshot] = useState<Snapshot>()
  const documentId = document?.id
  const load = useCallback(() => { if (documentId) void window.workspace.snapshots.list(projectId, documentId).then(setSnapshots) }, [projectId, documentId])
  useEffect(load, [load])
  const diff = useMemo(() => compareSnapshot ? buildHistoryDiff(compareSnapshot.plainText, currentContent?.plainText ?? '') : [], [compareSnapshot, currentContent?.plainText])
  return <section className="project-view"><header><div><h1>历史</h1><p>{document ? `${document.title} 的可恢复版本` : '请先选择章节'}</p></div>{document && <button onClick={async () => { await window.workspace.snapshots.create(projectId, document.id, 'manual'); load() }}><Clock3 size={16} />手动快照</button>}</header><div className="history-list">{snapshots.length === 0 && <div className="empty-section"><Clock3 size={28} /><h3>还没有历史快照</h3><p>手动创建，或在大段删除、定时保存和恢复前自动生成。</p></div>}{snapshots.map((snapshot) => <article key={snapshot.id}><div><strong>修订 {snapshot.revision}</strong><small>{new Date(snapshot.createdAt).toLocaleString()} · {snapshotReason(snapshot)}</small></div><p>{snapshot.plainText.slice(0, 140) || '空文档'}{snapshot.plainText.length > 140 ? '…' : ''}</p><div className="history-actions"><button onClick={() => setCompareSnapshot(snapshot)}><GitCompareArrows size={14} />查看差异</button><ConfirmAction title="恢复历史版本" message="恢复前会自动创建当前版本快照。继续吗？" onConfirm={async () => { const restored = await window.workspace.snapshots.restore(projectId, snapshot.id); onRestored?.(restored); load() }}><RotateCcw size={14} />恢复此版本</ConfirmAction></div></article>)}</div>{compareSnapshot && <Modal title={`修订 ${compareSnapshot.revision} 与当前正文的差异`} onClose={() => setCompareSnapshot(undefined)} width={860}><div className="history-diff" aria-label="历史版本差异">{diff.length === 0 ? <p>两个版本没有文字差异。</p> : diff.map((segment, index) => segment.type === 'insert' ? <ins key={index}>{segment.value}</ins> : segment.type === 'delete' ? <del key={index}>{segment.value}</del> : <span key={index}>{segment.value}</span>)}</div><p className="diff-legend"><span className="insert">新增</span><span className="delete">删除</span> 差异只供查看，恢复前仍会保存当前版本。</p></Modal>}</section>
}


/** S4：大纲视图 — 卡片列表，顺序与章树同源；支持批量建章。 */
export function OutlineView({ projectId, tree, onTreeChanged, onOpenChapter, onRegisterFlush }: {
  projectId: string; tree: DocumentNode[]; onTreeChanged(): Promise<void> | void
  onOpenChapter(node: DocumentNode): void
} & FlushRegistration): React.JSX.Element {
  const [outlines, setOutlines] = useState<NodeOutline[]>([])
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchText, setBatchText] = useState('')
  const [batchVolumeId, setBatchVolumeId] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [editing, setEditing] = useState<{ nodeId: string; summary: string; beats: string; hook: string }>()

  const load = useCallback(() => { void window.workspace.outlines.list(projectId).then(setOutlines) }, [projectId])
  useEffect(load, [load])
  useEffect(() => {
    const volumes = tree.filter((node) => node.type === 'volume')
    if (!batchVolumeId && volumes[0]) setBatchVolumeId(volumes[0].id)
  }, [tree, batchVolumeId])

  const cards = useMemo(() => buildOutlineCards(tree, outlines), [tree, outlines])
  const volumes = tree.filter((node) => node.type === 'volume')

  const saveEdit = async (): Promise<void> => {
    if (!editing) return
    setBusy(true); setError(undefined)
    try {
      const beats = editing.beats.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      await window.workspace.outlines.save({ projectId, nodeId: editing.nodeId, summary: editing.summary, beats, hook: editing.hook })
      setEditing(undefined); load()
    } catch (next) { setError(next instanceof Error ? next.message : String(next)) }
    finally { setBusy(false) }
  }

  const runBatch = async (): Promise<void> => {
    const lines = parseBatchOutlineLines(batchText)
    if (!batchVolumeId) { setError('请先选择一卷。'); return }
    if (!lines.length) { setError('请输入至少一行细纲。'); return }
    setBusy(true); setError(undefined)
    try {
      await window.workspace.documents.batchCreateChapters({ projectId, volumeId: batchVolumeId, lines })
      setBatchOpen(false); setBatchText(''); await onTreeChanged(); load()
    } catch (next) { setError(next instanceof Error ? next.message : String(next)) }
    finally { setBusy(false) }
  }

  return <section className="project-view outline-view">
    <header>
      <div><h1>大纲</h1><p>三层：全书核心大纲 → 卷梗概 → 章细纲。顺序与正文目录一致。批量建章会生成空章（构思）并带上细纲。</p></div>
      <button className="primary" disabled={!volumes.length} onClick={() => { setError(undefined); setBatchOpen(true) }}><Plus size={16} />批量建章</button>
    </header>
    <div className="book-outline-slot" aria-label="全书核心大纲">
      <NotesView projectId={projectId} section="outline" onRegisterFlush={onRegisterFlush} />
    </div>
    <h2 className="outline-layer-heading">卷 / 章细纲</h2>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {cards.length === 0 ? <div className="empty-section"><ListTree size={28} /><h3>还没有卷章</h3><p>先在正文区建卷，再回到这里规划细纲。</p></div>
      : <div className="outline-card-list" aria-label="大纲卡片">
        {cards.map((card) => {
          const node = tree.find((item) => item.id === card.nodeId)
          const preview = outlinePreviewText(card)
          return <article key={card.nodeId} className={`outline-card ${card.type}`}>
            <header>
              <strong>{card.type === 'volume' ? '卷' : '章'} · {card.title}</strong>
              <div>
                {card.type === 'chapter' && node && <button onClick={() => onOpenChapter(node)}>打开正文</button>}
                <button onClick={() => setEditing({ nodeId: card.nodeId, summary: card.summary, beats: card.beats.join('\n'), hook: card.hook })}>编辑细纲</button>
              </div>
            </header>
            <p className="outline-preview">{preview || '（尚未填写细纲）'}</p>
          </article>
        })}
      </div>}
    {batchOpen && <Modal title="批量建章" onClose={() => setBatchOpen(false)} width={560}>
      <div className="node-create-form">
        <label><span>目标卷</span>
          <select value={batchVolumeId ?? ''} onChange={(event) => setBatchVolumeId(event.target.value)}>
            {volumes.map((volume) => <option key={volume.id} value={volume.id}>{volume.title}</option>)}
          </select>
        </label>
        <label><span>细纲（每行一章）</span>
          <textarea rows={12} value={batchText} onChange={(event) => setBatchText(event.target.value)} placeholder={'主角入城\n夜探旧宅\n对质真相'} />
        </label>
        <p className="context-note">将生成 {parseBatchOutlineLines(batchText).length} 个空章节，状态为构思（尚无正文），并写入对应细纲。</p>
        {error && <div className="inline-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" onClick={() => setBatchOpen(false)}>取消</button>
          <button className="primary" disabled={busy} onClick={() => void runBatch()}>生成章节</button>
        </div>
      </div>
    </Modal>}
    {editing && <Modal title="编辑细纲" onClose={() => setEditing(undefined)} width={560}>
      <div className="node-create-form">
        <label><span>梗概</span><textarea rows={3} value={editing.summary} onChange={(event) => setEditing({ ...editing, summary: event.target.value })} /></label>
        <label><span>要点（每行一条）</span><textarea rows={6} value={editing.beats} onChange={(event) => setEditing({ ...editing, beats: event.target.value })} /></label>
        <label><span>章末钩子</span><input value={editing.hook} onChange={(event) => setEditing({ ...editing, hook: event.target.value })} /></label>
        <div className="modal-actions">
          <button type="button" onClick={() => setEditing(undefined)}>取消</button>
          <button className="primary" disabled={busy} onClick={() => void saveEdit()}>保存</button>
        </div>
      </div>
    </Modal>}
  </section>
}

/** S4：编辑器侧栏 — 当前章细纲。 */
export function ChapterOutlineAside({ projectId, chapter }: {
  projectId: string; chapter?: DocumentNode
}): React.JSX.Element {
  const [summary, setSummary] = useState('')
  const [beats, setBeats] = useState('')
  const [hook, setHook] = useState('')
  const [notice, setNotice] = useState<string>()
  const [busy, setBusy] = useState(false)

  const chapterId = chapter?.type === 'chapter' ? chapter.id : undefined
  const chapterTitle = chapter?.type === 'chapter' ? chapter.title : undefined
  useEffect(() => {
    let active = true
    setNotice(undefined)
    if (!chapterId) {
      setSummary(''); setBeats(''); setHook('')
      return
    }
    void window.workspace.outlines.get(projectId, chapterId).then((outline) => {
      if (!active) return
      setSummary(outline?.summary ?? '')
      setBeats((outline?.beats ?? []).join('\n'))
      setHook(outline?.hook ?? '')
    })
    return () => { active = false }
  }, [projectId, chapterId])

  const save = async (): Promise<void> => {
    if (!chapter || chapter.type !== 'chapter') return
    setBusy(true); setNotice(undefined)
    try {
      const nextBeats = beats.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      await window.workspace.outlines.save({ projectId, nodeId: chapter.id, summary, beats: nextBeats, hook })
      setNotice('已保存')
    } catch (error) { setNotice(`保存失败：${error instanceof Error ? error.message : String(error)}`) }
    finally { setBusy(false) }
  }

  if (!chapter || chapter.type !== 'chapter') {
    return <aside className="chapter-outline-aside" aria-label="本章细纲"><header><h2>本章细纲</h2></header><p className="empty-copy">打开章节后可在此查看与编辑细纲。</p></aside>
  }

  return <aside className="chapter-outline-aside" aria-label="本章细纲">
    <header><h2>本章细纲</h2><small>{chapterTitle}</small></header>
    <label><span>梗概</span><textarea rows={4} value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="这一章要写什么…" /></label>
    <label><span>要点</span><textarea rows={6} value={beats} onChange={(event) => setBeats(event.target.value)} placeholder="每行一条" /></label>
    <label><span>章末钩子</span><input value={hook} onChange={(event) => setHook(event.target.value)} placeholder="可选" /></label>
    <div className="chapter-outline-actions"><button className="primary" disabled={busy} onClick={() => void save()}>保存细纲</button>{notice && <span role="status">{notice}</span>}</div>
  </aside>
}


export function PatchDrawer({ projectId, documentId, onClose, onAccept, onAcceptAll }: { projectId: string; documentId: string; onClose(): void; onAccept(patch: TextPatch): Promise<TextPatch>; onAcceptAll?(patches: TextPatch[]): Promise<{ accepted: number; stale: number }> }): React.JSX.Element {
  const [patches, setPatches] = useState<TextPatch[]>([]); const load = useCallback(() => void window.workspace.patches.list(projectId, documentId).then(setPatches), [projectId, documentId])
  const [error, setError] = useState<string>()
  useEffect(load, [load])
  return <aside className="patch-drawer"><header><h2>修改提案</h2><button onClick={onClose}>关闭</button></header>{error && <div className="inline-error" role="alert">{error}</div>}{onAcceptAll && patches.filter((patch) => patch.status === 'proposed').length > 1 && <div className="proofread-actions"><button className="primary" onClick={async () => { try { const result = await onAcceptAll(patches.filter((patch) => patch.status === 'proposed')); setError(result.stale ? `已接受 ${result.accepted} 条；${result.stale} 条因原文已变化而失效。` : undefined); load() } catch (nextError) { setError(`应用失败：${nextError instanceof Error ? nextError.message : String(nextError)}`); load() } }}>全部接受（{patches.filter((patch) => patch.status === 'proposed').length} 条）</button></div>}{patches.length === 0 ? <p className="empty-copy">还没有修改提案。选中文字后在“同行者”中选择“修改”。</p> : patches.map((patch) => <article key={patch.id}><span className={`patch-status ${patch.status}`}>{patchStatus(patch.status)}</span><div className="diff-block"><del>{patch.originalText || '（空）'}</del><ins>{patch.replacement}</ins></div>{patch.status === 'proposed' && <div><button onClick={async () => { await window.workspace.patches.reject(projectId, patch.id); load() }}>拒绝</button><button className="primary" onClick={async () => { try { const result = await onAccept(patch); setError(result.status === 'stale' ? '目标文字或章节版本已变化，提案已经失效，请重新生成。' : undefined); load() } catch (nextError) { setError(`应用失败：${nextError instanceof Error ? nextError.message : String(nextError)}`) } }}>接受并应用</button></div>}</article>)}</aside>
}
