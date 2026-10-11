# 发送没送达时把话还给用户（方案）

状态：未完成（2026-10-12 代码已完成并过单测 / 类型检查 / CLI 回归，缺真机端到端；端到端做完后改名 `done-` 前缀并改成「已完成」）

设计取舍已写入 `src/components/AIPANEL_SPEC.md`「话没送出去时要交还给用户」。本文只写怎么做。

## 起因

排队的带图消息到点开跑时，响应式代理对象过 IPC 被拒收（已修，`25516388`）。暴露的是更大的问题：消息只在界面上有，后台没收到，界面却只报「任务失败」；多条排队时同因失败会把队列逐条吃光。

## 判别「没送达」

`say` 的 IPC 调用**抛异常** = 没送达（后台约定：收到并跑过的失败一律以 `SayResult.success=false` 返回，不抛；已核对 `agent:say` 处理函数，try/catch 只包住真正交给 Agent 的那段，外面三行准备工作抛异常时 Agent 也没跑到）。返回了结果（含 `success=false`、`aborted`）= 已送达，走原有逻辑。

## 改动

| 文件 | 内容 |
|---|---|
| `src/composables/follow-up-drain.ts` | 判定加入 `anyFailed`（队列里任一条没送出去就停）；纯函数 `withFailedAtHead` / `withRetried` / `mergeHandbackText` |
| `src/composables/useAgentMode.ts` | 三条发送路径没送达时：撤掉临时消息；普通/补充 → 还给输入框（`handBackToComposer`）；排队项 → 回队首标 `failed`。新增 `retryFollowUp`；删除失败项也会让队列接着走；`sayAsSupplement` 改为返回是否送达 + 原因 |
| `src/components/AiPanel.vue` | 提供 `handBackToComposer`；把「图/文档填回输入框」从编辑排队项里抽成 `restoreDraftMedia`，两处共用；接线重试 |
| `src/components/AiComposer.vue` | 队列行显示「没发出去：原因」、重试图标；暂停时表头改说明 |
| `src/i18n/locales/{zh-CN,en-US}/ai.ts` | 文案 |
| `src/composables/__tests__/follow-up-drain.test.ts` | 判定、合并草稿、「三条排队发送恒失败只试一次」「重试后按序发完」「删掉失败项后恢复」 |

`FollowUpQueueItem` / `FollowUpQueueViewItem` 各加可选 `failed?: { reason: string }`，不另起平行状态。

## 与最初方案的差异

- 停住的判定从「队首失败」改为「任一条失败」，这样拖动排序也不会绕开暂停。
- 「插入当前对话」失败的项和排队项一样回队首，不留在原位。
- 发送出错时，「没送达」优先于「后台还忙就等一等」，不再自动轮询重试同一条。
- 输入框正被拿来编辑排队项时，没送达的普通发送不往输入框放，改为留在队列最前面标成没送出去。

## 任务拆解

1. [x] 纯函数 + 单测。验收：vitest。
2. [x] 普通发送 / 补充没送达 → 交回输入框、撤临时消息。
3. [x] 排队项没送达 → 队首标记 + 暂停；重试 / 编辑 / 删除恢复。
4. [x] 队列行展示与 i18n。
5. [ ] 端到端：开发态真实应用里让发送失败（临时注入异常），走一遍单条、多条排队、补充、编辑排队项时失败。

## 已知缺口

- 组合函数（`useAgentMode`）本身没有单测：依赖 Pinia、i18n、窗口环境，成本高；分支逻辑靠抽出的纯函数 + 代码审查 + 待做的端到端覆盖。
- 选中文档区域的作用域和引用片段不随放回（SPEC 已写明）。
