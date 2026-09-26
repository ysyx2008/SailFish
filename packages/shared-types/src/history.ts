/**
 * 历史记录共享类型定义
 */

import type { ConversationKind, TerminalType, TokenUsage } from './agent'

export interface AgentStepRecord {
  id: string
  type: string
  content: string
  images?: string[]
  /**
   * 「活图」载荷的持久化形态。重新打开历史会话时，前端从这里恢复出可交互的
   * ECharts 图表。详见 `EChartsStepPayload` 注释（shared/types/agent.ts）。
   *
   * 体积说明：典型 ECharts option 序列化后 5-30KB，比同等画面的 SVG base64
   * （80KB+）小一个数量级——所以同时持久化两路图依旧让历史文件总体变小。
   */
  echartsOption?: import('./agent').EChartsStepPayload
  attachments?: import('./agent').AttachmentInfo[]
  toolName?: string
  /** 关联的 tool_call ID，用于配对 tool_call ↔ tool_result（老记录可能缺失） */
  toolCallId?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  riskLevel?: string
  timestamp: number
  /** Web 搜索结构化结果（web_search 工具专用） */
  webSearchResults?: import('./agent').WebSearchResultItem[]
  /** 工具执行成败标识，前端据此判断"失败的 tool_result 必须显示" */
  success?: boolean
  /** 向用户提问这道题的结果。仅 asking 步骤使用；旧记录可能缺失 */
  askingStatus?: import('./agent').AskingStatus
  /** asking 步骤：用户亲手输入或点选的回答（不含超时默认值） */
  askingAnswer?: string
  /** auto_review 步骤：替我审批这一次的结论 */
  autoReview?: import('./agent').AutoReviewTrail
  /** 并行子 Agent 卡片组（dispatch_agents 工具专用） */
  subAgents?: import('./agent').SubAgentResult[]
  /** Canvas 预览数据（仅 UI / Artifact 面板消费，不发给 AI；历史重开时重放） */
  canvasData?: import('./canvas').CanvasData
  /** 读盘时超大行未装入正文，只留大小和头尾 */
  hugeOutput?: import('./agent').HugeOutputStub
}

export interface AgentRecord {
  id: string
  timestamp: number
  terminalId: string
  /** Agent 的身份 key（如 '__companion__'、'__watch__'，或 tabId）。存盘时由 agent._agentId 写入 */
  agentKey?: string
  /**
   * 会话类别（task/companion/watch）。缺失（老记录）时由 `inferConversationKind(agentKey)`
   * 推断补默认，见 normalizeAgentRecord。形态用 terminalType 表达，不另设 workbenchType。
   */
  kind?: ConversationKind
  terminalType: TerminalType
  sshHost?: string
  userTask: string
  /**
   * 侧栏展示标题（LLM 自动生成或用户重命名）。
   * 缺省时 UI 回退到 userTask。属于会话自身，随记录删除；勿再旁路存 config。
   */
  title?: string
  /**
   * 用户亲手改过标题。为 true 后自动生成不再覆盖。
   * 缺省（老记录）视为未手改，仍可自动更新。
   */
  titleLocked?: boolean
  steps: AgentStepRecord[]
  messages?: Array<{
    role: string
    content: string
    tool_calls?: unknown[]
    tool_call_id?: string
    hugeOutput?: import('./agent').HugeOutputStub
  }>
  finalResult?: string
  duration: number
  status: 'completed' | 'failed' | 'aborted'
  tokenUsage?: TokenUsage
  /**
   * 产出物面板的持久化清单。
   * 由 Agent 完成后或用户在面板做增删操作时写入，加载历史时直接恢复（不再 replay steps）。
   * 字段缺失时（老记录）退化为按 steps 重放，保持向后兼容。
   */
  artifacts?: import('./canvas').CanvasArtifact[]
  /**
   * 这场对话结束时还装着的技能（含经同一入口加载的外部工具包）。
   * 重开对话时按这份清单再装；字段缺失（老记录）则不补、不强行猜测。
   */
  loadedSkills?: string[]
  /**
   * 这场对话里用户亲手卸掉的技能。
   * 重开后仍不许它自己再装回来；用户再点上才开。
   */
  userDismissedSkills?: string[]
  /**
   * 最近一次上下文交接后的工作上下文。
   * 有这份时重开从这里接着，不把已交过的原文再展开。字段缺失（没交过接）则按完整记录重拼。
   */
  workingContext?: Array<{
    role: string
    content: string
    tool_calls?: unknown[]
    tool_call_id?: string
    hugeOutput?: import('./agent').HugeOutputStub
  }>
  /**
   * 这场对话里压下去的原文归档。有交接检查点时跟对话一起留下，重开还能按编号取回。
   * 字段缺失（老记录 / 没压过）视为没有归档。
   */
  compressedArchives?: Array<{
    id: string
    messages: NonNullable<AgentRecord['workingContext']>
    summary: string
    timestamp: number
  }>
}

/** 输入区胶囊用的技能快照（不含外部工具包） */
export interface VisibleConversationSkill {
  id: string
  name: string
  description?: string
  /** 这场里用过，但现在已经关掉或没有了 */
  unavailable?: boolean
}

/**
 * Agent 历史列表行（来自磁盘索引，无 steps）。
 * 用于「最近对话」弹窗一次拉全量标题后本地筛选，点开时再 `getAgentRecordById`。
 */
export interface AgentHistorySummary {
  id: string
  timestamp: number
  duration: number
  userTask: string
  /** 侧栏展示标题；缺省时 UI 回退 userTask */
  title?: string
  terminalType: TerminalType
  /** Agent 身份 key（如 '__companion__'、'__watch__'）。用于把联络/关切会话从「任务」侧栏剔除 */
  agentKey?: string
  /** 会话类别（task/companion/watch）。缺失时由 inferConversationKind(agentKey) 推断 */
  kind?: ConversationKind
  sshHost?: string
  /**
   * 这条会话当初绑定的终端编号。
   * 老记录的索引里没存过，因此它同时充当「形态是否可信」的凭据：
   * 声称是终端却给不出编号的记录，一律不当终端看待（历史上曾把助手会话误存为本地终端）。
   */
  terminalId?: string
  status: 'completed' | 'failed' | 'aborted'
}
