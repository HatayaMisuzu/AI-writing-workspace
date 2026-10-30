# 隐私说明

> 依据 origin/main `a68a3900cc8c9416687e4d4f07d05371251e0b96` 核对（「依据」一节的行号按 `6ca96b8` 记录，之后 main 只改了 `src/main/index.ts`、`src/main/ipc/register.ts`、`src/main/database/*`、`src/shared/ipc.ts`，相关行号可能偏移几行）。

一句话：**你的作品只存在你自己的电脑上。墨记只会连你自己填的模型服务地址，不会连别的地方。**

## 1. 数据存在哪里

- **所有作品数据**（正文、大纲、资料、人物、伏笔、时间线、快照、AI 对话、码字统计等）都存在一个本地数据库文件 `inkstone.sqlite` 里，放在系统给应用分配的用户数据目录下。
  - Windows 上一般是 `%APPDATA%\墨记\`（具体文件夹名：待核实）。
  - 数据库旁边还会有 `inkstone.sqlite-wal`、`inkstone.sqlite-shm` 两个临时日志文件，属于正常现象，不要单独删除。
- **设置**：模型服务配置、全局词表、全局提示词模板等也存在这个数据库里；每部作品自己的设置（例如小黑屋状态、人物悬停偏好）随作品一起存。没有另外的设置文件。
- **备份**：墨记不会自己在后台写备份文件。只有你点「创建项目备份」时，才会把这部作品导出成一个 `.aiwproj` 文件，保存到你选的位置。导出的正文同理。
- 备份文件里**不包含**模型服务地址和 API Key。

## 2. 什么时候会联网

- 墨记**只会**连你在「设置 → 模型与服务」里保存过的模型服务地址。其他地址一律拦截，包括应用界面里的请求和后台的请求。
- 联网只发生在你使用 AI 功能的时候（对话、执笔、润色、AI 校对、章节理解等）。这时你的正文和你选定的上下文会发送到你配置的地址。用本地模型（Ollama、LM Studio 等，地址是 `localhost`）时，内容不离开你的电脑。
- **测试连接**：你在设置里点「测试连接」时，会连一次你正在填写的地址，即使它还没保存。这次放行只在测试期间有效，测试完就撤销，不会把地址加进白名单。
- 模型服务如果返回「跳转到别的地址」，墨记会拒绝跳转。
- **小黑屋期间不联网**：只要有任何一部作品在小黑屋里，墨记就拒绝一切联网请求（所有作品的 AI 和测试连接都不可用），出网为 0。
- 点开正文里的外部链接会交给系统浏览器打开；小黑屋期间不会打开。
- 墨记**没有**自动更新、没有遥测、没有崩溃上报、没有统计分析，不收集任何使用数据。

## 3. API Key 怎么保存

- Key 保存时由墨记用操作系统提供的加密功能（Electron safeStorage；Windows 上基于系统的用户凭据保护，具体机制以系统为准）加密，再存进上面那个数据库。换一台电脑或换一个系统账号，这份加密的 Key 就解不开了，需要重新填写。
- 如果系统的加密功能不可用，墨记会直接报错，**不会**退而用明文保存。
- 保存之后，Key 不会再显示到界面上，界面只知道「已保存过 Key」。
- 本地模型（地址是 `localhost` / `127.0.0.1`）可以不填 Key。
- 你修改了服务地址（换了主机或端口）但没重新填 Key 时，墨记会拒绝保存，要求重新输入 Key，以免把旧 Key 发到新地址。
- 已知问题（待修）：如果有人能直接改你电脑上的数据库，把已保存的地址改掉，你再点一次「测试连接」时，Key 会被发往那个被改过的地址。前提是对方已经能写你本机的文件。

## 4. 不收集什么

没有账号、没有登录、没有云同步、没有遥测。墨记不会把任何东西发给墨记的开发者。

---

## 依据

基于 origin/main `6ca96b83ec487eec18a7aee6c5f595241c062108`。

- 数据库文件名与位置：`src/main/index.ts:49`（`join(app.getPath('userData'), 'inkstone.sqlite')`）。Windows 的具体目录名由 Electron 根据应用名决定（package.json `productName: "墨记"`，`name: "inkstone-writing-workspace"`），属于推断，待核实。
- WAL 日志文件：`src/main/database/schema.ts:2`（`PRAGMA journal_mode = WAL`）。
- 设置存在数据库：`src/main/database/schema.ts:274`（`app_settings` 表）；全局词表 `src/main/services/lint-service.ts:3`；作品设置 `projects.settings_json`（`src/main/services/focus-lock-service.ts:2`）。
- 服务配置与加密 Key 列：`src/main/database/schema.ts:192–197`（`provider_configs.encrypted_api_key BLOB`）。
- 备份只在用户操作时导出：`src/main/ipc/register.ts:339–346`（`backup:export-project` 弹保存对话框）；备份内容清单不含 `provider_configs`：`src/main/services/backup-service.ts:256–275`（`exportProject`）。
- 联网白名单：`src/main/network-policy.ts:49–70`（`decideNetworkRequest`，只放行已保存/临时 origin）；`src/main/index.ts:42–46,73–75`（渲染进程请求过滤）；主进程出站统一经 `src/main/net/egress-guard.ts:53–81`（`checkEgress`、`guardedFetch`），且只有 `src/main/ai/provider.ts:222`、`src/main/ai/anthropic-adapter.ts:68` 使用。
- 拒绝重定向：`src/main/net/egress-guard.ts:75–79`。
- 测试连接临时放行：`src/main/ipc/register.ts:301–331`（`providers:test`、`providers:test-url`，`allowOriginTemporarily` + `finally revoke()`）；`src/main/network-policy.ts:93–102`。
- 小黑屋断网：`src/main/network-policy.ts:104–106`（`focus-locked`）；`src/main/net/egress-guard.ts:60–64`；AI 入口锁：`src/main/ipc/register.ts:149,286,289,375,395`（`assertNotFocusLocked`），测试连接全局锁 `register.ts:302,314`（`assertNoFocusLockAnywhere`）；设计说明 `src/main/services/focus-lock-service.ts:24`。
- 外链：`src/main/index.ts:33–36`（`shouldOpenExternal(url, isFocusEgressLocked())`）。
- 无遥测/自动更新：`git grep -i "crashReporter|telemetry|analytics|sentry|autoUpdater" origin/main -- src package.json` 无结果；CI 禁止额外网络依赖 `scripts/ci/no-extra-network-deps.mjs:14`（引自 06-release-gap.md）。
- Key 加密：`src/main/index.ts:50–59`（`safeStorage.encryptString/decryptString`，不可用时抛 `SECURE_STORAGE_UNAVAILABLE`）；写入 `src/main/ai/provider.ts:61`。
- Key 不回传界面：`src/main/ai/provider.ts:39–45`（`list()` 只返回 `hasApiKey`）。
- 本地可空 Key：`src/main/ai/provider.ts:85–88`；预设 `src/shared/provider-presets.ts`（`PROVIDER_PRESETS`）。
- 换地址需重填 Key：`src/main/ai/provider.ts:56–58`。
- 测试连接未确认地址变更（已知问题）：`src/main/ipc/register.ts:301–309`。
- 界面隐私提示：`src/renderer/src/screens/SettingsScreen.tsx:143`。
