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
import { executeCommandDirect, awaitExec } from './exec'
import { getTerminalContext, checkTerminalStatus, sendControlKey, sendInput } from './terminal'
import { fileSearch, readFile, editFile, writeTextFile, writeRemoteTextFile } from './file'
import { sftpPut, sftpGet } from './sftp'
import { searchKnowledge, getKnowledgeDoc } from './knowledge'
import { createPlan, updatePlan, clearPlan, dispatchPlan } from './plan'
import { recallTask, deepRecall, searchHistory, dispatchRecall } from './memory'
import { checkContext, compressContext, dispatchContext, recallCompressed, manageMemory } from './context'
import { wait, askUser, sendFileToChat, sendImageToChat, sendToChat, awaitFileTransfer, messageUser, executeMcpTool, loadMcpServer, loadSkillTool, unloadSkillTool, dispatchSkill, loadUserSkillTool, executeSkillTool } from './misc'
import { dispatchSubAgents, followupAgent, waitAgents, interruptAgent, denyIfParentOnly } from './sub-agent'
import { executeWebSearch } from './web-search'
import { executeWebFetch } from './web-fetch'
import { listSshSessionsTool, managePaneTool } from './split-pane'
import { listWorkbenchArtifactsTool, manageWorkbenchArtifactsTool } from './workbench'

// 重新导出类型
export type { ToolExecutorConfig, AgentConfig, ToolResult, ErrorCategory } from './types'

// 工具参数到目标 PTY 的解析（分屏：args.pane_id 优先于默认 ptyId）
import { resolveTargetPtyId } from './utils'
import { notePaneHostOperationIfNeeded } from './host-identity'

// 导出工具函数供外部使用
export { executeCommand } from './command'
export { executeCommandDirect, awaitExec } from './exec'
export { getTerminalContext, checkTerminalStatus, sendControlKey, sendInput } from './terminal'
export {
  fileSearch,
  readFile,
  editFile,
  writeTextFile,
  writeRemoteTextFile,
  getWorkspacePath,
  getScratchPath,
  ensureAgentWorkspaceDirs,
  isInWorkspace,
  isScratchPath,
  isAutoApproveWorkspacePath,
  assessFileWriteRisk,
  resolveWriteModeIfTargetExists,
} from './file'
export { sftpPut, sftpGet } from './sftp'
export { searchKnowledge, getKnowledgeDoc } from './knowledge'
export { createPlan, updatePlan, clearPlan, dispatchPlan } from './plan'
export { recallTask, deepRecall, searchHistory, dispatchRecall } from './memory'
export { checkContext, compressContext, recallCompressed, manageMemory } from './context'
export { wait, askUser, sendFileToChat, sendImageToChat, sendToChat, awaitFileTransfer, messageUser, executeMcpTool, loadSkillTool, unloadSkillTool, dispatchSkill, loadUserSkillTool, executeSkillTool } from './misc'
export { dispatchSubAgents, followupAgent, waitAgents, interruptAgent, getSubAgentTools } from './sub-agent'
export { executeWebSearch } from './web-search'
export { executeWebFetch } from './web-fetch'

// 导出工具函数
export {
  categorizeError,
  getErrorRecoverySuggestion,
  withRetry,
  truncateFromEnd,
  truncateFromEndDetailed,
  truncateFromEndWithNotice,
  truncateSandwichDetailed,
  truncateSandwichWithNotice,
  formatFileSize,
  normalizeToolArgs
} from './utils'

import type { ToolExecutorConfig, AgentConfig, ToolResult } from './types'

function requirePtyId(ptyId: string | undefined, toolName: string): string | ToolResult {
  if (ptyId) {
    return ptyId
  }

  return {
    success: false,
    output: '',
    error: t('error.tool_needs_terminal', { name: toolName })
  }
}

function requireTargetPty(
  args: Record<string, unknown>,
  defaultPtyId: string | undefined,
  toolName: string
): string | ToolResult {
  return requirePtyId(resolveTargetPtyId(args, defaultPtyId ?? '') || undefined, toolName)
}

/**
 * 执行工具调用 - 主入口函数
 */
export async function executeTool(
  ptyId: string | undefined,
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

  const denied = denyIfParentOnly(executor, name)
  if (denied) return denied

  notePaneHostOperationIfNeeded(name, args, ptyId, executor, toolCall.id)

  const id = ptyId ?? ''

  // 根据工具类型执行
  switch (name) {
    case 'execute_command': {
      const requiredPtyId = requireTargetPty(args, ptyId, name)
      if (typeof requiredPtyId !== 'string') return requiredPtyId
      // 分屏：args.pane_id 指定目标窗格，不传则用 Agent 创建时的默认 PTY
      // 不在此处做"窗格存活"预校验：底层 write/executeInTerminal 在实例不存在
      // 时会通过 boolean 返回值或 status:'no_instance' 明确报失败，自然冒泡更可靠
      return executeCommand(requiredPtyId, args, toolCall.id, config, executor)
    }

    case 'exec':
      return executeCommandDirect(args, toolCall.id, config, executor)

    case 'await_exec':
      return awaitExec(args, executor)

    case 'get_terminal_context': {
      const requiredPtyId = requireTargetPty(args, ptyId, name)
      if (typeof requiredPtyId !== 'string') return requiredPtyId
      return await getTerminalContext(requiredPtyId, args, executor)
    }

    case 'check_terminal_status': {
      const requiredPtyId = requireTargetPty(args, ptyId, name)
      if (typeof requiredPtyId !== 'string') return requiredPtyId
      return checkTerminalStatus(requiredPtyId, config, executor)
    }

    case 'send_control_key': {
      const requiredPtyId = requireTargetPty(args, ptyId, name)
      if (typeof requiredPtyId !== 'string') return requiredPtyId
      return sendControlKey(requiredPtyId, args, config, executor)
    }

    case 'send_input': {
      const requiredPtyId = requireTargetPty(args, ptyId, name)
      if (typeof requiredPtyId !== 'string') return requiredPtyId
      return sendInput(requiredPtyId, args, config, executor)
    }

    case 'read_file':
      return await readFile(id, args, config, executor)

    case 'file_search':
      return await fileSearch(id, args, config, executor)

    case 'edit_file':
      return editFile(id, args, toolCall.id, config, executor)

    case 'write_text_file':
      return writeTextFile(id, args, toolCall.id, config, executor)

    case 'write_remote_text_file':
      return writeRemoteTextFile(id, args, toolCall.id, config, executor)

    case 'sftp_put': {
      const requiredPtyId = requireTargetPty(args, ptyId, name)
      if (typeof requiredPtyId !== 'string') return requiredPtyId
      // 异构分屏：local 模式 tab 也能通过 pane_id 指向 SSH 窗格执行 SFTP
      return sftpPut(requiredPtyId, args, toolCall.id, config, executor)
    }

    case 'sftp_get': {
      const requiredPtyId = requireTargetPty(args, ptyId, name)
      if (typeof requiredPtyId !== 'string') return requiredPtyId
      return sftpGet(requiredPtyId, args, toolCall.id, config, executor)
    }

    case 'search_knowledge':
      return searchKnowledge(args, executor)

    case 'get_knowledge_doc':
      return getKnowledgeDoc(args, executor)

    case 'search_history':
      return searchHistory(args, executor)

    case 'wait':
      return wait(args, executor)

    case 'ask_user':
      return askUser(args, executor)

    case 'talk_to_user':
      return messageUser(args, executor)

    case 'plan':
      return dispatchPlan(args, executor)
    case 'create_plan':
      return createPlan(args, executor)
    case 'update_plan':
      return updatePlan(args, executor)
    case 'clear_plan':
      return clearPlan(args, executor)

    case 'skill':
      return await dispatchSkill(args, config, executor)
    case 'load_skill':
      return await loadSkillTool(args, config, executor)
    case 'unload_skill':
      return await unloadSkillTool(args, executor)

    case 'load_user_skill':
      return await loadUserSkillTool(args, executor)

    case 'recall':
      return dispatchRecall(args, executor, ptyId)
    case 'recall_task':
      return recallTask(args, executor, id)
    case 'deep_recall':
      return deepRecall(args, executor, id)

    case 'context':
      return await dispatchContext(args, executor)
    // 旧名：清单里已不再出现，模型一般走不到；留下以免手工/旧记录误调。
    case 'check_context':
      return checkContext(executor)
    case 'compress_context':
      return await compressContext(args, executor)
    case 'recall_compressed':
      return recallCompressed(args, executor)

    case 'manage_memory':
      return manageMemory(args, executor)

    case 'dispatch_agents':
      return dispatchSubAgents(args, config, executor, toolCall.id)
    case 'followup_agent':
      return followupAgent(args, executor)
    case 'wait_agents':
      return waitAgents(args, executor)
    case 'interrupt_agent':
      return interruptAgent(args, executor)

    case 'web_search':
      return executeWebSearch(args, executor)

    case 'web_fetch':
      return executeWebFetch(args, executor)

    case 'mcp_load':
      // 已废弃：引导改用 skill load mcp:…
      return loadMcpServer(args, executor)

    case 'send_to_chat':
      return sendToChat(args, executor)
    case 'send_file_to_chat':
      return sendFileToChat(args, executor)
    case 'send_image_to_chat':
      return sendImageToChat(args, executor)
    case 'await_file_transfer':
      return awaitFileTransfer(args, executor)

    case 'manage_pane':
      return managePaneTool(args, executor.agentId || ptyId, executor)
    case 'list_ssh_sessions':
      return listSshSessionsTool()

    case 'list_workbench_artifacts':
      return listWorkbenchArtifactsTool(executor)

    case 'manage_workbench_artifacts':
      return manageWorkbenchArtifactsTool(executor, args, ptyId)

    default:
      // MCP 工具有明确的 mcp_ 前缀，优先路由，避免被 skillSession 误认为技能工具
      if (name.startsWith('mcp_')) {
        if (executor.mcpService) {
          return executeMcpTool(name, args, toolCall.id, executor)
        }
        return { success: false, output: '', error: t('error.mcp_not_initialized') }
      }

      // 插件工具（plugin_ 前缀）
      if (name.startsWith('plugin_') && executor.pluginRegistry) {
        const pluginResult = await executor.pluginRegistry.executeTool(name, args, toolCall.id)
        if (pluginResult) return pluginResult
      }

      // 检查是否是技能工具调用
      if (executor.skillSession) {
        const skillTools = executor.skillSession.getAvailableTools()
        const skillTool = skillTools.find(t => t.function.name === name)
        if (skillTool) {
          return await executeSkillTool(name, ptyId, args, toolCall.id, config, executor)
        }
      }

      return { success: false, output: '', error: t('error.unknown_tool', { name }) }
  }
}
