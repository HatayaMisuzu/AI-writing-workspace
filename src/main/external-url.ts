export const isAllowedExternalUrl = (raw: string): boolean => {
  try { const protocol = new URL(raw).protocol; return protocol === 'https:' || protocol === 'http:' }
  catch { return false }
}
