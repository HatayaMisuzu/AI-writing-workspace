# 审查收敛与发布验收报告

执行日期：2026-09-09 至 2026-09-10

## 基线

- 开始 `HEAD`：`f83d2f6b0d6ba8448472b66ec7a522a4e9267f7f`
- 开始 tree：`3f16073fdb626bcbaf0daa599a1d8f854a2946a6`
- `origin/main`：`e131c2a41037302faa681062d56629de80b2a248`
- 保留了本地 `f83d2f6` 的 round-1 修复，没有 reset 到更旧远端。
- 工作开始时仓库干净；本轮在 `codex/audit-completion-20260909` 分支执行。

## 修复结果

| 范围 | 当前行为 | 主要验证 |
|---|---|---|
| U03 / U04 异步目标漂移 | AI 编辑和续写消息冻结 project、document、revision、request 与选区原文身份；切章不重绑定，旧 revision 不可应用 | Electron 同字 A/B 跨章编辑与插入 |
| U01 / F10 校对坐标 | 本地 issue 绑定当前全文 hash 和原文；输入立即清空旧 issue；嵌套 PM 映射使用真实节点位置并拒绝虚拟分隔符范围 | 嵌套 blockquote/list/hardBreak/mark/emoji 单测与 Electron stale lint |
| F01 / F08 摘要记忆 | 摘要冻结 source revision，拒绝旧结果和乱序旧请求；候选记录 digest/revision，confirm 在事务内复核；status 纯读；suggested 不进入事实上下文 | revision 竞态、乱序、纯读、stale confirm 测试 |
| F02 token 预算 | 最终 Provider messages（system/context/history/user）受模型输入预算约束；长摘要和校对确定性分段 | 最终消息预算与长文分段测试 |
| F03 / F04 备份恢复 | 100 MiB 上限、Zod 基础 schema、枚举/数字/引用/编辑器 JSON/replacement 图校验；memory 两阶段恢复；原子覆盖；空章按空内容导出 | 21 次随机顺序、多代关系、cycle rollback、空章导出 |
| U02 辅助草稿 | 故事、参考、人物、灵感和快速灵感在正常导航/关闭前自动保存；失败阻止离开 | Electron 故事草稿跨页恢复 |
| F05 / F09 Provider | error event、协议错误、unexpected EOF、timeout/cancel 分状态；`test` 复用完整响应校验；默认模型/route 更新事务化 | Provider fixture 单测与 Electron EOF/cancel |
| F06 / F07 | 聊天使用 `(created_at,id)` 游标；人物 partial update 保留 omitted 扩展字段 | 60 条同毫秒分页、人物字段回归 |
| IPC / sandbox | 主 frame/origin guard；关键写接口 Zod 校验；移除未使用高权限 preload API；sandbox 启用 | 生产 Electron 启动与完整 E2E |
| 迁移 | schema v4，有序事务迁移，拒绝未来版本；v3 fixture 保留内容与既有配置 | migration suite |

此外，“最近”现在表示最近 30 天；章节可拖入空卷；Tiptap 家族统一为 `3.31.3`。

## 可重复验收

- `npm ci`：通过，577 packages。
- `npm run verify`：通过；lint、typecheck、27 个 Vitest 文件 / 95 项测试、production build 全部成功。
- `tests/electron-e2e.mjs`：10/10 通过，使用临时 `userData` 和本地 OpenAI-compatible HTTP fixture。
- `npm run dist`：标准 Windows CI 使用 Electron 43.3.0 通过，生成 NSIS 安装包。
- packaged app smoke：标准 Windows CI 确认安装包内的 `墨记.exe` 以 Electron 43.3.0 和隔离 `userData` 启动并显示作品库。
- `npm audit --omit=dev`：0 vulnerabilities。
- `npm audit`：2 moderate，均来自开发期 Vitest / `@vitest/mocker`；官方自动修复要求升级到 Vitest 5，未在本轮强制做破坏性 major upgrade。

首轮正式发布全链路证据：[GitHub Actions run 34435092259](https://github.com/HatayaMisuzu/AI-writing-workspace/actions/runs/34435092259)，制品名 `inkstone-windows`。

## 本地环境说明与仍需决策项

- 本机无法连接 Electron 二进制下载源。本地 E2E/打包曾明确复用机器上已存在且通过 E2E 的 Electron 40.10.2 runtime；这只能证明功能链路，不作为正式发布制品。正式 `dist` 现会拒绝运行时覆盖和版本错配；标准 Windows CI 已按 lockfile 使用 Electron 43.3.0，并通过安装包内实际运行时版本冒烟校验。
- 本轮未使用真实付费 Provider 凭据；协议与状态机由本地 fixture 验收。具体第三方兼容性需在设置页测试。
- 仓库没有明确 LICENSE。许可证必须由权利人决定，本轮没有擅自添加。
