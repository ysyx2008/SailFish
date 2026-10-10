# 对话操作只有一条路：界面只是界面，联络复用同一套（2026-10-10）

已完成（2026-10-10；本地分支 `feat/companion-task-supervisor`，待桌面手测）

设计目标见 `electron/services/conversation/SPEC.md`「对话怎么动只有一种做法」「审批方式是每场对话自己的」，以及 `electron/services/agent/SPEC.md` 联络任务管理「联络动手和用户动手是同一回事」。

## 现状（问题所在）

| 动作 | 桌面输入框 | 联络（`TaskSupervisor`） | IM / Web / CLI |
|---|---|---|---|
| 新开 / 接着说 | `useAgentMode.runAgent` 自己判断：后端忙→`agent:addUserMessage`，否则 `agent:run` / `agent:runStandalone`；前端铸 `session_${ts}`、前端触发首个标题 | 建任务：IPC `agent:taskCreated` → `App.vue` 建 tab + `runStandalone`；无窗口直驱 `runAssistant`。再交代：在跑→`addUserMessage`；否则 IPC `agent:taskContinue` → `App.vue` 接回 tab 再 run；无窗口 `continueTask` | 各自后端直驱 `agentService.run` |
| 审批方式 | 下拉框 = 全局 `executionMode` + 全局 `autoApprovalReview`，每次 run 随 config 传 | 后端私有 `_preferAutoReview` + 建时 `executionMode` | IM 有自己的一份 |
| 批准 / 停止 | `agent:confirm` / abort | 同一个后端入口 ✅ | 同 ✅ |

第一行和第二行是两套平行实现，正是要消掉的。

## 目标形态

- **对象分工（谁拥有状态谁做决定）**：
  - `Agent` 拥有运行状态，所以「这句是补进去还是开新一轮」由它自己决定：对外一个 `say`，内部收编现有的 `addUserMessage` 与 `run`
  - `AgentService` 只做它本来的注册表 / 工厂职责：按 agentKey 找到实例，不在就按历史记录复活（恢复 sessionId 与形态），然后交给实例的 `say`；不在服务层查实例状态再分支
  - `Conversation`（聚合根）拥有审批方式，和标题、标题锁同等待遇；「该不该问、问谁」仍集中在现有确认策略里，只是输入从全局配置换成会话的设定
  - `TaskSupervisor` 收窄为联络的只读视图（列表 / 近况）+ 事件回流，动作一律转给上面同一套对象
  - 前端：认领逻辑收在一个 store 动作里，不散在 `App.vue` 的专用回调
- **后端单一入口**（实例上的 `say`，`AgentService` 负责找到 / 复活实例）：给定 agentKey + 一句话 + 可选输入（附件、图片、文档、工作台上下文、窗口才有的终端上下文、模型档）：
  - 那场在跑 → 当场补进去（`user_supplement`）
  - 那场空闲 / 实例不在 → 接着原来那场（按 agentKey 找会话；实例不在就从历史最近那条恢复 sessionId 与形态）
  - 全新 → 新会话（后端铸 sessionId、后端触发首个标题）
  - 返回实际发生了哪一种（`supplemented` / `started`）以及 sessionId，供界面更新
- **审批方式落在会话上**：`Conversation` 持有 `approval: 'strict' | 'relaxed' | 'autoReview' | 'free'`，随记录落盘；Agent 判断确认时读它，不再读每次 run 传进来的 `executionMode` 与全局 `autoApprovalReview`。新会话起步值 = 全局默认（即「新对话」起始界面的选择）
- **界面认领别处发起的动作**：任何来源让某个 agentKey 开跑 / 补话，后端发出统一事件；前端没有对应 tab 就按形态建出来（助手 → 侧栏条目；本机终端 → 用同一 id 重开；远程终端窗口不在 → 不建，后端已先拒绝），再显示话与过程。替换 `App.vue` 里 `onTaskCreated` / `onTaskContinue` 两段专用处理
- **联络**：create = 新建助手会话（带审批方式）+ `say(brief)`；instruct = `say(message)`；confirm / stop 不变。删掉 `notifyFrontendTaskCreated` / `notifyFrontendTaskContinue` / `continueTask` / `_preferAutoReview` / CLI 直驱特例
- **没有窗口**：同一个 `say`，不带窗口才有的上下文，无需另一条路径

## 已知约束

- 终端屏幕内容、工作台提示只有窗口知道：输入框发话时照旧随输入带上；别处发起时不带（Agent 需要时可自己用读终端的工具）
- 远程终端会话窗口不在时，`say` 直接回「窗口不在」，不替用户重连（与现有 SPEC 一致）
- 前端「正在跑」状态曾落后于后端（`useAgentMode` 里已有一次补丁）：认领事件以后端为准，这块重点测
- IM 自己的审批设定本次不动

## 任务拆解（每步一个 commit，可独立验收）

重构（行为不变）：

- [x] **R1 后端单一入口**（代码已提交，桌面手测待做）：`Agent.say` 内含「补话 / 开新一轮」判断，`AgentService.say` 按形态（助手 / 终端）找到 / 复活实例后转交；`agent:run` / `agent:runStandalone` 两个 IPC 合并为 `agent:say`，回调构造收成 `createRendererAgentCallbacks` 一份；`runAgent` 的界面「在跑」判断只决定显示，`say` 回 `supplemented` 时撤掉乐观的 user_task；`App.vue` 联络建任务 / 再交代暂时也调 `say`（R3 再换掉）。`agent:addUserMessage` 只剩 ask_user 的静默回复在用。sessionId 铸造挪到 R2，与首个标题一起搬。
  验收：单测覆盖补话 / 补话不改执行档 / 开新一轮；CLI 回归；桌面手测——新对话、运行中补话、排队续发、`/compact`、助手 tab、本机终端 tab、远程终端 tab
- [x] **R2 sessionId 与首个标题挪到后端**：新任务会话由后端铸 sessionId、第一句由后端触发起标题，前端只接收。（`onStart` 带回 `{sessionId, sessionStartTime}`，`App.vue` 全局 `onRunning` 认领；`Agent.scheduleInitialTitle` 在初次检查点后起标题，引导会话写固定标题；删掉 `history:generateConversationTitle` IPC；CLI 改走 `say` 并等 `waitForInitialTitle`）
  验收：新对话侧栏标题照常出现；联络、引导会话不受影响
- [x] **R3 界面认领**（与 F2 的「create / instruct 改调 `say`、删专用通道」合并做了）：统一的「某场开跑 / 补话」事件 + 前端按形态建 / 接回 tab；先让联络的建任务与再交代改走它（替换 `App.vue` 两段专用处理）。（`onStart` 的会话信息加 `terminalType` / `title`，且先于 `user_task` 发出；`AgentService.say` 没带回调时用宿主给的界面回调工厂，联络发起的过程照样推到界面；前端 `terminalStore.claimConversation` 认领任务会话，本机终端重开后经 `agent:adoptPane` 把窗交给这一轮；`Agent.withKnownPane` 让别处说话接着用上一轮的窗格；删掉 `agent:taskCreated` / `agent:taskContinue`、`notifyFrontend*`、`AgentService.continueTask`。CLI 端到端：建任务 → 新进程再交代，同一场两轮、标题不变）
  验收：桌面手测——联络建任务立刻出现在侧栏；对开着 / 关着的那场再交代，话立刻出现在那场。已知：关着的那场被接回时侧栏条目只显示这一轮起的过程（之前的历史点开历史记录看），与改动前一致

功能：

- [x] **F1 每场对话自己的审批方式**：会话字段 + 落盘往返；下拉框读写眼前这场（起始界面仍改起步值）；Agent 读会话的设定；前端不再每次 run 传执行档。
  验收：单测（往返、旧记录按起步值）；桌面手测——两场设不同方式互不影响、重启后各自还在
  （做成：`ApprovalMode` 记在 `Conversation` 上，检查点与 meta.json 都带，整份重写不抹掉已记下的；`agent:setApproval` 改眼前这场，实例不在时先记着；渠道经 `updateConfig` 给的执行档只管那一轮，替我审批那一轮跟全局开关；联络页与网页 / IM 远程会话的下拉框仍改渠道设定。CLI 端到端：联络建的任务记下替我审批、跑宽松；全自动任务新进程再交代仍跑全自动；`--mode free` 直接跑的那场记起步值、那一轮全自动）
- [x] **F2 联络全面改走同一套**（create / instruct 改调 `say`、删专用通道已并进 R3；审批方式作为会话设定传入、删私有开关并进 F1；无窗口直驱的特例随 R3 一并删掉，CLI `companion` 的值班循环不用改；「转达确认」这一步本轮没再跑端到端，留给桌面手测）：create / instruct 改调 `say`，审批方式作为会话设定传入；删掉专用通道与私有开关；CLI `companion` 去掉直驱特例。
  验收：task-supervisor / task-manager 单测改写；CLI 端到端（建任务 → 新进程再交代 → 转达确认）；桌面端到端（建任务后打开那场，下拉框显示替我审批 / 全自动）
- [x] **收尾**：`project-architecture.mdc` 相关段落、`docs/ideas.md`、本文件改名 `done-`
