import { describe, expect, it } from 'vitest'
import { createTestDb } from './helpers'
import { ProjectService } from '../src/main/services/project-service'
import { MemoryService } from '../src/main/services/memory-service'

describe('discussion to memory proposal', () => {
  it('does not confirm or propose ordinary brainstorming', () => {
    const db = createTestDb(); const project = new ProjectService(db).create({ title: '记忆', projectType: 'novel' }); const service = new MemoryService(db)
    expect(service.proposeFromChat(project.id, 'msg-1', '要不要 A 是凶手？')).toBeNull()
    expect(service.list(project.id).filter((item) => item.status === 'confirmed')).toHaveLength(0)
  })

  it('creates only suggested for explicit save intent and requires user confirmation', () => {
    const db = createTestDb(); const project = new ProjectService(db).create({ title: '记忆', projectType: 'novel' }); const service = new MemoryService(db)
    const proposal = service.proposeFromChat(project.id, 'msg-2', '就这么定，A 是凶手，记一下。')!
    expect(proposal).toMatchObject({ status: 'suggested', sourceType: 'chat', sourceId: 'msg-2' })
    expect(service.list(project.id).filter((item) => item.status === 'confirmed')).toHaveLength(0)
    expect(service.confirm(project.id, proposal.id, 'user')).toMatchObject({ status: 'confirmed', sourceType: 'chat', sourceId: 'msg-2' })
  })
})
