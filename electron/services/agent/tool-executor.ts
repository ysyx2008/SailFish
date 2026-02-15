/**
 * Agent 工具执行器
 * 
 * 本文件现在作为兼容层，实际实现已拆分到 tools/ 目录：
 * - tools/types.ts      - 类型定义
 * - tools/utils.ts      - 通用工具函数
 * - tools/command.ts    - 命令执行
 * - tools/terminal.ts   - 终端操作
 * - tools/file.ts       - 文件操作
 * - tools/knowledge.ts  - 知识库操作
 * - tools/plan.ts       - 计划/待办
 * - tools/memory.ts     - 任务记忆
 * - tools/misc.ts       - 其他工具（等待、提问、MCP、技能）
 * - tools/index.ts      - 模块入口
 * 
 * @see tools/README.md 了解详细架构
 */

// 重新导出所有内容，保持向后兼容

// 类型导出
export type { ToolExecutorConfig, AgentConfig, ToolResult, ErrorCategory } from './tools/index'

// 主函数
export { executeTool } from './tools/index'

// 工具函数
export {
  categorizeError,
  getErrorRecoverySuggestion,
  withRetry,
  truncateFromEnd,
  formatFileSize,
  normalizeToolArgs
} from './tools/index'

// 命令执行
export { executeCommand } from './tools/index'

// 终端操作
export {
  getTerminalContext,
  checkTerminalStatus,
  sendControlKey,
  sendInput
} from './tools/index'

// 文件操作
export {
  fileSearch,
  readFile,
  editFile,
  writeLocalFile,
  writeRemoteFile
} from './tools/index'

// 知识库
export {
  rememberInfo,
  searchKnowledge,
  getKnowledgeDoc
} from './tools/index'

// 计划
export {
  createPlan,
  updatePlan,
  clearPlan
} from './tools/index'

// 记忆
export {
  recallTask,
  deepRecall
} from './tools/index'

// 其他
export {
  wait,
  askUser,
  sendFileToChat,
  sendImageToChat,
  executeMcpTool,
  loadSkillTool,
  loadUserSkillTool,
  executeSkillTool
} from './tools/index'
