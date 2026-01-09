<script setup lang="ts">
/**
 * AI 面板组件
 * 重构版本：使用 composables 模块化管理逻辑
 * 每个 tab 独立实例，通过 tabId prop 绑定
 */
import { ref, computed, watch, inject, onMounted, onUnmounted, toRef, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { Upload, Trash2, X, HelpCircle, ChevronDown, Copy, Paperclip, Square, ArrowUp, Check } from 'lucide-vue-next'
import { useConfigStore } from '../stores/config'
import { useTerminalStore } from '../stores/terminal'
import AgentPlanView from './AgentPlanView.vue'

// 导入 composables
import {
  useMarkdown,
  useDocumentUpload,
  useContextStats,
  useHostProfile,
  useAiChat,
  useAgentMode,
  useMentions
} from '../composables'

// Props - 每个 AiPanel 实例绑定到特定的 tab
const props = defineProps<{
  tabId: string
  visible?: boolean  // 面板是否可见
}>()

// Emits
const emit = defineEmits<{
  close: []
}>()

// i18n
const { t } = useI18n()

// Stores
const configStore = useConfigStore()
const terminalStore = useTerminalStore()
const showSettings = inject<() => void>('showSettings')

// Refs
const messagesRef = ref<HTMLDivElement | null>(null)

// Plan 展开状态
const planExpanded = ref(false)

// 步骤中的计划展开状态（用于查看归档的计划）
const expandedPlanSteps = ref<Set<string>>(new Set())
const togglePlanExpand = (stepId: string) => {
  if (expandedPlanSteps.value.has(stepId)) {
    expandedPlanSteps.value.delete(stepId)
  } else {
    expandedPlanSteps.value.add(stepId)
  }
}

// 保存每个模式的滚动位置（用于模式切换时恢复）
const scrollPositions = ref<{ agent: number; chat: number }>({ agent: 0, chat: 0 })

// ==================== 初始化 Composables ====================

// 当前终端 ID（使用 prop，每个实例固定绑定一个 tab）
const currentTabId = toRef(props, 'tabId')

// 文档上传（传入 currentTabId，每个终端独立管理文档）
const {
  uploadedDocs,
  isUploadingDocs,
  isDraggingOver,
  selectAndUploadDocs,
  handleDroppedFiles,
  removeUploadedDoc,
  clearUploadedDocs,
  formatFileSize,
  getDocumentContext
} = useDocumentUpload(currentTabId)

// Markdown 渲染
const {
  renderMarkdown,
  handleCodeBlockClick,
  copyMessage
} = useMarkdown()

// AI 对话（注意：这里的 currentTabId 来自上面定义的 computed）
const {
  inputText,
  messages,
  isLoading,
  currentSystemInfo,
  terminalSelectedText,
  lastError,
  // 滚动相关
  hasNewMessage,
  updateScrollPosition,
  scrollToBottom,
  scrollToBottomIfNeeded,
  // 其他方法
  sendMessage,
  stopGeneration,
  diagnoseError,
  analyzeSelection,
  analyzeTerminalContent,
  quickActions
} = useAiChat(getDocumentContext, messagesRef, currentTabId)

// 主机档案
const {
  currentHostProfile,
  isLoadingProfile,
  isProbing,
  getHostIdByTabId,
  loadHostProfile,
  refreshHostProfile,
  autoProbeHostProfile
} = useHostProfile()

// @ 命令（提及）
const {
  showMenu: showMentionMenu,
  menuType: mentionMenuType,
  suggestions: mentionSuggestions,
  selectedIndex: mentionSelectedIndex,
  isLoading: isMentionLoading,
  hasMore: mentionHasMore,
  totalCount: mentionTotalCount,
  currentDir: mentionCurrentDir,
  detectTrigger,
  selectSuggestion: doSelectSuggestion,
  clearMentions,
  closeMenu: closeMentionMenu,
  goBack: mentionGoBack,
  handleKeyDown: handleMentionKeyDown,
  expandMentions
} = useMentions(inputText, currentTabId, uploadedDocs)

// 输入框引用（用于选择后重新聚焦）
const mentionInputRef = ref<HTMLTextAreaElement | null>(null)

// 监听面板可见性变化，当面板显示时聚焦输入框
watch(() => props.visible, (isVisible) => {
  if (isVisible) {
    nextTick(() => {
      mentionInputRef.value?.focus()
    })
  }
}, { immediate: true })

// 选择建议并重新聚焦输入框
const selectSuggestion = (suggestion: typeof mentionSuggestions.value[0]) => {
  doSelectSuggestion(suggestion)
  // 延迟聚焦，确保 DOM 更新完成
  nextTick(() => {
    mentionInputRef.value?.focus()
  })
}

// @ 命令补全列表引用（用于滚动）
const mentionListRef = ref<HTMLDivElement | null>(null)


// 监听选中项变化，自动滚动到可见区域
watch(mentionSelectedIndex, (newIndex) => {
  nextTick(() => {
    if (!mentionListRef.value) return
    const items = mentionListRef.value.querySelectorAll('.mention-item')
    const selectedItem = items[newIndex] as HTMLElement
    if (selectedItem) {
      selectedItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  })
})


// Agent 模式
const {
  agentMode,
  executionMode,
  commandTimeout,
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
  openHistoryModal,
  closeHistoryModal,
  loadHistoryRecord,
  hasExistingConversation,
  formatHistoryTime,
  saveCurrentSession
} = useAgentMode(
  inputText,
  scrollToBottom,
  scrollToBottomIfNeeded,
  getDocumentContext,
  getHostIdByTabId,
  autoProbeHostProfile,
  currentTabId
)

// 上下文统计
const {
  contextStats
} = useContextStats(
  agentMode,
  messages,
  agentState,
  agentUserTask,
  computed(() => configStore.activeAiProfile)
)

// ==================== 配置相关 ====================

const hasAiConfig = computed(() => configStore.hasAiConfig)
const aiProfiles = computed(() => configStore.aiProfiles)
const activeAiProfile = computed(() => configStore.activeAiProfile)

// 切换 AI 配置
const changeAiProfile = async (profileId: string) => {
  await configStore.setActiveAiProfile(profileId)
}

// ==================== 历史对话相关 ====================

// 截断文本
const truncateText = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength) + '...'
}

// 加载历史记录（带确认）
const handleLoadHistory = (record: { id: string; timestamp: number; terminalId: string; terminalType: 'local' | 'ssh'; sshHost?: string; userTask: string; steps: Array<{ id: string; type: string; content: string; toolName?: string; toolArgs?: Record<string, unknown>; toolResult?: string; riskLevel?: string; timestamp: number }>; finalResult?: string; duration: number; status: 'completed' | 'failed' | 'aborted' }) => {
  // 如果当前有活跃的任务（用户任务不为空），需要确认
  // 注意：如果欢迎页显示（agentUserTask 为空），说明没有活跃任务，不需要确认
  if (agentUserTask.value && hasExistingConversation.value) {
    if (!window.confirm(t('ai.agentWelcome.confirmLoadHistory'))) {
      return
    }
  }
  loadHistoryRecord(record)
  // 滚动到底部查看加载的历史
  scrollToBottom()
}

// ==================== 消息清空 ====================

// 清空对话确认框状态
const showClearConfirm = ref(false)

// 请求清空对话（如果 Agent 正在执行，需要用户确认）
const requestClearMessages = () => {
  if (isAgentRunning.value) {
    // Agent 正在执行，需要确认
    showClearConfirm.value = true
  } else {
    // Agent 未运行，直接清空
    doClearMessages()
  }
}

// 确认清空对话（先停止 Agent，再清空）
const confirmClearMessages = async () => {
  showClearConfirm.value = false
  
  // 如果 Agent 正在执行，先停止它
  if (isAgentRunning.value) {
    await abortAgent()
  }
  
  // 然后清空对话
  doClearMessages()
}

// 取消清空对话
const cancelClearMessages = () => {
  showClearConfirm.value = false
}

// 执行清空对话（包括 Agent 状态和历史）
const doClearMessages = () => {
  if (currentTabId.value) {
    // 在清空之前，保存当前会话到历史记录（会话级保存）
    if (agentMode.value) {
      saveCurrentSession()
    }
    terminalStore.clearAiMessages(currentTabId.value)
    terminalStore.clearAgentState(currentTabId.value, false)  // 不保留历史
  }
  // 清空上传的文档
  clearUploadedDocs()
  // 清空待处理的补充消息
  pendingSupplements.value = []
}

// 兼容旧的 clearMessages（现在改为 requestClearMessages）
const clearMessages = requestClearMessages

// ==================== 确认框辅助函数 ====================

// 工具名称映射
const getToolDisplayName = (toolName: string) => {
  const key = `ai.toolNames.${toolName}`
  const translated = t(key)
  return translated !== key ? translated : toolName
}

// 格式化确认参数显示（简化显示）
const formatConfirmArgs = (confirm: typeof pendingConfirm.value) => {
  if (!confirm) return ''
  const args = confirm.toolArgs
  // 对于命令执行，只显示命令本身
  if (args.command) {
    return args.command as string
  }
  // 对于文件操作，显示路径
  if (args.path) {
    return args.path as string
  }
  // 其他情况显示 JSON
  return JSON.stringify(args, null, 2)
}

// 检查任务组是否正在流式输出或等待中（不需要显示"AI 正在思考中"）
const isStreamingOutput = (group: typeof agentTaskGroups.value[0]) => {
  if (group.steps.length === 0) return false
  const lastStep = group.steps[group.steps.length - 1]
  // 如果最后一个步骤是 message 类型且正在流式输出，或者最后一个步骤是 message 类型且有内容
  // 说明 AI 已经开始返回内容了，不需要显示"思考中"
  if (lastStep.type === 'message' && (lastStep.isStreaming || lastStep.content.length > 0)) {
    return true
  }
  // 如果最后一个步骤是 waiting、asking 或 waiting_password 类型，也不需要显示"思考中"
  if (lastStep.type === 'waiting' || lastStep.type === 'asking' || lastStep.type === 'waiting_password') {
    return true
  }
  return false
}

// ==================== 发送消息 ====================

// IME 组合输入状态
const isComposing = ref(false)

// 自由模式确认输入框状态
const showFreeModeConfirm = ref(false)
const freeModeConfirmInput = ref('')
const freeModeConfirmInputRef = ref<HTMLInputElement | null>(null)

// 获取当前语言的确认词
const freeModeConfirmWord = computed(() => t('ai.freeModeConfirmWord'))

// 请求启用自由模式（显示确认输入框）
const requestFreeMode = () => {
  showFreeModeConfirm.value = true
  freeModeConfirmInput.value = ''
  // 自动聚焦输入框
  nextTick(() => {
    freeModeConfirmInputRef.value?.focus()
  })
}

// 确认启用自由模式
const confirmEnableFreeMode = () => {
  if (freeModeConfirmInput.value === freeModeConfirmWord.value) {
    executionMode.value = 'free'
    showFreeModeConfirm.value = false
    freeModeConfirmInput.value = ''
  }
}

// 取消启用自由模式
const cancelFreeMode = () => {
  showFreeModeConfirm.value = false
  freeModeConfirmInput.value = ''
}

// 切换到严格模式
const switchToStrictMode = () => {
  executionMode.value = 'strict'
}

// 切换到宽松模式
const switchToRelaxedMode = () => {
  executionMode.value = 'relaxed'
}

// 点击中的选项（用于即时视觉反馈，单选时使用）
const clickingOption = ref<string | null>(null)

// 多选已选中的选项（stepId -> 已选选项数组）
const multiSelectOptions = ref<Map<string, string[]>>(new Map())

// 获取步骤的已选选项
const getSelectedOptions = (stepId: string): string[] => {
  return multiSelectOptions.value.get(stepId) || []
}

// 切换多选选项
const toggleMultiOption = (stepId: string, opt: string) => {
  const current = multiSelectOptions.value.get(stepId) || []
  const idx = current.indexOf(opt)
  if (idx === -1) {
    current.push(opt)
  } else {
    current.splice(idx, 1)
  }
  multiSelectOptions.value.set(stepId, [...current])
}

// 确认多选结果
const confirmMultiSelect = (stepId: string) => {
  const selected = multiSelectOptions.value.get(stepId) || []
  if (selected.length === 0) return
  // 发送 JSON 数组格式
  sendAgentReply(JSON.stringify(selected))
  // 清理本地状态
  multiSelectOptions.value.delete(stepId)
}

// 处理选项点击（添加即时视觉反馈）
const handleOptionClick = (stepId: string, opt: string, allowMultiple: boolean) => {
  if (allowMultiple) {
    // 多选：切换选中状态
    toggleMultiOption(stepId, opt)
  } else {
    // 单选：直接发送
    clickingOption.value = opt
    sendAgentReply(opt)
  }
}

// 检查是否有等待回复的 asking 步骤（用于判断是否可以按回车发送默认值）
const waitingAskStep = computed(() => {
  for (const group of agentTaskGroups.value) {
    if (group.isCurrentTask) {
      for (const step of group.steps) {
        if (step.type === 'asking' && step.toolResult?.includes('⏳')) {
          return step
        }
      }
    }
  }
  return null
})

// 是否可以发送空消息（有等待的提问且有默认值或选项）
const canSendEmpty = computed(() => {
  const step = waitingAskStep.value
  if (!step) return false
  return !!step.toolArgs?.default_value
})

// 自动调整 textarea 高度
const adjustTextareaHeight = () => {
  const textarea = mentionInputRef.value
  if (!textarea) return
  
  // 重置高度以获取正确的 scrollHeight
  textarea.style.height = 'auto'
  // 设置为内容高度，但不超过最大高度 (CSS 中限制了 max-height)
  textarea.style.height = `${textarea.scrollHeight}px`
}

// 处理输入事件（检测 @ 触发）
const handleInputChange = (event: Event) => {
  const textarea = event.target as HTMLTextAreaElement
  const cursorPos = textarea.selectionStart || 0
  detectTrigger(inputText.value, cursorPos)
  // 调整高度
  adjustTextareaHeight()
}

// 监听 inputText 变化（包括程序性修改）
watch(inputText, () => {
  nextTick(adjustTextareaHeight)
})

// 处理失焦事件（延迟关闭菜单，以便点击菜单项时不会被 blur 打断）
const handleInputBlur = () => {
  setTimeout(() => closeMentionMenu(), 150)
}

// 处理键盘事件（@ 补全菜单导航）
const handleInputKeyDown = (event: KeyboardEvent) => {
  // 如果 @ 补全菜单打开，优先处理菜单导航
  if (showMentionMenu.value) {
    const handled = handleMentionKeyDown(event)
    if (handled) return
  }
  
  // 回车发送（非 IME 组合输入状态）
  if (event.key === 'Enter' && !event.shiftKey && !isComposing.value) {
    event.preventDefault()
    handleSend()
  }
}

// 发送消息（根据模式选择普通对话或 Agent）
const handleSend = async () => {
  // 如果正在 IME 组合输入（如中文输入法选词），不发送
  if (isComposing.value) return
  
  // 用户有操作时，清除错误提示
  if (currentTabId.value) {
    terminalStore.clearError(currentTabId.value)
  }
  
  // 关闭 @ 补全菜单
  closeMentionMenu()
  
  // 如果输入为空且有等待的提问有默认值，发送空消息让后端使用默认值
  if (!inputText.value.trim() && canSendEmpty.value && isAgentRunning.value && agentState.value?.agentId) {
    window.electronAPI.agent.addMessage(agentState.value.agentId, '')
    return
  }
  
  // 展开 @ 引用，获取引用内容
  const { contextParts } = await expandMentions(inputText.value)
  
  // 如果有 @ 引用的内容，将展开的内容追加到消息末尾
  // 这样 AI 可以看到完整的引用内容
  if (contextParts.length > 0) {
    const mentionContext = contextParts.join('\n\n')
    // 在原始消息后追加引用内容
    inputText.value = inputText.value + '\n\n' + mentionContext
  }
  
  // 清空已选择的 @ 引用
  clearMentions()
  
  if (agentMode.value) {
    runAgent()
  } else {
    sendMessage()
  }
}

// ==================== 右键菜单监听 ====================

// 监听右键菜单发送到 AI 的文本
watch(() => terminalStore.pendingAiText, (text) => {
  if (text) {
    agentMode.value = false  // 切换到对话界面
    analyzeTerminalContent(text)
    terminalStore.clearPendingAiText()
  }
}, { immediate: true })

// 监听模式切换，保存和恢复滚动位置
watch(agentMode, async (newMode, oldMode) => {
  if (!messagesRef.value || oldMode === undefined) return
  
  // 保存当前模式的滚动位置
  const currentScrollTop = messagesRef.value.scrollTop
  if (oldMode) {
    scrollPositions.value.agent = currentScrollTop
  } else {
    scrollPositions.value.chat = currentScrollTop
  }
  
  // 等待 DOM 更新后恢复目标模式的滚动位置
  await nextTick()
  if (messagesRef.value) {
    const targetScrollTop = newMode ? scrollPositions.value.agent : scrollPositions.value.chat
    messagesRef.value.scrollTop = targetScrollTop
  }
})

// ==================== 诊断和分析（包装函数） ====================

// 包装诊断错误函数
const handleDiagnoseError = () => {
  diagnoseError(agentMode)
}

// 包装分析选中内容函数
const handleAnalyzeSelection = () => {
  analyzeSelection(agentMode)
}

// ==================== 拖放处理 ====================

// 拖放进入
const handleDragEnter = (e: DragEvent) => {
  e.preventDefault()
  e.stopPropagation()
  // 检查是否有文件
  if (e.dataTransfer?.types.includes('Files')) {
    isDraggingOver.value = true
  }
}

// 拖放悬停
const handleDragOver = (e: DragEvent) => {
  e.preventDefault()
  e.stopPropagation()
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'copy'
  }
}

// 拖放离开
const handleDragLeave = (e: DragEvent) => {
  e.preventDefault()
  e.stopPropagation()
  // 检查是否真的离开了容器（而不是进入子元素）
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const x = e.clientX
  const y = e.clientY
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
    isDraggingOver.value = false
  }
}

// 拖放放下
const handleDrop = async (e: DragEvent) => {
  e.preventDefault()
  e.stopPropagation()
  isDraggingOver.value = false
  
  const files = e.dataTransfer?.files
  if (files && files.length > 0) {
    await handleDroppedFiles(files)
  }
}

// ==================== 键盘事件处理 ====================

const handleKeyDown = (e: KeyboardEvent) => {
  // ESC 键关闭弹窗
  if (e.key === 'Escape') {
    if (showHistoryModal.value) {
      e.preventDefault()
      closeHistoryModal()
    }
  }
}

// ==================== 生命周期 ====================

onMounted(() => {
  // 加载主机档案
  loadHostProfile()
  // 注册键盘事件
  document.addEventListener('keydown', handleKeyDown)
})

onUnmounted(() => {
  // 清理键盘事件
  document.removeEventListener('keydown', handleKeyDown)
})
</script>

<template>
  <div 
    class="ai-panel"
    :class="{
      'mode-strict': agentMode && executionMode === 'strict',
      'mode-relaxed': agentMode && executionMode === 'relaxed',
      'mode-free': agentMode && executionMode === 'free'
    }"
    @dragenter="handleDragEnter"
    @dragover="handleDragOver"
    @dragleave="handleDragLeave"
    @drop="handleDrop"
  >
    <!-- 拖放提示覆盖层 -->
    <div v-if="isDraggingOver" class="drop-overlay">
      <div class="drop-content">
        <Upload :size="48" :stroke-width="1.5" />
        <p>{{ t('ai.dropToUpload') }}</p>
        <span class="drop-hint">{{ t('ai.dropHint') }}</span>
      </div>
    </div>

    <div class="ai-header">
      <h3>{{ t('ai.assistant') }}</h3>
      <div class="ai-header-actions">
        <!-- 模型选择 -->
        <select 
          v-if="aiProfiles.length > 0"
          class="model-select"
          :value="activeAiProfile?.id || ''"
          :title="t('ai.switchModel')"
          @change="changeAiProfile(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="profile in aiProfiles" :key="profile.id" :value="profile.id">
            {{ profile.name }} ({{ profile.model }})
          </option>
        </select>
        <button class="btn-icon" @click="clearMessages" :title="t('ai.clearChat')">
          <Trash2 :size="16" />
        </button>
        <button class="btn-icon" @click="emit('close')" :title="t('ai.closePanel')">
          <X :size="16" />
        </button>
      </div>
    </div>

    <!-- 未配置 AI 提示 -->
    <div v-if="!hasAiConfig" class="ai-no-config">
      <HelpCircle :size="48" :stroke-width="1.5" />
      <p>{{ t('ai.noConfig') }}</p>
      <button class="btn btn-primary btn-sm" @click="showSettings?.()">
        {{ t('ai.goToSettings') }}
      </button>
    </div>

    <template v-else>
      <!-- 模式切换 -->
      <div class="mode-switcher">
        <button 
          class="mode-btn" 
          :class="{ active: agentMode, 'needs-attention': !agentMode && pendingConfirm }"
          :title="!agentMode && pendingConfirm ? t('ai.pendingConfirmHint') : t('ai.agentModeTitle')"
          @click="agentMode = true"
        >
          🤖 {{ t('ai.modeAgent') }}
          <span v-if="!agentMode && pendingConfirm" class="attention-badge">!</span>
        </button>
        <button 
          class="mode-btn" 
          :class="{ active: !agentMode }"
          :title="t('ai.chatModeTitle')"
          @click="agentMode = false"
        >
          💬 {{ t('ai.modeChat') }}
        </button>
      </div>

      <!-- 自由模式确认对话框 -->
      <div v-if="showFreeModeConfirm" class="free-mode-confirm-overlay">
        <div class="free-mode-confirm-dialog">
          <div class="confirm-dialog-header">
            <span class="confirm-dialog-icon">⚠️</span>
            <span class="confirm-dialog-title">{{ t('ai.freeModeConfirmTitle') }}</span>
          </div>
          <div class="confirm-dialog-content">
            <p>{{ t('ai.freeModeConfirmDesc') }}</p>
            <ul class="confirm-dialog-warnings">
              <li>{{ t('ai.freeModeWarning1') }}</li>
              <li>{{ t('ai.freeModeWarning2') }}</li>
              <li>{{ t('ai.freeModeWarning3') }}</li>
            </ul>
            <p class="confirm-dialog-instruction">{{ t('ai.freeModeConfirmInstruction', { word: freeModeConfirmWord }) }}</p>
            <input 
              ref="freeModeConfirmInputRef"
              type="text" 
              v-model="freeModeConfirmInput"
              class="confirm-dialog-input"
              :placeholder="t('ai.freeModeConfirmPlaceholder', { word: freeModeConfirmWord })"
              @keydown.enter="confirmEnableFreeMode"
              @keydown.esc="cancelFreeMode"
            />
          </div>
          <div class="confirm-dialog-actions">
            <button class="btn btn-sm btn-outline" @click="cancelFreeMode">
              {{ t('common.cancel') }}
            </button>
            <button 
              class="btn btn-sm btn-danger" 
              :disabled="freeModeConfirmInput !== freeModeConfirmWord"
              @click="confirmEnableFreeMode"
            >
              {{ t('ai.enableFreeMode') }}
            </button>
          </div>
        </div>
      </div>

      <!-- 清空对话确认对话框（Agent 执行中） -->
      <div v-if="showClearConfirm" class="free-mode-confirm-overlay">
        <div class="free-mode-confirm-dialog clear-confirm-dialog">
          <div class="confirm-dialog-header">
            <span class="confirm-dialog-icon">⚠️</span>
            <span class="confirm-dialog-title">{{ t('ai.clearConfirmTitle') }}</span>
          </div>
          <div class="confirm-dialog-content">
            <p>{{ t('ai.clearConfirmDesc') }}</p>
            <ul class="confirm-dialog-warnings">
              <li>{{ t('ai.clearConfirmWarning1') }}</li>
              <li>{{ t('ai.clearConfirmWarning2') }}</li>
            </ul>
          </div>
          <div class="confirm-dialog-actions">
            <button class="btn btn-sm btn-outline" @click="cancelClearMessages">
              {{ t('common.cancel') }}
            </button>
            <button class="btn btn-sm btn-danger" @click="confirmClearMessages">
              {{ t('ai.clearConfirmButton') }}
            </button>
          </div>
        </div>
      </div>

      <!-- 系统环境信息 + Agent 设置 -->
      <div class="system-info-bar">
        <div v-if="currentSystemInfo" class="system-info-left host-info-trigger">
          <span class="system-icon">💻</span>
          <span class="system-text">
            {{ currentSystemInfo.os === 'windows' ? 'Windows' : currentSystemInfo.os === 'macos' ? 'macOS' : 'Linux' }}
            · {{ currentSystemInfo.shell === 'powershell' ? 'PowerShell' : currentSystemInfo.shell === 'cmd' ? 'CMD' : currentSystemInfo.shell === 'bash' ? 'Bash' : currentSystemInfo.shell === 'zsh' ? 'Zsh' : currentSystemInfo.shell }}
          </span>
          <span class="hover-hint">▾</span>
          
          <!-- 悬浮主机信息面板 -->
          <div class="host-info-popover">
            <div class="popover-header">
              <span>🖥️ {{ t('ai.agentWelcome.hostInfo') }}</span>
              <button 
                class="refresh-btn" 
                @click.stop="refreshHostProfile" 
                :disabled="isProbing"
                :title="isProbing ? t('ai.agentWelcome.probing') : t('ai.agentWelcome.refreshHost')"
              >
                <span :class="{ spinning: isProbing }">🔄</span>
              </button>
            </div>
            <div v-if="currentHostProfile" class="popover-content">
              <div class="info-row">
                <span class="info-label">{{ t('ai.agentWelcome.hostname') }}:</span>
                <span class="info-value">{{ currentHostProfile.hostname || t('common.unknown') }}</span>
                <span v-if="currentHostProfile.username" class="info-secondary">@ {{ currentHostProfile.username }}</span>
              </div>
              <div v-if="currentHostProfile.osVersion || currentHostProfile.os" class="info-row">
                <span class="info-label">{{ t('ai.agentWelcome.system') }}:</span>
                <span class="info-value">{{ currentHostProfile.osVersion || currentHostProfile.os }}</span>
              </div>
              <div v-if="currentHostProfile.shell" class="info-row">
                <span class="info-label">{{ t('ai.agentWelcome.shell') }}:</span>
                <span class="info-value">{{ currentHostProfile.shell }}</span>
                <span v-if="currentHostProfile.packageManager" class="info-secondary">| {{ currentHostProfile.packageManager }}</span>
              </div>
              <div v-if="currentHostProfile.installedTools?.length" class="info-row tools-row">
                <span class="info-label">{{ t('ai.agentWelcome.tools') }}:</span>
                <span class="info-value tools-list">{{ currentHostProfile.installedTools.join(', ') }}</span>
              </div>
            </div>
            <div v-else-if="isLoadingProfile" class="popover-loading">
              {{ t('common.loading') }}
            </div>
            <div v-else class="popover-empty">
              {{ t('ai.agentWelcome.notProbed') }}
            </div>
          </div>
        </div>
        <!-- Agent 模式设置 -->
        <div v-if="agentMode" class="agent-settings">
          <!-- 超时设置 -->
          <div class="timeout-setting" :title="t('ai.timeout')">
            <span class="timeout-label">{{ t('ai.timeout') }}</span>
            <select v-model.number="commandTimeout" class="timeout-select">
              <option :value="5">5s</option>
              <option :value="10">10s</option>
              <option :value="30">30s</option>
              <option :value="60">60s</option>
              <option :value="120">2m</option>
              <option :value="300">5m</option>
            </select>
          </div>
          <!-- 执行模式选择器（三选一：严格/宽松/自由） -->
          <div class="execution-mode-selector">
            <button 
              class="mode-option" 
              :class="{ active: executionMode === 'strict' }"
              @click="switchToStrictMode"
              :title="t('ai.strictModeTitle')"
            >
              {{ t('ai.strict') }}
            </button>
            <button 
              class="mode-option" 
              :class="{ active: executionMode === 'relaxed' }"
              @click="switchToRelaxedMode"
              :title="t('ai.relaxedModeTitle')"
            >
              {{ t('ai.relaxed') }}
            </button>
            <button 
              class="mode-option mode-option-free" 
              :class="{ active: executionMode === 'free' }"
              @click="executionMode === 'free' ? switchToStrictMode() : requestFreeMode()"
              :title="t('ai.freeModeTitle')"
            >
              {{ t('ai.free') }}
            </button>
          </div>
        </div>
      </div>

      <!-- 错误诊断提示（Agent 执行时隐藏） -->
      <div v-if="lastError && !isAgentRunning" class="error-alert">
        <div class="error-alert-icon">⚠️</div>
        <div class="error-alert-content">
          <div class="error-alert-title">{{ t('ai.errorDetected') }}</div>
          <div class="error-alert-text">{{ lastError.content.slice(0, 80) }}{{ lastError.content.length > 80 ? '...' : '' }}</div>
        </div>
        <button class="error-alert-btn" @click="handleDiagnoseError" :disabled="isLoading">
          {{ t('ai.aiDiagnose') }}
        </button>
        <button class="error-alert-close" @click="terminalStore.clearError(currentTabId)" :title="t('ai.closeError')">
          <X :size="14" />
        </button>
      </div>

      <!-- 终端选中内容提示（Agent 执行时隐藏） -->
      <div v-if="terminalSelectedText && !lastError && !isAgentRunning" class="selection-alert">
        <div class="selection-alert-icon">📋</div>
        <div class="selection-alert-content">
          <div class="selection-alert-title">{{ t('ai.selectedContent') }}</div>
          <div class="selection-alert-text">{{ terminalSelectedText.slice(0, 60) }}{{ terminalSelectedText.length > 60 ? '...' : '' }}</div>
        </div>
        <button class="selection-alert-btn" @click="handleAnalyzeSelection" :disabled="isLoading">
          {{ t('ai.aiAnalyze') }}
        </button>
      </div>

      <!-- 快捷操作（仅对话模式且无对话内容时显示） -->
      <div v-if="!agentMode && messages.length === 0" class="quick-actions">
        <button
          v-for="action in quickActions"
          :key="action.label"
          class="quick-action-btn"
          @click="action.action"
        >
          <span class="action-icon">{{ action.icon }}</span>
          <span>{{ action.label }}</span>
        </button>
      </div>

      <!-- Plan 固定顶部区域 -->
      <div v-if="currentPlan && agentMode" class="plan-sticky-header">
        <AgentPlanView 
          :plan="currentPlan" 
          :compact="!planExpanded" 
          @toggle="planExpanded = !planExpanded" 
        />
      </div>

      <!-- 消息列表 -->
      <div ref="messagesRef" class="ai-messages" @click="handleCodeBlockClick" @scroll="updateScrollPosition">
        <div v-if="messages.length === 0 && !agentMode" class="ai-welcome">
          <p>👋 {{ t('ai.welcome.greeting') }}</p>
          <p class="welcome-section-title">💬 {{ t('ai.welcome.directChat') }}</p>
          <p class="welcome-desc">{{ t('ai.welcome.directChatDesc') }}</p>
          
          <p class="welcome-section-title">🚀 {{ t('ai.welcome.quickFeatures') }}</p>
          <ul>
            <li><strong>{{ t('ai.welcome.explainCommand') }}</strong> - {{ t('ai.welcome.explainCommandDesc') }}</li>
            <li><strong>{{ t('ai.welcome.errorDiagnose') }}</strong> - {{ t('ai.welcome.errorDiagnoseDesc') }}</li>
            <li><strong>{{ t('ai.welcome.generateCommand') }}</strong> - {{ t('ai.welcome.generateCommandDesc') }}</li>
            <li><strong>{{ t('ai.welcome.analyzeOutput') }}</strong> - {{ t('ai.welcome.analyzeOutputDesc') }}</li>
          </ul>

          <p class="welcome-section-title">✨ {{ t('ai.welcome.usageTips') }}</p>
          <ul>
            <li>{{ t('ai.welcome.tip1') }}</li>
            <li>{{ t('ai.welcome.tip2') }}</li>
            <li>{{ t('ai.welcome.tip3') }}</li>
            <li>{{ t('ai.welcome.tip4') }}</li>
          </ul>
        </div>
        <div v-if="agentMode && !agentUserTask" class="ai-welcome">
          <p>🤖 {{ t('ai.agentWelcome.enabled') }}</p>

          <p class="welcome-section-title">💡 {{ t('ai.agentWelcome.whatIsAgent') }}</p>
          <p class="welcome-desc">{{ t('ai.agentWelcome.agentDesc') }}</p>
          
          <p class="welcome-section-title">🎯 {{ t('ai.agentWelcome.examples') }}</p>
          <ul>
            <li>{{ t('ai.agentWelcome.example1') }}</li>
            <li>{{ t('ai.agentWelcome.example2') }}</li>
            <li>{{ t('ai.agentWelcome.example3') }}</li>
            <li>{{ t('ai.agentWelcome.example4') }}</li>
          </ul>

          <p class="welcome-section-title">
            <template v-if="executionMode === 'free'">🔥 {{ t('ai.agentWelcome.freeMode') }} <span class="strict-badge free">{{ t('ai.agentWelcome.freeModeOn') }}</span></template>
            <template v-else-if="executionMode === 'strict'">🔒 {{ t('ai.agentWelcome.strictMode') }} <span class="strict-badge">{{ t('ai.agentWelcome.strictModeOn') }}</span></template>
            <template v-else>🔓 {{ t('ai.agentWelcome.relaxedMode') }} <span class="strict-badge relaxed">{{ t('ai.agentWelcome.relaxedModeOn') }}</span></template>
          </p>
          <ul>
            <li v-if="executionMode === 'free'"><strong class="warning-text">{{ t('ai.agentWelcome.freeModeDesc1') }}</strong></li>
            <li v-if="executionMode === 'free'">{{ t('ai.agentWelcome.freeModeDesc2') }}</li>
            <li v-if="executionMode === 'strict'"><strong>{{ t('ai.agentWelcome.strictModeDesc1') }}</strong></li>
            <li v-if="executionMode === 'strict'">{{ t('ai.agentWelcome.strictModeDesc2') }}</li>
            <li v-if="executionMode === 'relaxed'"><strong>{{ t('ai.agentWelcome.relaxedModeDesc1') }}</strong></li>
            <li v-if="executionMode === 'relaxed'">{{ t('ai.agentWelcome.relaxedModeDesc2') }}</li>
            <li>{{ t('ai.agentWelcome.allCommandsVisible') }}</li>
          </ul>

          <p class="welcome-section-title">⚠️ {{ t('ai.agentWelcome.cautions') }}</p>
          <ul>
            <li>{{ t('ai.agentWelcome.caution1') }}</li>
            <li>{{ t('ai.agentWelcome.caution2') }}</li>
          </ul>

          <!-- 最近对话历史 -->
          <div class="recent-history-section">
            <p class="welcome-section-title">📜 {{ t('ai.agentWelcome.recentHistory') }}</p>
            
            <div v-if="isLoadingHistory" class="history-loading">
              {{ t('ai.agentWelcome.historyLoading') }}
            </div>
            
            <div v-else-if="recentHistory.length === 0" class="history-empty">
              {{ t('ai.agentWelcome.noRecentHistory') }}
            </div>
            
            <div v-else class="history-list">
              <div 
                v-for="record in recentHistory" 
                :key="record.id" 
                class="history-card"
                @click="handleLoadHistory(record)"
              >
                <span class="history-status-icon" :class="record.status">
                  {{ record.status === 'completed' ? '✓' : record.status === 'failed' ? '✗' : '!' }}
                </span>
                <span class="history-task">{{ truncateText(record.userTask, 50) }}</span>
                <span class="history-meta">
                  <span v-if="record.terminalType === 'ssh'" class="history-ssh">{{ record.sshHost }}</span>
                  <span class="history-time">{{ formatHistoryTime(record.timestamp) }}</span>
                </span>
              </div>
            </div>
            
            <button 
              v-if="recentHistory.length > 0" 
              class="view-more-btn"
              @click="openHistoryModal"
            >
              {{ t('ai.agentWelcome.viewMoreHistory') }}
            </button>
          </div>
        </div>

        <!-- 历史对话弹窗 -->
        <div v-if="showHistoryModal" class="history-modal-overlay" @click.self="closeHistoryModal">
          <div class="history-modal">
            <div class="history-modal-header">
              <h3>📜 {{ t('ai.agentWelcome.recentHistory') }}</h3>
              <button class="history-modal-close" @click="closeHistoryModal">×</button>
            </div>
            <div class="history-modal-body">
              <div v-if="isLoadingAllHistory" class="history-loading">
                {{ t('ai.agentWelcome.historyLoading') }}
              </div>
              <div v-else-if="allHistory.length === 0" class="history-empty">
                {{ t('ai.agentWelcome.noRecentHistory') }}
              </div>
              <div v-else class="history-modal-list">
                <div 
                  v-for="record in allHistory" 
                  :key="record.id" 
                  class="history-card"
                  @click="handleLoadHistory(record)"
                >
                  <span class="history-status-icon" :class="record.status">
                    {{ record.status === 'completed' ? '✓' : record.status === 'failed' ? '✗' : '!' }}
                  </span>
                  <span class="history-task">{{ truncateText(record.userTask, 80) }}</span>
                  <span class="history-meta">
                    <span v-if="record.terminalType === 'ssh'" class="history-ssh">{{ record.sshHost }}</span>
                    <span class="history-time">{{ formatHistoryTime(record.timestamp) }}</span>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <!-- 普通对话模式的消息 -->
        <template v-if="!agentMode">
        <div
          v-for="msg in messages"
          :key="msg.id"
          class="message"
          :class="msg.role"
        >
          <div class="message-wrapper">
            <div class="message-content">
              <div v-if="msg.role === 'assistant'" v-html="renderMarkdown(msg.content)" class="markdown-content"></div>
              <span v-else>{{ msg.content }}</span>
            </div>
            <button
              v-if="msg.role === 'assistant' && msg.content && !msg.content.includes('中...')"
              class="copy-btn"
              @click="copyMessage(msg.content)"
              :title="t('common.copy')"
            >
              <Copy :size="14" />
            </button>
            </div>
          </div>
        </template>

        <!-- Agent 任务列表（每个任务：用户任务 + 步骤块 + 最终结果） -->
        <template v-if="agentMode && agentTaskGroups.length > 0">
          <template v-for="group in agentTaskGroups" :key="group.id">
            <!-- 用户任务 -->
            <div class="message user">
              <div class="message-wrapper">
                <div class="message-content">
                  <span>{{ group.userTask }}</span>
                </div>
              </div>
            </div>
            
            <!-- Agent 初始加载提示（刚启动还没有步骤时） -->
            <div v-if="group.isCurrentTask && isAgentRunning && group.steps.length === 0" class="message assistant">
              <div class="message-wrapper">
                <div class="message-content agent-initial-loading">
                  <div class="agent-thinking-indicator">
                    <span class="thinking-spinner"></span>
                    <span class="thinking-text">{{ t('ai.agentStarting') }}</span>
                  </div>
                </div>
              </div>
            </div>
            
            <!-- 执行步骤（折叠块） -->
            <div v-if="group.steps.length > 0" class="message assistant">
              <div class="message-wrapper agent-steps-wrapper">
                <div class="message-content agent-steps-content">
                  <div class="agent-steps-header-inline" @click="toggleStepsCollapse(group.id)">
                    <span>🤖 {{ group.isCurrentTask && isAgentRunning ? t('ai.agentRunning') : t('ai.agentHistory') }}</span>
                    <span v-if="group.isCurrentTask && isAgentRunning" class="agent-running-dot"></span>
                    <span class="steps-count">{{ group.steps.length }} {{ t('ai.steps') }}</span>
                    <span class="collapse-icon" :class="{ collapsed: isStepsCollapsed(group.id) }">▼</span>
                  </div>
                  <div v-show="!isStepsCollapsed(group.id)" class="agent-steps-body">
                    <div 
                      v-for="step in group.steps" 
                      :key="step.id" 
                      class="agent-step-inline"
                      :class="[step.type, getRiskClass(step.riskLevel), { 'step-rejected': step.content.includes('拒绝') }]"
                    >
                      <span class="step-icon">{{ getStepIcon(step.type) }}</span>
                      <div class="step-content">
                        <div 
                          v-if="step.type === 'message'" 
                          class="step-text step-analysis markdown-content"
                          :class="{ 'is-streaming': step.isStreaming }"
                          v-html="renderMarkdown(step.content)"
                        ></div>
                        <!-- 提问类型特殊渲染：显示问题、选项按钮、状态 -->
                        <div v-else-if="step.type === 'asking'" class="step-text asking-content">
                          <div class="asking-question">{{ step.content }}</div>
                          <!-- 默认值提示 -->
                          <div v-if="step.toolArgs?.default_value" class="asking-default">
                            <span class="default-label">{{ t('ai.askingDefault') }}</span>{{ step.toolArgs.default_value }}
                            <span v-if="step.toolResult?.includes('⏳')" class="default-hint">{{ t('ai.askingDefaultHint') }}</span>
                          </div>
                          <!-- 可点击的选项按钮 -->
                          <div v-if="step.toolArgs?.options && (step.toolArgs.options as string[]).length > 0" class="asking-options">
                            <button 
                              v-for="(opt, idx) in (step.toolArgs.options as string[]).slice(0, 10)" 
                              :key="idx"
                              class="asking-option-btn"
                              :class="{ 
                                'selected': step.toolResult?.includes(opt) || getSelectedOptions(step.id).includes(opt),
                                'clicking': clickingOption === opt && step.toolResult?.includes('⏳') && !step.toolArgs?.allow_multiple
                              }"
                              :disabled="!isAgentRunning || step.toolResult?.includes('✅') || step.toolResult?.includes('⏰') || step.toolResult?.includes('🛑')"
                              @click="handleOptionClick(step.id, opt, !!step.toolArgs?.allow_multiple)"
                            >
                              <span class="option-label">{{ String.fromCharCode(65 + idx) }}</span>
                              {{ opt }}
                            </button>
                            <!-- 多选确认按钮 -->
                            <button 
                              v-if="step.toolArgs?.allow_multiple && step.toolResult?.includes('⏳')"
                              class="asking-confirm-btn"
                              :disabled="getSelectedOptions(step.id).length === 0"
                              @click="confirmMultiSelect(step.id)"
                            >
                              {{ t('ai.confirmMultiSelect') }} ({{ getSelectedOptions(step.id).length }})
                            </button>
                          </div>
                          <!-- 状态显示：等待、超时、取消时显示完整状态；已完成时不重复显示选中的选项 -->
                          <div v-if="step.toolResult && !step.toolResult.includes('✅')" class="asking-status" :class="{ 
                            'status-waiting': step.toolResult.includes('⏳'),
                            'status-timeout': step.toolResult.includes('⏰'),
                            'status-cancelled': step.toolResult.includes('🛑')
                          }">
                            {{ step.toolResult }}
                          </div>
                        </div>
                        <!-- 计划类型特殊渲染：可展开查看计划详情 -->
                        <div v-else-if="step.type === 'plan_created' || step.type === 'plan_updated' || step.type === 'plan_archived'" class="step-text plan-step-content">
                          <div class="plan-step-header" @click="togglePlanExpand(step.id)">
                            <span class="plan-step-text">{{ step.content }}</span>
                            <span class="plan-expand-icon" :class="{ expanded: expandedPlanSteps.has(step.id) }">▶</span>
                          </div>
                          <!-- 展开的计划详情 -->
                          <div v-if="expandedPlanSteps.has(step.id) && step.plan" class="plan-step-details">
                            <AgentPlanView :plan="step.plan" :compact="false" />
                          </div>
                        </div>
                        <div v-else class="step-text">
                          {{ step.content }}
                        </div>
                        <div v-if="step.toolResult && step.toolResult !== '已拒绝' && step.type !== 'asking'" class="step-result">
                          <pre>{{ step.toolResult }}</pre>
                        </div>
                      </div>
                    </div>
                    <!-- AI 思考中指示器（当 Agent 运行中且没有流式输出时显示） -->
                    <div 
                      v-if="group.isCurrentTask && isAgentRunning && !pendingConfirm && !isStreamingOutput(group)"
                      class="agent-thinking-indicator"
                    >
                      <span class="thinking-spinner"></span>
                      <span class="thinking-text">{{ t('ai.thinking') }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            
            <!-- 最终结果 -->
            <div v-if="group.finalResult" class="message assistant">
              <div class="message-wrapper agent-final-wrapper">
                <div class="message-content agent-final-content" :class="{ 'is-error': group.finalResult.startsWith('❌'), 'is-aborted': group.finalResult.startsWith('⚠️') }">
                  <div class="agent-final-header">
                    <span class="final-icon">{{ group.finalResult.startsWith('❌') ? '❌' : group.finalResult.startsWith('⚠️') ? '⚠️' : '✅' }}</span>
                    <span class="final-title">{{ group.finalResult.startsWith('❌') ? t('ai.taskFailed') : group.finalResult.startsWith('⚠️') ? t('ai.taskAborted') : t('ai.taskComplete') }}</span>
                  </div>
                  <div class="agent-final-body markdown-content" v-html="renderMarkdown(group.finalResult.replace(/^[❌✅⚠️]\s*(Agent\s*(执行失败|运行出错)[:\s]*)?/, ''))"></div>
                </div>
              </div>
            </div>
          </template>
        </template>

        <!-- 等待处理的补充消息 -->
        <template v-if="isAgentRunning && pendingSupplements.length > 0">
          <div 
            v-for="(supplement, idx) in pendingSupplements" 
            :key="`pending_${idx}`" 
            class="message assistant"
          >
            <div class="message-wrapper">
              <div class="message-content pending-supplement">
                <div class="pending-supplement-header">
                  <span class="pending-icon">💡</span>
                  <span class="pending-label">{{ t('ai.supplementInfo') }}（{{ t('ai.pendingProcess') }}）</span>
                  <span class="pending-spinner"></span>
                </div>
                <div class="pending-supplement-content">{{ supplement }}</div>
              </div>
            </div>
          </div>
        </template>

        <!-- Agent 确认对话框（融入对话流，只在 Agent 模式下显示） -->
        <div v-if="agentMode && pendingConfirm" class="message assistant">
          <div class="message-wrapper">
            <div class="message-content agent-confirm-inline" :class="getRiskClass(pendingConfirm.riskLevel)">
              <div class="confirm-header-inline">
                <span class="confirm-icon">{{ pendingConfirm.riskLevel === 'dangerous' ? '🔴' : (pendingConfirm.riskLevel === 'moderate' ? '🟡' : '🟢') }}</span>
                <span class="confirm-title">{{ t('ai.needConfirm') }}</span>
                <span class="confirm-risk-badge" :class="getRiskClass(pendingConfirm.riskLevel)">
                  {{ pendingConfirm.riskLevel === 'dangerous' ? t('ai.highRisk') : (pendingConfirm.riskLevel === 'moderate' ? t('ai.mediumRisk') : t('ai.lowRisk')) }}
                </span>
              </div>
              <div class="confirm-detail">
                <div class="confirm-tool-name">{{ getToolDisplayName(pendingConfirm.toolName) }}</div>
                <pre class="confirm-args-inline">{{ formatConfirmArgs(pendingConfirm) }}</pre>
              </div>
              <div class="confirm-actions-inline">
                <button class="btn btn-sm btn-outline-secondary" @click="confirmToolCall(false)">
                  {{ t('ai.reject') }}
                </button>
                <button 
                  class="btn btn-sm" 
                  :class="pendingConfirm.riskLevel === 'dangerous' ? 'btn-outline-danger' : (pendingConfirm.riskLevel === 'moderate' ? 'btn-outline-warning' : 'btn-outline-success')"
                  @click="confirmToolCall(true, true)"
                  :title="t('ai.alwaysAllowHint')"
                >
                  {{ t('ai.alwaysAllow') }}
                </button>
                <button 
                  class="btn btn-sm" 
                  :class="pendingConfirm.riskLevel === 'dangerous' ? 'btn-danger' : (pendingConfirm.riskLevel === 'moderate' ? 'btn-warning' : 'btn-success')"
                  @click="confirmToolCall(true)"
                >
                  {{ t('ai.allowExecute') }}
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- 新消息指示器 -->
        <div v-if="hasNewMessage" class="new-message-indicator" @click="scrollToBottom" :title="t('ai.newMessage')">
          <ChevronDown :size="14" />
          <span>{{ t('ai.newMessage') }}</span>
        </div>
      </div>


      <!-- 已上传文档列表 -->
      <div v-if="uploadedDocs.length > 0" class="uploaded-docs">
        <div class="uploaded-docs-header">
          <span class="uploaded-docs-title">📎 {{ t('ai.uploadedDocs') }} ({{ uploadedDocs.length }})</span>
          <button class="btn-clear-docs" @click="clearUploadedDocs" :title="t('ai.clearDocs')">
            <X :size="12" />
          </button>
        </div>
        <div class="uploaded-docs-list">
          <div 
            v-for="(doc, index) in uploadedDocs" 
            :key="index" 
            class="uploaded-doc-item"
            :class="{ 'has-error': doc.error }"
          >
            <span class="doc-icon">{{ doc.fileType === 'pdf' ? '📕' : doc.fileType === 'docx' || doc.fileType === 'doc' ? '📘' : '📄' }}</span>
            <span class="doc-name" :title="doc.filename">{{ doc.filename }}</span>
            <span class="doc-size">{{ formatFileSize(doc.fileSize) }}</span>
            <span v-if="doc.error" class="doc-error" :data-tooltip="doc.error">⚠️</span>
            <button class="btn-remove-doc" @click="removeUploadedDoc(index)" :title="t('ai.removeDoc')">
              <X :size="10" />
            </button>
          </div>
        </div>
      </div>

      <!-- @ 引用已在输入框中显示，不需要额外的标签列表 -->

      <!-- 输入区域 -->
      <div class="ai-input">
        <!-- 上下文使用量迷你指示器 -->
        <div 
          v-if="messages.length > 0 || (agentMode && agentUserTask)" 
          class="context-mini"
        >
          <div 
            class="context-mini-bar"
            :class="{ 
              'warning': contextStats.percentage > 60, 
              'danger': contextStats.percentage > 85 
            }"
            :style="{ width: contextStats.percentage + '%' }"
          ></div>
          <span class="context-mini-tip">
            {{ t('ai.context') }}: ~{{ contextStats.tokenEstimate.toLocaleString() }} / {{ (contextStats.maxTokens / 1000).toFixed(0) }}K ({{ contextStats.percentage }}%)
          </span>
        </div>
        <div class="input-container">
          <!-- 上传按钮 -->
          <button 
            class="upload-btn" 
            @click="() => selectAndUploadDocs()" 
            :disabled="isUploadingDocs"
            :title="t('ai.uploadDocument')"
          >
            <Paperclip v-if="!isUploadingDocs" :size="18" />
            <span v-else class="upload-spinner"></span>
          </button>
          <textarea
            ref="mentionInputRef"
            v-model="inputText"
            :placeholder="isAgentRunning ? t('ai.inputPlaceholderSupplement') : (agentMode ? t('ai.inputPlaceholderAgent') : t('ai.inputPlaceholder'))"
            rows="1"
            @input="handleInputChange"
            @keydown="handleInputKeyDown"
            @compositionstart="isComposing = true"
            @compositionend="isComposing = false"
            @blur="handleInputBlur"
          ></textarea>
          
          <!-- @ 命令补全菜单 -->
          <div v-if="showMentionMenu" class="mention-menu">
            <div v-if="mentionMenuType === null" class="mention-menu-header">
              {{ t('mentions.selectCommand') }}
            </div>
            <div v-else class="mention-menu-header">
              <span v-if="mentionMenuType === 'file'">📄 {{ t('mentions.file') }}</span>
              <span v-else-if="mentionMenuType === 'docs'">📚 {{ t('mentions.docs') }}</span>
              <span v-if="mentionCurrentDir" class="mention-path" :title="mentionCurrentDir">{{ mentionCurrentDir }}</span>
            </div>
            <div v-if="isMentionLoading" class="mention-loading">
              <span class="mention-spinner"></span>
              {{ t('common.loading') }}
            </div>
            <div v-else-if="mentionSuggestions.length === 0" class="mention-empty">
              {{ t('mentions.noResults') }}
            </div>
            <div v-else ref="mentionListRef" class="mention-list">
              <div 
                v-for="(suggestion, index) in mentionSuggestions"
                :key="suggestion.id"
                class="mention-item"
                :class="{ active: index === mentionSelectedIndex }"
                @mousedown.prevent="selectSuggestion(suggestion)"
                @mouseenter="mentionSelectedIndex = index"
              >
                <span class="mention-icon">{{ suggestion.icon }}</span>
                <div class="mention-content">
                  <span class="mention-label">{{ suggestion.label }}</span>
                  <span v-if="suggestion.description" class="mention-desc">{{ suggestion.description }}</span>
                </div>
              </div>
              <!-- 更多提示 -->
              <div v-if="mentionHasMore" class="mention-more">
                {{ t('mentions.moreItems', { count: mentionTotalCount - 50 }) }}
              </div>
            </div>
            <div class="mention-hint">
              <span v-if="mentionMenuType !== null" class="mention-back-btn" @mousedown.prevent="mentionGoBack(); mentionInputRef?.focus()">← {{ t('mentions.back') }}</span>
              <span class="mention-hint-keys">
                <span>↑↓</span> {{ t('mentions.navigate') }}
                <span>Tab/Enter</span> {{ t('mentions.select') }}
                <span>Esc</span> {{ t('mentions.close') }}
              </span>
            </div>
          </div>
          <!-- 停止按钮 (普通对话模式) -->
          <button
            v-if="isLoading && !agentMode"
            class="btn btn-danger stop-btn"
            @click="stopGeneration"
            :title="t('ai.stopGeneration')"
          >
            <Square :size="16" fill="currentColor" />
          </button>
          <!-- Agent 运行中：有输入显示补充按钮，有默认值提问时显示使用默认值按钮，否则显示停止按钮 -->
          <button
            v-else-if="isAgentRunning && inputText.trim()"
            class="send-btn send-btn-supplement"
            :title="t('ai.sendSupplement')"
            @click="handleSend"
          >
            <ArrowUp :size="18" />
          </button>
          <button
            v-else-if="isAgentRunning && canSendEmpty"
            class="send-btn send-btn-default"
            :title="t('ai.useDefault')"
            @click="handleSend"
          >
            <Check :size="18" />
          </button>
          <button
            v-else-if="isAgentRunning"
            class="btn btn-danger stop-btn"
            @click="abortAgent"
            :title="t('ai.stopAgent')"
          >
            <Square :size="16" fill="currentColor" />
          </button>
          <!-- 发送按钮 -->
          <button
            v-else
            class="send-btn"
            :class="{ 'send-btn-agent': agentMode }"
            :disabled="!inputText.trim()"
            :title="agentMode ? t('ai.executeTask') : t('ai.sendMessage')"
            @click="handleSend"
          >
            <ArrowUp :size="18" />
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ai-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  position: relative;
  /* 入场动画 */
  animation: panelEnter 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes panelEnter {
  from {
    opacity: 0;
    transform: translateX(10px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

/* 拖放覆盖层 */
.drop-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 150, 255, 0.15);
  backdrop-filter: blur(4px);
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 3px dashed var(--accent-primary);
  border-radius: 8px;
  animation: dropOverlayFadeIn 0.2s ease;
}

@keyframes dropOverlayFadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.drop-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--accent-primary);
  text-align: center;
  padding: 24px;
  background: var(--bg-primary);
  border-radius: 12px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
}

.drop-content svg {
  animation: dropIconBounce 0.5s ease infinite alternate;
}

@keyframes dropIconBounce {
  from {
    transform: translateY(0);
  }
  to {
    transform: translateY(-8px);
  }
}

.drop-content p {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}

.drop-hint {
  font-size: 12px;
  color: var(--text-muted);
}

.ai-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-color);
  position: relative;
  animation: headerEnter 0.4s cubic-bezier(0.16, 1, 0.3, 1) 0.1s both;
}

@keyframes headerEnter {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 深色主题：头部底部微光 */
[data-color-scheme="dark"] .ai-header::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(var(--accent-secondary-rgb, 116, 199, 236), 0.15), transparent);
}

.ai-header h3 {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 6px;
}

.ai-header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.ai-header-actions .btn-icon {
  width: 28px;
  height: 28px;
  padding: 6px;
  border-radius: 6px;
}

.model-select {
  padding: 4px 8px;
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  cursor: pointer;
  max-width: 160px;
  outline: none;
}

.model-select:hover {
  border-color: var(--accent-primary);
}

.model-select:focus {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 2px rgba(0, 150, 255, 0.2);
}

.ai-no-config {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 20px;
  color: var(--text-muted);
  text-align: center;
}

.system-info-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border-color);
  font-size: 11px;
  color: var(--text-muted);
}

.system-info-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.system-icon {
  font-size: 12px;
}

.system-text {
  font-family: var(--font-mono);
}

/* 主机信息悬浮触发器 */
.host-info-trigger {
  position: relative;
  cursor: pointer;
  padding: 2px 6px;
  margin: -2px -6px;
  border-radius: 6px;
  transition: all 0.2s ease;
}

.host-info-trigger:hover {
  background: var(--bg-surface);
  color: var(--text-primary);
}

.hover-hint {
  font-size: 8px;
  opacity: 0.5;
  margin-left: 2px;
  transition: all 0.2s ease;
}

.host-info-trigger:hover .hover-hint {
  opacity: 1;
  transform: translateY(1px);
}

/* 悬浮面板 */
.host-info-popover {
  position: absolute;
  top: calc(100% + 4px);
  left: 8px;
  min-width: 380px;
  max-width: 380px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.25);
  z-index: 100;
  opacity: 0;
  visibility: hidden;
  transform: translateY(-5px);
  transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}

/* 添加透明连接区域，让鼠标能顺利移动到面板 */
.host-info-popover::after {
  content: '';
  position: absolute;
  top: -10px;
  left: 0;
  right: 0;
  height: 10px;
}

.host-info-trigger:hover .host-info-popover,
.host-info-popover:hover {
  opacity: 1;
  visibility: visible;
  transform: translateY(0);
}

/* 面板箭头 */
.host-info-popover::before {
  content: '';
  position: absolute;
  top: -6px;
  left: 28px;
  width: 12px;
  height: 12px;
  background: var(--bg-secondary);
  border-left: 1px solid var(--border-color);
  border-top: 1px solid var(--border-color);
  transform: rotate(45deg);
}

.popover-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-color);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.refresh-btn {
  padding: 4px 6px;
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.2s ease;
}

.refresh-btn:hover:not(:disabled) {
  background: var(--bg-hover);
}

.refresh-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.refresh-btn .spinning {
  display: inline-block;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@keyframes gradient-flow {
  0% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}

.popover-content {
  padding: 14px 16px;
}

.info-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 10px;
  font-size: 13px;
  line-height: 1.5;
}

.info-row:last-child {
  margin-bottom: 0;
}

.info-row.tools-row {
  flex-wrap: wrap;
}

.info-label {
  color: var(--text-muted);
  flex-shrink: 0;
  min-width: 55px;
}

.info-value {
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 11px;
}

.info-secondary {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 11px;
}

.info-value.tools-list {
  color: var(--accent-primary);
  word-break: break-word;
}

.popover-loading,
.popover-empty {
  padding: 16px 14px;
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
}

/* 错误诊断提示 */
.error-alert {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: rgba(244, 63, 94, 0.15);
  border-bottom: 1px solid rgba(244, 63, 94, 0.3);
  flex-shrink: 0;
  z-index: 10;
}

.error-alert-icon {
  font-size: 18px;
  flex-shrink: 0;
}

.error-alert-content {
  flex: 1;
  min-width: 0;
}

.error-alert-title {
  font-size: 12px;
  font-weight: 600;
  color: #f43f5e;
  margin-bottom: 2px;
}

.error-alert-text {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.error-alert-btn {
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 500;
  color: #fff;
  background: #f43f5e;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.error-alert-btn:hover:not(:disabled) {
  background: #e11d48;
}

.error-alert-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.error-alert-close {
  padding: 4px;
  color: var(--text-muted);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0.6;
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.error-alert-close:hover {
  opacity: 1;
  background: rgba(244, 63, 94, 0.2);
}

/* 选中内容提示 */
.selection-alert {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: rgba(59, 130, 246, 0.15);
  border-bottom: 1px solid rgba(59, 130, 246, 0.3);
  flex-shrink: 0;
  z-index: 10;
}

.selection-alert-icon {
  font-size: 18px;
  flex-shrink: 0;
}

.selection-alert-content {
  flex: 1;
  min-width: 0;
}

.selection-alert-title {
  font-size: 12px;
  font-weight: 600;
  color: #3b82f6;
  margin-bottom: 2px;
}

.selection-alert-text {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.selection-alert-btn {
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 500;
  color: #fff;
  background: #3b82f6;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.selection-alert-btn:hover:not(:disabled) {
  background: #2563eb;
}

.selection-alert-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.quick-actions {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
  padding: 12px;
  border-bottom: 1px solid var(--border-color);
}

.quick-action-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.quick-action-btn:hover {
  background: var(--bg-surface);
  color: var(--text-primary);
  border-color: var(--accent-primary);
}

.action-icon {
  font-size: 14px;
}

/* Plan 固定顶部区域 */
.plan-sticky-header {
  flex-shrink: 0;
  padding: 8px 12px;
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border-color);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  z-index: 10;
}

.ai-messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  user-select: text;
  position: relative;
  /* 启用滚动锚定，防止内容变化时滚动位置跳动 */
  overflow-anchor: auto;
  transition: box-shadow 0.3s ease;
}

/* Agent 执行模式 - 宽松模式绿色内阴影（仅左右两边） */
.ai-panel.mode-relaxed .ai-messages {
  box-shadow: 
    inset 30px 0 30px -20px rgba(16, 185, 129, 0.35),
    inset -30px 0 30px -20px rgba(16, 185, 129, 0.35);
}

/* Agent 执行模式 - 自由模式红色内阴影 + 脉冲警示（仅左右两边） */
.ai-panel.mode-free .ai-messages {
  box-shadow: 
    inset 40px 0 40px -25px rgba(239, 68, 68, 0.4),
    inset -40px 0 40px -25px rgba(239, 68, 68, 0.4);
  animation: free-mode-pulse 2s ease-in-out infinite;
}

@keyframes free-mode-pulse {
  0%, 100% {
    box-shadow: 
      inset 40px 0 40px -25px rgba(239, 68, 68, 0.4),
      inset -40px 0 40px -25px rgba(239, 68, 68, 0.4);
  }
  50% {
    box-shadow: 
      inset 50px 0 50px -30px rgba(239, 68, 68, 0.5),
      inset -50px 0 50px -30px rgba(239, 68, 68, 0.5);
  }
}

/* 新消息指示器 */
.new-message-indicator {
  position: sticky;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--accent-primary);
  color: #fff;
  font-size: 12px;
  font-weight: 500;
  border-radius: 20px;
  cursor: pointer;
  box-shadow: 0 2px 12px rgba(0, 150, 255, 0.4);
  transition: all 0.2s ease;
  animation: bounceIn 0.3s ease;
  z-index: 10;
  width: fit-content;
  margin: 0 auto;
}

.new-message-indicator:hover {
  background: var(--accent-primary-hover, #0080ff);
  transform: translateX(-50%) scale(1.05);
  box-shadow: 0 4px 16px rgba(0, 150, 255, 0.5);
}

.new-message-indicator:active {
  transform: translateX(-50%) scale(0.98);
}

@keyframes bounceIn {
  0% {
    opacity: 0;
    transform: translateX(-50%) translateY(10px);
  }
  100% {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
}

/* 上下文使用量迷你指示器 */
.context-mini {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 8px; /* 扩大悬停区域 */
  cursor: help;
}

.context-mini::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--bg-tertiary);
  border-radius: 1px;
}

.context-mini-bar {
  position: absolute;
  top: 0;
  left: 0;
  height: 2px;
  background: var(--accent-primary);
  border-radius: 1px;
  transition: width 0.3s ease, background 0.3s ease;
}

.context-mini-bar.warning {
  background: var(--accent-warning, #f59e0b);
}

.context-mini-bar.danger {
  background: var(--accent-error, #ef4444);
}

.context-mini-tip {
  position: absolute;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  padding: 4px 8px;
  font-size: 10px;
  color: var(--text-primary);
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  white-space: nowrap;
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.15s ease, visibility 0.15s ease;
  z-index: 100;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.context-mini:hover .context-mini-tip {
  opacity: 1;
  visibility: visible;
}

/* 旧的上下文样式（保留兼容） */
.context-stats {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: var(--bg-tertiary);
  border-top: 1px solid var(--border-color);
  font-size: 11px;
}

.context-info {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
}

.context-label {
  color: var(--text-secondary);
  font-weight: 500;
}

.context-separator {
  opacity: 0.5;
}

.context-bar {
  width: 60px;
  height: 4px;
  background: var(--bg-surface);
  border-radius: 2px;
  overflow: hidden;
}

.context-bar-fill {
  height: 100%;
  background: var(--accent-primary);
  border-radius: 2px;
  transition: width 0.3s ease, background 0.3s ease;
}

.context-bar-fill.warning {
  background: var(--accent-warning, #f59e0b);
}

.context-bar-fill.danger {
  background: var(--accent-error, #ef4444);
}

.ai-welcome {
  padding: 12px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.ai-welcome .welcome-section-title {
  font-weight: 600;
  color: var(--text-primary);
  margin-top: 10px;
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.ai-welcome .welcome-desc {
  color: var(--text-muted);
  font-size: 12px;
  margin-bottom: 4px;
}

.ai-welcome ul {
  margin: 4px 0 6px;
  padding-left: 16px;
}

.ai-welcome li {
  margin: 2px 0;
  color: var(--text-muted);
  font-size: 11px;
}

.ai-welcome li strong {
  color: var(--accent-primary);
  font-weight: 500;
}

.strict-badge {
  display: inline-block;
  padding: 2px 6px;
  font-size: 10px;
  font-weight: 500;
  background: var(--accent-primary);
  color: #fff;
  border-radius: 4px;
  margin-left: 6px;
}

.strict-badge.relaxed {
  background: var(--accent-secondary, #10b981);
}

.strict-badge.free {
  background: #ef4444;
}

/* ==================== 历史对话列表样式 ==================== */

.recent-history-section {
  margin-top: 20px;
  padding: 16px;
  background: linear-gradient(135deg, var(--bg-tertiary) 0%, transparent 100%);
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--border-color) 50%, transparent);
}

.recent-history-section .welcome-section-title {
  margin-bottom: 14px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.3px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.history-loading,
.history-empty {
  color: var(--text-muted);
  font-size: 12px;
  padding: 16px;
  text-align: center;
  background: var(--bg-surface);
  border-radius: 8px;
  border: 1px dashed var(--border-color);
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.history-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  cursor: pointer;
  border-radius: 10px;
  background: var(--bg-surface);
  border: 1px solid transparent;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  overflow: hidden;
}

.history-card::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--accent-primary);
  opacity: 0;
  transition: opacity 0.2s ease;
}

.history-card:hover {
  background: var(--bg-hover);
  border-color: color-mix(in srgb, var(--accent-primary) 30%, transparent);
  transform: translateX(2px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.history-card:hover::before {
  opacity: 1;
}

.history-card:active {
  transform: translateX(2px) scale(0.99);
}

.history-status-icon {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  transition: transform 0.2s ease;
}

.history-card:hover .history-status-icon {
  transform: scale(1.1);
}

.history-status-icon.completed {
  background: linear-gradient(135deg, rgba(16, 185, 129, 0.2) 0%, rgba(16, 185, 129, 0.1) 100%);
  color: #10b981;
  box-shadow: 0 0 0 1px rgba(16, 185, 129, 0.3);
}

.history-status-icon.failed {
  background: linear-gradient(135deg, rgba(239, 68, 68, 0.2) 0%, rgba(239, 68, 68, 0.1) 100%);
  color: #ef4444;
  box-shadow: 0 0 0 1px rgba(239, 68, 68, 0.3);
}

.history-status-icon.aborted {
  background: linear-gradient(135deg, rgba(245, 158, 11, 0.2) 0%, rgba(245, 158, 11, 0.1) 100%);
  color: #f59e0b;
  box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.3);
}

.history-task {
  flex: 1;
  font-size: 12.5px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 450;
  letter-spacing: 0.1px;
}

.history-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.history-ssh {
  font-size: 10px;
  color: var(--accent-primary);
  background: color-mix(in srgb, var(--accent-primary) 12%, transparent);
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 500;
}

.history-time {
  font-size: 11px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
}

.view-more-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  margin-top: 12px;
  padding: 10px 16px;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  overflow: hidden;
}

.view-more-btn::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
  opacity: 0;
  transition: opacity 0.25s ease;
}

.view-more-btn:hover {
  border-color: var(--accent-primary);
  color: var(--accent-primary);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px color-mix(in srgb, var(--accent-primary) 20%, transparent);
}

.view-more-btn:hover::before {
  opacity: 0.08;
}

.view-more-btn:active {
  transform: translateY(0);
}

/* 历史弹窗 */
.history-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1000;
  animation: modalOverlayIn 0.2s ease;
}

@keyframes modalOverlayIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.history-modal {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 16px;
  width: 90%;
  max-width: 600px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.05) inset;
  animation: modalSlideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes modalSlideIn {
  from {
    opacity: 0;
    transform: scale(0.95) translateY(10px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

.history-modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 18px 24px;
  border-bottom: 1px solid var(--border-color);
  background: linear-gradient(180deg, var(--bg-surface) 0%, transparent 100%);
}

.history-modal-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: 0.2px;
}

.history-modal-close {
  background: var(--bg-hover);
  border: none;
  font-size: 18px;
  color: var(--text-secondary);
  cursor: pointer;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
}

.history-modal-close:hover {
  background: var(--accent-error);
  color: white;
}

.history-modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
}

.history-modal-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.history-modal-list .history-card {
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid var(--border-color);
}

.history-modal-list .history-card:hover {
  border-color: color-mix(in srgb, var(--accent-primary) 40%, transparent);
}

.message {
  margin-bottom: 12px;
  animation: messageEnter 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes messageEnter {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.message.user {
  display: flex;
  justify-content: flex-end;
}

.message.assistant {
  display: flex;
  justify-content: flex-start;
}

.message-wrapper {
  position: relative;
  max-width: 85%;
  display: flex;
  flex-direction: column;
  gap: 4px;
  transition: transform 0.2s ease;
}

.message.user .message-content {
  background: var(--accent-primary);
  color: var(--bg-primary);
  border-radius: 12px 12px 4px 12px;
  user-select: text;
  cursor: text;
}

.message.assistant .message-content {
  background: var(--bg-surface);
  color: var(--text-primary);
  border-radius: 12px 12px 12px 4px;
  user-select: text;
  cursor: text;
}

.message-content {
  padding: 10px 14px;
  font-size: 13px;
  line-height: 1.5;
  word-wrap: break-word;
  user-select: text;
  cursor: text;
  /* 限制重绘范围，减少布局抖动 */
  contain: layout style;
}

.message-content pre {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 12px;
  white-space: pre-wrap;
  user-select: text;
  cursor: text;
}

.markdown-content {
  width: 100%;
}

/* 代码块样式 */
/* 代码块样式 - 使用 :deep() 穿透 v-html */
.markdown-content :deep(.code-block) {
  margin: 12px 0;
  border-radius: 8px;
  overflow: hidden;
  background: #1a1b26;
  border: 1px solid rgba(255, 255, 255, 0.1);
  width: 100%;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.markdown-content :deep(.code-header) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  font-size: 11px;
  font-weight: 500;
  color: #7aa2f7;
  background: #16161e;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  text-transform: uppercase;
  font-family: var(--font-mono);
  letter-spacing: 0.5px;
}

.markdown-content :deep(.code-actions) {
  display: flex;
  gap: 6px;
}

.markdown-content :deep(.code-copy-btn),
.markdown-content :deep(.code-send-btn) {
  padding: 4px 8px;
  font-size: 11px;
  color: #565f89;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
}

/* 确保 SVG 不拦截点击事件 */
.markdown-content :deep(.code-copy-btn svg),
.markdown-content :deep(.code-send-btn svg) {
  pointer-events: none;
}

.markdown-content :deep(.code-copy-btn:hover) {
  color: #7aa2f7;
  background: rgba(122, 162, 247, 0.15);
  border-color: #7aa2f7;
}

.markdown-content :deep(.code-send-btn:hover) {
  color: #9ece6a;
  background: rgba(158, 206, 106, 0.15);
  border-color: #9ece6a;
}

.markdown-content :deep(.code-block pre) {
  margin: 0;
  padding: 14px 16px;
  overflow-x: auto;
  background: #1a1b26;
  white-space: pre;
}

.markdown-content :deep(.code-block code) {
  font-family: 'Fira Code', 'JetBrains Mono', 'Cascadia Code', Consolas, monospace;
  font-size: 13px;
  line-height: 1.6;
  color: #a9b1d6;
  white-space: pre;
  display: block;
}

/* 行内代码样式 */
.markdown-content :deep(.inline-code) {
  padding: 2px 6px;
  font-family: var(--font-mono);
  font-size: 12px;
  background: rgba(122, 162, 247, 0.15);
  border: 1px solid rgba(122, 162, 247, 0.3);
  border-radius: 4px;
  color: #7aa2f7;
}

/* Markdown 样式 - 使用 :deep() 穿透 v-html */
.markdown-content {
  line-height: 1.6;
  /* 开启 GPU 加速，减少流式输出时的重绘闪动 */
  transform: translateZ(0);
  backface-visibility: hidden;
}

.markdown-content :deep(p) {
  margin: 0 0 8px;
}

.markdown-content :deep(p:last-child) {
  margin-bottom: 0;
}

.markdown-content :deep(strong) {
  font-weight: 600;
  color: var(--text-primary);
}

.markdown-content :deep(em) {
  font-style: italic;
}

.markdown-content :deep(h1),
.markdown-content :deep(h2) {
  font-size: 16px;
  font-weight: 600;
  margin: 12px 0 8px;
  color: var(--text-primary);
}

.markdown-content :deep(h3) {
  font-size: 14px;
  font-weight: 600;
  margin: 10px 0 6px;
  color: var(--text-primary);
}

.markdown-content :deep(h4),
.markdown-content :deep(h5),
.markdown-content :deep(h6) {
  font-size: 13px;
  font-weight: 600;
  margin: 8px 0 4px;
  color: var(--text-primary);
}

.markdown-content :deep(ul),
.markdown-content :deep(ol) {
  margin: 8px 0;
  padding-left: 20px;
}

.markdown-content :deep(li) {
  margin: 4px 0;
}

.markdown-content :deep(ul li) {
  list-style-type: disc;
}

.markdown-content :deep(ol li) {
  list-style-type: decimal;
}

.markdown-content :deep(blockquote) {
  margin: 8px 0;
  padding: 8px 12px;
  border-left: 3px solid var(--accent-primary);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}

/* 思考过程折叠区域样式 */
.markdown-content :deep(details) {
  margin: 12px 0;
  border: 1px solid rgba(122, 162, 247, 0.3);
  border-radius: 8px;
  background: linear-gradient(135deg, rgba(122, 162, 247, 0.08), rgba(122, 162, 247, 0.02));
  overflow: hidden;
}

.markdown-content :deep(details[open]) {
  background: linear-gradient(135deg, rgba(122, 162, 247, 0.12), rgba(122, 162, 247, 0.04));
}

.markdown-content :deep(summary) {
  padding: 10px 14px;
  cursor: pointer;
  user-select: none;
  font-size: 13px;
  color: #7aa2f7;
  background: rgba(122, 162, 247, 0.1);
  border-bottom: 1px solid rgba(122, 162, 247, 0.2);
  list-style: none;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: background 0.2s ease;
}

.markdown-content :deep(summary::-webkit-details-marker) {
  display: none;
}

.markdown-content :deep(summary::before) {
  content: '▶';
  font-size: 10px;
  transition: transform 0.2s ease;
  color: #7aa2f7;
}

.markdown-content :deep(details[open] > summary::before) {
  transform: rotate(90deg);
}

.markdown-content :deep(summary:hover) {
  background: rgba(122, 162, 247, 0.2);
}

.markdown-content :deep(details > blockquote) {
  margin: 0;
  padding: 12px 16px;
  border-left: none;
  border-radius: 0;
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.6;
  max-height: 400px;
  overflow-y: auto;
}

/* 思考过程中的文本样式 */
.markdown-content :deep(details > blockquote p) {
  margin: 6px 0;
}

.markdown-content :deep(details > blockquote code) {
  background: rgba(0, 0, 0, 0.2);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 11px;
}

.markdown-content :deep(a) {
  color: var(--accent-primary);
  text-decoration: none;
}

.markdown-content :deep(a:hover) {
  text-decoration: underline;
}

.markdown-content :deep(hr) {
  border: none;
  border-top: 1px solid var(--border-color);
  margin: 12px 0;
}

.markdown-content :deep(table) {
  border-collapse: collapse;
  margin: 8px 0;
  width: 100%;
}

.markdown-content :deep(th),
.markdown-content :deep(td) {
  border: 1px solid var(--border-color);
  padding: 6px 10px;
  text-align: left;
}

.markdown-content :deep(th) {
  background: var(--bg-tertiary);
  font-weight: 600;
}

.copy-btn {
  align-self: flex-start;
  padding: 4px 8px;
  font-size: 11px;
  color: var(--text-muted);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0.6;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  gap: 4px;
}

.copy-btn:hover {
  opacity: 1;
  background: var(--bg-hover);
  color: var(--accent-primary);
}

/* 已上传文档列表 */
.uploaded-docs {
  padding: 8px 12px;
  background: var(--bg-tertiary);
  border-top: 1px solid var(--border-color);
}

.uploaded-docs-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.uploaded-docs-title {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-secondary);
}

.btn-clear-docs {
  padding: 2px 4px;
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 3px;
  opacity: 0.6;
  transition: all 0.2s;
}

.btn-clear-docs:hover {
  opacity: 1;
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

.uploaded-docs-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.uploaded-doc-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-size: 11px;
  max-width: 200px;
}

.uploaded-doc-item.has-error {
  border-color: rgba(239, 68, 68, 0.5);
  background: rgba(239, 68, 68, 0.05);
}

.doc-icon {
  font-size: 12px;
  flex-shrink: 0;
}

.doc-name {
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100px;
}

.doc-size {
  color: var(--text-muted);
  font-size: 10px;
  flex-shrink: 0;
}

.doc-error {
  flex-shrink: 0;
  cursor: help;
  position: relative;
}

.doc-error::after {
  content: attr(data-tooltip);
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  background: rgba(30, 30, 30, 0.95);
  color: #fff;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.4;
  white-space: pre-wrap;
  max-width: 280px;
  min-width: 120px;
  z-index: 1000;
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.2s ease, visibility 0.2s ease;
  pointer-events: none;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(239, 68, 68, 0.3);
}

.doc-error::before {
  content: '';
  position: absolute;
  bottom: calc(100% + 4px);
  left: 50%;
  transform: translateX(-50%);
  border: 5px solid transparent;
  border-top-color: rgba(30, 30, 30, 0.95);
  z-index: 1001;
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.2s ease, visibility 0.2s ease;
  pointer-events: none;
}

.doc-error:hover::after,
.doc-error:hover::before {
  opacity: 1;
  visibility: visible;
}

.btn-remove-doc {
  padding: 2px;
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 3px;
  opacity: 0.5;
  transition: all 0.2s;
  flex-shrink: 0;
}

.btn-remove-doc:hover {
  opacity: 1;
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

.ai-input {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px 14px;
  border-top: 1px solid var(--border-color);
  background: linear-gradient(180deg, var(--bg-tertiary) 0%, var(--bg-primary) 100%);
}

/* 输入框容器 - 包含输入框和按钮的统一容器 */
.input-container {
  position: relative; /* 用于定位 @ 补全菜单 */
  flex: 1;
  display: flex;
  align-items: flex-end;
  gap: 10px;
  padding: 8px 10px 8px 12px;
  background: var(--bg-surface);
  border: none;
  border-radius: 16px;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.03);
}

.input-container:focus-within {
  box-shadow: 0 0 0 2px var(--accent-primary), 0 4px 12px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.05);
}

/* 上传按钮 */
.upload-btn {
  flex-shrink: 0;
  padding: 8px;
  background: transparent;
  border: none;
  color: var(--text-muted);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}

.upload-btn:hover:not(:disabled) {
  background: rgba(100, 150, 255, 0.12);
  color: var(--accent-primary);
  transform: scale(1.08);
}

.upload-btn:active:not(:disabled) {
  transform: scale(0.95);
}

.upload-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.upload-spinner {
  display: inline-block;
  width: 16px;
  height: 16px;
  border: 2px solid rgba(100, 150, 255, 0.2);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.ai-input textarea {
  flex: 1;
  padding: 6px 4px;
  font-size: 14px;
  font-family: inherit;
  color: var(--text-primary);
  background: transparent;
  border: none;
  resize: none;
  outline: none;
  line-height: 1.5;
  min-height: 24px;
  max-height: 360px;
  overflow-y: auto;
  transition: height 0.1s ease-out;
}

.ai-input textarea:focus {
  border: none;
  box-shadow: none;
  outline: none;
}

.ai-input textarea::placeholder {
  color: var(--text-muted);
  opacity: 0.7;
  transition: opacity 0.2s;
}

.ai-input textarea:focus::placeholder {
  opacity: 0.5;
}

.send-btn {
  flex-shrink: 0;
  padding: 10px 14px;
  border-radius: 12px;
  background: linear-gradient(135deg, #6b8cff 0%, #5a7bff 50%, #4f6ef7 100%);
  border: none;
  box-shadow: 0 2px 8px rgba(90, 123, 255, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.15);
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}

.send-btn:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 16px rgba(90, 123, 255, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.2);
  background: linear-gradient(135deg, #7d9aff 0%, #6b8cff 50%, #5a7bff 100%);
}

.send-btn:active:not(:disabled) {
  transform: translateY(0) scale(0.97);
  box-shadow: 0 2px 4px rgba(90, 123, 255, 0.3);
}

.send-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  box-shadow: none;
}

.send-btn-agent {
  background: linear-gradient(135deg, #34d399 0%, #10b981 50%, #059669 100%);
  box-shadow: 0 2px 8px rgba(16, 185, 129, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.15);
}

.send-btn-agent:hover:not(:disabled) {
  background: linear-gradient(135deg, #4ade80 0%, #34d399 50%, #10b981 100%);
  box-shadow: 0 4px 16px rgba(16, 185, 129, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.2);
}

.send-btn-supplement {
  background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 50%, #d97706 100%);
  box-shadow: 0 2px 8px rgba(245, 158, 11, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.15);
}

.send-btn-supplement:hover:not(:disabled) {
  background: linear-gradient(135deg, #fcd34d 0%, #fbbf24 50%, #f59e0b 100%);
  box-shadow: 0 4px 16px rgba(245, 158, 11, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.2);
}

.send-btn-default {
  background: linear-gradient(135deg, #6ee7b7 0%, #10b981 50%, #059669 100%);
  box-shadow: 0 2px 8px rgba(16, 185, 129, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.15);
}

.send-btn-default:hover:not(:disabled) {
  background: linear-gradient(135deg, #a7f3d0 0%, #34d399 50%, #10b981 100%);
  box-shadow: 0 4px 16px rgba(16, 185, 129, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.2);
}

.stop-btn {
  flex-shrink: 0;
  padding: 10px 14px;
  border-radius: 12px;
  background: linear-gradient(135deg, #f87171 0%, #ef4444 50%, #dc2626 100%);
  border: none;
  box-shadow: 0 2px 8px rgba(239, 68, 68, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.15);
  animation: pulse-glow 1.5s ease-in-out infinite;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}

.stop-btn:hover {
  transform: translateY(-1px);
  background: linear-gradient(135deg, #fca5a5 0%, #f87171 50%, #ef4444 100%);
  box-shadow: 0 4px 16px rgba(239, 68, 68, 0.5);
}

.stop-btn:active {
  transform: translateY(0) scale(0.97);
}

@keyframes pulse-glow {
  0%, 100% {
    box-shadow: 0 2px 8px rgba(239, 68, 68, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.15);
  }
  50% {
    box-shadow: 0 2px 16px rgba(239, 68, 68, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.15);
  }
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.7;
  }
}

/* ==================== Agent 模式样式 ==================== */

/* 模式切换 */
.mode-switcher {
  display: flex;
  padding: 8px 12px;
  gap: 8px;
  border-bottom: 1px solid var(--border-color);
  animation: switcherEnter 0.4s cubic-bezier(0.16, 1, 0.3, 1) 0.15s both;
}

@keyframes switcherEnter {
  from {
    opacity: 0;
    transform: translateY(-5px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.mode-btn {
  flex: 1;
  padding: 8px 14px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  position: relative;
  overflow: hidden;
}

.mode-btn::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, rgba(255,255,255,0.1), transparent);
  opacity: 0;
  transition: opacity 0.2s ease;
}

.mode-btn:hover::before {
  opacity: 1;
}

.mode-btn:hover {
  background: var(--bg-surface);
  color: var(--text-primary);
  transform: translateY(-1px);
}

.mode-btn:active {
  transform: translateY(0) scale(0.98);
}

.mode-btn.active {
  background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
  color: #fff;
  border-color: transparent;
  box-shadow: 0 2px 10px rgba(var(--accent-rgb, 137, 180, 250), 0.3);
}

.mode-btn.active:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 15px rgba(var(--accent-rgb, 137, 180, 250), 0.4);
}

/* 需要注意的状态（有待确认操作） */
.mode-btn.needs-attention {
  position: relative;
  animation: attention-pulse 1.5s ease-in-out infinite;
  border-color: var(--warning-color, #f59e0b);
  background: rgba(245, 158, 11, 0.15);
  color: var(--warning-color, #f59e0b);
}

.mode-btn.needs-attention:hover {
  background: rgba(245, 158, 11, 0.25);
}

@keyframes attention-pulse {
  0%, 100% {
    box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.4);
  }
  50% {
    box-shadow: 0 0 0 6px rgba(245, 158, 11, 0);
  }
}

.attention-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  width: 16px;
  height: 16px;
  background: var(--warning-color, #f59e0b);
  color: #fff;
  font-size: 10px;
  font-weight: bold;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: badge-bounce 1s ease-in-out infinite;
}

@keyframes badge-bounce {
  0%, 100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.2);
  }
}

/* Agent 设置区域 */
.agent-settings {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* 超时设置 */
.timeout-setting {
  display: flex;
  align-items: center;
  gap: 4px;
}

.timeout-label {
  font-size: 11px;
  color: var(--text-secondary);
}

.timeout-select {
  font-size: 11px;
  height: 26px;
  padding: 0 2px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-primary);
  cursor: pointer;
  outline: none;
  text-align: right;
}

.timeout-select:hover {
  border-color: var(--accent-primary);
}

.timeout-select:focus {
  border-color: var(--accent-primary);
}

/* 严格模式开关 */
.strict-mode-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
}

.toggle-label {
  font-size: 11px;
  color: var(--text-secondary);
}

.toggle-switch {
  position: relative;
  width: 32px;
  height: 18px;
  background: var(--bg-tertiary);
  border-radius: 9px;
  border: 1px solid var(--border-color);
  transition: all 0.2s;
}

.toggle-switch.active {
  background: var(--accent-primary);
  border-color: var(--accent-primary);
}

.toggle-dot {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.2s;
}

.toggle-switch.active .toggle-dot {
  transform: translateX(14px);
}

/* 执行模式选择器 */
.execution-mode-selector {
  display: flex;
  gap: 2px;
  background: var(--bg-tertiary);
  border-radius: 6px;
  padding: 2px;
  border: 1px solid var(--border-color);
}

.mode-option {
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.mode-option:hover {
  background: var(--bg-surface);
  color: var(--text-primary);
}

.mode-option.active {
  background: var(--accent-primary);
  color: #fff;
}

.mode-option-free.active {
  background: #ef4444;
}

.mode-option-free:hover:not(.active) {
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
}

/* 自由模式确认对话框 */
.free-mode-confirm-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.free-mode-confirm-dialog {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 20px;
  max-width: 400px;
  width: 100%;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.confirm-dialog-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
}

.confirm-dialog-icon {
  font-size: 24px;
}

.confirm-dialog-title {
  font-size: 16px;
  font-weight: 600;
  color: #ef4444;
}

.confirm-dialog-content {
  margin-bottom: 20px;
}

.confirm-dialog-content p {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0 0 12px;
  line-height: 1.5;
}

.confirm-dialog-warnings {
  margin: 12px 0;
  padding-left: 20px;
}

.confirm-dialog-warnings li {
  font-size: 12px;
  color: #ef4444;
  margin: 6px 0;
  line-height: 1.4;
}

.confirm-dialog-instruction {
  font-weight: 500;
  color: var(--text-primary) !important;
}

.confirm-dialog-input {
  width: 100%;
  padding: 10px 12px;
  font-size: 14px;
  background: var(--bg-tertiary);
  border: 2px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-primary);
  outline: none;
  transition: border-color 0.2s;
}

.confirm-dialog-input:focus {
  border-color: #ef4444;
}

.confirm-dialog-input::placeholder {
  color: var(--text-muted);
}

.confirm-dialog-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}

.btn-outline {
  background: transparent;
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
}

.btn-outline:hover {
  background: var(--bg-surface);
  color: var(--text-primary);
}

/* 警告文本样式 */
.warning-text {
  color: #ef4444 !important;
}

/* Agent 步骤（融入对话） */
.agent-steps-wrapper {
  max-width: 95% !important;
}

.agent-steps-content {
  padding: 12px 14px !important;
}

.agent-steps-header-inline {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--accent-primary);
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-color);
  cursor: pointer;
  user-select: none;
}

.agent-steps-header-inline:hover {
  opacity: 0.8;
}

.steps-count {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-muted);
  margin-left: auto;
}

.collapse-icon {
  font-size: 10px;
  color: var(--text-muted);
  transition: transform 0.2s ease;
}

.collapse-icon.collapsed {
  transform: rotate(-90deg);
}

.agent-steps-body {
  margin-top: 10px;
}

/* AI 思考中指示器 */
.agent-thinking-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  margin-top: 10px;
  background: linear-gradient(135deg, rgba(52, 211, 153, 0.06), rgba(16, 185, 129, 0.06));
  border-radius: 8px;
  border: 1px solid rgba(52, 211, 153, 0.12);
}

.thinking-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(52, 211, 153, 0.2);
  border-top-color: #34d399;
  border-radius: 50%;
  animation: spin 1s linear infinite;
  box-shadow: 0 0 8px rgba(52, 211, 153, 0.3);
}

.thinking-text {
  font-size: 13px;
  /* 渐变文字动画 */
  background: linear-gradient(
    90deg,
    rgba(110, 231, 183, 0.75) 0%,
    rgba(52, 211, 153, 1) 50%,
    rgba(110, 231, 183, 0.75) 100%
  );
  background-size: 200% 100%;
  animation: gradient-flow 2s linear infinite;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  color: rgba(110, 231, 183, 0.75);
  animation: pulse-text 2s ease-in-out infinite;
}

@keyframes pulse-text {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

/* Agent 最终回复 - 美化样式 */
.agent-final-wrapper {
  background: transparent !important;
}

.agent-final-content {
  background: rgba(255, 255, 255, 0.03);
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  overflow: hidden;
}

.agent-final-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: rgba(16, 185, 129, 0.1);
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  font-size: 13px;
  font-weight: 500;
}

/* 失败状态的样式 */
.agent-final-content.is-error .agent-final-header {
  background: rgba(244, 67, 54, 0.1);
}

.agent-final-content.is-error {
  border-color: rgba(244, 67, 54, 0.2);
}

.agent-final-content.is-aborted .agent-final-header {
  background: rgba(255, 152, 0, 0.1);
}

.agent-final-content.is-aborted {
  border-color: rgba(255, 152, 0, 0.2);
}

.final-icon {
  font-size: 16px;
}

.final-title {
  color: var(--text-primary);
}

.agent-final-body {
  padding: 12px 14px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-primary);
}

.agent-final-body :deep(p) {
  margin: 4px 0;
}

.agent-final-body :deep(p:first-child) {
  margin-top: 0;
}

.agent-final-body :deep(p:last-child) {
  margin-bottom: 0;
}

.agent-final-body :deep(strong) {
  color: var(--accent-primary);
}

.agent-final-body :deep(blockquote) {
  margin: 8px 0;
  padding: 10px 14px;
  border-left: 3px solid #10b981;
  background: rgba(16, 185, 129, 0.08);
  border-radius: 0 6px 6px 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}

.agent-final-body :deep(blockquote p) {
  margin: 0;
}

.agent-final-body :deep(ul),
.agent-final-body :deep(ol) {
  margin: 8px 0;
  padding-left: 20px;
}

.agent-final-body :deep(li) {
  margin: 4px 0;
}

.agent-final-body :deep(code) {
  background: rgba(255, 255, 255, 0.1);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 12px;
}

.agent-final-body :deep(pre) {
  margin: 8px 0;
  padding: 10px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 6px;
  overflow-x: auto;
}

.agent-final-body :deep(pre code) {
  background: transparent;
  padding: 0;
}

.agent-running-dot {
  width: 8px;
  height: 8px;
  background: var(--accent-primary);
  border-radius: 50%;
  animation: pulse-dot 1.5s ease-in-out infinite;
}

@keyframes pulse-dot {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(0.8); }
}

/* Agent 步骤消息（紧凑显示） */
.agent-step-message {
  margin-bottom: 4px !important;
}

.agent-step-message .message-wrapper {
  padding: 6px 0;
}

.agent-step-content-inline {
  display: flex;
  gap: 8px;
  padding: 8px 12px !important;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-radius: 8px;
}

.agent-step-inline {
  display: flex;
  gap: 8px;
  padding: 8px 0;
  font-size: 12px;
  color: var(--text-secondary);
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.agent-step-inline:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.step-icon {
  flex-shrink: 0;
  font-size: 14px;
}

.step-content {
  flex: 1;
  min-width: 0;
  /* 限制重绘范围，减少流式输出时的布局抖动 */
  contain: layout style;
}

.step-text {
  word-break: break-word;
  line-height: 1.5;
}

/* AI 分析文本样式 */
.step-text.step-analysis {
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.03);
  padding: 8px 10px;
  border-radius: 6px;
  margin: -4px 0;
}

/* Agent 步骤中的 markdown 样式 */
.step-text.step-analysis.markdown-content {
  font-size: 13px;
}

/* 流式输出时的样式优化 */
.step-text.step-analysis.markdown-content.is-streaming {
  /* 设置最小高度，减少内容从少到多时的高度跳动 */
  min-height: 120px;
  /* 提示浏览器内容会变化 */
  will-change: contents;
}

.step-text.step-analysis.markdown-content :deep(p) {
  margin: 4px 0;
}

.step-text.step-analysis.markdown-content :deep(strong) {
  color: var(--accent-primary);
}

/* 思考过程引用块样式 */
.step-text.step-analysis.markdown-content :deep(blockquote) {
  margin: 8px 0;
  padding: 10px 14px;
  border-left: 3px solid #7aa2f7;
  background: rgba(122, 162, 247, 0.1);
  border-radius: 0 6px 6px 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
  max-height: 300px;
  overflow-y: auto;
}

.step-text.step-analysis.markdown-content :deep(blockquote p) {
  margin: 0;
}

.step-text.step-analysis.markdown-content :deep(hr) {
  margin: 12px 0;
  border: none;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.step-result {
  margin-top: 6px;
  padding: 8px 10px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  max-height: 120px;
  overflow-y: auto;
}

.step-result pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-muted);
}

.agent-step-inline.thinking {
  color: rgba(110, 231, 183, 0.75);
}

.agent-step-inline.thinking .step-icon {
  animation: pulse 1.5s ease-in-out infinite;
}

.agent-step-inline.thinking .step-text {
  animation: pulse-text 2s ease-in-out infinite;
}

.agent-step-inline.tool_call {
  color: var(--accent-primary);
}

.agent-step-inline.tool_call .step-text {
  color: var(--text-primary);
}

.agent-step-inline.error {
  color: var(--accent-error, #f44336);
}

.agent-step-inline.message {
  color: var(--text-primary);
}

/* 用户补充消息：样式类似用户消息气泡，但略有区分 */
.agent-step-inline.user_supplement {
  display: flex;
  justify-content: flex-end;
  background: transparent;
  border-left: none;
  padding-left: 0;
  margin-left: 0;
}

.agent-step-inline.user_supplement .step-content {
  background: var(--accent-primary);
  opacity: 0.85;
  color: var(--bg-primary);
  border-radius: 12px 12px 4px 12px;
  padding: 8px 12px;
  max-width: 80%;
}

.agent-step-inline.user_supplement .step-icon {
  display: none;  /* 隐藏图标，让消息看起来更自然 */
}

.agent-step-inline.waiting {
  background: rgba(59, 130, 246, 0.1);
  border-left: 3px solid #3b82f6;
  padding-left: 10px;
  margin-left: -2px;
  border-radius: 4px;
  color: var(--text-primary);
}

.agent-step-inline.waiting .step-icon {
  color: #3b82f6;
}

.agent-step-inline.asking {
  background: rgba(96, 165, 250, 0.08);
  border-left: 3px solid #60a5fa;
  padding-left: 10px;
  margin-left: -2px;
  border-radius: 4px;
  color: var(--text-primary);
}

.agent-step-inline.asking .step-icon {
  color: #60a5fa;
}

.agent-step-inline.waiting_password {
  background: rgba(251, 191, 36, 0.12);
  border-left: 3px solid #fbbf24;
  padding-left: 10px;
  margin-left: -2px;
  border-radius: 4px;
  color: var(--text-primary);
  animation: password-pulse 2s ease-in-out infinite;
}

.agent-step-inline.waiting_password .step-icon {
  color: #fbbf24;
  animation: key-bounce 1s ease-in-out infinite;
}

@keyframes password-pulse {
  0%, 100% { 
    background: rgba(251, 191, 36, 0.12);
    border-left-color: #fbbf24;
  }
  50% { 
    background: rgba(251, 191, 36, 0.2);
    border-left-color: #f59e0b;
  }
}

@keyframes key-bounce {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-2px); }
}

/* 提问内容样式 */
.asking-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.asking-question {
  white-space: pre-wrap;
  line-height: 1.5;
  color: var(--text-primary);
}

.asking-default {
  font-size: 11px;
  color: var(--text-muted);
}

.asking-default .default-label {
  font-style: italic;
}

.asking-default .default-hint {
  color: #10b981;
  margin-left: 6px;
}

.asking-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 2px;
  max-width: 400px;
}

.asking-option-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
  background: rgba(96, 165, 250, 0.06);
  border: 1px solid rgba(96, 165, 250, 0.2);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
  text-align: left;
}

.asking-option-btn .option-label {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  background: rgba(255, 255, 255, 0.08);
  border-radius: 4px;
}

.asking-option-btn:hover:not(:disabled) {
  background: rgba(96, 165, 250, 0.12);
  border-color: rgba(96, 165, 250, 0.35);
}

.asking-option-btn:active:not(:disabled) {
  background: rgba(96, 165, 250, 0.18);
}

.asking-option-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.asking-option-btn.clicking {
  background: rgba(96, 165, 250, 0.2);
  border-color: rgba(96, 165, 250, 0.5);
  color: #60a5fa;
}

.asking-option-btn.clicking .option-label {
  background: rgba(96, 165, 250, 0.3);
  color: #60a5fa;
}

.asking-option-btn.selected {
  background: rgba(34, 197, 94, 0.12);
  border-color: rgba(34, 197, 94, 0.35);
  color: #22c55e;
}

.asking-option-btn.selected .option-label {
  background: rgba(34, 197, 94, 0.25);
  color: #22c55e;
}

/* 多选确认按钮 */
.asking-confirm-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px 16px;
  margin-top: 4px;
  font-size: 12px;
  font-weight: 600;
  color: #fff;
  background: linear-gradient(135deg, #60a5fa 0%, #3b82f6 100%);
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.asking-confirm-btn:hover:not(:disabled) {
  background: linear-gradient(135deg, #93c5fd 0%, #60a5fa 100%);
  box-shadow: 0 2px 8px rgba(59, 130, 246, 0.35);
}

.asking-confirm-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.asking-status {
  font-size: 11px;
  margin-top: 2px;
}

.asking-status.status-waiting {
  color: var(--text-muted);
}

.asking-status.status-done {
  color: #22c55e;
}

.asking-status.status-timeout {
  color: #f59e0b;
}

.asking-status.status-cancelled {
  color: #ef4444;
}

/* 计划步骤样式 */
.plan-step-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.plan-step-header {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 4px 8px;
  margin: -4px -8px;
  border-radius: 6px;
  transition: background 0.15s ease;
}

.plan-step-header:hover {
  background: rgba(255, 255, 255, 0.05);
}

.plan-step-text {
  flex: 1;
  color: var(--text-primary);
}

.plan-expand-icon {
  font-size: 10px;
  color: var(--text-muted);
  transition: transform 0.2s ease;
}

.plan-expand-icon.expanded {
  transform: rotate(90deg);
}

.plan-step-details {
  margin-top: 8px;
  padding: 8px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.06);
}

/* 归档计划的特殊样式 */
.agent-step-inline.plan_archived .plan-step-text {
  color: var(--text-muted);
}

.agent-step-inline.plan_archived .plan-step-header:hover .plan-step-text {
  color: var(--text-primary);
}

/* 等待处理的补充消息 */
.pending-supplement {
  background: rgba(245, 158, 11, 0.08) !important;
  border: 1px dashed rgba(245, 158, 11, 0.4) !important;
  border-radius: 8px !important;
}

.pending-supplement-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 12px;
}

.pending-icon {
  font-size: 14px;
}

.pending-label {
  color: #f59e0b;
  font-weight: 500;
}

.pending-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(245, 158, 11, 0.2);
  border-top-color: #f59e0b;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

.pending-supplement-content {
  color: var(--text-primary);
  font-size: 13px;
  line-height: 1.5;
}

/* 风险等级颜色 */
.risk-safe {
  border-left: 3px solid #10b981;
  padding-left: 10px;
  margin-left: -2px;
}

.risk-moderate {
  border-left: 3px solid #f59e0b;
  padding-left: 10px;
  margin-left: -2px;
}

.risk-dangerous {
  border-left: 3px solid #ef4444;
  padding-left: 10px;
  margin-left: -2px;
}

.risk-blocked {
  border-left: 3px solid #6b7280;
  padding-left: 10px;
}

/* 拒绝执行的步骤 */
.step-rejected {
  opacity: 0.6;
  border-left: 3px solid #ef4444 !important;
  padding-left: 10px;
  margin-left: -2px;
  opacity: 0.6;
}

/* Agent 确认对话框（融入对话） */
.agent-confirm-inline {
  padding: 14px !important;
  border-radius: 10px !important;
}

/* ===== 高风险 - 红色系 ===== */
.agent-confirm-inline.risk-dangerous {
  background: linear-gradient(135deg, #3b1018 0%, #2a0a10 100%) !important;
  border: 2px solid #ef4444 !important;
  box-shadow: 0 4px 20px rgba(239, 68, 68, 0.2);
}

/* ===== 中风险 - 橙黄色系 ===== */
.agent-confirm-inline.risk-moderate {
  background: linear-gradient(135deg, #3d2f10 0%, #2a2008 100%) !important;
  border: 2px solid #f59e0b !important;
  box-shadow: 0 4px 20px rgba(245, 158, 11, 0.15);
}

/* ===== 低风险 - 绿色系 ===== */
.agent-confirm-inline.risk-safe {
  background: linear-gradient(135deg, #0f2920 0%, #081a14 100%) !important;
  border: 2px solid #10b981 !important;
  box-shadow: 0 4px 20px rgba(16, 185, 129, 0.1);
}

.confirm-header-inline {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.confirm-icon {
  font-size: 20px;
}

.confirm-title {
  font-size: 14px;
  font-weight: 600;
  color: #fff;
}

.confirm-risk-badge {
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 700;
  border-radius: 4px;
  margin-left: auto;
}

.confirm-risk-badge.risk-dangerous {
  background: #ef4444;
  color: #fff;
}

.confirm-risk-badge.risk-moderate {
  background: #f59e0b;
  color: #000;
}

.confirm-risk-badge.risk-safe {
  background: #10b981;
  color: #fff;
}

.confirm-detail {
  margin-bottom: 12px;
}

.confirm-tool-name {
  font-size: 12px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.7);
  margin-bottom: 6px;
}

.confirm-args-inline {
  padding: 10px;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  font-family: var(--font-mono);
  font-size: 12px;
  margin: 0;
  max-height: 100px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  color: #fff;
}

.confirm-actions-inline {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}

.btn-outline-secondary {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.25);
  color: rgba(255, 255, 255, 0.8);
}

.btn-outline-secondary:hover {
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
}

.btn-warning {
  background: #f59e0b;
  border: 1px solid #f59e0b;
  color: #000;
}

.btn-warning:hover:not(:disabled) {
  background: #d97706;
  border-color: #d97706;
}

.btn-danger {
  background: #ef4444;
  border: 1px solid #ef4444;
  color: #fff;
}

.btn-danger:hover:not(:disabled) {
  background: #dc2626;
  border-color: #dc2626;
}

/* 成功按钮样式 */
.btn-success {
  background: #10b981;
  border-color: #10b981;
  color: #fff;
}

.btn-success:hover:not(:disabled) {
  background: #059669;
  border-color: #059669;
}

/* Outline 按钮样式（用于"始终允许"） */
.btn-outline-warning {
  background: transparent;
  border: 1px solid #f59e0b;
  color: #f59e0b;
}

.btn-outline-warning:hover:not(:disabled) {
  background: rgba(245, 158, 11, 0.15);
  color: #fbbf24;
}

.btn-outline-danger {
  background: transparent;
  border: 1px solid #ef4444;
  color: #ef4444;
}

.btn-outline-danger:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.15);
  color: #f87171;
}

.btn-outline-success {
  background: transparent;
  border: 1px solid #10b981;
  color: #10b981;
}

.btn-outline-success:hover:not(:disabled) {
  background: rgba(16, 185, 129, 0.15);
  color: #34d399;
}

/* ==================== @ 命令补全菜单样式 ==================== */

.mention-menu {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  margin-bottom: 8px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.4);
  max-height: 320px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  z-index: 100;
  animation: mentionMenuSlideUp 0.15s ease-out;
}

@keyframes mentionMenuSlideUp {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.mention-menu-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border-color);
}

.mention-path {
  margin-left: auto;
  font-size: 11px;
  font-weight: 400;
  color: var(--text-muted);
  font-family: var(--font-mono);
  flex-shrink: 1;
  min-width: 0;
  max-width: 85%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* 从右到左显示，让省略号在左边，优先显示路径最后部分 */
  direction: rtl;
  text-align: right;
}

.mention-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 20px;
  color: var(--text-muted);
  font-size: 12px;
}

.mention-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(100, 150, 255, 0.2);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.mention-empty {
  padding: 20px;
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
}

.mention-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}

.mention-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.12s;
}

.mention-item.active {
  background: rgba(100, 150, 255, 0.15);
}

.mention-more {
  padding: 8px 12px;
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
  border-top: 1px solid var(--border-color);
  background: var(--bg-tertiary);
}

.mention-icon {
  font-size: 16px;
  flex-shrink: 0;
}

.mention-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mention-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mention-desc {
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mention-hint {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 14px;
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  border-top: 1px solid var(--border-color);
}

.mention-back-btn {
  cursor: pointer;
  padding: 4px 10px;
  background: var(--bg-surface);
  border-radius: 6px;
  font-size: 11px;
  color: var(--text-secondary);
  transition: all 0.15s;
  flex-shrink: 0;
}

.mention-back-btn:hover {
  background: var(--accent-primary);
  color: #fff;
}

.mention-hint-keys {
  display: flex;
  align-items: center;
  gap: 12px;
}

.mention-hint-keys span {
  padding: 2px 6px;
  background: var(--bg-surface);
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-secondary);
}

</style>
