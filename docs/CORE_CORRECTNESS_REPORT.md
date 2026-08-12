# Core Correctness Repair v0.2 执行报告

执行日期：2026-08-12

目标应用：Electron + React + TypeScript 本地多作品写作应用

执行包：`ai-writing-workspace-core-correctness-pack-v0.2`

## 1. Baseline

- 开始时本地 `HEAD`：`cbb5f6aaabae011b2cf5159115a1fc1f115d244b`
- `origin/main`：`cbb5f6aaabae011b2cf5159115a1fc1f115d244b`
- 与执行包指定基线完全一致，无需 compare 补偿。
- 执行包 8 个文件的 SHA-256 校验全部通过。
- 基线 `typecheck`、`build` 通过；基线测试 19 项中 18 项通过、1 项失败。失败用例为跨卷章节顺序，实际顺序是“尾声、第一章、第二章”，证实 F-09。

## 2. 修复矩阵

| ID | 问题 | 状态 | 主要修改文件 | 测试证据 |
|---|---|---|---|---|
| F-01 | Reader final context leak | PASS | `context-engine.ts`, `history-policy.ts`, `prompt-composer.ts`, `runtime.ts` | `reader-runtime-isolation.test.ts`, `reader-context.test.ts` |
| F-02 | autosave unmount 不 flush | PASS | `save-coordinator.ts`, `EditorSurface.tsx`, `WorkspaceScreen.tsx`, `close-handler.ts`, `window-close.ts` | `save-coordinator.test.ts`；Electron quick switch/close |
| F-03 | Patch 坐标体系错误 | PASS | `domain.ts`, `ipc.ts`, `patch-service.ts`, `EditorSurface.tsx` | `prosemirror-patch.test.ts`, `patch-provider-linter.test.ts` |
| F-04 | Patch 破坏 Editor JSON | PASS | `EditorSurface.tsx`, `patch-service.ts` | 真实 ProseMirror schema/transaction 测试 |
| F-05 | Digest 链路未闭环 | PASS | `digest-runner.ts`, `provider.ts`, `register.ts`, `AssistantPanel.tsx` | `digest-runtime.test.ts` |
| F-06 | 聊天确认到 Memory 未闭环 | PASS | `memory-service.ts`, `AssistantPanel.tsx`, `ProjectViews.tsx` | `memory-proposal.test.ts`；Electron 确认流程 |
| F-07 | Context 信息孤岛 | PASS | `context-engine.ts`, `relevance.ts`, `project-content-service.ts` | `context-integration.test.ts` |
| F-08 | Memory 整句 LIKE | PASS | `memory-service.ts`, `relevance.ts` | `context-integration.test.ts` |
| F-09 | 邻近章节跨卷顺序错误 | PASS | `document-service.ts` | 原失败用例已通过；`context-integration.test.ts` |
| F-10 | 聊天历史重复注入 | PASS | `history-policy.ts`, `context-engine.ts`, `runtime.ts` | `reader-runtime-isolation.test.ts` |
| F-11 | requestId 并发竞态 | PASS | `ai-event-router.ts`, `preload/index.ts`, `runtime.ts`, `AssistantPanel.tsx` | `ai-concurrency.test.ts` |
| F-12 | Provider capability 虚报 | PASS | `provider.ts`, `SettingsScreen.tsx` | `memory-model.test.ts` |
| F-13 | 搜索 snippet 注入 | PASS | `search-snippet.ts`, `WorkspaceScreen.tsx` | `security-boundaries.test.ts` |
| F-14 | openExternal 协议未限制 | PASS | `external-url.ts`, `main/index.ts` | `security-boundaries.test.ts` |
| F-15 | 假入口 | PASS | `ProjectSidebar.tsx`, `SettingsScreen.tsx`, `AssistantPanel.tsx` | 代码审计、Electron 流程验收 |

## 3. P0 详细结果

### 3.1 Autosave 与关闭

旧问题由防抖计时器和组件生命周期脱节造成：卸载仅清除 timer，没有等待最后一次保存；切章、切作品、进入设置和关闭窗口也没有统一的可等待保存门禁。并行 `flush()` 还可能在前一个保存完成前提前返回。

新机制由 `SaveCoordinator` 串行管理 dirty snapshot、文档 revision、定时保存和显式 `flush()`。保存期间产生的新输入继续进入同一 drain；只有最新内容全部入库，等待者才完成。所有离开正文的路径都先 await flush。主进程拦截窗口 close，通知 Renderer 保存；Renderer 成功后确认关闭，失败则取消关闭并显示错误。数据库由 `will-quit` 关闭，避免在 Renderer flush 前先断开 SQLite。

证据：4 个保存协调器回归用例覆盖防抖、立即 flush、保存中继续输入和失败；真实 Electron 中输入后立即切章，返回后末句仍在；输入后立即点 X，重启后末句仍在。

### 3.2 Patch 坐标

旧实现把 ProseMirror position 当成 plain-text offset 在 Main 中切片，段落边界和 mark 会让坐标不一致。

新机制规定 Renderer 是 PM 坐标权威：用 `doc.textBetween(fromPm, toPm)` 取得原文，同时持久化 `fromPm`、`toPm`、`documentRevision` 和原文 hash。接受前 Main 只校验 revision、当前选区文本和 hash，不再解释 PM position，也不再 plainText slice。

证据：测试 fixture 明确证明相同数字用于 `plainText.slice()` 会得到错误文本，而 PM `textBetween()` 得到正确目标；文档变化后提案必须 stale。

### 3.3 Patch 结构保留

旧实现由 Main 用新 plainText 重建整个 Editor JSON，导致粗体、段落和其他富文本结构丢失。

新机制由 Renderer 在当前 Tiptap/ProseMirror 文档上执行 `insertContentAt` transaction，编辑期间锁定 Editor，立即 flush，然后才把提案标为 accepted；接受前自动创建 AI patch snapshot。

证据：真实 ProseMirror schema 测试在含 bold mark 的段落旁修改另一段；接受后粗体 mark 和未修改节点结构保持，plainText 正确，snapshot 存在。

### 3.4 Reader 最终请求隔离

旧问题是 Reader Context builder 虽然排除了秘密，但 Runtime 随后无条件重新加入 creative chat history，最终 Provider messages 仍泄漏秘密。

新机制用显式 `historyPolicy()` 按任务决定历史：Reader Review、Digest、Proofreading 均为 isolated；仅创作讨论类任务使用当前 project/current thread 的单份历史。`composeProviderMessages()` 是可直接测试的最终请求组合器。Reader context 只含截止章正文和已到 reader-visible 边界的信息。

证据：最终 messages 测试同时放入未来章节“凶手=A”、私有 confirmed memory、灵感和 creative chat 秘密；序列化后的 Provider 请求全部不含这些字符串，只含读者已读正文。

## 4. P1 详细结果

### 4.1 Digest

章节理解不再复用普通聊天。独立 runner 向非流式 Provider 请求明确 JSON contract，接受纯 JSON/代码围栏 JSON，经 Zod 校验；首次无效时只进行一次 repair，仍无效则抛出可见的 `DIGEST_INVALID_RESPONSE`，不写伪数据。成功后存储 digest，并仅生成 `suggested` memory。后续 Context 可复用非 stale digest。

### 4.2 Memory proposal

普通脑暴不会创建记忆；只有“记一下/记住/就这么定/确定下来/定了”等明确作者意图才创建 `suggested` proposal。来源记录为 `sourceType=chat` 且 `sourceId` 与真实用户消息 ID 一致。只有用户点击“记录这条/确认”才进入 `confirmed`；拒绝和失败均有可见反馈。

### 4.3 Context integration 与 retrieval

Context 现在按任务集成人物、故事笔记、参考资料、非 stale digest、风格样本、相关灵感、Memory 和邻近章节。人物只有在姓名/别名与任务或正文信号相关时进入；故事/资料也按相关性召回。Memory 检索改为关键词和 n-gram 评分，避免整句 LIKE 的低召回。

### 4.4 章节顺序与历史去重

章节顺序改为卷 `order_index` → 章 `order_index` → 创建时间，不再按 UUID `parent_id` 排序。Context Engine 不再塞聊天；Runtime 仅在允许的 creative-thread 策略下加入当前 thread 一次，消除重复历史。

### 4.5 并发与 Provider 能力

Renderer 在发送前创建 requestId；Preload 使用单一 IPC listener 和按 requestId 分发的 router。每个 callback 只接收所属 stream，done/error 自动移除；卸载会取消仍在运行的请求。Runtime 在路由或配置阶段失败也会释放 controller，requestId 可安全重用。

OpenAI-compatible adapter 当前真实实现能力为 streaming/cancellation；tools/structured output 固定为 false，保存旧配置时也会归一化，设置页展示真实能力。默认模型仍承担全部任务，只有用户主动设置 route 才切换模型。

## 5. 测试与构建

最终门禁结果：

```text
npm run typecheck  PASS
npm run test       PASS — 14 files, 41 tests, 41 passed, 0 failed
npm run lint       PASS — 0 errors, 0 warnings
npm run build      PASS — Main / Preload / Renderer production bundles
npm run dist       PASS — Windows x64 NSIS installer 0.2.0
```

本地安装包：`release/墨记 Setup 0.2.0.exe`，104,855,098 bytes，SHA-256 `595391831280B460823B97148A41508E4863F5EEB7597448398A2C72EFF2CE85`。`release/` 按仓库既有规则忽略，不纳入源码提交。

未删除任何旧测试。另新增数据库 migration 测试，验证旧 `text_patches` 表升级及旧 proposed patch 自动 stale。Node 运行测试时打印 `node:sqlite` experimental warning，不影响结果。

## 6. 场景验收

| 场景 | 执行方式 | 结果 |
|---|---|---|
| A — quick chapter switch | 隔离 userData 的真实 Electron 进程；第一章输入后立即切第二章，再返回 | PASS，末句仍在 |
| B — quick close | 真实 Electron 点击标题栏 X；进程退出后用同一 userData 重启 | PASS，最新输入仍在 |
| C — rich-text patch | 真实 ProseMirror schema + bold mark + transaction 集成测试 | PASS，粗体/结构/快照均保留 |
| D — reader secret | 构造 future truth、private memory、idea、creative chat，检查最终 Provider messages | PASS，最终请求无秘密 |
| E — memory confirmation | Electron 中无模型配置运行“就这么定…记一下”，点击记录；另测普通脑暴与下轮召回 | PASS，先 suggested，用户确认后 confirmed 并可召回 |
| F — digest pipeline | 本地 fake provider 完整运行 trigger → JSON/repair → store → suggested memory → Context reuse | PASS；无效两次时明确失败且不落伪数据 |

真实 Electron 验收还覆盖了两部作品来回切换：甲作品正文、乙作品正文和甲作品 Memory 均未跨项目显示。验收发现 `window.prompt()` 在 Electron 不受支持，原“新建卷/章”入口实际不可用；已改为应用内 Modal，并把 Renderer 中同类 `prompt/confirm/alert` 全部替换为应用内确认或可见错误。

## 7. 未完成

- 因未提供最终用户 API Provider 凭据，未执行真实联网 Provider 集成测试；没有用 Mock UI 或伪响应冒充该项已验收。本地 adapter、streaming、取消、路由、错误映射和 fake-provider digest 均已测试。
- `Style origin range deferred`：本轮没有写入可能错误的 AI plain-text origin range，符合执行包“宁可缺记录，不要写错误记录”的允许方案。

## 8. Known Issues

- Renderer 生产 bundle 约 1.50 MB，功能构建通过，但后续体验优化可考虑按屏幕拆包；不影响本轮正确性门禁。
- 当前运行时使用 Node 内置 `node:sqlite`，测试环境会打印 experimental warning；数据库测试、WAL 持久化和打包均通过。

## 9. 本轮额外修复

- 修复保存 drain 并发等待提前完成的竞态。
- 修复 app quit 时 SQLite 早于 Renderer flush 关闭的问题。
- 修复快速连续点击章节时旧异步导航覆盖新目标的问题。
- Workspace 按 project id 重新挂载，避免切作品瞬间残留上一作品状态。
- 历史恢复后立即同步当前 Editor 内容。
- 特殊字符清洗为空时的全文检索不再产生无效查询。
- Provider 测试在缺配置/凭据时返回可见失败，而不是未处理异常。
- 补齐 ESLint 9 flat config，并清除全部 lint error/warning。
- 修复 Electron 不支持 `window.prompt()` 导致新建卷/章不可用，以及同类原生弹窗风险。

## 10. 判定

> Core Correctness Repair: PASS

该判定只覆盖本轮核心正确性修复，不代表擅自宣布整个产品 MVP 已完成。是否进入产品体验优化由后续审计决定。
