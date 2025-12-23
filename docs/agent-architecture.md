# Agent 工作原理：以旗鱼终端为例

本文档以旗鱼终端（SFTerminal）的 Agent 实现为例，详细介绍 AI Agent 的工作原理，包括 ReAct 机制、工具调用、任务规划、反思机制等核心概念。

---

## 目录

1. [什么是 Agent](#什么是-agent)
2. [ReAct 机制](#react-机制)
3. [工具调用（Function Calling）](#工具调用function-calling)
4. [任务规划（Planning）](#任务规划planning)
5. [反思与自我监控（Reflection）](#反思与自我监控reflection)
6. [风险评估与确认机制](#风险评估与确认机制)
7. [知识库与记忆（Memory）](#知识库与记忆memory)
8. [多 Agent 协调（Orchestrator）](#多-agent-协调orchestrator)
9. [核心代码解析](#核心代码解析)

---

## 什么是 Agent

Agent（智能体）是一种能够感知环境、做出决策并采取行动的 AI 系统。与简单的问答式 AI 不同，Agent 具有以下特征：

- **自主性**：能够独立制定并执行计划
- **工具使用**：可以调用外部工具完成任务
- **环境感知**：能够获取和理解当前环境状态
- **持续执行**：能够多轮迭代直到任务完成
- **自我反思**：能够评估执行效果并调整策略

在旗鱼终端中，Agent 可以帮助用户执行服务器运维任务，如执行命令、读写文件、诊断问题等。

```
┌─────────────────────────────────────────────────────────────┐
│                        用户任务                              │
│                 "帮我诊断服务器响应慢"                         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                        Agent                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │  分析    │→ │  规划    │→ │  执行    │→ │  验证    │    │
│  │  任务    │  │  步骤    │  │  工具    │  │  结果    │    │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │
│                              ↑                              │
│                              │                              │
│                        反思 & 调整                           │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │   终端 / 工具    │
                    │  执行实际操作    │
                    └─────────────────┘
```

---

## ReAct 机制

### 什么是 ReAct

ReAct（Reasoning + Acting）是一种让 AI 模型交替进行"推理"和"行动"的框架。由 Yao et al. 在 2022 年提出，核心思想是：

> **先思考（Reason），再行动（Act），观察结果，循环往复**

这种模式让 AI 能够：
1. 通过推理分解复杂问题
2. 通过行动获取真实信息
3. 根据观察调整后续策略

### ReAct 的三个核心步骤

```
┌──────────────────────────────────────────────────────────┐
│                     ReAct 循环                            │
│                                                          │
│   ┌─────────┐      ┌─────────┐      ┌─────────┐         │
│   │ Thought │  →   │ Action  │  →   │Observation│        │
│   │  思考   │      │  行动   │      │   观察   │         │
│   └─────────┘      └─────────┘      └─────────┘         │
│        │                                  │              │
│        └──────────────────────────────────┘              │
│                     循环迭代                              │
└──────────────────────────────────────────────────────────┘
```

1. **Thought（思考）**：分析当前情况，决定下一步做什么
2. **Action（行动）**：调用工具执行具体操作
3. **Observation（观察）**：获取工具执行的结果

### 旗鱼终端中的 ReAct 实现

在 `prompt-builder.ts` 中定义了 ReAct 框架提示：

```typescript
function buildReActFramework(): string {
  return `## 推理框架（内心思考，不要说出来）

你是一个具备深度推理能力的智能体。以下是你的内心思考框架：

### 内心推理流程

**分析**：理解任务本质
- 明确任务目标和约束条件
- 识别需要的信息和可能的障碍
- 判断任务复杂度（简单/中等/复杂）

**规划**：制定执行策略
- 简单任务：直接执行
- 中等任务：列出 2-3 个关键步骤
- 复杂任务：制定完整计划，标注关键检查点

**执行**：每次工具调用
1. 用自然语言说明你要做什么（1 句话）
2. 执行操作
3. 用通俗语言解释结果

**验证**：任务结束前
- 回顾是否达成目标
- 给出清晰结论`
}
```

### ReAct 实际执行示例

```
用户：帮我查看服务器磁盘使用情况

---
【Agent 思考】服务器响应慢可能有多种原因，我先从系统负载开始排查。

【Action】execute_command: df -h

【Observation】
Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1       100G   85G   15G  85% /
/dev/sdb1       500G  200G  300G  40% /data

【Agent 思考】根分区使用率 85%，比较高。我来看看哪些目录占用空间最多。

【Action】execute_command: du -sh /* 2>/dev/null | sort -hr | head -10

【Observation】
45G     /var
25G     /usr
10G     /home

【Agent 总结】
磁盘分析结果：
- 根分区已用 85%（85G/100G），建议清理
- /var 目录占用 45G，可能是日志文件过多
- 数据盘 /data 使用率正常（40%）

建议：检查 /var/log 下的日志文件，清理过期日志。
```

---

## 工具调用（Function Calling）

### 什么是工具调用

工具调用是让 AI 模型能够调用外部函数或 API 的能力。当 AI 需要执行超出其能力范围的操作时（如执行系统命令、读写文件），它会生成一个结构化的"工具调用请求"，由程序执行后将结果返回给 AI。

```
┌─────────────────────────────────────────────────────────────┐
│                     工具调用流程                             │
│                                                             │
│   ┌────────┐    ┌────────────┐    ┌────────┐    ┌───────┐  │
│   │  AI    │ →  │ 工具调用   │ →  │ 执行器 │ →  │ 结果  │  │
│   │ 模型   │    │ 请求       │    │        │    │       │  │
│   └────────┘    └────────────┘    └────────┘    └───────┘  │
│                                                     │       │
│                                                     ▼       │
│                                              返回给 AI      │
└─────────────────────────────────────────────────────────────┘
```

### 工具定义

在 `tools.ts` 中定义了 Agent 可用的工具：

```typescript
export function getAgentTools(): ToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'execute_command',
        description: '在当前终端执行 shell 命令...',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: '要执行的 shell 命令'
            }
          },
          required: ['command']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: '读取本地文件内容...',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件路径' },
            start_line: { type: 'number', description: '起始行号' },
            end_line: { type: 'number', description: '结束行号' }
          },
          required: ['path']
        }
      }
    },
    // ... 更多工具
  ]
}
```

### 旗鱼终端的工具集

| 工具名称 | 功能描述 | 典型用途 |
|---------|---------|---------|
| `execute_command` | 执行 Shell 命令 | 运行系统命令、脚本 |
| `read_file` | 读取文件内容 | 查看配置、日志 |
| `write_file` | 写入文件 | 创建/修改配置文件 |
| `check_terminal_status` | 检查终端状态 | 判断命令是否完成 |
| `get_terminal_context` | 获取终端输出 | 查看命令执行结果 |
| `send_control_key` | 发送控制键 | 中断命令（Ctrl+C） |
| `send_input` | 发送文本输入 | 响应交互式提示 |
| `wait` | 等待指定时间 | 等待长耗时命令 |
| `ask_user` | 向用户提问 | 获取更多信息 |
| `remember_info` | 保存信息到知识库 | 记住重要发现 |
| `search_knowledge` | 搜索知识库 | 查找历史信息 |
| `create_plan` | 创建任务计划 | 复杂任务规划 |
| `update_plan` | 更新计划状态 | 标记步骤完成/失败 |

### 工具执行器

`tool-executor.ts` 负责实际执行工具调用：

```typescript
export async function executeTool(
  ptyId: string,
  toolCall: ToolCall,
  config: AgentConfig,
  terminalOutput: string[],
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const { name, arguments: argsStr } = toolCall.function
  const args = JSON.parse(argsStr)

  switch (name) {
    case 'execute_command':
      return executeCommand(ptyId, args, toolCall.id, config, executor)
    case 'read_file':
      return readFile(ptyId, args, config, executor)
    case 'write_file':
      return writeFile(ptyId, args, toolCall.id, config, executor)
    // ... 其他工具
    default:
      return { success: false, output: '', error: `未知工具: ${name}` }
  }
}
```

### 工具调用的消息格式

```typescript
// AI 返回的工具调用请求
{
  role: 'assistant',
  content: '我来检查磁盘使用情况',
  tool_calls: [{
    id: 'call_abc123',
    type: 'function',
    function: {
      name: 'execute_command',
      arguments: '{"command": "df -h"}'
    }
  }]
}

// 工具执行结果
{
  role: 'tool',
  tool_call_id: 'call_abc123',
  content: 'Filesystem      Size  Used Avail Use%...'
}
```

---

## 任务规划（Planning）

### 为什么需要规划

对于复杂任务，直接一步步执行可能会：
- 遗漏关键步骤
- 执行顺序混乱
- 难以追踪进度

任务规划让 Agent 能够：
- 分解复杂任务为可管理的步骤
- 明确步骤之间的依赖关系
- 实时展示执行进度

### 任务复杂度分析

在 `planner.ts` 中实现了任务复杂度分析：

```typescript
export function analyzeTaskComplexity(task: string): TaskComplexity {
  const taskLower = task.toLowerCase()
  
  // 复杂任务关键词
  const complexPatterns = [
    /排查|诊断|分析.*原因|故障|问题|为什么/,
    /部署|安装.*配置|搭建.*环境/,
    /迁移|备份.*恢复|升级/,
    /监控|告警|性能.*优化/,
    /自动化|脚本.*批量/,
  ]
  
  for (const pattern of complexPatterns) {
    if (pattern.test(taskLower)) return 'complex'
  }
  
  // 中等/简单判断...
  return 'simple'
}
```

### 任务规划示例

```
用户：帮我部署 Node.js 应用

---
【Agent 创建计划】

📋 任务计划：部署 Node.js 应用

1. ⏳ 检查系统环境
   - 确认 Node.js 和 npm 版本
   
2. ⏳ 安装依赖
   - 执行 npm install
   
3. ⏳ 构建项目
   - 执行 npm run build
   
4. ⏳ 启动服务
   - 启动应用并配置进程管理
   
5. ⏳ 验证运行
   - 检查服务是否正常响应

---
执行中...

1. ✅ 检查系统环境 - Node v18.17.0, npm 9.6.7
2. 🔄 安装依赖 - 正在安装...
3. ⏳ 构建项目
4. ⏳ 启动服务
5. ⏳ 验证运行
```

### Plan 相关工具

```typescript
// create_plan - 创建任务计划
{
  name: 'create_plan',
  description: '创建任务执行计划，向用户展示清晰的执行步骤和进度',
  parameters: {
    properties: {
      title: { type: 'string', description: '计划标题' },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '步骤标题' },
            description: { type: 'string', description: '步骤详细说明' }
          }
        }
      }
    }
  }
}

// update_plan - 更新步骤状态
{
  name: 'update_plan',
  description: '更新计划步骤状态',
  parameters: {
    properties: {
      step_index: { type: 'number', description: '步骤索引（从0开始）' },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed', 'failed', 'skipped']
      },
      result: { type: 'string', description: '步骤结果说明' }
    }
  }
}
```

---

## 反思与自我监控（Reflection）

### 为什么需要反思

在复杂任务执行中，Agent 可能会遇到：
- 命令执行失败
- 陷入重复循环
- 策略不适合当前情况

反思机制帮助 Agent：
- 检测执行问题
- 动态调整策略
- 避免无效重复

### 反思状态追踪

在 `types.ts` 中定义了反思状态：

```typescript
export interface ReflectionState {
  toolCallCount: number           // 工具调用计数
  failureCount: number            // 连续失败次数
  totalFailures: number           // 总失败次数
  successCount: number            // 成功次数
  lastCommands: string[]          // 最近执行的命令
  lastToolCalls: string[]         // 最近的工具调用签名
  lastReflectionAt: number        // 上次反思时的步数
  reflectionCount: number         // 反思次数
  currentStrategy: ExecutionStrategy  // 当前执行策略
  strategySwitches: StrategySwitchRecord[]  // 策略切换历史
  detectedIssues: string[]        // 检测到的问题
}
```

### 循环检测

```typescript
// 检测命令循环
private detectCommandLoop(commands: string[]): boolean {
  if (commands.length < 3) return false
  
  // 检查最后 3 个命令是否相同
  const last3 = commands.slice(-3)
  if (last3[0] === last3[1] && last3[1] === last3[2]) {
    return true
  }
  
  // 检查 AB-AB 模式
  if (commands.length >= 4) {
    const last4 = commands.slice(-4)
    if (last4[0] === last4[2] && last4[1] === last4[3]) {
      return true
    }
  }
  
  return false
}
```

### 策略动态切换

```typescript
// 执行策略类型
type ExecutionStrategy = 'default' | 'conservative' | 'aggressive' | 'diagnostic'

// 策略切换逻辑
private shouldSwitchStrategy(run: AgentRun): { 
  should: boolean
  newStrategy?: ExecutionStrategy
  reason?: string 
} {
  const issues = this.detectExecutionIssues(run)
  
  // 连续失败 -> 切换到保守策略
  if (issues.includes('consecutive_failures')) {
    return {
      should: true,
      newStrategy: 'conservative',
      reason: `连续失败 ${run.reflection.failureCount} 次，切换到保守策略`
    }
  }
  
  // 检测到循环 -> 切换到保守策略
  if (issues.includes('detected_command_loop')) {
    return {
      should: true,
      newStrategy: 'conservative',
      reason: '检测到执行循环，切换到保守策略'
    }
  }
  
  // 执行顺利 -> 可恢复默认策略
  if (issues.length === 0 && run.reflection.successCount >= 3) {
    return {
      should: true,
      newStrategy: 'default',
      reason: '执行顺利，切换回默认策略'
    }
  }
  
  return { should: false }
}
```

### 反思提示注入

当检测到问题时，会向 AI 注入反思提示：

```typescript
private generateReflectionPrompt(run: AgentRun): string | null {
  const issues = this.detectExecutionIssues(run)
  
  // 反思次数过多，强制停止
  if (issues.includes('too_many_reflections')) {
    return null  // 信号：应该强制停止
  }
  
  const prompts: string[] = []
  
  if (issues.includes('detected_command_loop')) {
    prompts.push('你在重复操作。直接告诉用户遇到了什么问题，然后停止。')
  }
  
  if (issues.includes('consecutive_failures')) {
    prompts.push('多次失败，告诉用户具体问题，停止尝试。')
  }
  
  return prompts.length > 0 
    ? `（${prompts.join(' ')}不要分析原因，简短说明后结束。）`
    : ''
}
```

---

## 风险评估与确认机制

### 命令风险等级

在 `risk-assessor.ts` 中实现了命令风险评估：

```typescript
export function assessCommandRisk(command: string): RiskLevel {
  const cmd = command.toLowerCase().trim()

  // 黑名单 - 直接拒绝
  const blocked = [
    /rm\s+(-[rf]+\s+)*\/(?:\s|$)/,    // rm -rf /
    /mkfs\./,                          // 格式化磁盘
    /dd\s+.*of=\/dev\/[sh]d[a-z]/,    // dd 写入磁盘
  ]
  if (blocked.some(p => p.test(cmd))) return 'blocked'

  // 高危 - 需要确认
  const dangerous = [
    /\brm\s+(-[rf]+\s+)*/,             // rm 命令
    /\bkill\s+/,                       // kill 命令
    /\bshutdown\b/,                    // shutdown
    /\breboot\b/,                      // reboot
    /\bsystemctl\s+(stop|restart)/,   // systemctl 危险操作
  ]
  if (dangerous.some(p => p.test(cmd))) return 'dangerous'

  // 中危 - 显示但可自动执行
  const moderate = [
    /\bmv\s+/,                          // mv
    /\bcp\s+/,                          // cp
    /\bapt\s+install/,                  // apt install
    /\bnpm\s+install/,                  // npm install
  ]
  if (moderate.some(p => p.test(cmd))) return 'moderate'

  // 安全 - 直接执行
  return 'safe'
}
```

### 风险等级说明

| 等级 | 说明 | 处理方式 |
|------|------|----------|
| `safe` | 只读/信息查询命令 | 自动执行 |
| `moderate` | 修改类但可恢复 | 根据配置自动或确认 |
| `dangerous` | 高风险/不可逆操作 | 需要用户确认 |
| `blocked` | 破坏性命令 | 直接拒绝 |

### 执行模式

```typescript
export type ExecutionMode = 'strict' | 'relaxed' | 'free'
```

- **strict（严格模式）**：所有命令都需确认
- **relaxed（宽松模式）**：仅危险命令需确认
- **free（自由模式）**：全自动执行（谨慎使用）

### 确认流程

```typescript
// 等待用户确认
private waitForConfirmation(
  agentId: string,
  toolCallId: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
  riskLevel: RiskLevel
): Promise<boolean> {
  return new Promise((resolve) => {
    const confirmation: PendingConfirmation = {
      agentId,
      toolCallId,
      toolName,
      toolArgs,
      riskLevel,
      resolve: (approved, modifiedArgs) => {
        if (modifiedArgs) {
          Object.assign(toolArgs, modifiedArgs)
        }
        resolve(approved)
      }
    }
    
    run.pendingConfirmation = confirmation
    
    // 通知前端需要确认
    callbacks.onNeedConfirm?.(confirmation)
  })
}
```

---

## 知识库与记忆（Memory）

### 为什么需要记忆

每次对话都从零开始效率低下。记忆机制让 Agent：
- 记住主机特定信息（目录、配置、服务）
- 复用历史发现，避免重复探索
- 越用越熟悉每台服务器

### 记忆工具

```typescript
// remember_info - 保存信息到知识库
{
  name: 'remember_info',
  description: `保存发现到知识库，下次交互时会自动召回。
  
  积极记录以下内容：
  - 目录和路径：项目目录、配置文件位置、日志位置
  - 服务信息：端口号、启动命令、配置文件位置
  - 环境配置：软件版本、环境变量
  - 问题和方案：遇到的问题及解决方法`,
  parameters: {
    properties: {
      info: { type: 'string', description: '要记住的信息' }
    }
  }
}

// search_knowledge - 搜索知识库
{
  name: 'search_knowledge',
  description: '搜索用户的知识库文档',
  parameters: {
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      limit: { type: 'number', description: '返回结果数量' }
    }
  }
}
```

### 记忆的自动召回

在构建系统提示时，会自动加载相关的主机记忆：

```typescript
// 获取主机记忆
if (context.hostId) {
  hostMemories = await knowledgeService.getHostMemoriesForPrompt(
    context.hostId, 
    userMessage,  // 使用用户消息作为上下文
    30  // 最多 30 条相关记忆
  )
}

// 添加到系统提示
if (hostMemories.length > 0) {
  hostContext += '\n\n## 已知信息（来自历史交互）'
  for (const memory of hostMemories) {
    hostContext += `\n- ${memory}`
  }
}
```

### 上下文压缩（Memory Folding）

当对话过长时，采用智能压缩策略：

```typescript
private async compressMessages(
  messages: AiMessage[], 
  maxTokens?: number
): Promise<AiMessage[]> {
  // 1. 将消息按轮次分组
  const messageGroups = this.groupMessagesByTurn(messages)
  
  // 2. 压缩工具输出（保留头尾）
  const compressedGroups = messageGroups.map(group => 
    group.map(msg => {
      if (msg.role === 'tool' && msg.content.length > 2000) {
        return { ...msg, content: this.compressToolOutput(msg.content) }
      }
      return msg
    })
  )
  
  // 3. 提取关键信息作为记忆锚点
  const keyPoints = this.extractKeyPoints(allCompressedMessages)
  
  // 4. 选择最重要的历史组
  // 5. 构建摘要 + 重要历史 + 最近对话
  
  return finalMessages
}
```

---

## 多 Agent 协调（Orchestrator）

### 什么是 Orchestrator

当需要在多台服务器上执行任务时（如智能巡检），使用 Orchestrator（协调器）模式：

```
┌─────────────────────────────────────────────────────────────┐
│                    Orchestrator (Master Agent)               │
│                                                             │
│  1. 解析任务        2. 识别目标服务器     3. 分配任务        │
│  4. 监控执行        5. 汇总结果          6. 生成报告        │
└─────────────────────────────────────────────────────────────┘
           │                    │                    │
           ▼                    ▼                    ▼
    ┌────────────┐      ┌────────────┐      ┌────────────┐
    │  Worker 1  │      │  Worker 2  │      │  Worker 3  │
    │ (prod-web) │      │ (prod-db)  │      │ (prod-api) │
    └────────────┘      └────────────┘      └────────────┘
           │                    │                    │
           ▼                    ▼                    ▼
    ┌────────────┐      ┌────────────┐      ┌────────────┐
    │ SSH 终端 1 │      │ SSH 终端 2 │      │ SSH 终端 3 │
    └────────────┘      └────────────┘      └────────────┘
```

### Orchestrator 工具

```typescript
const orchestratorTools = [
  {
    name: 'list_available_hosts',
    description: '列出可用的服务器'
  },
  {
    name: 'connect_terminal',
    description: '连接到指定服务器',
    parameters: {
      properties: {
        type: { enum: ['local', 'ssh'] },
        host_id: { type: 'string' },
        alias: { type: 'string' }
      }
    }
  },
  {
    name: 'dispatch_task',
    description: '派发任务给单个终端',
    parameters: {
      properties: {
        terminal_id: { type: 'string' },
        task: { type: 'string' }
      }
    }
  },
  {
    name: 'parallel_dispatch',
    description: '并行派发任务给多个终端',
    parameters: {
      properties: {
        terminal_ids: { type: 'array' },
        task: { type: 'string' }
      }
    }
  },
  {
    name: 'collect_results',
    description: '收集各终端的执行结果'
  },
  {
    name: 'analyze_and_report',
    description: '分析结果并生成报告',
    parameters: {
      properties: {
        findings: { type: 'array' },
        recommendations: { type: 'array' },
        severity: { enum: ['info', 'warning', 'critical'] }
      }
    }
  }
]
```

### 协调器执行流程

```typescript
private async runMasterAgent(orchestratorId: string): Promise<void> {
  const tools = getOrchestratorTools()
  const messages = [
    { role: 'system', content: this.buildSystemPrompt() },
    { role: 'user', content: run.task }
  ]
  
  while (run.status === 'running' && maxIterations-- > 0) {
    // 1. 调用 AI
    const response = await this.aiService.chatWithTools(messages, tools)
    
    // 2. 处理工具调用
    for (const toolCall of response.tool_calls) {
      const result = await this.executeOrchestratorTool(
        orchestratorId,
        toolCall.function.name,
        JSON.parse(toolCall.function.arguments)
      )
      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result })
    }
    
    // 3. 检查是否完成
    if (!response.tool_calls) {
      run.status = 'completed'
      break
    }
  }
}
```

---

## 核心代码解析

### Agent 主循环

`index.ts` 中的核心执行循环：

```typescript
async run(
  ptyId: string,
  userMessage: string,
  context: AgentContext,
  config?: Partial<AgentConfig>
): Promise<string> {
  // 1. 初始化运行状态
  const run: AgentRun = {
    id: this.generateId(),
    messages: [],
    steps: [],
    isRunning: true,
    reflection: { /* 反思状态初始化 */ }
  }
  
  // 2. 构建系统提示
  const systemPrompt = buildSystemPrompt(context, ...)
  run.messages.push({ role: 'system', content: systemPrompt })
  
  // 3. 添加用户消息
  run.messages.push({ role: 'user', content: userMessage })
  
  // 4. Agent 执行循环
  while (run.isRunning && !run.aborted) {
    // 4.1 调用 AI（流式）
    const response = await this.aiService.chatWithToolsStream(
      run.messages,
      getAgentTools(),
      onChunk,
      onToolCall,
      onDone
    )
    
    // 4.2 如果有工具调用
    if (response.tool_calls) {
      // 添加 assistant 消息
      run.messages.push({
        role: 'assistant',
        content: response.content,
        tool_calls: response.tool_calls
      })
      
      // 执行每个工具
      for (const toolCall of response.tool_calls) {
        const result = await executeTool(ptyId, toolCall, config, ...)
        
        // 更新反思追踪
        this.updateReflectionTracking(run, toolCall.function.name, args, result)
        
        // 添加工具结果
        run.messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result.output
        })
      }
      
      // 检查是否需要反思
      if (this.shouldTriggerReflection(run)) {
        const prompt = this.generateReflectionPrompt(run)
        if (prompt) {
          run.messages.push({ role: 'user', content: prompt })
        }
      }
    } else {
      // 没有工具调用，任务完成
      break
    }
  }
  
  return lastResponse?.content || '任务完成'
}
```

### 关键文件结构

```
electron/services/agent/
├── index.ts          # Agent 主服务，核心执行循环
├── types.ts          # 类型定义
├── tools.ts          # 工具定义（Function Calling）
├── tool-executor.ts  # 工具执行器
├── prompt-builder.ts # 系统提示构建器
├── planner.ts        # 任务规划器
├── risk-assessor.ts  # 风险评估
├── orchestrator.ts   # 多 Agent 协调器
├── orchestrator-tools.ts  # 协调器工具
└── i18n.ts           # 国际化
```

---

## 总结

旗鱼终端的 Agent 实现展示了一个完整的 AI Agent 系统应该具备的核心能力：

1. **ReAct 机制**：推理与行动交替进行，形成闭环
2. **工具调用**：通过结构化的 Function Calling 扩展能力
3. **任务规划**：分解复杂任务，可视化执行进度
4. **反思机制**：自我监控，动态调整策略
5. **风险控制**：多级风险评估，危险操作需确认
6. **知识记忆**：积累信息，越用越智能
7. **多 Agent 协调**：Master-Worker 模式处理分布式任务

这些机制共同构成了一个可靠、智能、安全的 AI 运维助手。

---

## 参考资料

- [ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629)
- [OpenAI Function Calling](https://platform.openai.com/docs/guides/function-calling)
- [LangChain Agents](https://python.langchain.com/docs/modules/agents/)
- [AutoGPT](https://github.com/Significant-Gravitas/AutoGPT)

