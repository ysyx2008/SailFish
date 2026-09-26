# 替我审批（自动审批评审员）方案

> 落盘日期：2026-09-26
> 状态：已完成
> 设计目标见 `electron/services/agent/SPEC.md`「替我审批：本来要问你的那一下，先让独立评审员看」。
> 来源：`docs/ideas.md`「和 Codex 一样的『替我审批』」；对照 Codex `codex-rs` 的 Guardian（2026-09-26 最新版）。

## 1. 插入点

所有要人拍板的确认都经过 `Agent.waitForConfirmation`（7 处调用：命令审计、写文件、SFTP 写、Word 保存/生成、插件门禁）。评审员插在这里，**只把「弹框」改成「替你放行」**：

```
waitForConfirmation(run, …, opts?)
  ├─ 子智能体 → 原逻辑（不走评审）
  ├─ 无应答通道 → 原逻辑（不批准）
  ├─ opts.humanOnly（插件显式要求审批）→ 直接弹框
  ├─ AutoApprovalReviewer.review(...) → approved → 留一行、返回 approved
  └─ 否则 → 原弹框，PendingConfirmation.autoReview 带上理由
```

「本次允许」白名单在 `createToolExecutorConfig` 的包装里已先判，命中不会走到评审。

## 2. 资格（Gate）

全部满足才评：

- 设置 `autoApprovalReview === true`（默认 false，每次评审时现读，不需广播）
- `inferConversationKind(agentKey) === 'task'`
- 非子智能体；`context.unattended !== true`
- `context.remoteChannel` 为空或 `'desktop'`（IM / Web 远程不评）
- `riskLevel !== 'blocked'`（硬墙本就不进确认，防御性再挡一道）
- 这一轮熔断未触发（连续 3 次未放行 → 本轮后续直接问人）

## 3. 模块（`electron/services/agent/auto-review/`）

| 文件 | 职责 |
|---|---|
| `policy.ts` | 评审员固定说明书（中文），输出契约 |
| `verdict.ts` | 解析模型输出 JSON；分数枚举校验；**查表裁决**（模型 outcome 与表都同意才放） |
| `evidence.ts` | 从步骤取「你的原话」（user_task / user_supplement / 已收到回答的 asking）+ AI 规则；从 run.messages 取「最近过程」线索；格式化「这一条动作」 |
| `inspector.ts` | 只读核查工具：`inspect_local`（命令须经 `assessShellRisk` 判为 safe 且已解析、无未知子命令；10s 超时；输出截 4000 字）、`inspect_remote`（SFTP stat / list，列目录上限 100 条） |
| `reviewer.ts` | `AutoApprovalReviewer` 类：每个 Agent 实例一个；自有追加式会话（缓存）；游标；熔断；作废重评；60s 总超时；token 回报 |
| `index.ts` | 导出 |

### 3.1 查表（`decideOutcome`）

| 危险度 | 放行条件（且模型 outcome=allow） |
|---|---|
| critical | 永不 |
| high | 授权 ∈ {high, medium} |
| medium | 授权 ≠ unknown |
| low | 不看授权 |

解析失败 / 枚举不合法 / 缺字段 → `failed` → 问人。

### 3.2 证据与缓存

- 会话 = `system(固定说明书)` + 追加的 `user(证据包)` / `assistant(结论)` / 核查的 tool 往返。
- 第一次：全部原话 + 最近过程（尾部 ≤ 12k 字，每条 ≤ 1500 字，标「线索」）+ 这一条动作。
- 之后：只补**新出现的原话**（按步骤 id 去重）+ **run.messages 游标之后的过程** + 这一条动作。
- 失效重建：换了会话 id；run.messages 被压缩/改写（游标处消息指纹对不上或长度回退）；自有会话超过 60k 字。重建即清空自有会话，按「第一次」重来。
- 原话不截：总原话 > 40k 字 → 不评，直接问人（note 说明装不下）。
- 附件只列文件名，不带内容。

### 3.3 作废重评

评审前后比较「原话步骤数」。评审中出现新原话且结论为放行 → 带新原话重评一次；再变 → 问人。

### 3.4 超时与取消

AbortController 合并 run 的中止信号 + 60s 定时器；超时/出错 → `failed` → 问人。核查每轮最多 4 次工具调用，超过即要求直接给结论。

### 3.5 留痕

- 放行：`addStep({ type: 'auto_review', content, riskLevel, toolName })`，内容「替你放行：动作（风险）· 理由」。
- 交给你：同样留一行「替你看过，交给你定 · 理由」，并把理由挂到确认卡。
- 新步骤类型 `auto_review` 进 `AgentStep['type']` 联合；前端默认 markdown 渲染 + 图标 + 样式；属过程（不钉在外面）。

### 3.6 token

评审每次调用的 usage 累加进 `run.tokenUsage`（进历史统计），不碰上下文水位账。

## 4. 前后端改动清单

| 文件 | 改动 |
|---|---|
| `packages/shared-types/src/agent.ts` | `AgentStep.type` 加 `auto_review`；`AgentStep.askingAnswer?`；`PendingConfirmation.autoReview?` |
| `electron/services/config.service.ts` | `autoApprovalReview: boolean` 默认 false + getter |
| `electron/services/agent/agent.ts` | `waitForConfirmation` 接评审；`opts.humanOnly`；插件门禁传 humanOnly；持有 reviewer 实例 |
| `electron/services/agent/tools/types.ts` | `waitForConfirmation` 签名加可选 `opts` |
| `electron/services/agent/tools/misc.ts` | 提问收到回答时写 `askingAnswer` |
| `electron/services/agent/auto-review/*` | 新模块 |
| `src/components/Settings/AutoReviewSettings.vue` + `SettingsModal.vue` | 安全组新页「替我审批」，单开关即存 |
| `src/components/AiPanel.vue` / `src/composables/useAgentMode.ts` | 确认卡理由；`auto_review` 图标与样式 |
| `src/i18n/locales/{zh-CN,en-US}/*` | 文案 |
| `electron/services/agent/i18n` | 后端留痕文案（中英） |

## 5. 任务拆解

- [ ] T1 SPEC 设计目标 + 本方案 —— 验收：SPEC 无实现名
- [ ] T2 `auto-review` 纯逻辑（policy / verdict / evidence）+ 单测 —— 验收：查表、解析、证据增量、原话不截、附件不带内容的单测绿
- [ ] T3 `inspector` + 单测 —— 验收：写命令/未知命令被拒、只读命令能跑、超时截断
- [ ] T4 `reviewer` 会话/缓存/熔断/重评/超时 + 单测（mock aiService）—— 验收：第二次评审请求前缀与第一次逐字相同；游标失效会重建；连续 3 次未放行后不再调用模型；中途新原话触发重评
- [ ] T5 接入 Agent 入口、配置、留痕、token、插件门禁、提问回答 —— 验收：开关关时行为与原来逐字一致（现有测试全绿）
- [ ] T6 前端设置页、确认卡、步骤样式、i18n —— 验收：`vue-tsc` 通过；中英键齐
- [ ] T7 回归 `test-cli.sh --no-ai` + 类型检查 + 端到端（CLI 交互式真实模型：授权过的删除被放行、没授权的交给人）
- [ ] T8 claude-review 审查修复；收尾（done-、想法本、架构文档）
