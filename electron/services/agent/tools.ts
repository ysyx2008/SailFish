/**
 * Agent 工具定义
 */
import type { ToolDefinition } from '../ai.service'
import type { McpService } from '../mcp.service'
import { getSkillsSummary } from './skills/registry'
import { getUserSkillService } from '../user-skill.service'
import { getConfigService } from '../config.service'

// 重新导出 ToolDefinition 类型供技能模块使用
export type { ToolDefinition }

import type { TerminalType, RemoteChannel } from '@shared/types'

/** @deprecated Use TerminalType from @shared/types */
export type AgentMode = TerminalType

/**
 * 工具元数据
 */
interface ToolMeta {
  /** 支持的运行模式（不指定则支持所有模式） */
  supportedModes?: AgentMode[]
}

/**
 * 带元数据的工具定义
 */
interface ToolDefinitionWithMeta extends ToolDefinition {
  _meta?: ToolMeta
}

/**
 * 动态构建 skill 工具定义（合并 load_skill + unload_skill）
 */
function buildSkillTool(): ToolDefinition {
  const disabledIds = new Set(getConfigService().get('disabledBuiltinSkills') || [])
  const skills = getSkillsSummary().filter(s => !disabledIds.has(s.id))
  const skillsCompact = skills.length > 0
    ? skills.map(s => `- ${s.id}: ${s.description}`).join('\n')
    : '暂无'
  const skillIds = skills.map(s => `"${s.id}"`).join(', ') || '暂无'

  return {
    type: 'function',
    function: {
      name: 'skill',
      description: `加载或卸载技能模块。加载后会话内持续有效。涉及相关领域时先加载再执行。\n\n可用技能：${skillsCompact}`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['load', 'unload'],
            description: '操作类型：load（加载）或 unload（卸载）'
          },
          skill_id: {
            type: 'string',
            description: `技能 ID，可选值: ${skillIds}`
          }
        },
        required: ['action', 'skill_id']
      }
    }
  }
}

/**
 * 动态构建 load_user_skill 工具定义
 * 用于加载用户自定义的技能（SKILL.md 文件）
 */
function buildLoadUserSkillTool(): ToolDefinition {
  const userSkillService = getUserSkillService()
  const skills = userSkillService.getEnabledSkills()
  const skillsList = skills.length > 0
    ? skills.map(s => {
        const desc = s.description ? ` - ${s.description}` : ''
        return `- **${s.id}**: ${s.name}${desc}`
      }).join('\n')
    : '- 暂无用户技能'

  return {
    type: 'function',
    function: {
      name: 'load_user_skill',
      description: `加载用户自定义技能（SKILL.md 操作指南）。与 skill 不同：skill 加载工具函数，本工具加载知识/流程指导。

**可用用户技能**：
${skillsList}`,
      parameters: {
        type: 'object',
        properties: {
          skill_id: {
            type: 'string',
            description: `用户技能 ID，可选值: ${skills.map(s => `"${s.id}"`).join(', ') || '暂无'}`
          }
        },
        required: ['skill_id']
      }
    }
  }
}

/**
 * 工具获取选项
 */
export interface GetAgentToolsOptions {
  /** Agent 运行模式，用于过滤不适用的工具 */
  mode?: AgentMode
  /** 请求来源通道（用于条件性加载 IM 专属工具） */
  remoteChannel?: RemoteChannel
  /** 是否包含上下文管理工具（用量超过阈值时启用，节省 token） */
  includeContextTools?: boolean
}

/**
 * 获取可用工具定义
 * @param mcpService 可选的 MCP 服务，用于动态加载 MCP 工具
 * @param options 可选配置，如终端类型
 */
export function getAgentTools(mcpService?: McpService, options?: GetAgentToolsOptions): ToolDefinition[] {
  // assistant 模式的轻量命令执行工具（child_process）
  // 终端模式的 execute_command 及终端交互工具由 terminal 技能提供
  const execTool: ToolDefinitionWithMeta | null = options?.mode === 'assistant'
    ? {
        type: 'function',
        function: {
          name: 'exec',
          description: `运行 shell 命令并返回输出（同步）。不支持交互式命令(vim/nano/tmux)。长时间命令通过 timeout 延长（默认 60s，最大 600s）。命令上限 800 字符。`,
          parameters: {
            type: 'object',
            properties: {
              command: {
                type: 'string',
                description: '要执行的 shell 命令（最长 800 字符）'
              },
              cwd: {
                type: 'string',
                description: '工作目录（可选，默认使用当前目录）'
              },
              timeout: {
                type: 'number',
                description: '超时秒数（默认 60，最大 600）。长时间命令（如构建、下载、sleep+check 轮询）应设置足够的 timeout'
              }
            },
            required: ['command']
          }
        }
      }
    : null

  // 内置工具（所有模式通用）
  const builtinTools: ToolDefinition[] = [
    ...(execTool ? [execTool as ToolDefinition] : []),
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: `读取本地文件。支持文本、PDF、Word(.doc/.docx)、图片(jpg/png/gif/bmp/webp/ico，自动注入视觉上下文)。自动检测二进制文件。大文件先用 info_only 查信息，再按行范围读取。仅本地文件，SSH 远程请用命令行。`,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '文件路径（绝对路径或相对于当前目录）'
            },
            info_only: {
              type: 'boolean',
              description: '仅获取文件信息（大小、行数等），不读取内容'
            },
            start_line: { type: 'number', description: '起始行号（从1开始）' },
            end_line: { type: 'number', description: '结束行号（包含）' },
            max_lines: { type: 'number', description: '从开头读取的最大行数' },
            tail_lines: { type: 'number', description: '从末尾读取的行数' }
          },
          required: ['path']
        }
      },
      _meta: { supportedModes: ['local', 'assistant'] }
    } as ToolDefinitionWithMeta,
    {
      type: 'function',
      function: {
        name: 'edit_file',
        description: `查找替换修改本地文件（修改首选工具）。使用前必须先 read_file 查看文件，old_text 必须从 read_file 输出中精确复制（不含行号前缀）。old_text 必须在文件中唯一匹配，匹配多处时提供更多上下文使其唯一。创建新文件请用 write_local_file。`,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '本地文件路径（绝对路径或相对于当前目录）'
            },
            old_text: {
              type: 'string',
              description: '要替换的原始文本，必须与文件内容完全匹配（包括空白和换行）'
            },
            new_text: {
              type: 'string',
              description: '替换后的新文本'
            },
            replace_all: {
              type: 'boolean',
              description: '替换所有匹配（默认 false，仅替换唯一匹配）'
            }
          },
          required: ['path', 'old_text', 'new_text']
        }
      },
      _meta: { supportedModes: ['local', 'assistant'] }
    } as ToolDefinitionWithMeta,
    {
      type: 'function',
      function: {
        name: 'write_local_file',
        description: `写入或创建本地纯文本文件。部分修改请优先用 edit_file。大文件分段写入（先 create 再 append）。禁止创建 Office 文档。重要文件请先备份。`,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '本地文件路径（绝对路径或相对于当前目录）'
            },
            content: {
              type: 'string',
              description: '文件内容（覆盖/追加/插入/行替换模式必填）'
            },
            mode: {
              type: 'string',
              enum: ['create', 'overwrite', 'append', 'insert', 'replace_lines', 'regex_replace'],
              description: '写入模式（默认 create）'
            },
            insert_at_line: { type: 'number', description: 'insert: 插入行号（从1开始）' },
            start_line: { type: 'number', description: 'replace_lines: 起始行号' },
            end_line: { type: 'number', description: 'replace_lines: 结束行号' },
            pattern: { type: 'string', description: 'regex_replace: 正则表达式' },
            replacement: { type: 'string', description: 'regex_replace: 替换内容（支持 $1 $2）' },
            replace_all: { type: 'boolean', description: 'regex_replace: 替换全部（默认 true）' }
          },
          required: ['path']
        }
      },
      _meta: { supportedModes: ['local', 'assistant'] }
    } as ToolDefinitionWithMeta,
    {
      type: 'function',
      function: {
        name: 'write_remote_file',
        description: `通过 SFTP 写入远程文件。大文件分段写入（先 create 再 append）。路径不支持 ~。局部修改请用命令行 sed/awk。`,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '远程文件路径'
            },
            content: {
              type: 'string',
              description: '文件内容'
            },
            mode: {
              type: 'string',
              enum: ['create', 'overwrite', 'append'],
              description: '写入模式：create（新建，默认）、overwrite（覆盖）、append（追加）'
            }
          },
          required: ['path', 'content']
        }
      },
      _meta: { supportedModes: ['ssh'] }
    } as ToolDefinitionWithMeta,
    {
      type: 'function',
      function: {
        name: 'file_search',
        description: `快速搜索本地文件名（基于系统索引，毫秒级）。支持通配符 * 和 ?。仅搜文件名不搜内容，搜内容请用 grep。仅本地，不支持 SSH。`,
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '搜索关键词，支持通配符 * 和 ?'
            },
            path: {
              type: 'string',
              description: '限制搜索目录（可选，不指定则全盘搜索）'
            },
            type: {
              type: 'string',
              enum: ['file', 'dir', 'all'],
              description: '搜索类型：file（仅文件）、dir（仅目录）、all（全部，默认）'
            },
            limit: {
              type: 'number',
              description: '最大结果数量，默认 50'
            }
          },
          required: ['query']
        }
      },
      _meta: { supportedModes: ['local', 'assistant'] }
    } as ToolDefinitionWithMeta,
    {
      type: 'function',
      function: {
        name: 'remember_info',
        description: '将信息整合到持久知识文档中，未来交互时自动提供。适用于用户要求记住的偏好、配置、约定等长期有效的信息。',
        parameters: {
          type: 'object',
          properties: {
            info: {
              type: 'string',
              description: '要记住的信息，关键细节必须完整准确'
            }
          },
          required: ['info']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'search_knowledge',
        description: '搜索用户的知识库文档。搜索结果已包含文档内容，直接使用即可。',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '简短的搜索词，1-3个核心关键词即可，避免堆砌'
            },
            limit: {
              type: 'integer',
              description: '返回结果数量（整数），默认 5，范围 1-20'
            }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_knowledge_doc',
        description: '按文档 ID 精确获取知识库中的完整文档内容。当用户通过 @docs 引用了特定文档时（消息中会显示 doc_id:xxx），使用此工具获取完整内容。',
        parameters: {
          type: 'object',
          properties: {
            doc_id: {
              type: 'string',
              description: '文档 ID，从用户消息中的 doc_id:xxx 获取'
            }
          },
          required: ['doc_id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'ask_user',
        description: `向用户提问并等待回复。只在制定计划时提问，执行中优先用合理默认值。调用后暂停执行直到用户回复。`,
        parameters: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: '要向用户提出的问题，应清晰明确'
            },
            options: {
              type: 'array',
              items: { type: 'string' },
              description: '可选项列表（最多 10 个）'
            },
            allow_multiple: { type: 'boolean', description: '允许多选（默认 false）' },
            default_value: { type: 'string', description: '默认值' },
            timeout: { type: 'number', description: '超时秒数（默认 120，范围 30-600）' }
          },
          required: ['question']
        }
      }
    },
    // ==================== Plan 工具（合并 create/update/clear） ====================
    {
      type: 'function',
      function: {
        name: 'plan',
        description: `管理任务执行计划。4+ 步骤且有依赖关系时使用，简单任务不需要。

**action**：
- create: 创建计划（需 title + steps）
- update: 更新步骤状态（需 step_index + status）
- clear: 归档计划（可选 reason）`,
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['create', 'update', 'clear'],
              description: '操作类型'
            },
            title: { type: 'string', description: 'create: 计划标题' },
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: '步骤标题' },
                  description: { type: 'string', description: '步骤说明（可选）' }
                },
                required: ['title']
              },
              description: 'create: 步骤列表'
            },
            step_index: { type: 'number', description: 'update: 步骤索引（从 0 开始）' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed', 'failed', 'skipped'],
              description: 'update: 步骤状态'
            },
            result: { type: 'string', description: 'update: 步骤结果说明（可选）' },
            reason: { type: 'string', description: 'clear: 归档原因（可选）' }
          },
          required: ['action']
        }
      }
    },
    buildSkillTool(),
    buildLoadUserSkillTool(),
    // ==================== 任务记忆工具（合并 recall_task/deep_recall） ====================
    {
      type: 'function',
      function: {
        name: 'recall',
        description: `回忆之前任务的信息。默认返回摘要（命令、路径、错误、关键发现），设 detail="full" 获取完整执行步骤。

上下文中的"任务历史"列表显示了所有可回忆的任务 ID。`,
        parameters: {
          type: 'object',
          properties: {
            task_id: {
              type: 'string',
              description: '任务 ID'
            },
            detail: {
              type: 'string',
              enum: ['summary', 'full'],
              description: '详细程度，默认 summary'
            },
            step_index: {
              type: 'number',
              description: 'detail=full 时可指定步骤索引（从 0 开始）'
            }
          },
          required: ['task_id']
        }
      }
    },
    // ==================== 历史搜索工具 ====================
    {
      type: 'function',
      function: {
        name: 'search_history',
        description: `搜索跨会话的历史对话记录（recall 只查当前会话）。支持两种模式：keyword（关键字匹配，默认）和 semantic（语义搜索，用自然语言描述要找什么）。keyword 模式需提供 keyword/start_date/end_date 至少一个；semantic 模式需提供 keyword 作为语义查询。detail: summary（默认）仅任务和结果，full 含工具调用记录。`,
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '搜索关键字或语义查询（semantic 模式下用自然语言描述）' },
            mode: {
              type: 'string',
              enum: ['keyword', 'semantic'],
              description: '搜索模式：keyword=关键字匹配（默认），semantic=向量语义搜索'
            },
            start_date: { type: 'string', description: '开始时间（YYYY-MM-DD 或 YYYY-MM-DD HH:mm）' },
            end_date: { type: 'string', description: '结束时间' },
            detail: {
              type: 'string',
              enum: ['summary', 'full'],
              description: '输出级别。summary=仅任务和结果；full=额外包含工具调用记录。默认 summary'
            },
            limit: {
              type: 'number',
              description: '返回结果数量，默认 10，最大 30'
            }
          },
          required: []
        }
      }
    },
    // ==================== 发消息给用户 ====================
    {
      type: 'function',
      function: {
        name: 'talk_to_user',
        description: `向用户发送 IM 消息或应用内推送通知。用于主动触达用户（如关切触发、唤醒、定时提醒、后台任务完成通知等）。`,
        parameters: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: '要发送给用户的消息内容'
            },
            title: {
              type: 'string',
              description: '消息标题（可选，一般为你的名字，指定后以卡片形式发送）'
            }
          },
          required: ['message']
        }
      }
    }
  ]

  // 根据运行模式过滤工具
  let filteredTools: ToolDefinition[] = builtinTools
  if (options?.mode) {
    filteredTools = builtinTools.filter(tool => {
      const meta = (tool as ToolDefinitionWithMeta)._meta
      // 没有 _meta 或没有 supportedModes 的工具支持所有模式
      if (!meta?.supportedModes) return true
      // 检查当前模式是否在支持列表中
      return meta.supportedModes.includes(options.mode!)
    })
  }

  // IM 通道专属工具：所有 IM 平台均可发送文件和图片
  const imPlatformMeta: Record<string, { name: string; fileLimit: string; imageLimit: string }> = {
    dingtalk: { name: '钉钉', fileLimit: '20MB', imageLimit: '20MB' },
    feishu:   { name: '飞书', fileLimit: '30MB', imageLimit: '10MB' },
    slack:    { name: 'Slack', fileLimit: '1GB', imageLimit: '1GB' },
    telegram: { name: 'Telegram', fileLimit: '50MB', imageLimit: '10MB' },
    wecom:    { name: '企业微信', fileLimit: '20MB', imageLimit: '20MB' },
  }
  const imMeta = options?.remoteChannel ? imPlatformMeta[options.remoteChannel] : undefined
  if (imMeta) {
    filteredTools.push({
      type: 'function',
      function: {
        name: 'send_to_chat',
        description: `发送本地文件或图片到当前${imMeta.name}聊天。图片会内联显示，其他文件作为附件发送。

**限制**：文件 ≤${imMeta.fileLimit}，图片 ≤${imMeta.imageLimit}，一次一个文件。`,
        parameters: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: '文件的绝对路径'
            },
            type: {
              type: 'string',
              enum: ['file', 'image'],
              description: '发送类型：image（图片，内联显示）或 file（文件，附件形式）。默认 file'
            },
            file_name: {
              type: 'string',
              description: 'type=file 时可选，自定义文件名'
            }
          },
          required: ['file_path']
        }
      }
    })
  }

  // 上下文管理工具：仅在用量超过阈值时注入，节省 token
  if (options?.includeContextTools) {
    filteredTools.push(...getContextManagementTools())
  }

  // 清理内部元数据，避免发送到 API 浪费 token
  const cleanTools = filteredTools.map(tool => {
    const { _meta, ...clean } = tool as ToolDefinitionWithMeta
    return clean as ToolDefinition
  })

  // 如果有 MCP 服务，添加 MCP 工具
  if (mcpService) {
    const mcpTools = mcpService.getToolDefinitions()
    return [...cleanTools, ...mcpTools]
  }

  return cleanTools
}

/**
 * 上下文管理工具定义（按需加载，用量超过阈值时才注入）
 */
function getContextManagementTools(): ToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'compress_context',
        description: `压缩较早的工具调用以释放上下文空间。内容归档保留，可通过 recall_compressed 找回。摘要应包含关键结果、路径、命令和发现。`,
        parameters: {
          type: 'object',
          properties: {
            summary: {
              type: 'string',
              description: '被压缩内容的摘要，应包含关键命令、结果、路径和发现'
            },
            keep_recent: {
              type: 'number',
              description: '保留最近多少组消息（assistant + tool 响应）不压缩，默认 4'
            }
          },
          required: ['summary']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'recall_compressed',
        description: `从压缩归档中取回原始消息。省略 archive_id 则列出所有可用归档。`,
        parameters: {
          type: 'object',
          properties: {
            archive_id: {
              type: 'string',
              description: '要取回的归档 ID（如 "ca-1"），省略则列出所有可用归档'
            }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'manage_memory',
        description: `管理历史任务记忆。suggestions 设置压缩级别（0=完整 1=工具摘要 2=请求+回复 3=结构化摘要 4=一句话），discard 丢弃不需要的任务。`,
        parameters: {
          type: 'object',
          properties: {
            suggestions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  task_id: { type: 'string', description: '任务 ID' },
                  level: { type: 'number', description: '压缩级别（0-4）' },
                  reason: { type: 'string', description: '设置该级别的简要原因' }
                },
                required: ['task_id', 'level']
              },
              description: '对历史任务的压缩级别建议'
            },
            discard: {
              type: 'array',
              items: { type: 'string' },
              description: '要完全丢弃的任务 ID 列表'
            }
          }
        }
      }
    }
  ]
}
