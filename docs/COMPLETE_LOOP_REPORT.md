# Complete Usable Loop V1 执行报告

## 1. Baseline

```text
Start HEAD: da7bd91ca586f564be6f7d312e92ba84f789f323
Start origin/main: da7bd91ca586f564be6f7d312e92ba84f789f323
Execution pack: ai-writing-workspace-complete-loop-pack-v0.3
```

执行包清单中的 11 个文件均完成 SHA-256 校验。开始时工作树干净，基线的 typecheck、41 项测试、lint 与 build 全部通过。

## 2. Scope

Included: writing/save/search/AI discussion/memory/edit/generation/digest/proofread/history/export，以及多作品隔离、卷章管理、Provider/Model Manager、迁移与 Electron 实机验证。

Excluded: reader/publish/cloud/comments/community。遗留的底层可见性边界仅为旧隔离测试保留，不可从产品 UI、任务推断或模型路由到达，也不作为当前产品能力宣称。

## 3. Closure Matrix

| ID | Loop | Result | Evidence |
|---|---|---|---|
| C1 | Writing | PASS | 自动保存、即时切章、关闭握手、卷章增删改排；Electron Gate A/B |
| C2 | Models | PASS | 用户自带 OpenAI-compatible Provider、默认模型、7 类任务路由读回与禁用回退 |
| C3 | AI discussion | PASS | 项目级 thread/message 持久化、最近 50 条、分页、错误/取消状态、重启恢复 |
| C4 | Context | PASS | 项目、文档、人物、笔记、摘要、确认记忆与安全风格样本按任务组装；上下文查看器 |
| C5 | Memory | PASS | 明确意图正反例、最多 3 条 suggested、作者逐条确认/否决、下轮上下文可见 |
| C6 | Digest | PASS | missing/fresh/stale 状态、一次结构修复、候选不自动 confirmed |
| C7 | Generation/editing | PASS | 生成候选仅一次插入；选区修改形成 TextPatch，接受前 revision/hash 校验并创建 AI 快照 |
| C8 | Style safety | PASS | human/AI 来源分离，原始 AI 永不按 human 权重检索 |
| C9 | Proofreading | PASS | 本地问题定位/应用/忽略/Undo；AI 结构化建议只进入修改提案 |
| C10 | History/export | PASS | 当前正文 Diff、安全渲染、恢复前 pre_restore；TXT/MD/DOCX 实际导出检查 |

## 4. Major Changes

- Model route readback：仅保留讨论、脑暴、续写、修改、整理、章节理解与校对；默认统一使用主模型，覆盖路由持久化并在模型禁用时回退。
- Chat persistence：新增 project/thread 隔离的对话服务，user/assistant 消息与 streaming/complete/error/cancelled 状态落库；异常退出的 streaming 会在迁移时转为 error。
- Memory intent：增加保守本地前置判断、结构化模型判定与一次修复；疑问、否定、假设、引用台词均不会形成提案。
- Digest status：作者可主动“理解本章”，UI 明确显示未更新、已更新或正文已变化。
- Style origin：新增 `style_samples`，AI 插入/修改显式记录为 AI；StyleEngine 排除原始 AI。
- Proofreading UI：本地规则提供具体操作；AI 校对结果校验 originalText 存在后才允许创建提案，绝不直接写正文。
- History diff：小文档用词级 diff，大文档回退行级 diff；React 文本节点渲染避免执行 HTML。
- UX/errors：补齐卷章重命名/删除、空状态、按钮标签、保存和 Provider 错误反馈；修复只读切换误触发保存导致提案 stale 的真实 Electron 问题。

## 5. Data Migration

- 新增 `style_samples` 表、哈希唯一索引与来源字段。
- `schema_version` 更新为 3；启动时将遗留 streaming 消息标记为 error。
- v0.2 fixture 验证旧作品、正文、Memory、Provider、Model route 与对话均可读取，正文无丢失，不要求删库。
- 项目备份新增可选 style samples，旧 v1 备份仍可导入。

## 6. Automated Tests

```text
typecheck: PASS
tests: 22 files, 65 tests, 65 passed, 0 failed
lint: PASS, 0 warnings
build: PASS
dist: PASS — Windows NSIS, 墨记 Setup 0.3.0.exe
```

新增或强化：`model-route-persistence`、`chat-persistence`、`memory-intent`、`digest-status`、`style-origin`、`proofreading`、`history-diff`、`complete-writing-loop` 与 v0.2 migration。

## 7. Electron Manual / Automated Smoke

使用真实 Electron 生产构建、独立临时 userData 与本地 deterministic OpenAI-compatible HTTP/SSE 服务执行：

| Gate | Result | Verification |
|---|---|---|
| A | PASS | 写最后一句后立即切章，返回仍存在 |
| B | PASS | 写最后一句后立即关闭，重开仍存在 |
| C | PASS | Fake Provider 测试连接、AI Streaming、重开后历史恢复 |
| D | PASS | 选区修改、接受提案、正文完整、History 有 AI snapshot |
| E | PASS | 不确定疑问未出现记忆提案 |
| F | PASS | 明确设定生成 suggested，点击确认后下轮 Provider Context 含确认事实 |
| G | PASS | 本地校对列表、应用、Undo、再次应用与保存 |
| H | PASS | History Diff 可见，Restore 成功 |
| I | PASS | TXT/Markdown/DOCX 实际写盘并检查结构、正文和文件有效性 |

Electron 截图属于本地 QA 产物，不提交仓库。Fake Provider 共接收 7 次真实 HTTP 请求。

## 8. External Provider

```text
NOT RUN — no user supplied credential
```

未以 Mock UI 或伪响应宣称真实联网 Provider 已验收。本地 Fake Provider 仅用于验证接口、路由、Streaming、结构输出、错误状态与持久化。

## 9. Remaining Known Issues

- 未提供用户的真实第三方 API 凭据，因此真实联网兼容性测试未执行；这不影响本地写作闭环。
- 当前兼容适配器如设计所述不宣称原生 tools 或 structured-output 能力，结构化任务通过 Prompt + Schema 校验 + 一次修复实现。

## 10. Git Delivery

```text
Commit SHA: pending
Push main: pending
origin/main: pending
Working tree clean: pending
```

## 11. Final Verdict

```text
Complete Usable Loop V1: PASS
```
