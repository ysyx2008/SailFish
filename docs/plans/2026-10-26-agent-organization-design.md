未完成（方案待确认）

# 秘书搭项目组织（2026-10-26）

设计目标见 `electron/services/agent/SPEC.md`「秘书搭项目组织：像公司一样分层做大事」。本文只写怎么做，类名、文件、数据格式随意用。

## 现状（读代码得出，develop `be1a0367`）

- **花名册按「这一轮」建，只有主人有**：`Agent.run` 里 `if (!this._isSubAgent) this._subAgentRoster = new SubAgentRoster()`，`cleanupRun` 里 `abortAll()` 后丢弃。以前几轮的人从盘上作为休眠成员恢复（`restoreDormant`）。
- **伙计就是完整的 Agent**：`SailFish.newChildAgent` 新建 `SailFish`、`markAsSubAgent()`、`bindConfirmationHost(this, name)`、继承技能。确认、用量都经 `_confirmationHost` 交给主人。
- **派人那几样对伙计关着**：`dispatch_agents` / `followup_agent` / `wait_agents` / `interrupt_agent` 的 `_meta.allowedForSubAgent: false`，清单过滤（`filterSubAgentTools`）和运行时硬拦（`denyIfNotForThisAgent`）两处对齐。
- **专家团**：`ExpertTeam` 管群消息、未读、叫醒计数；组长名写死为 `EXPERT_TEAM_LEADER`（「组长」，即秘书）。团活在派出它的那份花名册里，`teamSay` 点到组长就 `deps.knock` 敲派出者的门。
- **敲门和收工**：主人 `runUntilIdle` 在 `hasLiveChildren` 为真时挂着等敲门；敲门走 `injectSubAgentKnock`。这套是 `Agent` 基类上的通用逻辑，不区分主人还是伙计，只看有没有花名册。
- **按停级联**：`Agent.abort()` → `_subAgentRoster?.abortAll()` → 每个伙计 `handle.abort()`。
- **存盘**：伙计记录在 `history/sub-agents/<日期>/<主会话号>/<伙计目录>/`，位置靠 `getSessionId()` + 名字；群聊全文按会话号存（`ExpertTeamChatStore`）。伙计自己的 `getSessionId()` 是 `sub_…`，不是主会话号。
- **界面**：派出那一步带 `subAgents[]` 和 `expertTeam`（一团）；`ExpertTeamCard` / `ExpertTeamChat` / `SubAgentDock`（顶部挂着的一行）。

## 总体做法：组长照秘书的样子拿一份花名册

组织不是一份新的大名册，而是**一棵花名册树**：秘书的花名册是根；被指定为组长的专家，他自己的 Agent 实例也建一份花名册，挂在上级名册下面。这样：

- 秘书那条路一行不动：没有组长时，没有子名册，所有判断和现在一样（成功标准 11）。
- 组长「手下还有人在干就不收工」「被敲门」「按停级联」全部由 `Agent` 基类现有逻辑自然得到，因为它们只看「有没有花名册」。
- 组长名下的团就是一个普通 `ExpertTeam`，活在组长的名册里，点到组长就敲组长的门：交接规则零改动。

整棵树共用一个 `OrgLedger`（组织账本），只在出现第一位组长时由根名册建出来：

- 全树没做完的人数（保险丝按它算）、全树已用的名字（存盘目录是平铺在主会话下的，名字必须全树唯一）、每个名册的层数、找人（名字 → 所在名册）。
- 根名册 `room()` / `liveCount()` 在有账本时读账本，没有账本时读自己——没有组长时数值和现在完全一样。

## 改动明细

### 1. 指定组长、组长能派人

- `dispatch_agents` 的 `tasks[]` 加 `lead: boolean`（只对带 `role` 的专家有效；伙计带了整批退回并说明）。`parseDispatchTasks` 校验；层数到顶（派出者已在第 3 层）再指定组长，整批退回并说明。
- `SpawnTask.lead`、`ChildSlot.lead`、`ChildSnapshot.lead`。
- `ChildAgentHandle.becomeLead?(seat: LeadSeat)`：`LeadSeat` 带账本、层数、上级名册、自己的名字。`startChild` 在开工前对 `lead` 的人调用。
- `Agent.run`：`if (!this._isSubAgent || this._leadSeat)` 建名册；组长建出的名册挂上账本。
- 工具可见性：`ToolMeta` 加 `allowedForLead?: boolean`，派人那四样标 `true`。`filterSubAgentTools(tools, { lead })` 与 `denyIfNotForThisAgent` 两处同时认它。抽象层不出现工具名（OOP 边界护栏照旧）。
- 组长的 `newChildAgent` 绑定的确认宿主是**根**（`this._confirmationHost ?? this`），用量也记到根上；要你批准的那一下仍然只在你看的那场排队。
- 组长存盘与群聊的会话号：组长名下的人要存到**主会话**下面，所以存盘与群聊取的会话号改为「确认宿主的会话号」（新增 `rootSessionId()`，主人返回自己的）。
- `followup_agent` / `interrupt_agent` / `wait_agents` 只作用于自己的名册（组长只管自己这一枝）；秘书点到不在自己名册里的人时经账本找到他所在的名册再转过去（秘书可以叫醒任何人）。

验收：单测——组长能派、非组长不能（清单与硬拦都拦）；全树计数撞 1000 整批退回；名字全树唯一；第 3 层不能再指定组长；秘书按停整棵树停；不带 `lead` 的现有单测全部原样通过。

### 2. 群跨层、直达秘书

- `ExpertTeam` 构造加可选 `leader`（默认「组长」= 秘书，现有调用不变）。组长名下的团，组长一栏是组长自己的名字；群里和组织图上写「组长·名字」。
- 保留称呼「秘书」：任何一层的群里都能点名秘书。点到时经账本敲**根**的门（带团名和这句话）；顶层团里「秘书」与「组长」是同一个人。秘书回应用 `followup_agent` 点名那位，记进那个群（`ExpertTeam.spokeAs('秘书', …)`）。
- 两个团之间的事走共同上级的群：不需要代码，组长本来就在上一级群里。

验收：单测 + 假模型端到端——第 2 层专家点名秘书，根收到敲门；秘书回应出现在那个群里，被点名的人被叫醒。

### 3. 验收

- `tasks[]` 加 `reviewer: boolean`（只在带 `team` 时有效）。
- `team_say` 加 `verdict: 'pass' | 'reject'`，只有验收人能带；记进群消息，`ExpertTeam` 留最近一次结论。
- 团停下时交给组长的那段话、组长交差时往上带的话，都附「验收：通过 / 打回 / 没有验收人」。
- 组长开工的第一条话里写明：他交上去的东西上级当作他核对过的；手下的结果全文在哪。

验收：`ExpertTeam` 结论单测；文本单测；非验收人带 `verdict` 被拒。

### 4. 共享工作区与组织看板

- 有账本时，根名册的落盘目录下建 `org/`：每个组长名下的人的结果文件放在 `org/<组长名>/` 下（子名册的 `SubAgentWorkspace` 以它为根）。
- `org/board.md` 由系统按账本重写（节流，同总览）：团、组长、上级、成员、状态、结果文件位置、验收结论。
- 组织里每个人的开场多一段：工作区和看板的位置、自己向谁汇报。

验收：单测看板内容；端到端看文件真的写出、随进展变。

### 5. 组织的存盘与接着干

- `ChildState` 加 `parent?: string`（组长名）、`lead?: boolean`、`team?: string`（已有的话沿用）。
- 根名册恢复休眠成员只取没有 `parent` 的（老记录没有这个字段，行为不变）；组长的名册只取 `parent === 自己`。
- 叫醒一位组长：恢复他的座位和账本，再交代时他的名册照常从盘上恢复自己名下的人。
- 群聊全文：组长名下的团按主会话号存，跟着会话删。

验收：端到端 `kill -9` 后重开，秘书再交代组长，组长能叫醒手下的人。

### 6. 界面

- 共用类型（`packages/shared-types`）加 `OrganizationView`：`teams[]`（团名、上级团、组长、成员的角色/名字/状态/是否组长、各状态人数、验收结论、群聊文件）、全组织合计。
- 派出那一步：派出的人里有组长时带 `organization`。组长名下的进度经账本冒泡到根的那一步（同一个节流，最多每 250ms）。
- 新组件 `OrganizationCard`（对话里的小卡片）、`OrganizationChart`（组织图，点框打开现有 `ExpertTeamChat`，传那个团的群聊文件）。放的位置复用专家团群聊的座位。
- `SubAgentDock` 顶部那一行：有组织时按全组织计数，入口打开组织图。
- 中英文案同步。

验收：`scripts/ui-e2e` 用 `launchApp` + 临时数据目录 + 造好的会话记录截图：卡片、组织图、点进群聊、顶部一行。

### 7. 交给模型的话（要你审）

改到的地方：`dispatch_agents` 的说明（`lead`、`reviewer`、层数、代价）、组长开场、`team_say` 的说明（「秘书」、`verdict`）、团停下与交差的回执。写法按客观中性原则：写处境和后果，不写「先做什么」。草稿在动手做第 7 步时单独给你看，确认后再定稿。

### 8. 端到端

`scripts/cli-e2e/organization.mjs`：真起命令行进程 + 脚本化假模型。秘书派两位组长 → 各自组团 → 第 2 层有人点名秘书 → 验收人打回再通过 → 全部收工 → 看板与群聊文件齐全；另跑 Ctrl+C 整树停下、`kill -9` 后接着干。再用真模型（沙箱借来的配置）跑一次小组织，看真实表现。

### 9. 文档

SPEC 成功标准随实现补细节；`project-architecture.mdc` 加一段；想法本挪堆；本文改 `done-`。

## 任务拆解（每步一个提交，可各自验）

| 步 | 内容 | 怎么验 |
|---|---|---|
| 1 | 账本 + 指定组长 + 组长能派人 + 保险丝/名字/层数 + 按停级联 | 单测；现有伙计、专家团、存盘的单测与端到端原样通过 |
| 2 | 群跨层、直达秘书 | 单测 + 假模型端到端 |
| 3 | 验收 | 单测 |
| 4 | 共享工作区与看板 | 单测 + 看文件 |
| 5 | 组织存盘与接着干 | `kill -9` 端到端 |
| 6 | 界面：卡片、组织图、顶部一行 | 界面端到端截图 |
| 7 | 提示词定稿（先给你审） | 你过目 |
| 8 | 整条链路端到端（假模型 + 一次真模型） | 脚本跑通、日志无警告 |
| 9 | 文档 | — |

1～5 是后端，做完就能在命令行里用；6 之后你才能在界面上看到。

## 已知约束与风险

- **和另一路撞**：`feat/worker-remote-hosts`（伙计可带各自的远程命令清单，等你验）大改了 `tools/sub-agent.ts`（+302 行）、`sub-agent-roster.ts`、`sailfish.ts`、`tools.ts`。这一路第 1 步正好改这几处。建议那一路合进 `develop` 后再开始写代码；先写也行，合入前变基时我来解冲突。
- **花费**：组织里每多一层就多一次转述和汇总，token 会明显多于同样人数的扁平派法。只写给秘书看，不设防（和伙计一致）。
- **组长的上下文**：组长自己也会撞窗口上限；他名下的结果和总览已经按「长的落文件、对话里只留要点」处理，和秘书同一套。
- **层数 3、团 15 人、叫醒 30 次**：都是估的数，用下来再调。
