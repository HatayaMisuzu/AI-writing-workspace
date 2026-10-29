import { Bot, Check, ChevronRight, Copy, FileSearch, MessageSquarePlus, PenLine, RefreshCw, Send, Sparkles, Square, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AIMode, ChatThread, ContextBundle, DigestStatus, DocumentTaskTarget, MemoryProposal, ModelConfig, Project, RoutedTask } from '../../../shared/domain'
import { DEFAULT_CANDIDATE_COUNT, MAX_CANDIDATE_COUNT, normalizeCandidateCount } from '../../../shared/candidate-count'
import { inputForQuickMode, inputForReaderThrough } from '../services/quick-mode-input'
import { CONSISTENCY_DEFAULT_INTENT } from '../../../shared/consistency-check'
import { ConsistencyReportView } from './ConsistencyReportView'
import type { EditorSelection } from './EditorSurface'
import { clearedExclusionState, isRowChecked, omittedLabel, toContextSourceRows, toggleExcludedId, toggleIncludedId, type ContextSourceRow } from '../services/context-sources'
import { activeCandidateText, canProposeGenerationPatch, mapChatHistory, resolveDisplayedModelMode, resolveModelDisplayName, retryInputForMessage, type AssistantHistoryMessage } from '../services/assistant-history'

type ContextSummary = { count: number; tokens: number; items: ContextSourceRow[] }
type ViewMessage = AssistantHistoryMessage & { selection?: EditorSelection; proposals?: MemoryProposal[]; proposalError?: string; recorded?: boolean; context?: ContextSummary }

const inferMode = (text: string, explicit: AIMode): AIMode => {
  if (explicit !== 'discussion') return explicit
  if (/整理.*灵感|整理.*想法/.test(text)) return 'organization'
  if (/脑暴|发散|可能性/.test(text)) return 'brainstorm'
  return 'discussion'
}
const digestLabel = (status?: DigestStatus): string => !status || status.state === 'missing' ? 'AI理解：未更新'
  : status.state === 'fresh' ? 'AI理解：已更新' : 'AI理解：正文已变化'
export function AssistantPanel({ project, documentId, documentRevision, selection, collapsed, onCollapse, onCreatePatch, onBeforeAI, onEnsureSaved, onOpenDocument, onOpenSettings }: {
  project: Project; documentId?: string; documentRevision?: number; selection?: EditorSelection; collapsed: boolean; onCollapse(): void
  /** @deprecated S8 起执笔走 onCreatePatch；保留可选以免旧调用方断裂。 */
  onInsertCandidate?: (target: DocumentTaskTarget, text: string) => Promise<void>
  onCreatePatch(target: DocumentTaskTarget, replacement: string): Promise<void>
  onBeforeAI(requestId: string, documentId?: string, selection?: EditorSelection): Promise<DocumentTaskTarget | undefined>
  /** S6：预览前先自动保存，保证预览=发送。 */
  onEnsureSaved(): Promise<void>
  onOpenDocument(documentId: string): Promise<void>; onOpenSettings(): void
}): React.JSX.Element {
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<AIMode>('discussion')
  const [candidateCount, setCandidateCount] = useState(DEFAULT_CANDIDATE_COUNT)
  // P1-5：读者审稿「读到第 N 章」；原样发给后端校验（<1、越界、非整数给中文报错）
  const [readerThrough, setReaderThrough] = useState('1')
  const [messages, setMessages] = useState<ViewMessage[]>([])
  const [threadId, setThreadId] = useState<string>()
  const [threads, setThreads] = useState<ChatThread[]>([])
  const [loadingHistory, setLoadingHistory] = useState(true)
  const [hasEarlier, setHasEarlier] = useState(false)
  const [runningId, setRunningId] = useState<string>()
  const [activeRequestMode, setActiveRequestMode] = useState<RoutedTask>()
  const [digestStatus, setDigestStatus] = useState<DigestStatus>()
  const [digestBusy, setDigestBusy] = useState(false)
  const [modelRouting, setModelRouting] = useState<{ models: ModelConfig[]; routes: Record<RoutedTask, string | 'default'> }>()
  const [excludedIds, setExcludedIds] = useState<string[]>([])
  const [includedIds, setIncludedIds] = useState<string[]>([])
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [sourcePreview, setSourcePreview] = useState<{ rows: ContextSourceRow[]; tokens: number; error?: string }>()
  const cleanups = useRef(new Map<string, () => void>())
  const streamed = useRef(new Map<string, string>())
  const chatScroll = useRef<HTMLDivElement>(null)
  const followLatest = useRef(true)
  const currentDocument = useRef(documentId)
  const digestRequest = useRef<string | undefined>(undefined)
  const inputMode = inferMode(input, mode) as RoutedTask
  const displayedModelMode = resolveDisplayedModelMode(inputMode, activeRequestMode)
  const modelName = modelRouting ? resolveModelDisplayName(displayedModelMode, modelRouting.models, modelRouting.routes) : '未配置模型'
  useEffect(() => { currentDocument.current = documentId }, [documentId])

  const loadThread = useCallback(async (targetThreadId?: string): Promise<void> => {
    setLoadingHistory(true)
    let available = await window.workspace.chat.listThreads(project.id)
    if (!available.length) available = [await window.workspace.chat.newThread(project.id, '创作讨论')]
    const thread = available.find((item) => item.id === targetThreadId) ?? available[0]
    const history = await window.workspace.chat.listMessages(project.id, thread.id, undefined, 50)
    followLatest.current = true
    setThreads(available); setThreadId(thread.id); setMessages(mapChatHistory(history)); setHasEarlier(history.length === 50); setLoadingHistory(false)
    const cleared = clearedExclusionState(); setExcludedIds(cleared.excludedIds); setIncludedIds(cleared.includedIds) // 排除项不持久化
  }, [project.id])

  useEffect(() => { void loadThread().catch((error) => { setLoadingHistory(false); setMessages([{ id: crypto.randomUUID(), role: 'assistant',
    content: `读取历史失败：${error instanceof Error ? error.message : String(error)}`, status: 'error', createdAt: Date.now() }]) }) }, [loadThread])
  useEffect(() => {
    let active = true
    void Promise.all([window.workspace.providers.models(), window.workspace.providers.routes()])
      .then(([models, routes]) => { if (active) setModelRouting({ models, routes }) })
      .catch(() => { if (active) setModelRouting(undefined) })
    return () => { active = false }
  }, [])
  useEffect(() => {
    if (!documentId) { setDigestStatus(undefined); return }
    void window.workspace.digests.status(project.id, documentId).then(setDigestStatus)
  }, [documentId, documentRevision, project.id])
  useEffect(() => () => { cleanups.current.forEach((cleanup, requestId) => { cleanup(); void window.workspace.ai.cancel(requestId) }); cleanups.current.clear() }, [])
  useEffect(() => {
    if (!followLatest.current || !chatScroll.current) return
    chatScroll.current.scrollTop = chatScroll.current.scrollHeight
  }, [messages])

  // R4/S6：发送前列出将要发送的上下文来源，可逐条排除；与发送使用同一后端规划逻辑。
  // 预览前先自动保存，保证预览正文与实际发送一致。
  useEffect(() => {
    if (!sourcesOpen || !threadId) return
    let active = true
    const requestedMode = inferMode(input.trim(), mode)
    const timer = setTimeout(() => {
      void onEnsureSaved()
        .then(() => window.workspace.ai.previewContext({ threadId, task: { mode: requestedMode,
          writePermission: requestedMode === 'editing' || requestedMode === 'generation' ? 'proposal' : 'none', userIntent: input.trim(),
          projectId: project.id, documentId, selection: selection ? { from: selection.fromPm, to: selection.toPm, text: selection.text } : undefined,
          excludedIds: excludedIds.length ? excludedIds : undefined,
          includedIds: includedIds.length ? includedIds : undefined,
          throughChapterNumber: requestedMode === 'reader_review' ? Number(readerThrough) : undefined,
          candidateCount: requestedMode === 'generation' ? normalizeCandidateCount(candidateCount) : undefined } }))
        .then((bundle) => { if (active) setSourcePreview({ rows: toContextSourceRows(bundle), tokens: bundle.metadata.estimatedTokens }) })
        .catch((error) => { if (active) setSourcePreview({ rows: [], tokens: 0, error: error instanceof Error ? error.message : String(error) }) })
    }, 250)
    return () => { active = false; clearTimeout(timer) }
  }, [sourcesOpen, threadId, input, mode, project.id, documentId, documentRevision, selection, excludedIds, includedIds, candidateCount, readerThrough, onEnsureSaved])

  const loadEarlier = async (): Promise<void> => {
    if (!threadId || !messages[0]) return
    const earlier = await window.workspace.chat.listMessages(project.id, threadId, { createdAt: messages[0].createdAt, id: messages[0].id }, 50)
    setMessages((current) => [...mapChatHistory(earlier), ...current]); setHasEarlier(earlier.length === 50)
  }
  const newThread = async (): Promise<void> => {
    if (runningId) return
    const thread = await window.workspace.chat.newThread(project.id, '新对话')
    setThreads((current) => [thread, ...current]); setThreadId(thread.id); setMessages([]); setHasEarlier(false); setInput('')
    // O1：与切换对话一致，清空上下文排除态
    const cleared = clearedExclusionState(); setExcludedIds(cleared.excludedIds); setIncludedIds(cleared.includedIds)
    setSourcePreview(undefined)
  }

  const submit = async (override?: { mode: AIMode; text: string }): Promise<void> => {
    const text = override ? override.text : input.trim()
    if (!text || runningId || !threadId) return
    const requestId = crypto.randomUUID(); const messageId = crypto.randomUUID(); const assistantId = crypto.randomUUID()
    const requestedMode = override ? override.mode : inferMode(text, mode); const now = Date.now()
    const requestCandidateCount = requestedMode === 'generation' ? normalizeCandidateCount(candidateCount) : 1
    followLatest.current = true
    setRunningId(requestId)
    setActiveRequestMode((requestedMode === 'consistency_check' ? 'organization' : requestedMode) as RoutedTask)
    setMessages((current) => [...current, { id: messageId, role: 'user', content: text, mode: requestedMode, selection, createdAt: now },
      { id: assistantId, role: 'assistant', content: '', status: 'streaming', mode: requestedMode, selection, replyToUserId: messageId, createdAt: now + 1 }])
    setThreads((current) => current.map((thread) => thread.id === threadId && thread.title === '新对话'
      ? { ...thread, title: [...text].slice(0, 22).join(''), updatedAt: now + 1 } : thread))
    if (!override) setInput('')
    let target: DocumentTaskTarget | undefined
    try {
      target = await onBeforeAI(requestId, documentId, override ? undefined : selection)
      if (target) setMessages((current) => current.map((item) => item.id === messageId || item.id === assistantId ? { ...item, target } : item))
    }
    catch (error) {
      setRunningId(undefined)
      setActiveRequestMode(undefined)
      setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, content: `发送前保存失败：${error instanceof Error ? error.message : String(error)}`, status: 'error' } : item))
      return
    }

    const reader = requestedMode === 'reader_review'
    const consistency = requestedMode === 'consistency_check'
    // 读者审稿 / 一致性检查只读：不抽取记忆意图、不带编辑目标
    const intentPromise = reader || consistency ? Promise.resolve([] as MemoryProposal[]) : window.workspace.memories.extractIntent(project.id, messageId, text)
    if (reader || consistency) target = undefined
    streamed.current.set(requestId, '')
    const cleanup = window.workspace.ai.start({ requestId, threadId, userMessageId: messageId, assistantMessageId: assistantId, task: {
      mode: requestedMode, writePermission: requestedMode === 'editing' || requestedMode === 'generation' ? 'proposal' : 'none', userIntent: text,
      projectId: project.id, documentId: consistency ? documentId : target?.documentId, target,
      selection: target?.selection ? { from: target.selection.fromPm, to: target.selection.toPm, text: target.selection.text } : undefined,
      excludedIds: excludedIds.length ? excludedIds : undefined,
      includedIds: includedIds.length ? includedIds : undefined,
      throughChapterNumber: reader ? Number(readerThrough) : undefined,
      candidateCount: requestedMode === 'generation' ? requestCandidateCount : undefined
    } }, (event) => {
      if (event.requestId !== requestId) return
      if (event.type === 'chunk') {
        const nextText = (streamed.current.get(requestId) ?? '') + event.chunk
        streamed.current.set(requestId, nextText)
        const bundle = event.context as ContextBundle | undefined
        const context = bundle ? { count: bundle.items.length, tokens: bundle.metadata.estimatedTokens, items: toContextSourceRows(bundle) } : undefined
        setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, content: nextText, context: context ?? item.context } : item))
      } else if (event.type === 'done') {
        const finalText = streamed.current.get(requestId) ?? ''
        const candidates = event.candidates?.length ? event.candidates : (requestedMode === 'generation' && finalText ? [finalText] : undefined)
        setRunningId(undefined)
        setActiveRequestMode(undefined)
        { const cleared = clearedExclusionState(); setExcludedIds(cleared.excludedIds); setIncludedIds(cleared.includedIds) }
        setMessages((current) => current.map((item) => item.id === assistantId ? {
          ...item,
          content: candidates?.[0] ?? finalText,
          candidates,
          activeCandidateIndex: 0,
          status: undefined
        } : item))
        // 润色：完成后自动提出补丁。执笔：须作者选中候选后才 propose（S8）。
        if (requestedMode === 'editing' && target?.selection && finalText) void onCreatePatch(target, finalText).catch((error) => {
          setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, content: `${finalText}\n\n提案创建失败：${error instanceof Error ? error.message : String(error)}`, status: 'error' } : item))
        })
        cleanups.current.get(requestId)?.(); cleanups.current.delete(requestId); streamed.current.delete(requestId)
      } else {
        setRunningId(undefined)
        setActiveRequestMode(undefined)
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
    const sourceDocumentId = documentId
    const requestId = crypto.randomUUID()
    digestRequest.current = requestId
    setDigestBusy(true)
    try {
      await onBeforeAI(requestId, sourceDocumentId); const result = await window.workspace.digests.run(project.id, sourceDocumentId)
      const status = await window.workspace.digests.status(project.id, sourceDocumentId)
      if (digestRequest.current === requestId && currentDocument.current === sourceDocumentId) setDigestStatus(status)
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', createdAt: Date.now(),
        content: result.repaired ? '来源章节的理解已修复并更新；记忆候选仍需你确认。' : '来源章节的理解已更新；记忆候选仍需你确认。' }])
    } catch (error) { setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', createdAt: Date.now(),
      content: `章节理解失败：${error instanceof Error ? error.message : String(error)} 正文没有被修改，可以重试。`, status: 'error' }]) }
    finally { if (digestRequest.current === requestId) setDigestBusy(false) }
  }

  const setQuickMode = (next: AIMode): void => {
    setMode(next)
    setInput((current) => inputForQuickMode(next, current, readerThrough))
  }
  const resolveProposal = async (messageId: string, proposalId: string, action: 'confirm' | 'reject'): Promise<void> => {
    try {
      const resolved = action === 'confirm'
        ? await window.workspace.memories.confirm(project.id, proposalId)
        : await window.workspace.memories.reject(project.id, proposalId)
      setMessages((current) => current.map((item) => {
        const proposals = item.proposals?.filter((proposal) => proposal.id !== proposalId &&
          !(action === 'confirm' && resolved.supersedes && proposal.supersedes === resolved.supersedes))
        return item.id === messageId ? { ...item, proposals, recorded: action === 'confirm', proposalError: undefined }
          : proposals?.length !== item.proposals?.length ? { ...item, proposals } : item
      }))
    } catch (error) { setMessages((current) => current.map((item) => item.id === messageId
      ? { ...item, proposalError: `记忆提案处理失败：${error instanceof Error ? error.message : String(error)}` } : item)) }
  }

  const proposeSelectedCandidate = async (message: ViewMessage): Promise<void> => {
    if (!message.target) return
    const text = activeCandidateText(message)
    try {
      await onCreatePatch(message.target, text)
      setMessages((current) => current.map((item) => item.id === message.id ? { ...item, inserted: true, proposalError: undefined } : item))
    } catch (error) {
      setMessages((current) => current.map((item) => item.id === message.id
        ? { ...item, proposalError: `提案创建失败：${error instanceof Error ? error.message : String(error)}` } : item))
    }
  }

  if (collapsed) return <button className="assistant-collapsed" onClick={onCollapse}><Bot size={18} /><span>同行者</span></button>
  return <aside className="assistant-panel">
    <header><div><h2>同行者</h2><span className="scope-notice">{modelName} · 仅使用《{project.title}》</span></div><div className="assistant-head-actions"><button className="icon-button" disabled={Boolean(runningId)} title="新对话" onClick={() => void newThread()}><MessageSquarePlus size={17} /></button><button className="icon-button" title="收起同行者" onClick={onCollapse}><ChevronRight size={18} /></button></div></header>
    <div className="thread-picker"><label htmlFor="assistant-thread">对话</label><select id="assistant-thread" value={threadId ?? ''} disabled={Boolean(runningId) || loadingHistory} onChange={(event) => void loadThread(event.target.value)}>{threads.map((thread) => <option key={thread.id} value={thread.id}>{thread.title} · {new Date(thread.updatedAt).toLocaleDateString()}</option>)}</select></div>
    <div className="assistant-tools"><button disabled={!documentId || digestBusy} onClick={() => void runDigest()}><FileSearch size={14} />{digestBusy ? '理解中…' : '理解本章'}</button><button disabled={!documentId || Boolean(runningId) || !threadId} title="只读冲突报告：本章正文 vs 已确认设定、人物卡、时间线" onClick={() => void submit({ mode: 'consistency_check', text: CONSISTENCY_DEFAULT_INTENT })}><FileSearch size={14} />检查一致性</button><span className={digestStatus?.state === 'stale' ? 'stale' : ''}>{digestLabel(digestStatus)}</span></div>
    <div className="chat-scroll" ref={chatScroll} onScroll={(event) => {
      const node = event.currentTarget
      followLatest.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
    }}>
      {hasEarlier && <button className="load-earlier" onClick={() => void loadEarlier()}>加载更早消息</button>}
      {loadingHistory ? <div className="chat-loading">正在读取这部作品的对话…</div> : messages.length === 0 ? <div className="chat-empty"><Sparkles size={23} /><h3>从这部作品继续聊</h3><p>讨论不会自动改正文；确定的设定会先成为待确认提案。</p>{modelName === '未配置模型' && <button className="text-action" onClick={onOpenSettings}>配置模型与服务</button>}</div> : messages.map((message) => <div key={message.id} className={`message ${message.role} ${message.status ?? ''}`}>
        <div className="message-role">{message.role === 'user' ? '你' : '同行者'}</div>
        {message.role === 'assistant' && message.mode === 'consistency_check' && !message.status && message.content
          ? <ConsistencyReportView text={message.content} />
          : <div className="message-content">{message.role === 'assistant' && message.candidates?.length ? activeCandidateText(message) : (message.content || '正在思考…')}</div>}
        {message.candidates && message.candidates.length > 1 && !message.status && <div className="candidate-switcher" role="tablist" aria-label="执笔候选">
          {message.candidates.map((_, index) => <button key={index} type="button" role="tab" aria-selected={(message.activeCandidateIndex ?? 0) === index}
            className={(message.activeCandidateIndex ?? 0) === index ? 'active' : ''}
            disabled={Boolean(message.inserted)}
            onClick={() => setMessages((current) => current.map((item) => item.id === message.id ? { ...item, activeCandidateIndex: index } : item))}>候选 {index + 1}</button>)}
        </div>}
        {message.context && <details className="context-inspector"><summary>使用 {message.context.count} 条作品上下文 · 约 {message.context.tokens} tokens</summary><ul>{message.context.items.map((item, index) => <li key={`${item.kind}-${index}`} className={item.included ? '' : 'omitted'}><strong>{item.title}</strong>{item.included ? <><span>{item.preview}{item.truncated ? '…（已截断）' : ''}</span><small>{item.reason}</small></> : <small>{omittedLabel(item.omittedReason)}</small>}</li>)}</ul></details>}
        {message.proposals?.map((proposal) => <div className="memory-proposal" key={proposal.id}><strong>记忆提案 · {proposal.type}</strong><p>{proposal.content}</p><span>尚未写入长期设定，需要你确认</span><div><button onClick={() => void resolveProposal(message.id, proposal.id, 'reject')}><Trash2 size={13} />忽略</button><button className="primary" onClick={() => void resolveProposal(message.id, proposal.id, 'confirm')}><Check size={13} />记录这条</button></div></div>)}
        {message.recorded && !message.proposals?.length && <div className="recorded-note"><Check size={13} />已记录到 Story Memory</div>}
        {message.proposalError && <div className="inline-error" role="alert">{message.proposalError}</div>}
        {message.role === 'assistant' && message.content && <div className="message-actions"><button title="复制" onClick={() => void navigator.clipboard.writeText(activeCandidateText(message))}><Copy size={14} /></button>
          {canProposeGenerationPatch(message) && <button onClick={() => void proposeSelectedCandidate(message)}><PenLine size={14} />采用为补丁</button>}
          {message.target && message.target.documentId !== documentId && <button onClick={() => void onOpenDocument(message.target!.documentId)}><FileSearch size={14} />打开来源章节</button>}
          {message.inserted && <span>已提出补丁</span>}
          {message.status === 'error' && <button onClick={() => setInput(retryInputForMessage(messages, message.id))}><RefreshCw size={14} />重试</button>}</div>}
      </div>)}
    </div>
    <div className="chat-compose">
      {sourcesOpen && <div className="context-sources" aria-label="将发送的上下文">
        {sourcePreview?.error ? <div className="inline-error" role="alert">上下文预览失败：{sourcePreview.error}</div>
          : !sourcePreview ? <div className="context-note">正在整理上下文…</div>
          : <><div className="context-note">将发送 {sourcePreview.rows.filter((row) => row.included).length} 条 · 约 {sourcePreview.tokens} tokens（取消勾选即不发送）</div>
            <ul>{sourcePreview.rows.map((row) => <li key={`${row.kind}:${row.id}`} className={row.included ? '' : 'omitted'}>
              <label><input type="checkbox" checked={isRowChecked(row, excludedIds, includedIds)} disabled={row.omittedReason === 'budget'} onChange={() => {
                if (row.kind === 'outline' || row.omittedReason === 'default_excluded') setIncludedIds((current) => toggleIncludedId(current, row.id))
                else setExcludedIds((current) => toggleExcludedId(current, row.id))
              }} />
                <strong>{row.title}</strong>{row.included ? <span>{row.preview}{row.truncated ? '…（已截断，部分已省略）' : ''}</span> : <small>{omittedLabel(row.omittedReason)}</small>}</label></li>)}</ul></>}
      </div>}
      {selection && <div className="selection-chip">已选择 {selection.text.length} 字</div>}
      <textarea value={input} disabled={loadingHistory} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit() } }} placeholder="和同行者聊聊这部作品…" />
      <div className="compose-row"><div className="quick-modes">
        <button className={mode === 'discussion' ? 'active' : ''} onClick={() => setQuickMode('discussion')}>问 AI</button>
        <button className={mode === 'editing' ? 'active' : ''} disabled={!selection} onClick={() => setQuickMode('editing')}>修改</button>
        <button className={mode === 'generation' ? 'active' : ''} onClick={() => setQuickMode('generation')}>续写</button>
        {mode === 'generation' && <label className="candidate-count-picker" title="执笔候选数（默认 1，最多 3）">候选
          <select aria-label="执笔候选数" value={candidateCount} disabled={Boolean(runningId)}
            onChange={(event) => setCandidateCount(normalizeCandidateCount(Number(event.target.value)))}>
            {Array.from({ length: MAX_CANDIDATE_COUNT }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>}
        <button className={mode === 'reader_review' ? 'active' : ''} title="只读报告：仅发送第 1..N 章正文" onClick={() => setQuickMode('reader_review')}>读者审稿</button>
        {mode === 'reader_review' && <label className="candidate-count-picker" title="读者读到第 N 章（按章树顺序）">读到第
          <input aria-label="读到第 N 章" type="number" min={1} step={1} style={{ width: 52 }} value={readerThrough} disabled={Boolean(runningId)}
            onChange={(event) => { const value = event.target.value; setReaderThrough(value); setInput((current) => inputForReaderThrough(current, value)) }} />章</label>}
        <button className={sourcesOpen ? 'active' : ''} aria-expanded={sourcesOpen} onClick={() => setSourcesOpen((open) => !open)}>上下文{(excludedIds.length || includedIds.length) ? `（排除 ${excludedIds.length}·勾选大纲 ${includedIds.length}）` : ''}</button>
      </div>{runningId ? <button className="send-button" title="取消请求" onClick={() => void window.workspace.ai.cancel(runningId)}><Square size={14} /></button> : <button className="send-button" disabled={!input.trim() || !threadId} aria-label="发送" onClick={() => void submit()}><Send size={15} /></button>}</div>
    </div>
  </aside>
}
