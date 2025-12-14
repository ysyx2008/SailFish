/**
 * 钢铁军团全局状态管理
 * 用于跨组件共享钢铁军团的状态
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { LegionMessage, LegionPlan, WorkerState, LegionResult, BatchConfirmData, ConfirmStrategy, OrchestratorConfig, AvailableHost } from '../composables/useIronLegion'

export const useIronLegionStore = defineStore('ironLegion', () => {
  // ==================== 状态 ====================
  
  // 界面状态
  const isExpanded = ref(false) // 是否展开（全屏显示）
  const isActive = ref(false) // 是否有活跃任务（显示状态栏）
  
  // 任务状态
  const orchestratorId = ref<string | null>(null)
  const isRunning = ref(false)
  const taskTitle = ref('') // 当前任务标题
  const messages = ref<LegionMessage[]>([])
  const currentPlan = ref<LegionPlan | null>(null)
  const workers = ref<WorkerState[]>([])
  const availableHosts = ref<AvailableHost[]>([])
  const pendingBatchConfirm = ref<BatchConfirmData | null>(null)
  const result = ref<LegionResult | null>(null)
  const error = ref<string | null>(null)
  
  // 事件监听器清理函数
  const cleanupFns: Array<() => void> = []
  
  // ==================== 计算属性 ====================
  
  const hasHosts = computed(() => availableHosts.value.length > 0)
  
  const completedCount = computed(() => 
    currentPlan.value?.steps.filter(s => s.status === 'completed').length || 0
  )
  
  const totalSteps = computed(() => currentPlan.value?.steps.length || 0)
  
  const progress = computed(() => 
    totalSteps.value > 0 ? Math.round((completedCount.value / totalSteps.value) * 100) : 0
  )
  
  // 是否应该显示状态栏（有活跃任务或有结果）
  const shouldShowStatusBar = computed(() => 
    isActive.value && !isExpanded.value
  )
  
  // ==================== 方法 ====================
  
  // 展开面板
  const expand = () => {
    isExpanded.value = true
  }
  
  // 最小化面板
  const minimize = () => {
    isExpanded.value = false
  }
  
  // 切换展开/最小化
  const toggle = () => {
    isExpanded.value = !isExpanded.value
  }
  
  // 激活钢铁军团（显示状态栏）
  const activate = () => {
    isActive.value = true
  }
  
  // 完全关闭（隐藏状态栏）
  const deactivate = () => {
    isActive.value = false
    isExpanded.value = false
  }
  
  // 加载可用主机
  const loadHosts = async () => {
    try {
      availableHosts.value = await window.electronAPI.orchestrator.listHosts()
    } catch (e) {
      console.error('[IronLegion] Failed to load hosts:', e)
    }
  }
  
  // 添加消息
  const addMessage = (message: Omit<LegionMessage, 'id' | 'timestamp'>) => {
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
      isActive.value = true
      error.value = null
      result.value = null
      currentPlan.value = null
      workers.value = []
      taskTitle.value = task.slice(0, 50) + (task.length > 50 ? '...' : '')
      
      // 添加用户消息
      addMessage({
        type: 'user',
        content: task
      })
      
      // 启动协调器
      orchestratorId.value = await window.electronAPI.orchestrator.start(task, config)
      console.log('[IronLegion] Started with ID:', orchestratorId.value)
      
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
      console.error('[IronLegion] Failed to stop:', e)
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
      console.error('[IronLegion] Failed to respond batch confirm:', e)
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
    taskTitle.value = ''
  }
  
  // 完全重置（包括关闭状态栏）
  const reset = () => {
    clearSession()
    deactivate()
    orchestratorId.value = null
    isRunning.value = false
  }
  
  // 设置事件监听器
  const setupListeners = () => {
    // 避免重复注册监听器
    if (cleanupFns.length > 0) return
    
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
  
  return {
    // 界面状态
    isExpanded,
    isActive,
    shouldShowStatusBar,
    
    // 任务状态
    orchestratorId,
    isRunning,
    taskTitle,
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
    
    // 界面方法
    expand,
    minimize,
    toggle,
    activate,
    deactivate,
    
    // 任务方法
    loadHosts,
    startTask,
    stopTask,
    respondBatchConfirm,
    clearSession,
    reset,
    
    // 生命周期
    setupListeners,
    cleanupListeners
  }
})
