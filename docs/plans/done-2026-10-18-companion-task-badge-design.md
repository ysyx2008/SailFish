# 联络派的任务带标志 · 方案

状态：**已完成**（2026-10-18 落盘，同日做完；尚未提交）

设计目标已写进：

- `electron/services/agent/SPEC.md`「联络任务管理」关键取舍里「联络派的任务，出身记在那场任务自己身上」
- `src/workbench/assistant/HUB_SPEC.md`「出身标识」

想法本条目：`docs/ideas.md`「联络建的任务，在侧栏里也该有个标志」。

## 要解决的事

联络派的任务在侧栏「最近对话」里和用户自己开的一样。要给它一个标志，做法参照终端：行首一个压低对比度的小图标，悬停才给说明。

## 已定的取舍

- 「谁派的」单独存成一个枚举字段，不并进终端用的形态枚举（终端标志是从形态算出来的，形态已经是枚举，并进去会有两份记录）。
- 现在只有「联络」一个值。联络现在只能建无终端助手任务，两个标志不会同时出现，不为将来预留。
- 按「当初是谁建的」定，建的时候定下、不再变；与「这一轮谁开头」（决定回执送谁）是两件事，互不影响。
- 用户从一场任务另起的分支不继承出身。
- 没记下出身的老任务不补标。

## 数据怎么流

1. 联络建任务时（`TaskSupervisor.createTask` → `AgentService.prepareAssignedTask`），在 Agent 上先记下出身（与交办标题、审批方式同一种「会话还没建好，先记着」的做法）。
2. 会话建好后交给会话（`Conversation`），建时定下，不可改。
3. 随记录落盘：`AgentRecord` → 会话元数据 `meta.json` → 历史索引 → 列表摘要 `AgentHistorySummary`。整份重写时不抹掉已记下的。
4. 开跑事件（`AgentRunSessionInfo` → `agent:running`）带上出身，界面认领会话时记进 tab 的 agentState，侧栏「实时会话」行（还没进历史索引时）也能标。
5. `ConversationRow` 在终端图标同一位置按出身画图标，说明走 i18n（中英）。（第一版用的是 `MessagesSquare`，试用后改了，见文末「后续修订」。）

## 类型

`shared-types/src/agent.ts`：

```ts
/** 谁把这场任务派出来的。目前只有联络；用户自己开的没有这一项 */
export type AssignedBy = 'companion'
export function isAssignedBy(value: unknown): value is AssignedBy
```

`TaskSupervisor` 里的 `LedBy` 与 `agent/types.ts` 里两处 `ledBy?: 'companion'` 是同一批取值（联络），改成引用 `AssignedBy`，不另留一份字面量。

## 任务拆解

- [x] 1. 共享类型：`AssignedBy`、`AgentRecord.assignedBy`、`AgentHistorySummary.assignedBy`、`AgentRunSessionInfo.assignedBy`
  - 验收：类型检查通过
- [x] 2. 会话：`Conversation` 建时定下出身、`fromRecord` 接回、两条落盘路径带上；`fork` 不继承
  - 验收：`conversation.test.ts` 新增用例
- [x] 3. 落盘与索引：`session-persistence`（meta 往返、整份重写不抹）、`agent-record-store`（索引条目、摘要）
  - 验收：`session-persistence.test.ts`、record-store 测试新增用例
- [x] 4. Agent / 联络：`Agent` 先记下出身并在建会话后交出；`prepareAssignedTask` 带出身；开跑事件带上
  - 验收：`task-supervisor.test.ts` 的 `prepareAssignedTask` 断言带出身；`agent.test.ts` 新增六条
- [x] 5. 界面：agentState 记出身、实时会话摘要带出身、`ConversationRow` 画图标、i18n 中英
  - 验收：类型检查 + `conversation-row.test.ts` 行渲染测试（联络派的有图标且悬停有说明；普通助手、缺失/未知出身没有；终端记录只显示主机；编辑态隐藏；行 tooltip 不含正文）
  - 注：没有在运行中的桌面应用里肉眼看过（开发态会占用真实数据目录与单实例锁）
- [x] 6. 端到端：CLI 沙箱里真起一场联络建任务 → 该任务 `meta.json` 与历史索引里都有出身，联络线自己的 16 条记录没有；`bash electron/cli/test-cli.sh --no-ai` 通过（104 项，101 通过、0 失败、3 跳过）
- [x] 7. 收尾：想法本挪到已完成；`project-architecture.mdc` 补一句；本文件改名 `done-` 并文首改「已完成」

## 后续修订（2026-10-18 晚，用户试用后）

用户装上试用后的反馈：1) 气泡图标不直观；2) 图标上没看到说明，很难猜到是联络派的；随后提议在对话顶上居中写一行说明。设计目标已补进 `HUB_SPEC.md`「出身标识」和 `AIPANEL_SPEC.md`。

- **图标换成纸飞机**（`Send`，取「派出去」）。图标与文案放进一张表（`src/utils/assigned-by-presentation.ts`，`Record<AssignedBy, …>`），侧栏行与对话顶部横幅共用，加新的派出方时类型会逼着补一项。
- **说明鼠标一放上去就弹出**：项目里早有即时悬停提示（`useHoverTip` + `HoverTipOverlay`，源码注释写明 Electron 下原生 title 不可靠）——第一版没发现、另写了一套，代码审查指出后删掉改用。给共用的 `useHoverTip` 补了一种摆法 `bottom-start`（放在锚点下方、左端对齐；图标贴着窗口左缘，居中会伸出窗口）。新组件 `OriginMark` 包住图标：可悬停范围放大一圈（padding + 负 margin，不改行内排版）、`title=""` 压住按钮自带的整行标题提示、长主机名换行。终端图标一并改用。
- **对话顶上固定一行字**：新组件 `AssignedByBanner`，放在 `AiPanel` 顶栏之后、消息列表之前（不随对话滚走）；`peek` 模式不出现；底色带一点主题强调色、字色用次要文字色（第一版用的最淡的灰，用户要「很显著」，临时页面里看过后调亮）。出身取自 tab 的 `agentState.assignedBy`。
- 验证：`conversation-row.test.ts` / `assigned-by-banner.test.ts` 组件测试；临时 vite 页面里真实渲染看了行、提示、横幅的样子（已删）；全量 vitest、`vue-tsc`、ESLint、`test-cli.sh --no-ai` 通过。
- 没做：没在运行中的桌面应用里肉眼看过（开发态会占用真实数据目录和单实例锁）；列表滚动时不主动收起提示（与其他即时提示同一行为，滚动后鼠标位置变化会触发移出）。
