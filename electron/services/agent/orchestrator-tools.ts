/**
 * Master Agent 专用工具定义
 * 用于多终端协调（智能巡检）模式
 */
import type { ToolDefinition } from '../ai.service'

/**
 * 获取协调器专用工具定义
 */
export function getOrchestratorTools(): ToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'list_available_hosts',
        description: `列出会话管理器中所有可用的 SSH 主机配置。

返回信息包括：
- hostId: 主机配置的唯一标识
- name: 主机显示名称
- host: 主机地址
- port: SSH 端口
- username: 用户名
- group: 所属分组名称（可用于匹配"生产服务器"、"测试环境"等）
- tags: 标签列表

**使用场景**：
1. 任务开始时先调用此工具了解可用主机
2. 根据用户任务描述匹配相关主机（如"生产服务器"→匹配分组名包含"生产"或"prod"的主机）
3. 如果用户没有指定具体主机，你需要智能选择相关主机`,
        parameters: {
          type: 'object',
          properties: {}
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'connect_terminal',
        description: `创建新的终端连接（本地或 SSH）。

**参数**：
- type: 终端类型，'local'（本地终端）或 'ssh'（SSH 远程终端）
- host_id: 主机配置 ID（type='ssh' 时必填，从 list_available_hosts 获取）
- alias: 终端别名，用于后续引用（如 "local-1" 或 "prod-web-1"）

**返回**：
- terminalId: 新创建的终端 ID
- alias: 终端别名
- type: 终端类型
- connected: 是否连接成功

**使用场景**：
- 需要在本地执行脚本或汇总分析 → type='local'
- 需要连接远程服务器 → type='ssh'
- 混合任务可以同时创建两种类型的终端

**注意**：
- SSH 连接可能需要几秒钟，请耐心等待
- 本地终端创建很快
- 同一主机可以创建多个终端连接`,
        parameters: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['local', 'ssh'],
              description: '终端类型：local（本地）或 ssh（远程）'
            },
            host_id: {
              type: 'string',
              description: '主机配置 ID（type=ssh 时必填，从 list_available_hosts 获取）'
            },
            alias: {
              type: 'string',
              description: '终端别名，用于后续引用，建议使用易于识别的名称'
            }
          },
          required: ['type', 'alias']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'dispatch_task',
        description: `向指定终端派发任务，由该终端的 Worker Agent 执行。

**参数**：
- terminal_id: 终端 ID 或别名
- task: 任务描述（自然语言，Worker Agent 会理解并执行）
- wait_for_result: 是否等待执行完成（默认 true）

**返回**：
- success: 任务是否成功完成
- result: 执行结果（命令输出或分析结果）
- error: 错误信息（如果失败）
- duration: 执行耗时（毫秒）

**注意**：
- 任务描述应清晰具体，Worker Agent 会自行决定执行哪些命令
- 如果 wait_for_result=false，立即返回，后续用 get_task_status 查询
- 危险命令会触发确认机制（取决于用户选择的确认策略）`,
        parameters: {
          type: 'object',
          properties: {
            terminal_id: {
              type: 'string',
              description: '终端 ID 或别名'
            },
            task: {
              type: 'string',
              description: '任务描述（自然语言）'
            },
            wait_for_result: {
              type: 'boolean',
              description: '是否等待执行完成，默认 true'
            }
          },
          required: ['terminal_id', 'task']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'parallel_dispatch',
        description: `并行向多个终端派发相同任务。这是批量执行的高效方式。

**参数**：
- terminal_ids: 终端 ID 或别名的数组
- task: 任务描述（所有终端执行相同任务）

**返回**：
- results: 各终端的执行结果数组
  - terminalId: 终端 ID
  - terminalName: 终端名称
  - success: 是否成功
  - result: 执行结果
  - error: 错误信息
  - duration: 执行耗时

**注意**：
- 适用于需要在多台服务器执行相同检查的场景
- 实际并行数受 maxParallelWorkers 配置限制
- 如果有危险命令，会触发批量确认（可一次确认应用到所有终端）`,
        parameters: {
          type: 'object',
          properties: {
            terminal_ids: {
              type: 'array',
              items: { type: 'string' },
              description: '终端 ID 或别名的数组'
            },
            task: {
              type: 'string',
              description: '任务描述（所有终端执行相同任务）'
            }
          },
          required: ['terminal_ids', 'task']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_task_status',
        description: `查询某个终端任务的执行状态。

**参数**：
- terminal_id: 终端 ID 或别名

**返回**：
- status: 状态（connecting/idle/running/completed/failed/timeout）
- currentTask: 当前执行的任务（如果正在执行）
- result: 执行结果（如果已完成）
- error: 错误信息（如果失败）
- duration: 已执行时间（毫秒）

**使用场景**：
- dispatch_task 设置 wait_for_result=false 后轮询查询
- 监控长时间运行的任务进度`,
        parameters: {
          type: 'object',
          properties: {
            terminal_id: {
              type: 'string',
              description: '终端 ID 或别名'
            }
          },
          required: ['terminal_id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'collect_results',
        description: `收集并汇总多个终端的执行结果。适用于任务执行完成后的结果分析。

**参数**：
- terminal_ids: 要收集结果的终端 ID 数组（可选，默认收集所有）
- format: 输出格式
  - "table": 表格形式，适合对比
  - "list": 列表形式，详细输出
  - "summary": 仅统计汇总

**返回**：
- totalCount: 总任务数
- successCount: 成功数
- failedCount: 失败数
- results: 各终端的详细结果
- formatted: 按指定格式的输出文本

**使用场景**：
- 所有任务执行完成后收集汇总
- 生成最终报告`,
        parameters: {
          type: 'object',
          properties: {
            terminal_ids: {
              type: 'array',
              items: { type: 'string' },
              description: '要收集结果的终端 ID 数组，不指定则收集所有'
            },
            format: {
              type: 'string',
              enum: ['table', 'list', 'summary'],
              description: '输出格式：table（表格）、list（列表）、summary（汇总）'
            }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'close_terminal',
        description: `关闭指定的终端连接。

**参数**：
- terminal_id: 终端 ID 或别名

**返回**：
- success: 是否成功关闭

**使用场景**：
- 任务完成后清理不再需要的终端连接
- 释放系统资源

**注意**：
- 关闭后终端 ID 将失效
- 如果终端有任务正在执行，会先停止任务`,
        parameters: {
          type: 'object',
          properties: {
            terminal_id: {
              type: 'string',
              description: '终端 ID 或别名'
            }
          },
          required: ['terminal_id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'analyze_and_report',
        description: `分析收集的结果并生成报告。调用此工具表示任务执行完成。

**参数**：
- findings: 主要发现（数组）
- recommendations: 建议措施（数组）
- severity: 整体严重程度（info/warning/critical）

**使用场景**：
- 所有终端任务执行完成后
- 汇总分析结果并给出建议
- 结束本次智能巡检任务`,
        parameters: {
          type: 'object',
          properties: {
            findings: {
              type: 'array',
              items: { type: 'string' },
              description: '主要发现列表'
            },
            recommendations: {
              type: 'array',
              items: { type: 'string' },
              description: '建议措施列表'
            },
            severity: {
              type: 'string',
              enum: ['info', 'warning', 'critical'],
              description: '整体严重程度：info（正常）、warning（需关注）、critical（需立即处理）'
            }
          },
          required: ['findings', 'recommendations', 'severity']
        }
      }
    }
  ]
}

/**
 * 协调器工具名称列表
 */
export const ORCHESTRATOR_TOOL_NAMES = [
  'list_available_hosts',
  'connect_terminal',
  'dispatch_task',
  'parallel_dispatch',
  'get_task_status',
  'collect_results',
  'close_terminal',
  'analyze_and_report'
] as const

export type OrchestratorToolName = typeof ORCHESTRATOR_TOOL_NAMES[number]

/**
 * 判断是否为协调器工具
 */
export function isOrchestratorTool(toolName: string): toolName is OrchestratorToolName {
  return ORCHESTRATOR_TOOL_NAMES.includes(toolName as OrchestratorToolName)
}

