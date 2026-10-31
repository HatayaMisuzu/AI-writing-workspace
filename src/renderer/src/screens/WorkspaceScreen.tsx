import { syncSelectedTitle } from '../services/selected-node'
import { displayProjectTitle } from '../services/project-title'
import { BookmarkPlus, FilePlus2, Lightbulb, Search, SidebarClose, SlidersHorizontal } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FocusLockInput, FocusLockStatus, ChapterWordRange, DocumentContent, DocumentNode, DocumentTaskTarget, Project, SearchResult, TextPatch } from '../../../shared/domain'
import { ProjectSidebar, type ProjectSection } from '../components/ProjectSidebar'
import { EditorSurface, type EditorController, type EditorSelection } from '../components/EditorSurface'
import { AssistantPanel } from '../components/AssistantPanel'
import { BookFindView, type BookBatchInfo, type BookFindTarget } from './BookFindView'
import { ChapterOutlineAside, CharactersView, HistoryView, IdeasView, MemoryView, NotesView, OutlineView, PatchDrawer } from './ProjectViews'
import { DailyStatsView } from './DailyStatsView'
import { PromptTemplatesView } from './PromptTemplatesView'
import { ProofingView } from './ProofingView'
import { StockpileView } from './StockpileView'
import { ForeshadowView } from './ForeshadowView'
import { RelatedTimelineEvents, TimelineView } from './TimelineView'
import { Modal } from '../components/Modal'
import { BlackroomBar, BlackroomEmergencyDialog, BlackroomEntryDialog } from '../components/Blackroom'
import { parseSearchSnippet } from '../services/search-snippet'
import { createIdleTask, patchTreeAfterSave } from '../services/tree-patch'
import { chapterWordRangeHint } from '../services/chapter-word-range-view'

const renderSnippet = (snippet: string): React.ReactNode[] => {
  return parseSearchSnippet(snippet).map((segment, index) => segment.highlighted ? <mark key={index}>{segment.text}</mark> : segment.text)
}

const NARROW_QUERY = '(max-width: 1080px)'
const TREE_IDLE_REFRESH_TIMEOUT_MS = 1000

export function WorkspaceScreen({ project, onProjectChanged, onSettings, onRegisterBeforeLeave, onFocusLockChange }: {
  project: Project; onProjectChanged(): void; onSettings(): void; onRegisterBeforeLeave(handler?: () => Promise<void>): void; onFocusLockChange?(locked: boolean): void
}): React.JSX.Element {
  const [tree, setTree] = useState<DocumentNode[]>([])
  const [selected, setSelected] = useState<DocumentNode>()
  const [content, setContent] = useState<DocumentContent>()
  const [section, setSection] = useState<ProjectSection>('manuscript')
  const [wordRange, setWordRange] = useState<ChapterWordRange>()
  // F10：区间在日更面板设置；切回任意分区时重读，静默显示于状态栏
  useEffect(() => {
    let active = true
    window.workspace.writing.getChapterWordRange(project.id).then((next) => { if (active) setWordRange(next) }).catch(() => { if (active) setWordRange(undefined) })
    return () => { active = false }
  }, [project.id, section])
  const [timelineFocus, setTimelineFocus] = useState<string>()
  const [characterFocus, setCharacterFocus] = useState<string>()
  const [assistantCollapsed, setAssistantCollapsed] = useState(false)
  // 窄屏（≤1080px，与 styles.css 断点一致）：同行者默认收起，点按钮以抽屉打开
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches)
  const [drawerOpen, setDrawerOpen] = useState(false)
  useEffect(() => {
    const query = window.matchMedia(NARROW_QUERY)
    const onChange = (): void => { setNarrow(query.matches); if (!query.matches) setDrawerOpen(false) }
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  const toggleDrawer = useCallback(() => setDrawerOpen((open) => !open), [])
  const [focusMode, setFocusMode] = useState(false)
  // F15 小黑屋：锁状态以主进程为准（墙钟），界面每秒及窗口重新获得焦点时刷新
  const [lockStatus, setLockStatus] = useState<FocusLockStatus>()
  const [blackroomEntryOpen, setBlackroomEntryOpen] = useState(false)
  const [blackroomExitOpen, setBlackroomExitOpen] = useState(false)
  const locked = lockStatus?.locked === true
  const hideChrome = focusMode || locked
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
  const editorController = useRef<EditorController | undefined>(undefined)
  const auxiliaryFlush = useRef<(() => Promise<void>) | undefined>(undefined)
  const quickIdeaText = useRef('')
  const navigationSequence = useRef(0)

  const refreshTree = useCallback(async (): Promise<DocumentNode[]> => {
    const next = await window.workspace.documents.tree(project.id); setTree(next); return next
  }, [project.id])
  // 保存回执只给章节树打局部补丁；补不上（章不在树里）才在空闲时全量刷新，rIC 带 timeout 兜底
  const refreshTreeRef = useRef(refreshTree)
  refreshTreeRef.current = refreshTree
  const idleTreeRefresh = useMemo(() => createIdleTask(() => { void refreshTreeRef.current().catch(() => undefined) }, TREE_IDLE_REFRESH_TIMEOUT_MS), [])
  useEffect(() => () => idleTreeRefresh.cancel(), [idleTreeRefresh])
  const patchTreeOnSave = useCallback((saved: DocumentContent): void => {
    // schedule 是合并的（幂等），放在 updater 里不怕 StrictMode 双调
    setTree((current) => { const result = patchTreeAfterSave(current, saved); if (result.needsFullRefresh) idleTreeRefresh.schedule(); return result.tree })
  }, [idleTreeRefresh])
  useEffect(() => { quickIdeaText.current = ideaText }, [ideaText])
  const flushAll = useCallback(async (): Promise<void> => {
    await editorController.current?.flush()
    await auxiliaryFlush.current?.()
    const idea = quickIdeaText.current.trim()
    if (idea) {
      await window.workspace.ideas.create(project.id, idea)
      quickIdeaText.current = ''; setIdeaText('')
    }
  }, [project.id])
  const registerAuxiliaryFlush = useCallback((handler?: () => Promise<void>): void => { auxiliaryFlush.current = handler }, [])
  useEffect(() => { onRegisterBeforeLeave(flushAll); return () => onRegisterBeforeLeave(undefined) }, [flushAll, onRegisterBeforeLeave])

  const openDocument = useCallback(async (node: DocumentNode): Promise<void> => {
    if (node.type === 'volume' || node.id === selected?.id || bookBusy.current) return
    const request = ++navigationSequence.current
    try {
      const nextContent = await window.workspace.documents.get(project.id, node.id)
      if (request !== navigationSequence.current) return
      await flushAll()
      if (request !== navigationSequence.current) return
      setSelected(node); setContent(nextContent); setSection('manuscript'); setSelection(undefined); setNavigationError(undefined)
    } catch (error) { setNavigationError(`保存失败，仍停留在当前章节：${error instanceof Error ? error.message : String(error)}`) }
  }, [flushAll, project.id, selected?.id])

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
      if (event.ctrlKey && event.key.toLowerCase() === 'f' && event.shiftKey) { event.preventDefault(); if (!locked) setSearchOpen(true) }
      if (event.key === 'Escape' && focusMode && !locked) setFocusMode(false)
    }
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler)
  }, [focusMode, locked])

  const refreshLock = useCallback(async (): Promise<void> => {
    try { setLockStatus(await window.workspace.focus.status(project.id)) } catch { /* 读不到即保持当前界面，不阻止写作 */ }
  }, [project.id])
  useEffect(() => {
    let active = true
    void window.workspace.focus.restore(project.id).then((status) => { if (active) setLockStatus(status) }).catch(() => { if (active) setLockStatus(undefined) })
    return () => { active = false }
  }, [project.id])
  useEffect(() => { onFocusLockChange?.(locked) }, [locked, onFocusLockChange])
  // 锁定时窄屏抽屉一并关闭（抽屉与「打开同行者」按钮都随 AssistantPanel 不渲染）
  useEffect(() => { if (locked) setDrawerOpen(false) }, [locked])
  useEffect(() => () => onFocusLockChange?.(false), [onFocusLockChange])
  useEffect(() => {
    if (!locked) return
    const timer = window.setInterval(() => void refreshLock(), 1000)
    const wake = (): void => { void refreshLock() }
    window.addEventListener('focus', wake); document.addEventListener('visibilitychange', wake)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', wake); document.removeEventListener('visibilitychange', wake) }
  }, [locked, refreshLock])
  const startBlackroom = async (input: FocusLockInput): Promise<void> => {
    await flushAll()
    const status = await window.workspace.focus.start(project.id, input)
    setFocusMode(false); setSearchOpen(false); setPatchOpen(false); setSection('manuscript')
    setLockStatus(status); setBlackroomEntryOpen(false)
  }
  const finishBlackroom = async (): Promise<void> => {
    try { await flushAll(); setLockStatus(await window.workspace.focus.finish(project.id)); setNavigationError(undefined) }
    catch (error) { setNavigationError(error instanceof Error ? error.message : String(error)) }
  }
  const emergencyExitBlackroom = async (phrase: string): Promise<void> => {
    await flushAll()
    setLockStatus(await window.workspace.focus.emergencyExit(project.id, phrase)); setBlackroomExitOpen(false)
  }

  // P3 PR-2b：全书替换 / 整批恢复进行中禁止切区段、切章（打开章不可编辑，等批次结束）
  const bookBusy = useRef(false)
  const [bookBusyView, setBookBusyView] = useState(false)
  const [lastBookBatch, setLastBookBatch] = useState<BookBatchInfo>()
  const setBookBusy = useCallback((busy: boolean): void => { bookBusy.current = busy; setBookBusyView(busy) }, [])
  const reloadAfterBookWrite = async (documentIds: string[]): Promise<void> => {
    // 打开章被改写：从库里取新内容和新 revision，回到正文时编辑器按新内容重建（撤销栈为空，Ctrl+Z 不会退回替换前）
    if (selected && documentIds.includes(selected.id)) setContent(await window.workspace.documents.get(project.id, selected.id))
    await refreshTree(); onProjectChanged()
  }
  const changeSection = async (next: ProjectSection): Promise<void> => {
    if (next === section || bookBusy.current) return
    try { await flushAll(); setSection(next); setNavigationError(undefined) }
    catch (error) { setNavigationError(`保存失败，无法离开当前内容：${error instanceof Error ? error.message : String(error)}`) }
  }
  // 全书查找点击命中 → 打开该章并让编辑器打开章内查找定位；编辑器消费后清掉，避免之后切回正文时重复触发
  const [findRequest, setFindRequest] = useState<(BookFindTarget & { token: number }) | undefined>()
  const findToken = useRef(0)
  const openBookHit = async (target: BookFindTarget): Promise<void> => {
    if (bookBusy.current) return
    findToken.current += 1
    setFindRequest({ ...target, token: findToken.current })
    await openChapterById(target.documentId)
  }
  const openChapterById = async (chapterId: string): Promise<void> => {
    const node = tree.find((item) => item.id === chapterId)
    if (!node) { setNavigationError('关联章节已被删除。'); return }
    if (node.id === selected?.id) { try { await flushAll(); setSection('manuscript'); setNavigationError(undefined) } catch (error) { setNavigationError(String(error)) } return }
    await openDocument(node)
  }
  const openTimelineEvent = async (eventId: string): Promise<void> => {
    try { await flushAll(); setTimelineFocus(eventId); setSection('timeline'); setNavigationError(undefined) } catch (error) { setNavigationError(String(error)) }
  }
  const openCharacter = async (characterId: string): Promise<void> => {
    try { await flushAll(); setCharacterFocus(characterId); setSection('characters'); setNavigationError(undefined) } catch (error) { setNavigationError(String(error)) }
  }
  const requestCreateNode = async (type: 'volume' | 'chapter', parentId?: string): Promise<void> => {
    try { await flushAll() } catch (error) { setNavigationError(`保存失败，未创建新节点：${error instanceof Error ? error.message : String(error)}`); return }
    if (type === 'chapter' && !parentId) {
      setNavigationError('请先新建一卷，再在卷中添加章节。')
      return
    }
    setNodeCreator({ type, parentId, title: type === 'volume' ? '新卷' : '新章节' })
  }
  const updateNode = async (): Promise<void> => {
    if (!nodeEditor) return
    try {
      await flushAll()
      if (nodeEditor.action === 'rename') {
        if (!nodeEditor.title.trim()) throw new Error('名称不能为空。')
        await window.workspace.documents.rename(project.id, nodeEditor.node.id, nodeEditor.title.trim())
      } else {
        await window.workspace.documents.delete(project.id, nodeEditor.node.id)
        if (nodeEditor.node.id === selected?.id || (nodeEditor.node.type === 'volume' && selected?.parentId === nodeEditor.node.id)) {
          setSelected(undefined); setContent(undefined); setSelection(undefined)
        }
      }
      setNodeEditor(undefined); const nextTree = await refreshTree(); setSelected((current) => syncSelectedTitle(current, nextTree)); onProjectChanged()
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
  const rangeHint = content ? chapterWordRangeHint(content.wordCount, wordRange) : null
  const totalWords = useMemo(() => tree.reduce((sum, node) => sum + (node.type === 'chapter' ? node.wordCount : 0), 0), [tree])
  const registerController = useCallback((controller?: EditorController): void => { editorController.current = controller }, [])
  const freezeAITarget = useCallback(async (requestId: string, expectedDocumentId?: string, targetSelection?: EditorSelection): Promise<DocumentTaskTarget | undefined> => {
    if (!expectedDocumentId) { await flushAll(); return undefined }
    await flushAll()
    const controller = editorController.current
    if (!controller || controller.projectId !== project.id || controller.documentId !== expectedDocumentId) throw new Error('请求来源章节已经关闭，请重新发送。')
    return controller.freezeTarget(requestId, targetSelection)
  }, [flushAll, project.id])
  const createPatch = useCallback(async (target: DocumentTaskTarget, replacement: string): Promise<void> => {
    if (!target.selection) throw new Error('修改请求缺少原始选区。')
    await window.workspace.patches.propose({ projectId: target.projectId, documentId: target.documentId,
      documentRevision: target.sourceRevision, fromPm: target.selection.fromPm, toPm: target.selection.toPm,
      originalText: target.selection.text, replacement })
    setPatchOpen(true)
  }, [])
  const openTargetDocument = useCallback(async (documentId: string): Promise<void> => {
    const target = tree.find((item) => item.id === documentId)
    if (!target) throw new Error('来源章节已被删除。')
    await openDocument(target)
  }, [openDocument, tree])
  const registerForeshadow = useCallback(async (): Promise<void> => {
    if (!selected || !selection || !selection.text.trim()) return
    try {
      await flushAll()
      const name = selection.text.trim().slice(0, 24)
      await window.workspace.foreshadows.register({
        projectId: project.id,
        chapterId: selected.id,
        name,
        content: selection.text,
        fromPm: selection.fromPm,
        toPm: selection.toPm
      })
      setNavigationError(undefined)
      setSection('foreshadow')
    } catch (error) {
      setNavigationError(error instanceof Error ? error.message : String(error))
    }
  }, [flushAll, project.id, selected, selection])

  const acceptPatch = useCallback(async (patch: TextPatch): Promise<TextPatch> => {
    if (!editorController.current || patch.documentId !== selected?.id) throw new Error('请先打开提案所属章节。')
    const result = await editorController.current.applyPatch(patch)
    if (result.status === 'accepted') { await refreshTree(); onProjectChanged() }
    return result
  }, [onProjectChanged, refreshTree, selected?.id])
  const acceptAllPatches = useCallback(async (list: TextPatch[]): Promise<{ accepted: number; stale: number }> => {
    if (!editorController.current || list.some((patch) => patch.documentId !== selected?.id)) throw new Error('请先打开提案所属章节。')
    const result = await editorController.current.applyPatches(list)
    if (result.accepted) { await refreshTree(); onProjectChanged() }
    return result
  }, [onProjectChanged, refreshTree, selected?.id])

  return <div className={hideChrome ? `workspace-screen is-focus${locked ? ' is-blackroom' : ''}` : 'workspace-screen'}>
    {!hideChrome && <ProjectSidebar project={project} tree={tree} selectedId={selected?.id} section={section} onSection={(next) => { setTimelineFocus(undefined); setCharacterFocus(undefined); void changeSection(next) }} onSelect={(node) => void openDocument(node)} onNewVolume={() => void requestCreateNode('volume')} onNewChapter={(parent) => void requestCreateNode('chapter', parent)} onRename={(node) => setNodeEditor({ node, action: 'rename', title: node.title })} onDelete={(node) => setNodeEditor({ node, action: 'delete', title: node.title })} onReorder={async (documentId, parentId, orderIndex) => { try { await flushAll(); await window.workspace.documents.reorder(project.id, documentId, parentId, orderIndex); await refreshTree() } catch (error) { setNavigationError(String(error)) } }}  onSetStatus={async (node, status) => { try { await window.workspace.documents.setStatus(project.id, node.id, status); await refreshTree() } catch (error) { setNavigationError(String(error)) } }} />}
    <div className="workspace-main">
      {locked && lockStatus ? <div className="workspace-actions blackroom-actions"><BlackroomBar status={lockStatus} chapters={tree.filter((node) => node.type === 'chapter')} selectedId={selected?.id} onSelectChapter={(node) => void openDocument(node)} onFinish={() => void finishBlackroom()} onEmergency={() => setBlackroomExitOpen(true)} /><button disabled={bookBusyView} onClick={() => void changeSection(section === 'book-find' ? 'manuscript' : 'book-find')}><Search size={16} />{section === 'book-find' ? '回到正文' : '全书查找'}</button><button disabled={bookBusyView} data-testid="blackroom-book-check" onClick={() => void changeSection(section === 'proofing' ? 'manuscript' : 'proofing')}><SlidersHorizontal size={16} />{section === 'proofing' ? '回到正文' : '整本检查'}</button><button onClick={() => setIdeaOpen(true)}><Lightbulb size={16} />快速灵感 <kbd>Ctrl J</kbd></button></div>
      : <div className="workspace-actions"><button onClick={() => setSearchOpen(true)}><Search size={16} />全文检索</button><button onClick={() => setIdeaOpen(true)}><Lightbulb size={16} />快速灵感 <kbd>Ctrl J</kbd></button>{selected && <button onClick={() => setPatchOpen(true)}><SlidersHorizontal size={16} />修改提案</button>}{selected && selection && selection.text.trim() && <button type="button" onClick={() => void registerForeshadow()}><BookmarkPlus size={16} />登记为伏笔</button>}<span />{focusMode && <button onClick={() => setFocusMode(false)}><SidebarClose size={16} />退出专注</button>}</div>}
      {navigationError && <div className="navigation-error" role="alert">{navigationError}</div>}
      {section === 'manuscript' && selected && content ? <div className="manuscript-with-outline">
          <EditorSurface node={selected} content={content} focusMode={hideChrome} onFocusMode={setFocusMode} blackroomLocked={locked} onBlackroom={() => setBlackroomEntryOpen(true)} onSaved={(saved) => { setContent(saved); patchTreeOnSave(saved); onProjectChanged(); if (locked) void refreshLock() }} onSelection={setSelection} onRegisterController={registerController} onOpenPatches={() => setPatchOpen(true)} onOpenCharacter={(id) => void openCharacter(id)} findRequest={findRequest} onFindRequestDone={() => setFindRequest(undefined)} />
          {!hideChrome && <div className="manuscript-aside-stack"><ChapterOutlineAside projectId={project.id} chapter={selected} />{selected.type === 'chapter' && <RelatedTimelineEvents projectId={project.id} chapterId={selected.id} onOpenEvent={(id) => void openTimelineEvent(id)} />}</div>}
        </div>
        : section === 'outline' ? <OutlineView projectId={project.id} tree={tree} onTreeChanged={async () => { await refreshTree(); onProjectChanged() }} onOpenChapter={(node) => void openDocument(node)} onRegisterFlush={registerAuxiliaryFlush} />
        : section === 'ideas' ? <IdeasView projectId={project.id} onRegisterFlush={registerAuxiliaryFlush} />
        : section === 'history' ? <HistoryView projectId={project.id} document={selected} currentContent={content} onRestored={(restored) => { setContent(restored); void refreshTree() }} />
        : section === 'ai-data' ? <MemoryView projectId={project.id} />
        : section === 'story' ? <NotesView projectId={project.id} section="story" onRegisterFlush={registerAuxiliaryFlush} />
        : section === 'references' ? <NotesView projectId={project.id} section="reference" onRegisterFlush={registerAuxiliaryFlush} />
        : section === 'characters' ? <CharactersView projectId={project.id} onRegisterFlush={registerAuxiliaryFlush} focusCharacterId={characterFocus} onOpenTimelineEvent={(id) => void openTimelineEvent(id)} />
        : section === 'prompts' ? <PromptTemplatesView project={project} />
        : section === 'book-find' ? <BookFindView projectId={project.id} chapters={tree.filter((node) => node.type === 'chapter')} onOpenHit={(target) => void openBookHit(target)} onBeforeReplace={flushAll} onBusy={setBookBusy} onContentChanged={reloadAfterBookWrite} lastBatch={lastBookBatch} onLastBatch={setLastBookBatch} />
        : section === 'proofing' ? <ProofingView project={project} tree={tree} locked={locked} onOpenChapter={(id) => void openChapterById(id)} />
        : section === 'daily' ? <DailyStatsView project={project} />
        : section === 'stockpile' ? <StockpileView project={project} chapters={tree.filter((node) => node.type === 'chapter')} onProgressChanged={() => { onProjectChanged(); void refreshTree() }} />
        : section === 'timeline' ? <TimelineView project={project} chapters={tree.filter((node) => node.type === 'chapter')} focusEventId={timelineFocus} onOpenChapter={(id) => void openChapterById(id)} onOpenCharacter={(id) => void openCharacter(id)} />
        : section === 'foreshadow' ? <ForeshadowView project={project} chapters={tree.filter((node) => node.type === 'chapter')} />
        : <section className="project-view placeholder-view"><FilePlus2 size={34} /><h1>内容</h1><p>这是辅助层，不要求作者维护复杂结构。</p></section>}
      <footer className="workspace-status"><span className="saved-dot" />本地项目<span>本章 {content?.wordCount.toLocaleString() ?? 0} 字</span>{rangeHint && <span className={`word-range-hint ${rangeHint.state}`} data-testid="word-range-hint">{rangeHint.text}</span>}<span>全书 {totalWords.toLocaleString()} 字</span><span>项目内容严格隔离</span></footer>
    </div>
    {!hideChrome && <AssistantPanel project={project} documentId={selected?.id} documentText={content?.plainText} documentRevision={content?.revision} selection={selection} collapsed={narrow ? !drawerOpen : assistantCollapsed} onCollapse={narrow ? toggleDrawer : () => setAssistantCollapsed(!assistantCollapsed)} narrow={narrow} drawer={narrow && drawerOpen} onCreatePatch={createPatch} onBeforeAI={freezeAITarget} onEnsureSaved={flushAll} onOpenDocument={openTargetDocument} onOpenSettings={onSettings} />}
    {ideaOpen && <div className="quick-idea-popover"><header><strong>快速记录灵感</strong><kbd>Ctrl J</kbd></header><textarea autoFocus value={ideaText} onChange={(event) => setIdeaText(event.target.value)} placeholder="记下一闪而过的想法…" /><div><button onClick={() => { setIdeaText(''); setIdeaOpen(false) }}>取消</button><button className="primary" onClick={async () => { if (ideaText.trim()) await window.workspace.ideas.create(project.id, ideaText); setIdeaText(''); setIdeaOpen(false) }}>保存并返回正文</button></div></div>}
    {blackroomEntryOpen && !locked && <BlackroomEntryDialog onClose={() => setBlackroomEntryOpen(false)} onStart={startBlackroom} />}
    {blackroomExitOpen && locked && <BlackroomEmergencyDialog onClose={() => setBlackroomExitOpen(false)} onConfirm={emergencyExitBlackroom} />}
    {searchOpen && !locked && <Modal title={`在《${displayProjectTitle(project.title)}》中检索`} onClose={() => setSearchOpen(false)} width={680}><div className="search-dialog"><div className="dialog-search"><input autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void runSearch() }} placeholder="输入关键词；只检索当前作品" /><button className="primary" onClick={() => void runSearch()}>搜索</button></div><div className="search-results">{searchResults.map((result) => <button key={result.documentId} onClick={async () => { const node = tree.find((item) => item.id === result.documentId); if (node) await openDocument(node); setSearchOpen(false) }}><strong>{result.title}</strong><p>{renderSnippet(result.snippet)}</p></button>)}</div></div></Modal>}
    {patchOpen && !locked && selected && <PatchDrawer projectId={project.id} documentId={selected.id} onClose={() => setPatchOpen(false)} onAccept={acceptPatch} onAcceptAll={acceptAllPatches} />}
    {nodeCreator && <Modal title={nodeCreator.type === 'volume' ? '新建卷' : '新建章节'} onClose={() => setNodeCreator(undefined)}><form className="node-create-form" onSubmit={(event) => { event.preventDefault(); void createNode() }}><label><span>{nodeCreator.type === 'volume' ? '卷名' : '章节名'}</span><input autoFocus value={nodeCreator.title} onChange={(event) => setNodeCreator({ ...nodeCreator, title: event.target.value })} /></label><div className="modal-actions"><button type="button" onClick={() => setNodeCreator(undefined)}>取消</button><button className="primary" type="submit">创建</button></div></form></Modal>}
    {nodeEditor && <Modal title={nodeEditor.action === 'rename' ? `重命名${nodeEditor.node.type === 'volume' ? '卷' : '章节'}` : `删除${nodeEditor.node.type === 'volume' ? '卷' : '章节'}`} onClose={() => setNodeEditor(undefined)}><div className="node-create-form">{nodeEditor.action === 'rename' ? <label><span>名称</span><input autoFocus value={nodeEditor.title} onChange={(event) => setNodeEditor({ ...nodeEditor, title: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter') void updateNode() }} /></label> : <p>确定删除“{nodeEditor.node.title}”吗？{nodeEditor.node.type === 'volume' ? '卷内全部章节也会删除。' : '此操作无法撤销。'}</p>}<div className="modal-actions"><button onClick={() => setNodeEditor(undefined)}>取消</button><button className={nodeEditor.action === 'delete' ? 'danger-button' : 'primary'} onClick={() => void updateNode()}>{nodeEditor.action === 'rename' ? '保存' : '确认删除'}</button></div></div></Modal>}
  </div>
}
