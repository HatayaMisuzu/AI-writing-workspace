// 编辑器 content 采纳判定（isStaleContent）的纯函数单测
import { describe, expect, it } from 'vitest'
import { isStaleContent } from '../src/renderer/src/services/content-adoption'

describe('同章旧 content 不回滚编辑器', () => {
  it('同一章、content 修订号落后于编辑器 → 过时', () => {
    expect(isStaleContent({ sameDocument: true, contentRevision: 2, editorRevision: 3 })).toBe(true)
  })
  it('修订号相同或更新（保存回执、历史恢复）→ 采用', () => {
    expect(isStaleContent({ sameDocument: true, contentRevision: 3, editorRevision: 3 })).toBe(false)
    expect(isStaleContent({ sameDocument: true, contentRevision: 5, editorRevision: 3 })).toBe(false)
  })
  it('切换章节时总是采用', () => {
    expect(isStaleContent({ sameDocument: false, contentRevision: 1, editorRevision: 9 })).toBe(false)
  })
})
