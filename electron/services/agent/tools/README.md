# Agent 工具执行器模块

本目录包含 Agent 的工具执行实现，按功能拆分为多个模块。

## 模块结构

```
tools/
├── index.ts        # 模块入口，executeTool 主函数
├── types.ts        # 类型定义 (ToolExecutorConfig, ErrorCategory 等)
├── utils.ts        # 通用工具函数 (错误处理、重试、截断等)
├── command.ts      # 命令执行 (execute_command, sudo, 限时执行等)
├── terminal.ts     # 终端操作 (get_terminal_context, check_terminal_status 等)
├── file.ts         # 文件操作 (read_file, write_local_file, edit_file 等)
├── knowledge.ts    # 知识库 (remember_info, search_knowledge 等)
├── plan.ts         # 计划/待办 (create_plan, update_plan, clear_plan)
├── memory.ts       # 任务记忆 (recall_task, deep_recall)
├── context.ts      # 上下文管理 (compress_context, recall_compressed, manage_memory)
├── misc.ts         # 其他工具 (wait, ask_user, MCP, 技能工具)
└── README.md       # 本文档
```

## 工具清单

### 命令执行 (command.ts)
- `execute_command` - 执行终端命令，支持风险评估、自动确认、超时处理
- `executeSudoCommand` - 执行 sudo 命令，处理密码输入
- `executeFireAndForget` - 执行持续运行的命令 (如 tail -f, ping)
- `executeTimedCommand` - 限时执行命令

### 终端操作 (terminal.ts)
- `get_terminal_context` - 获取终端最近 N 行输出
- `check_terminal_status` - 检查终端状态（空闲/忙碌/等待输入）
- `send_control_key` - 发送控制键 (Ctrl+C, Ctrl+D 等)
- `send_input` - 发送文本输入

### 文件操作 (file.ts)
- `read_file` - 读取文件（支持部分读取、文档解析）
- `write_local_file` - 写入本地文件（多种模式）
- `write_remote_file` - 通过 SFTP 写入远程文件
- `edit_file` - 精确编辑文件（查找替换）
- `file_search` - 本地文件搜索

### 知识库 (knowledge.ts)
- `remember_info` - 记忆信息到知识库
- `search_knowledge` - 搜索知识库
- `get_knowledge_doc` - 获取知识库文档

### 计划/待办 (plan.ts)
- `create_plan` - 创建执行计划
- `update_plan` - 更新计划步骤状态
- `clear_plan` - 归档/清除计划

### 任务记忆 (memory.ts)
- `recall_task` - 回忆任务摘要
- `deep_recall` - 获取任务详细步骤

### 其他工具 (misc.ts)
- `wait` - 等待指定时间
- `ask_user` - 向用户提问
- `executeMcpTool` - 执行 MCP 工具
- `loadSkillTool` - 加载内置技能
- `loadUserSkillTool` - 加载用户自定义技能
- `executeSkillTool` - 执行技能工具

## 依赖关系

```
index.ts
    ├── command.ts    → utils.ts, types.ts
    ├── terminal.ts   → utils.ts, types.ts
    ├── file.ts       → utils.ts, types.ts
    ├── knowledge.ts  → utils.ts, types.ts
    ├── plan.ts       → types.ts
    ├── memory.ts     → types.ts
    └── misc.ts       → utils.ts, types.ts
```

## 使用方式

```typescript
import { executeTool, type ToolExecutorConfig } from './tools'

// 或直接导入特定函数
import { executeCommand } from './tools/command'
import { readFile } from './tools/file'
```

## 向后兼容

原有的 `tool-executor.ts` 现在作为兼容层，重新导出所有内容：

```typescript
// 以下两种导入方式等效
import { executeTool } from './tool-executor'
import { executeTool } from './tools'
```
