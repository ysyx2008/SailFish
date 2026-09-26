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
    '**禁止的命令**：vim/vi/nano/emacs（本机文件用 `write_text_file`）、tmux/screen、mc/ranger',
    '**长内容**：超过 200 字符禁止用 echo/printf 往窗里打；长文本分析结果直接在对话中回复，不要发送到终端',
    '**长耗时命令**：执行 → `wait` 等待 → `check_terminal_status` 确认，超时不代表失败',
    '**远程窗**：看提示符判断状态——`$`/`#` 可执行新命令；`Password:` 停下让用户输入；`(y/n)` 按情况回复或问用户；`--More--`/`(END)` 发送 `q` 退出',
  ].join('\n'),
}

registerSkill(terminalSkill)
