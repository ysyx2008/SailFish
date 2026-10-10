# useAgentMode 组合式函数 SPEC

> Last verified: 2026-09-12（任务结束后压缩跟在收场后面）  
> 文件：`src/composables/useAgentMode.ts`  
> 职责：管理单个 AiPanel（tab）的 Agent 运行生命周期、步骤分组、IPC 事件路由。

## 设计目标（2026-09-11）

**正在连接也能说话**：窗格还在转「正在连接」，或已经连不上，对话照样能发，字立刻上墙。不能因为眼前还没有可用终端就把字悄悄扔掉。还没连上时只做不必动手的事，不要另开一扇盖掉眼前这扇。定时任务仍等终端就绪；用户自己接着说的下一句可以照发。

---

## 一、核心职责

`useAgentMode` 是每个 `AiPanel` 实例私有的"业务大脑"：
- 封装 `runAgent`（发起 AI 任务）
- 订阅后端 Agent IPC 事件（step / confirm / complete / error 等）
- 把原始步骤流转换为 `agentTaskGroups`（用于 UI 渲染）
- 将状态写回 `terminalStore`（其他组件通过 store 读取，不直接访问 useAgentMode）

每个 `AiPanel` 实例挂载时调用，卸载时清理全部监听器。**多个 AiPanel 同时存在时各自独立运行，互不干扰。**

---

## 二、Agent Run 完整生命周期

```
用户提交（runAgent 调用）
  │
  ├─ clearAgentState(tabId, keepSteps=true)    // 清理上一次 run 的瞬态状态（pendingConfirm 等），保留 steps
  │
  ├─ setAgentSession(tabId, sessionId, startTime)  // 首次 run：生成 session_${startTime} 作为会话 ID
  │   （多轮对话复用：sessionId 已存在时跳过）
  │
  ├─ setAgentRunning(tabId, true, agentKey, message)   // 标记运行中 + 记录 userTask
  │
  ├─ [仅新 session + 非联络] history.generateConversationTitle(sessionId, message)
  │   // fire-and-forget：LLM 短标题写入 conversationDisplayTitles，不阻塞 Agent
  │
  ├─ IPC 调用（await）：对这场对话「说一句」
  │   // 补进当前一轮还是开新一轮由后端那场对话自己决定；回「补进去了」时撤掉乐观的新一轮显示
  │
  │   （后端异步推送步骤，前端通过 IPC 监听器接收，见第三节）
  │
  └─ IPC 返回（run 完成，无论成功/失败/中止）
      └─ finalizeAgentRunState(tabId)    // 清理运行标记，由 onComplete/onError 监听器触发
```

### agentKey（Agent 实例定位主键）

- **终端 tab**：`agentKey = tabId`（Agent 实例以 tabId 为 key）
- **助手 tab**：`agentKey = tab.agentId`（UUID，创建 tab 时分配，跨多轮稳定）

---

## 三、IPC 事件路由（isEventForThisTab）

后端所有 Agent 事件携带 `agentId` 和可选的 `ptyId`。前端每个 AiPanel 都注册了全局监听，**必须过滤出属于自己 tab 的事件**。

### 路由逻辑

```ts
resolveTabIdForAgentEvent(agentId, ptyId):
  if ptyId:
    return findTabIdByPtyId(ptyId) ?? findTabIdByAgentId(ptyId)
  return findTabIdByAgentId(agentId)

isEventForThisTab = resolvedTabId === currentTabId
```

### 监听器清单

| 事件 | 触发操作 |
|---|---|
| `agent.onStep` | 「准备中→思考中」切换识别（乐观移除占位）+ `addAgentStep` + artifact 同步 + TTS 投喂 + 智能滚底 |
| `agent.onStepRemoved` | `removeAgentStep`（后端撤销占位步骤时） |
| `agent.onNeedConfirm` | `setAgentPendingConfirm` + 强制滚底（两次，等待虚拟列表测高）|
| `agent.onConfirmResolved` | `setAgentPendingConfirm(undefined)`（远程确认同步到本地）|
| `agent.onNeedSecureInput` | `setAgentPendingSecureInput` + 强制滚底 |
| `agent.onComplete` | `finalizeAgentRunState` + 处理后续排队任务 + setAgentCompletedUnseen |
| `agent.onError` | `finalizeAgentRunState` + 注入 error step + setAgentCompletedUnseen |

**注意**：监听器在 AiPanel `onMounted` 时通过 `setupAgentListeners()` 注册，`onUnmounted` 时通过 `cleanupAgentListeners()` 全部清理。热重载时先 cleanup 再重新注册，防止重复。

---

## 四、agentTaskGroups 计算规则

`agentTaskGroups` 是 AiPanel 渲染的核心数据源，从 `agentState.steps` 扁平列表中派生：

### 分组逻辑

```
遍历 steps：
  user_task      → 开启新 group（proactive/onboarding 特殊标记）
  final_result   → 关闭当前 group（写入 finalResult，currentGroup = null）
  proactive_notice → 追加到当前 group.steps；无 currentGroup 时合成独立 isProactive group（finalResult=content）
  user_supplement（在 user_task 之前到达）→ 暂存为 leadingSupplements，user_task 到达后追加
  confirm        → 不进入 group（由 pendingConfirm 单独管理）
  其他 step（任务进行中）→ 追加到当前 group.steps
  任务已结束后、没有新的用户要求时出现的思考 / 工具过程 → 画在这场收场后面
  人主动要求压缩 → 新的一轮用户要求，跟在上一场收场后面
```

### 过程折叠（flattenedItems）

每一截埋头干活的过程就地收成一条折叠行，折叠行落在这段过程原来的位置，任何任务都收、跑着的时候也收——那一行代为播报它在忙什么并走秒，做完原地换成做了什么。留在外面的只有：要用户动手的（问问题、等密码、要确认危险命令）、任务级错误、对外发出去的、带图产出的，以及它说给用户听的每一句话；过程中某次工具失败、搜索结果、子任务进度都不算，收进去。一句话里的思考也算过程——跟着收进折叠行、留在它当时想的位置上，外面只留说出口的那句。因此展开与否，读到的顺序不变。折叠内的步骤挂在折叠行这一格里而不是平铺到列表，展开时高度才能平滑撑开。调试模式、严格模式（用户要盯着每一步）、或用户关掉自动收起时不折。

### isCurrentTask 标记

最后一个 group 且没有 `finalResult` → `isCurrentTask = true`  
含义：正在执行中的任务，AiPanel 据此显示流式状态、preparing placeholder 等。

### 特殊 group 类型

| 类型 | 触发条件 | 渲染方式 |
|---|---|---|
| 普通任务 | 默认 | user_task 气泡 + steps 列表 |
| proactive（`isProactive = true`）| 历史：`userTask === '__proactive__'` + `final_result` | 只在有 finalResult 时渲染单条 `proactive_message` 卡片，无 user_task 气泡 |
| proactive_notice（内联） | 当前任务 group 内的 `proactive_notice` step | 任务流中插入 assistant 气泡（`flattenedItems` type=`proactive_notice`） |
| onboarding（`isOnboarding = true`）| `userTask === '__onboarding__'` | 无 user_task 气泡，steps 正常渲染 |

**talk_to_user 延迟注入**：`App.vue` 在 companion tab `isRunning` 时将 proactive 消息暂存，`onComplete` 时 `flushDeferredProactive`；依赖 IM/WebChat 入口的 `agent:running` IPC 正确置位 `isRunning`（见 `agent/SPEC.md`）。

---

## 五、pendingComposerHandoff 机制

用于将欢迎页 Composer 中的内容（文本 + 图片）交给新建的助手 tab 自动发起 run。

### 流程

```
WelcomeChatComposer.handleComposerSubmit:
  1. createAssistantTab({ activate: false })       → 创建新 tab（不激活）
  2. transferUploadedDocs(WELCOME_COMPOSER_TAB_ID, tabId)  → 转移文档附件
  3. setPendingComposerHandoff(tabId, { message, images }) → 写入待交接内容
  4. markAssistantSkipOnboarding(tabId)            → 跳过引导流程
  5. markAgentOnboardingShown()                    → 关闭首页「初次见面」邀请
  6. focusHubConversation(tabId)                   → Hub 焦点切到新 tab

AiPanel（新 tab）watch hubFocusedAssistantTabId 或 active：
  → consumePendingComposerHandoff(tabId)           → 取出并清空 handoff
  → runAgent(handoff.message, handoff.images)      → 自动发起 run
```

`pendingComposerHandoff` 是一次性的（consume 后清空），防止重入。

### 诞生引导（onboarding）入口

- **欢迎页邀请**：未 `agentOnboardingShown` / 未完成时，Composer 上方展示「初次见面，认识一下？」；用户点「认识一下」→ `createAssistantTab` + `focusHubConversation`（不 skip），AiPanel 在 `tabActive` 且非联络时自动 `runAgent('__onboarding__')`。
- **稍后再说** / 欢迎页直接发真任务：`markAgentOnboardingShown`，不再提示。
- Setup 完成后**不**自动跳进任务；联络 tab 永不自动触发 onboarding。
- 侧栏标题固定为 `ai.onboardingConversationTitle`（「认识一下」），不展示 `__onboarding__`。

---

## 六、onComplete 后续处理

`onComplete` 不只是标记完成，还处理以下后续情况（按优先级）：

1. **队列化 proactive 回复**（Watch 任务完成后接着回复用户）→ 100ms 后自动作为新任务 runAgent
2. **用户在 Agent 总结期间发送的消息**（pendingUserMessages）→ 合并后 100ms 内自动 runAgent
3. **后台 tab 完成**（非当前 activeTabId）→ `setAgentCompletedUnseen(true)`，触发 TabBar 高亮

---

## 七、配置实时同步

运行中 Agent 的配置变化会实时同步到后端：

| 配置变化 | 同步动作 |
|---|---|
| `commandTimeout` 变化 | `agent.updateConfig(key, { commandTimeout })` |
| `activeProfileId`（AI 模型）变化 | `agent.updateConfig(key, { profileId })` |

---

## 八、注意事项

- **不要在 useAgentMode 外部直接调用 `runAgent`**：应通过 AiPanel 暴露的接口（如 `submitMessage`）触发，保证 Tab 上下文、滚动、handoff 等逻辑完整执行。
- **终端 tab 与助手 tab 走同一个入口，只是形态不同**：两者后端 Agent 键不同（tabId vs agentId UUID）；界面上的「在跑」只决定怎么显示，不决定发给后端的是补话还是新一轮。
- **clearAgentState 保留 steps**：新任务开始时调用 `clearAgentState(tabId, true)`，`true` 表示保留历史步骤，实现多轮对话的步骤累积显示。
- **联络 tab 挂载时恢复历史**：已经恢复过、或正在跑任务则不动。否则拉合并视图上墙。挂载期间已经灌进的现场提醒接到历史后面，同文短时间窗去重，不因为已经有提醒就放弃整段历史。合并逻辑的真相源在后端联络关系线，前端不再自拼。
