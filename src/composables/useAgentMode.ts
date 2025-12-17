/**
 * Agent 模式 composable
 * 处理 Agent 任务的运行、确认、事件监听等
 */
import { ref, computed, watch, onMounted, onUnmounted, Ref } from 'vue'
import { useTerminalStore } from '../stores/terminal'
import type { AgentStep } from '../stores/terminal'

// Agent 任务分组类型
export interface AgentTaskGroup {
  id: string
  userTask: string
  steps: AgentStep[]
  finalResult?: string
  isCurrentTask: boolean
}

// Agent 状态类型
// 计划步骤进度
interface PlanStepProgress {
  value: number
  current?: number
  total?: number
  eta?: string
  speed?: string
  isIndeterminate: boolean
  statusText?: string
}

// 计划步骤
interface AgentPlanStep {
  id: string
  title: string
  description?: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'
  result?: string
  progress?: PlanStepProgress
}

// Agent 执行计划
interface AgentPlan {
  id: string
  title: string
  steps: AgentPlanStep[]
  createdAt: number
  updatedAt: number
}

interface AgentState {
  isRunning: boolean
  agentId?: string
  steps: AgentStep[]
  pendingConfirm?: {
    agentId: string
    toolCallId: string
    toolName: string
    toolArgs: Record<string, unknown>
    riskLevel: string
  }
  userTask?: string
  finalResult?: string
  history: Array<{ userTask: string; finalResult: string }>
  currentPlan?: AgentPlan
}

export function useAgentMode(
  inputText: Ref<string>,
  scrollToBottom: () => Promise<void>,           // 强制滚动（用户发送时）
  scrollToBottomIfNeeded: () => Promise<void>,   // 智能滚动（收到新内容时）
  getDocumentContext: () => Promise<string>,
  getHostIdByTabId: (tabId: string) => Promise<string>,  // 根据 tabId 获取 hostId（不依赖 activeTab）
  autoProbeHostProfile: () => Promise<void>,
  summarizeAgentFindings: (hostId: string) => Promise<void>,
  tabId: Ref<string>  // 每个 AiPanel 实例固定绑定的 tab ID
) {
  const terminalStore = useTerminalStore()

  // 当前终端 ID（使用传入的 tabId，不再依赖 activeTabId）
  const currentTabId = tabId

  // Agent 模式状态（每个 AiPanel 实例独立，无需保存到 store）
  const agentMode = ref(true)
  const executionMode = ref<'strict' | 'relaxed' | 'free'>('strict')  // 执行模式：strict=严格，relaxed=宽松，free=自由
  const commandTimeout = ref(10)     // 命令超时时间（秒），默认 10 秒
  const collapsedTaskIds = ref<Set<string>>(new Set())  // 已折叠的任务 ID
  const pendingSupplements = ref<string[]>([])  // 等待处理的补充消息

  // 清理事件监听的函数
  let cleanupStepListener: (() => void) | null = null
  let cleanupConfirmListener: (() => void) | null = null
  let cleanupCompleteListener: (() => void) | null = null
  let cleanupErrorListener: (() => void) | null = null

  // 获取当前 tab（基于固定的 tabId）
  const currentTab = computed(() => {
    return terminalStore.tabs.find(t => t.id === currentTabId.value)
  })

  // Agent 状态
  const agentState = computed((): AgentState | undefined => {
    return currentTab.value?.agentState as AgentState | undefined
  })

  const isAgentRunning = computed(() => {
    return agentState.value?.isRunning || false
  })

  const pendingConfirm = computed(() => {
    return agentState.value?.pendingConfirm
  })

  const agentUserTask = computed(() => {
    return agentState.value?.userTask
  })

  // 当前执行计划 - 从 steps 中提取最新的 plan
  const currentPlan = computed((): AgentPlan | undefined => {
    const steps = agentState.value?.steps || []
    // 倒序查找最新的 plan_created 或 plan_updated
    for (let i = steps.length - 1; i >= 0; i--) {
      const step = steps[i]
      if ((step.type === 'plan_created' || step.type === 'plan_updated') && step.plan) {
        return step.plan as AgentPlan
      }
    }
    return undefined
  })

  // 切换任务步骤折叠状态
  const toggleStepsCollapse = (taskId: string) => {
    if (collapsedTaskIds.value.has(taskId)) {
      collapsedTaskIds.value.delete(taskId)
    } else {
      collapsedTaskIds.value.add(taskId)
    }
  }

  // 检查任务是否折叠
  const isStepsCollapsed = (taskId: string) => {
    return collapsedTaskIds.value.has(taskId)
  }

  // 监听执行模式变化，实时更新运行中的 Agent
  watch(executionMode, async (newValue) => {
    const agentId = agentState.value?.agentId
    if (agentId && isAgentRunning.value) {
      await window.electronAPI.agent.updateConfig(agentId, { executionMode: newValue })
    }
  })

  // 监听超时设置变化
  watch(commandTimeout, async (newValue) => {
    const agentId = agentState.value?.agentId
    if (agentId && isAgentRunning.value) {
      await window.electronAPI.agent.updateConfig(agentId, { commandTimeout: newValue * 1000 })
    }
  })

  // 按任务分组的步骤（每个任务包含：用户任务 + 步骤块 + 最终结果）
  const agentTaskGroups = computed((): AgentTaskGroup[] => {
    const allSteps = agentState.value?.steps || []
    const groups: AgentTaskGroup[] = []
    let currentGroup: AgentTaskGroup | null = null
    
    for (const step of allSteps) {
      if (step.type === 'user_task') {
        // 开始新任务
        currentGroup = {
          id: step.id,
          userTask: step.content,
          steps: [],
          isCurrentTask: false
        }
        groups.push(currentGroup)
      } else if (step.type === 'final_result') {
        // 结束当前任务
        if (currentGroup) {
          currentGroup.finalResult = step.content
          currentGroup = null
        }
      } else if (step.type !== 'confirm') {
        // 添加到当前任务的步骤
        if (currentGroup) {
          currentGroup.steps.push(step)
        }
      }
    }
    
    // 标记最后一个未完成的任务为当前任务
    if (groups.length > 0) {
      const lastGroup = groups[groups.length - 1]
      if (!lastGroup.finalResult) {
        lastGroup.isCurrentTask = true
      }
    }
    
    // 去除步骤中与 finalResult 重复的最后一个 message
    for (const group of groups) {
      if (group.finalResult && group.steps.length > 0) {
        const lastStep = group.steps[group.steps.length - 1]
        if (lastStep.type === 'message' && lastStep.content === group.finalResult) {
          group.steps = group.steps.slice(0, -1)
        }
      }
    }
    
    return groups
  })

  // 获取当前终端信息（用于历史记录）
  const getTerminalInfo = () => {
    const tab = currentTab.value
    if (!tab) return null
    return {
      terminalId: tab.id,
      terminalType: tab.type as 'local' | 'ssh',
      sshHost: tab.sshConfig?.host
    }
  }

  // 保存 Agent 记录到历史
  const saveAgentRecord = (
    _tabId: string,
    userTask: string,
    startTime: number,
    status: 'completed' | 'failed' | 'aborted',
    finalResult?: string
  ) => {
    const terminalInfo = getTerminalInfo()
    if (!terminalInfo) return
    
    const steps = agentState.value?.steps || []
    // 过滤掉 user_task 和 final_result 类型，只保留执行步骤
    const executionSteps = steps
      .filter(s => s.type !== 'user_task' && s.type !== 'final_result')
      .map(s => ({
        id: s.id,
        type: s.type,
        content: s.content,
        toolName: s.toolName,
        toolArgs: s.toolArgs ? JSON.parse(JSON.stringify(s.toolArgs)) : undefined,
        toolResult: s.toolResult,
        riskLevel: s.riskLevel,
        timestamp: s.timestamp
      }))
    
    // 使用 JSON.parse(JSON.stringify()) 确保移除所有 Vue Proxy，避免 IPC 序列化错误
    const record = JSON.parse(JSON.stringify({
      id: `agent_${startTime}`,
      timestamp: startTime,
      ...terminalInfo,
      userTask,
      steps: executionSteps,
      finalResult,
      duration: Date.now() - startTime,
      status
    }))
    
    window.electronAPI.history.saveAgentRecord(record).catch(err => {
      console.error('保存 Agent 历史记录失败:', err)
    })
  }

  // 检测任务组是否失败或被中止（都需要作为上下文带入）
  const isTaskGroupFailedOrAborted = (group: AgentTaskGroup): boolean => {
    // 用户主动中止也算，因为用户可能是发现 agent 做错了才中止的
    return group.finalResult?.startsWith('❌') ||
      group.steps.some(s => s.type === 'error')
  }

  // 检测前面连续失败的任务，并构建失败上下文（支持多个连续失败）
  const buildPreviousFailedContext = () => {
    const groups = agentTaskGroups.value
    if (groups.length === 0) return undefined

    // 从最后一个任务组开始，向前收集连续失败的任务（最多 3 个）
    const MAX_FAILED_TASKS = 3
    const failedTasks: Array<{
      userTask: string
      steps: { type: string; content: string; toolName?: string; toolArgs?: Record<string, unknown>; toolResult?: string; riskLevel?: string }[]
      finalResult: string
      timestamp: number
    }> = []

    for (let i = groups.length - 1; i >= 0 && failedTasks.length < MAX_FAILED_TASKS; i--) {
      const group = groups[i]
      
      // 如果遇到成功的任务，停止收集
      if (!isTaskGroupFailedOrAborted(group)) {
        break
      }
      
      // 收集失败任务信息
      failedTasks.unshift({
        userTask: group.userTask,
        steps: group.steps.map(s => ({
          type: s.type,
          content: s.content,
          toolName: s.toolName,
          toolArgs: s.toolArgs ? JSON.parse(JSON.stringify(s.toolArgs)) : undefined,
          toolResult: s.toolResult,
          riskLevel: s.riskLevel
        })),
        finalResult: group.finalResult || '执行失败',
        timestamp: Date.now() - (groups.length - 1 - i) * 1000  // 用索引模拟时间顺序
      })
    }

    if (failedTasks.length === 0) return undefined

    console.log(`[Agent] 检测到 ${failedTasks.length} 个连续失败的任务，构建失败上下文`)

    // 返回所有连续失败的任务
    return failedTasks
  }

  // 运行 Agent 或发送补充消息
  const runAgent = async () => {
    if (!inputText.value.trim() || !currentTabId.value) return

    const tabId = currentTabId.value
    const message = inputText.value

    // 如果 Agent 正在运行，发送补充消息而不是启动新任务
    if (isAgentRunning.value && agentState.value?.agentId) {
      inputText.value = ''
      
      // 检查是否有 asking 步骤在等待回复
      const hasWaitingAsk = agentTaskGroups.value.some(group => 
        group.isCurrentTask && group.steps.some(step => 
          step.type === 'asking' && step.toolResult?.includes('⏳')
        )
      )
      
      // 如果不是在回复提问，才显示为待处理的补充消息
      if (!hasWaitingAsk) {
        pendingSupplements.value.push(message)
      }
      
      // 发送到后端
      await window.electronAPI.agent.addMessage(agentState.value.agentId, message)
      return
    }

    const startTime = Date.now()  // 记录开始时间
    inputText.value = ''

    // 获取 Agent 上下文
    const context = terminalStore.getAgentContext(tabId)
    if (!context || !context.ptyId) {
      console.error('无法获取终端上下文')
      return
    }

    // 获取主机 ID（基于 tabId 而非 activeTab，防止用户在 Agent 执行期间切换标签导致 hostId 错误）
    const hostId = await getHostIdByTabId(tabId)

    // 检测前面连续失败的任务，构建失败上下文
    const previousFailedAgents = buildPreviousFailedContext()

    // 首次运行时自动探测主机信息（后台执行，不阻塞）
    autoProbeHostProfile().catch(e => {
      console.warn('[Agent] 主机探测失败:', e)
    })

    // 准备新任务（保留之前的步骤）
    terminalStore.clearAgentState(tabId, true)
    
    // 从 Agent 历史中构建上下文消息
    const currentHistory = agentState.value?.history || []
    const historyMessages: { role: 'user' | 'assistant'; content: string }[] = []
    for (const item of currentHistory) {
      historyMessages.push({ role: 'user', content: item.userTask })
      historyMessages.push({ role: 'assistant', content: item.finalResult })
    }
    
    // 获取文档上下文
    const documentContext = await getDocumentContext()

    // 添加用户任务到步骤中（作为对话流的一部分）
    terminalStore.addAgentStep(tabId, {
      id: `user_task_${Date.now()}`,
      type: 'user_task',
      content: message,
      timestamp: Date.now()
    })
    await scrollToBottom()

    // 设置 Agent 状态：正在运行 + 用户任务
    terminalStore.setAgentRunning(tabId, true, undefined, message)

    let result: { success: boolean; result?: string; error?: string } | null = null
    let finalContent = ''
    
    try {
      // 调用 Agent API，传递配置
      result = await window.electronAPI.agent.run(
        context.ptyId,
        message,
        {
          ...context,
          hostId,  // 主机档案 ID
          historyMessages,  // 添加历史对话
          documentContext,  // 添加文档上下文
          previousFailedAgents  // 前面连续失败的 Agent 上下文列表（如果有）
        } as { ptyId: string; terminalOutput: string[]; systemInfo: { os: string; shell: string }; terminalType: 'local' | 'ssh'; hostId?: string; historyMessages?: { role: string; content: string }[]; documentContext?: string; previousFailedAgents?: { userTask: string; steps: { type: string; content: string; toolName?: string; toolArgs?: Record<string, unknown>; toolResult?: string; riskLevel?: string }[]; finalResult: string; timestamp: number }[] },
        { executionMode: executionMode.value, commandTimeout: commandTimeout.value * 1000 }  // 传递配置（超时时间转为毫秒）
      )

      // 添加最终结果到步骤中
      if (!result.success) {
        finalContent = `❌ Agent 执行失败: ${result.error}`
      } else if (result.result) {
        finalContent = result.result
      }
      
      if (finalContent) {
        terminalStore.addAgentStep(tabId, {
          id: `final_result_${Date.now()}`,
          type: 'final_result',
          content: finalContent,
          timestamp: Date.now()
        })
        terminalStore.setAgentFinalResult(tabId, finalContent)
      }
      
      // 保存 Agent 记录
      saveAgentRecord(tabId, message, startTime, result.success ? 'completed' : 'failed', finalContent)
      
      // Agent 完成后自动总结关键信息并更新记忆（后台执行）
      summarizeAgentFindings(hostId).catch(e => {
        console.warn('[Agent] 总结记忆失败:', e)
      })
    } catch (error) {
      console.error('Agent 运行失败:', error)
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      
      // 检查是否是用户主动中止
      const isAborted = errorMessage.includes('用户中止') || errorMessage.includes('aborted')
      
      if (isAborted) {
        // 用户主动中止，不添加 final_result 步骤（后端已经添加了 error 步骤）
        // 只保存记录
        saveAgentRecord(tabId, message, startTime, 'aborted', '用户中止了 Agent 执行')
      } else {
        // 其他错误，添加 final_result 步骤
        finalContent = `❌ Agent 运行出错: ${errorMessage}`
        terminalStore.addAgentStep(tabId, {
          id: `final_result_${Date.now()}`,
          type: 'final_result',
          content: finalContent,
          timestamp: Date.now()
        })
        terminalStore.setAgentFinalResult(tabId, finalContent)
        
        // 保存失败的 Agent 记录
        saveAgentRecord(tabId, message, startTime, 'failed', finalContent)
      }
    } finally {
      // 无论成功还是失败，都确保重置 Agent 运行状态
      console.log('[Agent] finally block executing, resetting isRunning for tabId:', tabId)
      terminalStore.setAgentRunning(tabId, false)
      console.log('[Agent] setAgentRunning called, current agentState:', terminalStore.getAgentState(tabId))
    }

    // 完成后使用智能滚动
    await scrollToBottomIfNeeded()
  }

  // 中止 Agent
  const abortAgent = async () => {
    const agentId = agentState.value?.agentId
    if (!agentId) return

    try {
      await window.electronAPI.agent.abort(agentId)
    } catch (error) {
      console.error('中止 Agent 失败:', error)
    }
  }

  // 确认工具调用
  const confirmToolCall = async (approved: boolean) => {
    const confirm = pendingConfirm.value
    if (!confirm) return

    try {
      await window.electronAPI.agent.confirm(
        confirm.agentId,
        confirm.toolCallId,
        approved
      )
      // 清除待确认状态
      if (currentTabId.value) {
        terminalStore.setAgentPendingConfirm(currentTabId.value, undefined)
      }
    } catch (error) {
      console.error('确认工具调用失败:', error)
    }
  }

  // 发送 Agent 回复（用于用户点击选项快速回复）
  const sendAgentReply = async (message: string) => {
    if (!message.trim() || !currentTabId.value) return

    // 只有在 Agent 运行中才能发送回复
    if (!isAgentRunning.value || !agentState.value?.agentId) return

    // 直接发送到后端，不添加到 pendingSupplements（选项点击不需要显示等待状态）
    await window.electronAPI.agent.addMessage(agentState.value.agentId, message)
  }

  // 获取步骤类型的图标
  const getStepIcon = (type: AgentStep['type']): string => {
    switch (type) {
      case 'thinking': return '🤔'
      case 'tool_call': return '🔧'
      case 'tool_result': return '📋'
      case 'message': return '💬'
      case 'error': return '❌'
      case 'confirm': return '⚠️'
      case 'user_task': return '👤'
      case 'final_result': return '✅'
      case 'user_supplement': return '💡'
      case 'waiting': return '⏳'
      case 'asking': return '❓'
      case 'waiting_password': return '🔐'
      default: return '•'
    }
  }

  // 获取风险等级的颜色类
  const getRiskClass = (riskLevel?: string): string => {
    switch (riskLevel) {
      case 'safe': return 'risk-safe'
      case 'moderate': return 'risk-moderate'
      case 'dangerous': return 'risk-dangerous'
      case 'blocked': return 'risk-blocked'
      default: return ''
    }
  }

  // 设置 Agent 事件监听
  // 注意：每个 AiPanel 实例都会注册监听器，所以需要确保只处理属于自己 tab 的事件
  const setupAgentListeners = () => {
    // 先清理旧的监听器，防止热重载时重复注册
    cleanupAgentListeners()
    // 判断事件是否属于当前 tab（优先使用 ptyId 匹配，更可靠）
    const isEventForThisTab = (agentId: string, ptyId?: string): boolean => {
      // 优先使用 ptyId 匹配（最可靠，因为 ptyId 在启动前就已知）
      if (ptyId) {
        const foundTabId = terminalStore.findTabIdByPtyId(ptyId)
        if (foundTabId === currentTabId.value) {
          // 确保 agentId 关联已设置
          terminalStore.setAgentId(currentTabId.value, agentId)
          return true
        }
        return false
      }
      
      // 降级：使用 agentId 匹配（兼容旧逻辑）
      const foundTabId = terminalStore.findTabIdByAgentId(agentId)
      if (foundTabId) {
        return foundTabId === currentTabId.value
      }
      
      // 最后的降级：检查当前 tab 是否正在等待 Agent 启动
      // 注意：这种情况在多 tab 同时启动时可能不可靠
      const currentState = agentState.value
      if (currentState?.isRunning && !currentState.agentId) {
        terminalStore.setAgentId(currentTabId.value, agentId)
        return true
      }
      
      return false
    }
    
    // 监听步骤更新
    cleanupStepListener = window.electronAPI.agent.onStep((data: { agentId: string; ptyId?: string; step: AgentStep }) => {
      // 只处理属于当前 tab 的事件（使用 ptyId 可靠匹配）
      if (!isEventForThisTab(data.agentId, data.ptyId)) return
      
      const tabId = currentTabId.value
      terminalStore.addAgentStep(tabId, data.step)
      
      // 如果是用户补充消息步骤，从待处理列表中移除
      if (data.step.type === 'user_supplement') {
        const idx = pendingSupplements.value.indexOf(data.step.content)
        if (idx !== -1) {
          pendingSupplements.value.splice(idx, 1)
        }
      }
      
      // 使用智能滚动，不打断用户查看历史
      scrollToBottomIfNeeded()
    })

    // 监听需要确认
    cleanupConfirmListener = window.electronAPI.agent.onNeedConfirm((data) => {
      // 类型转换，添加 ptyId 支持
      const eventData = data as { agentId: string; ptyId?: string; toolCallId: string; toolName: string; toolArgs: Record<string, unknown>; riskLevel: string }
      // 只处理属于当前 tab 的事件（使用 ptyId 可靠匹配）
      if (!isEventForThisTab(eventData.agentId, eventData.ptyId)) return
      
      terminalStore.setAgentPendingConfirm(currentTabId.value, data)
      // 需要确认时强制滚动，确保用户看到确认框
      scrollToBottom()
    })

    // 监听完成
    cleanupCompleteListener = window.electronAPI.agent.onComplete((data: { agentId: string; ptyId?: string; result: string; pendingUserMessages?: string[] }) => {
      // 只处理属于当前 tab 的事件（优先使用 ptyId 匹配）
      if (data.ptyId) {
        const foundTabId = terminalStore.findTabIdByPtyId(data.ptyId)
        if (foundTabId !== currentTabId.value) return
      } else {
        const foundTabId = terminalStore.findTabIdByAgentId(data.agentId)
        if (foundTabId !== currentTabId.value) return
      }
      
      terminalStore.setAgentRunning(currentTabId.value, false)
      // 清空待处理的补充消息
      pendingSupplements.value = []
      
      // 如果有未处理的用户消息（用户在 Agent 总结时发送的），自动作为新任务启动
      if (data.pendingUserMessages && data.pendingUserMessages.length > 0) {
        const pendingMessage = data.pendingUserMessages.join('\n')
        console.log('[Agent] 发现未处理的用户消息，将作为新任务启动:', pendingMessage)
        // 延迟一点启动，让当前完成状态先更新到 UI
        setTimeout(() => {
          inputText.value = pendingMessage
          runAgent()
        }, 100)
      }
    })

    // 监听错误
    cleanupErrorListener = window.electronAPI.agent.onError((data: { agentId: string; ptyId?: string; error: string }) => {
      // 只处理属于当前 tab 的事件（优先使用 ptyId 匹配）
      if (data.ptyId) {
        const foundTabId = terminalStore.findTabIdByPtyId(data.ptyId)
        if (foundTabId !== currentTabId.value) return
      } else {
        const foundTabId = terminalStore.findTabIdByAgentId(data.agentId)
        if (foundTabId !== currentTabId.value) return
      }
      
      terminalStore.setAgentRunning(currentTabId.value, false)
      // 清空待处理的补充消息
      pendingSupplements.value = []
      terminalStore.addAgentStep(currentTabId.value, {
        id: `error_${Date.now()}`,
        type: 'error',
        content: data.error,
        timestamp: Date.now()
      })
    })
  }

  // 清理 Agent 事件监听
  const cleanupAgentListeners = () => {
    if (cleanupStepListener) {
      cleanupStepListener()
      cleanupStepListener = null
    }
    if (cleanupConfirmListener) {
      cleanupConfirmListener()
      cleanupConfirmListener = null
    }
    if (cleanupCompleteListener) {
      cleanupCompleteListener()
      cleanupCompleteListener = null
    }
    if (cleanupErrorListener) {
      cleanupErrorListener()
      cleanupErrorListener = null
    }
  }

  // 生命周期
  onMounted(() => {
    setupAgentListeners()
  })

  onUnmounted(() => {
    cleanupAgentListeners()
  })

  return {
    agentMode,
    executionMode,
    commandTimeout,
    collapsedTaskIds,
    pendingSupplements,
    agentState,
    isAgentRunning,
    pendingConfirm,
    agentUserTask,
    currentPlan,
    agentTaskGroups,
    toggleStepsCollapse,
    isStepsCollapsed,
    runAgent,
    abortAgent,
    confirmToolCall,
    sendAgentReply,
    getStepIcon,
    getRiskClass
  }
}
