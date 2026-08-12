export interface SearchSnippetSegment { text: string; highlighted: boolean }

export const parseSearchSnippet = (snippet: string): SearchSnippetSegment[] => {
  const parts = snippet.split(/(<mark>|<\/mark>)/)
  const segments: SearchSnippetSegment[] = []
  let highlighted = false
  for (const part of parts) {
    if (part === '<mark>') highlighted = true
    else if (part === '</mark>') highlighted = false
    else if (part) segments.push({ text: part, highlighted })
  }
  return segments
}
