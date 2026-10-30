import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { displayProjectTitle, UNTITLED_PROJECT_TITLE } from '../src/renderer/src/services/project-title'
import { userErrorMessage } from '../src/shared/user-error'

const read = (path: string): string => readFileSync(join(__dirname, '..', path), 'utf8')

describe('空书名显示「未命名作品」', () => {
  it('空、空白、null 显示占位，其余原样', () => {
    expect(displayProjectTitle('')).toBe(UNTITLED_PROJECT_TITLE)
    expect(displayProjectTitle(' \u3000\n')).toBe('未命名作品')
    expect(displayProjectTitle(undefined)).toBe('未命名作品')
    expect(displayProjectTitle(' 雾港 ')).toBe(' 雾港 ')
  })
  it('书库、侧栏、作品栏、检索、小黑屋提示都走 displayProjectTitle', () => {
    for (const file of ['src/renderer/src/screens/LibraryScreen.tsx', 'src/renderer/src/components/ProjectSidebar.tsx', 'src/renderer/src/components/WorksRail.tsx', 'src/renderer/src/screens/WorkspaceScreen.tsx', 'src/renderer/src/components/Blackroom.tsx', 'src/renderer/src/screens/PromptTemplatesView.tsx']) {
      expect(read(file), file).toContain('displayProjectTitle(')
    }
    expect(read('src/renderer/src/screens/LibraryScreen.tsx')).not.toMatch(/<strong>\{project\.title\}<\/strong>/)
  })
})

describe('AssistantPanel 记忆提案处理失败走 userErrorMessage', () => {
  it('确认/驳回失败不再吐原始 error.message', () => {
    const source = read('src/renderer/src/components/AssistantPanel.tsx')
    expect(source).toContain('记忆提案处理失败：${userErrorMessage(error)}')
    expect(source).not.toMatch(/记忆提案[^`]*失败：\$\{error instanceof Error/)
    expect(userErrorMessage(new Error("Error invoking remote method 'memories:confirm': Error: 提案已失效"))).toBe('提案已失效')
  })
})

describe('关闭校对折叠「定位」留下的选区', () => {
  it('关闭按钮走 closeProofread，折叠到选区末尾', () => {
    const source = read('src/renderer/src/components/EditorSurface.tsx')
    expect(source).toContain('aria-label="关闭校对" onClick={closeProofread}')
    expect(source).toContain('setTextSelection(editor.state.selection.to)')
  })
})

describe('小修⑥ 重命名后同步大标题', async () => {
  const { syncSelectedTitle } = await import('../src/renderer/src/services/selected-node')
  const node = { id: 'c1', title: '旧名' } as never as import('../src/shared/domain').DocumentNode
  it('树里同 id 标题变了 → 返回新标题；没变/找不到/未选中 → 原样', () => {
    expect(syncSelectedTitle(node, [{ ...node, title: '新名' }])?.title).toBe('新名')
    expect(syncSelectedTitle(node, [node])).toBe(node)
    expect(syncSelectedTitle(node, [])).toBe(node)
    expect(syncSelectedTitle(undefined, [node])).toBeUndefined()
  })
  it('WorkspaceScreen 在 updateNode 刷新树后同步 selected', () => {
    expect(read('src/renderer/src/screens/WorkspaceScreen.tsx')).toContain('setSelected((current) => syncSelectedTitle(current, nextTree))')
  })
})

describe('小修⑦ 窄侧栏样式', () => {
  it('行网格给徽标留 auto 列，徽标不折行不收缩，标题省略号', () => {
    const css = read('src/renderer/src/styles.css')
    expect(css).toContain('grid-template-columns: minmax(0, 1fr) auto 26px 26px')
    expect(css).toMatch(/\.chapter-status-badge \{[^}]*flex-shrink: 0;[^}]*white-space: nowrap;/)
    expect(css).toMatch(/\.chapter-title \{[^}]*text-overflow: ellipsis/)
    expect(css).toMatch(/\.chapter-open \{[^}]*min-width: 0/)
  })
})
