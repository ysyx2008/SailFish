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
      description: `删除日程事件。

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
  }
]
