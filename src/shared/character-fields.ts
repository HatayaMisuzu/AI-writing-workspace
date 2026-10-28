import { CHARACTER_FIELD_KEYS, type CharacterFieldKey } from './domain'

/**
 * 规范化人物 fields_json：
 * - 六个固定键始终存在（缺省空串，不预置业务文案）
 * - 额外键保留（兼容旧数据 / 扩展），但不由 UI 编辑
 */
export function normalizeCharacterFields(input?: Record<string, string> | null): Record<string, string> {
  const source = input && typeof input === 'object' ? input : {}
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') result[key] = value
  }
  for (const key of CHARACTER_FIELD_KEYS) {
    if (typeof result[key] !== 'string') result[key] = ''
  }
  return result
}

export function mergeCharacterFields(
  existing: Record<string, string> | undefined,
  patch: Partial<Record<string, string>> | undefined
): Record<string, string> {
  const base = normalizeCharacterFields(existing)
  if (!patch) return base
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value === 'string') base[key] = value
  }
  for (const key of CHARACTER_FIELD_KEYS) {
    if (typeof base[key] !== 'string') base[key] = ''
  }
  return base
}

export function readFixedCharacterFields(fields: Record<string, string> | undefined): Record<CharacterFieldKey, string> {
  const normalized = normalizeCharacterFields(fields)
  const result = {} as Record<CharacterFieldKey, string>
  for (const key of CHARACTER_FIELD_KEYS) result[key] = normalized[key] ?? ''
  return result
}
