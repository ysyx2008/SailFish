/**
 * 钢铁军团类型定义
 * 实际逻辑已移至 stores/ironLegion.ts
 */

// 确认策略
export type ConfirmStrategy = 'cautious' | 'batch' | 'free'

// 协调器配置
export interface OrchestratorConfig {
  maxParallelWorkers?: number
  workerTimeout?: number
  autoCloseTerminals?: boolean
  confirmStrategy?: ConfirmStrategy
  profileId?: string
}

// Worker 状态
export interface WorkerState {
  terminalId: string
  hostId: string
  hostName: string
  status: 'connecting' | 'idle' | 'running' | 'completed' | 'failed' | 'timeout'
  currentTask?: string
  result?: string
  error?: string
}

// 计划步骤
export interface LegionPlanStep {
  id: string
  title: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'
  terminalId?: string
  terminalName?: string
  result?: string
}

// 执行计划
export interface LegionPlan {
  id: string
  title: string
  steps: LegionPlanStep[]
  createdAt: number
  updatedAt: number
}

// 消息
export interface LegionMessage {
  id: string
  type: 'user' | 'agent' | 'system' | 'progress'
  content: string
  timestamp: number
}

// 可用主机
export interface AvailableHost {
  hostId: string
  name: string
  host: string
  port: number
  username: string
  group?: string
  groupId?: string
  tags?: string[]
}

// 批量确认数据
export interface BatchConfirmData {
  command: string
  riskLevel: 'safe' | 'moderate' | 'dangerous' | 'blocked'
  targetTerminals: Array<{
    terminalId: string
    terminalName: string
    selected: boolean
  }>
}

// 执行结果
export interface LegionResult {
  totalCount: number
  successCount: number
  failedCount: number
  results: Array<{
    terminalId: string
    terminalName: string
    success: boolean
    result?: string
    error?: string
  }>
}

// 为了向后兼容，导出一个空的 composable（实际使用 store）
export function useIronLegion() {
  console.warn('[useIronLegion] This composable is deprecated. Please use useIronLegionStore instead.')
  return {}
}
