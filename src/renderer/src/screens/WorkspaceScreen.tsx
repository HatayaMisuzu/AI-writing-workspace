import { FilePlus2, Lightbulb, Search, SidebarClose, SlidersHorizontal } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DocumentContent, DocumentNode, Project, SearchResult, TextPatch } from '../../../shared/domain'
import { ProjectSidebar, type ProjectSection } from '../components/ProjectSidebar'
import { EditorSurface, type EditorController, type EditorSelection } from '../components/EditorSurface'
import { AssistantPanel } from '../components/AssistantPanel'
import { CharactersView, HistoryView, IdeasView, MemoryView, NotesView, PatchDrawer } from './ProjectViews'
import { Modal } from '../components/Modal'
import { parseSearchSnippet } from '../services/search-snippet'

const renderSnippet = (snippet: string): React.ReactNode[] => {
  return parseSearchSnippet(snippet).map((segment, index) => segment.highlighted ? <mark key={index}>{segment.text}</mark> : segment.text)
}

export function WorkspaceScreen({ project, onProjectChanged, onSettings, onRegisterBeforeLeave }: {
  project: Project; onProjectChanged(): void; onSettings(): void; onRegisterBeforeLeave(handler?: () => Promise<void>): void
}): React.JSX.Element {
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
  const [nodeCreator, setNodeCreator] = useState<{ type: 'volume' | 'chapter'; parentId?: string; title: string }>()
  const [nodeEditor, setNodeEditor] = useState<{ node: DocumentNode; action: 'rename' | 'delete'; title: string }>()
  const [navigationError, setNavigationError] = useState<string>()
  const [insertCandidate, setInsertCandidate] = useState<(text: string) => Promise<void>>(() => async () => undefined)
  const editorController = useRef<EditorController | undefined>(undefined)
  const navigationSequence = useRef(0)

  const refreshTree = useCallback(async (): Promise<DocumentNode[]> => {
    const next = await window.workspace.documents.tree(project.id); setTree(next); return next
  }, [project.id])
  const flushEditor = useCallback(async (): Promise<void> => { await editorController.current?.flush() }, [])
  useEffect(() => { onRegisterBeforeLeave(flushEditor); return () => onRegisterBeforeLeave(undefined) }, [flushEditor, onRegisterBeforeLeave])

  const openDocument = useCallback(async (node: DocumentNode): Promise<void> => {
    if (node.type === 'volume' || node.id === selected?.id) return
    const request = ++navigationSequence.current
    try {
      const nextContent = await window.workspace.documents.get(project.id, node.id)
      if (request !== navigationSequence.current) return
      await flushEditor()
      if (request !== navigationSequence.current) return
      setSelected(node); setContent(nextContent); setSection('manuscript'); setSelection(undefined); setNavigationError(undefined)
    } catch (error) { setNavigationError(`保存失败，仍停留在当前章节：${error instanceof Error ? error.message : String(error)}`) }
  }, [flushEditor, project.id, selected?.id])

  useEffect(() => {
    let active = true
    void (async () => {
      await window.workspace.projects.touch(project.id)
      const next = await window.workspace.documents.tree(project.id)
      if (!active) return
      setTree(next)
      const chapter = next.find((node) => node.type === 'chapter')
      if (chapter) { const nextContent = await window.workspace.documents.get(project.id, chapter.id); if (active) { setSelected(chapter); setContent(nextContent) } }
    })()
    return () => { active = false }
  }, [project.id])

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.key.toLowerCase() === 'j') { event.preventDefault(); setIdeaOpen(true) }
      if (event.ctrlKey && event.key.toLowerCase() === 'f' && event.shiftKey) { event.preventDefault(); setSearchOpen(true) }
      if (event.key === 'Escape' && focusMode) setFocusMode(false)
    }
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler)
  }, [focusMode])

  const changeSection = async (next: ProjectSection): Promise<void> => {
    if (next === section) return
    try { if (section === 'manuscript') await flushEditor(); setSection(next); setNavigationError(undefined) }
    catch (error) { setNavigationError(`保存失败，无法离开正文：${error instanceof Error ? error.message : String(error)}`) }
  }
  const requestCreateNode = async (type: 'volume' | 'chapter', parentId?: string): Promise<void> => {
    try { await flushEditor() } catch (error) { setNavigationError(`保存失败，未创建新节点：${error instanceof Error ? error.message : String(error)}`); return }
    if (type === 'chapter' && !parentId) {
      setNavigationError('请先新建一卷，再在卷中添加章节。')
      return
    }
    setNodeCreator({ type, parentId, title: type === 'volume' ? '新卷' : '新章节' })
  }
  const updateNode = async (): Promise<void> => {
    if (!nodeEditor) return
    try {
      await flushEditor()
      if (nodeEditor.action === 'rename') {
        if (!nodeEditor.title.trim()) throw new Error('名称不能为空。')
        await window.workspace.documents.rename(project.id, nodeEditor.node.id, nodeEditor.title.trim())
      } else {
        await window.workspace.documents.delete(project.id, nodeEditor.node.id)
        if (nodeEditor.node.id === selected?.id || (nodeEditor.node.type === 'volume' && selected?.parentId === nodeEditor.node.id)) {
          setSelected(undefined); setContent(undefined); setSelection(undefined)
        }
      }
      setNodeEditor(undefined); await refreshTree(); onProjectChanged()
    } catch (error) { setNavigationError(`操作失败：${error instanceof Error ? error.message : String(error)}`) }
  }
  const createNode = async (): Promise<void> => {
    if (!nodeCreator?.title.trim()) return
    const { type, parentId, title } = nodeCreator
    try {
      const node = await window.workspace.documents.create({ projectId: project.id, parentId: type === 'chapter' ? parentId : null, type, title: title.trim() })
      setNodeCreator(undefined)
      const next = await refreshTree()
      if (type === 'chapter') await openDocument(next.find((item) => item.id === node.id) ?? node)
    } catch (error) { setNavigationError(`创建失败：${error instanceof Error ? error.message : String(error)}`) }
  }
  const runSearch = async (): Promise<void> => setSearchResults(await window.workspace.documents.search(project.id, searchQuery))
  const totalWords = useMemo(() => tree.reduce((sum, node) => sum + (node.type === 'chapter' ? node.wordCount : 0), 0), [tree])
  const registerController = useCallback((controller?: EditorController): void => { editorController.current = controller }, [])
  const createPatch = useCallback(async (target: EditorSelection, replacement: string): Promise<void> => {
    if (!editorController.current) throw new Error('编辑器尚未就绪。')
    await editorController.current.createPatch(target, replacement); setPatchOpen(true)
  }, [])
  const acceptPatch = useCallback(async (patch: TextPatch): Promise<TextPatch> => {
    if (!editorController.current || patch.documentId !== selected?.id) throw new Error('请先打开提案所属章节。')
    const result = await editorController.current.applyPatch(patch)
    if (result.status === 'accepted') { await refreshTree(); onProjectChanged() }
    return result
  }, [onProjectChanged, refreshTree, selected?.id])

  return <div className={focusMode ? 'workspace-screen is-focus' : 'workspace-screen'}>
    {!focusMode && <ProjectSidebar project={project} tree={tree} selectedId={selected?.id} section={section} onSection={(next) => void changeSection(next)} onSelect={(node) => void openDocument(node)} onNewVolume={() => void requestCreateNode('volume')} onNewChapter={(parent) => void requestCreateNode('chapter', parent)} onRename={(node) => setNodeEditor({ node, action: 'rename', title: node.title })} onDelete={(node) => setNodeEditor({ node, action: 'delete', title: node.title })} onReorder={async (documentId, parentId, orderIndex) => { try { await flushEditor(); await window.workspace.documents.reorder(project.id, documentId, parentId, orderIndex); await refreshTree() } catch (error) { setNavigationError(String(error)) } }} />}
    <div className="workspace-main">
      <div className="workspace-actions"><button onClick={() => setSearchOpen(true)}><Search size={16} />全文检索</button><button onClick={() => setIdeaOpen(true)}><Lightbulb size={16} />快速灵感 <kbd>Ctrl J</kbd></button>{selected && <button onClick={() => setPatchOpen(true)}><SlidersHorizontal size={16} />修改提案</button>}<span />{focusMode && <button onClick={() => setFocusMode(false)}><SidebarClose size={16} />退出专注</button>}</div>
      {navigationError && <div className="navigation-error" role="alert">{navigationError}</div>}
      {section === 'manuscript' && selected && content ? <EditorSurface node={selected} content={content} focusMode={focusMode} onFocusMode={setFocusMode} onSaved={(saved) => { setContent(saved); void refreshTree(); onProjectChanged() }} onSelection={setSelection} onRegisterInsert={(handler) => setInsertCandidate(() => handler)} onRegisterController={registerController} onOpenPatches={() => setPatchOpen(true)} />
        : section === 'ideas' ? <IdeasView projectId={project.id} />
        : section === 'history' ? <HistoryView projectId={project.id} document={selected} currentContent={content} onRestored={(restored) => { setContent(restored); void refreshTree() }} />
        : section === 'ai-data' ? <MemoryView projectId={project.id} />
        : section === 'story' ? <NotesView projectId={project.id} section="story" />
        : section === 'references' ? <NotesView projectId={project.id} section="reference" />
        : section === 'characters' ? <CharactersView projectId={project.id} />
        : <section className="project-view placeholder-view"><FilePlus2 size={34} /><h1>内容</h1><p>这是辅助层，不要求作者维护复杂结构。</p></section>}
      <footer className="workspace-status"><span className="saved-dot" />本地项目<span>本章 {content?.wordCount.toLocaleString() ?? 0} 字</span><span>全书 {totalWords.toLocaleString()} 字</span><span>项目内容严格隔离</span></footer>
    </div>
    {!focusMode && <AssistantPanel project={project} documentId={selected?.id} documentRevision={content?.revision} selection={selection} collapsed={assistantCollapsed} onCollapse={() => setAssistantCollapsed(!assistantCollapsed)} onInsertCandidate={insertCandidate} onCreatePatch={createPatch} onBeforeAI={flushEditor} onOpenSettings={onSettings} />}
    {ideaOpen && <div className="quick-idea-popover"><header><strong>快速记录灵感</strong><kbd>Ctrl J</kbd></header><textarea autoFocus value={ideaText} onChange={(event) => setIdeaText(event.target.value)} placeholder="记下一闪而过的想法…" /><div><button onClick={() => setIdeaOpen(false)}>取消</button><button className="primary" onClick={async () => { if (ideaText.trim()) await window.workspace.ideas.create(project.id, ideaText); setIdeaText(''); setIdeaOpen(false) }}>保存并返回正文</button></div></div>}
    {searchOpen && <Modal title={`在《${project.title}》中检索`} onClose={() => setSearchOpen(false)} width={680}><div className="search-dialog"><div className="dialog-search"><input autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void runSearch() }} placeholder="输入关键词；只检索当前作品" /><button className="primary" onClick={() => void runSearch()}>搜索</button></div><div className="search-results">{searchResults.map((result) => <button key={result.documentId} onClick={async () => { const node = tree.find((item) => item.id === result.documentId); if (node) await openDocument(node); setSearchOpen(false) }}><strong>{result.title}</strong><p>{renderSnippet(result.snippet)}</p></button>)}</div></div></Modal>}
    {patchOpen && selected && <PatchDrawer projectId={project.id} documentId={selected.id} onClose={() => setPatchOpen(false)} onAccept={acceptPatch} />}
    {nodeCreator && <Modal title={nodeCreator.type === 'volume' ? '新建卷' : '新建章节'} onClose={() => setNodeCreator(undefined)}><form className="node-create-form" onSubmit={(event) => { event.preventDefault(); void createNode() }}><label><span>{nodeCreator.type === 'volume' ? '卷名' : '章节名'}</span><input autoFocus value={nodeCreator.title} onChange={(event) => setNodeCreator({ ...nodeCreator, title: event.target.value })} /></label><div className="modal-actions"><button type="button" onClick={() => setNodeCreator(undefined)}>取消</button><button className="primary" type="submit">创建</button></div></form></Modal>}
    {nodeEditor && <Modal title={nodeEditor.action === 'rename' ? `重命名${nodeEditor.node.type === 'volume' ? '卷' : '章节'}` : `删除${nodeEditor.node.type === 'volume' ? '卷' : '章节'}`} onClose={() => setNodeEditor(undefined)}><div className="node-create-form">{nodeEditor.action === 'rename' ? <label><span>名称</span><input autoFocus value={nodeEditor.title} onChange={(event) => setNodeEditor({ ...nodeEditor, title: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter') void updateNode() }} /></label> : <p>确定删除“{nodeEditor.node.title}”吗？{nodeEditor.node.type === 'volume' ? '卷内全部章节也会删除。' : '此操作无法撤销。'}</p>}<div className="modal-actions"><button onClick={() => setNodeEditor(undefined)}>取消</button><button className={nodeEditor.action === 'delete' ? 'danger-button' : 'primary'} onClick={() => void updateNode()}>{nodeEditor.action === 'rename' ? '保存' : '确认删除'}</button></div></div></Modal>}
  </div>
}
