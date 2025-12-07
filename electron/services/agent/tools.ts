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
        description: `检查终端的完整状态，返回丰富的感知信息：
1. **运行状态**: 空闲/忙碌/等待输入/可能卡死
2. **输入等待**: 检测是否在等待密码、确认(y/n)、选择、或其他输入
3. **进程信息**: 前台进程、运行时长、输出速率
4. **环境信息**: 当前目录、用户、激活的虚拟环境
5. **输出模式**: 是否有进度条、测试输出、日志流等

在以下情况使用此工具：
- 执行命令前，确认终端可以接受新命令
- 命令超时后，判断是卡死还是正常运行
- 需要了解终端当前在做什么`,
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
        name: 'send_input',
        description: `向终端发送文本输入。用于响应终端的交互式提示，如：
- 确认提示 (y/n, yes/no)
- 数字选择 (1, 2, 3...)
- 密码或其他简短输入

注意：
- 默认会自动添加回车键发送输入
- 如果只想输入文字不发送，设置 press_enter 为 false
- 建议先用 check_terminal_status 确认终端正在等待输入`,
        parameters: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: '要发送的文本内容，如 "y", "n", "1", "yes" 等'
            },
            press_enter: {
              type: 'boolean',
              description: '是否在文本后自动按回车键，默认 true'
            }
          },
          required: ['text']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: `读取文件内容。支持多种读取方式：
1. **完整读取**：不指定任何范围参数，读取整个文件（文件需小于 500KB）
2. **按行范围读取**：使用 start_line 和 end_line 指定行号范围（从1开始）
3. **按行数读取**：使用 max_lines 指定从文件开头读取的行数
4. **从末尾读取**：使用 tail_lines 指定从文件末尾读取的行数
5. **文件信息查询**：只设置 info_only=true，获取文件大小、行数等信息，不读取内容

对于大文件，建议先使用 info_only=true 查看文件信息，然后根据需要读取特定部分。`,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '文件路径（绝对路径或相对于当前目录）'
            },
            info_only: {
              type: 'boolean',
              description: '仅获取文件信息（大小、行数等），不读取内容。对于大文件，建议先查询信息再决定读取范围。'
            },
            start_line: {
              type: 'number',
              description: '起始行号（从1开始）。与 end_line 配合使用可读取指定行范围。'
            },
            end_line: {
              type: 'number',
              description: '结束行号（包含）。与 start_line 配合使用可读取指定行范围。'
            },
            max_lines: {
              type: 'number',
              description: '从文件开头读取的最大行数。例如设置为 100 可读取前100行。'
            },
            tail_lines: {
              type: 'number',
              description: '从文件末尾读取的行数。例如设置为 50 可读取最后50行（类似 tail -n 50）。'
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
              type: 'number',
              description: '返回结果数量，默认 5，最大 20'
            }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_terminal_state',
        description: '获取终端的完整状态信息，包括当前工作目录、最近执行的命令、命令执行历史等。比 check_terminal_status 更详细。',
        parameters: {
          type: 'object',
          properties: {
            include_history: {
              type: 'boolean',
              description: '是否包含命令执行历史，默认 false'
            },
            history_limit: {
              type: 'number',
              description: '历史记录数量限制，默认 5'
            }
          }
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
