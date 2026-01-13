/**
 * 上下文统计 composable
 * 估算 Token 使用量和上下文统计
 */
import { computed, ComputedRef } from 'vue'
import type { AgentStep } from '../stores/terminal'

// Agent 状态类型
interface AgentState {
  isRunning: boolean
  agentId?: string
  steps: AgentStep[]
  pendingConfirm?: unknown
  userTask?: string
  finalResult?: string
  history: Array<{ userTask: string; finalResult: string }>
}

// AI Profile 类型
interface AiProfile {
  id: string
  name: string
  apiUrl: string
  apiKey: string
  model: string
  proxy?: string
  contextLength?: number
}

// 上下文统计结果
export interface ContextStatsResult {
  messageCount: number
  tokenEstimate: number
  maxTokens: number
  percentage: number
}

export function useContextStats(
  agentState: ComputedRef<AgentState | undefined>,
  agentUserTask: ComputedRef<string | undefined>,
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

  // 计算上下文使用情况
  // 优先使用后端返回的实际 token 数，比前端估算更准确
  const contextStats = computed((): ContextStatsResult => {
    let totalTokens = 0
    let messageCount = 0
    
    // Agent 模式：优先使用后端返回的 contextTokens
    const allSteps = agentState.value?.steps || []
    
    // 从最新的步骤中获取后端计算的 contextTokens
    for (let i = allSteps.length - 1; i >= 0; i--) {
      if (allSteps[i].contextTokens !== undefined) {
        totalTokens = allSteps[i].contextTokens!
        break
      }
    }
    
    // 如果后端没有返回（兼容旧版本），使用简单估算
    if (totalTokens === 0) {
      // System prompt + 工具定义
      totalTokens = 600
      
      // 当前用户任务
      if (agentUserTask.value) {
        totalTokens += estimateTokens(agentUserTask.value) + 3
      }
      
      // 当前步骤的简单估算
      for (const step of allSteps) {
        totalTokens += estimateTokens(step.content || '') + 5
        if (step.toolResult) {
          totalTokens += estimateTokens(step.toolResult) + 5
        }
      }
    }
    
    messageCount = allSteps.length
    
    // 从当前 AI 配置获取上下文长度，默认 8000
    const maxTokens = activeAiProfile.value?.contextLength || 8000
    
    return {
      messageCount,
      tokenEstimate: totalTokens,
      maxTokens,
      percentage: Math.min(100, Math.round((totalTokens / maxTokens) * 100))
    }
  })

  return {
    estimateTokens,
    contextStats
  }
}
