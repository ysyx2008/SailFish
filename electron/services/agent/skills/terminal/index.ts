/**
 * 终端工具组与「终端」技能
 *
 * 终端页（local / ssh）一直带着这组工具，由 getAgentTools 直接注入，提示词见
 * packages/workbench-local、workbench-ssh 的 prompt.ts。
 *
 * 独立助手这场有了终端才装上「终端」技能，由系统按有没有窗装载，不进技能目录。
 */

import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { getAllTerminalTools } from './tools'

export { getAllTerminalTools } from './tools'

export const TERMINAL_SKILL_ID = 'terminal'

const terminalSkill: Skill = {
  id: TERMINAL_SKILL_ID,
  name: '终端',
  description: '往这场对话里看得见的终端窗打命令、看输出、按键、打字、等长命令跑完。',
  tools: getAllTerminalTools(),
  systemManaged: true,
  content: [
    '**终端**：这场对话里已有看得见的终端窗。要让用户看见的命令，用 `execute_command` 打在窗里；分屏时用 `pane_id` 指定哪扇窗。',
    '**不能用的命令**：vim、vi、nano、emacs 这类编辑器（改本机文件用 `write_text_file`），tmux、screen，mc、ranger。',
    '**长文本**：超过 200 字符的内容不要用 echo/printf 打进窗里。分析结果直接写在对话里，不要发到终端。',
    '**耗时长的命令**：先 `execute_command`，再用 `wait` 等，最后用 `check_terminal_status` 确认是否跑完。等待超时不代表命令失败。',
    '**远程窗**：看提示符判断状态。`$` 或 `#` 表示可以执行新命令；`Password:` 表示在等密码，先停下，让用户自己输入；`(y/n)` 按情况回答，或问用户；`--More--` 或 `(END)` 发送 `q` 退出。',
  ].join('\n'),
}

registerSkill(terminalSkill)
