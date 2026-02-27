/**
 * 关切技能工具定义
 * Agent 通过这些工具自主管理"关切"——即 AI 持续关注的事项
 */

import type { ToolDefinition } from '../../tools'

export const watchTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'watch_list',
      description: `列出我当前所有的关切（关注点）。

返回每个关切的名称、状态、触发方式、下次执行时间等。`,
      parameters: {
        type: 'object',
        properties: {
          include_disabled: {
            type: 'boolean',
            description: '是否包含已禁用的关切，默认 true'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'watch_create',
      description: `创建一个新的关切（持续关注的事项）。

**触发方式**（可组合多个）：
- cron: Cron 表达式，如 "0 9 * * *"（每天 9 点）
- interval: 固定间隔（秒），如 1800 = 30 分钟
- heartbeat: 每次心跳唤醒时检查
- manual: 仅手动触发
- file_change: 文件/目录变化时触发（需指定 paths）
- calendar: 日历事件前 N 分钟触发
- email: 收到新邮件时触发（可过滤发件人/主题）
- webhook: 外部 HTTP 请求触发
- command_probe: 定时执行命令，根据输出变化/正则匹配/退出码触发。通用探针，可监控磁盘、进程、日志、Git 等任意数据源
- http_probe: 定时 HTTP 请求，根据状态码/响应体变化/正则匹配触发。可监控 API 健康、网页变化等

**重要**：prompt 字段只写"执行时要做的动作"，绝不要包含调度描述。
否则执行时 Agent 会把 prompt 当成新请求，再次创建关切，导致无限循环。
例如用户说"每天 9 点检查邮件"，prompt 应为"检查邮箱是否有重要邮件，有则推送摘要"。

**输出投递**：
- desktop: 在应用内对话面板展示结果（默认，推荐）
- im: 通过 IM（钉钉/飞书等）推送结果
- notification: 系统通知
- log: 仅记录日志
- silent: 静默执行`,
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '关切名称，简洁描述关注什么'
          },
          prompt: {
            type: 'string',
            description: '执行时的具体动作指令。只写动作，不写调度信息'
          },
          triggers: {
            type: 'array',
            description: '触发方式列表',
            items: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['cron', 'interval', 'heartbeat', 'manual', 'file_change', 'calendar', 'email', 'webhook', 'command_probe', 'http_probe'],
                  description: '触发类型'
                },
                expression: { type: 'string', description: 'cron 表达式（仅 cron 类型）' },
                seconds: { type: 'number', description: '间隔秒数（仅 interval 类型）' },
                paths: { type: 'array', items: { type: 'string' }, description: '监控路径（仅 file_change 类型）' },
                pattern: { type: 'string', description: 'glob 过滤（file_change）/ 正则表达式（command_probe、http_probe 的 regex_match 模式）' },
                before_minutes: { type: 'number', description: '提前分钟数（仅 calendar 类型）' },
                filter_from: { type: 'string', description: '发件人过滤（仅 email 类型）' },
                filter_subject: { type: 'string', description: '主题过滤（仅 email 类型）' },
                command: { type: 'string', description: '要执行的命令（仅 command_probe 类型）。根据目标平台选择合适的命令' },
                shell: { type: 'string', description: '指定 shell（如 bash、powershell），不指定则自动检测（仅 command_probe 类型）' },
                probe_interval: { type: 'number', description: '探测间隔秒数（command_probe / http_probe 类型，最小 10）' },
                trigger_on: {
                  type: 'string',
                  description: '触发条件。command_probe: output_changed / regex_match / exit_code_nonzero。http_probe: status_changed / status_error / body_changed / regex_match'
                },
                working_directory: { type: 'string', description: '命令工作目录（仅 command_probe 类型）' },
                url: { type: 'string', description: 'HTTP 请求地址（仅 http_probe 类型）' },
                method: { type: 'string', description: 'HTTP 方法（默认 GET，仅 http_probe 类型）' },
                headers: { type: 'object', description: 'HTTP 请求头（仅 http_probe 类型）' },
                body: { type: 'string', description: 'HTTP 请求体（仅 http_probe 类型）' },
                timeout: { type: 'number', description: '请求超时毫秒（默认 10000，仅 http_probe 类型）' }
              },
              required: ['type']
            }
          },
          description: { type: 'string', description: '详细描述（可选）' },
          output: {
            type: 'string',
            enum: ['desktop', 'im', 'notification', 'log', 'silent'],
            description: '结果投递方式。desktop=应用内对话面板, im=IM推送, notification=系统通知, log=仅记录, silent=静默。默认 "desktop"'
          },
          priority: {
            type: 'string',
            enum: ['high', 'normal', 'low'],
            description: '优先级，默认 "normal"'
          },
          skills: {
            type: 'array',
            items: { type: 'string' },
            description: '需要的技能列表（如 email、browser）'
          },
          enabled: { type: 'boolean', description: '是否立即启用，默认 true' }
        },
        required: ['name', 'prompt', 'triggers']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'watch_update',
      description: '修改已有的关切。可以更新名称、指令、触发方式、输出等任意字段。',
      parameters: {
        type: 'object',
        properties: {
          watch_id: { type: 'string', description: '关切 ID（通过 watch_list 获取）' },
          name: { type: 'string', description: '新名称' },
          prompt: { type: 'string', description: '新的执行指令' },
          triggers: {
            type: 'array',
            description: '新的触发方式列表（替换原有全部触发器）',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['cron', 'interval', 'heartbeat', 'manual', 'file_change', 'calendar', 'email', 'webhook', 'command_probe', 'http_probe'] },
                expression: { type: 'string' },
                seconds: { type: 'number' },
                paths: { type: 'array', items: { type: 'string' } },
                pattern: { type: 'string' },
                before_minutes: { type: 'number' },
                filter_from: { type: 'string' },
                filter_subject: { type: 'string' },
                command: { type: 'string' },
                shell: { type: 'string' },
                probe_interval: { type: 'number' },
                trigger_on: { type: 'string' },
                working_directory: { type: 'string' },
                url: { type: 'string' },
                method: { type: 'string' },
                headers: { type: 'object' },
                body: { type: 'string' },
                timeout: { type: 'number' }
              },
              required: ['type']
            }
          },
          output: { type: 'string', enum: ['desktop', 'im', 'notification', 'log', 'silent'] },
          priority: { type: 'string', enum: ['high', 'normal', 'low'] },
          enabled: { type: 'boolean' }
        },
        required: ['watch_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'watch_delete',
      description: '删除一个关切。删除后不再触发，历史记录保留。',
      parameters: {
        type: 'object',
        properties: {
          watch_id: { type: 'string', description: '关切 ID' }
        },
        required: ['watch_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'watch_toggle',
      description: '启用或禁用一个关切。禁用后暂停触发，启用后恢复。',
      parameters: {
        type: 'object',
        properties: {
          watch_id: { type: 'string', description: '关切 ID' }
        },
        required: ['watch_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'watch_trigger',
      description: '立即触发一个关切（不影响正常调度）。用于测试或临时执行。',
      parameters: {
        type: 'object',
        properties: {
          watch_id: { type: 'string', description: '关切 ID' }
        },
        required: ['watch_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'watch_history',
      description: '查看关切的执行历史。',
      parameters: {
        type: 'object',
        properties: {
          watch_id: { type: 'string', description: '关切 ID（可选，不指定则返回全部历史）' },
          limit: { type: 'number', description: '返回记录数，默认 10' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'watch_state_update',
      description: `更新关切的持久化状态（用于有状态工作流）。

状态在每次执行时自动注入到上下文中，用于跨执行保持记忆。`,
      parameters: {
        type: 'object',
        properties: {
          watch_id: {
            type: 'string',
            description: '关切 ID'
          },
          watch_state: {
            type: 'object',
            description: '要合并到当前关切私有状态的键值对（增量合并，不会清除未提及的 key）'
          }
        },
        required: ['watch_id', 'watch_state']
      }
    }
  }
]
