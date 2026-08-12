import { Bot, ChevronRight, Copy, PenLine, Play, RefreshCw, Send, Sparkles, Square, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import type { AIMode, Project } from '../../../shared/domain'
import type { EditorSelection } from './EditorSurface'

type ViewMessage = { id: string; role: 'user' | 'assistant'; content: string; status?: 'streaming' | 'error'; mode?: AIMode; selection?: EditorSelection }

const inferMode = (text: string, explicit: AIMode): AIMode => {
  if (explicit !== 'discussion') return explicit
  if (/读者|阅读体验|读者视角/.test(text)) return 'reader_review'
  if (/校对|错别字|病句|的地得/.test(text)) return 'proofreading'
  if (/理解本章|章节理解|digest|摘要本章/i.test(text)) return 'chapter_digest'
  if (/整理.*灵感|整理.*想法/.test(text)) return 'organization'
  if (/脑暴|发散|可能性/.test(text)) return 'brainstorm'
  return 'discussion'
}

export function AssistantPanel({ project, documentId, selection, collapsed, onCollapse, onInsertCandidate, onPatchCreated, onOpenSettings }: {
  project: Project; documentId?: string; selection?: EditorSelection; collapsed: boolean; onCollapse(): void
  onInsertCandidate(text: string): void; onPatchCreated(): void; onOpenSettings(): void
}): React.JSX.Element {
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<AIMode>('discussion')
  const [messages, setMessages] = useState<ViewMessage[]>([])
  const [runningId, setRunningId] = useState<string>()
  const [contextNote, setContextNote] = useState<string>()
  const cleanupRef = useRef<(() => void) | undefined>(undefined)
  const threadId = useMemo(() => `main-${project.id}`, [project.id])

  if (collapsed) return <button className="assistant-collapsed" onClick={onCollapse}><Bot size={18} /><span>同行者</span></button>

  const submit = (): void => {
    const text = input.trim()
    if (!text || runningId) return
    const messageId = crypto.randomUUID()
    const assistantId = crypto.randomUUID()
    const requestedMode = inferMode(text, mode)
    setMessages((current) => [...current, { id: messageId, role: 'user', content: text, mode: requestedMode, selection }, { id: assistantId, role: 'assistant', content: '', status: 'streaming', mode: requestedMode, selection }])
    setInput('')
    cleanupRef.current = window.workspace.ai.start({ mode: requestedMode, writePermission: requestedMode === 'editing' ? 'proposal' : 'none', userIntent: text,
      projectId: project.id, documentId, selection, throughChapterId: requestedMode === 'reader_review' ? documentId : undefined }, threadId, (event) => {
      if (event.type === 'chunk') {
        setRunningId(event.requestId)
        if (event.context && typeof event.context === 'object' && 'metadata' in event.context) {
          const metadata = (event.context as { metadata?: { sourceIds?: string[]; estimatedTokens?: number } }).metadata
          setContextNote(metadata ? `使用 ${metadata.sourceIds?.length ?? 0} 条项目内上下文 · 约 ${metadata.estimatedTokens ?? 0} tokens` : undefined)
        }
        setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, content: item.content + event.chunk } : item))
      } else if (event.type === 'done') {
        setRunningId(undefined)
        setMessages((current) => {
          const assistant = current.find((item) => item.id === assistantId)
          if (requestedMode === 'editing' && selection && documentId && assistant?.content) {
            void window.workspace.patches.propose({ projectId: project.id, documentId, from: selection.from, to: selection.to, replacement: assistant.content }).then(onPatchCreated)
          }
          if (requestedMode === 'chapter_digest' && documentId && assistant?.content) {
            void window.workspace.digests.store(project.id, documentId, assistant.content).catch(() => undefined)
          }
          return current.map((item) => item.id === assistantId ? { ...item, status: undefined } : item)
        })
        cleanupRef.current?.()
      } else {
        setRunningId(undefined)
        setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, content: event.message, status: 'error' } : item))
        cleanupRef.current?.()
      }
    })
  }

  const setQuickMode = (next: AIMode): void => {
    setMode(next)
    if (!input) setInput(next === 'editing' ? '请帮我修改选中的文字，保持原意和语气。' : next === 'generation' ? '请根据当前上下文生成一段候选文字。' : '')
  }

  return <aside className="assistant-panel">
    <header><div><h2>同行者</h2><span className="scope-notice">仅使用《{project.title}》的内容</span></div><button className="icon-button" onClick={onCollapse}><ChevronRight size={18} /></button></header>
    <div className="chat-scroll">
      {messages.length === 0 ? <div className="chat-empty"><Sparkles size={23} /><h3>需要时，我在这里</h3><p>可以讨论当前章节、检索前文，或为选区生成修改提案。未配置模型不会影响写作与保存。</p><button className="text-action" onClick={onOpenSettings}>配置模型与服务</button></div> : messages.map((message) => <div key={message.id} className={`message ${message.role} ${message.status ?? ''}`}>
        <div className="message-role">{message.role === 'user' ? '你' : '同行者'}</div><div className="message-content">{message.content || '正在思考…'}</div>
        {message.role === 'assistant' && message.content && <div className="message-actions"><button title="复制" onClick={() => void navigator.clipboard.writeText(message.content)}><Copy size={14} /></button>
          {message.mode === 'generation' && !message.status && <button onClick={() => onInsertCandidate(message.content)}><PenLine size={14} />插入候选</button>}
          {message.status === 'error' && <button onClick={() => setInput([...messages].reverse().find((item: ViewMessage) => item.role === 'user')?.content ?? '')}><RefreshCw size={14} />重试</button>}</div>}
      </div>)}
    </div>
    <div className="chat-compose">
      {contextNote && <div className="context-note">{contextNote}</div>}
      {selection && <div className="selection-chip"><span>已选择 {selection.text.length} 字</span><X size={13} /></div>}
      <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit() } }} placeholder="和它聊聊这部作品…" />
      <div className="compose-row"><div className="quick-modes">
        <button className={mode === 'discussion' ? 'active' : ''} onClick={() => setQuickMode('discussion')}>问 AI</button>
        <button className={mode === 'editing' ? 'active' : ''} disabled={!selection} onClick={() => setQuickMode('editing')}>修改</button>
        <button className={mode === 'generation' ? 'active' : ''} onClick={() => setQuickMode('generation')}>续写</button>
      </div>{runningId ? <button className="send-button" onClick={() => void window.workspace.ai.cancel(runningId)}><Square size={14} /></button> : <button className="send-button" onClick={submit}><Send size={15} /></button>}</div>
    </div>
  </aside>
}
