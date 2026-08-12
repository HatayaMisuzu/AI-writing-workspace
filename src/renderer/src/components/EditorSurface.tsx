import { CharacterCount } from '@tiptap/extension-character-count'
import { Placeholder } from '@tiptap/extension-placeholder'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Focus, Maximize2, Redo2, Save, Undo2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { DocumentContent, DocumentNode, LocalLintIssue } from '../../../shared/domain'

export interface EditorSelection { from: number; to: number; text: string }

export function EditorSurface({ node, content, focusMode, onFocusMode, onSaved, onSelection, onRegisterInsert }: {
  node: DocumentNode; content: DocumentContent; focusMode: boolean; onFocusMode(value: boolean): void
  onSaved(content: DocumentContent): void; onSelection(selection?: EditorSelection): void
  onRegisterInsert(handler: (text: string) => void): void
}): React.JSX.Element {
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving' | 'error'>('saved')
  const [issues, setIssues] = useState<LocalLintIssue[]>([])
  const revisionRef = useRef(content.revision)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const editor = useEditor({
    extensions: [StarterKit, CharacterCount, Placeholder.configure({ placeholder: '从这里开始写……' })],
    content: content.editorJson,
    editorProps: { attributes: { class: 'manuscript-editor', spellcheck: 'false' } },
    onUpdate: ({ editor: activeEditor }) => {
      setSaveState('dirty')
      if (saveTimer.current) clearTimeout(saveTimer.current)
      const json = activeEditor.getJSON() as Record<string, unknown>
      const text = activeEditor.getText({ blockSeparator: '\n\n' })
      saveTimer.current = setTimeout(async () => {
        setSaveState('saving')
        try {
          const saved = await window.workspace.documents.save({ projectId: node.projectId, documentId: node.id, editorJson: json, plainText: text, expectedRevision: revisionRef.current })
          revisionRef.current = saved.revision
          onSaved(saved)
          setIssues(await window.workspace.linter.run(text))
          setSaveState('saved')
        } catch { setSaveState('error') }
      }, 700)
    },
    onSelectionUpdate: ({ editor: activeEditor }) => {
      const { from, to } = activeEditor.state.selection
      onSelection(from === to ? undefined : { from, to, text: activeEditor.state.doc.textBetween(from, to, '\n') })
    }
  }, [node.id])

  useEffect(() => {
    revisionRef.current = content.revision
    editor?.commands.setContent(content.editorJson, { emitUpdate: false })
    setSaveState('saved')
  }, [content.documentId, content.revision, editor])
  useEffect(() => onRegisterInsert((text) => editor?.chain().focus().insertContent(text).run()), [editor, onRegisterInsert])
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current) }, [])

  return <section className={focusMode ? 'editor-pane focus-mode' : 'editor-pane'}>
    <div className="editor-toolbar">
      <button className="icon-button" onClick={() => editor?.chain().focus().undo().run()}><Undo2 size={17} /></button>
      <button className="icon-button" onClick={() => editor?.chain().focus().redo().run()}><Redo2 size={17} /></button><span className="toolbar-separator" />
      <button className={editor?.isActive('bold') ? 'toolbar-button active' : 'toolbar-button'} onClick={() => editor?.chain().focus().toggleBold().run()}>粗体</button>
      <button className="toolbar-button" onClick={() => onFocusMode(!focusMode)}><Focus size={16} />专注</button>
      <button className="toolbar-button"><Maximize2 size={15} />打字机</button>
      <span className="toolbar-spacer" /><span className={`save-indicator ${saveState}`}><Save size={14} />{saveState === 'saved' ? '已保存' : saveState === 'dirty' ? '等待保存' : saveState === 'saving' ? '保存中' : '保存失败'}</span>
    </div>
    <div className="writing-scroll"><article className="writing-page"><h1>{node.title}</h1><EditorContent editor={editor} /></article></div>
    <div className="editor-status"><span>{content.wordCount.toLocaleString()} 字</span>{issues.length > 0 && <span className="proofread-count">{issues.length} 条本地校对提示</span>}</div>
  </section>
}
