/**
 * 终端技能
 * 
 * 为 Agent 提供 PTY 终端交互能力，绑定终端时自动加载。
 * 提供的工具：execute_command, check_terminal_status, get_terminal_context, send_control_key, send_input, wait
 */

import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { getAllTerminalTools } from './tools'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('TerminalSkill')

const terminalSkill: Skill = {
  id: 'terminal',
  name: '终端控制',
  description: 'PTY 终端交互：执行命令、查看输出、发送控制键、等待完成。绑定终端时自动加载。',
  tools: getAllTerminalTools(),

  content: [
    '**禁止的命令**：vim/vi/nano/emacs（用 `write_local_file`）、tmux/screen、mc/ranger',
    '',
    '**长内容处理**：',
    '- 超过 200 字符禁止用 echo/printf，用 `write_local_file` 写入 /tmp 再执行',
    '- 长文本分析结果直接在对话中回复，不要发送到终端',
    '',
    '**长耗时命令**：执行 → `wait` 等待 → `check_terminal_status` 确认，超时不代表失败',
    '- 等待时可以说点有趣的话，比如："去喝杯咖啡☕马上回来"、"编译中，先摸会儿鱼🐟"、"让子弹飞一会儿🎬"',
    '',
    '## SSH 终端',
    '',
    '以下规则仅在 SSH 远程终端中生效（本地终端请忽略）：',
    '',
    '- `read_file`、`edit_file`、`write_local_file` **不可用**（只能操作本地文件）',
    '- 读取远程文件用 `cat`/`head`/`tail`，写入用 `write_remote_file` 或 `echo`/`cat <<EOF`',
    '- 终端状态需根据屏幕内容自行判断（看提示符、Password:、进度等）',
    '- 上述禁止的命令和长内容处理中的 `write_local_file` 应替换为 `write_remote_file`',
    '',
    '**SSH 终端状态判断**（根据屏幕内容）：',
    '- 看到 `$` 或 `#` 提示符 → 可执行新命令',
    '- 看到 `Password:` → 暂停，让用户输入',
    '- 看到 `(y/n)` → 根据情况回复或询问用户',
    '- 看到 `--More--` 或 `(END)` → 发送 `q` 退出',
  ].join('\n'),

  async init() {
    log.info('Initialized')
  },

  async cleanup() {
    log.info('Cleaned up')
  }
}

try {
  registerSkill(terminalSkill)
} catch (error) {
  log.error('Failed to register:', error)
}

export { terminalSkill }
