import { Bot, Check, ChevronRight, Copy, FileSearch, MessageSquarePlus, PenLine, RefreshCw, Send, Sparkles, Square, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AIMode, ChatThread, ContextBundle, DigestStatus, MemoryProposal, Project, RoutedTask } from '../../../shared/domain'
import type { EditorSelection } from './EditorSurface'
import { canInsertCandidate, mapChatHistory, resolveModelDisplayName, retryInputForMessage, type AssistantHistoryMessage } from '../services/assistant-history'

type ContextSummary = { count: number; tokens: number; items: Array<{ kind: string; title: string; reason: string; preview: string }> }
type ViewMessage = AssistantHistoryMessage & { selection?: EditorSelection; proposals?: MemoryProposal[]; proposalError?: string; recorded?: boolean; context?: ContextSummary }

const inferMode = (text: string, explicit: AIMode): AIMode => {
  if (explicit !== 'discussion') return explicit
  if (/整理.*灵感|整理.*想法/.test(text)) return 'organization'
  if (/脑暴|发散|可能性/.test(text)) return 'brainstorm'
  return 'discussion'
}
const digestLabel = (status?: DigestStatus): string => !status || status.state === 'missing' ? 'AI理解：未更新'
  : status.state === 'fresh' ? 'AI理解：已更新' : 'AI理解：正文已变化'
export function AssistantPanel({ project, documentId, documentRevision, selection, collapsed, onCollapse, onInsertCandidate, onCreatePatch, onBeforeAI, onOpenSettings }: {
  project: Project; documentId?: string; documentRevision?: number; selection?: EditorSelection; collapsed: boolean; onCollapse(): void
  onInsertCandidate(text: string): Promise<void>; onCreatePatch(selection: EditorSelection, replacement: string): Promise<void>
  onBeforeAI(): Promise<void>; onOpenSettings(): void
}): React.JSX.Element {
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<AIMode>('discussion')
  const [messages, setMessages] = useState<ViewMessage[]>([])
  const [threadId, setThreadId] = useState<string>()
  const [threads, setThreads] = useState<ChatThread[]>([])
  const [loadingHistory, setLoadingHistory] = useState(true)
  const [hasEarlier, setHasEarlier] = useState(false)
  const [runningId, setRunningId] = useState<string>()
  const [digestStatus, setDigestStatus] = useState<DigestStatus>()
  const [digestBusy, setDigestBusy] = useState(false)
  const [modelName, setModelName] = useState('未配置模型')
  const cleanups = useRef(new Map<string, () => void>())
  const streamed = useRef(new Map<string, string>())
  const chatScroll = useRef<HTMLDivElement>(null)
  const followLatest = useRef(true)
  const routedMode = inferMode(input, mode) as RoutedTask

  const loadThread = useCallback(async (targetThreadId?: string): Promise<void> => {
    setLoadingHistory(true)
    let available = await window.workspace.chat.listThreads(project.id)
    if (!available.length) available = [await window.workspace.chat.newThread(project.id, '创作讨论')]
    const thread = available.find((item) => item.id === targetThreadId) ?? available[0]
    const history = await window.workspace.chat.listMessages(project.id, thread.id, undefined, 50)
    followLatest.current = true
    setThreads(available); setThreadId(thread.id); setMessages(mapChatHistory(history)); setHasEarlier(history.length === 50); setLoadingHistory(false)
  }, [project.id])

  useEffect(() => { void loadThread().catch((error) => { setLoadingHistory(false); setMessages([{ id: crypto.randomUUID(), role: 'assistant',
    content: `读取历史失败：${error instanceof Error ? error.message : String(error)}`, status: 'error', createdAt: Date.now() }]) }) }, [loadThread])
  useEffect(() => {
    void Promise.all([window.workspace.providers.models(), window.workspace.providers.routes()])
      .then(([models, routes]) => setModelName(resolveModelDisplayName(routedMode, models, routes)))
      .catch(() => setModelName('未配置模型'))
  }, [routedMode])
  useEffect(() => {
    if (!documentId) { setDigestStatus(undefined); return }
    void window.workspace.digests.status(project.id, documentId).then(setDigestStatus)
  }, [documentId, documentRevision, project.id])
  useEffect(() => () => { cleanups.current.forEach((cleanup, requestId) => { cleanup(); void window.workspace.ai.cancel(requestId) }); cleanups.current.clear() }, [])
  useEffect(() => {
    if (!followLatest.current || !chatScroll.current) return
    chatScroll.current.scrollTop = chatScroll.current.scrollHeight
  }, [messages])

  const loadEarlier = async (): Promise<void> => {
    if (!threadId || !messages[0]) return
    const earlier = await window.workspace.chat.listMessages(project.id, threadId, messages[0].createdAt, 50)
    setMessages((current) => [...mapChatHistory(earlier), ...current]); setHasEarlier(earlier.length === 50)
  }
  const newThread = async (): Promise<void> => {
    if (runningId) return
    const thread = await window.workspace.chat.newThread(project.id, '新对话')
    setThreads((current) => [thread, ...current]); setThreadId(thread.id); setMessages([]); setHasEarlier(false); setInput('')
  }

  const submit = async (): Promise<void> => {
    const text = input.trim()
    if (!text || runningId || !threadId) return
    const requestId = crypto.randomUUID(); const messageId = crypto.randomUUID(); const assistantId = crypto.randomUUID()
    const requestedMode = inferMode(text, mode); const now = Date.now()
    followLatest.current = true
    setRunningId(requestId)
    setMessages((current) => [...current, { id: messageId, role: 'user', content: text, mode: requestedMode, selection, createdAt: now },
      { id: assistantId, role: 'assistant', content: '', status: 'streaming', mode: requestedMode, selection, replyToUserId: messageId, createdAt: now + 1 }])
    setThreads((current) => current.map((thread) => thread.id === threadId && thread.title === '新对话'
      ? { ...thread, title: [...text].slice(0, 22).join(''), updatedAt: now + 1 } : thread))
    setInput('')
    try { await onBeforeAI() }
    catch (error) {
      setRunningId(undefined)
      setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, content: `发送前保存失败：${error instanceof Error ? error.message : String(error)}`, status: 'error' } : item))
      return
    }

    const intentPromise = window.workspace.memories.extractIntent(project.id, messageId, text)
    streamed.current.set(requestId, '')
    const cleanup = window.workspace.ai.start({ requestId, threadId, userMessageId: messageId, assistantMessageId: assistantId, task: {
      mode: requestedMode, writePermission: requestedMode === 'editing' || requestedMode === 'generation' ? 'proposal' : 'none', userIntent: text,
      projectId: project.id, documentId, selection: selection ? { from: selection.fromPm, to: selection.toPm, text: selection.text } : undefined
    } }, (event) => {
      if (event.requestId !== requestId) return
      if (event.type === 'chunk') {
        const nextText = (streamed.current.get(requestId) ?? '') + event.chunk
        streamed.current.set(requestId, nextText)
        const bundle = event.context as ContextBundle | undefined
        const context = bundle ? { count: bundle.items.length, tokens: bundle.metadata.estimatedTokens,
          items: bundle.items.map((item) => ({ kind: item.kind, title: item.title, reason: item.reason,
            preview: item.content.replace(/\s+/g, ' ').slice(0, 90) })) } : undefined
        setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, content: nextText, context: context ?? item.context } : item))
      } else if (event.type === 'done') {
        const finalText = streamed.current.get(requestId) ?? ''
        setRunningId(undefined)
        setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, content: finalText, status: undefined } : item))
        if (requestedMode === 'editing' && selection && finalText) void onCreatePatch(selection, finalText).catch((error) => {
          setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, content: `${finalText}\n\n提案创建失败：${error instanceof Error ? error.message : String(error)}`, status: 'error' } : item))
        })
        cleanups.current.get(requestId)?.(); cleanups.current.delete(requestId); streamed.current.delete(requestId)
      } else {
        setRunningId(undefined)
        setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, content: event.message,
          status: event.code === 'PROVIDER_CANCELLED' ? 'cancelled' : 'error' } : item))
        cleanups.current.get(requestId)?.(); cleanups.current.delete(requestId); streamed.current.delete(requestId)
      }
    })
    cleanups.current.set(requestId, cleanup)
    void intentPromise.then((proposals) => {
      if (proposals.length) setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, proposals } : item))
    }).catch((error) => setMessages((current) => current.map((item) => item.id === assistantId
      ? { ...item, proposalError: `记忆提案创建失败：${error instanceof Error ? error.message : String(error)}` } : item)))
  }

  const runDigest = async (): Promise<void> => {
    if (!documentId || digestBusy) return
    setDigestBusy(true)
    try {
      await onBeforeAI(); const result = await window.workspace.digests.run(project.id, documentId)
      setDigestStatus(await window.workspace.digests.status(project.id, documentId))
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', createdAt: Date.now(),
        content: result.repaired ? '本章理解已修复并更新；记忆候选仍需你确认。' : '本章理解已更新；记忆候选仍需你确认。' }])
    } catch (error) { setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', createdAt: Date.now(),
      content: `章节理解失败：${error instanceof Error ? error.message : String(error)} 正文没有被修改，可以重试。`, status: 'error' }]) }
    finally { setDigestBusy(false) }
  }

  const setQuickMode = (next: AIMode): void => {
    setMode(next)
    if (!input) setInput(next === 'editing' ? '请修改选中的文字，保持原意和语气。' : next === 'generation' ? '请根据当前上下文生成一段候选文字。' : '')
  }
  const resolveProposal = async (messageId: string, proposalId: string, action: 'confirm' | 'reject'): Promise<void> => {
    try {
      if (action === 'confirm') await window.workspace.memories.confirm(project.id, proposalId)
      else await window.workspace.memories.reject(project.id, proposalId)
      setMessages((current) => current.map((item) => item.id === messageId ? { ...item,
        proposals: item.proposals?.filter((proposal) => proposal.id !== proposalId), recorded: action === 'confirm', proposalError: undefined } : item))
    } catch (error) { setMessages((current) => current.map((item) => item.id === messageId
      ? { ...item, proposalError: `记忆提案处理失败：${error instanceof Error ? error.message : String(error)}` } : item)) }
  }

  if (collapsed) return <button className="assistant-collapsed" onClick={onCollapse}><Bot size={18} /><span>同行者</span></button>
  return <aside className="assistant-panel">
    <header><div><h2>同行者</h2><span className="scope-notice">{modelName} · 仅使用《{project.title}》</span></div><div className="assistant-head-actions"><button className="icon-button" disabled={Boolean(runningId)} title="新对话" onClick={() => void newThread()}><MessageSquarePlus size={17} /></button><button className="icon-button" title="收起同行者" onClick={onCollapse}><ChevronRight size={18} /></button></div></header>
    <div className="thread-picker"><label htmlFor="assistant-thread">对话</label><select id="assistant-thread" value={threadId ?? ''} disabled={Boolean(runningId) || loadingHistory} onChange={(event) => void loadThread(event.target.value)}>{threads.slice(0, 12).map((thread) => <option key={thread.id} value={thread.id}>{thread.title} · {new Date(thread.updatedAt).toLocaleDateString()}</option>)}</select></div>
    <div className="assistant-tools"><button disabled={!documentId || digestBusy} onClick={() => void runDigest()}><FileSearch size={14} />{digestBusy ? '理解中…' : '理解本章'}</button><span className={digestStatus?.state === 'stale' ? 'stale' : ''}>{digestLabel(digestStatus)}</span></div>
    <div className="chat-scroll" ref={chatScroll} onScroll={(event) => {
      const node = event.currentTarget
      followLatest.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
    }}>
      {hasEarlier && <button className="load-earlier" onClick={() => void loadEarlier()}>加载更早消息</button>}
      {loadingHistory ? <div className="chat-loading">正在读取这部作品的对话…</div> : messages.length === 0 ? <div className="chat-empty"><Sparkles size={23} /><h3>从这部作品继续聊</h3><p>讨论不会自动改正文；确定的设定会先成为待确认提案。</p>{modelName === '未配置模型' && <button className="text-action" onClick={onOpenSettings}>配置模型与服务</button>}</div> : messages.map((message) => <div key={message.id} className={`message ${message.role} ${message.status ?? ''}`}>
        <div className="message-role">{message.role === 'user' ? '你' : '同行者'}</div><div className="message-content">{message.content || '正在思考…'}</div>
        {message.context && <details className="context-inspector"><summary>使用 {message.context.count} 条作品上下文 · 约 {message.context.tokens} tokens</summary><ul>{message.context.items.map((item, index) => <li key={`${item.kind}-${index}`}><strong>{item.title}</strong><span>{item.preview}</span><small>{item.reason}</small></li>)}</ul></details>}
        {message.proposals?.map((proposal) => <div className="memory-proposal" key={proposal.id}><strong>记忆提案 · {proposal.type}</strong><p>{proposal.content}</p><span>尚未写入长期设定，需要你确认</span><div><button onClick={() => void resolveProposal(message.id, proposal.id, 'reject')}><Trash2 size={13} />忽略</button><button className="primary" onClick={() => void resolveProposal(message.id, proposal.id, 'confirm')}><Check size={13} />记录这条</button></div></div>)}
        {message.recorded && !message.proposals?.length && <div className="recorded-note"><Check size={13} />已记录到 Story Memory</div>}
        {message.proposalError && <div className="inline-error" role="alert">{message.proposalError}</div>}
        {message.role === 'assistant' && message.content && <div className="message-actions"><button title="复制" onClick={() => void navigator.clipboard.writeText(message.content)}><Copy size={14} /></button>
          {canInsertCandidate(message) && <button onClick={() => void onInsertCandidate(message.content).then(() => setMessages((current) => current.map((item) => item.id === message.id ? { ...item, inserted: true } : item))).catch((error) => setMessages((current) => current.map((item) => item.id === message.id ? { ...item, content: `${item.content}\n\n插入失败：${error instanceof Error ? error.message : String(error)}`, status: 'error' } : item)))}><PenLine size={14} />插入候选</button>}
          {message.inserted && <span>已插入正文</span>}
          {message.status === 'error' && <button onClick={() => setInput(retryInputForMessage(messages, message.id))}><RefreshCw size={14} />重试</button>}</div>}
      </div>)}
    </div>
    <div className="chat-compose">
      {selection && <div className="selection-chip">已选择 {selection.text.length} 字</div>}
      <textarea value={input} disabled={loadingHistory} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit() } }} placeholder="和同行者聊聊这部作品…" />
      <div className="compose-row"><div className="quick-modes">
        <button className={mode === 'discussion' ? 'active' : ''} onClick={() => setQuickMode('discussion')}>问 AI</button>
        <button className={mode === 'editing' ? 'active' : ''} disabled={!selection} onClick={() => setQuickMode('editing')}>修改</button>
        <button className={mode === 'generation' ? 'active' : ''} onClick={() => setQuickMode('generation')}>续写</button>
      </div>{runningId ? <button className="send-button" title="取消请求" onClick={() => void window.workspace.ai.cancel(runningId)}><Square size={14} /></button> : <button className="send-button" disabled={!input.trim() || !threadId} aria-label="发送" onClick={() => void submit()}><Send size={15} /></button>}</div>
    </div>
  </aside>
}
