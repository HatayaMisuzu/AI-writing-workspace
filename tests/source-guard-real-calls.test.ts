import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findViolations, listSourceFiles, stripComments, type GuardRule } from './helpers/source-guard'

/**
 * 源码守卫加固（只改测试）：守卫只看真实代码，注释里的字样既不能让守卫变红，也不能让真实调用逃过守卫。
 *
 * 新禁止项：src 里不得新增长期读连接 / 长读：
 * - `new DatabaseSync(`：每条连接都会长期持有 WAL 读快照的可能，影响 WAL 回到文件头与检查点收敛；
 * - `.iterate(`：游标式逐行读取，语句未结束前一直持有读事务（长读）；
 * - node:sqlite 的 `backup`：在线备份 API，备份期间持续读库；
 * - `VACUUM INTO`：整库读出写到新文件，也是长读。
 *
 * 精确允许（按文件 + 恰好计数，不是白名单目录）：产品现在本来就有且只有两条连接——
 * - src/main/database/database.ts：主连接（AppDatabase 构造里 `this.raw = new DatabaseSync(path)`），恰好 1 处；
 * - src/main/database/wal-checkpointer.ts：后台检查点 worker 的连接（WORKER_SOURCE 模板里 `db = new DatabaseSync(workerData.path)`），
 *   只做 PRAGMA wal_checkpoint(PASSIVE)、busy_timeout = 0，恰好 1 处。
 * 其他文件出现任何一处、或这两个文件的数量变化，都必须红，交由评审决定。
 */

const SRC = resolve('src')

const LONG_READ_RULES: GuardRule[] = [
  { name: 'new DatabaseSync', pattern: /\bnew\s+DatabaseSync\s*\(/ },
  { name: '.iterate(', pattern: /\.iterate\s*\(/ },
  { name: 'node:sqlite backup', pattern: /(?<![\w$])backup\s*\(/ },
  { name: 'node:sqlite backup import', pattern: /\bbackup\b[^;\n]*(?:from\s*['"]node:sqlite['"]|require\(\s*['"]node:sqlite['"]\s*\))/ },
  { name: 'VACUUM INTO', pattern: /\bVACUUM\s+INTO\b/i }
]

const ALLOWED_NEW_DATABASE_SYNC: Record<string, number> = {
  'main/database/database.ts': 1,
  'main/database/wal-checkpointer.ts': 1
}

const NON_PASSIVE: GuardRule[] = [{ name: '非 PASSIVE 的 wal_checkpoint', pattern: /wal_checkpoint\s*\(\s*(?:FULL|RESTART|TRUNCATE)\s*\)/i }]

describe('源码守卫工具：只看真实调用', () => {
  it('stripComments 去掉 // 与 /* */，保留字符串里的 //、保留行号', () => {
    const src = [
      "const url = 'http://example.com/a' // 尾注释 VACUUM INTO",
      'const b = "x // y" /* 块注释 new DatabaseSync( */ + 1',
      '/* 多行',
      ' * db.iterate()',
      ' */',
      'const re = /\\/\\//g; const t = `a // b`',
      'const q = 4 / 2 // 除号后的注释 .iterate('
    ].join('\n')
    const out = stripComments(src)
    expect(out.split('\n')).toHaveLength(7)
    expect(out).toContain("'http://example.com/a'")
    expect(out).toContain('"x // y"')
    expect(out).toContain('/\\/\\//g')
    expect(out).toContain('`a // b`')
    expect(out).toContain('4 / 2')
    expect(out).not.toMatch(/VACUUM INTO|new DatabaseSync|iterate/)
  })

  it('注释改写绕不过：真实调用上方带无害注释 / 注释另写内容，真实调用仍报违规', () => {
    const disguised = [
      '// 这里只做 PASSIVE 检查点（注释写得再好看也不算数）',
      "db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() // PASSIVE",
      '/* 只读一次，不是长读 */ for (const row of stmt.iterate()) use(row)',
      "raw.exec('VACUUM INTO ?') /* 注释：这不是 VACUUM */",
      'const extra = new DatabaseSync(path) // 不是新连接'
    ].join('\n')
    expect(findViolations(disguised, NON_PASSIVE).map((h) => h.line)).toEqual([2])
    expect(findViolations(disguised, LONG_READ_RULES).map((h) => `${h.line}:${h.rule}`)).toEqual(['3:.iterate(', '4:VACUUM INTO', '5:new DatabaseSync'])
  })

  it('只在注释里出现的违规词不报', () => {
    const commentsOnly = [
      '// 旧方案：PRAGMA wal_checkpoint(RESTART)，已放弃',
      '/**',
      ' * 不要用 new DatabaseSync(path) 再开连接，也不要 stmt.iterate()、backup(db, file) 或 VACUUM INTO',
      ' * wal_checkpoint(TRUNCATE)',
      ' */',
      "db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() // 不是 wal_checkpoint(FULL)",
      "const note = 'see http://x/y' // new DatabaseSync("
    ].join('\n')
    expect(findViolations(commentsOnly, NON_PASSIVE)).toEqual([])
    expect(findViolations(commentsOnly, LONG_READ_RULES)).toEqual([])
  })
})

describe('源码守卫：src 不得新增长期读连接 / 长读', () => {
  it('new DatabaseSync 只允许主连接与检查点 worker 各恰好 1 处；.iterate( / backup / VACUUM INTO 一处都不许', () => {
    const counts: Record<string, number> = {}
    const other: string[] = []
    for (const file of listSourceFiles(SRC, SRC)) {
      for (const hit of findViolations(readFileSync(join(SRC, file), 'utf8'), LONG_READ_RULES)) {
        if (hit.rule === 'new DatabaseSync' && file in ALLOWED_NEW_DATABASE_SYNC) counts[file] = (counts[file] ?? 0) + 1
        else other.push(`src/${file}:${hit.line} [${hit.rule}] ${hit.text}`)
      }
    }
    expect(other).toEqual([])
    expect(counts).toEqual(ALLOWED_NEW_DATABASE_SYNC)
  })
})
