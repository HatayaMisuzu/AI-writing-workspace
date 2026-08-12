import { describe, expect, it } from 'vitest'
import { localMemoryIntent, shouldRunMemoryIntent } from '../src/main/ai/memory-intent'
import { MemoryIntentRunner } from '../src/main/ai/memory-intent'
import { ProviderService } from '../src/main/ai/provider'
import { ProjectService } from '../src/main/services/project-service'
import { createTestDb, testCodec } from './helpers'

describe('memory intent semantics', () => {
  it.each([
    ['记一下：林夏害怕密闭空间。', true],
    ['就这么定，林夏以前认识周青，这个记一下。', true],
    ['以后按这个设定：钥匙是假的。', true],
    ['确认采用第一种方案，记住。', true],
    ['不要记，林夏可能害怕密闭空间。', false],
    ['林夏会不会害怕密闭空间？', false],
    ['她说“记住我”，然后关上门。', false],
    ['先别定，只是想想。', false]
  ])('%s => %s', (text, expected) => expect(shouldRunMemoryIntent(text)).toBe(expected))

  it('creates suggested records only after an explicit author command', async () => {
    const db = createTestDb(); const project = new ProjectService(db).create({ title: '记忆', projectType: 'novel' })
    const runner = new MemoryIntentRunner(db, new ProviderService(db, testCodec))
    const proposals = await runner.extractAndCreate(project.id, 'chat-1', '记一下：林夏害怕密闭空间。')
    expect(proposals).toHaveLength(1); expect(proposals[0]).toMatchObject({ status: 'suggested', type: 'character_state' })
    expect(localMemoryIntent('不要记：林夏怕黑。').proposals).toHaveLength(0)
  })

  it.each([
    ['记一下：人物害怕电梯。', 'character_state'],
    ['记一下：两人是姐妹。', 'relationship'],
    ['记一下：第三章离开城市。', 'event'],
    ['确认采用：第一方案，记住。', 'decision']
  ])('classifies %s as %s', (text, type) => expect(localMemoryIntent(text).proposals[0]?.type).toBe(type))
})
