import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * 测试专用：源码守卫只看「真实代码」，不看注释。
 *
 * 背景：守卫原先直接对源码全文做正则匹配，注释里的字样也算数，于是可以靠改注释让守卫变绿/变红，与真实调用脱钩。
 * stripComments 用一个小的词法状态机去掉 // 行注释和 /* *\/ 块注释：
 * - 字符串（'…'、"…"、`…` 模板字面量，含转义）原样保留，所以 'http://x' 里的 // 不会被当成注释，
 *   exec/prepare 的 SQL 参数、worker 源码模板字面量里的代码都仍会被扫描（模板字面量整体按字符串保留，偏保守：只会多报不会漏报）；
 * - 正则字面量（/…/，按前一个有效字符判断是否处于表达式起点）原样保留，避免 /\/\// 之类被误判为注释；
 * - 注释替换为空白，但保留换行，违规报告里的行号与原文件一致。
 */
export function stripComments(source: string): string {
  let out = ''
  let i = 0
  let prev = '' // 上一个非空白的有效代码字符，用来判断 / 是正则还是除号
  const n = source.length
  const blank = (s: string): string => s.replace(/[^\n]/g, ' ')
  while (i < n) {
    const c = source[i]
    const d = source[i + 1]
    if (c === '/' && d === '/') {
      let j = i
      while (j < n && source[j] !== '\n') j++
      out += blank(source.slice(i, j)); i = j
      continue
    }
    if (c === '/' && d === '*') {
      const end = source.indexOf('*/', i + 2)
      const j = end === -1 ? n : end + 2
      out += blank(source.slice(i, j)); i = j
      continue
    }
    if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1
      while (j < n && source[j] !== c) {
        if (source[j] === '\\') j++
        else if (c !== '`' && source[j] === '\n') break
        j++
      }
      j = Math.min(j + 1, n)
      out += source.slice(i, j); i = j; prev = c
      continue
    }
    if (c === '/' && (prev === '' || '(,=:[!&|?{};+-*%~^'.includes(prev) || /\b(?:return|typeof|case|do|else|in|of|void|yield|await)$/.test(out.trimEnd()))) {
      let j = i + 1
      let inClass = false
      while (j < n && source[j] !== '\n') {
        const ch = source[j]
        if (ch === '\\') { j += 2; continue }
        if (ch === '[') inClass = true
        else if (ch === ']') inClass = false
        else if (ch === '/' && !inClass) break
        j++
      }
      if (j < n && source[j] === '/') {
        j++
        while (j < n && /[a-z]/i.test(source[j])) j++
        out += source.slice(i, j); i = j; prev = '/'
        continue
      }
    }
    out += c
    if (!/\s/.test(c)) prev = c
    i++
  }
  return out
}

export type GuardRule = { name: string; pattern: RegExp }
export type GuardHit = { rule: string; line: number; text: string }

/** 对去掉注释后的源码逐行匹配；text 给的是原文件那一行（便于报告），匹配只看去注释后的内容。 */
export function findViolations(source: string, rules: GuardRule[]): GuardHit[] {
  const original = source.split('\n')
  const hits: GuardHit[] = []
  stripComments(source).split('\n').forEach((line, index) => {
    for (const rule of rules) {
      const re = new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', ''))
      if (re.test(line)) hits.push({ rule: rule.name, line: index + 1, text: original[index].trim() })
    }
  })
  return hits
}

/** 递归列出目录下指定扩展名的源文件，返回以 / 分隔的相对路径（相对 base）。 */
export function listSourceFiles(dir: string, base: string, exts = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return listSourceFiles(path, base, exts)
    return exts.test(entry.name) ? [relative(base, path).split(sep).join('/')] : []
  })
}

export function readStripped(path: string): string {
  return stripComments(readFileSync(path, 'utf8'))
}
