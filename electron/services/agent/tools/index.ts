/**
 * 工具执行器模块入口
 * 
 * 本模块负责执行 Agent 的各种工具调用，包括：
 * - 命令执行 (command.ts)
 * - 终端操作 (terminal.ts)
 * - 文件操作 (file.ts)
 * - 知识库操作 (knowledge.ts)
 * - 计划/待办 (plan.ts)
 * - 任务记忆 (memory.ts)
 * - 其他工具 (misc.ts)
 */
import type { ToolCall } from '../../ai.service'
import { t } from '../i18n'
import { normalizeToolArgs } from './utils'

// 导入各模块的工具函数
import { executeCommand } from './command'
import { getTerminalContext, checkTerminalStatus, sendControlKey, sendInput } from './terminal'
import { fileSearch, readFile, editFile, writeLocalFile, writeRemoteFile } from './file'
import { rememberInfo, searchKnowledge, getKnowledgeDoc } from './knowledge'
import { createPlan, updatePlan, clearPlan } from './plan'
import { recallTask, deepRecall } from './memory'
import { wait, askUser, sendFileToChat, sendImageToChat, sendIMNotification, executeMcpTool, loadSkillTool, unloadSkillTool, loadUserSkillTool, executeSkillTool } from './misc'

// 重新导出类型
export type { ToolExecutorConfig, AgentConfig, ToolResult, ErrorCategory } from './types'

// 导出工具函数供外部使用
export { executeCommand } from './command'
export { getTerminalContext, checkTerminalStatus, sendControlKey, sendInput } from './terminal'
export { fileSearch, readFile, editFile, writeLocalFile, writeRemoteFile } from './file'
export { rememberInfo, searchKnowledge, getKnowledgeDoc } from './knowledge'
export { createPlan, updatePlan, clearPlan } from './plan'
export { recallTask, deepRecall } from './memory'
export { wait, askUser, sendFileToChat, sendImageToChat, sendIMNotification, executeMcpTool, loadSkillTool, unloadSkillTool, loadUserSkillTool, executeSkillTool } from './misc'

// 导出工具函数
export {
  categorizeError,
  getErrorRecoverySuggestion,
  withRetry,
  truncateFromEnd,
  formatFileSize,
  normalizeToolArgs
} from './utils'

import type { ToolExecutorConfig, AgentConfig, ToolResult } from './types'

/**
 * 执行工具调用 - 主入口函数
 */
export async function executeTool(
  ptyId: string,
  toolCall: ToolCall,
  config: AgentConfig,
  terminalOutput: string[],
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  if (executor.isAborted()) {
    return { success: false, output: '', error: t('error.operation_aborted') }
  }

  const { name, arguments: argsStr } = toolCall.function
  let args: Record<string, unknown>
  
  try {
    args = JSON.parse(argsStr)
    args = normalizeToolArgs(args)
  } catch {
    return { success: false, output: '', error: t('error.tool_param_parse_failed') }
  }

  // 根据工具类型执行
  switch (name) {
    case 'execute_command':
      return executeCommand(ptyId, args, toolCall.id, config, executor)

    case 'get_terminal_context':
      return await getTerminalContext(ptyId, args, executor)

    case 'check_terminal_status':
      return checkTerminalStatus(ptyId, config, executor)

    case 'send_control_key':
      return sendControlKey(ptyId, args, config, executor)

    case 'send_input':
      return sendInput(ptyId, args, config, executor)

    case 'read_file':
      return await readFile(ptyId, args, config, executor)

    case 'file_search':
      return await fileSearch(ptyId, args, config, executor)

    case 'edit_file':
      return editFile(ptyId, args, toolCall.id, config, executor)

    case 'write_local_file':
      return writeLocalFile(ptyId, args, toolCall.id, config, executor)

    case 'write_remote_file':
      return writeRemoteFile(ptyId, args, toolCall.id, config, executor)

    case 'remember_info':
      return await rememberInfo(args, config, executor)

    case 'search_knowledge':
      return searchKnowledge(args, executor)

    case 'get_knowledge_doc':
      return getKnowledgeDoc(args, executor)

    case 'wait':
      return wait(args, executor)

    case 'ask_user':
      return askUser(args, executor)

    case 'send_im_notification':
      return sendIMNotification(args, executor)

    case 'create_plan':
      return createPlan(args, executor)

    case 'update_plan':
      return updatePlan(args, executor)

    case 'clear_plan':
      return clearPlan(args, executor)

    case 'load_skill':
      return await loadSkillTool(args, config, executor)

    case 'unload_skill':
      return await unloadSkillTool(args, executor)

    case 'load_user_skill':
      return await loadUserSkillTool(args, executor)

    case 'recall_task':
      return recallTask(args, executor, ptyId)

    case 'deep_recall':
      return deepRecall(args, executor, ptyId)

    case 'send_file_to_chat':
      return sendFileToChat(args, executor)

    case 'send_image_to_chat':
      return sendImageToChat(args, executor)

    default:
      // 检查是否是技能工具调用
      if (executor.skillSession) {
        const skillTools = executor.skillSession.getAvailableTools()
        const skillTool = skillTools.find(t => t.function.name === name)
        if (skillTool) {
          return await executeSkillTool(name, ptyId, args, toolCall.id, config, executor)
        }
      }
      
      // 检查是否是 MCP 工具调用
      if (name.startsWith('mcp_') && executor.mcpService) {
        return executeMcpTool(name, args, toolCall.id, executor)
      }
      return { success: false, output: '', error: t('error.unknown_tool', { name }) }
  }
}
