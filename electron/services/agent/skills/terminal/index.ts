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
