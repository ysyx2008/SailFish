# 感知层架构设计（Sensor Loop）

> 让一个 Agent 有多双眼睛（传感器），但只用一个大脑思考。

## 1. 设计目标

旗鱼当前只能通过两种方式触发 Agent：用户主动发消息、定时任务到点执行。Agent 没有持续感知环境变化的能力——它不知道有新邮件、不知道日程即将开始、不知道外部系统发来了通知。

本方案引入**感知层（Sensor Loop）**，让旗鱼从"被动响应"进化为"主动感知"：

- **事件驱动**：Agent 可被邮件、日历、Webhook、心跳等多种事件源唤醒
- **Watch 模型**：用户定义"关注点"（Watch），描述触发条件、执行 prompt、输出渠道
- **单 Agent 串行执行**：所有事件共享一个 Agent 大脑，通过事件队列排队处理
- **Agency of Omission**：Agent 可在执行前自主判断"该不该做"，选择不打扰用户

## 2. 核心概念

### 2.1 Watch（关注点）

Watch 是 Agent 的"关注配置"，定义了：
- **何时关注**（triggers）：cron、心跳、Webhook、邮件到达、日历事件临近等
- **关注什么**（prompt）：Agent 被唤醒时的任务指令
- **用什么能力**（skills）：预加载的技能（邮箱、日历、浏览器等）
- **在哪里做**（execution）：本地终端 / SSH / 纯助手模式
- **结果送哪里**（output）：IM 推送 / 系统通知 / 静默记录
- **要不要做**（preCheck）：执行前让 AI 自主判断是否应该执行

Watch 是 ScheduledTask 的超集——定时任务只是 trigger 为 cron/interval 的特殊 Watch。

### 2.2 Sensor（传感器）

Sensor 是轻量级的事件生产者，持续运行但不消耗 AI 资源：
- **HeartbeatSensor**：每 N 分钟产生一次心跳事件
- **WebhookSensor**：接收外部 HTTP 回调
- **EmailSensor**（未来）：IMAP IDLE 监听新邮件
- **CalendarSensor**（未来）：扫描即将到来的日历事件

### 2.3 Event Bus（事件总线）

连接传感器和 Watch 执行引擎的管道：
- 传感器产生事件 → 事件入队列
- Watch Service 从队列取事件 → 匹配 Watch → 执行 Agent

## 3. 架构概览

```
┌─────────────────────────────────────────────────┐
│                  Sensor Loop                     │
│            （轻量轮询 / 长连接 / HTTP）            │
│                                                  │
│  ⏰ HeartbeatSensor    每 N 分钟产生心跳          │
│  🌐 WebhookSensor      接收 HTTP POST 回调        │
│  📧 EmailSensor        IMAP IDLE 监听（未来）      │
│  📅 CalendarSensor     事件倒计时（未来）           │
└──────────────────┬──────────────────────────────┘
                   │ SensorEvent
                   ▼
┌─────────────────────────────────────────────────┐
│              Event Bus + Queue                   │
│                                                  │
│  内存队列，FIFO，支持优先级                        │
│  事件持久化（可选，用于崩溃恢复）                   │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│              Watch Service                       │
│                                                  │
│  1. 从队列取事件                                  │
│  2. 匹配 Watch 触发条件                           │
│  3. Pre-check：让 AI 判断是否执行（可选）          │
│  4. 构建 prompt（原始 prompt + 事件上下文）        │
│  5. 调用 Agent 执行                               │
│  6. 将结果投递到 Watch 配置的输出渠道              │
│  7. 更新 Watch 状态和执行历史                     │
└─────────────────────────────────────────────────┘
```

## 4. 数据模型

### 4.1 WatchDefinition

```typescript
interface WatchDefinition {
  id: string
  name: string
  description?: string
  enabled: boolean

  // 触发配置（多种触发方式可并存）
  triggers: WatchTrigger[]

  // Agent 指令
  prompt: string
  skills?: string[]

  // 执行环境
  execution: {
    type: 'assistant' | 'local' | 'ssh'
    sshSessionId?: string
    workingDirectory?: string
    timeout?: number   // 秒，默认 300
  }

  // 输出配置
  output: {
    type: 'im' | 'notification' | 'log' | 'silent'
  }

  // 预检查（Agency of Omission）
  preCheck?: {
    enabled: boolean
    hint?: string  // 额外提示，如"周末和节假日不要打扰"
  }

  // 工作流状态（有状态 Watch 使用）
  state?: Record<string, unknown>

  // 优先级
  priority: 'high' | 'normal' | 'low'

  // 元数据
  createdAt: number
  updatedAt: number
  expiresAt?: number  // 可选的过期时间
}
```

### 4.2 WatchTrigger

```typescript
type WatchTrigger =
  | { type: 'cron'; expression: string }
  | { type: 'interval'; seconds: number }
  | { type: 'heartbeat' }
  | { type: 'webhook'; token: string }
  | { type: 'manual' }
  // 未来扩展：
  // | { type: 'email'; filter?: { from?: string; subject?: string } }
  // | { type: 'calendar'; beforeMinutes: number }
```

### 4.3 SensorEvent

```typescript
interface SensorEvent {
  id: string
  type: 'heartbeat' | 'cron' | 'interval' | 'webhook' | 'manual'
  source: string      // sensor ID 或 'user'
  timestamp: number
  watchId?: string    // 指向特定 Watch（webhook/cron/interval 有目标）
  payload: Record<string, unknown>  // 事件载荷
  priority: 'high' | 'normal' | 'low'
}
```

### 4.4 WatchExecutionRecord

```typescript
interface WatchExecutionRecord {
  id: string
  watchId: string
  watchName: string
  triggerType: string
  timestamp: number
  duration: number
  status: 'completed' | 'failed' | 'skipped' | 'timeout'
  skipReason?: string   // preCheck 跳过的原因
  output?: string       // 执行输出摘要
  error?: string
}
```

## 5. 与现有系统的关系

### 5.1 与 Scheduler 的关系

Watch Service **不替代** Scheduler，而是在其之上构建。现有 Scheduler 的 cron/interval/once 调度能力被复用：

- SchedulerService 的定时调度逻辑（cron 解析、间隔计算、错过任务检查）保持不变
- Watch 的 `cron` 和 `interval` 触发器委托给 Scheduler 的定时机制
- 现有 ScheduledTask 可通过迁移工具转换为 Watch（向后兼容）

### 5.2 与 Agent 的关系

Watch 执行复用现有的 `AgentService.run()` 接口：

- Watch 被触发时，构建 AgentContext + AgentCallbacks
- prompt 被增强为：原始 prompt + 事件上下文 + Watch 状态
- 执行完成后，通过 Watch 的 output 配置投递结果

### 5.3 与 Gateway 的关系

Webhook 触发器通过 Gateway 的 HTTP 服务接收：

- 新增 `POST /hooks/:token` 端点
- 收到请求后产生 SensorEvent 投入事件队列
- Gateway 现有的鉴权机制可复用（Bearer Token）

### 5.4 与 IM 的关系

Watch 执行结果可通过 IM 推送：

- 复用 `IMService.sendNotification()` 发送结果
- 心跳触发的 Watch 可通过 Telegram/钉钉等推送简报

## 6. 实现路径

### Phase 1：核心基座（已完成）
- [x] 架构文档
- [x] Watch 数据模型 + Store 持久化
- [x] Event Bus（内存队列 + 优先级排序 + handler 超时保护）
- [x] Heartbeat Sensor（可配置间隔）
- [x] Watch Service（CRUD + 事件匹配 + Agent 执行 + pre-check）
- [x] 输入验证（cron 表达式、间隔范围、必填字段）
- [x] Webhook 端点集成到 Gateway（含速率限制 30次/分钟/token）
- [x] main.ts 集成 + 16 IPC handlers + preload API（强类型化）
- [x] CLI 命令（watch:list/create/trigger/delete/history + sensor:status/heartbeat）
- [x] 前端 Watch 管理界面（Awaken.vue）+ IPC 事件驱动状态
- [x] Settings 心跳传感器配置 UI
- [x] i18n 国际化（中英双语完整覆盖）
- [x] 测试用例集成到 test-cli.sh（51 总测试，48 通过，0 失败）
- [x] Claude 代码审查 + 修复所有 Critical/High 问题

### Phase 2：更多传感器（已完成）
- [x] Email Sensor（IMAP IDLE 长连接 + 凭证回调 + 指数退避重连）
- [x] Calendar Sensor（.ics 文件解析 + 系统日历发现 + 去重通知）
- [x] 文件变化 Sensor（fs.watch + 路径安全检查 + 去抖 + glob 过滤）
- [x] 传感器自动启停（Watch 创建/删除时自动注册/注销 target）
- [x] 新触发器类型定义（FileChangeTrigger / CalendarTrigger / EmailTrigger）
- [x] WatchService 事件上下文增强（file_change / calendar / email 事件注入 prompt）
- [x] Claude 代码审查 + 修复 4 Critical / 6 High 问题

### Phase 3：高级特性（已完成）
- [x] 有状态工作流（Watch 自身状态 + 跨 Watch 共享状态 + 状态自动提取 + Schema 验证）
- [x] Watch 模板市场（8 个内置模板，5 个分类，CLI + 前端支持）
- [x] Awaken UI 增强（模板面板 + 新传感器触发器编辑 + 共享状态面板）
- [x] CLI 新增 3 命令（watch:templates / watch:from-template / watch:state）
- [x] i18n 完整覆盖（中英双语）
- [x] 测试 58 总计，55 通过，0 失败

## 7. 设计原则

1. **感知不消耗 AI**：传感器是确定性逻辑，不调用 LLM
2. **串行不并行**：事件队列 + 顺序处理，避免并发复杂性
3. **渐进不替代**：在 Scheduler 之上构建，不破坏现有功能
4. **简单优先**：内存队列 > Redis，JSON 文件 > 数据库
5. **Agent 有权沉默**：preCheck 让 AI 可以选择"不做"
