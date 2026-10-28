/** S1c：模型服务 Base URL 只允许 http/https。main（schema、存量配置、adapter）与 renderer（设置页即时提示）共用。 */
export const BASE_URL_MISSING_SCHEME = '请在地址前加 http:// 或 https://（例如 http://localhost:11434/v1）。'
export const BASE_URL_UNSUPPORTED_SCHEME = 'Base URL 只支持 http:// 或 https:// 地址。'
export const BASE_URL_HAS_CREDENTIALS = '地址中不要包含账号或密码，密钥请填在 Key 栏。'
export const BASE_URL_MALFORMED = 'Base URL 格式不正确。'
export const BASE_URL_TOO_LONG = 'Base URL 过长（最多 2000 个字符）。'
export const BASE_URL_MAX_LENGTH = 2_000
// 零宽/不可见字符：可用于显示伪装（如 local\u200bhost 实际解析为 localhost）
const INVISIBLE_CHARS = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/

export type BaseUrlCheck = { ok: true; url: string } | { ok: false; message: string }

export const checkBaseUrl = (raw: string): BaseUrlCheck => {
  const value = raw.trim()
  if (!value) return { ok: false, message: BASE_URL_MALFORMED }
  if (raw.length > BASE_URL_MAX_LENGTH) return { ok: false, message: BASE_URL_TOO_LONG }
  if (INVISIBLE_CHARS.test(value)) return { ok: false, message: BASE_URL_MALFORMED }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    // localhost:11434、127.0.0.1:8080/v1、api.example.com 等缺协议的写法
    if (!value.includes(':') || /^[^\s/:]+:\d+(\/|$)/.test(value)) return { ok: false, message: BASE_URL_MISSING_SCHEME }
    return { ok: false, message: BASE_URL_UNSUPPORTED_SCHEME }
  }
  let parsed: URL
  try { parsed = new URL(value) } catch { return { ok: false, message: BASE_URL_MALFORMED } }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, message: BASE_URL_UNSUPPORTED_SCHEME }
  if (parsed.username || parsed.password || /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(value)) return { ok: false, message: BASE_URL_HAS_CREDENTIALS }
  if (!parsed.hostname || /^\.*$/.test(parsed.hostname) || /\s/.test(value)) return { ok: false, message: BASE_URL_MALFORMED }
  // 存规范化后的地址（小写主机名、IDNA/全角映射后的真实主机），避免存入值与实际连接目标不一致
  const url = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`
  if (url.length > BASE_URL_MAX_LENGTH) return { ok: false, message: BASE_URL_TOO_LONG }
  return { ok: true, url }
}

// S1d：query 中视为密钥的参数名（大小写不敏感，按解码后的完整参数名匹配）
export const SECRET_QUERY_PARAMS = ['key', 'api_key', 'apikey', 'token', 'access_token', 'secret', 'password', 'sig'] as const
export const REDACTED = '***'
export const BASE_URL_QUERY_SECRET_HINT = '地址中含有密钥参数（如 key=、token=），建议把密钥填在 Key 栏；界面与日志中该值会显示为 ***。'
const secretNames = new Set<string>(SECRET_QUERY_PARAMS)
const decodeName = (name: string): string => { try { return decodeURIComponent(name.replace(/\+/g, ' ')).trim().toLowerCase() } catch { return name.trim().toLowerCase() } }
const isSecretName = (name: string): boolean => secretNames.has(decodeName(name))

type QueryPart = { raw: string; name: string; value?: string }
const splitUrl = (raw: string): { head: string; query?: string; hash: string } => {
  const hashAt = raw.indexOf('#'); const hash = hashAt < 0 ? '' : raw.slice(hashAt); const rest = hashAt < 0 ? raw : raw.slice(0, hashAt)
  const q = rest.indexOf('?')
  return q < 0 ? { head: rest, hash } : { head: rest.slice(0, q), query: rest.slice(q + 1), hash }
}
const parseQuery = (query: string): QueryPart[] => query.split('&').map((raw) => {
  const eq = raw.indexOf('=')
  return eq < 0 ? { raw, name: raw } : { raw, name: raw.slice(0, eq), value: raw.slice(eq + 1) }
})
const joinUrl = (head: string, parts: QueryPart[] | undefined, hash: string): string =>
  `${head}${parts ? `?${parts.map((part) => part.value === undefined ? part.raw : `${part.name}=${part.value}`).join('&')}` : ''}${hash}`

/** 地址 query 中是否带有密钥类参数（有值）。 */
export const hasSecretQuery = (raw: string): boolean => {
  const { query } = splitUrl(raw)
  return query !== undefined && parseQuery(query).some((part) => part.value !== undefined && part.value !== '' && isSecretName(part.name))
}

/** 把 query 中密钥类参数的值替换为 ***（其余部分原样保留）。 */
export const redactQuerySecrets = (raw: string): string => {
  const { head, query, hash } = splitUrl(raw)
  if (query === undefined) return raw
  return joinUrl(head, parseQuery(query).map((part) => part.value !== undefined && isSecretName(part.name) ? { ...part, value: REDACTED } : part), hash)
}

/** 任意文本（报错详情、日志）中出现的 name=value 密钥参数一律脱敏。 */
export const redactSecretsInText = (text: string): string =>
  text.replace(/(^|[?&;\s"'(])((?:key|api_key|apikey|token|access_token|secret|password|sig))=([^&#\s"')]*)/gi, `$1$2=${REDACTED}`)

/**
 * 设置页编辑再保存时，界面拿到的是脱敏后的地址：密钥参数值为 *** 时，按参数名（同名按出现次序）
 * 用已保存的原值还原，避免把 *** 写回覆盖原值。找不到原值则返回 undefined（调用方应拒绝保存）。
 */
export const restoreRedactedSecrets = (input: string, original: string | undefined): string | undefined => {
  const { head, query, hash } = splitUrl(input)
  if (query === undefined) return input
  const parts = parseQuery(query)
  if (!parts.some((part) => part.value === REDACTED && isSecretName(part.name))) return input
  const originals = original === undefined ? [] : parseQuery(splitUrl(original).query ?? '')
  const used = new Map<string, number>()
  let missing = false
  const restored = parts.map((part) => {
    if (part.value !== REDACTED || !isSecretName(part.name)) return part
    const name = decodeName(part.name); const index = used.get(name) ?? 0; used.set(name, index + 1)
    const source = originals.filter((item) => item.value !== undefined && decodeName(item.name) === name)[index]
    if (!source) { missing = true; return part }
    return { ...part, value: source.value }
  })
  return missing ? undefined : joinUrl(head, restored, hash)
}

/**
 * 隐去地址中的账号密码，不依赖写法是否标准（http:\\u:p@h、http:u:p@h、user:p@host 等）：
 * 协议（若有）及其后的斜杠/反斜杠之后、最后一个 @ 之前的内容全部替换为 ***。
 */
export const redactBaseUrl = (input: string): string => {
  const raw = redactQuerySecrets(input)
  const at = raw.lastIndexOf('@')
  if (at < 0) return raw
  const prefix = /^\s*[a-z][a-z0-9+.-]*:[\\/]*/i.exec(raw)?.[0] ?? ''
  return `${prefix.length <= at ? prefix : ''}***${raw.slice(at)}`
}

/** 回传给界面的地址：校验不通过的一律不回显原文（只给出需修正提示），通过的再做脱敏兜底。 */
export const displayBaseUrl = (raw: string): string => checkBaseUrl(raw).ok ? redactBaseUrl(raw) : ''
