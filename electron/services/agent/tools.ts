/**
 * Agent 工具定义
 */
import type { ToolDefinition } from '../ai.service'
import type { McpService } from '../mcp.service'
import { getSkillsSummary } from './skills/registry'

// 重新导出 ToolDefinition 类型供技能模块使用
export type { ToolDefinition }

/**
 * Agent 运行模式
 * - local: 本地终端
 * - ssh: SSH 远程终端
 * - assistant: 纯助手模式（无终端，仅对话/知识问答）
 * 未来可扩展: docker, k8s, wsl 等
 */
export type AgentMode = 'local' | 'ssh' | 'assistant'

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
 * 动态构建 load_skill 工具定义
 * 从技能注册表获取可用技能列表
 */
function buildLoadSkillTool(): ToolDefinition {
  const skills = getSkillsSummary()
  const skillsList = skills.length > 0
    ? skills.map(s => `- **${s.id}**: ${s.name} - ${s.description}`).join('\n')
    : '- 暂无可用技能'

  return {
    type: 'function',
    function: {
      name: 'load_skill',
      description: `加载技能模块以获得额外能力。技能是一组相关工具的集合，按需加载可以避免工具过多。

**可用技能**：
${skillsList}

**使用方式**：
1. 需要特定能力时，先加载对应技能
2. 加载成功后，该技能的工具变为可用
3. 完成后技能会自动清理资源

**注意**：技能在当前会话中持续有效，无需重复加载。`,
      parameters: {
        type: 'object',
        properties: {
          skill_id: {
            type: 'string',
            description: `技能 ID，可选值: ${skills.map(s => `"${s.id}"`).join(', ') || '暂无'}`
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
}

/**
 * 获取可用工具定义
 * @param mcpService 可选的 MCP 服务，用于动态加载 MCP 工具
 * @param options 可选配置，如终端类型
 */
export function getAgentTools(mcpService?: McpService, options?: GetAgentToolsOptions): ToolDefinition[] {
  // 内置工具
  const builtinTools: ToolDefinition[] = [
    {
      type: 'function',
      function: {
        name: 'execute_command',
        description: `在当前终端执行 shell 命令。

**禁止使用的命令**（会被系统拒绝）：
- vim、vi、nano、emacs 等编辑器 → 请使用 write_file 工具
- tmux、screen 等终端复用器 → 不支持
- mc、ranger 等全屏文件管理器 → 请使用 ls、cd 等命令

**持续运行的命令**（发送后立即返回，不等待超时）：
- tail -f、ping、watch、top、htop、journalctl -f 等 → 命令启动后立即返回
- 用 get_terminal_context 查看输出
- 用 send_control_key("ctrl+c") 或 send_control_key("q") 停止

**需要你自行控制的命令**：
- less、more 等分页程序 → 用 check_terminal_status 观察，发送 q 退出
- 交互式确认（apt install 等）→ 系统会自动添加 -y 参数

返回值包含：
- **success**: 命令是否成功执行（true/false）
- **output**: 命令的完整输出内容（超时时会返回终端最后 50 行）
- **error**: 失败时的错误信息和恢复建议
- **isRunning**: 为 true 时表示命令仍在运行（持续运行命令或长耗时命令超时）

注意：success=false 时应分析 output/error 内容判断问题原因。`,
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
        description: `检查终端状态，返回详细的状态分析和最近输出。返回：
1. **终端信息**: 类型、当前目录、最近命令、用户@主机、活跃环境
2. **状态检测**: 
   - 输入等待（密码/确认/选择/分页器/编辑器）及建议响应
   - 进程状态（空闲/忙碌/卡死）
   - 可否执行新命令
3. **输出类型识别**: 进度条/编译/测试/日志流/错误/表格
4. **终端输出**: 最近 50 行（不受用户滚动窗口影响）

本地终端基于进程检测状态准确；SSH 终端需结合输出内容判断。`,
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
        description: `读取本地文件内容。支持多种读取方式和文件格式：

**支持的文件格式**：
- 📄 **PDF 文件**：自动提取文本内容（不支持扫描件 OCR）
- 📝 **Word 文档**：支持 .docx（Office 2007+）和 .doc（97-2003）格式
- 📃 **文本文件**：txt、md、json、xml、html、csv 等

**读取方式**（仅适用于文本文件）：
1. **完整读取**：不指定任何范围参数，读取整个文件（文件需小于 500KB）
2. **按行范围读取**：使用 start_line 和 end_line 指定行号范围（从1开始）
3. **按行数读取**：使用 max_lines 指定从文件开头读取的行数
4. **从末尾读取**：使用 tail_lines 指定从文件末尾读取的行数
5. **文件信息查询**：只设置 info_only=true，获取文件大小、行数等信息，不读取内容

⚠️ **仅支持本地文件**：此工具只能读取运行终端程序的本地机器上的文件。
对于 SSH 远程主机，请使用 execute_command 执行 cat/head/tail/sed 等命令读取远程文件。

对于大文件，建议先使用 info_only=true 查看文件信息，然后根据需要读取特定部分。
对于 PDF/Word 文档，会自动解析提取文本，最大支持 10MB 文件。
⚠️ **文件名注意事项**：文件名中可能包含特殊字符（比如中文引号“”等），请严格使用原始文件名。`,
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
      },
      _meta: { supportedModes: ['local'] }
    } as ToolDefinitionWithMeta,
    {
      type: 'function',
      function: {
        name: 'edit_file',
        description: `精确编辑本地文件。通过查找并替换指定文本来修改文件，无需重写整个文件。

**这是修改现有文件的首选工具**，比重写整个文件更高效、更安全。

**使用方法**：
1. 提供 old_text：要替换的原始文本（必须与文件内容完全匹配）
2. 提供 new_text：替换后的新文本
3. 工具会在文件中查找 old_text 并替换为 new_text

**重要规则**：
- old_text 必须在文件中**唯一匹配**，否则会报错
- 如果匹配多处，请提供更多上下文（包含前后几行）使其唯一
- 保持原有缩进格式，不要改变空白字符

**示例场景**：
- 修改函数实现：提供函数的完整代码块作为 old_text
- 修改配置项：提供包含该配置的几行作为 old_text
- 添加代码：old_text 为插入点附近的代码，new_text 包含原代码+新增内容

⚠️ 如果需要创建新文件或完全重写，请使用 write_local_file 工具。`,
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
            }
          },
          required: ['path', 'old_text', 'new_text']
        }
      },
      _meta: { supportedModes: ['local'] }
    } as ToolDefinitionWithMeta,
    {
      type: 'function',
      function: {
        name: 'write_local_file',
        description: `写入或创建本地文件。支持多种写入模式：

**注意**：如果只需要修改文件的一部分，请优先使用 edit_file 工具。

**支持的模式**：
1. **新建模式（默认）**：mode='create'，仅创建新文件，如果文件已存在则报错
2. **覆盖模式**：mode='overwrite'，用 content 替换整个文件（文件存在会覆盖）
3. **追加模式**：mode='append'，在文件末尾追加 content
4. **插入模式**：mode='insert'，在 insert_at_line 行之前插入 content
5. **行替换模式**：mode='replace_lines'，用 content 替换 start_line 到 end_line 的内容
6. **正则替换模式**：mode='regex_replace'，用正则表达式查找替换

⚠️ **重要文件请先备份**：修改配置文件、脚本等重要文件前，必须先执行备份命令：
\`cp file.txt file.txt.$(date +%Y%m%d_%H%M%S).bak\`
不需要备份：新建文件、临时文件、日志文件、明确不重要的文件`,
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
              description: '写入模式：create（新建，默认，文件存在则报错）、overwrite（覆盖）、append（追加）、insert（插入）、replace_lines（行替换）、regex_replace（正则替换）'
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
      },
      _meta: { supportedModes: ['local'] }
    } as ToolDefinitionWithMeta,
    {
      type: 'function',
      function: {
        name: 'write_remote_file',
        description: `通过 SFTP 写入远程文件。

**支持的模式**：
1. **新建模式（默认）**：mode='create'，仅创建新文件，如果文件已存在则报错
2. **覆盖模式**：mode='overwrite'，用 content 替换整个文件
3. **追加模式**：mode='append'，在文件末尾追加 content

**注意**：路径不支持 \`~\`，请用相对路径或绝对路径

**局部修改**：如需 insert、replace_lines 等高级功能，请用 execute_command 执行 sed、awk 等命令`,
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
        description: `快速搜索本地文件（毫秒级响应）。

**搜索能力**：
- macOS: 使用 Spotlight 索引，全盘瞬时搜索
- Windows: 使用内置 Everything，全盘瞬时搜索
- Linux: 使用 locate/fd，快速搜索

**搜索语法**：
- 支持通配符: \`*\` 匹配任意字符，\`?\` 匹配单个字符
- 示例: \`*.ts\` 搜索所有 TypeScript 文件
- 示例: \`config*.json\` 搜索 config 开头的 JSON 文件
- 示例: \`project\` 搜索包含 project 的文件名

**使用场景**：
- 快速定位配置文件、日志文件
- 查找特定类型的文件
- 在项目中搜索文件

⚠️ 仅支持本地文件系统搜索，不支持 SSH 远程主机。`,
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
      _meta: { supportedModes: ['local'] }
    } as ToolDefinitionWithMeta,
    {
      type: 'function',
      function: {
        name: 'remember_info',
        description: `保存发现到知识库，下次交互时会基于语义相关性自动提供这些信息。知识库容量充足，鼓励多记录有价值的信息。

**积极记录以下内容**：
- **目录和路径**：项目目录、配置文件位置、日志位置、数据目录等
- **环境和配置**：JDK/Python/Node 版本、环境变量、系统参数
- **服务和端口**：各服务的端口、依赖关系、启动方式、配置文件位置
- **网络信息**：IP 地址、域名、防火墙规则、网络拓扑
- **软件和版本**：安装的软件、版本号、安装路径
- **定时任务**：crontab 配置、定时脚本位置
- **用户偏好**：习惯用的编辑器、常用命令、操作习惯
- **问题和方案**：遇到的问题及解决方法，避免重复排查
- **系统特性**：系统限制、特殊配置、注意事项
- **常用命令**：该主机特有的启动/停止/部署命令

**不要记录**：
- 纯动态数据（如"当前 CPU 85%"，但"CPU 经常超过 80% 需要关注"可以记）
- 大段命令输出（但输出中的关键发现要记录）

**记录要求**：路径、端口、版本等关键信息必须完整准确，禁止缩写。`,
        parameters: {
          type: 'object',
          properties: {
            info: {
              type: 'string',
              description: '要记住的信息。路径、端口等关键信息必须完整准确'
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

**核心原则：只在制定计划时提问**
- 开始执行前，先问清楚所有疑问
- 计划确定后顺畅执行，不再打断用户
- 执行中遇到意外，优先用合理默认值，实在无法继续才提问

使用场景：
- 需要用户提供特定信息（如配置参数、路径、选项等）
- 任务有多种执行方式，需要用户选择
- 执行前需要用户确认关键决策
- 遇到歧义或不确定性，需要澄清用户意图

注意：
- 问题要清晰、具体，让用户知道如何回答
- 如果有可选项，可以列出供用户选择（最多 10 个选项）
- 调用此工具后会暂停执行，直到用户回复
- 可以通过 timeout 参数设置等待时长（默认 120 秒）`,
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
            },
            timeout: {
              type: 'number',
              description: '等待用户回复的超时时间（秒）。默认 120 秒，最短 30 秒，最长 600 秒。简单选择题可设短些（如 60 秒），需要用户查资料的问题可设长些（如 300 秒）。'
            }
          },
          required: ['question']
        }
      }
    },
    // ==================== Plan/Todo 工具 ====================
    {
      type: 'function',
      function: {
        name: 'create_plan',
        description: `创建任务执行计划，向用户展示清晰的执行步骤和进度。

**何时使用**：
- 任务涉及 4 个以上步骤，且步骤间有依赖关系
- 多系统/多服务联动操作（如部署、迁移）
- 用户要求"帮我规划"或需要了解整体进度

**何时不需要**：
- 单个查询或 1-3 步的简单操作
- 用户说"直接做"/"快速帮我"

创建计划后，使用 update_plan 更新每个步骤的状态。`,
        parameters: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description: '计划标题，简短描述任务目标（如"服务器性能诊断"、"部署 Node.js 应用"）'
            },
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { 
                    type: 'string', 
                    description: '步骤标题，简洁明了（如"检查系统负载"、"安装依赖"）' 
                  },
                  description: { 
                    type: 'string', 
                    description: '步骤详细说明（可选，说明这一步要做什么）' 
                  }
                },
                required: ['title']
              },
              description: '计划步骤列表，建议 4-8 步，不超过 10 步'
            }
          },
          required: ['title', 'steps']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'update_plan',
        description: `更新计划步骤状态。在执行每个步骤前后调用，让用户实时了解进度。

**使用流程**：
1. 开始步骤前：update_plan(step_index, "in_progress")
2. 步骤完成后：update_plan(step_index, "completed", "结果说明")
3. 步骤失败时：update_plan(step_index, "failed", "失败原因")
4. 跳过步骤时：update_plan(step_index, "skipped", "跳过原因")`,
        parameters: {
          type: 'object',
          properties: {
            step_index: {
              type: 'number',
              description: '步骤索引（从 0 开始）'
            },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed', 'failed', 'skipped'],
              description: '步骤状态：pending（等待）、in_progress（执行中）、completed（完成）、failed（失败）、skipped（跳过）'
            },
            result: {
              type: 'string',
              description: '步骤结果说明（可选，如"负载正常: 0.52"、"发现 3 个错误"）'
            }
          },
          required: ['step_index', 'status']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'clear_plan',
        description: `归档当前计划。将计划及其执行情况保存到历史记录中，用户可随时查看。

**使用场景**：
- 计划执行完毕后需要开始新任务
- 计划执行失败后需要重新规划
- 用户要求放弃当前计划
- 任务目标发生变化需要制定新计划

归档后计划会保存在执行步骤中，用户可以点击查看详情。调用此工具后可以立即创建新计划。`,
        parameters: {
          type: 'object',
          properties: {
            reason: {
              type: 'string',
              description: '归档计划的原因（可选，会显示在归档记录中）'
            }
          }
        }
      }
    },
    buildLoadSkillTool()
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

  // 如果有 MCP 服务，添加 MCP 工具
  if (mcpService) {
    const mcpTools = mcpService.getToolDefinitions()
    return [...filteredTools, ...mcpTools]
  }

  return filteredTools
}
