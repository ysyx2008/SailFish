/**
 * 用户技能创建工具定义
 */

import type { ToolDefinition } from '../../tools'

export const skillCreatorTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'skill_create',
      description: `创建用户技能。将知识、操作指南或最佳实践保存为可复用的技能文件。

**使用场景**：
- 用户请求"把这个创建为技能"或"保存为我的技能"
- 将复杂操作流程文档化供后续使用
- 创建领域特定的操作指南

**技能格式**：技能使用 Markdown 格式，包含 YAML frontmatter 元数据。
技能创建后可通过 load_user_skill("技能ID") 加载使用。`,
      parameters: {
        type: 'object',
        properties: {
          skill_id: {
            type: 'string',
            description: '技能 ID（英文、数字、连字符，如 video-downloader）。用于目录命名和后续加载。'
          },
          name: {
            type: 'string',
            description: '技能名称（中文或英文，如"视频下载器"）。用于显示和识别。'
          },
          description: {
            type: 'string',
            description: '技能描述（一句话概括技能用途和适用场景）。帮助判断何时使用此技能。'
          },
          content: {
            type: 'string',
            description: '技能正文内容（Markdown 格式）。包含操作步骤、命令示例、最佳实践、故障排除等。'
          },
          version: {
            type: 'string',
            description: '版本号（可选，默认 "1.0"）'
          }
        },
        required: ['skill_id', 'name', 'description', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_list',
      description: '列出所有用户技能。显示技能 ID、名称、描述、启用状态等信息。',
      parameters: {
        type: 'object',
        properties: {
          include_disabled: {
            type: 'boolean',
            description: '是否包含已禁用的技能，默认 true'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_delete',
      description: '删除用户技能。删除后技能文件将被移除，无法恢复。',
      parameters: {
        type: 'object',
        properties: {
          skill_id: {
            type: 'string',
            description: '要删除的技能 ID'
          }
        },
        required: ['skill_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_update',
      description: '更新用户技能内容。可更新名称、描述、正文内容等。',
      parameters: {
        type: 'object',
        properties: {
          skill_id: {
            type: 'string',
            description: '要更新的技能 ID'
          },
          name: {
            type: 'string',
            description: '新的技能名称（可选）'
          },
          description: {
            type: 'string',
            description: '新的技能描述（可选）'
          },
          content: {
            type: 'string',
            description: '新的技能正文内容（可选）'
          },
          version: {
            type: 'string',
            description: '新的版本号（可选）'
          }
        },
        required: ['skill_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_get_path',
      description: '获取用户技能目录路径。用于了解技能存储位置或手动编辑技能文件。',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  }
]
