import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { EditorState } from '@tiptap/pm/state'
import { NameMatcher, termsFromCharacters } from '../src/shared/name-matcher'
import { applyHover, blockMatchText, characterHoverKey, characterHoverPlugin, hitAt, hitsInRange, shouldDegrade, type CharacterHoverMeta } from '../src/renderer/src/services/character-hover'

const schema = getSchema([StarterKit])
const docOf = (paragraphs: string[]) => schema.node('doc', null, paragraphs.map((text) => schema.node('paragraph', null, text ? [schema.text(text)] : [])))
const matcher = new NameMatcher(termsFromCharacters([{ id: 'c1', name: '林栀', aliases: ['阿栀'] }, { id: 'c2', name: '顾言', aliases: [] }]))
const stateWith = (paragraphs: string[]) => {
  let state = EditorState.create({ schema, doc: docOf(paragraphs), plugins: [characterHoverPlugin()] })
  state = state.apply(state.tr.setMeta(characterHoverKey, { type: 'setMatcher', matcher } satisfies CharacterHoverMeta))
  return state
}
const decos = (state: EditorState) => characterHoverKey.getState(state)!.decorations.find().map((item) => state.doc.textBetween(item.from, item.to))

describe('F14 悬停插件（只加 Decoration，不改文档）', () => {
  it('全章装饰命中，位置对应原文；hardBreak 等叶子节点占 1 位', () => {
    const state = stateWith(['林栀来了。', '顾言和阿栀'])
    expect(decos(state)).toEqual(['林栀', '顾言', '阿栀'])
    const withBreak = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('甲'), schema.node('hardBreak'), schema.text('林栀')])])
    expect(blockMatchText(withBreak.child(0))).toBe('甲\uFFFC林栀')
    const [hit] = hitsInRange(withBreak, matcher)
    expect(withBreak.textBetween(hit.pmFrom, hit.pmTo)).toBe('林栀')
  })

  it('编辑后先映射旧装饰，recompute 只重算改动段落 ±1；文档本身不被插件改动', () => {
    let state = stateWith(['林栀', '空', '空', '顾言'])
    const before = state.doc
    state = state.apply(state.tr.insertText('阿栀', 1))
    expect(characterHoverKey.getState(state)!.dirty.length).toBeGreaterThan(0)
    expect(decos(state)).toEqual(['林栀', '顾言'])
    const docBefore = state.doc
    state = state.apply(state.tr.setMeta(characterHoverKey, { type: 'recompute' }))
    expect(state.doc).toBe(docBefore)
    expect(decos(state)).toEqual(['阿栀', '林栀', '顾言'])
    expect(before.textContent).toBe('林栀空空顾言')
  })

  it('忽略此处只去掉这一处，且随编辑映射；Ctrl+Shift+K 的 hitAt', () => {
    let state = stateWith(['林栀和林栀'])
    expect(hitAt(state, 2)?.characterIds).toEqual(['c1'])
    state = state.apply(state.tr.setMeta(characterHoverKey, { type: 'ignoreAt', range: { from: 1, to: 3 } }))
    expect(decos(state)).toEqual(['林栀'])
    expect(hitAt(state, 2)).toBeUndefined()
    state = state.apply(state.tr.insertText('前', 1))
    state = state.apply(state.tr.setMeta(characterHoverKey, { type: 'recompute' }))
    expect(characterHoverKey.getState(state)!.ignored).toEqual([{ from: 2, to: 4 }])
    expect(decos(state)).toEqual(['林栀'])
  })

  it('降级：> 200000 字或全章 > 50ms；降级后只装饰可见区间附近', () => {
    expect(shouldDegrade(200_001, 1)).toBe(true)
    expect(shouldDegrade(1000, 51)).toBe(true)
    expect(shouldDegrade(200_000, 50)).toBe(false)
    const paragraphs = Array.from({ length: 2100 }, (_, i) => `${i}林栀${'雾'.repeat(95)}`)
    let state = stateWith(paragraphs)
    const plugin = characterHoverKey.getState(state)!
    expect(plugin.degraded).toBe(true)
    expect(plugin.decorations.find().length).toBeLessThan(2100)
    state = state.apply(state.tr.setMeta(characterHoverKey, { type: 'viewport', range: { from: 100_000, to: 101_000 } }))
    const visible = characterHoverKey.getState(state)!.decorations.find()
    expect(visible.length).toBeGreaterThan(0)
    expect(visible.every((item) => item.from > 99_000 && item.to < 102_500)).toBe(true)
  })

  it('关闭（matcher = null）清空装饰', () => {
    let state = stateWith(['林栀'])
    state = state.apply(state.tr.setMeta(characterHoverKey, { type: 'setMatcher', matcher: null }))
    expect(decos(state)).toEqual([])
  })

  it('applyHover 对无关事务不改状态', () => {
    const state = stateWith(['林栀'])
    const plugin = characterHoverKey.getState(state)!
    expect(applyHover(plugin, state.tr, state.doc)).toBe(plugin)
  })
})
