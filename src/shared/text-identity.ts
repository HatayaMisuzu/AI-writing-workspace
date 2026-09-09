/** Stable, browser-safe identity for detecting changed text. This is not a security primitive. */
export function textIdentity(text: string): string {
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x85ebca6b)
  }
  return `${text.length.toString(36)}-${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`
}
