import { userErrorMessage } from '../../../shared/user-error'
import { CharacterCount } from '@tiptap/extension-character-count'
import { Placeholder } from '@tiptap/extension-placeholder'
import { EditorContent, Extension, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Check, Focus, ListTree, Search, UserRound, Lock, LocateFixed, Redo2, Save, ShieldCheck, Sparkles, Undo2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LINT_GROUPS, type Character, type CharacterHoverPrefs, type DocumentContent, type DocumentNode, type DocumentTaskTarget, type LocalLintIssue, type ProofreadIssue, type TextPatch } from '../../../shared/domain'
import { textIdentity } from '../../../shared/text-identity'
import { findTextRange, findTextRanges, plainTextRangeToPm } from '../services/prosemirror-range'
import { LIVE_WORD_COUNT_DELAY_MS, liveWordCountOf } from '../services/live-word-count'
import { averageBlockHeight, type BlockMetrics } from '../services/block-height-estimate'
import { SaveCoordinator, type SaveState } from '../services/save-coordinator'
import { BATCH_PROPOSE_LIMIT, LINT_PAGE_SIZE, batchSlice, pageLintGroups } from '../services/lint-drawer-paging'
import { shiftIssuesAfterEdit, type AppliedLocalEdit } from '../services/lint-incremental'
import { longParagraphChunksPlugin } from '../services/long-paragraph-chunks'
import { docEdgeNavigationPlugin, revealDocEdge } from '../services/doc-edge-navigation'
import { revealPos } from '../services/find-highlight'
import { isStaleContent } from '../services/content-adoption'
import { createFrameCoalescer } from '../services/frame-coalescer'
import { syncSelectionToDom } from '../services/select-all-dom-sync'
import { NameMatcher, termsFromCharacters } from '../../../shared/name-matcher'
import { isInHoverBridge } from './hover-bridge'
import { CHARACTERS_CHANGED_EVENT, HOVER_DEGRADE_NOTICE, characterHoverPlugin, hitAt, ignoreHoverAt, isHoverDegraded, setHoverMatcher, type DecoratedHit } from '../services/character-hover'
import { CharacterHoverCard } from './CharacterHoverCard'
import { FindReplacePanel, type FindInitial } from './FindReplacePanel'
import { ChapterHeadingsPanel } from './ChapterHeadingsPanel'

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
  /** F13「全部接受」：按位置逐条接受、后面的按增量偏移重算（方案 c）；整批 1 个快照、1 个事务、1 次写库（PR37 复验 ②）。 */
  applyPatches(patches: TextPatch[]): Promise<{ accepted: number; stale: number }>
}

const issueLabel = (kind: string): string => ({
  repeated_punctuation: '重复标点', ellipsis: '省略号', dash: '破折号', space: '空格', mixed_punctuation: '混合标点',
  quote: '引号', punctuation: '标点', wordlist_replace: '词表替换', wordlist_hint: '词表提示', repeat_char: '重复字', halfwidth: '全半角', typo: '错别字', grammar: '语法', reference: '指代', repetition: '重复', format: '格式'
}[kind] ?? '文字提示')

export function EditorSurface({ node, content, focusMode, onFocusMode, onSaved, onSelection, onRegisterController, onOpenPatches, blackroomLocked = false, onBlackroom, onOpenCharacter, findRequest, onFindRequestDone }: {
  /** 全书查找点击命中：打开章内查找并定位（token 变化才触发）。 */
  findRequest?: FindInitial & { documentId: string; token: number }
  onFindRequestDone?(): void
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
  const [lintShownLimit, setLintShownLimit] = useState(LINT_PAGE_SIZE)
  useEffect(() => { setLintShownLimit(LINT_PAGE_SIZE) }, [localIssues])
  const [longChapter, setLongChapter] = useState(false)
  const blackroomRef = useRef(blackroomLocked)
  blackroomRef.current = blackroomLocked
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

  /** 当前 localIssues 对应的正文哈希；「应用」后增量更新过的提示不用再整章重跑（PR37 复验 ①）。 */
  const issuesTextHash = useRef<string | undefined>(undefined)
  /** applyLocalIssue → onUpdate：这次文档变化是哪条提示的应用。 */
  const pendingLocalEdit = useRef<AppliedLocalEdit | undefined>(undefined)
  const runLocalLint = useCallback(async (text: string, options: { force?: boolean } = {}): Promise<void> => {
    // F13：小黑屋中保存后不跑自动检查（组长决定 3），出屋后重新检查
    if (blackroomRef.current) { issuesTextHash.current = undefined; setLocalIssues([]); return }
    const sourceHash = textIdentity(text)
    if (!options.force && sourceHash === issuesTextHash.current) return
    const result = await window.workspace.linter.run(node.projectId, node.id, text, latestRevision.current)
    if (textIdentity(latestPlainText.current) !== sourceHash || result.skipped) return
    setLongChapter(result.longChapter)
    setLocalIssues(result.issues.map((issue) => ({ ...issue, documentId: node.id, sourceRevision: latestRevision.current })))
    setIgnoredIssues(new Set())
    issuesTextHash.current = sourceHash
  }, [node.id, node.projectId])

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
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hoverCardRef = useRef(hoverCard)
  hoverCardRef.current = hoverCard
  const shortcutRef = useRef<(() => void) | undefined>(undefined)
  const chunkExtension = useMemo(() => Extension.create({ name: 'longParagraphChunks', addProseMirrorPlugins: () => [longParagraphChunksPlugin()] }), [])
  const docEdgeExtension = useMemo(() => Extension.create({ name: 'docEdgeNavigation',
    addProseMirrorPlugins: () => [docEdgeNavigationPlugin({ reveal: (_view, _pos, edge) => { void revealDocEdge(writingPageRef.current?.parentElement, edge) } })] }), [])
  // U03：全选后不管 PM 是否认为选区「没变」，都把当前非空 PM 选区写回 DOM（见 select-all-dom-sync.ts）
  const selectAllExtension = useMemo(() => Extension.create({ name: 'selectAllDomSync', priority: 1000,
    addKeyboardShortcuts() {
      return { 'Mod-a': () => { const handled = this.editor.commands.selectAll(); syncSelectionToDom(this.editor.view); return handled } }
    } }), [])
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
    extensions: [StarterKit, CharacterCount, Placeholder.configure({ placeholder: '从这里开始写……' }), hoverExtension, chunkExtension, docEdgeExtension, selectAllExtension],
    content: content.editorJson,
    editorProps: { attributes: { class: 'manuscript-editor', spellcheck: 'false' } },
    onUpdate: ({ editor: activeEditor }) => {
      const plainText = activeEditor.getText({ blockSeparator: '\n\n' })
      latestPlainText.current = plainText
      // 按键路径只做必要的事：没有提示时不触发重渲染；字数是全文正则（20 万字约 7–17ms），推迟到停顿后再算
      const localEdit = pendingLocalEdit.current
      pendingLocalEdit.current = undefined
      if (localEdit) {
        // 「应用」一条本地建议：只平移受影响的提示（O(条数)），不整章重跑、不清空忽略
        const nextHash = textIdentity(plainText)
        issuesTextHash.current = nextHash
        setLocalIssues((previous) => shiftIssuesAfterEdit(previous, localEdit, nextHash))
      } else {
        issuesTextHash.current = undefined
        setLocalIssues((previous) => previous.length ? [] : previous)
        setIgnoredIssues((previous) => previous.size ? new Set() : previous)
      }
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
    // 按 rAF 合帧，且只在宽度或文档（ProseMirror doc 不可变，引用变即内容变）真的变了时才测
    const coalescer = createFrameCoalescer<{ width: number; doc: unknown }>(() => {
      const dom = viewDom()
      if (!dom || !writingPageRef.current) return undefined
      return { width: dom.clientWidth, doc: editor.state.doc }
    }, measure, (a, b) => a.width === b.width && a.doc === b.doc)
    updateBlockEstimateRef.current = coalescer.schedule
    const observer = new ResizeObserver(() => coalescer.schedule())
    const attach = (): void => { const dom = viewDom(); if (dom) { observer.observe(dom); coalescer.flush() } }
    if (viewDom()) attach(); else editor.on('create', attach)
    return () => { editor.off('create', attach); observer.disconnect(); coalescer.cancel(); updateBlockEstimateRef.current = () => undefined }
  }, [editor, content.documentId, content.revision])

  useEffect(() => {
    const sameDocument = renderedDocumentId.current === content.documentId
    // 同章旧 content（比编辑器已保存的修订号更早）直接忽略：不回滚修订号、不覆盖正文（见 content-adoption.ts）
    if (isStaleContent({ sameDocument, contentRevision: content.revision, editorRevision: coordinator.currentRevision() })) return
    coordinator.resetRevision(content.revision)
    latestRevision.current = content.revision
    latestPlainText.current = content.plainText
    setLiveWordCount(content.wordCount)
    renderedDocumentId.current = content.documentId
    if (!sameDocument) issuesTextHash.current = undefined
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
      },
      applyPatches: async (input) => {
        // PR37 复验 ②：语义仍是「按位置顺序逐条接受，接受一条后后面的按长度变化重算位置」，
        // 但整批：1 次 prepareBatch（1 个 ai_edit 快照 = 批量前原文）→ 1 个编辑器事务（tr.mapping 增量重算位置，
        // 每条都在重算后的位置核对原文，不符的标 stale）→ 1 次保存（1 次写库）→ 1 次 completeBatch。
        // 一个事务 = 一个撤销步：Ctrl+Z 一次回到批量之前。
        const sorted = input.filter((patch) => patch.status === 'proposed' && patch.documentId === node.id).sort((a, b) => a.fromPm - b.fromPm || a.toPm - b.toPm)
        if (!sorted.length) return { accepted: 0, stale: 0 }
        editor.setEditable(false, false)
        try {
          await coordinator.flush()
          const revision = coordinator.currentRevision()
          const doc = editor.state.doc
          const staleIds: string[] = []
          const candidates: TextPatch[] = []
          let lastTo = -1
          for (const patch of sorted) {
            // 与前一条已选区间重叠（前一条接受后它的原文已不在）或越界 → stale，与逐条接受时的结果一致
            if (patch.fromPm < lastTo || patch.toPm > doc.content.size) { staleIds.push(patch.id); continue }
            candidates.push(patch); lastTo = patch.toPm
          }
          const prepared = candidates.length
            ? await window.workspace.patches.prepareBatch({ projectId: node.projectId, documentId: node.id, documentRevision: revision,
              items: candidates.map((patch) => ({ patchId: patch.id, currentText: doc.textBetween(patch.fromPm, patch.toPm, '\n') })) })
            : { ready: [], stale: [] }
          const ready = [...prepared.ready].sort((a, b) => a.fromPm - b.fromPm)
          const acceptedIds: string[] = []
          if (ready.length) {
            pendingStyleSample.current = { origin: 'ai', text: ready.map((patch) => patch.replacement).join('') }
            const applied = editor.chain().command(({ tr, commands }) => {
              for (const patch of ready) {
                const from = tr.mapping.map(patch.fromPm, 1); const to = Math.max(from, tr.mapping.map(patch.toPm, -1))
                if (tr.doc.textBetween(from, to, '\n') !== patch.originalText) { staleIds.push(patch.id); continue }
                if (!commands.insertContentAt({ from, to }, patch.replacement)) { staleIds.push(patch.id); continue }
                acceptedIds.push(patch.id)
              }
              return true
            }).run()
            if (!applied) throw new Error('无法在当前富文本文档中应用提案。')
            if (acceptedIds.length) await coordinator.flush()
            else pendingStyleSample.current = undefined
          }
          await window.workspace.patches.completeBatch({ projectId: node.projectId, savedRevision: coordinator.currentRevision(), acceptedIds, staleIds })
          return { accepted: acceptedIds.length, stale: staleIds.length + prepared.stale.length }
        } finally { editor.setEditable(true, false) }
      }
    }
    onRegisterController(controller)
    return () => { onRegisterController(undefined); coordinator.dispose() }
  }, [coordinator, editor, node.id, node.projectId, onRegisterController])

  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    setHoverMatcher(editor.view, hoverMatcher)
    // F14 B+：匹配器更换（人物/偏好变化）不再无条件关卡。按新装饰在原位置重取命中：
    // 同一 term 仍命中 → 用新命中刷新（人物 ids 以新数据为准，卡片内容由当前 characters 渲染）；否则关闭。
    setHoverCard((previous) => {
      if (!previous) return previous
      const next = hitAt(editor.state, previous.hit.pmFrom)
      if (!next || next.term !== previous.hit.term || next.pmFrom !== previous.hit.pmFrom) return undefined
      return { hit: next, position: previous.position }
    })
    setHoverDegraded(isHoverDegraded(editor.state))
    const onTransaction = (): void => setHoverDegraded(isHoverDegraded(editor.state))
    editor.on('transaction', onTransaction)
    return () => { editor.off('transaction', onTransaction) }
  }, [editor, hoverMatcher])

  useEffect(() => {
    if (!editor) return
    const dom = editor.view.dom as HTMLElement
    const cardAt = (target: HTMLElement): void => {
      const hit = hitAt(editor.state, editor.view.posAtDOM(target, 0))
      if (!hit) return
      const rect = target.getBoundingClientRect()
      setHoverCard({ hit, position: { left: rect.left, top: rect.bottom + 6 } })
    }
    const onOver = (event: MouseEvent): void => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('.character-hit')
      if (!target) return
      if (openTimerRef.current) clearTimeout(openTimerRef.current)
      openTimerRef.current = setTimeout(() => cardAt(target), 300)
    }
    const onOut = (event: MouseEvent): void => {
      const target = (event.target as HTMLElement).closest('.character-hit')
      if (!target || target.contains(event.relatedTarget as Node | null)) return
      if (openTimerRef.current) { clearTimeout(openTimerRef.current); openTimerRef.current = undefined }
      if ((event.relatedTarget as HTMLElement | null)?.closest?.('.character-hover-card')) return
      if (isInHoverBridge(editor.view, hoverCardRef.current?.hit, event.clientX, event.clientY)) return
      setHoverCard(undefined)
    }
    dom.addEventListener('mouseover', onOver)
    dom.addEventListener('mouseout', onOut)
    shortcutRef.current = () => {
      const hit = hitAt(editor.state, editor.state.selection.from)
      if (!hit) return
      const coords = editor.view.coordsAtPos(hit.pmFrom)
      setHoverCard({ hit, position: { left: coords.left, top: coords.bottom + 6 } })
    }
    return () => { if (openTimerRef.current) { clearTimeout(openTimerRef.current); openTimerRef.current = undefined }; dom.removeEventListener('mouseover', onOver); dom.removeEventListener('mouseout', onOut); shortcutRef.current = undefined }
  }, [editor])

  // F14 B+：卡片开着时的离开检测。人物/偏好变化会重建装饰，替换鼠标下的 .character-hit span；
  // 被替换的旧节点已脱离 DOM，之后鼠标移开时 mouseout 冒泡不到 editor dom，上面的 onOut 收不到，卡片就关不掉。
  // 所以卡片打开期间在 document 上看 pointermove：目标既不在命中也不在卡片里就关卡（判定与 onOut 一致：
  // 落在卡片上保留）。卡片关闭或组件卸载时 cleanup 卸掉监听。
  const hoverCardOpen = hoverCard !== undefined
  useEffect(() => {
    if (!hoverCardOpen) return
    const onMove = (event: PointerEvent): void => {
      const target = event.target as HTMLElement | null
      if (target?.closest?.('.character-hit') || target?.closest?.('.character-hover-card')) return
      if (editor && !editor.isDestroyed && isInHoverBridge(editor.view, hoverCardRef.current?.hit, event.clientX, event.clientY)) return
      if (openTimerRef.current) { clearTimeout(openTimerRef.current); openTimerRef.current = undefined }
      setHoverCard(undefined)
    }
    document.addEventListener('pointermove', onMove, true)
    return () => document.removeEventListener('pointermove', onMove, true)
  }, [hoverCardOpen, editor])

  useEffect(() => {
    if (!hoverCard) return
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setHoverCard(undefined) }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [hoverCard])

  // 章内查找替换 / 本章大纲（小黑屋内同样可用：纯本地、无网络）
  const [findMode, setFindMode] = useState<'find' | 'replace' | undefined>()
  const [findFocusToken, setFindFocusToken] = useState(0)
  const [headingsOpen, setHeadingsOpen] = useState(false)
  const scrollerOf = useCallback((): HTMLElement | null => writingPageRef.current?.parentElement ?? null, [])
  const openFind = useCallback((mode: 'find' | 'replace') => { setFindMode(mode); setFindFocusToken((value) => value + 1) }, [])
  // 同步聚焦（tiptap 的 focus 命令延迟一帧，紧接着的 Ctrl+Z 会落到 body 上）
  const closeFind = useCallback(() => { setFindMode(undefined); if (editor && !editor.isDestroyed) editor.view.focus() }, [editor])
  useEffect(() => {
    // Ctrl+Shift+F 留给全书搜索，这里只认不带 Shift 的 Ctrl+F / Ctrl+H
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return
      const key = event.key.toLowerCase()
      if (key !== 'f' && key !== 'h') return
      if ((event.target as HTMLElement | null)?.closest?.('[role="dialog"]')) return
      event.preventDefault()
      openFind(key === 'h' ? 'replace' : 'find')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openFind])
  useEffect(() => { setFindMode(undefined) }, [node.id])
  const [findInitial, setFindInitial] = useState<(FindInitial & { token: number }) | undefined>()
  useEffect(() => {
    if (!findRequest || findRequest.documentId !== node.id) return
    setFindInitial(findRequest); openFind('find'); onFindRequestDone?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只按 token 触发
  }, [findRequest?.token, node.id])

  // 出屋后重新检查（屋内不跑自动检查）
  const wasLocked = useRef(blackroomLocked)
  useEffect(() => {
    if (wasLocked.current && !blackroomLocked) void runLocalLint(latestPlainText.current)
    wasLocked.current = blackroomLocked
  }, [blackroomLocked, runLocalLint])

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
    pendingLocalEdit.current = { issueId: issue.id, from: issue.from, to: issue.to, replacementLength: issue.replacement.length }
    if (!editor.chain().focus().insertContentAt(range, issue.replacement).run()) { pendingLocalEdit.current = undefined; throw new Error('无法应用校对建议。') }
    pendingLocalEdit.current = undefined
    await coordinator.flush()
  }

  const jumpToLocalIssue = (issue: LocalLintIssue): void => {
    if (!editor) return
    const range = plainTextRangeToPm(editor.state.doc, issue.from, issue.to)
    if (!range) return
    // 不用 ProseMirror 的 scrollIntoView（tiptap focus 默认也会下一帧 scrollIntoView）：分块超长段上会卡死，改用 revealPos 瞬时滚动
    editor.chain().focus(null, { scrollIntoView: false }).setTextSelection(range).run()
    void revealPos(editor.view, scrollerOf(), range.from)
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

  const visibleLocalIssues = useMemo(() => localIssues.filter((issue) => !ignoredIssues.has(issue.id)), [localIssues, ignoredIssues])
  const groupedIssues = useMemo(() => LINT_GROUPS.map((group) => ({ group, issues: visibleLocalIssues.filter((issue) => (issue.group ?? 'punctuation') === group) })).filter((item) => item.issues.length > 0), [visibleLocalIssues])
  /** L2：抽屉只渲染前 lintShownLimit 条，点「更多」再加载下一批。 */
  const pagedIssues = useMemo(() => pageLintGroups(groupedIssues, lintShownLimit), [groupedIssues, lintShownLimit])
  const shownIssueCount = Math.min(lintShownLimit, visibleLocalIssues.length)
  const batchGroups = useMemo(() => {
    const map = new Map<string, LocalLintIssue[]>()
    for (const issue of visibleLocalIssues) {
      if (issue.group !== 'wordlist_replace' || !issue.replacement) continue
      const key = issue.ruleKey ?? issue.originalText; const list = map.get(key); if (list) list.push(issue); else map.set(key, [issue])
    }
    return [...map.values()].filter((items) => items.length > 1)
  }, [visibleLocalIssues])
  // 抽屉里「原文」整页只取一次正文，避免每条提示各自 getText（上万条时是 O(条数 × 字数)）
  /** 关闭校对：「定位」留下的选区折叠到其末尾（光标落在定位词之后），避免接着打字把原词替换掉。 */
  const closeProofread = (): void => {
    setProofreadOpen(false)
    if (editor && !editor.isDestroyed && !editor.state.selection.empty) editor.chain().focus().setTextSelection(editor.state.selection.to).run()
  }
  const drawerText = proofreadOpen ? (editor?.getText({ blockSeparator: '\n\n' }) ?? '') : ''

  const ignoreHere = async (issue: LocalLintIssue): Promise<void> => {
    setIgnoredIssues((current) => new Set(current).add(issue.id))
    if (issue.ruleKey && issue.occurrence) await window.workspace.lint.ignore(node.projectId, { documentId: node.id, ruleKey: issue.ruleKey, originalText: issue.originalText, occurrence: issue.occurrence })
  }
  /** 「忽略这条规则（本作品）」：词表 = 作品级 `!词`；其余规则 = 本作品关闭这一类。 */
  const ignoreRule = async (issue: LocalLintIssue): Promise<void> => {
    if (issue.ruleKey?.startsWith('wordlist:')) await window.workspace.lint.disableTerm(node.projectId, issue.ruleKey.slice('wordlist:'.length))
    else {
      const rules = await window.workspace.lint.rules(node.projectId)
      const group = issue.group ?? 'punctuation'
      await window.workspace.lint.setRules(node.projectId, { ...rules, ...(group === 'repeat_char' ? { repeatChar: false } : group === 'halfwidth' ? { halfwidth: false } : { punctuation: false }) })
    }
    await runLocalLint(latestPlainText.current, { force: true })
  }
  /** 本章批量应用：一律生成修改提案（D4），接受前正文不变。 */
  const proposeBatch = async (items: LocalLintIssue[]): Promise<void> => {
    if (!editor) return
    await coordinator.flush()
    if (items.length > BATCH_PROPOSE_LIMIT) throw new Error(`单次批量应用最多 ${BATCH_PROPOSE_LIMIT} 处。`)
    const plainText = editor.getText({ blockSeparator: '\n\n' })
    const currentHash = textIdentity(plainText)
    if (items.some((issue) => currentHash !== issue.sourceTextHash)) throw new Error('正文已变化，请重新检查后再批量应用。')
    const revision = coordinator.currentRevision()
    for (const issue of items) {
      const range = plainTextRangeToPm(editor.state.doc, issue.from, issue.to)
      if (!range || editor.state.doc.textBetween(range.from, range.to, '\n\n') !== issue.originalText) throw new Error('原文位置已经变化，请重新检查。')
      await window.workspace.patches.propose({ projectId: node.projectId, documentId: node.id, documentRevision: revision, fromPm: range.from, toPm: range.to, originalText: issue.originalText, replacement: issue.replacement! })
    }
    setProofreadOpen(false)
    onOpenPatches()
  }
  const reportLocal = (task: Promise<void>): void => { void task.catch((error) => setProofreadError(error instanceof Error ? error.message : String(error))) }
  return <section className={focusMode ? 'editor-pane focus-mode' : 'editor-pane'}>
    <div className="editor-toolbar">
      <button className="icon-button" title="撤销" aria-label="撤销" onClick={() => editor?.chain().focus().undo().run()}><Undo2 size={17} /></button>
      <button className="icon-button" title="重做" aria-label="重做" onClick={() => editor?.chain().focus().redo().run()}><Redo2 size={17} /></button><span className="toolbar-separator" />
      <button className={editor?.isActive('bold') ? 'toolbar-button active' : 'toolbar-button'} onClick={() => editor?.chain().focus().toggleBold().run()}>粗体</button>
      {!blackroomLocked && <button className="toolbar-button" onClick={() => setProofreadOpen(true)}><ShieldCheck size={16} />校对{visibleLocalIssues.length > 0 ? ` ${visibleLocalIssues.length}` : ''}</button>}
      {!blackroomLocked && <button className="toolbar-button" onClick={() => onFocusMode(!focusMode)}><Focus size={16} />专注</button>}
      {!blackroomLocked && onBlackroom && <button className="toolbar-button" onClick={onBlackroom}><Lock size={16} />小黑屋</button>}
      <button className="toolbar-button" title="章内查找（Ctrl+F）/ 替换（Ctrl+H）" onClick={() => openFind('find')}><Search size={16} />查找</button>
      <button className={headingsOpen ? 'toolbar-button active' : 'toolbar-button'} aria-pressed={headingsOpen} title="本章标题与场景分隔" onClick={() => setHeadingsOpen((open) => !open)}><ListTree size={16} />章内大纲</button>
      <button className={hoverPrefs?.enabled ? 'toolbar-button active' : 'toolbar-button'} aria-pressed={Boolean(hoverPrefs?.enabled)} title="悬停人名显示只读人物卡" disabled={!hoverPrefs}
        onClick={() => { if (hoverPrefs) void saveHoverPrefs({ ...hoverPrefs, enabled: !hoverPrefs.enabled }) }}><UserRound size={16} />人物悬停</button>
      <span className="toolbar-spacer" /><span className={`save-indicator ${saveState}`} title={saveError}><Save size={14} />{saveState === 'saved' ? '已保存' : saveState === 'dirty' ? '等待保存' : saveState === 'saving' ? '保存中' : '保存失败，内容仍保留'}</span>
    </div>
    {saveError && <div className="save-error" role="alert">{saveError}</div>}
    <div className="writing-scroll"><article className="writing-page" ref={writingPageRef}><h1>{node.title}</h1><EditorContent editor={editor} /></article></div>
    {editor && findMode && <FindReplacePanel key={`${node.id}:${findInitial?.token ?? 0}`} initial={findInitial} editor={editor} mode={findMode} focusToken={findFocusToken} scroller={scrollerOf} onMode={openFind} onClose={closeFind} />}
    {editor && headingsOpen && <ChapterHeadingsPanel key={node.id} editor={editor} scroller={scrollerOf} onClose={() => setHeadingsOpen(false)} />}
    <div className="editor-status"><span>{liveWordCount.toLocaleString()} 字</span>{visibleLocalIssues.length > 0 && <button className="proofread-count" onClick={() => setProofreadOpen(true)}>{visibleLocalIssues.length} 条校对提示</button>}{hoverDegraded && hoverPrefs?.enabled && <span className="hover-degraded" data-testid="hover-degraded">{HOVER_DEGRADE_NOTICE}</span>}</div>
    {hoverCard && <CharacterHoverCard term={hoverCard.hit.term} position={hoverCard.position} showOpenLink={!blackroomLocked && Boolean(onOpenCharacter)}
      characters={hoverCard.hit.characterIds.map((id) => characters.find((item) => item.id === id)).filter((item): item is Character => Boolean(item))}
      onOpen={(id) => { setHoverCard(undefined); onOpenCharacter?.(id) }}
      onIgnoreTerm={() => { const { hit } = hoverCard; setHoverCard(undefined); if (hoverPrefs) void saveHoverPrefs({ ...hoverPrefs, ignoredTerms: [...hoverPrefs.ignoredTerms, ...hit.characterIds.map((characterId) => ({ characterId, term: hit.term }))] }) }}
      onIgnoreHere={() => { const { hit } = hoverCard; setHoverCard(undefined); if (editor) ignoreHoverAt(editor.view, { from: hit.pmFrom, to: hit.pmTo }) }}
      onMouseEnter={() => undefined} onMouseLeave={() => setHoverCard(undefined)} />}
    {proofreadOpen && !blackroomLocked && <aside className="proofread-drawer" aria-label="校对结果">
      <header><div><h2>校对</h2><p>本地规则可直接修正；AI 建议会先进入修改提案。</p></div><button className="icon-button" aria-label="关闭校对" onClick={closeProofread}><X size={18} /></button></header>
      <div className="proofread-actions"><button onClick={() => void runLocalLint(editor?.getText({ blockSeparator: '\n\n' }) ?? '', { force: true })}>重新检查本地规则</button><button className="primary" disabled={proofreadBusy} onClick={() => void runAiProofread()}><Sparkles size={15} />{proofreadBusy ? 'AI 校对中…' : '运行 AI 校对'}</button></div>
      {proofreadError && <div className="inline-error" role="alert">{proofreadError}</div>}
      <section data-testid="local-lint"><h3>本地规则 <span>{visibleLocalIssues.length}</span></h3>
        {longChapter && <p className="empty-copy" role="status">章节过长，词表检查请手动运行（只检查了标点）。</p>}
        {batchGroups.map((all) => { const batch = batchSlice(all); return <div key={all[0].ruleKey} className="proofread-actions"><button className="primary" onClick={() => reportLocal(proposeBatch(batch.items))}>本章批量应用「{all[0].originalText}→{all[0].replacement}」（{batch.remaining > 0 ? `前 ${batch.items.length} 处 / 共 ${batch.total} 处` : `${batch.total} 处`}，生成修改提案）</button>{batch.remaining > 0 && <p className="empty-copy" role="status" data-testid="batch-limit-notice" data-rule={all[0].ruleKey ?? all[0].originalText}>「{all[0].originalText}→{all[0].replacement}」单次最多 {BATCH_PROPOSE_LIMIT} 处：本次只为前 {batch.items.length} 处生成提案，其余 {batch.remaining} 处请处理完后重新检查再批量应用。</p>}</div> })}
        {visibleLocalIssues.length === 0 ? <p className="empty-copy">暂未发现明确的标点或空格问题。</p> : <>{visibleLocalIssues.length > shownIssueCount && <p className="empty-copy" role="status" data-testid="lint-page-status">共 {visibleLocalIssues.length} 条，已显示前 {shownIssueCount} 条</p>}{pagedIssues.map(({ group, total, issues }) => <div key={group} className="lint-group" data-group={group}><h4>{issueLabel(group === 'punctuation' ? 'punctuation' : group)} <span>{total}</span></h4>{issues.map((issue) => <article key={issue.id} className="proofread-issue"><span>{issueLabel(issue.kind)}</span><p>{issue.message}</p><small>原文：{drawerText.slice(issue.from, issue.to)}</small>{issue.replacement && <ins>建议：{issue.replacement}</ins>}<div><button onClick={() => jumpToLocalIssue(issue)}><LocateFixed size={14} />定位</button><button onClick={() => reportLocal(ignoreHere(issue))}>忽略这一处</button><button onClick={() => reportLocal(ignoreRule(issue))}>{issue.ruleKey?.startsWith('wordlist:') ? '本作品不再提示此词' : '本作品关闭此类'}</button>{issue.replacement && <button className="primary" onClick={() => reportLocal(applyLocalIssue(issue))}><Check size={14} />应用</button>}</div></article>)}</div>)}{visibleLocalIssues.length > shownIssueCount && <div className="proofread-actions"><button onClick={() => setLintShownLimit((limit) => limit + LINT_PAGE_SIZE)}>更多（再显示 {Math.min(LINT_PAGE_SIZE, visibleLocalIssues.length - shownIssueCount)} 条，剩余 {visibleLocalIssues.length - shownIssueCount} 条）</button></div>}</>}</section>
      <section><h3>AI 校对 <span>{aiIssues.length}</span></h3>{aiIssues.length === 0 ? <p className="empty-copy">{aiProofreadRan ? 'AI 未发现需要处理的明确问题。' : '运行后，建议会先进入修改提案，不会直接改写正文。'}</p> : aiIssues.map((issue) => <article key={issue.id} className="proofread-issue"><span>{issueLabel(issue.category)}</span><p>{issue.reason}</p><small>原文：{issue.originalText}</small>{issue.suggestion && <ins>建议：{issue.suggestion}</ins>}<div><button className="primary" disabled={!issue.suggestion} onClick={() => void createProofreadPatch(issue).catch((error) => setProofreadError(error instanceof Error ? error.message : String(error)))}>加入修改提案</button></div></article>)}</section>
    </aside>}
  </section>
}
