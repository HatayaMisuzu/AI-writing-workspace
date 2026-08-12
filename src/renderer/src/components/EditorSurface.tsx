import { CharacterCount } from '@tiptap/extension-character-count'
import { Placeholder } from '@tiptap/extension-placeholder'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Focus, Redo2, Save, Undo2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DocumentContent, DocumentNode, LocalLintIssue, TextPatch } from '../../../shared/domain'
import { SaveCoordinator, type SaveState } from '../services/save-coordinator'

export interface EditorSelection { fromPm: number; toPm: number; text: string }
export interface EditorController {
  flush(): Promise<void>
  hasPending(): boolean
  currentRevision(): number
  createPatch(selection: EditorSelection, replacement: string): Promise<TextPatch>
  applyPatch(patch: TextPatch): Promise<TextPatch>
}

export function EditorSurface({ node, content, focusMode, onFocusMode, onSaved, onSelection, onRegisterInsert, onRegisterController }: {
  node: DocumentNode; content: DocumentContent; focusMode: boolean; onFocusMode(value: boolean): void
  onSaved(content: DocumentContent): void; onSelection(selection?: EditorSelection): void
  onRegisterInsert(handler: (text: string) => void): void
  onRegisterController(controller?: EditorController): void
}): React.JSX.Element {
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [saveError, setSaveError] = useState<string>()
  const [issues, setIssues] = useState<LocalLintIssue[]>([])
  const onSavedRef = useRef(onSaved)
  const initialRevision = useRef({ documentId: node.id, revision: content.revision })
  if (initialRevision.current.documentId !== node.id) initialRevision.current = { documentId: node.id, revision: content.revision }
  useEffect(() => { onSavedRef.current = onSaved }, [onSaved])

  const coordinator = useMemo(() => new SaveCoordinator(initialRevision.current.revision, async (snapshot) =>
    window.workspace.documents.save({ projectId: node.projectId, documentId: node.id, editorJson: snapshot.editorJson,
      plainText: snapshot.plainText, expectedRevision: snapshot.baseRevision }), (saved) => {
    onSavedRef.current(saved)
    void window.workspace.linter.run(saved.plainText).then(setIssues)
  }, (state, error) => {
    setSaveState(state)
    setSaveError(state === 'error' ? (error instanceof Error ? error.message : '保存失败，请重试。') : undefined)
  }), [node.id, node.projectId])

  const editor = useEditor({
    extensions: [StarterKit, CharacterCount, Placeholder.configure({ placeholder: '从这里开始写……' })],
    content: content.editorJson,
    editorProps: { attributes: { class: 'manuscript-editor', spellcheck: 'false' } },
    onUpdate: ({ editor: activeEditor }) => {
      coordinator.markDirty({ editorJson: activeEditor.getJSON() as Record<string, unknown>, plainText: activeEditor.getText({ blockSeparator: '\n\n' }) })
      coordinator.schedule()
    },
    onSelectionUpdate: ({ editor: activeEditor }) => {
      const { from, to } = activeEditor.state.selection
      onSelection(from === to ? undefined : { fromPm: from, toPm: to, text: activeEditor.state.doc.textBetween(from, to, '\n') })
    }
  }, [node.id])

  useEffect(() => {
    coordinator.resetRevision(content.revision)
  }, [content.revision, coordinator])

  useEffect(() => onRegisterInsert((text) => editor?.chain().focus().insertContent(text).run()), [editor, onRegisterInsert])
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
        editor.setEditable(false)
        try {
          await coordinator.flush()
          const currentText = editor.state.doc.textBetween(patch.fromPm, patch.toPm, '\n')
          const prepared = await window.workspace.patches.prepare(node.projectId, patch.id, coordinator.currentRevision(), currentText)
          if (prepared.status === 'stale') return prepared
          const applied = editor.chain().insertContentAt({ from: patch.fromPm, to: patch.toPm }, patch.replacement).run()
          if (!applied) throw new Error('无法在当前富文本文档中应用提案。')
          await coordinator.flush()
          return window.workspace.patches.complete(node.projectId, patch.id, coordinator.currentRevision())
        } finally { editor.setEditable(true) }
      }
    }
    onRegisterController(controller)
    return () => { onRegisterController(undefined); coordinator.dispose() }
  }, [coordinator, editor, node.id, node.projectId, onRegisterController])

  return <section className={focusMode ? 'editor-pane focus-mode' : 'editor-pane'}>
    <div className="editor-toolbar">
      <button className="icon-button" onClick={() => editor?.chain().focus().undo().run()}><Undo2 size={17} /></button>
      <button className="icon-button" onClick={() => editor?.chain().focus().redo().run()}><Redo2 size={17} /></button><span className="toolbar-separator" />
      <button className={editor?.isActive('bold') ? 'toolbar-button active' : 'toolbar-button'} onClick={() => editor?.chain().focus().toggleBold().run()}>粗体</button>
      <button className="toolbar-button" onClick={() => onFocusMode(!focusMode)}><Focus size={16} />专注</button>
      <span className="toolbar-spacer" /><span className={`save-indicator ${saveState}`} title={saveError}><Save size={14} />{saveState === 'saved' ? '已保存' : saveState === 'dirty' ? '等待保存' : saveState === 'saving' ? '保存中' : '保存失败，内容仍保留'}</span>
    </div>
    {saveError && <div className="save-error" role="alert">{saveError}</div>}
    <div className="writing-scroll"><article className="writing-page"><h1>{node.title}</h1><EditorContent editor={editor} /></article></div>
    <div className="editor-status"><span>{content.wordCount.toLocaleString()} 字</span>{issues.length > 0 && <span className="proofread-count">{issues.length} 条本地校对提示</span>}</div>
  </section>
}
