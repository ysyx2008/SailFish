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

**resource 与参数对照**（*=必填）：

| resource   | 用途         | 参数说明                                                     |
|------------|-------------|-------------------------------------------------------------|
| calendar   | 日历日程     | event_id→日程详情; calendar_id→日程列表; 都不传→使用说明         |
| approval   | 审批         | sp_no→审批详情; template_id→模板结构; 都不传→按时间列出审批记录    |
| checkin    | 考勤打卡     | *userid (必填，多人用逗号分隔); start_date, end_date (不传→今天) |
| contact    | 通讯录       | userid→用户详情; department_id→部门成员列表; 都不传→部门列表      |

通用参数：limit（数量限制）、cursor（翻页游标）。`,
      parameters: {
        type: 'object',
        properties: {
          resource: {
            type: 'string',
            enum: ['calendar', 'approval', 'checkin', 'contact'],
            description: '资源类型'
          },
          calendar_id: { type: 'string', description: '日历 ID（从创建日程的返回值或日程详情中获取）' },
          event_id: { type: 'string', description: '日程事件 ID（即 schedule_id）' },
          start_date: { type: 'string', description: '查询起始日期（YYYY-MM-DD）' },
          end_date: { type: 'string', description: '查询结束日期（YYYY-MM-DD）' },
          template_id: { type: 'string', description: '审批模板 ID' },
          sp_no: { type: 'string', description: '审批单号' },
          sp_status: { type: 'number', description: '审批状态筛选（1:审批中 2:已通过 3:已驳回 4:已撤销 6:通过后撤销 7:已删除 10:已支付）' },
          userid: { type: 'string', description: '用户 ID（企业微信 userid，checkin 时必填，多人逗号分隔）' },
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

**data 参数**（*=必填）：

**calendar create**: *summary, *start_time (ISO 8601), *end_time, attendees (userid[]), description, location
**calendar update** (需 event_id): *start_time, *end_time (企微必传，不改也要传原值), summary, description, location, attendees
**calendar delete** (需 event_id): 无需 data
**approval create**: *template_id, *creator_userid, apply_data ({contents:[...]}), use_template_approver (默认1)

注意：calendar update 时 start_time/end_time 是企微 API 的强制要求。如不知原始时间，先用 wecom_read calendar + event_id 查询。`,
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
          event_id: { type: 'string', description: '日程事件 ID（update/delete 日程时必填）' },
          template_id: { type: 'string', description: '审批模板 ID' },
          data: { type: 'object', description: '写入的数据内容（JSON，结构见上方说明）' }
        },
        required: ['resource', 'action']
      }
    }
  }
]
