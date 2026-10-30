import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { docEdgeNavigationPlugin, docEdgeOf, docEdgeSelection } from '../src/renderer/src/services/doc-edge-navigation'

const schema = getSchema([StarterKit])
const long = '林舟在会上说，他慢慢地看。'.repeat(600)
const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('开头')]), schema.node('paragraph', null, [schema.text(long.slice(0, 3000)), schema.text(long.slice(3000, 3400), [schema.mark('bold')]), schema.text(long.slice(3400))])])
const ev = (init: { key: string; ctrlKey?: boolean; shiftKey?: boolean }) => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init }) as unknown as KeyboardEvent
const key = (key: string, extra: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra })

describe('PR45 Ctrl+Home/End 由编辑器处理（不走 Chromium 原生光标移动）', () => {
  it('只认 Ctrl/Cmd+Home/End，带 Alt 或不带修饰键不处理', () => {
    expect(docEdgeOf(key('End', { ctrlKey: true }))).toBe('end')
    expect(docEdgeOf(key('Home', { metaKey: true }))).toBe('start')
    expect(docEdgeOf(key('End', { ctrlKey: true, shiftKey: true }))).toBe('end')
    expect(docEdgeOf(key('End'))).toBeUndefined()
    expect(docEdgeOf(key('End', { ctrlKey: true, altKey: true }))).toBeUndefined()
    expect(docEdgeOf(key('a', { ctrlKey: true }))).toBeUndefined()
  })

  it('文末/文首：折叠选区；Shift 保留锚点扩选', () => {
    const state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 3) })
    const end = docEdgeSelection(doc, state.selection, 'end', false)
    expect(end.empty).toBe(true); expect(end.head).toBe(doc.content.size - 1)
    expect(docEdgeSelection(doc, state.selection, 'start', false).head).toBe(1)
    const extended = docEdgeSelection(doc, state.selection, 'end', true)
    expect(extended.anchor).toBe(3); expect(extended.head).toBe(doc.content.size - 1)
  })

  it('插件：Ctrl+End 一次事务设选区并按目标位置滚动；关闭时交回默认处理', () => {
    const revealed: number[] = []
    let enabled = true
    const plugin = docEdgeNavigationPlugin({ reveal: (_view, pos) => revealed.push(pos), enabled: () => enabled })
    let state = EditorState.create({ schema, doc, plugins: [plugin] })
    const dispatched: Transaction[] = []
    const view = { get state() { return state }, dispatch: (tr: Transaction) => { dispatched.push(tr); state = state.apply(tr) } } as unknown as EditorView
    const handle = plugin.props.handleKeyDown!.bind(plugin)
    expect(handle(view, ev({ key: 'End', ctrlKey: true }))).toBe(true)
    expect(dispatched).toHaveLength(1)
    expect(state.selection.head).toBe(doc.content.size - 1)
    expect(revealed).toEqual([doc.content.size - 1])
    expect(handle(view, ev({ key: 'Home', ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(state.selection.anchor).toBe(doc.content.size - 1); expect(state.selection.head).toBe(1)
    expect(handle(view, ev({ key: 'End' }))).toBe(false)
    enabled = false
    expect(handle(view, ev({ key: 'End', ctrlKey: true }))).toBe(false)
    expect(dispatched).toHaveLength(2)
  })
})
