/**
 * 飞书技能工具定义
 * 仅 2 个工具：feishu_read（读取/查询）+ feishu_write（创建/修改/删除/上传）
 */

import type { ToolDefinition } from '../../tools'

export const feishuTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'feishu_read',
      description: `读取飞书云端资源。根据 resource 类型传入对应参数。

**resource 与参数对照**：

| resource   | 用途         | 定位参数                                          | 筛选参数                        |
|------------|-------------|--------------------------------------------------|-------------------------------|
| bitable    | 多维表格     | app_token + table_id (不传 table_id → 列出表格)    | filter, sort, page_token       |
| doc        | 云文档       | document_id (不传 → 列出最近文档)                   | —                             |
| sheet      | 电子表格     | spreadsheet_id + sheet_id + range (不传 → 概览)    | —                             |
| calendar   | 日历日程     | calendar_id (不传 → 列出日历)                       | start_date, end_date           |
| task       | 任务         | task_id (不传 → 列出任务)                           | —                             |
| drive      | 云空间       | folder_token / file_token (不传 → 列出根目录)       | —                             |

通用参数：limit（数量限制）、page_token（分页）。`,
      parameters: {
        type: 'object',
        properties: {
          resource: {
            type: 'string',
            enum: ['bitable', 'doc', 'sheet', 'calendar', 'task', 'drive'],
            description: '资源类型'
          },
          app_token: { type: 'string', description: '多维表格 app_token' },
          table_id: { type: 'string', description: '多维表格 table_id' },
          view_id: { type: 'string', description: '多维表格视图 ID（可选）' },
          document_id: { type: 'string', description: '云文档 ID' },
          spreadsheet_id: { type: 'string', description: '电子表格 token' },
          sheet_id: { type: 'string', description: '工作表 ID' },
          range: { type: 'string', description: '单元格范围（如 A1:D10）' },
          calendar_id: { type: 'string', description: '日历 ID' },
          event_id: { type: 'string', description: '日程事件 ID' },
          task_id: { type: 'string', description: '任务 ID' },
          folder_token: { type: 'string', description: '文件夹 token' },
          file_token: { type: 'string', description: '文件 token' },
          filter: { type: 'string', description: '多维表格筛选条件（飞书 filter 表达式）' },
          sort: { type: 'string', description: '多维表格排序（JSON: [{"field_name":"xxx","desc":true}]）' },
          start_date: { type: 'string', description: '日历查询起始日期（YYYY-MM-DD）' },
          end_date: { type: 'string', description: '日历查询结束日期（YYYY-MM-DD）' },
          limit: { type: 'number', description: '返回数量限制（默认 20，最大 100）' },
          page_token: { type: 'string', description: '分页 token（从上次结果获取）' }
        },
        required: ['resource']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'feishu_write',
      description: `写入飞书云端资源（创建/修改/删除/上传）。

**resource × action 对照**：

| resource   | create           | update              | delete          | upload          |
|------------|-----------------|---------------------|-----------------|-----------------|
| bitable    | 新增记录(s)      | 修改记录             | 删除记录(s)      | —               |
| doc        | 创建文档         | 追加/替换内容         | 删除文档         | —               |
| sheet      | 创建电子表格      | 写入单元格           | —               | —               |
| calendar   | 创建日程         | 修改日程             | 删除日程         | —               |
| task       | 创建任务         | 更新任务             | 删除任务         | —               |
| drive      | 创建文件夹       | 重命名              | 删除文件         | 上传文件         |

**data 参数**内容因 resource+action 而异，例：
- bitable create: data.fields = {"姓名": "张三", "年龄": 28}
- doc create: data = {title: "标题", content: "Markdown 内容"}
- calendar create: data = {summary: "会议", start_time: "2025-01-15T09:00:00+08:00", end_time: "..."}
- task create: data = {summary: "任务标题", due: {timestamp: "1700000000"}}
- drive upload: file_path = "/path/to/file", parent_token = "目标文件夹token"`,
      parameters: {
        type: 'object',
        properties: {
          resource: {
            type: 'string',
            enum: ['bitable', 'doc', 'sheet', 'calendar', 'task', 'drive'],
            description: '资源类型'
          },
          action: {
            type: 'string',
            enum: ['create', 'update', 'delete', 'upload'],
            description: '操作类型'
          },
          app_token: { type: 'string', description: '多维表格 app_token' },
          table_id: { type: 'string', description: '多维表格 table_id' },
          record_id: { type: 'string', description: '多维表格记录 ID（update/delete 单条）' },
          record_ids: { type: 'array', items: { type: 'string' }, description: '批量删除的记录 ID 列表' },
          document_id: { type: 'string', description: '云文档 ID（update/delete）' },
          spreadsheet_id: { type: 'string', description: '电子表格 token' },
          sheet_id: { type: 'string', description: '工作表 ID' },
          range: { type: 'string', description: '写入范围（如 A1:D10）' },
          calendar_id: { type: 'string', description: '日历 ID' },
          event_id: { type: 'string', description: '日程事件 ID（update/delete）' },
          task_id: { type: 'string', description: '任务 ID（update/delete）' },
          folder_token: { type: 'string', description: '文件夹 token' },
          file_token: { type: 'string', description: '文件 token（delete/update）' },
          parent_token: { type: 'string', description: '父文件夹 token（upload/create）' },
          data: { type: 'object', description: '写入的数据内容（JSON，结构因 resource+action 而异）' },
          file_path: { type: 'string', description: '本地文件路径（drive upload 时使用）' },
          file_name: { type: 'string', description: '上传文件名（可选，默认取 file_path 的文件名）' }
        },
        required: ['resource', 'action']
      }
    }
  }
]
