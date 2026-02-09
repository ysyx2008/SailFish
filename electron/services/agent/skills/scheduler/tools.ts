/**
 * 定时任务技能工具定义
 */

import type { ToolDefinition } from '../../tools'

export const schedulerTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'schedule_list',
      description: `列出所有定时任务。显示任务名称、状态、调度配置、下次执行时间等信息。

**返回信息**：
- 任务名称和 ID
- 启用/禁用状态
- 调度配置（Cron 表达式、间隔、一次性）
- 执行目标（本地终端或 SSH 会话）
- 下次执行时间
- 任务指令摘要`,
      parameters: {
        type: 'object',
        properties: {
          include_disabled: {
            type: 'boolean',
            description: '是否包含已禁用的任务，默认 true'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'schedule_create',
      description: `创建定时任务。

调度类型：cron（如 "0 9 * * *"）、interval（如 "30m"）、once（ISO 格式）。
执行目标：local（本地）或 ssh（需指定 ssh_session_id）。

**重要**：prompt 字段必须只包含「运行时要执行的动作」，绝不能包含调度/时间相关的描述。
否则执行时 Agent 会把 prompt 当成新的用户请求，再次创建定时任务，导致无限循环。`,
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '任务名称'
          },
          prompt: {
            type: 'string',
            description: '运行时要执行的具体操作指令。必须去掉调度相关描述，只保留动作本身。例如用户说"每天9点检查磁盘空间"，prompt 应为"检查磁盘空间使用情况并报告"'
          },
          schedule_type: {
            type: 'string',
            enum: ['cron', 'interval', 'once'],
            description: '调度类型：cron（Cron 表达式）、interval（固定间隔）、once（一次性）'
          },
          schedule_expression: {
            type: 'string',
            description: '调度表达式。cron: "0 9 * * *"; interval: "30m/2h/1d"; once: "2024-03-01T15:00:00"'
          },
          target_type: {
            type: 'string',
            enum: ['local', 'ssh'],
            description: '执行目标类型，默认 "local"'
          },
          ssh_session_id: {
            type: 'string',
            description: '当 target_type="ssh" 时必填，SSH 会话 ID（可通过 schedule_ssh_sessions 获取）'
          },
          description: {
            type: 'string',
            description: '任务描述（可选）'
          },
          timeout: {
            type: 'number',
            description: '超时时间（秒），默认 300'
          },
          enabled: {
            type: 'boolean',
            description: '是否立即启用，默认 true'
          }
        },
        required: ['name', 'prompt', 'schedule_type', 'schedule_expression']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'schedule_delete',
      description: '删除定时任务。删除后任务将不再执行，历史记录保留。',
      parameters: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: '要删除的任务 ID（可通过 schedule_list 获取）'
          }
        },
        required: ['task_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'schedule_toggle',
      description: '启用或禁用定时任务。禁用后任务暂停调度，启用后恢复。',
      parameters: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: '任务 ID'
          }
        },
        required: ['task_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'schedule_run',
      description: '立即执行定时任务（不影响正常调度）。用于测试任务配置或临时执行。',
      parameters: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: '要执行的任务 ID'
          }
        },
        required: ['task_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'schedule_history',
      description: '获取定时任务的执行历史记录。显示执行时间、状态、耗时、错误信息等。',
      parameters: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: '任务 ID（可选，不指定则返回所有任务的历史）'
          },
          limit: {
            type: 'number',
            description: '返回记录数量，默认 10'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'schedule_ssh_sessions',
      description: '列出所有已保存的 SSH 会话。创建定时任务时，如果需要在远程服务器执行，可以使用这里列出的会话 ID。',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  }
]
