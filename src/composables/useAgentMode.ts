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
}

export function useAgentMode(
  inputText: Ref<string>,
  scrollToBottom: () => Promise<void>,           // 强制滚动（用户发送时）
  scrollToBottomIfNeeded: () => Promise<void>,   // 智能滚动（收到新内容时）
  getDocumentContext: () => Promise<string>,
  getHostId: () => Promise<string>,
  autoProbeHostProfile: () => Promise<void>,
  summarizeAgentFindings: (hostId: string) => Promise<void>
) {
  const terminalStore = useTerminalStore()

  // Agent 模式状态
  const agentMode = ref(true)
  const strictMode = ref(true)       // 严格模式（默认开启）
  const commandTimeout = ref(10)     // 命令超时时间（秒），默认 10 秒
  const collapsedTaskIds = ref<Set<string>>(new Set())  // 已折叠的任务 ID
  const pendingSupplements = ref<string[]>([])  // 等待处理的补充消息

  // 清理事件监听的函数
  let cleanupStepListener: (() => void) | null = null
  let cleanupConfirmListener: (() => void) | null = null
  let cleanupCompleteListener: (() => void) | null = null
  let cleanupErrorListener: (() => void) | null = null

  // 当前终端 ID
  const currentTabId = computed(() => terminalStore.activeTabId)

  // Agent 状态
  const agentState = computed((): AgentState | undefined => {
    const activeTab = terminalStore.activeTab
    return activeTab?.agentState as AgentState | undefined
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

  // 监听严格模式变化，实时更新运行中的 Agent
  watch(strictMode, async (newValue) => {
    const agentId = agentState.value?.agentId
    if (agentId && isAgentRunning.value) {
      await window.electronAPI.agent.updateConfig(agentId, { strictMode: newValue })
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
    const activeTab = terminalStore.activeTab
    if (!activeTab) return null
    return {
      terminalId: activeTab.id,
      terminalType: activeTab.type as 'local' | 'ssh',
      sshHost: activeTab.sshConfig?.host
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

    // 获取主机 ID
    const hostId = await getHostId()

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
          documentContext   // 添加文档上下文
        } as { ptyId: string; terminalOutput: string[]; systemInfo: { os: string; shell: string }; hostId?: string; historyMessages?: { role: string; content: string }[]; documentContext?: string },
        { strictMode: strictMode.value, commandTimeout: commandTimeout.value * 1000 }  // 传递配置（超时时间转为毫秒）
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
  const setupAgentListeners = () => {
    // 监听步骤更新
    cleanupStepListener = window.electronAPI.agent.onStep((data) => {
      // 优先使用 agentId 查找对应的终端，如果找不到则使用当前终端
      const tabId = terminalStore.findTabIdByAgentId(data.agentId) || currentTabId.value
      if (tabId) {
        terminalStore.addAgentStep(tabId, data.step)
        // 只设置 agentId 用于关联，不改变 isRunning 状态
        // 因为 IPC 事件可能在 runAgent 的 finally 块之后到达
        terminalStore.setAgentId(tabId, data.agentId)
        
        // 如果是用户补充消息步骤，从待处理列表中移除
        if (data.step.type === 'user_supplement') {
          const idx = pendingSupplements.value.indexOf(data.step.content)
          if (idx !== -1) {
            pendingSupplements.value.splice(idx, 1)
          }
        }
        
        // 使用智能滚动，不打断用户查看历史
        scrollToBottomIfNeeded()
      }
    })

    // 监听需要确认
    cleanupConfirmListener = window.electronAPI.agent.onNeedConfirm((data) => {
      const tabId = terminalStore.findTabIdByAgentId(data.agentId) || currentTabId.value
      if (tabId) {
        terminalStore.setAgentPendingConfirm(tabId, data)
        // 需要确认时强制滚动，确保用户看到确认框
        scrollToBottom()
      }
    })

    // 监听完成
    cleanupCompleteListener = window.electronAPI.agent.onComplete((data) => {
      const tabId = terminalStore.findTabIdByAgentId(data.agentId) || currentTabId.value
      if (tabId) {
        terminalStore.setAgentRunning(tabId, false)
        // 清空待处理的补充消息
        pendingSupplements.value = []
      }
    })

    // 监听错误
    cleanupErrorListener = window.electronAPI.agent.onError((data) => {
      const tabId = terminalStore.findTabIdByAgentId(data.agentId) || currentTabId.value
      if (tabId) {
        terminalStore.setAgentRunning(tabId, false)
        // 清空待处理的补充消息
        pendingSupplements.value = []
        terminalStore.addAgentStep(tabId, {
          id: `error_${Date.now()}`,
          type: 'error',
          content: data.error,
          timestamp: Date.now()
        })
      }
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
    strictMode,
    commandTimeout,
    collapsedTaskIds,
    pendingSupplements,
    agentState,
    isAgentRunning,
    pendingConfirm,
    agentUserTask,
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
