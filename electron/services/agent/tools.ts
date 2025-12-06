/**
 * Agent 工具定义
 */
import type { ToolDefinition } from '../ai.service'
import type { McpService } from '../mcp.service'

/**
 * 获取可用工具定义
 * @param mcpService 可选的 MCP 服务，用于动态加载 MCP 工具
 */
export function getAgentTools(mcpService?: McpService): ToolDefinition[] {
  // 内置工具
  const builtinTools: ToolDefinition[] = [
    {
      type: 'function',
      function: {
        name: 'execute_command',
        description: '在当前终端执行 shell 命令。支持大部分命令，包括 top/htop/watch/tail -f 等（会自动限时执行）。仅 vim/nano 等编辑器不支持（请用 write_file 工具）。',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: '要执行的 shell 命令'
            }
          },
          required: ['command']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'check_terminal_status',
        description: '检查终端当前状态：是否空闲（等待输入）还是有命令正在执行。在执行命令前或命令超时后调用，可以判断终端是否卡住。',
        parameters: {
          type: 'object',
          properties: {}
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_terminal_context',
        description: '获取终端最近的输出内容，用于查看命令执行结果或当前终端显示内容。',
        parameters: {
          type: 'object',
          properties: {
            lines: {
              type: 'string',
              description: '要获取的行数，默认 50'
            }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'send_control_key',
        description: '向终端发送控制键。当终端有命令卡住或需要退出程序时使用。建议先用 check_terminal_status 确认终端状态。',
        parameters: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              enum: ['ctrl+c', 'ctrl+d', 'ctrl+z', 'enter', 'q'],
              description: 'ctrl+c: 中断命令; ctrl+d: 发送EOF; ctrl+z: 暂停; enter: 回车; q: 退出分页器'
            }
          },
          required: ['key']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: '读取文件内容',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '文件路径（绝对路径或相对于当前目录）'
            }
          },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: '写入或创建文件',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '文件路径'
            },
            content: {
              type: 'string',
              description: '文件内容'
            }
          },
          required: ['path', 'content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'remember_info',
        description: `记住用户项目的关键路径。只在发现用户自定义的、非常规的配置或日志路径时使用。不要记录系统默认路径（如/etc/nginx/）或动态信息。`,
        parameters: {
          type: 'object',
          properties: {
            info: {
              type: 'string',
              description: '用户项目的关键路径（如"项目配置在/data/myapp/config/"）'
            }
          },
          required: ['info']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'report_progress',
        description: '报告当前任务进度。用于复杂任务的关键节点，让用户了解执行状态。',
        parameters: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['started', 'in_progress', 'completed', 'blocked'],
              description: 'started: 开始执行; in_progress: 执行中; completed: 已完成; blocked: 遇到阻碍'
            },
            current_step: {
              type: 'string',
              description: '当前正在执行的步骤描述'
            },
            findings: {
              type: 'string',
              description: '到目前为止的发现或结果摘要'
            },
            next_action: {
              type: 'string',
              description: '下一步计划（如果有）'
            },
            blocked_reason: {
              type: 'string',
              description: '如果 status 是 blocked，说明阻碍原因'
            }
          },
          required: ['status', 'current_step']
        }
      }
    }
  ]

  // 如果有 MCP 服务，添加 MCP 工具
  if (mcpService) {
    const mcpTools = mcpService.getToolDefinitions()
    return [...builtinTools, ...mcpTools]
  }

  return builtinTools
}
