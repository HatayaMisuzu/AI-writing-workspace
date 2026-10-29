import { classifyConflicts, conflictTargetLabel, coverageWarnings, parseConsistencyReport, type ConsistencyConflict, type ConsistencyCoverage } from '../../../shared/consistency-check'

const ConflictItem = ({ conflict }: { conflict: ConsistencyConflict }): React.JSX.Element => <li>
  <div>原文{conflict.location ? `（${conflict.location}）` : ''}：「{conflict.quote}」</div>
  <div>冲突对象：{conflictTargetLabel(conflict)}</div>
  {conflict.explanation && <div>{conflict.explanation}</div>}
</li>

/**
 * P1-6：只读冲突报告。JSON 解析失败时退化为原文展示。
 * chapterText 存在时校验引用是否出现在本章；找不到的条目单列为「引用未在本章找到」，不计入确切冲突。
 * chapterText 缺省（报告章≠当前章）时引用一律标「未校验」，不计入确切冲突数。
 * coverage 显示设定/本章被省略或截断的警告；不完整时不显示「未发现冲突」的确定结论。
 */
export function ConsistencyReportView({ text, chapterText, coverage }: { text: string; chapterText?: string; coverage?: ConsistencyCoverage }): React.JSX.Element {
  const report = parseConsistencyReport(text, chapterText)
  const warnings = coverageWarnings(coverage)
  const warningBlock = warnings.length ? <div className="consistency-warning" role="alert">{warnings.map((warning) => <div key={warning}>⚠ {warning}</div>)}</div> : null
  if (!report.ok) return <div className="message-content">{warningBlock}<small>报告格式无法解析，以下为模型原文：</small>{'\n'}{report.raw}</div>
  const { confirmed, notFound: unverified, unchecked } = classifyConflicts(report.conflicts, chapterText !== undefined)
  const scope = warnings.length ? '在已比对的范围内' : ''
  return <div className="message-content consistency-report">
    {warningBlock}
    {unchecked.length > 0
      ? <><strong>一致性检查：模型报告 {unchecked.length} 处可能冲突，引用未校验（报告所属章节不是当前打开的章节，打开该章后可校验）</strong>
        <ul className="consistency-unchecked">{unchecked.map((conflict, index) => <li key={index} className="consistency-unchecked-item"><small>【未校验】</small><ul><ConflictItem conflict={conflict} /></ul></li>)}</ul></>
      : confirmed.length
      ? <><strong>一致性检查：{scope}发现 {confirmed.length} 处可能冲突（只读，未修改正文或设定）</strong><ol>{confirmed.map((conflict, index) => <ConflictItem key={index} conflict={conflict} />)}</ol></>
      : <div>一致性检查：{scope}未发现冲突{warnings.length ? '，但结果不完整' : ''}。（只读报告，未修改正文或设定）</div>}
    {unverified.length > 0 && <><small>以下 {unverified.length} 条引用未在本章找到，可能是模型误引，不作为确切冲突：</small>
      <ul className="consistency-unverified">{unverified.map((conflict, index) => <ConflictItem key={index} conflict={conflict} />)}</ul></>}
  </div>
}
