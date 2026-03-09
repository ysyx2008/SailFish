/**
 * 钉钉技能工具定义
 * 2 个工具：dingtalk_read（读取/查询）+ dingtalk_write（创建/修改/删除）
 */

import type { ToolDefinition } from '../../tools'

export const dingtalkTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'dingtalk_read',
      description: `读取钉钉资源。根据 resource 类型传入对应参数。

**resource 与参数对照**：

| resource   | 用途         | 定位参数                                          | 筛选参数                        |
|------------|-------------|--------------------------------------------------|-------------------------------|
| calendar   | 日历日程     | union_id + calendar_id + event_id                 | start_date, end_date           |
| todo       | 待办任务     | union_id + task_id (不传 task_id → 列出待办)       | is_done                        |
| attendance | 考勤打卡     | userid（必填，多人逗号分隔）                        | start_date, end_date           |
| contact    | 通讯录       | userid / department_id (不传 → 列出部门)            | —                             |
| approval   | 审批流程     | process_instance_id / process_code                 | start_date, end_date           |

**union_id 获取**：先用 contact 资源查询用户信息（传 userid），返回结果中包含 union_id。日历和待办操作均需要此 ID。
通用参数：limit（数量限制）、cursor（翻页游标）。`,
      parameters: {
        type: 'object',
        properties: {
          resource: {
            type: 'string',
            enum: ['calendar', 'todo', 'attendance', 'contact', 'approval'],
            description: '资源类型'
          },
          union_id: { type: 'string', description: '钉钉用户 unionId（日历和待办操作必填，从通讯录查询获取）' },
          calendar_id: { type: 'string', description: '日历 ID（不传 → 列出日历，传 "primary" 表示主日历）' },
          event_id: { type: 'string', description: '日程事件 ID' },
          task_id: { type: 'string', description: '待办任务 ID' },
          is_done: { type: 'boolean', description: '筛选待办状态（true=已完成, false=未完成, 不传=全部）' },
          userid: { type: 'string', description: '钉钉用户 ID（考勤/通讯录使用，多人逗号分隔）' },
          department_id: { type: 'number', description: '部门 ID（1=根部门）' },
          process_code: { type: 'string', description: '审批流程模板 code' },
          process_instance_id: { type: 'string', description: '审批实例 ID' },
          start_date: { type: 'string', description: '查询起始日期（YYYY-MM-DD）' },
          end_date: { type: 'string', description: '查询结束日期（YYYY-MM-DD）' },
          limit: { type: 'number', description: '返回数量限制（默认 20）' },
          cursor: { type: 'string', description: '翻页游标（从上次结果获取）' }
        },
        required: ['resource']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'dingtalk_write',
      description: `写入钉钉资源（创建/修改/删除）。

**resource × action 对照**：

| resource   | create           | update              | delete           |
|------------|-----------------|---------------------|-----------------|
| calendar   | 创建日程(需union_id) | 修改日程            | 删除日程         |
| todo       | 创建待办(需union_id) | 更新待办(完成/修改)  | 删除待办         |
| approval   | 发起审批申请      | —                   | —               |

**data 参数**内容因 resource+action 而异，例：
- calendar create: data = {summary: "周会", start: {dateTime: "2025-06-15T09:00:00+08:00"}, end: {dateTime: "2025-06-15T10:00:00+08:00"}}
- todo create: data = {subject: "完成报告", due_time: 1700000000000, description: "详情"}
- approval create: data = {originator_user_id: "userid", form_component_values: [...]}`,
      parameters: {
        type: 'object',
        properties: {
          resource: {
            type: 'string',
            enum: ['calendar', 'todo', 'approval'],
            description: '资源类型'
          },
          action: {
            type: 'string',
            enum: ['create', 'update', 'delete'],
            description: '操作类型'
          },
          union_id: { type: 'string', description: '钉钉用户 unionId（日历和待办操作必填）' },
          calendar_id: { type: 'string', description: '日历 ID（默认 "primary" 主日历）' },
          event_id: { type: 'string', description: '日程事件 ID（update/delete）' },
          task_id: { type: 'string', description: '待办任务 ID（update/delete）' },
          process_code: { type: 'string', description: '审批流程模板 code（approval create 必填）' },
          data: { type: 'object', description: '写入的数据内容（JSON，结构因 resource+action 而异）' }
        },
        required: ['resource', 'action']
      }
    }
  }
]
