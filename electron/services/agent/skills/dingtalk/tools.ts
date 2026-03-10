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
| bitable    | 多维表格     | union_id + base_id + sheet_id + record_id          | filter (JSON 筛选条件)         |
| drive      | 钉盘/云盘    | union_id + space_id + file_id                      | parent_id                      |
| wiki       | 知识库       | union_id + workspace_id + node_id                  | keyword (搜索)                 |

**union_id 获取**：先用 contact 资源查询用户信息（传 userid），返回结果中包含 union_id。日历、待办、多维表格、钉盘、知识库操作均需要此 ID。

**bitable 用法**：
- 不传 sheet_id → 列出数据表 | 传 sheet_id 不传 record_id → 列出记录 | 传 record_id → 获取单条记录
- 只传 sheet_id + filter 参数可按条件筛选：filter 格式为 JSON 字符串 {"combination":"and","conditions":[{"field":"字段名","operator":"equal","value":["值"]}]}
- operator 可选: equal | notEqual | greater | greaterEqual | less | lessEqual | contain | notContain | empty | notEmpty

**drive 用法**：
- 不传 space_id → 列出空间 | 传 space_id → 列出文件(parent_id 可选，根目录传 "0")

**wiki 用法**：
- 不传 workspace_id → 列出知识库 | 传 workspace_id 不传 node_id → 列出知识库根节点 | 传 node_id → 列出子节点
- 传 keyword → 搜索知识库文档

通用参数：limit（数量限制）、cursor（翻页游标）。`,
      parameters: {
        type: 'object',
        properties: {
          resource: {
            type: 'string',
            enum: ['calendar', 'todo', 'attendance', 'contact', 'approval', 'bitable', 'drive', 'wiki'],
            description: '资源类型'
          },
          union_id: { type: 'string', description: '钉钉用户 unionId（日历/待办/多维表格/钉盘/知识库操作必填，从通讯录查询获取）' },
          calendar_id: { type: 'string', description: '日历 ID（不传 → 列出日历，传 "primary" 表示主日历）' },
          event_id: { type: 'string', description: '日程事件 ID' },
          task_id: { type: 'string', description: '待办任务 ID' },
          is_done: { type: 'boolean', description: '筛选待办状态（true=已完成, false=未完成, 不传=全部）' },
          userid: { type: 'string', description: '钉钉用户 ID（考勤/通讯录使用，多人逗号分隔）' },
          department_id: { type: 'number', description: '部门 ID（1=根部门）' },
          process_code: { type: 'string', description: '审批流程模板 code' },
          process_instance_id: { type: 'string', description: '审批实例 ID' },
          base_id: { type: 'string', description: '多维表格 base ID' },
          sheet_id: { type: 'string', description: '多维表格数据表 ID 或名称' },
          record_id: { type: 'string', description: '多维表格记录 ID' },
          filter: { type: 'string', description: '多维表格筛选条件（JSON 字符串）' },
          space_id: { type: 'string', description: '钉盘空间 ID' },
          file_id: { type: 'string', description: '钉盘文件 ID' },
          parent_id: { type: 'string', description: '钉盘父目录 ID（根目录传 "0"）' },
          workspace_id: { type: 'string', description: '知识库 ID (workspaceId/spaceUuid)' },
          node_id: { type: 'string', description: '知识库节点 ID (dentryUuid)' },
          keyword: { type: 'string', description: '搜索关键词（知识库搜索使用）' },
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
| bitable    | 新增记录(需union_id+base_id+sheet_id) | 更新记录(需record_id) | 删除记录(需record_ids) |
| drive      | 创建文件夹(需union_id+space_id) | —         | 删除文件(需file_id) |
| wiki       | 创建文档(需union_id+workspace_id) | —        | —               |

**data 参数**内容因 resource+action 而异，例：
- calendar create: data = {summary: "周会", start: {dateTime: "2025-06-15T09:00:00+08:00"}, end: {dateTime: "2025-06-15T10:00:00+08:00"}}
- todo create: data = {subject: "完成报告", due_time: 1700000000000, description: "详情"}
- approval create: data = {originator_user_id: "userid", form_component_values: [...]}
- bitable create: data = {fields: {"字段名": "值", "数字字段": 100}}，批量新增传 data = {records: [{fields: {...}}, ...]}
- bitable update: 需 record_id，data = {fields: {"要修改的字段": "新值"}}
- bitable delete: 需 record_ids 数组
- drive create: data = {fileName: "新文件夹", parentId: "0"} (parentId 不传默认根目录)
- wiki create: data = {name: "文档标题", docType: "alidoc"} (docType 可选: alidoc/alidoc_sheet)`,
      parameters: {
        type: 'object',
        properties: {
          resource: {
            type: 'string',
            enum: ['calendar', 'todo', 'approval', 'bitable', 'drive', 'wiki'],
            description: '资源类型'
          },
          action: {
            type: 'string',
            enum: ['create', 'update', 'delete'],
            description: '操作类型'
          },
          union_id: { type: 'string', description: '钉钉用户 unionId（日历/待办/多维表格/钉盘/知识库操作必填）' },
          calendar_id: { type: 'string', description: '日历 ID（默认 "primary" 主日历）' },
          event_id: { type: 'string', description: '日程事件 ID（update/delete）' },
          task_id: { type: 'string', description: '待办任务 ID（update/delete）' },
          process_code: { type: 'string', description: '审批流程模板 code（approval create 必填）' },
          base_id: { type: 'string', description: '多维表格 base ID' },
          sheet_id: { type: 'string', description: '多维表格数据表 ID 或名称' },
          record_id: { type: 'string', description: '多维表格记录 ID（update 单条必填）' },
          record_ids: { type: 'array', items: { type: 'string' }, description: '多维表格记录 ID 数组（delete 必填）' },
          space_id: { type: 'string', description: '钉盘空间 ID' },
          file_id: { type: 'string', description: '钉盘文件 ID（delete 必填）' },
          parent_id: { type: 'string', description: '钉盘父目录 ID（不传默认根目录 "0"）' },
          workspace_id: { type: 'string', description: '知识库 ID' },
          node_id: { type: 'string', description: '知识库父节点 ID（不传默认根节点）' },
          data: { type: 'object', description: '写入的数据内容（JSON，结构因 resource+action 而异）' }
        },
        required: ['resource', 'action']
      }
    }
  }
]
