type FrameHost = { requestAnimationFrame: (cb: () => void) => number; cancelAnimationFrame: (id: number) => void }

/**
 * 按 rAF 合帧：同一帧内多次 schedule 只跑一次；run 前先取 key（尺寸、内容等），与上次相同则跳过。
 * flush() 立即同步跑（同样做 key 比较），用于挂载时首测。
 */
export function createFrameCoalescer<K>(keyOf: () => K | undefined, run: () => void, equal: (a: K, b: K) => boolean = Object.is, host: FrameHost = globalThis as unknown as FrameHost): { schedule(): void; flush(): void; cancel(): void; invalidate(): void } {
  let frame: number | undefined
  let hasLast = false
  let last: K | undefined
  const execute = (): void => {
    const key = keyOf()
    if (key === undefined) return
    if (hasLast && equal(last as K, key)) return
    hasLast = true; last = key
    run()
  }
  const cancel = (): void => { if (frame !== undefined) { host.cancelAnimationFrame(frame); frame = undefined } }
  return {
    schedule() { if (frame !== undefined) return; frame = host.requestAnimationFrame(() => { frame = undefined; execute() }) },
    flush() { cancel(); execute() },
    cancel,
    invalidate() { hasLast = false; last = undefined }
  }
}
