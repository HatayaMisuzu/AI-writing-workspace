import { describe, expect, it } from 'vitest'
import { LIVE_WORD_COUNT_DELAY_MS, liveWordCountOf } from '../src/renderer/src/services/live-word-count'

describe('按键性能：状态栏字数推迟到停顿后计算', () => {
  it('计数规则与原先逐键计算一致（汉字 + 英文/数字词）', () => {
    expect(liveWordCountOf('林栀推门进来，Ann 说 hello 42。')).toBe(7 + 3)
    expect(liveWordCountOf('')).toBe(0)
  })
  it('停顿阈值 300ms', () => { expect(LIVE_WORD_COUNT_DELAY_MS).toBe(300) })
})
