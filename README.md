# 墨记（Inkstone）

墨记是一个 Electron + React + TypeScript 的本地桌面长篇写作应用。它面向持续创作多部作品，而不是一次性生成文章：作品库是应用级入口，每部作品的正文、故事资料、人物、参考资料、记忆、AI 对话、全文检索、历史快照和备份都按 `project_id` 隔离。

## 当前能力

- 多作品库、最近 30 天筛选、归档与快速切换
- 卷/章树、跨卷与空卷拖拽排序、Tiptap 富文本编辑、自动保存、字数统计、专注模式
- SQLite WAL 本地持久化、项目内全文检索、短关键词回退检索
- 定时/手动/大段删除/AI 修改前快照与恢复
- 故事资料、人物卡、参考资料、灵感、项目记忆
- `.aiwproj` 项目备份与恢复（100 MiB 输入上限、关系与引用校验、原子导出），TXT/Markdown 导入，TXT/Markdown/DOCX 原子导出
- 通用 Provider / Model Manager：由用户在运行后填写 Provider、Base URL、API Key 与 Model ID
- 默认单模型处理全部 AI 任务；只有用户主动设置任务路由时才使用多模型
- OpenAI-compatible 流式适配器、取消、401/429/网络错误归一化
- 可持久化 AI 对话、显式章节理解状态、保守的记忆意图识别、来源安全的风格样本
- 本地规则校对、可审阅 AI 校对提案、历史版本差异与可恢复修改

## 运行

需要 Node.js 22+ 和 npm。

```powershell
npm install
npm run dev
```

无需 `OPENAI_API_KEY`，也无需任何真实 API 凭据即可启动、构建、编辑、保存、检索、备份和运行本地测试。AI 功能使用前，在“设置 → 模型与服务”中添加自己的兼容 Provider、Base URL、API Key 和 Model ID。

```powershell
npm run verify  # lint、类型检查、完整本地测试、生产构建
npm run test:e2e # 临时用户目录 + 本地 Provider fixture 的 Electron 关键旅程
npm run dist    # 生成 Windows NSIS 安装包
```

## 本地数据与安全

- 数据库位于 Electron `userData` 目录，使用 SQLite WAL。
- Renderer 启用 `contextIsolation`，禁用 `nodeIntegration`，只通过类型化 preload API 访问主进程。
- API Key 在设置表单输入时短暂存在于 Renderer；保存后由主进程通过 Electron `safeStorage` 加密持久化，已保存密钥不会回传 Renderer。
- AI 上下文构建、对话、记忆、摘要与风格样本都必须携带 `projectId`，不同作品不会互相检索或注入。
- AI 修改与续写候选绑定发起时的来源章节和 revision；切章不会重绑定目标，来源正文变化后旧结果会被拒绝。
- AI 修改先生成可审阅补丁；接受前校验章节、revision、原文哈希并创建快照。
- 章节理解生成的 `suggested` 记忆只是待确认候选，不进入长期事实上下文；只有作者确认后才生效。
- 故事/参考笔记、人物、灵感和快速灵感在正常导航或关闭前会自动保存，保存失败则阻止离开。

`.aiwproj` 恢复会先验证结构、项目内引用和 memory replacement 图，再在单一事务中写入。坏引用、自引用或环会被拒绝且不留下半个项目；合法空章节会按空内容导出。备份仍应作为本地恢复副本使用，不替代操作系统级多副本备份。

## 说明

Provider 接口、任务路由、Streaming、取消、超时与错误处理使用本地确定性 OpenAI-compatible fixture 验收，不需要真实付费凭据。本轮没有重新执行真实联网 Provider 测试；具体服务的兼容性仍应使用设置页“测试连接”确认。详见 [核心正确性修复报告](docs/CORE_CORRECTNESS_REPORT.md)；此前执行证据保留在 [初版执行报告](docs/EXECUTION_REPORT.md)。

仓库目前没有明确 LICENSE；发布或对外分发前需由权利人选择许可证。
