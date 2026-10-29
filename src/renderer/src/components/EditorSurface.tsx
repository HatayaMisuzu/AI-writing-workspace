import { userErrorMessage } from '../../../shared/user-error'
import { CharacterCount } from '@tiptap/extension-character-count'
import { Placeholder } from '@tiptap/extension-placeholder'
import { EditorContent, Extension, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Check, Focus, UserRound, Lock, LocateFixed, Redo2, Save, ShieldCheck, Sparkles, Undo2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Character, CharacterHoverPrefs, DocumentContent, DocumentNode, DocumentTaskTarget, LocalLintIssue, ProofreadIssue, TextPatch } from '../../../shared/domain'
import { textIdentity } from '../../../shared/text-identity'
import { findTextRange, findTextRanges, plainTextRangeToPm } from '../services/prosemirror-range'
import { LIVE_WORD_COUNT_DELAY_MS, liveWordCountOf } from '../services/live-word-count'
import { averageBlockHeight, type BlockMetrics } from '../services/block-height-estimate'
import { SaveCoordinator, type SaveState } from '../services/save-coordinator'
import { NameMatcher, termsFromCharacters } from '../../../shared/name-matcher'
import { CHARACTERS_CHANGED_EVENT, HOVER_DEGRADE_NOTICE, characterHoverPlugin, hitAt, ignoreHoverAt, isHoverDegraded, setHoverMatcher, type DecoratedHit } from '../services/character-hover'
import { CharacterHoverCard } from './CharacterHoverCard'

export interface EditorSelection { fromPm: number; toPm: number; text: string }
export interface EditorController {
  readonly projectId: string
  readonly documentId: string
  flush(): Promise<void>
  hasPending(): boolean
  currentRevision(): number
  freezeTarget(requestId: string, selection?: EditorSelection): Promise<DocumentTaskTarget>
  insertCandidate(target: DocumentTaskTarget, text: string): Promise<void>
  createPatch(target: DocumentTaskTarget, replacement: string): Promise<TextPatch>
  applyPatch(patch: TextPatch): Promise<TextPatch>
}

const issueLabel = (kind: string): string => ({
  repeated_punctuation: '重复标点', ellipsis: '省略号', dash: '破折号', space: '空格', mixed_punctuation: '混合标点',
  quote: '引号', punctuation: '标点', typo: '错别字', grammar: '语法', reference: '指代', repetition: '重复', format: '格式'
}[kind] ?? '文字提示')

export function EditorSurface({ node, content, focusMode, onFocusMode, onSaved, onSelection, onRegisterController, onOpenPatches, blackroomLocked = false, onBlackroom, onOpenCharacter }: {
  blackroomLocked?: boolean; onBlackroom?(): void; onOpenCharacter?(characterId: string): void
  node: DocumentNode; content: DocumentContent; focusMode: boolean; onFocusMode(value: boolean): void
  onSaved(content: DocumentContent): void; onSelection(selection?: EditorSelection): void
  onRegisterController(controller?: EditorController): void
  onOpenPatches(): void
}): React.JSX.Element {
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [saveError, setSaveError] = useState<string>()
  const [localIssues, setLocalIssues] = useState<LocalLintIssue[]>([])
  const [aiIssues, setAiIssues] = useState<ProofreadIssue[]>([])
  const [proofreadOpen, setProofreadOpen] = useState(false)
  const [proofreadBusy, setProofreadBusy] = useState(false)
  const [aiProofreadRan, setAiProofreadRan] = useState(false)
  const [proofreadError, setProofreadError] = useState<string>()
  const [ignoredIssues, setIgnoredIssues] = useState<Set<string>>(new Set())
  const [liveWordCount, setLiveWordCount] = useState(content.wordCount)
  const writingPageRef = useRef<HTMLElement>(null)
  const updateBlockEstimateRef = useRef<() => void>(() => undefined)
  const wordCountTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const scheduleWordCount = useCallback((): void => {
    if (wordCountTimer.current) clearTimeout(wordCountTimer.current)
    wordCountTimer.current = setTimeout(() => {
      wordCountTimer.current = undefined
      setLiveWordCount(liveWordCountOf(latestPlainText.current))
      updateBlockEstimateRef.current()
    }, LIVE_WORD_COUNT_DELAY_MS)
  }, [])
  useEffect(() => () => { if (wordCountTimer.current) clearTimeout(wordCountTimer.current) }, [])
  const onSavedRef = useRef(onSaved)
  const pendingStyleSample = useRef<{ origin: 'ai'; text: string } | undefined>(undefined)
  const renderedDocumentId = useRef(node.id)
  const latestPlainText = useRef(content.plainText)
  const latestRevision = useRef(content.revision)
  const initialRevision = useRef({ documentId: node.id, revision: content.revision })
  if (initialRevision.current.documentId !== node.id) initialRevision.current = { documentId: node.id, revision: content.revision }
  useEffect(() => { onSavedRef.current = onSaved }, [onSaved])

  const runLocalLint = useCallback(async (text: string): Promise<void> => {
    const sourceHash = textIdentity(text)
    const next = await window.workspace.linter.run(text)
    if (textIdentity(latestPlainText.current) !== sourceHash) return
    setLocalIssues(next.map((issue) => ({ ...issue, documentId: node.id, sourceRevision: latestRevision.current })))
    setIgnoredIssues(new Set())
  }, [node.id])

  const coordinator = useMemo(() => new SaveCoordinator(initialRevision.current.revision, async (snapshot) =>
    window.workspace.documents.save({ projectId: node.projectId, documentId: node.id, editorJson: snapshot.editorJson,
      plainText: snapshot.plainText, expectedRevision: snapshot.baseRevision, styleSample: snapshot.styleSample }), (saved) => {
    onSavedRef.current(saved)
    latestRevision.current = saved.revision
    setLiveWordCount(saved.wordCount)
    void runLocalLint(saved.plainText)
  }, (state, error) => {
    setSaveState(state)
    setSaveError(state === 'error' ? (error instanceof Error ? error.message : '保存失败，请重试。') : undefined)
  }), [node.id, node.projectId, runLocalLint])

  // F14 人物悬停：人物卡 + 偏好来自本地 IPC；只加 Decoration，不改 editor_json
  const [characters, setCharacters] = useState<Character[]>([])
  const [hoverPrefs, setHoverPrefs] = useState<CharacterHoverPrefs>()
  const [hoverCard, setHoverCard] = useState<{ hit: Pick<DecoratedHit, 'term' | 'characterIds' | 'pmFrom' | 'pmTo'>; position: { left: number; top: number } }>()
  const [hoverDegraded, setHoverDegraded] = useState(false)
  const shortcutRef = useRef<(() => void) | undefined>(undefined)
  const hoverExtension = useMemo(() => Extension.create({ name: 'characterHover',
    addProseMirrorPlugins: () => [characterHoverPlugin({ onShortcut: () => shortcutRef.current?.() })] }), [])
  useEffect(() => {
    let alive = true
    const load = (): void => { void Promise.all([window.workspace.characters.list(node.projectId), window.workspace.characters.hoverPrefs(node.projectId)])
      .then(([list, prefs]) => { if (alive) { setCharacters(list); setHoverPrefs(prefs) } }).catch(() => undefined) }
    load()
    const onChanged = (event: Event): void => { if ((event as CustomEvent<{ projectId: string }>).detail?.projectId === node.projectId) load() }
    window.addEventListener(CHARACTERS_CHANGED_EVENT, onChanged)
    return () => { alive = false; window.removeEventListener(CHARACTERS_CHANGED_EVENT, onChanged) }
  }, [node.projectId])
  const hoverMatcher = useMemo(() => hoverPrefs?.enabled ? new NameMatcher(termsFromCharacters(characters),
    { ignoredTerms: hoverPrefs.ignoredTerms, enabledSingleTerms: hoverPrefs.enabledSingleTerms }) : null, [characters, hoverPrefs])

  const editor = useEditor({
    extensions: [StarterKit, CharacterCount, Placeholder.configure({ placeholder: '从这里开始写……' }), hoverExtension],
    content: content.editorJson,
    editorProps: { attributes: { class: 'manuscript-editor', spellcheck: 'false' } },
    onUpdate: ({ editor: activeEditor }) => {
      const plainText = activeEditor.getText({ blockSeparator: '\n\n' })
      latestPlainText.current = plainText
      // 按键路径只做必要的事：没有提示时不触发重渲染；字数是全文正则（20 万字约 7–17ms），推迟到停顿后再算
      setLocalIssues((previous) => previous.length ? [] : previous)
      setIgnoredIssues((previous) => previous.size ? new Set() : previous)
      const styleSample = pendingStyleSample.current
      pendingStyleSample.current = undefined
      scheduleWordCount()
      coordinator.markDirty({ editorJson: activeEditor.getJSON() as Record<string, unknown>, plainText, styleSample })
      coordinator.schedule()
    },
    onSelectionUpdate: ({ editor: activeEditor }) => {
      const { from, to } = activeEditor.state.selection
      onSelection(from === to ? undefined : { fromPm: from, toPm: to, text: activeEditor.state.doc.textBetween(from, to, '\n') })
    }
  }, [node.id])

  // 屏外段落估算高度：按段落字数、当前宽度、行高算平均段高，写到编辑器外层的 CSS 变量（不碰 ProseMirror 的 DOM）
  useEffect(() => {
    if (!editor) return
    const viewDom = (): HTMLElement | undefined => { try { return editor.isDestroyed ? undefined : editor.view.dom as HTMLElement } catch { return undefined } }
    const measure = (): void => {
      const page = writingPageRef.current
      const dom = viewDom()
      if (!page || !dom) return
      const paragraph = dom.querySelector('p') ?? dom
      const style = getComputedStyle(paragraph)
      const fontSize = parseFloat(style.fontSize) || 18
      const spacing = parseFloat(style.letterSpacing) || 0
      const context = document.createElement('canvas').getContext('2d')
      if (context) context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
      const cjk = (context?.measureText('永').width || fontSize) + spacing
      const latin = (context ? context.measureText('abcdefghijklmnopqrstuvwxyz0123456789').width / 36 : fontSize * 0.55) + spacing
      const metrics: BlockMetrics = {
        contentWidth: dom.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0),
        cjkWidth: cjk, latinWidth: latin,
        lineHeight: parseFloat(style.lineHeight) || fontSize * 1.92,
        indent: parseFloat(style.textIndent) || 0
      }
      const texts: string[] = []
      editor.state.doc.forEach((child) => { texts.push(child.textContent) })
      const next = Math.round(averageBlockHeight(texts, metrics) * 10) / 10
      const current = parseFloat(page.style.getPropertyValue('--block-estimate')) || 0
      if (Math.abs(next - current) >= 0.1) page.style.setProperty('--block-estimate', `${next}px`)
    }
    updateBlockEstimateRef.current = measure
    let lastWidth = -1
    const observer = new ResizeObserver(() => {
      const width = viewDom()?.clientWidth ?? -1
      if (width !== lastWidth) { lastWidth = width; measure() }
    })
    const attach = (): void => { const dom = viewDom(); if (dom) { observer.observe(dom); measure() } }
    if (viewDom()) attach(); else editor.on('create', attach)
    return () => { editor.off('create', attach); observer.disconnect(); updateBlockEstimateRef.current = () => undefined }
  }, [editor, content.documentId, content.revision])

  useEffect(() => {
    coordinator.resetRevision(content.revision)
    latestRevision.current = content.revision
    latestPlainText.current = content.plainText
    setLiveWordCount(content.wordCount)
    const sameDocument = renderedDocumentId.current === content.documentId
    renderedDocumentId.current = content.documentId
    if (!sameDocument) { setAiIssues([]); setAiProofreadRan(false); setProofreadError(undefined) }
    if (sameDocument && editor && !editor.isDestroyed && !coordinator.hasPending() && editor.getText({ blockSeparator: '\n\n' }) !== content.plainText) {
      editor.commands.setContent(content.editorJson, { emitUpdate: false })
      onSelection(undefined)
    }
    void runLocalLint(content.plainText)
  }, [content.documentId, content.editorJson, content.revision, content.plainText, content.wordCount, coordinator, editor, onSelection, runLocalLint])

  useEffect(() => {
    if (!editor) return
    const controller: EditorController = {
      projectId: node.projectId,
      documentId: node.id,
      flush: () => coordinator.flush(),
      hasPending: () => coordinator.hasPending(),
      currentRevision: () => coordinator.currentRevision(),
      freezeTarget: async (requestId, selection) => {
        await coordinator.flush()
        let frozenSelection: DocumentTaskTarget['selection']
        if (selection) {
          const currentText = editor.state.doc.textBetween(selection.fromPm, selection.toPm, '\n')
          if (currentText !== selection.text) throw new Error('选区已经变化，请重新选择后发送。')
          frozenSelection = { ...selection, originalHash: textIdentity(currentText) }
        } else {
          // S8：无选区时冻结光标为插入点（空 range），供执笔候选走插入型补丁。
          const from = editor.state.selection.from
          frozenSelection = { fromPm: from, toPm: from, text: '', originalHash: textIdentity('') }
        }
        return { requestId, projectId: node.projectId, documentId: node.id,
          sourceRevision: coordinator.currentRevision(), selection: frozenSelection }
      },
      insertCandidate: async (target, text) => {
        if (!text || target.projectId !== node.projectId || target.documentId !== node.id) throw new Error('请先打开候选所属章节。')
        await coordinator.flush()
        if (coordinator.currentRevision() !== target.sourceRevision) throw new Error('候选生成后正文已变化，请重新生成。')
        await window.workspace.snapshots.create(node.projectId, node.id, 'ai_edit')
        pendingStyleSample.current = { origin: 'ai', text }
        if (!editor.chain().focus().insertContent(text).run()) throw new Error('无法把候选文本插入来源章节。')
        await coordinator.flush()
      },
      createPatch: async (target, replacement) => {
        if (target.projectId !== node.projectId || target.documentId !== node.id || !target.selection) throw new Error('修改目标不属于当前章节。')
        await coordinator.flush()
        if (coordinator.currentRevision() !== target.sourceRevision) throw new Error('正文已在请求后变化，提案已过期。')
        const selection = target.selection
        const currentText = editor.state.doc.textBetween(selection.fromPm, selection.toPm, '\n')
        if (currentText !== selection.text || textIdentity(currentText) !== selection.originalHash) throw new Error('选区已经变化，请重新选择后生成提案。')
        return window.workspace.patches.propose({ projectId: node.projectId, documentId: node.id,
          documentRevision: target.sourceRevision, fromPm: selection.fromPm, toPm: selection.toPm,
          originalText: currentText, replacement })
      },
      applyPatch: async (patch) => {
        if (patch.documentId !== node.id) throw new Error('提案不属于当前章节。')
        editor.setEditable(false, false)
        try {
          await coordinator.flush()
          const currentText = editor.state.doc.textBetween(patch.fromPm, patch.toPm, '\n')
          const prepared = await window.workspace.patches.prepare(node.projectId, patch.id, coordinator.currentRevision(), currentText)
          if (prepared.status === 'stale') return prepared
          pendingStyleSample.current = { origin: 'ai', text: patch.replacement }
          const applied = editor.chain().insertContentAt({ from: patch.fromPm, to: patch.toPm }, patch.replacement).run()
          if (!applied) throw new Error('无法在当前富文本文档中应用提案。')
          await coordinator.flush()
          return window.workspace.patches.complete(node.projectId, patch.id, coordinator.currentRevision())
        } finally { editor.setEditable(true, false) }
      }
    }
    onRegisterController(controller)
    return () => { onRegisterController(undefined); coordinator.dispose() }
  }, [coordinator, editor, node.id, node.projectId, onRegisterController])

  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    setHoverMatcher(editor.view, hoverMatcher)
    setHoverCard(undefined)
    setHoverDegraded(isHoverDegraded(editor.state))
    const onTransaction = (): void => setHoverDegraded(isHoverDegraded(editor.state))
    editor.on('transaction', onTransaction)
    return () => { editor.off('transaction', onTransaction) }
  }, [editor, hoverMatcher])

  useEffect(() => {
    if (!editor) return
    const dom = editor.view.dom as HTMLElement
    let openTimer: ReturnType<typeof setTimeout> | undefined
    const cardAt = (target: HTMLElement): void => {
      const hit = hitAt(editor.state, editor.view.posAtDOM(target, 0))
      if (!hit) return
      const rect = target.getBoundingClientRect()
      setHoverCard({ hit, position: { left: rect.left, top: rect.bottom + 6 } })
    }
    const onOver = (event: MouseEvent): void => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('.character-hit')
      if (!target) return
      if (openTimer) clearTimeout(openTimer)
      openTimer = setTimeout(() => cardAt(target), 300)
    }
    const onOut = (event: MouseEvent): void => {
      const target = (event.target as HTMLElement).closest('.character-hit')
      if (!target || target.contains(event.relatedTarget as Node | null)) return
      if (openTimer) { clearTimeout(openTimer); openTimer = undefined }
      if (!(event.relatedTarget as HTMLElement | null)?.closest?.('.character-hover-card')) setHoverCard(undefined)
    }
    dom.addEventListener('mouseover', onOver)
    dom.addEventListener('mouseout', onOut)
    shortcutRef.current = () => {
      const hit = hitAt(editor.state, editor.state.selection.from)
      if (!hit) return
      const coords = editor.view.coordsAtPos(hit.pmFrom)
      setHoverCard({ hit, position: { left: coords.left, top: coords.bottom + 6 } })
    }
    return () => { if (openTimer) clearTimeout(openTimer); dom.removeEventListener('mouseover', onOver); dom.removeEventListener('mouseout', onOut); shortcutRef.current = undefined }
  }, [editor])

  useEffect(() => {
    if (!hoverCard) return
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setHoverCard(undefined) }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [hoverCard])

  const saveHoverPrefs = async (next: CharacterHoverPrefs): Promise<void> => { setHoverPrefs(await window.workspace.characters.setHoverPrefs(node.projectId, next)) }

  const applyLocalIssue = async (issue: LocalLintIssue): Promise<void> => {
    if (!editor || !issue.replacement) return
    if (issue.documentId !== node.id) throw new Error('校对结果不属于当前章节。')
    const range = plainTextRangeToPm(editor.state.doc, issue.from, issue.to)
    if (!range) throw new Error('原文位置已经变化，请重新校对。')
    const plainText = editor.getText({ blockSeparator: '\n\n' })
    const current = plainText.slice(issue.from, issue.to)
    if (textIdentity(plainText) !== issue.sourceTextHash || current !== issue.originalText ||
      editor.state.doc.textBetween(range.from, range.to, '\n\n') !== issue.originalText) {
      throw new Error('正文已变化，这条校对结果已失效，请重新检查。')
    }
    if (!editor.chain().focus().insertContentAt(range, issue.replacement).run()) throw new Error('无法应用校对建议。')
    await coordinator.flush()
  }

  const jumpToLocalIssue = (issue: LocalLintIssue): void => {
    if (!editor) return
    const range = plainTextRangeToPm(editor.state.doc, issue.from, issue.to)
    if (range) editor.chain().focus().setTextSelection(range).scrollIntoView().run()
  }

  const runAiProofread = async (): Promise<void> => {
    setProofreadBusy(true); setProofreadError(undefined)
    try {
      await coordinator.flush()
      setAiIssues(await window.workspace.proofreading.run(node.projectId, node.id))
      setAiProofreadRan(true)
    } catch (error) { setProofreadError(userErrorMessage(error)) }
    finally { setProofreadBusy(false) }
  }

  const createProofreadPatch = async (issue: ProofreadIssue): Promise<void> => {
    if (!editor || !issue.suggestion) return
    await coordinator.flush()
    if (issue.documentRevision !== coordinator.currentRevision()) throw new Error('正文已在校对后变化，请重新运行 AI 校对。')
    const matches = findTextRanges(editor.state.doc, issue.originalText)
    if (matches.length > 1 && !issue.occurrence) throw new Error('相同原文出现多次，无法安全定位，请重新运行 AI 校对。')
    const range = findTextRange(editor.state.doc, issue.originalText, issue.occurrence ?? 1)
    if (!range) throw new Error('原文已经变化，请重新运行 AI 校对。')
    await window.workspace.patches.propose({ projectId: node.projectId, documentId: node.id,
      documentRevision: coordinator.currentRevision(), fromPm: range.from, toPm: range.to,
      originalText: issue.originalText, replacement: issue.suggestion })
    setProofreadOpen(false)
    onOpenPatches()
  }

  const visibleLocalIssues = localIssues.filter((issue) => !ignoredIssues.has(issue.id))
  return <section className={focusMode ? 'editor-pane focus-mode' : 'editor-pane'}>
    <div className="editor-toolbar">
      <button className="icon-button" title="撤销" aria-label="撤销" onClick={() => editor?.chain().focus().undo().run()}><Undo2 size={17} /></button>
      <button className="icon-button" title="重做" aria-label="重做" onClick={() => editor?.chain().focus().redo().run()}><Redo2 size={17} /></button><span className="toolbar-separator" />
      <button className={editor?.isActive('bold') ? 'toolbar-button active' : 'toolbar-button'} onClick={() => editor?.chain().focus().toggleBold().run()}>粗体</button>
      {!blackroomLocked && <button className="toolbar-button" onClick={() => setProofreadOpen(true)}><ShieldCheck size={16} />校对{visibleLocalIssues.length > 0 ? ` ${visibleLocalIssues.length}` : ''}</button>}
      {!blackroomLocked && <button className="toolbar-button" onClick={() => onFocusMode(!focusMode)}><Focus size={16} />专注</button>}
      {!blackroomLocked && onBlackroom && <button className="toolbar-button" onClick={onBlackroom}><Lock size={16} />小黑屋</button>}
      <button className={hoverPrefs?.enabled ? 'toolbar-button active' : 'toolbar-button'} aria-pressed={Boolean(hoverPrefs?.enabled)} title="悬停人名显示只读人物卡" disabled={!hoverPrefs}
        onClick={() => { if (hoverPrefs) void saveHoverPrefs({ ...hoverPrefs, enabled: !hoverPrefs.enabled }) }}><UserRound size={16} />人物悬停</button>
      <span className="toolbar-spacer" /><span className={`save-indicator ${saveState}`} title={saveError}><Save size={14} />{saveState === 'saved' ? '已保存' : saveState === 'dirty' ? '等待保存' : saveState === 'saving' ? '保存中' : '保存失败，内容仍保留'}</span>
    </div>
    {saveError && <div className="save-error" role="alert">{saveError}</div>}
    <div className="writing-scroll"><article className="writing-page" ref={writingPageRef}><h1>{node.title}</h1><EditorContent editor={editor} /></article></div>
    <div className="editor-status"><span>{liveWordCount.toLocaleString()} 字</span>{visibleLocalIssues.length > 0 && <button className="proofread-count" onClick={() => setProofreadOpen(true)}>{visibleLocalIssues.length} 条校对提示</button>}{hoverDegraded && hoverPrefs?.enabled && <span className="hover-degraded" data-testid="hover-degraded">{HOVER_DEGRADE_NOTICE}</span>}</div>
    {hoverCard && <CharacterHoverCard term={hoverCard.hit.term} position={hoverCard.position} showOpenLink={!blackroomLocked && Boolean(onOpenCharacter)}
      characters={hoverCard.hit.characterIds.map((id) => characters.find((item) => item.id === id)).filter((item): item is Character => Boolean(item))}
      onOpen={(id) => { setHoverCard(undefined); onOpenCharacter?.(id) }}
      onIgnoreTerm={() => { const { hit } = hoverCard; setHoverCard(undefined); if (hoverPrefs) void saveHoverPrefs({ ...hoverPrefs, ignoredTerms: [...hoverPrefs.ignoredTerms, ...hit.characterIds.map((characterId) => ({ characterId, term: hit.term }))] }) }}
      onIgnoreHere={() => { const { hit } = hoverCard; setHoverCard(undefined); if (editor) ignoreHoverAt(editor.view, { from: hit.pmFrom, to: hit.pmTo }) }}
      onMouseEnter={() => undefined} onMouseLeave={() => setHoverCard(undefined)} />}
    {proofreadOpen && !blackroomLocked && <aside className="proofread-drawer" aria-label="校对结果">
      <header><div><h2>校对</h2><p>本地规则可直接修正；AI 建议会先进入修改提案。</p></div><button className="icon-button" aria-label="关闭校对" onClick={() => setProofreadOpen(false)}><X size={18} /></button></header>
      <div className="proofread-actions"><button onClick={() => void runLocalLint(editor?.getText({ blockSeparator: '\n\n' }) ?? '')}>重新检查本地规则</button><button className="primary" disabled={proofreadBusy} onClick={() => void runAiProofread()}><Sparkles size={15} />{proofreadBusy ? 'AI 校对中…' : '运行 AI 校对'}</button></div>
      {proofreadError && <div className="inline-error" role="alert">{proofreadError}</div>}
      <section><h3>本地规则 <span>{visibleLocalIssues.length}</span></h3>{visibleLocalIssues.length === 0 ? <p className="empty-copy">暂未发现明确的标点或空格问题。</p> : visibleLocalIssues.map((issue) => <article key={issue.id} className="proofread-issue"><span>{issueLabel(issue.kind)}</span><p>{issue.message}</p><small>原文：{(editor?.getText({ blockSeparator: '\n\n' }) ?? '').slice(issue.from, issue.to)}</small>{issue.replacement && <ins>建议：{issue.replacement}</ins>}<div><button onClick={() => jumpToLocalIssue(issue)}><LocateFixed size={14} />定位</button><button onClick={() => setIgnoredIssues((current) => new Set(current).add(issue.id))}>忽略</button>{issue.replacement && <button className="primary" onClick={() => void applyLocalIssue(issue).catch((error) => setProofreadError(error instanceof Error ? error.message : String(error)))}><Check size={14} />应用</button>}</div></article>)}</section>
      <section><h3>AI 校对 <span>{aiIssues.length}</span></h3>{aiIssues.length === 0 ? <p className="empty-copy">{aiProofreadRan ? 'AI 未发现需要处理的明确问题。' : '运行后，建议会先进入修改提案，不会直接改写正文。'}</p> : aiIssues.map((issue) => <article key={issue.id} className="proofread-issue"><span>{issueLabel(issue.category)}</span><p>{issue.reason}</p><small>原文：{issue.originalText}</small>{issue.suggestion && <ins>建议：{issue.suggestion}</ins>}<div><button className="primary" disabled={!issue.suggestion} onClick={() => void createProofreadPatch(issue).catch((error) => setProofreadError(error instanceof Error ? error.message : String(error)))}>加入修改提案</button></div></article>)}</section>
    </aside>}
  </section>
}
