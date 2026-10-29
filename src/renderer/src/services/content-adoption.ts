/**
 * 父组件传下来的 content 是否已经过时：同一章里，编辑器（保存协调器）已经保存到更新的修订号，
 * 而这次渲染拿到的还是更早一次保存的结果（React 的 passive effect 晚于下一次保存才执行时会出现）。
 * 过时的 content 不能拿来回滚修订号，也不能 setContent 覆盖编辑器——否则连续接受多条提案时
 * 会把刚应用的修改冲掉，后面的提案因原文对不上而失效。
 */
export const isStaleContent = (input: { sameDocument: boolean; contentRevision: number; editorRevision: number }): boolean =>
  input.sameDocument && input.contentRevision < input.editorRevision
