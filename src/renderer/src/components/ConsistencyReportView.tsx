import { CONSISTENCY_KIND_LABELS, parseConsistencyReport } from '../../../shared/consistency-check'

/** P1-6：只读冲突报告。JSON 解析失败时退化为原文展示。 */
export function ConsistencyReportView({ text }: { text: string }): React.JSX.Element {
  const report = parseConsistencyReport(text)
  if (!report.ok) return <div className="message-content"><small>报告格式无法解析，以下为模型原文：</small>{'\n'}{report.raw}</div>
  if (!report.conflicts.length) return <div className="message-content">一致性检查：未发现冲突。（只读报告，未修改正文或设定）</div>
  return <div className="message-content consistency-report">
    <strong>一致性检查：发现 {report.conflicts.length} 处可能冲突（只读，未修改正文或设定）</strong>
    <ol>{report.conflicts.map((conflict, index) => <li key={index}>
      <div>原文{conflict.location ? `（${conflict.location}）` : ''}：「{conflict.quote}」</div>
      <div>冲突对象：{CONSISTENCY_KIND_LABELS[conflict.conflictWith.kind]} · {conflict.conflictWith.title}</div>
      {conflict.explanation && <div>{conflict.explanation}</div>}
    </li>)}</ol>
  </div>
}
