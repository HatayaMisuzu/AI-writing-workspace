import { describe, expect, it } from 'vitest'
import { isAllowedExternalUrl } from '../src/main/external-url'
import { parseSearchSnippet } from '../src/renderer/src/services/search-snippet'

describe('renderer and external navigation boundaries', () => {
  it('allows only HTTP(S) external URLs', () => {
    expect(isAllowedExternalUrl('https://example.com')).toBe(true)
    expect(isAllowedExternalUrl('http://localhost:3000')).toBe(true)
    for (const value of ['file:///C:/secret', 'javascript:alert(1)', 'mailto:test@example.com', 'not a url']) expect(isAllowedExternalUrl(value)).toBe(false)
  })

  it('keeps user HTML as text and only recognizes controlled mark delimiters', () => {
    const segments = parseSearchSnippet('<img src=x onerror=alert(1)>前<mark>红伞</mark>后')
    expect(segments).toEqual([
      { text: '<img src=x onerror=alert(1)>前', highlighted: false },
      { text: '红伞', highlighted: true }, { text: '后', highlighted: false }
    ])
  })
})
