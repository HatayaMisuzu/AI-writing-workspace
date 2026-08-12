# V1 产品硬化执行报告

## 1. Baseline

- Start HEAD: `ec84bc38b312697a36891e058d7a778c87485195`
- Start origin/main: `ec84bc38b312697a36891e058d7a778c87485195`
- v0.3 implementation evidence: `16ee675109f93582934e701475b694b12d32c93c`
- v0.3 documentation commit: `ec84bc38b312697a36891e058d7a778c87485195`

## 2. 已知问题处理结果

| 项目 | 结果 | 核心处理 |
| --- | --- | --- |
| Memory lifecycle | PASS | 支持 confirmed 设定的替代、废弃、历史追踪；替代必须再次由作者确认，默认 Context 只召回当前有效设定。 |
| Digest stale candidate | PASS | 正文修订后摘要转 stale，并废弃未确认的旧章节候选；重新理解不会累积重复候选。 |
| Generation inserted state | PASS | 当前候选只允许插入一次；重启后历史回复不再重新出现“插入候选”。 |
| Chat thread access | PASS | 可新建、切换和恢复作品内的多个对话线程；首条消息自动形成可辨识标题。 |
| Proofreading location | PASS | 以 occurrence 与上下文定位重复文本，定位不唯一或正文已变化时拒绝错误应用。 |
| Style sample | PASS | 按作品、文档、来源和新鲜度采样；原始 AI 文本不入样本，人工连续修订后才保守采纳。 |
| Model display | PASS | 展示当前任务实际路由到的启用模型，禁用路由安全回退到默认模型。 |
| Retry | PASS | 错误消息重试绑定原始用户输入；取消中的部分内容可恢复且明确标记取消。 |
| Evidence SHA | PASS | 已修正旧报告中的 implementation SHA，不再把后续文档提交冒充实现提交。 |

## 3. Codex 自主发现并修复的问题

| 问题 | 作者影响 | 修复 | 验证 |
| --- | --- | --- | --- |
| 历史恢复只更新 SQLite，编辑器可能仍显示旧内容 | 作者会误以为恢复失败，继续编辑时有覆盖风险 | 同步刷新当前文档的 ProseMirror 内容并清理旧选区 | Electron G：恢复后正文和富文本标记正确 |
| 快速切章时可能读取已销毁的编辑器实例 | 连续管理长篇章节时偶发崩溃 | 只同步同一文档并检查 editor 生命周期 | Electron A：长章切换和返回通过，renderer errors 为 0 |
| 流式读取阶段取消会泄露底层 AbortError | 取消操作显示生硬技术错误 | Provider Adapter 统一转换为可识别的取消错误 | 单元测试覆盖首块数据后的取消；Electron B 通过 |
| Context 检查器只有来源，没有实际片段 | 作者难以判断 AI 是否引用了正确设定 | 加入短内容预览、来源与召回理由 | 确定性与真实 DeepSeek 讨论均显示 Context 检查器 |
| 长作品名和模型/范围标签会挤压布局 | 小屏写作区被破坏 | 对相关标签增加省略与宽度约束 | 1366×768 截图检查通过 |
| 长对话总是强制或完全不跟随末尾 | 阅读历史与等待回复互相干扰 | 仅在作者已接近底部时跟随最新消息 | Electron B 长对话、线程切换通过 |
| 校对抽屉与修改提案抽屉可同时遮挡正文 | 审核操作层级混乱 | 创建修改提案时关闭校对抽屉，只保留当前决策面板 | Electron F 截图与第二处重复文本应用通过 |
| AI 校对返回零问题时提示“需要配置模型” | 真实已执行结果被误判为未配置 | 区分“尚未运行”与“已运行且无明确问题” | 真实 Provider 校对入口通过 |
| 多个“新对话”难以区分 | 作者跨主题讨论时选错线程 | 首次发送时用用户输入生成短标题 | 持久化测试与 Electron B 通过 |

## 4. 自主发现但本轮未开发

- 全部第三方 OpenAI-compatible 服务的兼容矩阵：需要多家真实服务、不同流式方言和鉴权条件，不应在本轮凭单一供应商结果宣称全面兼容。
- 超大型作品树虚拟化与语义向量检索：当前 60k 字章节切换和现有作品隔离旅程已达标；引入索引或新依赖属于后续有真实规模证据后再做的架构工作。

## 5. Tests

- `npm run typecheck`: PASS
- Vitest files: 23 passed
- Vitest tests: 72 passed
- `npm run lint`: PASS（0 warnings）
- `npm run build`: PASS
- `npm run dist`: PASS

针对性测试覆盖记忆替代/废弃、摘要 stale 候选、生成插入状态、线程持久化、重复文本校对定位、样本隔离、模型路由、重试与流式取消。作品、文档、对话、记忆和 Context 的隔离边界均保留。

真实 Provider 补充验证：使用用户临时提供的 DeepSeek 服务（`https://api.deepseek.com` / `deepseek-v4-flash`）完成连接、流式讨论、记忆提案、章节理解、续写、编辑提案和 AI 校对，七项 PASS，page errors 为 0。凭据只通过测试进程环境注入，未写入仓库、报告或截图；隔离测试用户目录已删除。

## 6. Electron journeys

| Journey | 结果 | 验证内容 |
| --- | --- | --- |
| A | PASS | 建作品、写作、树管理、切章、搜索安全、灵感、历史、导出、重启、长章响应与跨作品隔离 |
| B | PASS | Provider 设置、流式、取消、错误、重试、多线程、重启与 Context 检查器 |
| C | PASS | 疑问不提案、明确记忆、确认、自然语言替代及 active Context 只保留新设定 |
| D | PASS | 摘要 fresh/stale、旧 suggested 候选废弃与重新理解 |
| E | PASS | 续写候选插入一次，重启后不重复提供插入操作 |
| F | PASS | 重复句只修改指定 occurrence |
| G | PASS | 富文本编辑提案、接受、AI 快照、diff 与恢复 |

确定性 Electron 旅程使用隔离本地测试服务；真实 Provider 旅程另行执行，未用 Mock UI 冒充真实联网验收。所有验收截图均来自本轮实际 Electron 运行并已逐张检查。

## 7. Known Issues

- 已验证 DeepSeek 这一条真实 OpenAI-compatible 路径，但这不等于所有第三方服务均已形成兼容性认证矩阵。
- AI 校对、摘要与生成的内容质量仍取决于最终用户配置的模型；应用层会保持定位、确认、隔离和失败边界，不把模型输出静默写入正文或 confirmed Memory。

## 8. Verdict

V1 Product Hardening: PASS WITH KNOWN ISSUES
