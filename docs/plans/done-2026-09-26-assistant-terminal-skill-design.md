# 独立助手的终端能力改成「终端」技能（2026-09-26）

**状态：已完成（2026-09-26）**

设计目标见 `electron/services/agent/SPEC.md`「独立助手有了终端才带终端能力（设计目标，2026-09-26）」。本文只写怎么做。

## 背景

- 6 月 18 日前终端本来是技能（`terminal`，绑定终端时自动加载）；`3e69f4d2` 因终端页每轮都要用、技能只是多绕一层，改成终端页直接注入。
- 8 月 18 日 `127c5b33` 助手能开真终端后，为了「同一步先开窗再打命令」，`getAgentTools` 的 assistant 分支一直 push `getAllTerminalTools()`。今天要收回的就是这一处。
- 工具清单每一步重新拼（`SailFish.collectToolCatalog`），开窗后下一步加进来即可；开窗与打命令分两步。

## 改法

### 1. 技能模型：系统托管标记

- `skills/types.ts` 的 `Skill` 加 `systemManaged?: boolean`：由系统按处境装卸，不给人手动装、不给模型自己挑。
- `skills/registry.ts`：`getSkillsSummary()`（喂给 `skill` 工具目录）与 `getBuiltinSkillsForSettings()`（设置页、@ 列表）都排除 `systemManaged`。
- `skill` 工具 `load` / `unload` 一个系统托管技能：拒绝并说明「由系统按有没有终端管理」。

### 2. 重新注册 `terminal` 技能

- `skills/terminal/index.ts` 恢复 `registerSkill`：`id: 'terminal'`，名字「终端」，`systemManaged: true`，`tools: getAllTerminalTools()`。
- `content`：把助手说明里「终端入座后命令打在窗里」这类只在有终端时才有用的规矩挪进来（见第 5 条），装上才注入。
- 终端页不走这个技能：assistant 以外的形态若技能清单里恰好带着它（历史恢复），工具同名去重，行为不变。

### 3. 助手拼工具不再默认带终端组

- `tools.ts` `getAgentTools` 的 assistant 分支删掉 `getAllTerminalTools()`，开窗入口 `manage_pane` 等不受影响。
- local / ssh 分支照旧直接注入。

### 4. 有终端就自动装上

在 Agent 上加「确保终端技能」这一步（只对 assistant 形态、非伙计生效），判据是**这一轮此刻有没有窗**：`run.ptyId` 非空，或 `run.context.panes` 非空。

- **开工时**：`applyRestoredSkills()` 之后检查一次。覆盖用户手动开窗后再发消息。
- **它自己开窗时**：`setCurrentPtyId` 回调里拿到新窗格后检查一次。`openTerminalTool` / `splitTerminalTool` 都走这里，下一步拼工具时已在。
- 装载走技能会话 `loadSkill('terminal')`，然后触发 `_skillsChangedHook`，界面上挂出胶囊。不看「用户曾点掉」的记录，因为开窗本身就是明确要用。
- 已装上就什么都不做：整场不撤，关窗也不卸。
- 技能会话里的技能照常进检查点落盘，重开时由 `applyRestoredSkills` 带回。

### 5. 说明文案对齐处境

- `packages/workbench-assistant/src/prompt.ts` 第 17 行现在点名 `execute_command`，没开终端时这个工具已经不在。改成只说「用 `manage_pane(action=open)` 请真终端入座，入座后命令打在窗里」，具体用哪个工具交给装上后的技能说明。
- `prompt-builder.ts` 约 700–745 行点名终端类工具的分屏说明：核对它只在有窗格时出现；没窗格也出现的话，一并收进技能说明或加条件。

### 6. 终端在座时胶囊点不掉

- 共享类型 `VisibleConversationSkill` 加 `systemManaged?: boolean`，`listVisibleSkills()` 带出。
- 前端 `AiComposer.vue` 的胶囊：`systemManaged` 且这场助手 tab 此刻有活着的终端窗格时，不显示 ×。关窗后显示，可以卸。
- 后端兜底：模型在一轮里用 `skill unload terminal`，且这一轮此刻有窗，拒绝。
- 胶囊名走 i18n（中「终端」/ 英「Terminal」）。

## 任务拆解

- [x] **T1 技能模型与注册**：`systemManaged` 字段、注册表过滤、`skill` 工具拒绝装卸系统托管技能、重新注册 `terminal`。
  - 验收：单测，`getSkillsSummary` / 设置列表里没有 `terminal`；`skill load terminal` 被拒。
- [x] **T2 助手默认不带终端组 + 有终端自动装**：删 assistant 分支注入；开工与 `setCurrentPtyId` 两处确保技能。
  - 验收：单测，无窗时工具里没有 `execute_command`，有 `manage_pane`；带 `ptyId` 开工后有；一轮中开窗后下一步有，技能清单里有 `terminal`；伙计、关切、命令行都没有。
- [x] **T3 说明文案**：助手说明第 17 行改写；分屏说明只在有窗格时出现，与技能装上条件一致，不改；终端规矩挪进技能说明。`manage_pane` 描述里「open → execute_command」的流程保留（开窗后技能即装上，流程成立）。
  - 验收：端到端里无窗时 system prompt 不含技能说明。
- [x] **T4 胶囊锁定**：共享类型字段、前端有窗时隐藏 × 并悬停说明原因、后端一轮内拒绝卸载、i18n。
  - 验收：端到端覆盖「运行中且在座时 unpin 被拒」；桌面胶囊外观未手测（留给用户）。
- [x] **T5 端到端**：`assistant-terminal-skill.e2e.test.ts`，真 PTY / 真统一终端服务 / 真历史落盘，只有模型与前端开窗是脚本。8 条场景：不开窗聊天 → 自己开窗（下一步有工具、这一轮就有技能说明、命令真进窗、在座时模型卸不掉）→ 关窗后接着聊仍带着 → 关窗后用户点掉、下一条不带 → 用户手动开窗再发消息、开工即装回 → 运行中在座时点胶囊卸不掉 → 重开（配置残留旧禁用项）技能带回且不发灰 → 同一轮关掉最后一扇窗后模型能卸。反向验证：拿掉自动装载 / 拿掉锁 / 拿掉审查三处修复，各自对应用例失败。
- [x] 收尾：全量测试（仅 `type-single-source` 一条失败，来自已提交的审批档改动 `4e5b09e3`，与本次无关）、命令行回归 56/0、类型检查、i18n 对齐；claude 审查；想法本已挪到已完成；本文改名 `done-`。

## 审查后补的三处

- **一轮中途开窗，技能说明当场补进系统提示**：否则这一轮工具在手、规矩要到下一轮才到。开窗那一步本来就断缓存，不额外付费。
- **关掉最后一扇窗时清空这一轮的当前窗**：原先传空串被当成无操作，这一轮仍记着已关的窗，导致模型卸技能被误拒、用户点 × 无反应。
- **系统托管技能不受 `disabledBuiltinSkills` 旧项影响**：6 月前「终端控制」可在设置里禁用，残留项会让重开时胶囊发灰或不回来。

## 影响面

- 独立助手没开终端时，每次请求少发 6 个终端工具的说明，实测约 3600 字符、约 1500 token。
- 第一次开窗那一步起，工具与技能说明变化，断一次前缀缓存（和加载其它技能同一种代价）。
- 老对话重开：旧记录里没有 `terminal` 技能；若当时开着终端，按「开工时此刻有没有窗」重新判断。
