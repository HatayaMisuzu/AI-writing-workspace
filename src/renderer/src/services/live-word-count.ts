/** 停止输入后多久刷新状态栏字数（只影响显示；保存时主进程另行精确计数）。 */
export const LIVE_WORD_COUNT_DELAY_MS = 300
export const liveWordCountOf = (plainText: string): number =>
  (plainText.match(/[\p{Script=Han}]/gu)?.length ?? 0) + (plainText.match(/[A-Za-z0-9]+/g)?.length ?? 0)
