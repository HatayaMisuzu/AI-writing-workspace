import type { AIMode } from '../../../shared/domain'
import { READER_REVIEW_DEFAULT_INTENT } from '../../../shared/reader-review'

const EDITING_DEFAULT = '请修改选中的文字，保持原意和语气。'
const GENERATION_DEFAULT = '请根据当前上下文生成一段候选文字。'
const READER_DEFAULT_PATTERN = new RegExp(`^${READER_REVIEW_DEFAULT_INTENT(0).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('0', '\\d*')}$`)

const isReaderDefault = (text: string): boolean => READER_DEFAULT_PATTERN.test(text)
/** 输入框为空或仍是某个模式的默认意图（作者没写自己的字）。 */
export const isDefaultIntent = (text: string): boolean => !text.trim() || text === EDITING_DEFAULT || text === GENERATION_DEFAULT || isReaderDefault(text)

const defaultFor = (mode: AIMode, readerThrough: string): string =>
  mode === 'editing' ? EDITING_DEFAULT : mode === 'generation' ? GENERATION_DEFAULT
    : mode === 'reader_review' ? READER_REVIEW_DEFAULT_INTENT(Number(readerThrough) || 1) : ''

/** 修复 1：切换快捷模式时，作者已写的文字一律保留；只有空/默认意图才换成新模式的默认意图。 */
export const inputForQuickMode = (next: AIMode, current: string, readerThrough: string): string =>
  isDefaultIntent(current) ? defaultFor(next, readerThrough) : current

/** 修复 1：修改「读到第 N 章」时，若输入框仍是读者默认意图，则同步其中的 N；作者自写文字不动。 */
export const inputForReaderThrough = (current: string, readerThrough: string): string =>
  isReaderDefault(current) ? READER_REVIEW_DEFAULT_INTENT(Number(readerThrough) || 1) : current
