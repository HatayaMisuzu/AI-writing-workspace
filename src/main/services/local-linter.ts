import { randomUUID } from 'node:crypto'
import type { LocalLintIssue } from '../../shared/domain'

export function lintChineseText(text: string): LocalLintIssue[] {
  const issues: LocalLintIssue[] = []
  const rules: Array<{ regex: RegExp; kind: string; message: string; replacement?: (value: string) => string }> = [
    { regex: /[!！]{2,}/g, kind: 'repeated_punctuation', message: '连续感叹号可能是误输入。', replacement: () => '！' },
    { regex: /[?？]{2,}/g, kind: 'repeated_punctuation', message: '连续问号可能是误输入。', replacement: () => '？' },
    { regex: /\.\.\.(?!\.)/g, kind: 'ellipsis', message: '中文省略号通常使用六点“……”。', replacement: () => '……' },
    { regex: /(?<!—)—(?!—)/g, kind: 'dash', message: '中文破折号通常使用两个连续字符“——”。', replacement: () => '——' },
    { regex: /[\u4e00-\u9fff] +[\u4e00-\u9fff]/g, kind: 'space', message: '中文字符之间可能有多余空格。', replacement: (value) => value.replace(/ +/g, '') },
    { regex: /[，。！？；：][,.;:!?]/g, kind: 'mixed_punctuation', message: '中英文标点可能重复。', replacement: (value) => value[0] }
  ]
  for (const rule of rules) {
    for (const match of text.matchAll(rule.regex)) {
      if (match.index === undefined) continue
      issues.push({ id: randomUUID(), from: match.index, to: match.index + match[0].length,
        severity: 'warning', kind: rule.kind, message: rule.message, replacement: rule.replacement?.(match[0]) })
    }
  }
  const quoteStack: number[] = []
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '“') quoteStack.push(index)
    if (text[index] === '”') {
      if (quoteStack.length) quoteStack.pop()
      else issues.push({ id: randomUUID(), from: index, to: index + 1, severity: 'warning', kind: 'quote', message: '发现没有对应左引号的右引号。' })
    }
  }
  quoteStack.forEach((index) => issues.push({ id: randomUUID(), from: index, to: index + 1, severity: 'warning', kind: 'quote', message: '发现没有闭合的左引号。' }))
  return issues.toSorted((a, b) => a.from - b.from)
}
