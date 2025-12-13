/**
 * 智能巡检（多终端协调器）类型定义
 */

import type { AgentPlan, AgentStep, RiskLevel, WorkerAgentOptions } from './types'

// 重新导出 WorkerAgentOptions 供外部使用
export type { WorkerAgentOptions }

// 确认策略
export type ConfirmStrategy = 'cautious' | 'batch' | 'free'

// 协调器配置
export interface OrchestratorConfig {
  maxParallelWorkers: number      // 最大并行 Worker 数，默认 5
  workerTimeout: number           // Worker 任务超时（毫秒），默认 60000
  autoCloseTerminals: boolean     // 任务完成后自动关闭终端，默认 false
  confirmStrategy: ConfirmStrategy  // 确认策略：审慎/批量确认/自由模式
  profileId?: string              // AI 配置档案 ID（可选，默认使用当前激活的配置）
}

// 默认协调器配置
export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  maxParallelWorkers: 5,
  workerTimeout: 60000,
  autoCloseTerminals: false,
  confirmStrategy: 'batch'
}

// Worker 状态
export type WorkerStatus = 'connecting' | 'idle' | 'running' | 'completed' | 'failed' | 'timeout'

// Worker 状态
export interface WorkerState {
  terminalId: string              // 终端 ID
  hostId: string                  // 主机配置 ID
  hostName: string                // 主机显示名
  status: WorkerStatus            // 当前状态
  currentTask?: string            // 当前执行的任务
  taskStartedAt?: number          // 任务开始时间
  result?: string                 // 执行结果
  error?: string                  // 错误信息
  steps?: AgentStep[]             // Worker Agent 执行步骤
}

// 可用主机信息（从会话管理器获取）
export interface AvailableHost {
  hostId: string                  // 主机配置 ID
  name: string                    // 显示名称
  host: string                    // 主机地址
  port: number                    // 端口
  username: string                // 用户名
  group?: string                  // 分组名称
  groupId?: string                // 分组 ID
  tags?: string[]                 // 标签
}

// 任务派发请求
export interface DispatchRequest {
  terminalId: string              // 目标终端 ID
  task: string                    // 任务描述
  waitForResult?: boolean         // 是否等待结果，默认 true
  timeout?: number                // 超时时间（毫秒）
}

// 任务派发结果
export interface DispatchResult {
  terminalId: string              // 终端 ID
  terminalName: string            // 终端名称
  success: boolean                // 是否成功
  result?: string                 // 执行结果
  error?: string                  // 错误信息
  duration?: number               // 执行耗时（毫秒）
}

// 聚合结果
export interface AggregatedResult {
  totalCount: number              // 总任务数
  successCount: number            // 成功数
  failedCount: number             // 失败数
  results: DispatchResult[]       // 各终端结果
  summary?: string                // AI 生成的汇总
}

// 批量确认请求
export interface BatchConfirmation {
  orchestratorId: string          // 协调器 ID
  command: string                 // 待执行的命令
  riskLevel: RiskLevel            // 风险等级
  targetTerminals: Array<{
    terminalId: string
    terminalName: string
    selected: boolean             // 用户可取消勾选某些终端
  }>
  resolve: (
    action: 'cancel' | 'current' | 'all',
    selectedTerminals?: string[]
  ) => void
}

// 协调器消息类型
export interface OrchestratorMessage {
  id: string
  type: 'user' | 'agent' | 'system' | 'progress'
  content: string
  timestamp: number
  plan?: AgentPlan                // 附带的执行计划
  workers?: WorkerState[]         // 附带的 Worker 状态
}

// 协调器运行状态
export interface OrchestratorRun {
  id: string                      // 运行 ID
  task: string                    // 原始任务描述
  config: OrchestratorConfig      // 配置
  status: 'running' | 'completed' | 'failed' | 'aborted'
  workers: Map<string, WorkerState>  // Worker 状态映射
  currentPlan?: AgentPlan         // 当前执行计划
  messages: OrchestratorMessage[] // 消息记录
  startedAt: number               // 开始时间
  completedAt?: number            // 完成时间
  result?: AggregatedResult       // 最终结果
  pendingBatchConfirmation?: BatchConfirmation  // 待批量确认
}

// 协调器事件回调
export interface OrchestratorCallbacks {
  onMessage?: (orchestratorId: string, message: OrchestratorMessage) => void
  onWorkerUpdate?: (orchestratorId: string, worker: WorkerState) => void
  onPlanUpdate?: (orchestratorId: string, plan: AgentPlan) => void
  onNeedBatchConfirm?: (confirmation: BatchConfirmation) => void
  onComplete?: (orchestratorId: string, result: AggregatedResult) => void
  onError?: (orchestratorId: string, error: string) => void
}

// IPC 接口类型
export interface OrchestratorIPCHandlers {
  // 启动协调任务
  'orchestrator:start': (
    task: string,
    config?: Partial<OrchestratorConfig>
  ) => Promise<string>  // 返回 orchestratorId
  
  // 停止协调任务
  'orchestrator:stop': (orchestratorId: string) => Promise<void>
  
  // 获取可用主机列表
  'orchestrator:listHosts': () => Promise<AvailableHost[]>
  
  // 响应批量确认
  'orchestrator:batchConfirmResponse': (
    orchestratorId: string,
    action: 'cancel' | 'current' | 'all',
    selectedTerminals?: string[]
  ) => Promise<void>
  
  // 获取协调器状态
  'orchestrator:getStatus': (orchestratorId: string) => Promise<OrchestratorRun | null>
}

// IPC 事件类型
export interface OrchestratorIPCEvents {
  // 消息更新
  'orchestrator:message': {
    orchestratorId: string
    message: OrchestratorMessage
  }
  
  // Worker 状态更新
  'orchestrator:workerUpdate': {
    orchestratorId: string
    worker: WorkerState
  }
  
  // 计划更新
  'orchestrator:planUpdate': {
    orchestratorId: string
    plan: AgentPlan
  }
  
  // 需要批量确认
  'orchestrator:needBatchConfirm': {
    orchestratorId: string
    command: string
    riskLevel: RiskLevel
    targetTerminals: Array<{
      terminalId: string
      terminalName: string
      selected: boolean
    }>
  }
  
  // 任务完成
  'orchestrator:complete': {
    orchestratorId: string
    result: AggregatedResult
  }
  
  // 任务错误
  'orchestrator:error': {
    orchestratorId: string
    error: string
  }
}

