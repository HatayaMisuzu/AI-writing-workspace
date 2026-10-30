import { openSync, readSync, closeSync, statSync } from 'node:fs'

/**
 * diag-hw1（诊断分支专用，不改变行为）：检查点/释放时间线。仅在 INKSTONE_CP_DIAG=1 时输出到 stdout。
 * 只读文件（-wal 头、-shm 的 wal-index 头 + 检查点信息），不开 SQLite 连接、不发 PRAGMA。
 */
export const cpDiagOn = (): boolean => process.env.INKSTONE_CP_DIAG === '1'

export function cpDiag(event: string, data: Record<string, unknown> = {}): void {
  if (!cpDiagOn()) return
  try { process.stdout.write(`[cp-diag] ${new Date().toISOString()} pid=${process.pid} ${event} ${JSON.stringify(data)}\n`) } catch { /* ignore */ }
}

function readBytes(file: string, length: number): Buffer | undefined {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(length)
    const n = readSync(fd, buf, 0, length, 0)
    return buf.subarray(0, n)
  } catch { return undefined } finally { if (fd !== undefined) try { closeSync(fd) } catch { /* ignore */ } }
}

/** wal 文件大小 + wal 头 ckptSeq/salt1（WAL 从头复用时会变）+ shm 的 mxFrame / nBackfill / nBackfillAttempted / readMarks */
export function walState(dbPath: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  try { out.walBytes = statSync(`${dbPath}-wal`).size } catch { out.walBytes = -1 }
  const wal = readBytes(`${dbPath}-wal`, 32)
  if (wal && wal.length >= 32) { out.ckptSeq = wal.readUInt32BE(12); out.salt1 = wal.readUInt32BE(16) }
  const shm = readBytes(`${dbPath}-shm`, 136)
  if (shm && shm.length >= 136) {
    out.mxFrame = shm.readUInt32LE(16)
    out.nBackfill = shm.readUInt32LE(96)
    out.readMarks = [0, 1, 2, 3, 4].map((i) => shm.readUInt32LE(100 + i * 4))
    out.nBackfillAttempted = shm.readUInt32LE(128)
  }
  return out
}
