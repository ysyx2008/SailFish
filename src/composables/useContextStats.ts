/**
 * 上下文统计 composable
 * 估算 Token 使用量和上下文统计
 */
import { computed, ComputedRef } from 'vue'
import type { AiProfile, AgentContextBar, ContextCompositionNode } from '@shared/types'
import { deriveContextBarFromSteps } from '@shared/types'
import type { AgentStep } from '../stores/terminal'

// Agent 状态类型
interface AgentState {
  isRunning: boolean
  agentId?: string
  steps: AgentStep[]
  contextBar?: AgentContextBar
  pendingConfirm?: unknown
  userTask?: string
  finalResult?: string
}

// 上下文统计结果
export interface ContextStatsResult {
  messageCount: number
  tokenEstimate: number
  maxTokens: number
  percentage: number
  /** 最近一次 API 调用的缓存命中率（0-100），undefined 表示无数据 */
  cacheHitRate?: number
  /** 本次实际使用的模型名称（视觉路由切换时与 activeAiProfile 不同） */
  effectiveModel?: string
  /** 字数组成树（live；历史回退无此字段） */
  composition?: ContextCompositionNode
  /** 当前会话本进程累计消耗（live；不落盘） */
  consumedTokens?: number
  consumedPromptTokens?: number
  consumedCompletionTokens?: number
  consumedCacheHitTokens?: number
}

export function useContextStats(
  agentState: ComputedRef<AgentState | undefined>,
  _agentUserTask: ComputedRef<string | undefined>,
  activeAiProfile: ComputedRef<AiProfile | null | undefined>
) {
  // 估算文本的 token 数量
  // 中文：约 1.5 字符/token，英文：约 4 字符/token
  const estimateTokens = (text: string): number => {
    if (!text) return 0
    
    // 统计中文字符数量
    const chineseChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
    // 非中文字符数量
    const otherChars = text.length - chineseChars
    
    // 中文约 1.5 字符/token，英文约 4 字符/token
    return Math.ceil(chineseChars / 1.5 + otherChars / 4)
  }

  // 优先会话级 contextBar；无则回退从 steps 倒查（未接到推送时）
  const contextStats = computed((): ContextStatsResult => {
    const allSteps = agentState.value?.steps || []
    const bar = agentState.value?.contextBar ?? deriveContextBarFromSteps(allSteps)

    const totalTokens = bar?.contextTokens ?? 0
    const messageCount = allSteps.length
    const maxTokens = bar?.effectiveContextLength || activeAiProfile.value?.contextLength || 128000
    const modelName = bar?.effectiveModel || activeAiProfile.value?.name

    return {
      messageCount,
      tokenEstimate: totalTokens,
      maxTokens,
      percentage: Math.min(100, Math.round((totalTokens / maxTokens) * 100)),
      cacheHitRate: bar?.cacheHitRate,
      effectiveModel: modelName,
      composition: bar?.composition,
      consumedTokens: bar?.consumedTokens,
      consumedPromptTokens: bar?.consumedPromptTokens,
      consumedCompletionTokens: bar?.consumedCompletionTokens,
      consumedCacheHitTokens: bar?.consumedCacheHitTokens,
    }
  })

  return {
    estimateTokens,
    contextStats
  }
}
