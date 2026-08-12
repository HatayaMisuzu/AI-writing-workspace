import { Bot, Check, ChevronRight, Copy, PenLine, RefreshCw, Send, Sparkles, Square, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AIMode, MemoryProposal, Project } from '../../../shared/domain'
import type { EditorSelection } from './EditorSurface'

type ViewMessage = {
  id: string; role: 'user' | 'assistant'; content: string; status?: 'streaming' | 'error'; mode?: AIMode
  selection?: EditorSelection; proposal?: MemoryProposal; proposalError?: string
}

const inferMode = (text: string, explicit: AIMode): AIMode => {
  if (explicit !== 'discussion') return explicit
  if (/读者|阅读体验|读者视角/.test(text)) return 'reader_review'
  if (/校对|错别字|病句|的地得/.test(text)) return 'proofreading'
  if (/理解本章|章节理解|digest|摘要本章/i.test(text)) return 'chapter_digest'
  if (/整理.*灵感|整理.*想法/.test(text)) return 'organization'
  if (/脑暴|发散|可能性/.test(text)) return 'brainstorm'
  return 'discussion'
}

const hasSaveIntent = (text: string): boolean => /记一下|记住|就这么定|确定下来|定了/.test(text)

export function AssistantPanel({ project, documentId, selection, collapsed, onCollapse, onInsertCandidate, onCreatePatch, onBeforeAI, onOpenSettings }: {
  project: Project; documentId?: string; selection?: EditorSelection; collapsed: boolean; onCollapse(): void
  onInsertCandidate(text: string): void; onCreatePatch(selection: EditorSelection, replacement: string): Promise<void>
  onBeforeAI(): Promise<void>; onOpenSettings(): void
}): React.JSX.Element {
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<AIMode>('discussion')
  const [messages, setMessages] = useState<ViewMessage[]>([])
  const [runningId, setRunningId] = useState<string>()
  const [cancellable, setCancellable] = useState(false)
  const [contextNote, setContextNote] = useState<string>()
  const cleanups = useRef(new Map<string, () => void>())
  const streamed = useRef(new Map<string, string>())
  const threadId = useMemo(() => `main-${project.id}`, [project.id])
  useEffect(() => () => { cleanups.current.forEach((cleanup, requestId) => { cleanup(); void window.workspace.ai.cancel(requestId) }); cleanups.current.clear() }, [])

  const submit = async (): Promise<void> => {
    const text = input.trim()
    if (!text || runningId) return
    const requestId = crypto.randomUUID()
    const messageId = crypto.randomUUID()
    const assistantId = crypto.randomUUID()
    const requestedMode = inferMode(text, mode)
    setRunningId(requestId)
    setCancellable(requestedMode !== 'chapter_digest')
    setMessages((current) => [...current, { id: messageId, role: 'user', content: text, mode: requestedMode, selection },
      { id: assistantId, role: 'assistant', content: '', status: 'streaming', mode: requestedMode, selection }])
    setInput('')
    try { await onBeforeAI() }
    catch (error) {
      setRunningId((current) => current === requestId ? undefined : current); setCancellable(false)
      setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, content: `发送前保存失败：${error instanceof Error ? error.message : String(error)}`, status: 'error' } : item))
      return
    }

    if (requestedMode === 'chapter_digest') {
      if (!documentId) {
        setRunningId(undefined); setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, content: '请先打开一个章节。', status: 'error' } : item)); return
      }
      try {
        const result = await window.workspace.digests.run(project.id, documentId)
        setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, content: result.repaired ? '章节理解已修复并更新。' : '章节理解已更新。', status: undefined } : item))
      } catch (error) {
        setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, content: error instanceof Error ? error.message : '章节理解失败，可重试。', status: 'error' } : item))
      } finally { setRunningId((current) => current === requestId ? undefined : current); setCancellable(false) }
      return
    }

    if (hasSaveIntent(text)) void window.workspace.memories.proposeFromChat(project.id, messageId, text).then((proposal) => {
      if (proposal) setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, proposal } : item))
    }).catch((error) => setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, proposalError: `记忆提案创建失败：${error instanceof Error ? error.message : String(error)}` } : item)))

    streamed.current.set(requestId, '')
    const cleanup = window.workspace.ai.start({ requestId, threadId, userMessageId: messageId, task: {
      mode: requestedMode, writePermission: requestedMode === 'editing' || hasSaveIntent(text) ? 'proposal' : 'none', userIntent: text,
      projectId: project.id, documentId, selection: selection ? { from: selection.fromPm, to: selection.toPm, text: selection.text } : undefined,
      throughChapterId: requestedMode === 'reader_review' ? documentId : undefined
    } }, (event) => {
      if (event.requestId !== requestId) return
      if (event.type === 'chunk') {
        const nextText = (streamed.current.get(requestId) ?? '') + event.chunk
        streamed.current.set(requestId, nextText)
        if (event.context && typeof event.context === 'object' && 'metadata' in event.context) {
          const metadata = (event.context as { metadata?: { sourceIds?: string[]; estimatedTokens?: number } }).metadata
          setContextNote(metadata ? `使用 ${metadata.sourceIds?.length ?? 0} 条项目内上下文 · 约 ${metadata.estimatedTokens ?? 0} tokens` : undefined)
        }
        setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, content: nextText } : item))
      } else if (event.type === 'done') {
        const finalText = streamed.current.get(requestId) ?? ''
        setRunningId((current) => current === requestId ? undefined : current)
        setCancellable(false)
        setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, content: finalText, status: undefined } : item))
        if (requestedMode === 'editing' && selection && finalText) void onCreatePatch(selection, finalText).catch((error) => {
          setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, content: `${finalText}\n\n提案创建失败：${error instanceof Error ? error.message : String(error)}`, status: 'error' } : item))
        })
        cleanups.current.get(requestId)?.(); cleanups.current.delete(requestId); streamed.current.delete(requestId)
      } else {
        setRunningId((current) => current === requestId ? undefined : current)
        setCancellable(false)
        setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, content: event.message, status: 'error' } : item))
        cleanups.current.get(requestId)?.(); cleanups.current.delete(requestId); streamed.current.delete(requestId)
      }
    })
    cleanups.current.set(requestId, cleanup)
  }

  const setQuickMode = (next: AIMode): void => {
    setMode(next)
    if (!input) setInput(next === 'editing' ? '请帮我修改选中的文字，保持原意和语气。' : next === 'generation' ? '请根据当前上下文生成一段候选文字。' : '')
  }

  const resolveProposal = async (messageId: string, proposalId: string, action: 'confirm' | 'reject'): Promise<void> => {
    try {
      if (action === 'confirm') await window.workspace.memories.confirm(project.id, proposalId)
      else await window.workspace.memories.reject(project.id, proposalId)
      setMessages((current) => current.map((item) => item.id === messageId ? { ...item, proposal: undefined, proposalError: undefined } : item))
    } catch (error) {
      setMessages((current) => current.map((item) => item.id === messageId
        ? { ...item, proposalError: `记忆提案处理失败：${error instanceof Error ? error.message : String(error)}` } : item))
    }
  }

  if (collapsed) return <button className="assistant-collapsed" onClick={onCollapse}><Bot size={18} /><span>同行者</span></button>
  return <aside className="assistant-panel">
    <header><div><h2>同行者</h2><span className="scope-notice">仅使用《{project.title}》的内容</span></div><button className="icon-button" onClick={onCollapse}><ChevronRight size={18} /></button></header>
    <div className="chat-scroll">
      {messages.length === 0 ? <div className="chat-empty"><Sparkles size={23} /><h3>需要时，我在这里</h3><p>可以讨论当前章节、检索前文，或为选区生成修改提案。未配置模型不会影响写作与保存。</p><button className="text-action" onClick={onOpenSettings}>配置模型与服务</button></div> : messages.map((message) => <div key={message.id} className={`message ${message.role} ${message.status ?? ''}`}>
        <div className="message-role">{message.role === 'user' ? '你' : '同行者'}</div><div className="message-content">{message.content || '正在思考…'}</div>
        {message.proposal && <div className="memory-proposal"><strong>记忆提案</strong><p>{message.proposal.content}</p><span>仍为 suggested，需要你确认</span><div><button onClick={() => void resolveProposal(message.id, message.proposal!.id, 'reject')}><Trash2 size={13} />忽略</button><button className="primary" onClick={() => void resolveProposal(message.id, message.proposal!.id, 'confirm')}><Check size={13} />记录这条</button></div></div>}
        {message.proposalError && <div className="inline-error" role="alert">{message.proposalError}</div>}
        {message.role === 'assistant' && message.content && <div className="message-actions"><button title="复制" onClick={() => void navigator.clipboard.writeText(message.content)}><Copy size={14} /></button>
          {message.mode === 'generation' && !message.status && <button onClick={() => onInsertCandidate(message.content)}><PenLine size={14} />插入候选</button>}
          {message.status === 'error' && <button onClick={() => setInput([...messages].reverse().find((item) => item.role === 'user')?.content ?? '')}><RefreshCw size={14} />重试</button>}</div>}
      </div>)}
    </div>
    <div className="chat-compose">
      {contextNote && <div className="context-note">{contextNote}</div>}
      {selection && <div className="selection-chip"><span>已选择 {selection.text.length} 字</span><X size={13} /></div>}
      <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit() } }} placeholder="和它聊聊这部作品…" />
      <div className="compose-row"><div className="quick-modes">
        <button className={mode === 'discussion' ? 'active' : ''} onClick={() => setQuickMode('discussion')}>问 AI</button>
        <button className={mode === 'editing' ? 'active' : ''} disabled={!selection} onClick={() => setQuickMode('editing')}>修改</button>
        <button className={mode === 'generation' ? 'active' : ''} onClick={() => setQuickMode('generation')}>续写</button>
      </div>{runningId ? <button className="send-button" disabled={!cancellable} title={cancellable ? '取消请求' : '章节理解处理中'} onClick={() => { if (cancellable) void window.workspace.ai.cancel(runningId) }}><Square size={14} /></button> : <button className="send-button" onClick={() => void submit()}><Send size={15} /></button>}</div>
    </div>
  </aside>
}
