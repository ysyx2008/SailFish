import type { PendingConfirmation } from '@shared/types'

/**
 * Tab / 历史对话侧栏共用的 Agent UI 状态派生逻辑。
 * 事件写入 terminalStore.agentState，展示层只读此模块，避免 TabBar 与历史面板各算一套。
 */

export type TabAgentUiStatus = 'open' | 'running' | 'attention'

/** 历史行专用：无对应 tab 时为 closed */
export type HistoryConversationTabStatus = TabAgentUiStatus | 'closed'

export interface TabAgentUiMeta {
  status: TabAgentUiStatus
  pendingConfirm: boolean
  agentCompletedUnseen: boolean
  /** 待确认 或 后台任务完成未读 */
  needsAttention: boolean
  isRunning: boolean
}

export interface HistoryConversationMeta {
  status: HistoryConversationTabStatus
  pendingConfirm: boolean
  agentCompletedUnseen: boolean
}

export const CLOSED_HISTORY_CONVERSATION_META: HistoryConversationMeta = {
  status: 'closed',
  pendingConfirm: false,
  agentCompletedUnseen: false,
}

type AgentStateSlice = {
  isRunning?: boolean
  pendingConfirm?: PendingConfirmation
  agentCompletedUnseen?: boolean
}

/** 从 tab.agentState 派生 UI 状态；attention 优先于 running */
export function deriveTabAgentUiMeta(agentState?: AgentStateSlice): TabAgentUiMeta {
  const pendingConfirm = !!agentState?.pendingConfirm
  const agentCompletedUnseen = agentState?.agentCompletedUnseen === true
  const isRunning = agentState?.isRunning === true
  const needsAttention = pendingConfirm || agentCompletedUnseen
  const status: TabAgentUiStatus = needsAttention
    ? 'attention'
    : isRunning
      ? 'running'
      : 'open'
  return { status, pendingConfirm, agentCompletedUnseen, needsAttention, isRunning }
}

export function toHistoryConversationMeta(tabMeta: TabAgentUiMeta): HistoryConversationMeta {
  return {
    status: tabMeta.status,
    pendingConfirm: tabMeta.pendingConfirm,
    agentCompletedUnseen: tabMeta.agentCompletedUnseen,
  }
}

/** TabBar：非激活 tab 的 attention 提示 */
export function formatAgentAttentionTooltip(
  meta: Pick<TabAgentUiMeta, 'pendingConfirm' | 'agentCompletedUnseen' | 'needsAttention'>,
  t: (key: string) => string
): string | undefined {
  if (!meta.needsAttention) return undefined
  if (meta.pendingConfirm && meta.agentCompletedUnseen) {
    return `${t('tabs.needsAttentionConfirm')} · ${t('tabs.needsAttentionTaskFinished')}`
  }
  if (meta.pendingConfirm) return t('tabs.needsAttentionConfirm')
  return t('tabs.needsAttentionTaskFinished')
}

/** 从秘书菜单打开、占主区的非会话面板 */
export type SecretaryPanel = 'todos' | 'contacts' | 'memory'

/** 壳层当前落在哪儿——判断某条会话是否正在用户眼前所需的全部状态 */
export interface ConversationSurfaceState {
  activeTabId: string
  hubFocusedAssistantTabId: string
  secretaryPanel?: SecretaryPanel | null
  /** 人在「终端」这个地方但一个终端 tab 也没有：activeTabId 同样是空的，但眼前是空终端页 */
  terminalPlaceActive?: boolean
}

/**
 * 用户是否正在看该助手会话（attention / 未读判断 / 侧栏高亮）。
 * Hub 焦点只在任务区生效；切到联络 / 终端 Tab / 秘书面板 / 空终端页后都不算「正在看」
 * （Hub 焦点 id 仍保留以便切回，所以不能只看它有没有值）。
 */
export function isAssistantConversationSurfaceVisible(
  tabId: string,
  surface: ConversationSurfaceState
): boolean {
  const { activeTabId, hubFocusedAssistantTabId, secretaryPanel, terminalPlaceActive } = surface
  if (activeTabId && tabId === activeTabId) return true
  if (activeTabId || secretaryPanel || terminalPlaceActive) return false
  return Boolean(hubFocusedAssistantTabId) && tabId === hubFocusedAssistantTabId
}

type HubAttentionTabSlice = {
  type: string
  isRemote?: boolean
  isPromoted?: boolean
  agentId?: string
  agentState?: AgentStateSlice
}

/**
 * Hub 任务区入口（TabBar「任务」按钮）是否需要 attention：
 * 用户已离开任务区（activeTabId 非空，或开着秘书面板），且存在未提升的本地助手会话待查看/待确认。
 */
export function hasHubTasksAreaAttention(
  tabs: HubAttentionTabSlice[],
  activeTabId: string,
  companionAgentId: string,
  secretaryPanelOpen = false
): boolean {
  if (!activeTabId && !secretaryPanelOpen) return false
  return tabs.some(tab => {
    if (tab.type !== 'assistant' || tab.isRemote || tab.isPromoted) return false
    if (tab.agentId === companionAgentId) return false
    return deriveTabAgentUiMeta(tab.agentState).needsAttention
  })
}

/** 历史对话行状态图标 tooltip */
export function formatHistoryConversationTooltip(
  meta: HistoryConversationMeta,
  t: (key: string) => string
): string {
  if (meta.status === 'closed') return t('welcome.conversations.statusClosed')
  if (meta.status === 'running') return t('welcome.conversations.agentRunning')
  if (meta.pendingConfirm && meta.agentCompletedUnseen) {
    return `${t('tabs.needsAttentionConfirm')} · ${t('tabs.needsAttentionTaskFinished')}`
  }
  if (meta.pendingConfirm) return t('tabs.needsAttentionConfirm')
  if (meta.agentCompletedUnseen) return t('tabs.needsAttentionTaskFinished')
  return t('welcome.conversations.statusOpen')
}
