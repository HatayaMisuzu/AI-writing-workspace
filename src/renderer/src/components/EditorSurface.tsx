import { CharacterCount } from '@tiptap/extension-character-count'
import { Placeholder } from '@tiptap/extension-placeholder'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Check, Focus, LocateFixed, Redo2, Save, ShieldCheck, Sparkles, Undo2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DocumentContent, DocumentNode, LocalLintIssue, ProofreadIssue, TextPatch } from '../../../shared/domain'
import { findTextRange, findTextRanges, plainTextRangeToPm } from '../services/prosemirror-range'
import { SaveCoordinator, type SaveState } from '../services/save-coordinator'

export interface EditorSelection { fromPm: number; toPm: number; text: string }
export interface EditorController {
  flush(): Promise<void>
  hasPending(): boolean
  currentRevision(): number
  createPatch(selection: EditorSelection, replacement: string): Promise<TextPatch>
  applyPatch(patch: TextPatch): Promise<TextPatch>
}

const issueLabel = (kind: string): string => ({
  repeated_punctuation: '重复标点', ellipsis: '省略号', dash: '破折号', space: '空格', mixed_punctuation: '混合标点',
  quote: '引号', punctuation: '标点', typo: '错别字', grammar: '语法', reference: '指代', repetition: '重复', format: '格式'
}[kind] ?? '文字提示')

export function EditorSurface({ node, content, focusMode, onFocusMode, onSaved, onSelection, onRegisterInsert, onRegisterController, onOpenPatches }: {
  node: DocumentNode; content: DocumentContent; focusMode: boolean; onFocusMode(value: boolean): void
  onSaved(content: DocumentContent): void; onSelection(selection?: EditorSelection): void
  onRegisterInsert(handler: (text: string) => Promise<void>): void
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
  const onSavedRef = useRef(onSaved)
  const pendingStyleSample = useRef<{ origin: 'ai'; text: string } | undefined>(undefined)
  const renderedDocumentId = useRef(node.id)
  const initialRevision = useRef({ documentId: node.id, revision: content.revision })
  if (initialRevision.current.documentId !== node.id) initialRevision.current = { documentId: node.id, revision: content.revision }
  useEffect(() => { onSavedRef.current = onSaved }, [onSaved])

  const runLocalLint = useCallback(async (text: string): Promise<void> => {
    setLocalIssues(await window.workspace.linter.run(text))
    setIgnoredIssues(new Set())
  }, [])

  const coordinator = useMemo(() => new SaveCoordinator(initialRevision.current.revision, async (snapshot) =>
    window.workspace.documents.save({ projectId: node.projectId, documentId: node.id, editorJson: snapshot.editorJson,
      plainText: snapshot.plainText, expectedRevision: snapshot.baseRevision, styleSample: snapshot.styleSample }), (saved) => {
    onSavedRef.current(saved)
    setLiveWordCount(saved.wordCount)
    void runLocalLint(saved.plainText)
  }, (state, error) => {
    setSaveState(state)
    setSaveError(state === 'error' ? (error instanceof Error ? error.message : '保存失败，请重试。') : undefined)
  }), [node.id, node.projectId, runLocalLint])

  const editor = useEditor({
    extensions: [StarterKit, CharacterCount, Placeholder.configure({ placeholder: '从这里开始写……' })],
    content: content.editorJson,
    editorProps: { attributes: { class: 'manuscript-editor', spellcheck: 'false' } },
    onUpdate: ({ editor: activeEditor }) => {
      const plainText = activeEditor.getText({ blockSeparator: '\n\n' })
      const styleSample = pendingStyleSample.current
      pendingStyleSample.current = undefined
      setLiveWordCount((plainText.match(/[\p{Script=Han}]/gu)?.length ?? 0) + (plainText.match(/[A-Za-z0-9]+/g)?.length ?? 0))
      coordinator.markDirty({ editorJson: activeEditor.getJSON() as Record<string, unknown>, plainText, styleSample })
      coordinator.schedule()
    },
    onSelectionUpdate: ({ editor: activeEditor }) => {
      const { from, to } = activeEditor.state.selection
      onSelection(from === to ? undefined : { fromPm: from, toPm: to, text: activeEditor.state.doc.textBetween(from, to, '\n') })
    }
  }, [node.id])

  useEffect(() => {
    coordinator.resetRevision(content.revision)
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

  useEffect(() => onRegisterInsert(async (text) => {
    if (!editor || !text) return
    pendingStyleSample.current = { origin: 'ai', text }
    if (!editor.chain().focus().insertContent(text).run()) throw new Error('无法把候选文本插入当前章节。')
    await coordinator.flush()
  }), [coordinator, editor, onRegisterInsert])

  useEffect(() => {
    if (!editor) return
    const controller: EditorController = {
      flush: () => coordinator.flush(),
      hasPending: () => coordinator.hasPending(),
      currentRevision: () => coordinator.currentRevision(),
      createPatch: async (selection, replacement) => {
        await coordinator.flush()
        const currentText = editor.state.doc.textBetween(selection.fromPm, selection.toPm, '\n')
        if (currentText !== selection.text) throw new Error('选区已经变化，请重新选择后生成提案。')
        return window.workspace.patches.propose({ projectId: node.projectId, documentId: node.id,
          documentRevision: coordinator.currentRevision(), fromPm: selection.fromPm, toPm: selection.toPm,
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

  const applyLocalIssue = async (issue: LocalLintIssue): Promise<void> => {
    if (!editor || !issue.replacement) return
    const range = plainTextRangeToPm(editor.state.doc, issue.from, issue.to)
    if (!range) throw new Error('原文位置已经变化，请重新校对。')
    const plainText = editor.getText({ blockSeparator: '\n\n' })
    const current = plainText.slice(issue.from, issue.to)
    if (!current) throw new Error('原文位置已经变化，请重新校对。')
    editor.chain().focus().insertContentAt(range, issue.replacement).run()
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
    } catch (error) { setProofreadError(error instanceof Error ? error.message : String(error)) }
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
      <button className="toolbar-button" onClick={() => setProofreadOpen(true)}><ShieldCheck size={16} />校对{visibleLocalIssues.length > 0 ? ` ${visibleLocalIssues.length}` : ''}</button>
      <button className="toolbar-button" onClick={() => onFocusMode(!focusMode)}><Focus size={16} />专注</button>
      <span className="toolbar-spacer" /><span className={`save-indicator ${saveState}`} title={saveError}><Save size={14} />{saveState === 'saved' ? '已保存' : saveState === 'dirty' ? '等待保存' : saveState === 'saving' ? '保存中' : '保存失败，内容仍保留'}</span>
    </div>
    {saveError && <div className="save-error" role="alert">{saveError}</div>}
    <div className="writing-scroll"><article className="writing-page"><h1>{node.title}</h1><EditorContent editor={editor} /></article></div>
    <div className="editor-status"><span>{liveWordCount.toLocaleString()} 字</span>{visibleLocalIssues.length > 0 && <button className="proofread-count" onClick={() => setProofreadOpen(true)}>{visibleLocalIssues.length} 条校对提示</button>}</div>
    {proofreadOpen && <aside className="proofread-drawer" aria-label="校对结果">
      <header><div><h2>校对</h2><p>本地规则可直接修正；AI 建议会先进入修改提案。</p></div><button className="icon-button" aria-label="关闭校对" onClick={() => setProofreadOpen(false)}><X size={18} /></button></header>
      <div className="proofread-actions"><button onClick={() => void runLocalLint(editor?.getText({ blockSeparator: '\n\n' }) ?? '')}>重新检查本地规则</button><button className="primary" disabled={proofreadBusy} onClick={() => void runAiProofread()}><Sparkles size={15} />{proofreadBusy ? 'AI 校对中…' : '运行 AI 校对'}</button></div>
      {proofreadError && <div className="inline-error" role="alert">{proofreadError}</div>}
      <section><h3>本地规则 <span>{visibleLocalIssues.length}</span></h3>{visibleLocalIssues.length === 0 ? <p className="empty-copy">暂未发现明确的标点或空格问题。</p> : visibleLocalIssues.map((issue) => <article key={issue.id} className="proofread-issue"><span>{issueLabel(issue.kind)}</span><p>{issue.message}</p><small>原文：{(editor?.getText({ blockSeparator: '\n\n' }) ?? '').slice(issue.from, issue.to)}</small>{issue.replacement && <ins>建议：{issue.replacement}</ins>}<div><button onClick={() => jumpToLocalIssue(issue)}><LocateFixed size={14} />定位</button><button onClick={() => setIgnoredIssues((current) => new Set(current).add(issue.id))}>忽略</button>{issue.replacement && <button className="primary" onClick={() => void applyLocalIssue(issue).catch((error) => setProofreadError(error instanceof Error ? error.message : String(error)))}><Check size={14} />应用</button>}</div></article>)}</section>
      <section><h3>AI 校对 <span>{aiIssues.length}</span></h3>{aiIssues.length === 0 ? <p className="empty-copy">{aiProofreadRan ? 'AI 未发现需要处理的明确问题。' : '运行后，建议会先进入修改提案，不会直接改写正文。'}</p> : aiIssues.map((issue) => <article key={issue.id} className="proofread-issue"><span>{issueLabel(issue.category)}</span><p>{issue.reason}</p><small>原文：{issue.originalText}</small>{issue.suggestion && <ins>建议：{issue.suggestion}</ins>}<div><button className="primary" disabled={!issue.suggestion} onClick={() => void createProofreadPatch(issue).catch((error) => setProofreadError(error instanceof Error ? error.message : String(error)))}>加入修改提案</button></div></article>)}</section>
    </aside>}
  </section>
}
