/**
 * Agent 模式 composable
 * 处理 Agent 任务的运行、确认、事件监听等
 * 同时管理 AI 面板的滚动和终端状态
 */
import { ref, computed, watch, nextTick, onMounted, onUnmounted, Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTerminalStore } from '../stores/terminal'
import { useConfigStore } from '../stores/config'
import type { AgentStep, AgentState } from '../stores/terminal'
import { createLogger } from '../utils/logger'

const log = createLogger('Agent')

// 判断用户是否在底部附近的阈值（像素）
const SCROLL_THRESHOLD = 100
// 滚动节流间隔（毫秒）
const SCROLL_THROTTLE_MS = 1000

// Agent 任务分组类型
export interface AgentTaskGroup {
  id: string
  userTask: string
  images?: string[]  // 用户消息附带的图片（用于聊天中显示）
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

// AgentState 类型从 terminal store 导入

export function useAgentMode(
  messagesRef: Ref<HTMLDivElement | null>,
  getDocumentContext: () => Promise<string>,
  getHostIdByTabId: (tabId: string) => Promise<string>,  // 根据 tabId 获取 hostId（不依赖 activeTab）
  autoProbeHostProfile: () => Promise<void>,
  tabId: Ref<string>,  // 每个 AiPanel 实例固定绑定的 tab ID
  imageCallbacks?: {
    getImages: () => string[]      // 获取待发送的图片 data URL 列表
    clearImages: () => void        // 清空待发送的图片
  }
) {
  const { t } = useI18n()
  const terminalStore = useTerminalStore()
  const configStore = useConfigStore()

  // 当前终端 ID（使用传入的 tabId，不再依赖 activeTabId）
  const currentTabId = tabId

  // ==================== 输入和滚动状态 ====================
  
  // 输入文本
  const inputText = ref('')
  
  // 是否有新消息（用户不在底部时显示提示）
  const hasNewMessage = ref(false)
  
  // 标志：是否跳过 scroll 事件的状态更新（用于避免强制滚动时被 scroll 事件覆盖）
  let skipScrollUpdate = false
  
  // 智能滚动节流状态
  let scrollPending = false
  let lastScrollTime = 0

  // Agent 执行模式设置
  const executionMode = ref<'strict' | 'relaxed' | 'free'>('relaxed')  // 执行模式：strict=严格，relaxed=宽松，free=自由
  const commandTimeout = ref(10)     // 命令超时时间（秒），默认 10 秒
  const activeProfileId = ref<string>(configStore.activeAiProfileId || '')  // 当前终端选择的 AI 配置档案 ID（每个终端独立，初始值继承全局设置）
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

  // ==================== 终端状态 ====================
  
  // 当前终端的 AI 加载状态（每个终端独立）
  const isLoading = computed(() => {
    return currentTab.value?.aiLoading || false
  })

  // 获取当前终端的系统信息
  const currentSystemInfo = computed(() => {
    const tab = currentTab.value
    if (tab?.systemInfo) {
      return tab.systemInfo
    }
    return null
  })

  // 获取当前终端选中的文本
  const terminalSelectedText = computed(() => {
    return currentTab.value?.selectedText || ''
  })

  // 获取最近的错误
  const lastError = computed(() => {
    return currentTab.value?.lastError
  })

  // ==================== 滚动相关 ====================
  
  // 用户是否在底部附近（从 store 获取，每个终端独立）
  const isUserNearBottom = computed(() => {
    const id = currentTabId.value
    if (!id) return true
    return terminalStore.getAiScrollNearBottom(id)
  })

  // 设置当前 tab 的 isUserNearBottom 状态
  const setIsUserNearBottom = (value: boolean) => {
    const id = currentTabId.value
    if (id) {
      terminalStore.setAiScrollNearBottom(id, value)
    }
  }

  // 检查用户是否在底部附近
  const checkIsNearBottom = () => {
    if (!messagesRef.value) return true
    const { scrollTop, scrollHeight, clientHeight } = messagesRef.value
    return scrollHeight - scrollTop - clientHeight < SCROLL_THRESHOLD
  }

  // 更新用户滚动位置状态（由组件的 scroll 事件调用）
  const updateScrollPosition = () => {
    // 跳过强制滚动期间的状态更新，避免被 scroll 事件覆盖
    if (skipScrollUpdate) return
    const nearBottom = checkIsNearBottom()
    setIsUserNearBottom(nearBottom)
    // 如果用户滚动到底部，清除新消息提示
    if (nearBottom) {
      hasNewMessage.value = false
    }
  }

  // 强制滚动到底部（用户主动发送消息或点击时调用）
  const scrollToBottom = async () => {
    // 先设置状态，防止被 scroll 事件覆盖
    skipScrollUpdate = true
    setIsUserNearBottom(true)
    hasNewMessage.value = false
    
    await nextTick()
    if (messagesRef.value) {
      messagesRef.value.scrollTop = messagesRef.value.scrollHeight
    }
    
    // 延迟恢复 scroll 事件更新，确保滚动完成后才开始监听用户滚动
    requestAnimationFrame(() => {
      skipScrollUpdate = false
    })
  }

  // 实际执行滚动
  const doScrollIfNeeded = async () => {
    lastScrollTime = Date.now()
    await nextTick()
    
    // 在执行滚动前再次检测是否在底部附近
    // 这样可以避免内容突然增加导致的误判
    const nearBottomNow = checkIsNearBottom()
    
    if (isUserNearBottom.value || nearBottomNow) {
      if (messagesRef.value) {
        // 滚动期间跳过状态更新，避免 scroll 事件错误地更新状态
        skipScrollUpdate = true
        setIsUserNearBottom(true)
        hasNewMessage.value = false
        
        messagesRef.value.scrollTop = messagesRef.value.scrollHeight
        
        // 延迟恢复 scroll 事件监听，等待滚动完成
        // 使用 50ms 延迟，确保滚动动画完成，同时不影响用户后续手动滚动
        setTimeout(() => {
          skipScrollUpdate = false
        }, 50)
      }
    } else {
      // 用户在上方查看历史，显示新消息提示
      hasNewMessage.value = true
    }
  }

  // 智能滚动：只有用户在底部附近时才自动滚动（带节流）
  const scrollToBottomIfNeeded = async () => {
    const now = Date.now()
    
    // 节流：如果距离上次滚动时间过短，标记为待处理
    if (now - lastScrollTime < SCROLL_THROTTLE_MS) {
      if (!scrollPending) {
        scrollPending = true
        requestAnimationFrame(() => {
          scrollPending = false
          doScrollIfNeeded()
        })
      }
      return
    }
    
    await doScrollIfNeeded()
  }

  // 停止生成
  const stopGeneration = async () => {
    if (currentTabId.value) {
      // 传入 tabId 只中止当前终端的请求，不影响其他终端
      await window.electronAPI.ai.abort(currentTabId.value)
      terminalStore.setAiLoading(currentTabId.value, false)
    }
  }

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
    // 倒序查找最新的 plan 相关步骤
    for (let i = steps.length - 1; i >= 0; i--) {
      const step = steps[i]
      // 如果遇到 plan_archived，说明计划已被归档，当前无活跃计划
      if (step.type === 'plan_archived') {
        return undefined
      }
      // 如果遇到 plan_created 或 plan_updated 且有 plan 数据
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
    const context = terminalStore.getAgentContext(currentTabId.value)
    const promises: Promise<unknown>[] = []

    // 远程 tab：同步到 RemoteChatService（运行时覆盖，不持久化）
    // 无论 agent 是否正在运行都需要同步，确保下次 IM 消息到来时使用新模式
    if (currentTab.value?.isRemote) {
      promises.push(
        window.electronAPI.remoteChat.setExecutionMode(newValue).catch(err => {
          log.error('Failed to sync execution mode to RemoteChatService:', err)
        })
      )
    }

    // 同时更新当前运行中的 Agent 实例（对当前正在执行的任务立即生效）
    if (context?.ptyId && isAgentRunning.value) {
      promises.push(
        window.electronAPI.agent.updateConfig(context.ptyId, { executionMode: newValue })
      )
    }

    await Promise.all(promises)
  })

  // 监听超时设置变化
  watch(commandTimeout, async (newValue) => {
    const context = terminalStore.getAgentContext(currentTabId.value)
    if (context?.ptyId && isAgentRunning.value) {
      await window.electronAPI.agent.updateConfig(context.ptyId, { commandTimeout: newValue * 1000 })
    }
  })

  // 监听模型配置变化，实时同步到运行中的 Agent
  watch(activeProfileId, async (newValue) => {
    const context = terminalStore.getAgentContext(currentTabId.value)
    if (context?.ptyId && isAgentRunning.value && newValue) {
      await window.electronAPI.agent.updateConfig(context.ptyId, { profileId: newValue })
    }
  })

  // 按任务分组的步骤（每个任务包含：用户任务 + 步骤块 + 最终结果）
  const agentTaskGroups = computed((): AgentTaskGroup[] => {
    const allSteps = agentState.value?.steps || []
    const groups: AgentTaskGroup[] = []
    let currentGroup: AgentTaskGroup | null = null
    let orphanedStepCount = 0
    
    for (const step of allSteps) {
      if (step.type === 'user_task') {
        // 开始新任务
        currentGroup = {
          id: step.id,
          userTask: step.content,
          images: step.images,  // 附带的图片
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
        } else {
          orphanedStepCount++
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
    
    // 诊断日志：仅在远程 tab 且有变化时打印
    const tab = currentTab.value
    if (tab?.isRemote) {
      const stepTypes = allSteps.map(s => s.type)
      const userTaskCount = stepTypes.filter(t => t === 'user_task').length
      const finalResultCount = stepTypes.filter(t => t === 'final_result').length
      log.debug(`[Groups] tabId=${tab.id}, totalSteps=${allSteps.length}, groups=${groups.length}, userTasks=${userTaskCount}, finals=${finalResultCount}, orphaned=${orphanedStepCount}, stepTypes=[${stepTypes.join(',')}]`)
    }
    
    return groups
  })

  // 保存当前会话（供外部调用，如清空对话时）
  // 注意：会话历史现在由后端 Agent 在 finalizeRun 时自动保存到 HistoryService
  // 此方法保留接口但不再执行操作，避免前端重复保存
  const saveCurrentSession = () => {
    // 后端已在每次 run 结束时自动保存，无需前端再次保存
  }

  // 运行 Agent 或发送补充消息
  const runAgent = async () => {
    const hasImageData = (imageCallbacks?.getImages()?.length ?? 0) > 0
    if ((!inputText.value.trim() && !hasImageData) || !currentTabId.value) return

    const tabId = currentTabId.value
    const message = inputText.value

    // 如果 Agent 正在运行，发送补充消息而不是启动新任务
    const runningContext = terminalStore.getAgentContext(tabId)
    if (isAgentRunning.value && runningContext?.ptyId) {
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
      
      // 发送到后端（使用 ptyId）
      await window.electronAPI.agent.addMessage(runningContext.ptyId, message)
      return
    }

    const startTime = Date.now()  // 记录开始时间
    inputText.value = ''

    // 获取 Agent 上下文
    const context = terminalStore.getAgentContext(tabId)
    if (!context || !context.ptyId) {
      log.error('无法获取终端上下文')
      return
    }

    // 获取主机 ID（基于 tabId 而非 activeTab，防止用户在 Agent 执行期间切换标签导致 hostId 错误）
    const hostId = await getHostIdByTabId(tabId)

    // 首次运行时自动探测主机信息（后台执行，不阻塞）
    autoProbeHostProfile().catch(e => {
      log.warn('主机探测失败:', e)
    })

    // 准备新任务（保留之前的步骤）
    terminalStore.clearAgentState(tabId, true)
    
    // 如果是新会话（没有 sessionId），设置会话 ID 和开始时间
    if (!agentState.value?.sessionId) {
      terminalStore.setAgentSession(tabId, `session_${startTime}`, startTime)
    }
    
    // 获取文档上下文
    const documentContext = await getDocumentContext()
    
    // 获取待发送的图片（传给后端，后端生成 user_task 步骤时携带）
    const images = imageCallbacks?.getImages() || []

    // 清空待发送的图片
    if (images.length > 0) {
      imageCallbacks?.clearImages()
    }

    // 设置 Agent 状态：正在运行 + 用户任务
    terminalStore.setAgentRunning(tabId, true, undefined, message)
    await scrollToBottom()

    try {
      // 调用 Agent API
      // user_task 和 final_result 步骤由后端统一生成并通过 onStep 回调推送
      const result = await window.electronAPI.agent.run(
        context.ptyId,
        message,
        {
          ...context,
          hostId,
          sshHost: currentTab.value?.sshConfig?.host,
          documentContext,
          images: images.length > 0 ? images : undefined,
          sessionId: agentState.value?.sessionId,
          sessionStartTime: agentState.value?.sessionStartTime
        },
        { executionMode: executionMode.value, commandTimeout: commandTimeout.value * 1000 },
        activeProfileId.value || undefined
      )

      // 后端已通过 onStep 推送 final_result，这里只需设置 finalResult 状态
      if (!result.success) {
        const finalContent = result.aborted
          ? t('ai.taskAbortedMessage')
          : t('ai.agentExecutionFailed', { error: result.error })
        terminalStore.setAgentFinalResult(tabId, finalContent)
      } else if (result.result) {
        terminalStore.setAgentFinalResult(tabId, result.result)
      }
    } catch (error) {
      log.error('Agent 运行失败:', error)
      const errorMessage = error instanceof Error ? error.message : t('ai.unknownError')
      const finalContent = t('ai.agentRunError', { error: errorMessage })
      
      // IPC 层面的错误（如连接断开），后端可能没来得及推送 final_result
      // 检查后端是否已推送过 final_result，避免重复
      const currentSteps = agentState.value?.steps || []
      if (!currentSteps.some(s => s.type === 'final_result')) {
        terminalStore.addAgentStep(tabId, {
          id: `final_result_${Date.now()}`,
          type: 'final_result',
          content: finalContent,
          timestamp: Date.now()
        })
      }
      terminalStore.setAgentFinalResult(tabId, finalContent)
    } finally {
      terminalStore.setAgentRunning(tabId, false)
    }

    // 完成后使用智能滚动
    await scrollToBottomIfNeeded()
  }

  // 中止 Agent（使用 ptyId）
  const abortAgent = async () => {
    const context = terminalStore.getAgentContext(currentTabId.value)
    if (!context?.ptyId) return

    try {
      await window.electronAPI.agent.abort(context.ptyId)
    } catch (error) {
      log.error('中止 Agent 失败:', error)
    }
  }

  // 确认工具调用（使用 ptyId）
  // alwaysAllow: 如果为 true，将该工具+参数加入会话白名单，后续自动跳过确认
  const confirmToolCall = async (approved: boolean, alwaysAllow?: boolean) => {
    const confirm = pendingConfirm.value
    if (!confirm) return

    const context = terminalStore.getAgentContext(currentTabId.value)
    if (!context?.ptyId) return

    try {
      await window.electronAPI.agent.confirm({
        ptyId: context.ptyId,
        toolCallId: confirm.toolCallId,
        approved,
        modifiedArgs: undefined,
        alwaysAllow
      })
      // 清除待确认状态
      if (currentTabId.value) {
        terminalStore.setAgentPendingConfirm(currentTabId.value, undefined)
      }
    } catch (error) {
      log.error('确认工具调用失败:', error)
    }
  }

  // 发送 Agent 回复（用于用户点击选项快速回复，使用 ptyId）
  const sendAgentReply = async (message: string) => {
    if (!message.trim() || !currentTabId.value) return

    // 只有在 Agent 运行中才能发送回复
    const context = terminalStore.getAgentContext(currentTabId.value)
    if (!isAgentRunning.value || !context?.ptyId) return

    // 直接发送到后端，不添加到 pendingSupplements（选项点击不需要显示等待状态）
    await window.electronAPI.agent.addMessage(context.ptyId, message)
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
      case 'plan_created': return '📋'
      case 'plan_updated': return '📋'
      case 'plan_archived': return '📦'
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
        log.info('发现未处理的用户消息，将作为新任务启动:', pendingMessage)
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

  // ==================== 历史对话功能 ====================
  
  // 历史记录类型定义
  interface AgentRecord {
    id: string
    timestamp: number
    terminalId: string
    terminalType: 'local' | 'ssh'
    sshHost?: string
    userTask: string
    steps: Array<{
      id: string
      type: string
      content: string
      toolName?: string
      toolArgs?: Record<string, unknown>
      toolResult?: string
      riskLevel?: string
      timestamp: number
    }>
    finalResult?: string
    duration: number
    status: 'completed' | 'failed' | 'aborted'
  }

  // 近期历史记录（用于欢迎页展示）
  const recentHistory = ref<AgentRecord[]>([])
  const isLoadingHistory = ref(false)
  
  // 查看更多弹窗状态
  const showHistoryModal = ref(false)
  const allHistory = ref<AgentRecord[]>([])
  const isLoadingAllHistory = ref(false)

  // 加载近期历史（最近 5 条，用于欢迎页）
  const loadRecentHistory = async () => {
    if (isLoadingHistory.value) return
    isLoadingHistory.value = true
    try {
      const records = await window.electronAPI.history.getAgentRecords() as AgentRecord[]
      // 按时间倒序，取最近 5 条
      recentHistory.value = records
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 5)
    } catch (e) {
      log.error('加载历史记录失败:', e)
    } finally {
      isLoadingHistory.value = false
    }
  }

  // 加载全部历史（用于弹窗）
  const loadAllHistory = async () => {
    if (isLoadingAllHistory.value) return
    isLoadingAllHistory.value = true
    try {
      const records = await window.electronAPI.history.getAgentRecords() as AgentRecord[]
      // 按时间倒序排列
      allHistory.value = records.sort((a, b) => b.timestamp - a.timestamp)
    } catch (e) {
      log.error('加载全部历史记录失败:', e)
    } finally {
      isLoadingAllHistory.value = false
    }
  }

  // 打开历史弹窗
  const openHistoryModal = async () => {
    showHistoryModal.value = true
    await loadAllHistory()
  }

  // 关闭历史弹窗
  const closeHistoryModal = () => {
    showHistoryModal.value = false
  }

  // 加载历史记录到当前会话
  const loadHistoryRecord = (record: AgentRecord) => {
    terminalStore.restoreAgentHistory(currentTabId.value, record)
    // 关闭弹窗（如果是从弹窗中选择的）
    closeHistoryModal()
  }

  // 检查是否有现有对话（用于确认是否覆盖）
  const hasExistingConversation = computed(() => {
    const steps = agentState.value?.steps || []
    return steps.length > 0
  })

  // 格式化历史时间
  const formatHistoryTime = (timestamp: number): string => {
    const date = new Date(timestamp)
    const now = new Date()
    const isToday = date.toDateString() === now.toDateString()
    
    if (isToday) {
      return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    } else {
      return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    }
  }

  // 远程 tab：从 IM 持久化配置加载执行模式
  const loadRemoteExecutionMode = async () => {
    if (!currentTab.value?.isRemote) return
    try {
      const config = await window.electronAPI.im.getConfig()
      if (config.executionMode && ['strict', 'relaxed', 'free'].includes(config.executionMode)) {
        executionMode.value = config.executionMode
      }
    } catch (err) {
      log.warn('Failed to load remote execution mode, using default:', err)
    }
  }

  // 生命周期
  onMounted(() => {
    setupAgentListeners()
    // 加载近期历史（用于欢迎页展示）
    loadRecentHistory()
    // 远程 tab 从 IM 配置加载执行模式
    loadRemoteExecutionMode()
  })

  onUnmounted(() => {
    cleanupAgentListeners()
  })

  return {
    // 输入和终端状态
    inputText,
    isLoading,
    currentSystemInfo,
    terminalSelectedText,
    lastError,
    // 滚动相关
    hasNewMessage,
    isUserNearBottom,
    updateScrollPosition,
    scrollToBottom,
    scrollToBottomIfNeeded,
    stopGeneration,
    // Agent 执行
    executionMode,
    commandTimeout,
    activeProfileId,
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
    getRiskClass,
    // 历史对话功能
    recentHistory,
    isLoadingHistory,
    showHistoryModal,
    allHistory,
    isLoadingAllHistory,
    loadRecentHistory,
    loadAllHistory,
    openHistoryModal,
    closeHistoryModal,
    loadHistoryRecord,
    hasExistingConversation,
    formatHistoryTime,
    saveCurrentSession  // 保存当前会话（清空对话时调用）
  }
}
