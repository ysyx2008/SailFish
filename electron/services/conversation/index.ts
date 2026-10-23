/**
 * Conversation 模块公共导出
 *
 * 重构已收尾（见 docs/conversation-refactor-design.md）：
 * - `ConversationStore`：会话存储接缝，包 `AgentRecordStore`（会话存储聚合，非整个 HistoryService）
 * - `Conversation`：聚合根（真实 transcript + taskMemory + cachePrefix），Agent 委托
 * - `ConversationManager`：策略决策（回种）+ 会话工厂（馆长发证）+ 读侧查询权威；`CONVERSATION_POLICY` 策略表
 *
 * **完整 4B（Manager 拥有 Map<id,Conversation> + taskMemory 所有权反转）已决定不做**：会话只由
 * 单个 Agent 独占记录、且 taskMemory 是 Agent 级跨会话记忆，反转与之相悖。当前形态即终态。
 *
 * 早期基于「AgentRecord 是单任务」误判的扁平模型脚手架（旧 conversation.ts/manager.ts/messages.ts）
 * 已删除，按真实模型重建。
 */
export { ConversationStore } from './storage'
export { Conversation } from './conversation'
export { ConversationManager } from './manager'
export { Companion } from './companion'
export { CONVERSATION_POLICY, conversationPolicy } from './policy'
export type { ConversationPolicy } from './policy'
export type { ConversationCreateOptions, ConversationDeps, CommitRunInput } from './conversation'
export type { CompanionExtractTaskOptions } from './companion'
export {
  splitMessagesIntoTasks,
  splitStepsIntoTasks,
  stepRecordToStep,
  chunkStepsByUserTask
} from './messages'
export type { TaskIdFactory, MessageTask, StepTask } from './messages'
export {
  generateConversationTitle,
  sanitizeConversationTitle,
  shouldRefreshConversationTitle,
  titlesEquivalent,
} from './title-generator'
export type {
  GenerateConversationTitleDeps,
  GenerateConversationTitleInput,
  ConversationTitleWriter,
} from './title-generator'
