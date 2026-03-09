/**
 * 企业微信技能工具定义
 * 2 个工具：wecom_read（读取/查询）+ wecom_write（创建/修改/删除）
 */

import type { ToolDefinition } from '../../tools'

export const wecomTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'wecom_read',
      description: `读取企业微信资源。根据 resource 类型传入对应参数。

**resource 与参数对照**：

| resource   | 用途         | 定位参数                                          | 筛选参数                        |
|------------|-------------|--------------------------------------------------|-------------------------------|
| calendar   | 日历日程     | calendar_id + event_id (不传 → 列出日历/日程)       | start_date, end_date           |
| approval   | 审批         | sp_no (审批单号，不传 → 列出审批记录)                | template_id, sp_status         |
| checkin    | 考勤打卡     | userid (不传 → 当前用户)                            | start_date, end_date           |
| contact    | 通讯录       | userid / department_id (不传 → 列出部门)            | —                             |

通用参数：limit（数量限制）、cursor（翻页游标）。`,
      parameters: {
        type: 'object',
        properties: {
          resource: {
            type: 'string',
            enum: ['calendar', 'approval', 'checkin', 'contact'],
            description: '资源类型'
          },
          calendar_id: { type: 'string', description: '日历 ID' },
          event_id: { type: 'string', description: '日程事件 ID' },
          start_date: { type: 'string', description: '查询起始日期（YYYY-MM-DD）' },
          end_date: { type: 'string', description: '查询结束日期（YYYY-MM-DD）' },
          template_id: { type: 'string', description: '审批模板 ID' },
          sp_no: { type: 'string', description: '审批单号' },
          sp_status: { type: 'number', description: '审批状态筛选（1:审批中 2:已通过 3:已驳回 4:已撤销 6:通过后撤销 7:已删除 10:已支付）' },
          userid: { type: 'string', description: '用户 ID（企业微信内部 ID）' },
          department_id: { type: 'number', description: '部门 ID（1=根部门）' },
          limit: { type: 'number', description: '返回数量限制（默认 20）' },
          cursor: { type: 'number', description: '翻页游标（从上次结果获取）' }
        },
        required: ['resource']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'wecom_write',
      description: `写入企业微信资源（创建/修改/删除）。

**resource × action 对照**：

| resource   | create           | update              | delete          |
|------------|-----------------|---------------------|-----------------|
| calendar   | 创建日程         | 修改日程             | 删除日程/取消日程 |
| approval   | 提交审批申请      | —                   | —               |

**data 参数**内容因 resource+action 而异，例：
- calendar create: data = {summary: "周会", start_time: "2025-06-15T09:00:00+08:00", end_time: "2025-06-15T10:00:00+08:00", attendees: ["userid1"]}
- calendar update: data = {summary: "新标题"} (只传要修改的字段)
- approval create: data = {template_id: "xxx", use_template_approver: 1, apply_data: {contents: [...]}}`,
      parameters: {
        type: 'object',
        properties: {
          resource: {
            type: 'string',
            enum: ['calendar', 'approval'],
            description: '资源类型'
          },
          action: {
            type: 'string',
            enum: ['create', 'update', 'delete'],
            description: '操作类型'
          },
          calendar_id: { type: 'string', description: '日历 ID（update/delete 日历时使用）' },
          event_id: { type: 'string', description: '日程事件 ID（update/delete 日程时使用）' },
          template_id: { type: 'string', description: '审批模板 ID' },
          data: { type: 'object', description: '写入的数据内容（JSON，结构因 resource+action 而异）' }
        },
        required: ['resource', 'action']
      }
    }
  }
]
