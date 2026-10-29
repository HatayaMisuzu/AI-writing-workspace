import { describe, expect, it } from 'vitest'
import { createTestDb } from './helpers'
import { ProjectService } from '../src/main/services/project-service'
import { readHoverPrefs, writeHoverPrefs } from '../src/main/services/hover-prefs-service'
import { hoverPrefsSchema } from '../src/main/ipc/schemas'

const setup = () => {
  const db = createTestDb()
  const project = new ProjectService(db).create({ title: '雾港', projectType: 'novel' })
  const raw = () => db.raw.prepare('SELECT settings_json, updated_at FROM projects WHERE id = ?').get(project.id) as { settings_json: string; updated_at: number }
  return { db, project, raw }
}

describe('F14 悬停偏好（settings_json，无迁移）', () => {
  it('默认：总开关开启，忽略/单字列表为空', () => {
    const { db, project } = setup()
    expect(readHoverPrefs(db, project.id)).toEqual({ enabled: true, ignoredTerms: [], enabledSingleTerms: [] })
  })

  it('⑦ 数据损坏视为空集（整个 JSON 坏 / 字段类型坏 / 单项坏）', () => {
    const { db, project } = setup()
    for (const bad of ['{not json', '[]', JSON.stringify({ hoverIgnoredTerms: 'x', hoverEnabledSingleTerms: { a: 1 }, characterHover: 'no' }),
      JSON.stringify({ hoverIgnoredTerms: [1, null, { characterId: 'a' }] })]) {
      db.raw.prepare('UPDATE projects SET settings_json = ? WHERE id = ?').run(bad, project.id)
      expect(readHoverPrefs(db, project.id)).toEqual({ enabled: true, ignoredTerms: [], enabledSingleTerms: [] })
    }
  })

  it('写入只改三个键，保留其他设置（如小黑屋状态），不改 updated_at', () => {
    const { db, project, raw } = setup()
    db.raw.prepare('UPDATE projects SET settings_json = ? WHERE id = ?').run(JSON.stringify({ focusLock: { keep: 1 }, other: 'x' }), project.id)
    const before = raw().updated_at
    const saved = writeHoverPrefs(db, project.id, { enabled: false, ignoredTerms: [{ characterId: 'c1', term: '阿栀' }], enabledSingleTerms: [{ characterId: 'c1', term: '栀' }] })
    expect(saved).toEqual({ enabled: false, ignoredTerms: [{ characterId: 'c1', term: '阿栀' }], enabledSingleTerms: [{ characterId: 'c1', term: '栀' }] })
    const settings = JSON.parse(raw().settings_json)
    expect(settings.focusLock).toEqual({ keep: 1 })
    expect(settings.other).toBe('x')
    expect(raw().updated_at).toBe(before)
  })

  it('IPC schema 拒绝多余字段、空 term、超长列表', () => {
    expect(() => hoverPrefsSchema.parse({ enabled: true, ignoredTerms: [{ characterId: 'a', term: ' ' }], enabledSingleTerms: [] })).toThrow()
    expect(() => hoverPrefsSchema.parse({ enabled: true, ignoredTerms: [], enabledSingleTerms: [], x: 1 })).toThrow()
    expect(() => hoverPrefsSchema.parse({ enabled: true, ignoredTerms: Array.from({ length: 10_001 }, () => ({ characterId: 'a', term: 'b' })), enabledSingleTerms: [] })).toThrow()
  })

  it('不存在的作品报错', () => {
    const { db } = setup()
    expect(() => readHoverPrefs(db, 'nope')).toThrow('PROJECT_NOT_FOUND')
  })
})
