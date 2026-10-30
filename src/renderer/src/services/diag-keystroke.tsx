// 诊断专用（分支 diag-thousand-chapter-keystroke，永不合并）：构建时 VITE_DIAG_KEYSTROKE=1 才生效，只记日志不改行为。
import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from 'react'

export const DIAG_KEYSTROKE = import.meta.env.VITE_DIAG_KEYSTROKE === '1'

type DiagWindow = Window & { __diagRenders?: Array<{ id: string; phase: string; actual: number; base: number; start: number; commit: number }>; __diagCounts?: Record<string, number> }

const onRender: ProfilerOnRenderCallback = (id, phase, actual, base, start, commit) => {
  const w = window as DiagWindow
  ;(w.__diagRenders ??= []).push({ id, phase, actual, base, start, commit })
}

export function diagCount(key: string): void {
  if (!DIAG_KEYSTROKE) return
  const w = window as DiagWindow
  const counts = (w.__diagCounts ??= {})
  counts[key] = (counts[key] ?? 0) + 1
}

export function DiagProfiler({ id, children }: { id: string; children: ReactNode }): React.JSX.Element {
  if (!DIAG_KEYSTROKE) return <>{children}</>
  return <Profiler id={id} onRender={onRender}>{children}</Profiler>
}
