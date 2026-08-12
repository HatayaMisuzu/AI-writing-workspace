import { FilePlus2, Lightbulb, Search, SidebarClose, SlidersHorizontal } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DocumentContent, DocumentNode, Project, SearchResult } from '../../../shared/domain'
import { ProjectSidebar, type ProjectSection } from '../components/ProjectSidebar'
import { EditorSurface, type EditorSelection } from '../components/EditorSurface'
import { AssistantPanel } from '../components/AssistantPanel'
import { CharactersView, HistoryView, IdeasView, MemoryView, NotesView, PatchDrawer } from './ProjectViews'
import { Modal } from '../components/Modal'

export function WorkspaceScreen({ project, onProjectChanged, onSettings }: { project: Project; onProjectChanged(): void; onSettings(): void }): React.JSX.Element {
  const [tree, setTree] = useState<DocumentNode[]>([])
  const [selected, setSelected] = useState<DocumentNode>()
  const [content, setContent] = useState<DocumentContent>()
  const [section, setSection] = useState<ProjectSection>('manuscript')
  const [assistantCollapsed, setAssistantCollapsed] = useState(false)
  const [focusMode, setFocusMode] = useState(false)
  const [selection, setSelection] = useState<EditorSelection>()
  const [ideaOpen, setIdeaOpen] = useState(false)
  const [ideaText, setIdeaText] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [patchOpen, setPatchOpen] = useState(false)
  const [insertCandidate, setInsertCandidate] = useState<(text: string) => void>(() => () => undefined)

  const loadTree = useCallback(async (preferredId?: string): Promise<void> => {
    const next = await window.workspace.documents.tree(project.id)
    setTree(next)
    const candidate = next.find((node) => node.id === preferredId) ?? next.find((node) => node.type === 'chapter')
    if (candidate && (!selected || preferredId)) await openDocument(candidate)
  }, [project.id])
  const openDocument = async (node: DocumentNode): Promise<void> => {
    if (node.type === 'volume') return
    const nextContent = await window.workspace.documents.get(project.id, node.id)
    setSelected(node); setContent(nextContent); setSection('manuscript'); setSelection(undefined)
  }
  useEffect(() => { void window.workspace.projects.touch(project.id); void loadTree() }, [project.id])
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.key.toLowerCase() === 'j') { event.preventDefault(); setIdeaOpen(true) }
      if (event.ctrlKey && event.key.toLowerCase() === 'f' && event.shiftKey) { event.preventDefault(); setSearchOpen(true) }
      if (event.key === 'Escape' && focusMode) setFocusMode(false)
    }
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler)
  }, [focusMode])

  const createNode = async (type: 'volume' | 'chapter', parentId?: string): Promise<void> => {
    const title = prompt(type === 'volume' ? '卷名' : '章节名', type === 'volume' ? '新卷' : '新章节')?.trim()
    if (!title) return
    const node = await window.workspace.documents.create({ projectId: project.id, parentId: type === 'chapter' ? parentId : null, type, title })
    await loadTree(type === 'chapter' ? node.id : undefined)
  }
  const runSearch = async (): Promise<void> => setSearchResults(await window.workspace.documents.search(project.id, searchQuery))
  const totalWords = useMemo(() => tree.reduce((sum, node) => sum + (node.type === 'chapter' ? node.wordCount : 0), 0), [tree])

  return <div className={focusMode ? 'workspace-screen is-focus' : 'workspace-screen'}>
    {!focusMode && <ProjectSidebar project={project} tree={tree} selectedId={selected?.id} section={section} onSection={setSection} onSelect={(node) => void openDocument(node)} onNewVolume={() => void createNode('volume')} onNewChapter={(parent) => void createNode('chapter', parent)} onReorder={async (documentId, parentId, orderIndex) => { await window.workspace.documents.reorder(project.id, documentId, parentId, orderIndex); await loadTree(selected?.id) }} />}
    <div className="workspace-main">
      <div className="workspace-actions"><button onClick={() => setSearchOpen(true)}><Search size={16} />全文检索</button><button onClick={() => setIdeaOpen(true)}><Lightbulb size={16} />快速灵感 <kbd>Ctrl J</kbd></button>{selected && <button onClick={() => setPatchOpen(true)}><SlidersHorizontal size={16} />修改提案</button>}<span />{focusMode && <button onClick={() => setFocusMode(false)}><SidebarClose size={16} />退出专注</button>}</div>
      {section === 'manuscript' && selected && content ? <EditorSurface node={selected} content={content} focusMode={focusMode} onFocusMode={setFocusMode} onSaved={(saved) => { setContent(saved); void loadTree(selected.id); onProjectChanged() }} onSelection={setSelection} onRegisterInsert={(handler) => setInsertCandidate(() => handler)} />
        : section === 'ideas' ? <IdeasView projectId={project.id} />
        : section === 'history' ? <HistoryView projectId={project.id} document={selected} />
        : section === 'ai-data' ? <MemoryView projectId={project.id} />
        : section === 'story' ? <NotesView projectId={project.id} section="story" />
        : section === 'references' ? <NotesView projectId={project.id} section="reference" />
        : section === 'characters' ? <CharactersView projectId={project.id} />
        : <section className="project-view placeholder-view"><FilePlus2 size={34} /><h1>内容</h1><p>这是辅助层，不要求作者维护复杂结构。</p></section>}
      <footer className="workspace-status"><span className="saved-dot" />本地项目<span>本章 {content?.wordCount.toLocaleString() ?? 0} 字</span><span>全书 {totalWords.toLocaleString()} 字</span><span>项目内容严格隔离</span></footer>
    </div>
    {!focusMode && <AssistantPanel project={project} documentId={selected?.id} selection={selection} collapsed={assistantCollapsed} onCollapse={() => setAssistantCollapsed(!assistantCollapsed)} onInsertCandidate={insertCandidate} onPatchCreated={() => setPatchOpen(true)} onOpenSettings={onSettings} />}
    {ideaOpen && <div className="quick-idea-popover"><header><strong>快速记录灵感</strong><kbd>Ctrl J</kbd></header><textarea autoFocus value={ideaText} onChange={(event) => setIdeaText(event.target.value)} placeholder="记下一闪而过的想法…" /><div><button onClick={() => setIdeaOpen(false)}>取消</button><button className="primary" onClick={async () => { if (ideaText.trim()) await window.workspace.ideas.create(project.id, ideaText); setIdeaText(''); setIdeaOpen(false) }}>保存并返回正文</button></div></div>}
    {searchOpen && <Modal title={`在《${project.title}》中检索`} onClose={() => setSearchOpen(false)} width={680}><div className="search-dialog"><div className="dialog-search"><input autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void runSearch() }} placeholder="输入关键词；只检索当前作品" /><button className="primary" onClick={() => void runSearch()}>搜索</button></div><div className="search-results">{searchResults.map((result) => <button key={result.documentId} onClick={async () => { const node = tree.find((item) => item.id === result.documentId); if (node) await openDocument(node); setSearchOpen(false) }}><strong>{result.title}</strong><p dangerouslySetInnerHTML={{ __html: result.snippet }} /></button>)}</div></div></Modal>}
    {patchOpen && selected && <PatchDrawer projectId={project.id} documentId={selected.id} onClose={() => setPatchOpen(false)} onApplied={() => void openDocument(selected)} />}
  </div>
}
