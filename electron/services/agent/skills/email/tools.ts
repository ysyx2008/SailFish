/**
 * 邮箱技能工具定义
 */

import type { ToolDefinition } from '../../tools'

export const emailTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'email_connect',
      description: `连接到用户配置的邮箱账户。

**注意**：
- 必须先在设置中配置邮箱账户
- 连接成功后可以进行邮件读取、发送等操作
- 10 分钟无操作会自动断开连接`,
      parameters: {
        type: 'object',
        properties: {
          account_id: {
            type: 'string',
            description: '邮箱账户 ID（可选，不指定则使用第一个配置的账户）'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'email_list',
      description: `列出邮箱文件夹或邮件列表。

**使用方式**：
1. 不指定 folder：返回所有文件夹列表
2. 指定 folder：返回该文件夹的邮件列表（默认最近 20 封）

**常用文件夹**：
- INBOX：收件箱
- Sent / Sent Messages / 已发送：已发送
- Drafts / 草稿箱：草稿
- Trash / Deleted / 已删除：垃圾箱
- Jstrash / Spam / 垃圾邮件：垃圾邮件`,
      parameters: {
        type: 'object',
        properties: {
          folder: {
            type: 'string',
            description: '文件夹名称（可选，不指定则列出所有文件夹）'
          },
          limit: {
            type: 'number',
            description: '返回邮件数量限制（默认 20，最大 100）'
          },
          page: {
            type: 'number',
            description: '分页页码（从 1 开始，默认 1）'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'email_read',
      description: `读取邮件的完整内容。

**返回内容**：
- 发件人、收件人、主题、日期
- 邮件正文（纯文本或 HTML）
- 附件列表（名称、大小）

**注意**：大附件不会自动下载，需要使用 email_download_attachment 单独下载。`,
      parameters: {
        type: 'object',
        properties: {
          folder: {
            type: 'string',
            description: '邮件所在文件夹（默认 INBOX）'
          },
          uid: {
            type: 'number',
            description: '邮件 UID（从 email_list 获取）'
          }
        },
        required: ['uid']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'email_search',
      description: `搜索邮件。

**搜索条件**：
- from：发件人地址或名称
- to：收件人地址
- subject：主题包含的关键词
- text：正文包含的关键词
- since：从某日期开始（格式：YYYY-MM-DD）
- before：到某日期结束（格式：YYYY-MM-DD）
- unseen：只搜索未读邮件（true/false）

可以组合多个条件进行搜索。`,
      parameters: {
        type: 'object',
        properties: {
          folder: {
            type: 'string',
            description: '搜索的文件夹（默认 INBOX）'
          },
          from: {
            type: 'string',
            description: '发件人（模糊匹配）'
          },
          to: {
            type: 'string',
            description: '收件人（模糊匹配）'
          },
          subject: {
            type: 'string',
            description: '主题关键词'
          },
          text: {
            type: 'string',
            description: '正文关键词'
          },
          since: {
            type: 'string',
            description: '开始日期（YYYY-MM-DD）'
          },
          before: {
            type: 'string',
            description: '结束日期（YYYY-MM-DD）'
          },
          unseen: {
            type: 'boolean',
            description: '只搜索未读邮件'
          },
          limit: {
            type: 'number',
            description: '返回数量限制（默认 20）'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'email_send',
      description: `发送邮件。

**支持功能**：
- 发送纯文本或 HTML 邮件
- 添加附件（指定文件路径）
- 抄送（CC）和密送（BCC）

**注意**：发送邮件是高风险操作，需要用户确认。`,
      parameters: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: '收件人邮箱地址（多个地址用逗号分隔）'
          },
          subject: {
            type: 'string',
            description: '邮件主题'
          },
          body: {
            type: 'string',
            description: '邮件正文（纯文本）'
          },
          html: {
            type: 'string',
            description: '邮件正文（HTML 格式，优先于 body）'
          },
          cc: {
            type: 'string',
            description: '抄送地址（多个地址用逗号分隔）'
          },
          bcc: {
            type: 'string',
            description: '密送地址（多个地址用逗号分隔）'
          },
          attachments: {
            type: 'array',
            items: { type: 'string' },
            description: '附件文件路径列表'
          },
          reply_to: {
            type: 'number',
            description: '回复的邮件 UID（用于设置 In-Reply-To 头）'
          }
        },
        required: ['to', 'subject']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'email_delete',
      description: `删除或移动邮件。

**操作类型**：
- 删除：将邮件移动到垃圾箱
- 彻底删除：永久删除邮件（不可恢复）
- 移动：将邮件移动到指定文件夹

**注意**：删除操作需要用户确认。`,
      parameters: {
        type: 'object',
        properties: {
          folder: {
            type: 'string',
            description: '邮件所在文件夹（默认 INBOX）'
          },
          uids: {
            type: 'array',
            items: { type: 'number' },
            description: '要操作的邮件 UID 列表'
          },
          action: {
            type: 'string',
            enum: ['trash', 'delete', 'move'],
            description: '操作类型：trash（移到垃圾箱）、delete（彻底删除）、move（移动到指定文件夹）'
          },
          target_folder: {
            type: 'string',
            description: '目标文件夹（action 为 move 时必填）'
          }
        },
        required: ['uids', 'action']
      }
    }
  }
]

