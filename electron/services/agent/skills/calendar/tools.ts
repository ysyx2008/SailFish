/**
 * 日历技能工具定义
 */

import type { ToolDefinition } from '../../tools'

export const calendarTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'calendar_connect',
      description: `连接到用户配置的日历账户。

**支持的日历服务**：
- Google Calendar
- Apple iCloud
- Microsoft Outlook
- 企业微信日历
- 其他 CalDAV 服务

**注意**：
- 必须先在设置中配置日历账户
- 连接成功后可以进行日程查看、创建、修改、删除操作
- 10 分钟无操作会自动断开连接`,
      parameters: {
        type: 'object',
        properties: {
          account_id: {
            type: 'string',
            description: '日历账户 ID（可选，不指定则使用第一个配置的账户）'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'calendar_list',
      description: `列出日历或日程事件。

**使用方式**：
1. 不指定 calendar_id：返回所有日历列表
2. 指定 calendar_id：返回该日历的日程事件

**时间范围**：
- 默认返回今天起未来 7 天的日程
- 可通过 start_date 和 end_date 指定范围

**返回内容**：
- 日历模式：日历名称、颜色、是否只读
- 日程模式：标题、时间、地点、是否全天事件`,
      parameters: {
        type: 'object',
        properties: {
          calendar_id: {
            type: 'string',
            description: '日历 ID（可选，不指定则列出所有日历）'
          },
          start_date: {
            type: 'string',
            description: '开始日期（YYYY-MM-DD 格式，默认今天）'
          },
          end_date: {
            type: 'string',
            description: '结束日期（YYYY-MM-DD 格式，默认 7 天后）'
          },
          limit: {
            type: 'number',
            description: '返回事件数量限制（默认 50，最大 200）'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'calendar_create',
      description: `创建新的日程事件。

**支持功能**：
- 设置标题、开始/结束时间、地点、描述
- 创建全天事件
- 设置提醒（提前 N 分钟）
- 设置重复规则（每天/每周/每月/每年）

**时间格式**：
- 普通事件：ISO 8601 格式，如 "2024-01-15T09:00:00"
- 全天事件：仅需日期，如 "2024-01-15"

**注意**：创建日程需要用户确认。`,
      parameters: {
        type: 'object',
        properties: {
          calendar_id: {
            type: 'string',
            description: '目标日历 ID'
          },
          title: {
            type: 'string',
            description: '日程标题'
          },
          start: {
            type: 'string',
            description: '开始时间（ISO 8601 格式，如 2024-01-15T09:00:00）'
          },
          end: {
            type: 'string',
            description: '结束时间（可选，默认开始时间 + 1 小时）'
          },
          all_day: {
            type: 'boolean',
            description: '是否为全天事件（默认 false）'
          },
          location: {
            type: 'string',
            description: '地点'
          },
          description: {
            type: 'string',
            description: '详细描述'
          },
          reminder_minutes: {
            type: 'number',
            description: '提前提醒分钟数（如 15 表示提前 15 分钟提醒）'
          },
          recurrence: {
            type: 'string',
            enum: ['daily', 'weekly', 'monthly', 'yearly'],
            description: '重复规则（可选）'
          }
        },
        required: ['calendar_id', 'title', 'start']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'calendar_update',
      description: `修改已有的日程事件。

只需提供要修改的字段，未提供的字段保持不变。

**可修改字段**：
- title：标题
- start：开始时间
- end：结束时间
- location：地点
- description：描述

**注意**：修改日程需要用户确认。`,
      parameters: {
        type: 'object',
        properties: {
          calendar_id: {
            type: 'string',
            description: '日历 ID'
          },
          event_id: {
            type: 'string',
            description: '事件 ID（从 calendar_list 获取）'
          },
          title: {
            type: 'string',
            description: '新标题'
          },
          start: {
            type: 'string',
            description: '新开始时间（ISO 8601 格式）'
          },
          end: {
            type: 'string',
            description: '新结束时间（ISO 8601 格式）'
          },
          location: {
            type: 'string',
            description: '新地点'
          },
          description: {
            type: 'string',
            description: '新描述'
          }
        },
        required: ['calendar_id', 'event_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'calendar_delete',
      description: `删除日程事件。只需传 calendar_id 和 event_ids，不要传其他信息。

**注意**：
- 删除操作不可恢复
- 需要用户确认
- 可以一次删除多个事件`,
      parameters: {
        type: 'object',
        properties: {
          calendar_id: {
            type: 'string',
            description: '日历 ID'
          },
          event_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '要删除的事件 ID 列表'
          }
        },
        required: ['calendar_id', 'event_ids']
      }
    }
  },
  // ========== 待办事项工具 ==========
  {
    type: 'function',
    function: {
      name: 'todo_list',
      description: `列出日历中的待办事项（VTODO）。

**使用方式**：
- 指定 calendar_id 获取该日历的待办事项
- 可通过 status 过滤待办状态

**过滤条件**：
- status: needs-action（待处理）、in-process（进行中）、completed（已完成）、cancelled（已取消）
- 不指定 status 则返回所有未完成的待办

**返回内容**：
- 待办标题、截止日期、优先级、状态、完成百分比`,
      parameters: {
        type: 'object',
        properties: {
          calendar_id: {
            type: 'string',
            description: '日历 ID'
          },
          status: {
            type: 'string',
            enum: ['needs-action', 'in-process', 'completed', 'cancelled', 'all'],
            description: '过滤状态（默认返回未完成的待办，传 "all" 返回全部）'
          },
          limit: {
            type: 'number',
            description: '返回数量限制（默认 50，最大 200）'
          }
        },
        required: ['calendar_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'todo_create',
      description: `创建新的待办事项。

**支持功能**：
- 设置标题、截止日期、优先级、描述
- 设置分类标签

**优先级说明**：
- 1: 最高优先级
- 5: 中等优先级
- 9: 最低优先级

**注意**：创建待办需要用户确认。`,
      parameters: {
        type: 'object',
        properties: {
          calendar_id: {
            type: 'string',
            description: '目标日历 ID'
          },
          title: {
            type: 'string',
            description: '待办标题'
          },
          due: {
            type: 'string',
            description: '截止日期（ISO 8601 格式，如 2024-01-15T18:00:00）'
          },
          priority: {
            type: 'number',
            description: '优先级（1=最高, 5=中, 9=最低）'
          },
          description: {
            type: 'string',
            description: '详细描述'
          },
          categories: {
            type: 'array',
            items: { type: 'string' },
            description: '分类标签（如 ["工作", "紧急"]）'
          }
        },
        required: ['calendar_id', 'title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'todo_update',
      description: `修改已有的待办事项。

只需提供要修改的字段，未提供的字段保持不变。

**可修改字段**：
- title：标题
- due：截止日期
- priority：优先级
- status：状态（needs-action / in-process / completed / cancelled）
- percent_complete：完成百分比（0-100）
- description：描述
- categories：分类标签

**快速完成待办**：设置 status 为 "completed" 即可标记完成。

**注意**：修改待办需要用户确认。`,
      parameters: {
        type: 'object',
        properties: {
          calendar_id: {
            type: 'string',
            description: '日历 ID'
          },
          todo_id: {
            type: 'string',
            description: '待办 ID（从 todo_list 获取）'
          },
          title: {
            type: 'string',
            description: '新标题'
          },
          due: {
            type: 'string',
            description: '新截止日期（ISO 8601 格式）'
          },
          priority: {
            type: 'number',
            description: '新优先级（1=最高, 5=中, 9=最低）'
          },
          status: {
            type: 'string',
            enum: ['needs-action', 'in-process', 'completed', 'cancelled'],
            description: '新状态'
          },
          percent_complete: {
            type: 'number',
            description: '完成百分比（0-100）'
          },
          description: {
            type: 'string',
            description: '新描述'
          },
          categories: {
            type: 'array',
            items: { type: 'string' },
            description: '新分类标签'
          }
        },
        required: ['calendar_id', 'todo_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'todo_delete',
      description: `删除待办事项。只需传 calendar_id 和 todo_ids，不要传其他信息。

**注意**：
- 删除操作不可恢复
- 需要用户确认
- 可以一次删除多个待办`,
      parameters: {
        type: 'object',
        properties: {
          calendar_id: {
            type: 'string',
            description: '日历 ID'
          },
          todo_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '要删除的待办 ID 列表'
          }
        },
        required: ['calendar_id', 'todo_ids']
      }
    }
  }
]
