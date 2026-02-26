# Agent 执行架构

描述消息从哪来、Agent 怎么跑、事件怎么流、数据怎么存。

> 另见: [`agent-architecture.md`](./agent-architecture.md)（Agent 内部原理：ReAct、工具调用、风险评估等）

---

## 全景

```
 ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
 │ 桌面 UI  │  │ Web Chat │  │ IM 平台  │  │  Watch   │
 │ (Vue)    │  │(Gateway) │  │(钉/飞/…) │  │ (Sensor) │
 └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘
      │             │             │              │
      │  IPC        │ 后端直驱    │ 后端直驱     │ 后端直驱
      ▼             ▼             ▼              ▼
 ┌────────────────────────────────────────────────────┐
 │              AgentService（Agent 工厂）             │
 │                                                    │
 │  agents Map<agentId, SailFish>                     │
 │    __companion__  → IM / 桌面助手                   │
 │    __watch__      → Watch 关切（独立实例）           │
 │    remote-*       → Web 远程会话                    │
 │    {ptyId}        → 终端绑定 Agent                  │
 │    assistant-*    → 桌面独立助手 tab                 │
 └───────────────────────┬────────────────────────────┘
                         │
                  Agent.run() 执行
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
         IPC→桌面   SSE→Web客户端  IM适配器→消息平台
```

---

## Agent 身份隔离

不同 Agent ID = 独立实例 + 独立 TaskMemory + 独立 session。

| Agent ID | 用途 | 备注 |
|----------|------|------|
| `__companion__` | IM 对话、桌面助手 | 共享上下文，保持连贯 |
| `__watch__` | Watch 关切（含觉醒） | 独立于 companion，避免高频执行污染 |
| `remote-agent-*` | Web 远程会话 | 每次 clearHistory 后重新生成 |
| `{ptyId}` | 终端绑定 Agent | 每个终端 tab 一个 |
| `assistant-*` | 桌面独立助手 tab | 前端创建时生成 |

觉醒唤醒目前与常规 Watch 共用 `__watch__`，通过 `context.wakeup` 做行为隔离（不累积 session history）。未来如果 TaskMemory 拥挤可拆分为 `__watch_wakeup__`。

---

## 四条执行路径

### 1. 桌面 UI — 前端驱动

```
用户输入 → AiPanel → IPC(runStandalone/run) → main.ts → AgentService → Agent.run()
                                                 │
                                          回调 → IPC → 前端渲染
```

唯一由前端发起执行的路径。`main.ts` 的 IPC handler 创建回调，通过 `event.sender.send()` 将事件返回前端。

### 2. Web 远程 — WebChatService 后端直驱

```
Web POST /api/chat → GatewayService → WebChatService.sendMessage()
                                            │
                                     agentService.runAssistant()
                                            │
                                     回调 → SSE 广播 + IPC → 桌面渲染
```

WebChatService 直接调用 AgentService，不经过前端中转。前端收到 `gateway:remoteTaskStarted` 后仅设置 running 状态，不驱动执行。

桌面用户手动操作远程 tab 时走 `runStandalone`，事件会同步转发到 WebChatService 供 SSE 广播。

### 3. IM — IMService 后端直驱

```
IM 消息回调 → IMService.runAgentTask()
                    │
             agentService.runAssistant(__companion__)
                    │
             回调 → IM 适配器发送 + IPC → 桌面 companion tab 渲染
```

IM 独立于 WebChatService，直接调用 AgentService。使用 `__companion__` Agent ID。发送队列串行化确保消息顺序。

### 4. Watch — WatchService 后端直驱

```
SensorEvent → EventBus 排队 → WatchService.executeWatch()
                                     │
                              ┌──────┴──────┐
                              ▼             ▼
                          Desktop        PTY
                        __watch__      {ptyId}
                              │             │
                       agentService    agentService
                      .runAssistant()     .run()
```

- **Desktop 输出**：通过 `__watch__` Agent 执行，步骤通过 IPC 发到 watch tab
- **PTY 输出**：创建临时 PTY/SSH，通过终端 Agent 执行
- **唤醒模式**：步骤带 `wakeup: true` 标记，只在 Awaken 面板显示"内心独白"，不影响主聊天
- **输出投递**：根据配置走桌面 tab / toast 通知 / IM / 系统通知 / 静默

---

## 事件流

### 后端 → 前端 IPC 通道

| 通道 | 用途 |
|------|------|
| `agent:step` | 步骤更新（thinking/tool_call/message/final_result 等） |
| `agent:complete` | 执行完成 |
| `agent:error` | 执行错误 |
| `agent:needConfirm` | 需要用户确认工具调用 |
| `gateway:remoteTabCreated` | 创建远程 tab |
| `gateway:remoteTaskStarted` | 远程任务开始（前端设置 running 状态） |
| `watch:ensureTab` | 确保助手 tab 存在 |
| `watch:proactive-message` | 主动推送消息（toast 通知） |

### 前端事件匹配

每个 AiPanel 注册 `agent:step/complete/error` 监听器，通过 `ptyId`（优先）或 `agentId` 匹配到正确的 tab。唤醒步骤（`wakeup: true`）被普通 AiPanel 过滤，只由 Awaken 面板处理。

---

## 三级记忆

```
                    Token 开销        持久性        写入时机
                   ──────────       ────────      ──────────
 L1 任务记忆        自动注入          内存           每次 run 结束
 (TaskMemory)      (token 预算内)    (实例存活期)

 L2 知识文档        自动注入          磁盘           每次 run 后异步
 (ContextKnowledge) (整份注入)       (永久)          LLM 判断是否有新信息

 L3 对话记录        按需加载          磁盘           检查点 + run 结束
 (HistoryService)  (Agent 搜索)     (永久)
```

- **L1** 是工作记忆，5 级渐进式压缩，越近越完整。Agent 实例销毁后从 L3 恢复。
- **L2** 是核心事实（"nginx 监听 8080"），按 hostId 或 personal 组织，少而精。
- **L3** 是完整经历，每轮工具调用后写检查点防丢失。Agent 通过 `search_history` 工具主动搜索。

### finalizeRun 时序

```
addStep(final_result) → taskMemory.saveTask(L1) → saveSessionToHistory(L3)
                                                 → updateContextKnowledge(L2, 异步)
                                                 → onComplete 回调
```

`final_result` 在保存之前写入 `run.steps`，确保 L1 和 L3 记录完整。

---

## 并发控制

- **Agent 实例**：`run()` 禁止并发，同一实例的并发请求被拒绝
- **Watch 队列**：所有 Watch 事件串行处理，避免 `__watch__` 实例竞态
- **WebChatService**：`sendMessage` 检查 `_isRunning`，拒绝并发
- **不同 Agent ID 之间**：可以并行执行，互不影响
