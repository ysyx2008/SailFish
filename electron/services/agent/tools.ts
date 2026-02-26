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
 * 动态构建 load_skill 工具定义
 * 从技能注册表获取可用技能列表
 */
function buildLoadSkillTool(): ToolDefinition {
  const disabledIds = new Set(getConfigService().get('disabledBuiltinSkills') || [])
  const skills = getSkillsSummary().filter(s => !disabledIds.has(s.id))
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
3. 技能在当前会话中持续有效（跨多轮对话），无需重复加载

**注意**：如果上下文较长且不再需要某技能，可用 unload_skill 卸载以释放工具槽位。`,
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
 * 动态构建 unload_skill 工具定义
 * 卸载已加载的技能，释放工具槽位
 */
function buildUnloadSkillTool(): ToolDefinition {
  const disabledIds = new Set(getConfigService().get('disabledBuiltinSkills') || [])
  const skills = getSkillsSummary().filter(s => !disabledIds.has(s.id))

  return {
    type: 'function',
    function: {
      name: 'unload_skill',
      description: `卸载已加载的技能模块，释放工具槽位。

**使用场景**：
- 当前任务不再需要某技能的功能
- 上下文较长，需要减少可用工具数量以优化响应
- 切换到不同类型的任务前清理不相关的技能

**注意**：
- 卸载后，该技能的工具将不再可用
- 如果后续需要，可以重新加载（load_skill）
- 技能的连接状态（如日历账户连接）会在卸载时清理`,
      parameters: {
        type: 'object',
        properties: {
          skill_id: {
            type: 'string',
            description: `要卸载的技能 ID，可选值: ${skills.map(s => `"${s.id}"`).join(', ') || '暂无'}`
          }
        },
        required: ['skill_id']
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
      description: `加载用户自定义技能的完整内容。用户技能是 SKILL.md 文件，包含特定领域的操作指南和最佳实践。

**可用用户技能**：
${skillsList}

**使用场景**：
- 当任务涉及用户技能描述的领域时
- 需要遵循用户定义的特定操作流程时
- 用户明确要求使用某个技能时

**使用方式**：
1. 根据任务需求选择合适的用户技能
2. 调用此工具获取技能的完整指导内容
3. 按照技能中的指导执行任务

**与 load_skill 的区别**：
- load_skill: 加载系统内置技能模块，提供额外的工具函数
- load_user_skill: 加载用户自定义的操作指南，是知识/流程类内容`,
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
          description: `运行 shell 命令并返回输出。同步等待命令完成后返回结果。

适用于：查询系统信息、运行脚本、文件操作等需要命令行辅助的场景。
不适用于：交互式命令、需要终端 UI 的程序（vim/nano/tmux 等）。

**长时间命令**：通过 timeout 参数延长等待时间（默认 60 秒，最大 600 秒）。
可以用 shell 组合命令实现"等待+检查"，如：\`sleep 120 && tail -10 logfile && ls /output/dir\`

命令长度上限 800 字符，超过请先写入脚本文件再执行。`,
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
        description: `读取本地文件内容。支持多种读取方式和文件格式：

**支持的文件格式**：
- 📄 **PDF 文件**：自动提取文本内容（不支持扫描件 OCR）
- 📝 **Word 文档**：支持 .docx（Office 2007+）和 .doc（97-2003）格式
- 🖼️ **图片文件**：jpg/jpeg、png、gif、bmp、webp，读取后自动注入视觉上下文供 AI 分析（最大 10MB）
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
      _meta: { supportedModes: ['local', 'assistant'] }
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
      _meta: { supportedModes: ['local', 'assistant'] }
    } as ToolDefinitionWithMeta,
    {
      type: 'function',
      function: {
        name: 'write_local_file',
        description: `写入或创建本地纯文本文件。支持多种写入模式：

**注意**：如果只需要修改文件的一部分，请优先使用 edit_file 工具。

**支持的模式**：
1. **新建模式（默认）**：mode='create'，仅创建新文件，如果文件已存在则报错
2. **覆盖模式**：mode='overwrite'，用 content 替换整个文件（文件存在会覆盖）
3. **追加模式**：mode='append'，在文件末尾追加 content
4. **插入模式**：mode='insert'，在 insert_at_line 行之前插入 content
5. **行替换模式**：mode='replace_lines'，用 content 替换 start_line 到 end_line 的内容
6. **正则替换模式**：mode='regex_replace'，用正则表达式查找替换

**⚠️ 禁止用此工具创建Office文档（.docx/.xlsx/.pptx）**，会被降级为.md纯文本。

**⚠️ 重要文件请先备份**：修改配置文件、脚本等重要文件前，必须先执行备份命令：
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
      _meta: { supportedModes: ['local', 'assistant'] }
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
        description: `快速搜索本地文件（毫秒级响应，基于系统索引）。

**优先使用**：按文件名/路径查找时请用本工具，不要用 execute_command 执行 find/locate——本工具通常更快（macOS Spotlight / Windows Everything / Linux locate 索引）；索引可能有短暂延迟。

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

⚠️ 仅支持本地文件系统搜索，不支持 SSH 远程主机。仅搜文件名不搜内容；搜内容请用 grep 等。`,
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
              description: '计划步骤列表，按需拆分，粒度适中即可'
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
    buildLoadSkillTool(),
    buildUnloadSkillTool(),
    buildLoadUserSkillTool(),
    // ==================== 任务记忆工具 ====================
    {
      type: 'function',
      function: {
        name: 'recall_task',
        description: `回忆之前任务的关键信息摘要。返回执行的命令、涉及的路径、服务、错误和关键发现等。

**使用场景**：
- 需要了解之前某个任务做了什么
- 需要查看之前执行过的命令
- 需要知道之前发现的问题或配置

上下文中的"任务历史"列表显示了所有可回忆的任务 ID。

**返回信息**：
- commands: 执行的关键命令
- paths: 涉及的文件路径
- services: 涉及的服务名
- errors: 遇到的错误
- keyFindings: 关键发现`,
        parameters: {
          type: 'object',
          properties: {
            task_id: {
              type: 'string',
              description: '任务 ID（从上下文中的任务历史列表获取）'
            }
          },
          required: ['task_id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'deep_recall',
        description: `深度回忆：获取某个任务的完整原始执行步骤。当需要查看命令的完整输出、配置文件的完整内容、详细的执行过程时使用。

**使用场景**：
- 需要查看某个命令的完整输出（不只是摘要）
- 需要详细分析之前的执行过程
- recall_task 返回的摘要信息不够详细

**注意**：返回内容可能较长，请根据需要指定具体步骤索引。`,
        parameters: {
          type: 'object',
          properties: {
            task_id: {
              type: 'string',
              description: '任务 ID（从上下文中的任务历史列表获取）'
            },
            step_index: {
              type: 'number',
              description: '可选，指定步骤索引（从 0 开始）。不指定则返回所有步骤的简要信息'
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
        description: `搜索历史对话记录。当你需要回顾之前跨会话的交互内容时使用（recall_task 只能查当前会话内的任务）。

**输出级别**：
- summary（默认）：任务描述 + 最终结果，适合快速浏览定位
- full：额外包含工具调用列表（执行了哪些命令、操作了哪些文件），适合需要复现操作细节的场景

**结果控制**：
- limit 控制返回 Top N（默认 10，最大 30）
- keyword 可选；可只传时间范围进行检索
- 支持 start_date / end_date 做时间范围过滤，支持到小时/分钟（YYYY-MM-DD、YYYY-MM-DD HH、YYYY-MM-DD HH:mm，或带时区 ISO）
- 当结果过多时会提示“仅返回前 N 条，可能还有更多”`,
        parameters: {
          type: 'object',
          properties: {
            keyword: {
              type: 'string',
              description: '可选，搜索关键字，会在用户任务和最终结果中匹配'
            },
            start_date: {
              type: 'string',
              description: '可选，开始时间（含），支持 YYYY-MM-DD、YYYY-MM-DD HH、YYYY-MM-DD HH:mm，或带时区 ISO 时间'
            },
            end_date: {
              type: 'string',
              description: '可选，结束时间（含），支持 YYYY-MM-DD、YYYY-MM-DD HH、YYYY-MM-DD HH:mm，或带时区 ISO 时间'
            },
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
        description: `主动跟用户说话。消息会通过最合适的渠道送达：应用内对话、IM（钉钉/飞书/Slack 等）。

**使用场景**：
- 定时任务完成后告知用户结果
- 需要主动提醒用户某些事项（日程、邮件等）
- 想跟用户打个招呼、分享想法

注意：这是你主动跟用户说话的唯一方式。只在确实有话要说时调用。`,
        parameters: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: '要发送给用户的消息内容'
            },
            title: {
              type: 'string',
              description: '消息标题（可选，指定后以卡片形式发送）'
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
        name: 'send_file_to_chat',
        description: `发送本地文件到当前${imMeta.name}聊天。将机器上的文件通过${imMeta.name}机器人发送给用户。

**使用场景**：
- 用户要求你把某个文件发过来
- 任务执行后需要将生成的文件（日志、报告、截图等）发给用户
- 发送配置文件、脚本等需要用户查看的文件

**限制**：
- 文件大小不超过 ${imMeta.fileLimit}
- 不限文件格式
- 一次只能发送一个文件，多个文件需多次调用

**注意**：
- 先确认文件存在且路径正确
- 超大文件建议先压缩再发送
- **发送图片请使用 send_image_to_chat**，效果更好（内联显示）`,
        parameters: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: '要发送的文件的绝对路径'
            },
            file_name: {
              type: 'string',
              description: '可选，自定义文件名（默认使用原始文件名）。用于给文件一个更友好的名称'
            }
          },
          required: ['file_path']
        }
      }
    })

    filteredTools.push({
      type: 'function',
      function: {
        name: 'send_image_to_chat',
        description: `发送图片到当前${imMeta.name}聊天，图片会在聊天中内联显示。

**使用场景**：
- 用户要求查看某张图片
- 任务生成了截图、图表、图片等需要展示给用户
- 需要向用户展示可视化结果

**支持的图片格式**：jpg/jpeg、png、gif、bmp、webp 等常见格式

**限制**：
- 图片大小不超过 ${imMeta.imageLimit}
- 一次只能发送一张图片

**注意**：
- 直接传文件路径即可，**不需要先 read_file**
- 先确认文件存在且路径正确
- 非图片文件请使用 send_file_to_chat`,
        parameters: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: '要发送的图片文件的绝对路径'
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

  // 如果有 MCP 服务，添加 MCP 工具
  if (mcpService) {
    const mcpTools = mcpService.getToolDefinitions()
    return [...filteredTools, ...mcpTools]
  }

  return filteredTools
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
        description: `压缩当前对话中较早的工具调用和结果，释放上下文空间。

压缩内容会归档保留（不会删除），之后可通过 recall_compressed 找回。

**何时使用**：
- "上下文状态"章节显示用量超过 70%
- 预计后续还有大量工具调用
- 某个工具返回了很长的输出，你已处理完毕

**参数说明**：
- summary：你对被压缩内容的摘要（将替换原始消息）
- keep_recent：保留最近多少组 assistant+tool 消息不压缩（默认 4）

请写清晰、有信息量的摘要，包含关键结果、路径、命令和发现。`,
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
        description: `从 compress_context 创建的压缩归档中取回原始消息。

**何时使用**：
- 需要查看之前被压缩的工具调用的完整输出
- 需要摘要中遗漏的细节信息

**参数说明**：
- archive_id：归档 ID（在压缩摘要中显示，如 "ca-1"）。省略则列出所有可用归档。`,
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
        description: `管理会话记忆：为历史任务建议压缩级别，或丢弃不再需要的任务。

**何时使用**：
- 完成任务后，优化历史任务的存储方式
- 发现不相关的任务占用了上下文空间

**压缩级别**：
- 0：完整对话（所有工具调用和结果）
- 1：压缩对话（工具调用摘要 + 最终回复）
- 2：精简对话（用户请求 + 最终回复）
- 3：结构化摘要（命令、路径、关键发现）
- 4：一句话总结

**参数说明**：
- suggestions：数组，每项包含 {task_id, level, reason}，设置压缩级别
- discard：要完全丢弃的任务 ID 数组`,
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
