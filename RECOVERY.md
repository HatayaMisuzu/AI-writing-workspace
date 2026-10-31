# 数据恢复指南

> 依据 origin/main `a68a3900cc8c9416687e4d4f07d05371251e0b96` 核对（「依据」一节的行号按 `6ca96b8` 记录，之后 main 只改了 `src/main/index.ts`、`src/main/ipc/register.ts`、`src/main/database/*`、`src/shared/ipc.ts`，相关行号可能偏移几行）。

## 1. 崩溃、断电之后

**先别慌，直接重新打开墨记。**

- **自动保存**：你停笔约 0.7 秒就会保存；一直不停地打字，最迟约 2 秒也会存一次。切换章节、关闭窗口、退出、进小黑屋、导出备份之前，墨记都会先把没存的内容存掉。所以崩溃或断电时，通常最多丢掉**最后一两秒**打的字（机器严重卡顿时可能更多）。
- **要么全存，要么不存**：每次保存都在一个数据库事务里完成，不会出现「存了一半」的章节。全书替换、整批恢复、导入备份也一样：中途出错就整批作废，一个字都不写。
- **重启后自动修复**：数据库使用 SQLite 的 WAL 日志模式。重新打开时，SQLite 会自动处理上次没来得及合并的日志，墨记没有额外的「恢复向导」（这部分是 SQLite 自身机制，属于推断）。
- 如果某一章看起来不对，去这一章的「历史」里找最近的快照恢复（见下一节）。
- 正常退出时（关窗前先把没存的内容存掉之后），墨记先等后台的日志合并（WAL 检查点）收尾，最多等 3.5 秒，超时就停掉它；然后把日志里还没合并的部分合并进数据库再关闭。还没合并的日志不超过约 8MB 时，整个退出在 5 秒内完成；更多时（例如大批量操作后马上退出）可能超过 5 秒，但照常合并，已保存的内容不会丢；万一中途被打断，内容仍在数据库或日志里，下次打开由 SQLite 恢复。
- 注意：目前墨记没有专门处理程序崩溃的弹窗或报告。

## 2. 快照

### 什么时候会自动拍
| 历史里显示 | 什么时候拍 |
|---|---|
| 定时保存 | 保存某章时，如果离这一章上次快照已满 10 分钟 |
| 大段删除前 | 一次保存比上次少了 1000 字以上 |
| AI 修改前 | 接受 AI 补丁、采用候选稿、全部接受 AI 校对之前 |
| 全书替换前 | 全书替换时，每一章各拍一份 |
| 恢复前备份 | 每次恢复快照之前，先把当前内容存一份 |
| 手动快照 | 你在「历史」页点「手动快照」 |

### 怎么恢复
1. 打开这一章，进入「历史」。
2. 选一个快照，可以先和当前正文对比差异。
3. 点恢复。恢复之前墨记会自动把当前内容存成「恢复前备份」，所以恢复本身也可以反悔。
4. 如果恢复的是「AI 修改前」快照，这次采纳的 AI 字数会从统计里扣回去。

快照目前**没有数量上限**，不会自动清理。

## 3. 全书替换后整批恢复

- 全书替换前，墨记会给每个被替换的章节拍一份「全书替换前」快照。
- 替换完成后，提示条上有「撤销本次全书替换」的按钮，点一下就整批恢复。
- 整批恢复时，如果某一章在替换之后**你又改过**，或者已经被删了，这一章会被跳过，结果窗口会列出来，不会覆盖你后来写的内容。每章恢复前也会先拍「恢复前备份」。
- 被替换的当前章，编辑器的撤销记录会清空，Ctrl+Z 退不回替换前，请用上面的整批恢复。
- 整批恢复只能在全书替换页进行，而且只针对**最近一次**全书替换。在同一部作品里切到别的区段再回来，按钮还在；关闭这部作品或重启应用后就没有了。错过了的话，只能逐章去「历史」里恢复「全书替换前」快照（历史页没有整批恢复）。

## 4. 备份：导出与导入

### 导出
- 在作品库里，打开作品的菜单 →「**创建项目备份**」，选择保存位置，得到一个 `.aiwproj` 文件。
- 备份包含这部作品的正文、目录、大纲、资料、人物、记忆、伏笔、时间线、快照、AI 对话、码字统计等。
- 写文件时先写临时文件再替换，导出中途出错不会把你原来的同名备份弄坏。
- **不包含**：模型服务配置和 API Key、全局词表、全局提示词模板（这两样请在校对页 / 提示词模板页单独导出）。
- 每部作品要单独导出，没有一键导出全部。

### 导入
- 在作品库点「**导入备份**」，选择 `.aiwproj` 文件。
- 导入会**新建**一部作品，标题后加「（已导入）」，**不会覆盖**已有作品。
- 文件超过 100 MB 会被拒绝。文件损坏或内容不完整时，整个导入作废，不会留下半部作品。

### 建议
- 换电脑、重装系统、升级之前，给每部作品导出一次备份，再另外拷一份到 U 盘或网盘。
- 也可以在**完全退出墨记后**，把整个数据目录（含 `inkstone.sqlite` 和同名的 `-wal`、`-shm` 文件）一起复制保存（推断，未在代码中提供此功能）。

---

## 依据

基于 origin/main `6ca96b83ec487eec18a7aee6c5f595241c062108`。

- 自动保存节奏与 flush 路径：`src/renderer/src/services/save-coordinator.ts:10–16,43–56`（`SAVE_IDLE_DELAY_MS = 700`、`SAVE_MAX_WAIT_MS = 2000`、`schedule`、`flush`）。卡顿时可能更晚：定时器依赖 `setTimeout`（06-release-gap.md「保存调度没有兜底」）。
- 保存在事务内：`src/main/services/document-service.ts:229`（`saveContent` → `db.transaction`）；事务实现 `src/main/database/database.ts:187`（`BEGIN IMMEDIATE`）。
- 退出上限：`src/main/database/database.ts`（`QUIT_CLOSE_LIMIT_MS = 5_000`、`closeForQuit`）、`src/main/index.ts`（`will-quit`）。
- WAL：`src/main/database/schema.ts:2–4`；启动时打开库、迁移：`src/main/database/database.ts:47–64`。无额外启动恢复逻辑、无崩溃处理器：`src/main` 中 grep `uncaughtException|render-process-gone` 无结果（06-release-gap.md）。
- 快照触发：定时 10 分钟 `document-service.ts:224–228`；大段删除 >1000 字 `document-service.ts:222–223`；AI 修改前 `src/main/services/patch-service.ts:58,90`、`src/renderer/src/components/EditorSurface.tsx:256`；手动 `src/renderer/src/screens/ProjectViews.tsx:123`；快照类型 `src/main/ipc/schemas.ts:84`；显示文案 `src/renderer/src/services/snapshot-label.ts:3–6`。
- 恢复与恢复前备份、扣回 AI 字数：`document-service.ts:395–419`（`restoreSnapshot`）。
- 无快照上限：document-service/schema 中无修剪逻辑（06-release-gap.md「快照没有保留上限」）。
- 全书替换与整批恢复：`document-service.ts:305–333`（`replaceBatch`，出错整批 ROLLBACK）、`337–365`（`restoreBatch`，跳过 changed/deleted，写 `pre_restore`）；IPC `src/main/ipc/register.ts:121–123`；界面 `src/renderer/src/screens/BookFindView.tsx:106–115,133,148,151`；只保留最近一次批次的状态 `BookFindView.tsx:24`（状态放在 WorkspaceScreen 的 `useState`，`WorkspaceScreen.tsx:161`，不落库）。`restoreBatch` 在 renderer 中只有 `BookFindView.tsx:108` 一处调用，历史页 `ProjectViews.tsx:116–124` 只有逐章恢复。
- 撤销栈清空：`src/renderer/src/screens/WorkspaceScreen.tsx:164`。
- 备份导出：`src/main/ipc/register.ts:339–346`；内容 `src/main/services/backup-service.ts:256–275`（`exportProject`）；原子写 `backup-service.ts:76–89`（临时文件 + rename）；全局模板只存指纹 `backup-service.ts:273`；全局词表/模板不随作品备份 `src/renderer/src/screens/ProofingView.tsx:58`、`PromptTemplatesView.tsx:113`。
- 备份导入：`register.ts:347–351`；`backup-service.ts:277–330`（100 MiB 上限 `:58,279`、校验 `:283`、新 id `:288–302`、标题加「（已导入）」`:328`、单事务 `:326`）。
- 作品库菜单文案：`src/renderer/src/screens/LibraryScreen.tsx:42,65`（「导入备份」「创建项目备份」）。
