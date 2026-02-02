# Agent 工作原理：以旗鱼终端为例

本文档以旗鱼终端（SFTerminal）的 Agent 实现为例，详细介绍 AI Agent 的工作原理，包括 ReAct 机制、工具调用、任务规划等核心概念。

---

## 目录

1. [什么是 Agent](#什么是-agent)
2. [ReAct 机制](#react-机制)
3. [工具调用（Function Calling）](#工具调用function-calling)
4. [任务规划（Planning）](#任务规划planning)
5. [风险评估与确认机制](#风险评估与确认机制)
7. [知识库与记忆（Memory）](#知识库与记忆memory)
8. [任务记忆系统（Task Memory）](#任务记忆系统task-memory)
9. [技能系统（Skill System）](#技能系统skill-system)
10. [核心代码解析](#核心代码解析)

---

## 什么是 Agent

Agent（智能体）是一种能够感知环境、做出决策并采取行动的 AI 系统。与简单的问答式 AI 不同，Agent 具有以下特征：

- **自主性**：能够独立制定并执行计划
- **工具使用**：可以调用外部工具完成任务
- **环境感知**：能够获取和理解当前环境状态
- **持续执行**：能够多轮迭代直到任务完成

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

在 `prompt-builder.ts` 中，ReAct 框架被集成到系统提示中：

```typescript
## 工作方式
- **调用工具前**：用 1 句话说明你要做什么
- **工具执行后**：用通俗语言解释结果和发现
- **关键操作后**：主动验证结果，不假设成功
- **遇到问题时**：动态调整策略，而非机械重试
```

### ReAct 实际执行示例

```
用户：帮我查看服务器磁盘使用情况

---
【Agent 思考】我来检查一下磁盘使用情况。

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
export function getAgentTools(mcpService?: McpService, options?: GetAgentToolsOptions): ToolDefinition[] {
  const builtinTools: ToolDefinition[] = [
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
    // ... 更多工具
  ]
  
  // 根据运行模式过滤工具（local/ssh/assistant）
  let filteredTools = builtinTools
  if (options?.mode) {
    filteredTools = builtinTools.filter(tool => {
      const meta = (tool as ToolDefinitionWithMeta)._meta
      if (!meta?.supportedModes) return true
      return meta.supportedModes.includes(options.mode!)
    })
  }
  
  return filteredTools
}
```

### 旗鱼终端的工具集

#### 终端操作类

| 工具名称 | 功能描述 | 适用场景 |
|---------|---------|---------|
| `execute_command` | 执行 Shell 命令 | 运行系统命令、脚本 |
| `check_terminal_status` | 检查终端状态 | 判断命令是否完成、是否需要输入 |
| `get_terminal_context` | 获取终端输出 | 查看命令执行结果 |
| `send_control_key` | 发送控制键 | 中断命令（Ctrl+C）、退出分页器 |
| `send_input` | 发送文本输入 | 响应交互式提示（y/n、密码等） |
| `wait` | 等待指定时间 | 等待长耗时命令完成 |

#### 文件操作类

| 工具名称 | 功能描述 | 适用模式 |
|---------|---------|---------|
| `read_file` | 读取文件内容（支持 PDF/Word） | 本地 |
| `edit_file` | 精确编辑文件（查找替换） | 本地 |
| `write_local_file` | 创建/覆盖/追加本地文件 | 本地 |
| `write_remote_file` | 通过 SFTP 写入远程文件 | SSH |
| `file_search` | 快速搜索文件（Spotlight/Everything） | 本地 |

#### 知识库类

| 工具名称 | 功能描述 |
|---------|---------|
| `remember_info` | 保存发现到知识库 |
| `search_knowledge` | 搜索知识库文档 |
| `get_knowledge_doc` | 按 ID 获取完整文档 |

#### 任务计划类

| 工具名称 | 功能描述 |
|---------|---------|
| `create_plan` | 创建任务执行计划 |
| `update_plan` | 更新步骤状态 |
| `clear_plan` | 归档当前计划 |

#### 任务记忆类

| 工具名称 | 功能描述 |
|---------|---------|
| `recall_task` | 回忆任务关键信息摘要 |
| `deep_recall` | 获取任务完整执行步骤 |

#### 交互与扩展类

| 工具名称 | 功能描述 |
|---------|---------|
| `ask_user` | 向用户提问等待回复 |
| `load_skill` | 加载技能模块获得额外能力 |
| `load_user_skill` | 加载用户自定义技能 |

### 工具执行器

`tools/index.ts` 负责实际执行工具调用，工具实现按功能模块拆分：

```typescript
// 导入各模块的工具函数
import { executeCommand } from './command'
import { getTerminalContext, checkTerminalStatus, sendControlKey, sendInput } from './terminal'
import { fileSearch, readFile, editFile, writeLocalFile, writeRemoteFile } from './file'
import { rememberInfo, searchKnowledge, getKnowledgeDoc } from './knowledge'
import { createPlan, updatePlan, clearPlan } from './plan'
import { recallTask, deepRecall } from './memory'
import { wait, askUser, loadSkillTool, executeSkillTool } from './misc'

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
      return await readFile(ptyId, args, config, executor)
    // ... 其他工具
    default:
      // 检查是否是技能工具调用
      if (executor.skillSession) {
        const skillTools = executor.skillSession.getAvailableTools()
        if (skillTools.find(t => t.function.name === name)) {
          return await executeSkillTool(name, ptyId, args, toolCall.id, config, executor)
        }
      }
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

### 何时使用计划

```typescript
## 任务计划
- 1-3 步的简单任务：直接执行，不要创建 plan
- 4+ 步骤且有依赖关系：使用 create_plan
- 用户说"直接做"/"快速帮我"：不要创建 plan
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

// clear_plan - 归档计划
{
  name: 'clear_plan',
  description: '归档当前计划，保存到历史记录中'
}
```

---

## 风险评估与确认机制

### 命令处理策略

在 `risk-assessor.ts` 中实现了命令分析：

```typescript
export function analyzeCommand(command: string): CommandHandlingInfo {
  const cmd = command.trim()
  const cmdName = cmd.toLowerCase().split(/\s+/)[0]

  // ==================== 完全禁止的命令 ====================
  const blockedCommands = {
    'vim': '请使用 write_local_file 工具',
    'vi': '请使用 write_local_file 工具',
    'nano': '请使用 write_local_file 工具',
    'tmux': '不支持终端复用器',
    'screen': '不支持终端复用器',
  }
  if (blockedCommands[cmdName]) {
    return { strategy: 'block', reason: `禁止使用 ${cmdName}` }
  }

  // ==================== 可以自动修正的命令 ====================
  // apt install 没有 -y → 自动添加 -y
  if (/\b(apt|yum|dnf)\s+install\b/.test(cmd) && !/\s-y\b/.test(cmd)) {
    return {
      strategy: 'auto_fix',
      fixedCommand: cmd.replace(/install\b/, 'install -y')
    }
  }

  // ==================== 持续运行的命令 ====================
  // tail -f, ping（无 -c）, watch, top/htop 等
  if (/\btail\s+.*-f\b/.test(cmd)) {
    return {
      strategy: 'fire_and_forget',
      hint: '用 get_terminal_context 查看输出，用 send_control_key("ctrl+c") 停止'
    }
  }

  return { strategy: 'allow' }
}
```

### 命令风险等级

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

  // 数据库命令单独评估
  if (isDatabaseCommand(command)) {
    return assessDatabaseRisk(command)
  }

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

  return 'safe'
}
```

### 数据库命令风险评估

```typescript
export function assessDatabaseRisk(command: string): RiskLevel {
  const cmd = command.toLowerCase().trim()
  
  // 高危 - 需要确认
  const dangerousDb = [
    /\bdrop\s+(database|table)\b/i,      // DROP DATABASE/TABLE
    /\btruncate\s+(table\s+)?\w+/i,      // TRUNCATE
    /\bdelete\s+from\s+\w+\s*(?:;|$)/i,  // DELETE 无 WHERE
    /\bflushall\b/i,                     // Redis FLUSHALL
  ]
  if (dangerousDb.some(p => p.test(cmd))) return 'dangerous'
  
  return 'safe'
}
```

### 风险等级说明

| 等级 | 说明 | 处理方式 |
|------|------|----------|
| `safe` | 只读/信息查询命令 | 自动执行 |
| `moderate` | 修改类但可恢复 | 根据配置自动或确认 |
| `dangerous` | 高风险/不可逆操作 | 需要用户确认 |
| `blocked` | 破坏性命令或禁止的交互式程序 | 直接拒绝 |

### 执行模式

```typescript
export type ExecutionMode = 'strict' | 'relaxed' | 'free'
```

- **strict（严格模式）**：所有命令都需确认
- **relaxed（宽松模式）**：仅危险命令需确认
- **free（自由模式）**：全自动执行（谨慎使用）

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
  description: `保存发现到知识库，下次交互时会基于语义相关性自动提供。
  
  积极记录以下内容：
  - 目录和路径：项目目录、配置文件位置、日志位置
  - 服务信息：端口号、启动命令、配置文件位置
  - 环境配置：软件版本、环境变量
  - 问题和方案：遇到的问题及解决方法`
}

// search_knowledge - 搜索知识库
{
  name: 'search_knowledge',
  description: '搜索用户的知识库文档。搜索结果已包含文档内容，直接使用即可。'
}

// get_knowledge_doc - 精确获取文档
{
  name: 'get_knowledge_doc',
  description: '按文档 ID 精确获取知识库中的完整文档内容。'
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
  for (const memory of hostMemories.slice(0, 15)) {
    hostContext += `\n- ${memory}`
  }
}
```

---

## 任务记忆系统（Task Memory）

### 多层次上下文管理

任务记忆采用分层压缩策略，平衡上下文质量与 token 预算：

```
┌─────────────────────────────────────────────────────────────┐
│                    任务记忆层次                              │
│                                                             │
│  Level 0  ───────────────────────────────────────────────   │
│  完整对话：用户请求 + 所有工具调用/结果 + AI 回复            │
│  （最近 1 个任务强制使用）                                   │
│                                                             │
│  Level 1  ───────────────────────────────────────────────   │
│  压缩对话：用户请求 + 压缩后的工具输出 + AI 回复             │
│                                                             │
│  Level 2  ───────────────────────────────────────────────   │
│  精简对话：用户请求 + AI 最终回复                            │
│  （失败/中止任务至少保留此级别）                             │
│                                                             │
│  Level 3  ───────────────────────────────────────────────   │
│  L2 摘要：命令、路径、服务、错误、关键发现                   │
│                                                             │
│  Level 4  ───────────────────────────────────────────────   │
│  L1 总结：一句话概要（~50 字符）                             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 任务记忆结构

```typescript
export interface TaskMemory {
  id: string                      // 任务 ID
  userRequest: string             // 用户原始请求
  timestamp: number               // 执行时间
  status: 'success' | 'failed' | 'aborted' | 'pending_confirmation'
  
  // L1: 一句话总结（~50 字符）
  summary: string
  
  // L2: 关键步骤摘要
  digest: {
    commands: string[]            // 执行的关键命令
    paths: string[]               // 涉及的文件路径
    services: string[]            // 涉及的服务名
    errors: string[]              // 遇到的错误
    keyFindings: string[]         // 关键发现
  }
  
  // L3: 完整执行步骤
  fullSteps: AgentStep[]
  
  // 语义索引
  keywords: string[]              // 关键词（用于快速匹配）
}
```

### 上下文预算分配

```typescript
export function calculateBudget(contextLength: number): ContextBudget {
  const total = Math.floor(contextLength * 0.8)  // 预留 20% 给当前对话
  
  return {
    total,
    systemPrompt: 3000,                           // 固定约 3000 tokens
    knowledge: Math.floor(total * 0.15),          // 15% 给知识库
    recentTasks: Math.floor(total * 0.40),        // 40% 给最近任务
    nearTasks: Math.floor(total * 0.10),          // 10% 给较近任务摘要
    historySummary: Math.floor(total * 0.05),     // 5% 给历史总结
    currentConversation: Math.floor(total * 0.10) // 10% 预留
  }
}
```

### 任务回忆工具

```typescript
// recall_task - 获取任务摘要
{
  name: 'recall_task',
  description: `回忆之前任务的关键信息摘要。
  返回：commands, paths, services, errors, keyFindings`
}

// deep_recall - 获取完整步骤
{
  name: 'deep_recall',
  description: `深度回忆：获取某个任务的完整原始执行步骤。
  当需要查看命令的完整输出时使用。`
}
```

---

## 技能系统（Skill System）

### 什么是技能

技能是一组相关工具的集合，可以按需动态加载。这种设计避免了工具列表过长，同时保持了灵活性。

```
┌─────────────────────────────────────────────────────────────┐
│                     技能系统架构                             │
│                                                             │
│  ┌─────────────┐   load_skill    ┌─────────────────────┐   │
│  │  核心工具    │ ─────────────→ │  技能工具           │   │
│  │  (默认加载)  │                │  (按需加载)          │   │
│  └─────────────┘                └─────────────────────┘   │
│                                                             │
│  核心工具：                       技能工具：                │
│  - execute_command               - Excel: excel_*          │
│  - read_file                     - Email: email_*          │
│  - write_local_file             - Browser: browser_*       │
│  - ...                          - Word: word_*             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 可用技能

| 技能 ID | 技能名称 | 功能描述 |
|---------|---------|---------|
| `excel` | Excel 文档 | 创建、读取、编辑 Excel 文件 |
| `email` | 邮件 | 发送邮件（支持 OAuth） |
| `browser` | 浏览器 | 网页自动化（截图、爬取） |
| `word` | Word 文档 | 创建 Word 文档 |

### 技能定义结构

```typescript
export interface Skill {
  id: string                      // 技能唯一标识
  name: string                    // 技能名称（用于显示）
  description: string             // 技能描述
  tools: ToolDefinition[]         // 该技能提供的工具列表
  init?: () => Promise<void>      // 初始化函数
  cleanup?: () => Promise<void>   // 清理函数
}
```

### 技能会话管理

```typescript
export interface SkillSessionManager {
  getLoadedSkills(): string[]
  loadSkill(skillId: string): Promise<SkillLoadResult>
  unloadSkill(skillId: string): Promise<void>
  getAvailableTools(): ToolDefinition[]
  cleanup(): Promise<void>
}
```

### 用户自定义技能

除了内置技能，用户还可以创建 SKILL.md 文件定义自己的操作指南：

```typescript
// load_user_skill - 加载用户技能
{
  name: 'load_user_skill',
  description: `加载用户自定义技能的完整内容。
  用户技能是 SKILL.md 文件，包含特定领域的操作指南和最佳实践。`
}
```

---

## 核心代码解析

### OOP 架构设计

旗鱼终端采用面向对象的 Agent 架构：

```
┌─────────────────────────────────────────────────────────────┐
│                     Agent 类层次结构                         │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                   Agent（抽象基类）                   │   │
│  │                                                       │   │
│  │  核心方法：                                           │   │
│  │  - run(): 执行任务                                    │   │
│  │  - abort(): 中止执行                                  │   │
│  │  - executeLoop(): 主执行循环                          │   │
│  │  - executeToolCalls(): 工具调用                       │   │
│  │                                                       │   │
│  │  抽象方法（子类实现）：                                │   │
│  │  - getAvailableTools(): 获取工具列表                  │   │
│  │  - buildSystemPrompt(): 构建系统提示                  │   │
│  │  - getAgentId(): 获取标识                             │   │
│  └─────────────────────────────────────────────────────┘   │
│                            ▲                                │
│                            │ 继承                           │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              TerminalAgent（终端实现）                │   │
│  │                                                       │   │
│  │  - 终端特定的工具列表（local/ssh 模式）               │   │
│  │  - 终端特定的系统提示构建                             │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Agent 主循环

`agent.ts` 中的核心执行循环：

```typescript
async run(message: string, context: AgentContext, options?: RunOptions): Promise<string> {
  // 1. 初始化运行状态
  const run = this.initializeRun(message, context, options)
  
  try {
    // 2. 构建上下文（知识库、任务历史、系统提示）
    await this.buildContext(run, message, options?.profileId)
    
    // 3. 执行主循环
    const result = await this.executeLoop(run)
    
    // 4. 完成运行，保存任务记忆
    this.finalizeRun(run, result)
    return result
  } catch (error) {
    this.handleError(run, error)
    throw error
  } finally {
    this.cleanupRun(run)
  }
}

protected async executeLoop(run: AgentRun): Promise<string> {
  let stepCount = 0
  const toolExecutorConfig = this.createToolExecutorConfig(run)
  
  while (run.isRunning && !run.aborted) {
    stepCount++
    
    // 处理待处理的用户消息
    this.processPendingUserMessages(run)
    
    // 执行单步
    const stepResult = await this.executeStep(run, toolExecutorConfig)
    
    // 没有工具调用时检查是否完成
    if (!stepResult.hasToolCalls) {
      const planAction = this.checkPlanProgress(run)
      if (planAction === 'complete') {
        return stepResult.response?.content || '任务完成'
      }
    }
  }
  
  return '任务完成'
}
```

### 执行阶段

```typescript
export type AgentExecutionPhase = 
  | 'thinking'           // AI 思考/生成响应中
  | 'executing_command'  // 执行终端命令中
  | 'writing_file'       // 写入文件中
  | 'waiting'            // wait 工具等待中
  | 'confirming'         // 等待用户确认中
  | 'idle'               // 空闲
```

### 关键文件结构

```
electron/services/agent/
├── agent.ts              # Agent 抽象基类，核心执行逻辑
├── terminal-agent.ts     # 终端 Agent 实现
├── index.ts              # 模块入口，导出服务
├── types.ts              # 类型定义
├── tools.ts              # 工具定义（Function Calling）
├── prompt-builder.ts     # 系统提示构建器（OOP 版本）
├── context-builder.ts    # 上下文构建器（任务历史压缩）
├── task-memory.ts        # 任务记忆存储
├── risk-assessor.ts      # 风险评估
├── i18n.ts               # 国际化
├── tools/                # 工具执行器（按功能拆分）
│   ├── index.ts          # 工具执行入口
│   ├── command.ts        # 命令执行
│   ├── terminal.ts       # 终端操作
│   ├── file.ts           # 文件操作
│   ├── knowledge.ts      # 知识库操作
│   ├── plan.ts           # 计划/待办
│   ├── memory.ts         # 任务记忆
│   ├── misc.ts           # 其他工具
│   ├── types.ts          # 工具类型
│   └── utils.ts          # 工具函数
└── skills/               # 技能系统
    ├── index.ts          # 技能入口
    ├── registry.ts       # 技能注册表
    ├── skill-loader.ts   # 技能加载器
    ├── types.ts          # 技能类型
    ├── excel/            # Excel 技能
    ├── email/            # 邮件技能
    ├── browser/          # 浏览器技能
    └── word/             # Word 技能
```

---

## 总结

旗鱼终端的 Agent 实现展示了一个完整的 AI Agent 系统应该具备的核心能力：

1. **ReAct 机制**：推理与行动交替进行，形成闭环
2. **工具调用**：通过结构化的 Function Calling 扩展能力
3. **任务规划**：分解复杂任务，可视化执行进度
4. **风险控制**：多级风险评估，危险操作需确认
5. **知识记忆**：积累信息，越用越智能
6. **任务记忆**：多层次压缩，智能上下文管理
7. **技能系统**：按需加载额外能力，保持灵活性
8. **OOP 架构**：清晰的类层次，便于扩展和维护

这些机制共同构成了一个可靠、智能、安全的 AI 运维助手。

---

## 参考资料

- [ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629)
- [OpenAI Function Calling](https://platform.openai.com/docs/guides/function-calling)
- [LangChain Agents](https://python.langchain.com/docs/modules/agents/)
- [AutoGPT](https://github.com/Significant-Gravitas/AutoGPT)
