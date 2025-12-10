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
        description: `在当前终端执行 shell 命令。支持大部分命令，包括 top/htop/watch/tail -f 等（会自动限时执行）。仅 vim/nano 等编辑器不支持（请用 write_file 工具）。

返回值包含：
- **success**: 命令是否成功执行（true/false）
- **output**: 命令的完整输出内容
- **exitCode**: 命令退出状态码（0 表示成功，非0 表示有错误）
- **error**: 失败时的错误信息和恢复建议
- **isRunning**: 长耗时命令超时时为 true，表示命令仍在后台执行

注意：exitCode 非0 或 success=false 时应分析 output/error 内容判断问题原因。`,
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
        description: `检查终端状态并获取当前屏幕内容。返回：
1. **终端类型**: 本地终端或 SSH 终端
2. **运行状态**: 空闲/忙碌/未知（SSH 终端状态由你根据屏幕内容判断）
3. **屏幕内容**: 当前可视区域的完整内容（用户看到的画面）
4. **基本信息**: 当前目录、最近命令等

本地终端状态检测准确（基于进程检测）；SSH 终端返回屏幕内容供你判断。`,
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
        description: '获取终端最近的输出内容（从末尾向前读取）',
        parameters: {
          type: 'object',
          properties: {
            lines: {
              type: 'number',
              description: '获取的行数，默认 50，最大 500'
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
        description: `读取本地文件内容。支持多种读取方式：
1. **完整读取**：不指定任何范围参数，读取整个文件（文件需小于 500KB）
2. **按行范围读取**：使用 start_line 和 end_line 指定行号范围（从1开始）
3. **按行数读取**：使用 max_lines 指定从文件开头读取的行数
4. **从末尾读取**：使用 tail_lines 指定从文件末尾读取的行数
5. **文件信息查询**：只设置 info_only=true，获取文件大小、行数等信息，不读取内容

⚠️ **仅支持本地文件**：此工具只能读取运行终端程序的本地机器上的文件。
对于 SSH 远程主机，请使用 execute_command 执行 cat/head/tail/sed 等命令读取远程文件。

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
        description: `写入或创建本地文件。支持多种写入模式：

1. **覆盖模式（默认）**：mode='overwrite'，用 content 替换整个文件
2. **追加模式**：mode='append'，在文件末尾追加 content
3. **插入模式**：mode='insert'，在 insert_at_line 行之前插入 content
4. **行替换模式**：mode='replace_lines'，用 content 替换 start_line 到 end_line 的内容
5. **正则替换模式**：mode='regex_replace'，用正则表达式查找替换

⚠️ **重要文件请先备份**：修改配置文件、脚本等重要文件前，必须先执行备份命令：
\`cp file.txt file.txt.$(date +%Y%m%d_%H%M%S).bak\`
不需要备份：新建文件、临时文件、日志文件、明确不重要的文件

⚠️ **仅支持本地文件**：此工具只能写入本地机器上的文件。
对于 SSH 远程主机，请使用 execute_command 执行命令来写入。`,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '本地文件路径'
            },
            content: {
              type: 'string',
              description: '文件内容（覆盖/追加/插入/行替换模式必填）'
            },
            mode: {
              type: 'string',
              enum: ['overwrite', 'append', 'insert', 'replace_lines', 'regex_replace'],
              description: '写入模式：overwrite（覆盖，默认）、append（追加）、insert（插入）、replace_lines（行替换）、regex_replace（正则替换）'
            },
            insert_at_line: {
              type: 'number',
              description: '插入位置的行号（insert 模式必填，在该行之前插入，从1开始）'
            },
            start_line: {
              type: 'number',
              description: '替换起始行号（replace_lines 模式必填，从1开始，包含该行）'
            },
            end_line: {
              type: 'number',
              description: '替换结束行号（replace_lines 模式必填，包含该行）'
            },
            pattern: {
              type: 'string',
              description: '正则表达式（regex_replace 模式必填）'
            },
            replacement: {
              type: 'string',
              description: '替换内容（regex_replace 模式必填，可使用 $1 $2 等捕获组）'
            },
            replace_all: {
              type: 'boolean',
              description: '是否替换所有匹配项（regex_replace 模式，默认 true）'
            }
          },
          required: ['path']
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
        name: 'wait',
        description: `等待指定时间后继续执行。用于长耗时命令执行期间，避免频繁查询状态消耗步骤。

使用场景：
- 执行构建、编译等长时间命令后，等待一段时间再检查结果
- 等待服务启动、进程完成等
- 给自己"休息"一下，稍后继续

你可以设置一条有趣的等待消息，让等待过程更生动！`,
        parameters: {
          type: 'object',
          properties: {
            seconds: {
              type: 'number',
              description: '等待的秒数。建议根据任务类型选择：简单检查 10-30 秒，构建任务 60-180 秒，大型编译 300+ 秒'
            },
            message: {
              type: 'string',
              description: '等待时显示的消息。可以有趣一点，如"我去喝杯咖啡☕"、"容我思考片刻🤔"、"编译中，先摸会儿鱼🐟"'
            }
          },
          required: ['seconds']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'ask_user',
        description: `向用户提问并等待回复。当你需要更多信息才能继续执行任务时使用此工具。

使用场景：
- 需要用户提供特定信息（如配置参数、路径、选项等）
- 任务有多种执行方式，需要用户选择
- 执行前需要用户确认关键决策
- 遇到歧义或不确定性，需要澄清用户意图
- 需要用户输入敏感信息（如密码、密钥），但不要在问题中提示用户输入密码

注意：
- 问题要清晰、具体，让用户知道如何回答
- 如果有可选项，可以列出供用户选择（最多 10 个选项）
- 调用此工具后会暂停执行，直到用户回复
- 等待时间最长 5 分钟，超时后会提示用户未回复`,
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
              description: '可选项列表（如果问题有固定选项，最多 10 个）。例如：["选项A", "选项B", "选项C"]'
            },
            allow_multiple: {
              type: 'boolean',
              description: '是否允许多选（默认 false 为单选）。设为 true 时用户可以选择多个选项'
            },
            default_value: {
              type: 'string',
              description: '默认值（如果用户直接按回车或不回复时使用）'
            }
          },
          required: ['question']
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
