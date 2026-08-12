# 墨记（Inkstone）

墨记是一个 Electron + React + TypeScript 的本地桌面长篇写作应用。它面向持续创作多部作品，而不是一次性生成文章：作品库是应用级入口，每部作品的正文、故事资料、人物、参考资料、记忆、AI 对话、全文检索、历史快照和备份都按 `project_id` 隔离。

## 当前能力

- 多作品库、最近写作、归档与快速切换
- 卷/章树、拖拽排序、Tiptap 富文本编辑、自动保存、字数统计、专注模式
- SQLite WAL 本地持久化、项目内全文检索、短关键词回退检索
- 定时/手动/大段删除/AI 修改前快照与恢复
- 故事资料、人物卡、参考资料、灵感、项目记忆
- `.aiwproj` 完整项目备份与恢复，TXT/Markdown 导入，TXT/Markdown/DOCX 导出
- 通用 Provider / Model Manager：由用户在运行后填写 Provider、Base URL、API Key 与 Model ID
- 默认单模型处理全部 AI 任务；只有用户主动设置任务路由时才使用多模型
- OpenAI-compatible 流式适配器、取消、401/429/网络错误归一化
- Reader Context、章节摘要、风格样本检索、建议记忆状态机、可审阅文本补丁

## 运行

需要 Node.js 22+ 和 npm。

```powershell
npm install
npm run dev
```

无需 `OPENAI_API_KEY`，也无需任何真实 API 凭据即可启动、构建、编辑、保存、检索、备份和运行本地测试。AI 功能使用前，在“设置 → 模型与服务”中添加自己的兼容 Provider、Base URL、API Key 和 Model ID。

```powershell
npm run verify  # 类型检查、19 项测试、生产构建
npm run dist    # 生成 Windows NSIS 安装包
```

## 本地数据与安全

- 数据库位于 Electron `userData` 目录，使用 SQLite WAL。
- Renderer 启用 `contextIsolation`，禁用 `nodeIntegration`，只通过类型化 preload API 访问主进程。
- API Key 只在主进程中处理，并通过 Electron `safeStorage` 加密后持久化；不会注入 Renderer。
- AI 上下文构建必须携带 `projectId`，Reader Context 不读取未来章节、私有笔记、灵感或聊天记录。
- AI 修改先生成可审阅补丁；接受前校验原文哈希并创建快照。

## 说明

本项目没有用 Mock UI 或伪响应宣称真实 AI 已验收。Provider 接口、任务路由、Streaming、取消与错误处理已做本地测试；由于未提供用户 API 凭据，真实联网 Provider 集成测试明确未执行。详见 [执行与验收报告](docs/EXECUTION_REPORT.md)。
