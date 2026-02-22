/**
 * 终端技能
 * 
 * 为 Agent 提供 PTY 终端交互能力。加载后：
 * - 用 PTY 版 execute_command 覆写基础版（child_process）
 * - 新增终端专属工具：check_terminal_status, get_terminal_context, send_control_key, send_input, wait
 * 
 * 终端标签页创建 Agent 时自动加载此技能，用户无感。
 */

import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { getAllTerminalTools } from './tools'

const terminalSkill: Skill = {
  id: 'terminal',
  name: '终端控制',
  description: '提供 PTY 终端交互能力：在终端中执行命令、查看终端状态和输出、发送控制键和文本输入、等待命令完成。绑定终端时自动加载。',
  tools: getAllTerminalTools(),

  async init() {
    console.log('[TerminalSkill] Initialized')
  },

  async cleanup() {
    console.log('[TerminalSkill] Cleaned up')
  }
}

try {
  registerSkill(terminalSkill)
} catch (error) {
  console.error('[TerminalSkill] Failed to register:', error)
}

export { terminalSkill }
