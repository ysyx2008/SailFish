# 联络派出去的活，回执只交给联络（秘书模型）

> 2026-10-10 · 已完成
>
> 设计目标见 `electron/services/agent/SPEC.md`「联络任务管理」成功标准 4–7 及对应取舍；CLI 部分见 `electron/cli/SPEC.md`「任务值班」。

## 背景

本分支上一版：任何任务（不分谁开的头）做完 / 失败 / 被停 / 要确认，`TaskSupervisor` 都经 `deliverProactiveMessage` 往联络线推一张卡片（IM + 桌面 + 系统通知 + 落 `__proactive__` 记录），同时 `appendProactiveContext` 给联络塞一张 30 分钟过期的暂存纸条。正式版（develop / main）没有这套。

问题：联络派的活，系统绕过联络直接找用户；联络自己盯着结果时还会重复（截图那次）；纸条过期后用户在微信上回「批准」联络接不上。用户自己开的任务则根本不该往联络那边送东西。

## 方案总览

1. **这一轮谁开的头**记在这一轮上：联络经 `manage_tasks create / instruct` 开的头 → `ledBy: 'companion'`；其余一律视为用户。往一场正在跑的轮里补话不改归属。
2. 任务事件按归属分流：
   - 用户开头：**什么都不送**（不推卡片、不写纸条、不叫醒联络）。
   - 联络开头：拼成一份**回执**交给联络 Agent。
3. 回执覆盖三类事件：结束（成功 / 失败 / 被停，5 秒防抖合并）、要确认（立即）、任务向用户提问（立即，新增挂钩）。立即类发出时把挂着的结束事件一起带上。
4. 交给联络走它收后台结果的同一条路（与 `deliverBackgroundNotice` 同一套时机判断）：主循环开着就静默插进这一轮（叫醒等待、打断正在思考的请求）；否则排队，闲下来以 `internalNotice` 另起一轮。与后台结果的两处不同：
   - 不受「用户按停后不再送回」限制——回执必须处理。
   - 另起一轮时用宿主给的界面回调（桌面 = 推联络页；CLI = 打印），不沿用联络上一轮留下的回调（上一轮若是微信，那套回调会把过程直接发到微信）；没有可续的上下文时用本机助手 + 桌面渠道兜底。
5. 回执轮开头写一个 `task_receipt` 步骤（内容即回执文本），不上用户气泡；照常落盘进联络会话（不起标题、不进向量索引——`internalNotice` 已有行为）。
6. 联络在回执轮里只有 `talk_to_user` 会到用户手里（IM 最近联系人 + 桌面）；回执轮自己的文字留在桌上。
7. 桌面联络页：回执轮整段折叠成一行（只有 `talk_to_user` 这类对外发出的、以及要用户动手的留在外面），折叠行写「处理了任务回执」；不挂「任务完成」脚注。
8. 删掉 `TaskSupervisor` 里所有推卡片 / 写纸条的代码（`deliverProactiveMessage`、`appendProactiveContext` 的任务用法与对应 i18n 文案）。

不做：`manage_tasks` 不加「等它做完」；不把渠道直通到某场任务；关切 / 唤醒不参与；不看觉醒开关。

## 改动点

### A. 这一轮的归属（agent 模块）

- `AgentRun.ledBy?: 'companion'`、`RunOptions.ledBy`；`Agent.say` 开新一轮时透传，补话忽略。
- `AgentService.say` 的 `opts.ledBy` 原样传下；`TaskSupervisorHost.say` 签名同步；`createTask` / `instructTask` 传 `'companion'`。
- `TaskRunFinishedEvent` / `TaskNeedsConfirmationEvent` 加 `ledBy`；`finalizeRun`、`handleError`、确认挂钩从 `run.ledBy` 取。
- 新挂钩：`Agent.addStep` 加出 `asking` 步骤时（非伙计）调 `taskSupervisor.handleAsking(agentKey, { question, options, ledBy })`。

### B. 回执（agent + task-supervisor）

- `Agent.deliverTaskReceipt(text, { callbacks?, fallbackContext })`：时机判断同 `deliverBackgroundNotice`；独立的排队与冲刷，`run()` 收尾时一并冲刷。
- `RunOptions.noticeKind?: 'task_receipt'` → `initializeRun` 在 `internalNotice` 时写 `task_receipt` 步骤。
- `AgentService.deliverCompanionReceipt(text)`：取 / 建 `__companion__`，带 `uiCallbacksFor(__companion__)` 与兜底上下文调 `deliverTaskReceipt`。
- `TaskSupervisor`：三个 handle 只认 `ledBy === 'companion'`；结束进缓冲 5 秒防抖；确认 / 提问立即发并带上缓冲；`flushPendingEvents` 冲缓冲。

### C. 提示词（需用户审）

`manage_tasks` 的 `create` 一句：

- 旧：「……任务只看得到 brief，看不到这条对话，也没有这个工具。确认和做完的结果会回到这条线。没设 full_auto 时……」
- 新：「……任务只看得到 brief，看不到这条对话，也没有这个工具。由你开头的这一轮，做完、失败、被停、要用户确认、向用户提问，都会以回执交给你，用户不会直接收到：你正在回复就送进这一轮，否则另起一轮。没设 full_auto 时……」

`instruct` 末尾加：「由你再交代而接着做的这一轮，回执同样交给你。」

`create` 返回：「已创建任务「{title}」（task_id={taskId}），正在执行（{mode}）。完成或需要确认时会回到这条线。」→ 末句改为「这一轮的回执会交给你。」

回执（中文；英文同义）：

```
任务回执（由你开头的这一轮，用户没有直接收到）：
- 「{title}」（task_id={id}）{已完成|失败|已停止}：{summary}
- 「{title}」（task_id={id}）在等用户确认：{tool}，风险 {risk}，参数 {args}，tool_call_id={toolCallId}
- 「{title}」（task_id={id}）向用户提问：{question}（选项：{options}）
这一轮用户看不到；要告诉用户的话用 talk_to_user。用户的答复用 manage_tasks confirm 或 instruct 转给那场。
```

### D. 前端（联络页渲染）

- `shared-types` 步骤类型加 `task_receipt`。
- `agent-task-groups`：`task_receipt` 起新分组 `isReceipt`。
- `process-fold`：`desk` 模式——只有对外发出的（`talk_to_user` 等）和要用户动手的留在外面，其余（含它写的文字）全收；折叠行带 `desk` 标记。
- `useAgentMode.flattenedItems`：回执组不出用户气泡、用 `desk` 折叠（调试模式除外）、不挂完成脚注。
- `ProcessTurnFold`：`desk` 折叠行做完时写「处理了任务回执」+ 动作计数；跑着时照常播报。
- 步骤图标、i18n 中英。

### E. CLI `companion` 值班

- 给 `AgentService` 设界面回调工厂：联络的回执轮也按现有格式打印。
- 值班条件：有联络开头的任务在跑，或联络在跑。
- 联络的回执轮里用过 `talk_to_user` 时，打印后读一句用户输入（终端不是交互式、或直接回车，就跳过），作为用户对联络说的话 `say` 回去。不再由 CLI 直接 `confirmTask`。
- 退出前冲刷回执，并在剩余时限内等联络把这轮处理完。

## 任务拆解

- [x] 1. **归属贯通**（A）。验收：单测——`createTask` / `instructTask` 开的那一轮 `ledBy=companion`；界面 `say` 开的没有；补话不改归属；事件带上 `ledBy`。
- [x] 2. **回执**（B + C）。验收：单测——用户开头的三类事件什么都不送；联络开头的不调 `deliverProactiveMessage`、不写纸条，改调 `deliverCompanionReceipt`，结束 5 秒合并、确认 / 提问立即并带上缓冲；`deliverTaskReceipt` 在跑插入、空着另起 `internalNotice` 轮并写 `task_receipt` 步骤、用传入回调、不受按停影响。
- [x] 3. **联络页渲染**（D）。验收：前端单测——`task_receipt` 起回执组；`desk` 折叠只留 `talk_to_user`；`typecheck:src`。
- [x] 4. **CLI 值班**（E）。验收：`sailfish companion` 真跑：派任务 → 回执叫醒联络 → 打印它对用户说的话。
- [x] 5. **回归 + 审查 + 文档**：vitest 全量、`test-cli.sh --no-ai`、两个 typecheck、claude-review；`docs/ideas.md`；本文件改 `done-`。

实际提交：1+2 合为 `d9240df7`（归属与回执同改一组文件，分开反而要写一版马上就丢的中间代码）；3 = `d5f9b535`；4 = `ab95421d`；审查后修正 = `5085bde6`。

与方案的出入：

- 回执和后台结果共用同一道「另起一轮」的门，避免两边同时开跑撞在一起；回执另起一轮时环境接着联络上一轮（渠道、会话），只有回调换成宿主界面。
- 这一轮收场时还没送进对话的回执挪回队列，等闲下来另起一轮，不丢。
- 回执另起的一轮不清「用户按停过」的标记（原来每次开跑都清）。
- 命令行 `--free` 下联络交办的任务一律全自动（任务监督加了宿主级开关），兑现 CLI SPEC「`--mode free` 下任务本就不问」。
- 命令行没有窗口也没有 IM，`talk_to_user` 会报「没有 IM 联系记录」；CLI 照样把那句打印出来。桌面上有窗口即算送达。

## 风险与待观察

- 每份回执多一次联络模型调用；结束事件 5 秒合并，确认 / 提问不合并。
- 回执轮沿用联络上一轮的渠道上下文（系统提示词不变，能吃缓存）；它若在回执轮里用 `ask_user`，会在桌面上等到超时——回执里已写明这一轮用户看不到。
- 用户在任务 tab 里直接点了确认：联络再 confirm 会得到「已过期」，按现有返回告诉它。
