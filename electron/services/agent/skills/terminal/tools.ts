/**
 * 终端技能工具定义
 * 
 * 包含 PTY 版 execute_command 和终端专属工具。
 * 加载后会覆写基础工具集中的 execute_command（child_process 版）。
 */

import type { ToolDefinition } from '../../tools'

/**
 * PTY 版 execute_command 工具定义
 * 加载 terminal 技能后会覆写 base 版
 */
export const ptyExecuteCommandTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'execute_command',
    description: `在当前终端执行 shell 命令。

**⚠️ 命令长度限制（重要）**：
- 命令最长 500 字符，超过会被拒绝执行
- 超长命令或多行脚本一般应该先写入临时文件，再执行脚本文件

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

**引号配对**：命令中的引号（单引号、双引号）和括号必须正确配对。未闭合会导致 shell 进入续行模式（如 dquote>），终端将卡住。

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
          description: '要执行的 shell 命令（最长 500 字符，超过请先写入脚本文件再执行）'
        }
      },
      required: ['command']
    }
  }
}

/**
 * 终端专属工具（不含 execute_command）
 */
export const terminalOnlyTools: ToolDefinition[] = [
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
  }
]

/**
 * 获取终端技能的所有工具定义
 * 包括 PTY 版 execute_command + 终端专属工具
 */
export function getAllTerminalTools(): ToolDefinition[] {
  return [ptyExecuteCommandTool, ...terminalOnlyTools]
}
