# 更新日志

本文件按 main 上已合入的 PR 整理，描述取自各 PR 标题；未合入的 PR 不列入。

## [0.4.0] - 未发布

### 安全

- S0: 升级 zod 至 ^4.6.7 修复 GHSA-mrhx-c7xc-m3w5（[#1](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/1)，[`7975b57`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/7975b57)）
- S1c：Base URL 仅允许 http/https，存量非法地址安全处理（[#4](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/4)，[`11678c6`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/11678c6)）
- S0b：升级 electron/vite/vitest 修复开发依赖漏洞，CI 增加含 dev 依赖的 audit 门禁（[#5](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/5)，[`777b42a`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/777b42a)）
- S1d：服务地址 query 密钥参数脱敏（[#6](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/6)，[`4ad52db`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/4ad52db)）
- S2：无其他出网（网络白名单 + CSP + CI grep）（[#11](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/11)，[`d4a70e9`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/d4a70e9)）
- P3-1：主进程出站守门（egress-guard）（[#27](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/27)，[`b3bf091`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/b3bf091)）

### 新增

- S3: 细纲表迁移 v5（node_outlines + outline 笔记；大纲暂不进 AI 上下文留给 S6）（[#3](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/3)，[`cbc3afc`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/cbc3afc)）
- S6：上下文来源清单可见可排除（大纲默认不发送；snapshot 记 id/类型）（[#9](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/9)，[`a3ba28d`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/a3ba28d)）
- S4：大纲视图 + 批量建章（[#12](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/12)，[`a55ae1c`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/a55ae1c)）
- S5：细纲进入 AI 上下文（[#13](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/13)，[`61d50a2`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/61d50a2)）
- S7：Provider 预设、空 key、超时、上下文窗口（[#14](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/14)，[`4a70028`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/4a70028)）
- S8：执笔多候选（默认 1、最多 3），选中后走插入型补丁（[#15](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/15)，[`3e116a6`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/3e116a6)）
- S9：writing_daily 日更统计表（数据层，v7）（[#16](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/16)，[`d1ad3af`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/d1ad3af)）
- S10：日更面板（统计展示 + 可选目标 UI）（[#17](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/17)，[`b6f5382`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/b6f5382)）
- S11：章节状态与存稿（迁移 v8）（[#18](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/18)，[`fc4d85b`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/fc4d85b)）
- S12：伏笔台账 + 记录员候选 + 人物卡字段（迁移 v9）（[#19](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/19)，[`eee080a`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/eee080a)）
- P1-1 F9：时间线（迁移 v10）（[#20](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/20)，[`b455737`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/b455737)）
- P1-2 F12：导出 TXT/MD/DOCX 按章节范围 + 仅定稿；修 PR20 遗留（[#21](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/21)，[`0dec484`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/0dec484)）
- P1-3 F10：章节字数区间提示；PR21 导出遗留修复（[#22](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/22)，[`6ce84cb`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/6ce84cb)）
- P1-4 提示词模板 + PR22 遗留（[#23](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/23)，[`3214b9f`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/3214b9f)）
- P1-5：读者视角审稿 reader_review 补完（[#24](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/24)，[`99220d6`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/99220d6)）
- P1-6：记录员·一致性检查（只读冲突报告）+ 三条修复（[#25](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/25)，[`b98c600`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/b98c600)）
- P1-7：Anthropic 原生适配器（ProviderAdapter 接口 + Messages API）（[#26](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/26)，[`a882181`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/a882181)）
- P3-e：同类设定确定排序（钉住>已确认>本章提及>最近更新>id）+ 清单/snapshot 入选/省略依据（[#28](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/28)，[`c075178`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/c075178)）
- P3: 提示词模板全局化（全局默认 + 本书开关 + 预览确认复制）（[#29](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/29)，[`f5d422d`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/f5d422d)）
- P3 L4: Visibility and pinning for context entries dropped by count limits (+L6/L8)（[#30](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/30)，[`46a3577`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/46a3577)）
- P3: Pins per mode (当前对话 / 检查一致性 separate)（[#31](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/31)，[`a727bd4`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/a727bd4)）
- P3: Narrow screens (≤1080px) assistant panel as overlay drawer（[#32](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/32)，[`f171bed`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/f171bed)）
- F15 小黑屋：作品级锁定写作（锁定期间 AI 关闭、网络 0 请求）（[#33](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/33)，[`40369db`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/40369db)）
- F15 lock clarity: name the locked book, refusal list, Esc closes emergency dialog（[#34](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/34)，[`e7d1be2`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/e7d1be2)）
- F14: 人物名悬停（只读卡片 / 匹配器 / 本章提及切换）+ F15 fail-closed 修复（[#35](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/35)，[`3469fa1`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/3469fa1)）
- F13: 本地校对词表、按类开关、本章批量提案与全部接受、全书检查（[#37](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/37)，[`36725c7`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/36725c7)）
- P3 PR-1：章内查找替换（Ctrl+F/H）+ 本章大纲跳转（[#39](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/39)，[`c380373`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/c380373)）
- P3 PR-2a：全书查找（只查找，按章分组，10 万处截断）[B+]（[#40](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/40)，[`24b44bb`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/24b44bb)）
- P3 PR-2b：全书替换（单事务）+ 快照整批恢复 [A]（[#41](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/41)，[`25df475`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/25df475)）

### 修复

- S1e：备份节点按层级父节点在前排序，修复导入 FK 失败（[#8](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/8)，[`0ded24d`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/0ded24d)）
- O1：新对话清空上下文排除态（与切换对话一致）（[#10](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/10)，[`2a1f08b`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/2a1f08b)）
- P3: 词表导入 1MB 上限（stat 先检查）+ 小黑屋 spec 补充（A 级）（[#38](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/38)，[`1aae3d0`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/1aae3d0)）
- fix(db): quiet checkpoint release before autocheckpoint restore (A)（[#42](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/42)，[`6ca96b8`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/6ca96b8)）
- P3：will-quit 5s 上限 + diagnostics 门控（无 dbPath）+ quiet===true（A）（[#43](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/43)，[`4d6d5fd`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/4d6d5fd)）
- P3：长段 Ctrl+End / 校对定位到段末不再卡住（renderer）[B+]（[#44](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/44)，[`8678446`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/8678446)）
- P3 夜间小修：空书名、记忆提案报错文案、关闭校对折叠选区、重命名同步大标题、窄侧栏徽标（B+）（[#47](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/47)，[`9fe3f12`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/9fe3f12)）
- P3 PR-53（A）：退出预算按工作量限制——worker 段硬上限 + 退出前检查点 + journal_size_limit/定期写回；WAL ≤ 8MB 时总时长 < 5s（[#51](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/51)，[`5679058`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/5679058)）

### 性能

- perf(editor): 长章节按键提速 + 连续输入保存 2s 上限（[#36](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/36)，[`d2fe53e`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/d2fe53e)）
- perf(renderer): 保存后章节树局部补丁 + measure 按 rAF 合帧 (B+)（[#46](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/46)，[`56c98ae`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/56c98ae)）
- P3：章树 contain: layout size，修千章书按键卡顿（第①步，B+）（[#50](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/50)，[`ac5051c`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/ac5051c)）

### 测试与 CI

- S1: Linux CI 构建（ubuntu-24.04 job + linux dir 产物冒烟）（[#2](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/2)，[`f860828`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/f860828)）
- S1b：Linux CI 运行 Electron e2e（真实 keyring，不削弱安全存储）（[#7](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/7)，[`d9c14ba`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/d9c14ba)）
- P3 H-W1：G 释放后首存 COMMIT 判定——≥50ms 须证明 WAL 复用而非同步检查点（B，只改测试）（[#45](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/45)，[`c959618`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/c959618)）
- P3：quit-stuck 断言分段（B，只改测试）（[#48](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/48)，[`a68a390`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/a68a390)）

### 文档

- docs：README / PRIVACY / RECOVERY + 全书替换整批恢复文案（B）（[#49](https://github.com/HatayaMisuzu/AI-writing-workspace/pull/49)，[`e891fc9`](https://github.com/HatayaMisuzu/AI-writing-workspace/commit/e891fc9)）
