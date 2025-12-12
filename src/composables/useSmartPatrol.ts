/**
 * 智能巡检 Composable
 * 处理智能巡检（多终端协调）的前端逻辑
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'

// 确认策略
export type ConfirmStrategy = 'cautious' | 'batch' | 'free'

// 协调器配置
export interface OrchestratorConfig {
  maxParallelWorkers?: number
  workerTimeout?: number
  autoCloseTerminals?: boolean
  confirmStrategy?: ConfirmStrategy
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
export interface PatrolPlanStep {
  id: string
  title: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'
  terminalId?: string
  terminalName?: string
  result?: string
}

// 执行计划
export interface PatrolPlan {
  id: string
  title: string
  steps: PatrolPlanStep[]
  createdAt: number
  updatedAt: number
}

// 消息
export interface PatrolMessage {
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
export interface PatrolResult {
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

export function useSmartPatrol() {
  // 状态
  const orchestratorId = ref<string | null>(null)
  const isRunning = ref(false)
  const messages = ref<PatrolMessage[]>([])
  const currentPlan = ref<PatrolPlan | null>(null)
  const workers = ref<WorkerState[]>([])
  const availableHosts = ref<AvailableHost[]>([])
  const pendingBatchConfirm = ref<BatchConfirmData | null>(null)
  const result = ref<PatrolResult | null>(null)
  const error = ref<string | null>(null)

  // 事件监听器清理函数
  const cleanupFns: Array<() => void> = []

  // 计算属性
  const hasHosts = computed(() => availableHosts.value.length > 0)
  const completedCount = computed(() => 
    currentPlan.value?.steps.filter(s => s.status === 'completed').length || 0
  )
  const totalSteps = computed(() => currentPlan.value?.steps.length || 0)
  const progress = computed(() => 
    totalSteps.value > 0 ? Math.round((completedCount.value / totalSteps.value) * 100) : 0
  )

  // 加载可用主机列表
  const loadHosts = async () => {
    try {
      availableHosts.value = await window.electronAPI.orchestrator.listHosts()
    } catch (e) {
      console.error('[SmartPatrol] Failed to load hosts:', e)
    }
  }

  // 添加消息
  const addMessage = (message: Omit<PatrolMessage, 'id' | 'timestamp'>) => {
    messages.value.push({
      ...message,
      id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      timestamp: Date.now()
    })
  }

  // 启动任务
  const startTask = async (task: string, config?: OrchestratorConfig) => {
    if (isRunning.value || !task.trim()) return

    try {
      isRunning.value = true
      error.value = null
      result.value = null
      currentPlan.value = null
      workers.value = []

      // 添加用户消息
      addMessage({
        type: 'user',
        content: task
      })

      // 启动协调器
      orchestratorId.value = await window.electronAPI.orchestrator.start(task, config)
      console.log('[SmartPatrol] Started with ID:', orchestratorId.value)

    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      isRunning.value = false
      addMessage({
        type: 'system',
        content: `启动失败: ${error.value}`
      })
    }
  }

  // 停止任务
  const stopTask = async () => {
    if (!orchestratorId.value) return

    try {
      await window.electronAPI.orchestrator.stop(orchestratorId.value)
      isRunning.value = false
      addMessage({
        type: 'system',
        content: '任务已停止'
      })
    } catch (e) {
      console.error('[SmartPatrol] Failed to stop:', e)
    }
  }

  // 响应批量确认
  const respondBatchConfirm = async (
    action: 'cancel' | 'current' | 'all',
    selectedTerminals?: string[]
  ) => {
    if (!orchestratorId.value || !pendingBatchConfirm.value) return

    try {
      await window.electronAPI.orchestrator.batchConfirmResponse(
        orchestratorId.value,
        action,
        selectedTerminals
      )
      pendingBatchConfirm.value = null
    } catch (e) {
      console.error('[SmartPatrol] Failed to respond batch confirm:', e)
    }
  }

  // 清空会话
  const clearSession = () => {
    messages.value = []
    currentPlan.value = null
    workers.value = []
    result.value = null
    error.value = null
    pendingBatchConfirm.value = null
  }

  // 设置事件监听器
  const setupListeners = () => {
    // 监听消息
    const unsubMessage = window.electronAPI.orchestrator.onMessage((data) => {
      if (data.orchestratorId !== orchestratorId.value) return
      messages.value.push(data.message)
    })
    cleanupFns.push(unsubMessage)

    // 监听 Worker 更新
    const unsubWorker = window.electronAPI.orchestrator.onWorkerUpdate((data) => {
      if (data.orchestratorId !== orchestratorId.value) return
      const idx = workers.value.findIndex(w => w.terminalId === data.worker.terminalId)
      if (idx >= 0) {
        workers.value[idx] = data.worker
      } else {
        workers.value.push(data.worker)
      }
    })
    cleanupFns.push(unsubWorker)

    // 监听计划更新
    const unsubPlan = window.electronAPI.orchestrator.onPlanUpdate((data) => {
      if (data.orchestratorId !== orchestratorId.value) return
      currentPlan.value = data.plan
    })
    cleanupFns.push(unsubPlan)

    // 监听批量确认请求
    const unsubBatchConfirm = window.electronAPI.orchestrator.onNeedBatchConfirm((data) => {
      if (data.orchestratorId !== orchestratorId.value) return
      pendingBatchConfirm.value = {
        command: data.command,
        riskLevel: data.riskLevel,
        targetTerminals: data.targetTerminals
      }
    })
    cleanupFns.push(unsubBatchConfirm)

    // 监听完成
    const unsubComplete = window.electronAPI.orchestrator.onComplete((data) => {
      if (data.orchestratorId !== orchestratorId.value) return
      isRunning.value = false
      result.value = data.result
    })
    cleanupFns.push(unsubComplete)

    // 监听错误
    const unsubError = window.electronAPI.orchestrator.onError((data) => {
      if (data.orchestratorId !== orchestratorId.value) return
      isRunning.value = false
      error.value = data.error
      addMessage({
        type: 'system',
        content: `错误: ${data.error}`
      })
    })
    cleanupFns.push(unsubError)
  }

  // 清理监听器
  const cleanupListeners = () => {
    cleanupFns.forEach(fn => fn())
    cleanupFns.length = 0
  }

  // 生命周期
  onMounted(() => {
    loadHosts()
    setupListeners()
  })

  onUnmounted(() => {
    cleanupListeners()
    // 如果还在运行，停止任务
    if (isRunning.value && orchestratorId.value) {
      window.electronAPI.orchestrator.stop(orchestratorId.value).catch(() => {})
    }
  })

  return {
    // 状态
    orchestratorId,
    isRunning,
    messages,
    currentPlan,
    workers,
    availableHosts,
    pendingBatchConfirm,
    result,
    error,

    // 计算属性
    hasHosts,
    completedCount,
    totalSteps,
    progress,

    // 方法
    loadHosts,
    startTask,
    stopTask,
    respondBatchConfirm,
    clearSession,
    addMessage
  }
}

