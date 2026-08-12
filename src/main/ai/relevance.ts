const LATIN_OR_NUMBER = /[A-Za-z0-9][A-Za-z0-9_'’-]*/g
const HAN_RUN = /[\p{Script=Han}]{2,}/gu

export const extractTerms = (text: string): string[] => {
  const terms = new Set<string>()
  for (const word of text.match(LATIN_OR_NUMBER) ?? []) if (word.length >= 2) terms.add(word.toLowerCase())
  for (const run of text.match(HAN_RUN) ?? []) {
    if (run.length <= 6) terms.add(run)
    const maxSize = Math.min(4, run.length)
    for (let size = 2; size <= maxSize; size += 1) {
      for (let index = 0; index <= run.length - size; index += 1) terms.add(run.slice(index, index + size))
    }
  }
  return [...terms].slice(0, 80)
}

export const relevanceScore = (candidate: string, query: string): number => {
  const haystack = candidate.toLowerCase()
  const terms = extractTerms(query)
  let score = 0
  for (const term of terms) {
    if (!haystack.includes(term)) continue
    score += term.length >= 4 ? 4 : term.length === 3 ? 2 : 1
  }
  return score
}
