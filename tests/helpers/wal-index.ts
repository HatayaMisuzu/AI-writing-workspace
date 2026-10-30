import { closeSync, openSync, readSync } from 'node:fs'
import { endianness } from 'node:os'

/**
 * 测试专用：只读解析 SQLite 的 -wal 文件头与 -shm（WAL-index）头，不开连接、不发 PRAGMA。
 *
 * 依赖 SQLite 文件格式（https://www.sqlite.org/walformat.html、https://www.sqlite.org/fileformat2.html#walformat）：
 *
 * -wal 文件头（32 字节，全部 **大端**）：
 *   0 magic（0x377f0682 / 0x377f0683；最低位=1 表示帧校验和按大端计算）  4 version(3007000)  8 pageSize
 *   12 ckptSeq（检查点序号，WAL 从头复用时 +1）  16 salt1  20 salt2  24 cksum1  28 cksum2（覆盖前 24 字节）
 *
 * -shm 的 WAL-index 头（**本机字节序**，x86/arm 均为小端）：
 *   0..47 WalIndexHdr 副本 1，48..95 副本 2（两份必须逐字节一致，否则说明正被写入/读不全）
 *     0 iVersion(3007000)  8 iChange  12 isInit(=1)  13 bigEndCksum  14 szPage(u16)  16 mxFrame  20 nPage
 *     24 aFrameCksum[2]  32 aSalt[2]  40 aCksum[2]（覆盖副本前 40 字节，本机字节序的 SQLite WAL 校验和）
 *   96 WalCkptInfo：96 nBackfill  100 aReadMark[5]  120 aLock[8]  128 nBackfillAttempted  132 notUsed0
 *
 * 任何读不到、长度不够、magic/version 不对、两份副本不一致、校验和不符，都返回 { ok:false, error }，
 * 调用方必须把失败当红处理，不得静默放行。
 */

export interface WalHeader { ckptSeq: number; salt1: number; salt2: number; pageSize: number }
export interface ShmHeader { mxFrame: number; nBackfill: number; nBackfillAttempted: number; iChange: number; salt1: number; salt2: number }
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

export const WAL_HEADER_BYTES = 32
export const SHM_HEADER_BYTES = 136
const SQLITE_VERSION = 3007000

/** SQLite walChecksumBytes：按 8 字节一组累加，s1 += x0 + s2; s2 += x1 + s1（u32 回绕） */
export function walChecksum(buf: Buffer, bigEndian: boolean): [number, number] {
  let s1 = 0; let s2 = 0
  for (let i = 0; i + 8 <= buf.length; i += 8) {
    const x0 = bigEndian ? buf.readUInt32BE(i) : buf.readUInt32LE(i)
    const x1 = bigEndian ? buf.readUInt32BE(i + 4) : buf.readUInt32LE(i + 4)
    s1 = (s1 + x0 + s2) >>> 0
    s2 = (s2 + x1 + s1) >>> 0
  }
  return [s1, s2]
}

export function parseWalHeader(buf: Buffer | undefined): Parsed<WalHeader> {
  if (!buf || buf.length < WAL_HEADER_BYTES) return { ok: false, error: `wal header short (${buf?.length ?? 'unreadable'})` }
  const magic = buf.readUInt32BE(0)
  if (magic !== 0x377f0682 && magic !== 0x377f0683) return { ok: false, error: `wal bad magic 0x${magic.toString(16)}` }
  if (buf.readUInt32BE(4) !== SQLITE_VERSION) return { ok: false, error: `wal bad version ${buf.readUInt32BE(4)}` }
  const [c1, c2] = walChecksum(buf.subarray(0, 24), (magic & 1) === 1)
  if (c1 !== buf.readUInt32BE(24) || c2 !== buf.readUInt32BE(28)) return { ok: false, error: 'wal header checksum mismatch' }
  return { ok: true, value: { pageSize: buf.readUInt32BE(8), ckptSeq: buf.readUInt32BE(12), salt1: buf.readUInt32BE(16), salt2: buf.readUInt32BE(20) } }
}

export function parseShmHeader(buf: Buffer | undefined, order: 'LE' | 'BE' = endianness()): Parsed<ShmHeader> {
  if (!buf || buf.length < SHM_HEADER_BYTES) return { ok: false, error: `shm header short (${buf?.length ?? 'unreadable'})` }
  const u32 = (o: number): number => (order === 'LE' ? buf.readUInt32LE(o) : buf.readUInt32BE(o))
  if (!buf.subarray(0, 48).equals(buf.subarray(48, 96))) return { ok: false, error: 'shm header copies differ' }
  if (u32(0) !== SQLITE_VERSION) return { ok: false, error: `shm bad iVersion ${u32(0)}` }
  if (buf[12] !== 1) return { ok: false, error: 'shm isInit != 1' }
  const [c1, c2] = walChecksum(buf.subarray(0, 40), order === 'BE')
  if (c1 !== u32(40) || c2 !== u32(44)) return { ok: false, error: 'shm header checksum mismatch' }
  return { ok: true, value: { iChange: u32(8), mxFrame: u32(16), salt1: u32(32), salt2: u32(36), nBackfill: u32(96), nBackfillAttempted: u32(128) } }
}

function readHead(file: string, length: number): Buffer | undefined {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(length)
    return buf.subarray(0, readSync(fd, buf, 0, length, 0))
  } catch { return undefined } finally { if (fd !== undefined) try { closeSync(fd) } catch { /* ignore */ } }
}

export interface WalState { wal: Parsed<WalHeader>; shm: Parsed<ShmHeader>; attempts: number }

/** 读 -wal / -shm 头；任一失败时有限次重试（Windows 上 shm 偶发读不全）。最终仍失败则原样返回失败项。 */
export function readWalState(dbPath: string, attempts = 5): WalState {
  let state: WalState = { wal: { ok: false, error: 'not read' }, shm: { ok: false, error: 'not read' }, attempts: 0 }
  for (let i = 1; i <= attempts; i += 1) {
    state = { wal: parseWalHeader(readHead(`${dbPath}-wal`, WAL_HEADER_BYTES)), shm: parseShmHeader(readHead(`${dbPath}-shm`, SHM_HEADER_BYTES)), attempts: i }
    if (state.wal.ok && state.shm.ok) break
  }
  return state
}

export const fmtWalState = (s: WalState): string => {
  const w = s.wal.ok ? `ckptSeq=${s.wal.value.ckptSeq} salt1=${s.wal.value.salt1}` : `wal=ERR(${s.wal.error})`
  const m = s.shm.ok ? `mxFrame=${s.shm.value.mxFrame} nBackfill=${s.shm.value.nBackfill}` : `shm=ERR(${s.shm.error})`
  return `{${w} ${m} tries=${s.attempts}}`
}
