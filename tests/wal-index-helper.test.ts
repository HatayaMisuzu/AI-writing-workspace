import { describe, expect, it } from 'vitest'
import { parseShmHeader, parseWalHeader, walChecksum } from './helpers/wal-index'

function walHeader(ckptSeq = 7, salt1 = 0x11223344, salt2 = 0x55667788): Buffer {
  const b = Buffer.alloc(32)
  b.writeUInt32BE(0x377f0682, 0); b.writeUInt32BE(3007000, 4); b.writeUInt32BE(4096, 8)
  b.writeUInt32BE(ckptSeq, 12); b.writeUInt32BE(salt1, 16); b.writeUInt32BE(salt2, 20)
  const [c1, c2] = walChecksum(b.subarray(0, 24), false)
  b.writeUInt32BE(c1, 24); b.writeUInt32BE(c2, 28)
  return b
}
function shmHeader(mxFrame = 29, nBackfill = 0): Buffer {
  const b = Buffer.alloc(136)
  b.writeUInt32LE(3007000, 0); b.writeUInt32LE(5, 8); b[12] = 1; b.writeUInt16LE(4096, 14)
  b.writeUInt32LE(mxFrame, 16); b.writeUInt32LE(100, 20); b.writeUInt32LE(0xaabbccdd, 32); b.writeUInt32LE(0x01020304, 36)
  const [c1, c2] = walChecksum(b.subarray(0, 40), false)
  b.writeUInt32LE(c1, 40); b.writeUInt32LE(c2, 44)
  b.copy(b, 48, 0, 48)
  b.writeUInt32LE(nBackfill, 96); b.writeUInt32LE(nBackfill, 128)
  return b
}

describe('wal-index helper：SQLite -wal / -shm 头解析', () => {
  it('合法 -wal 头 → ckptSeq / salt', () => {
    const r = parseWalHeader(walHeader(7))
    expect(r).toEqual({ ok: true, value: { pageSize: 4096, ckptSeq: 7, salt1: 0x11223344, salt2: 0x55667788 } })
  })
  it('损坏 -wal 头 → 明确失败', () => {
    expect(parseWalHeader(undefined).ok).toBe(false)
    expect(parseWalHeader(walHeader().subarray(0, 20)).ok).toBe(false)
    const badMagic = walHeader(); badMagic.writeUInt32BE(0xdeadbeef, 0)
    expect(parseWalHeader(badMagic)).toMatchObject({ ok: false, error: expect.stringContaining('magic') })
    const badSum = walHeader(); badSum[13] ^= 0xff
    expect(parseWalHeader(badSum)).toMatchObject({ ok: false, error: expect.stringContaining('checksum') })
  })
  it('合法 -shm 头（小端）→ mxFrame / nBackfill', () => {
    const r = parseShmHeader(shmHeader(29, 0), 'LE')
    expect(r).toMatchObject({ ok: true, value: { mxFrame: 29, nBackfill: 0, iChange: 5, salt1: 0xaabbccdd } })
  })
  it('损坏 -shm 头 → 明确失败（读不全 / 副本不一致 / 未初始化 / 校验和）', () => {
    expect(parseShmHeader(undefined, 'LE').ok).toBe(false)
    expect(parseShmHeader(shmHeader().subarray(0, 100), 'LE')).toMatchObject({ ok: false, error: expect.stringContaining('short') })
    const torn = shmHeader(); torn.writeUInt32LE(30, 16)
    expect(parseShmHeader(torn, 'LE')).toMatchObject({ ok: false, error: expect.stringContaining('copies differ') })
    const zero = Buffer.alloc(136)
    expect(parseShmHeader(zero, 'LE').ok).toBe(false)
    const badSum = shmHeader(); badSum.writeUInt32LE(31, 16); badSum.writeUInt32LE(31, 64)
    expect(parseShmHeader(badSum, 'LE')).toMatchObject({ ok: false, error: expect.stringContaining('checksum') })
  })
})
