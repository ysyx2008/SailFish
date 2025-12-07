<script setup lang="ts">
/**
 * AI 面板组件
 * 重构版本：使用 composables 模块化管理逻辑
 */
import { ref, computed, watch, inject, onMounted } from 'vue'
import { useConfigStore } from '../stores/config'
import { useTerminalStore } from '../stores/terminal'

// 导入 composables
import {
  useMarkdown,
  useDocumentUpload,
  useContextStats,
  useHostProfile,
  useAiChat,
  useAgentMode
} from '../composables'

// Emits
const emit = defineEmits<{
  close: []
}>()

// Stores
const configStore = useConfigStore()
const terminalStore = useTerminalStore()
const showSettings = inject<() => void>('showSettings')

// Refs
const messagesRef = ref<HTMLDivElement | null>(null)

// ==================== 初始化 Composables ====================

// 当前终端 ID（先从 store 获取，供 useDocumentUpload 使用）
const currentTabId = computed(() => terminalStore.activeTabId)

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
} = useAiChat(getDocumentContext, messagesRef)

// Agent 模式（需要 inputText 和 scrollToBottom）
// 先创建一个临时的 agentState computed 用于 useHostProfile
const tempAgentState = computed(() => {
  const activeTab = terminalStore.activeTab
  return activeTab?.agentState
})

// 主机档案
const {
  currentHostProfile,
  isLoadingProfile,
  isProbing,
  getHostId,
  loadHostProfile,
  refreshHostProfile,
  summarizeAgentFindings,
  autoProbeHostProfile
} = useHostProfile(tempAgentState)

// Agent 模式
const {
  agentMode,
  strictMode,
  commandTimeout,
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
  getStepIcon,
  getRiskClass
} = useAgentMode(
  inputText,
  scrollToBottom,
  scrollToBottomIfNeeded,
  getDocumentContext,
  getHostId,
  autoProbeHostProfile,
  summarizeAgentFindings
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

// ==================== 消息清空 ====================

// 清空对话（包括 Agent 状态和历史）
const clearMessages = () => {
  if (currentTabId.value) {
    terminalStore.clearAiMessages(currentTabId.value)
    terminalStore.clearAgentState(currentTabId.value, false)  // 不保留历史
  }
  // 清空上传的文档
  clearUploadedDocs()
}

// ==================== 确认框辅助函数 ====================

// 工具名称中文映射
const getToolDisplayName = (toolName: string) => {
  const names: Record<string, string> = {
    execute_command: '执行命令',
    read_file: '读取文件',
    write_file: '写入文件',
    get_terminal_context: '获取终端上下文'
  }
  return names[toolName] || toolName
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

// 检查任务组是否正在流式输出（AI 已开始返回内容）
const isStreamingOutput = (group: typeof agentTaskGroups.value[0]) => {
  if (group.steps.length === 0) return false
  const lastStep = group.steps[group.steps.length - 1]
  // 如果最后一个步骤是 message 类型且正在流式输出，或者最后一个步骤是 message 类型且有内容
  // 说明 AI 已经开始返回内容了，不需要显示"思考中"
  return lastStep.type === 'message' && (lastStep.isStreaming || lastStep.content.length > 0)
}

// ==================== 发送消息 ====================

// 发送消息（根据模式选择普通对话或 Agent）
const handleSend = () => {
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

// ==================== 生命周期 ====================

onMounted(() => {
  // 加载主机档案
  loadHostProfile()
})
</script>

<template>
  <div 
    class="ai-panel"
    @dragenter="handleDragEnter"
    @dragover="handleDragOver"
    @dragleave="handleDragLeave"
    @drop="handleDrop"
  >
    <!-- 拖放提示覆盖层 -->
    <div v-if="isDraggingOver" class="drop-overlay">
      <div class="drop-content">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        <p>释放以上传文档</p>
        <span class="drop-hint">支持 PDF、Word、文本等格式</span>
      </div>
    </div>

    <div class="ai-header">
      <h3>AI 助手</h3>
      <div class="ai-header-actions">
        <!-- 模型选择 -->
        <select 
          v-if="aiProfiles.length > 0"
          class="model-select"
          :value="activeAiProfile?.id || ''"
          title="切换 AI 模型"
          @change="changeAiProfile(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="profile in aiProfiles" :key="profile.id" :value="profile.id">
            {{ profile.name }} ({{ profile.model }})
          </option>
        </select>
        <button class="btn-icon" @click="clearMessages" title="清空对话">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
        <button class="btn-icon" @click="emit('close')" title="关闭面板">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- 未配置 AI 提示 -->
    <div v-if="!hasAiConfig" class="ai-no-config">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="12" cy="12" r="10"/>
        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
        <line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
      <p>尚未配置 AI 模型</p>
      <button class="btn btn-primary btn-sm" @click="showSettings?.()">
        前往设置
      </button>
    </div>

    <template v-else>
      <!-- 模式切换 -->
      <div class="mode-switcher">
        <button 
          class="mode-btn" 
          :class="{ active: agentMode }"
          title="Agent 模式：AI 自主执行命令完成任务"
          @click="agentMode = true"
        >
          🤖 Agent
        </button>
        <button 
          class="mode-btn" 
          :class="{ active: !agentMode }"
          title="对话模式：与 AI 进行问答交流"
          @click="agentMode = false"
        >
          💬 对话
        </button>
      </div>

      <!-- 系统环境信息 + Agent 设置 -->
      <div class="system-info-bar">
        <div v-if="currentSystemInfo" class="system-info-left">
        <span class="system-icon">💻</span>
        <span class="system-text">
          {{ currentSystemInfo.os === 'windows' ? 'Windows' : currentSystemInfo.os === 'macos' ? 'macOS' : 'Linux' }}
          · {{ currentSystemInfo.shell === 'powershell' ? 'PowerShell' : currentSystemInfo.shell === 'cmd' ? 'CMD' : currentSystemInfo.shell === 'bash' ? 'Bash' : currentSystemInfo.shell === 'zsh' ? 'Zsh' : currentSystemInfo.shell }}
        </span>
        </div>
        <!-- Agent 模式设置 -->
        <div v-if="agentMode" class="agent-settings">
          <!-- 超时设置 -->
          <div class="timeout-setting" title="命令执行超时时间">
            <span class="timeout-label">超时</span>
            <select v-model.number="commandTimeout" class="timeout-select">
              <option :value="5">5s</option>
              <option :value="10">10s</option>
              <option :value="30">30s</option>
              <option :value="60">60s</option>
              <option :value="120">2m</option>
              <option :value="300">5m</option>
            </select>
          </div>
          <!-- 严格模式开关 -->
          <div class="strict-mode-toggle" @click.stop="strictMode = !strictMode" :title="strictMode ? '严格模式：每个命令都需确认' : '宽松模式：仅危险命令需确认'">
            <span class="toggle-label">{{ strictMode ? '严格' : '宽松' }}</span>
            <span class="toggle-switch" :class="{ active: strictMode }">
              <span class="toggle-dot"></span>
            </span>
          </div>
        </div>
      </div>

      <!-- 错误诊断提示（Agent 执行时隐藏） -->
      <div v-if="lastError && !isAgentRunning" class="error-alert">
        <div class="error-alert-icon">⚠️</div>
        <div class="error-alert-content">
          <div class="error-alert-title">检测到错误</div>
          <div class="error-alert-text">{{ lastError.content.slice(0, 80) }}{{ lastError.content.length > 80 ? '...' : '' }}</div>
        </div>
        <button class="error-alert-btn" @click="handleDiagnoseError" :disabled="isLoading">
          AI 诊断
        </button>
        <button class="error-alert-close" @click="terminalStore.clearError(terminalStore.activeTab?.id || '')" title="关闭错误提示">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      <!-- 终端选中内容提示（Agent 执行时隐藏） -->
      <div v-if="terminalSelectedText && !lastError && !isAgentRunning" class="selection-alert">
        <div class="selection-alert-icon">📋</div>
        <div class="selection-alert-content">
          <div class="selection-alert-title">已选中终端内容</div>
          <div class="selection-alert-text">{{ terminalSelectedText.slice(0, 60) }}{{ terminalSelectedText.length > 60 ? '...' : '' }}</div>
        </div>
        <button class="selection-alert-btn" @click="handleAnalyzeSelection" :disabled="isLoading">
          AI 分析
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

      <!-- 消息列表 -->
      <div ref="messagesRef" class="ai-messages" @click="handleCodeBlockClick" @scroll="updateScrollPosition">
        <div v-if="messages.length === 0 && !agentMode" class="ai-welcome">
          <p>👋 你好！我是旗鱼终端的 AI 助手。</p>
          <p class="welcome-section-title">💬 直接对话</p>
          <p class="welcome-desc">在下方输入框输入任何问题，我会尽力帮你解答。</p>
          
          <p class="welcome-section-title">🚀 快捷功能</p>
          <ul>
            <li><strong>解释命令</strong> - 选中终端内容后点击按钮解释，或直接点击查看示例</li>
            <li><strong>错误诊断</strong> - 终端出错时自动提示，点击「AI 诊断」</li>
            <li><strong>生成命令</strong> - 用自然语言描述需求，如「查找大于100M的文件」</li>
            <li><strong>分析输出</strong> - 选中终端内容后，自动显示「AI 分析」按钮</li>
          </ul>

          <p class="welcome-section-title">✨ 使用技巧</p>
          <ul>
            <li>终端右键菜单可「发送到 AI 分析」</li>
            <li>AI 回复中的代码块可一键发送到终端</li>
            <li>每个终端标签页有独立的对话记录</li>
            <li>我会根据你的系统环境生成合适的命令</li>
          </ul>
        </div>
        <div v-if="agentMode && !agentUserTask" class="ai-welcome">
          <p>🤖 Agent 模式已启用</p>
          
          <!-- 主机档案信息 -->
          <div class="host-profile-section">
            <p class="welcome-section-title">
              🖥️ 主机信息
              <button 
                class="refresh-profile-btn" 
                @click="refreshHostProfile" 
                :disabled="isProbing"
                :title="isProbing ? '探测中...' : '刷新主机信息'"
              >
                <span :class="{ spinning: isProbing }">🔄</span>
              </button>
            </p>
            <div v-if="currentHostProfile" class="host-profile-info">
              <div class="profile-row">
                <span class="profile-label">主机:</span>
                <span class="profile-value">{{ currentHostProfile.hostname || '未知' }}</span>
                <span v-if="currentHostProfile.username" class="profile-value-secondary">@ {{ currentHostProfile.username }}</span>
              </div>
              <div v-if="currentHostProfile.osVersion || currentHostProfile.os" class="profile-row">
                <span class="profile-label">系统:</span>
                <span class="profile-value">{{ currentHostProfile.osVersion || currentHostProfile.os }}</span>
              </div>
              <div v-if="currentHostProfile.shell" class="profile-row">
                <span class="profile-label">Shell:</span>
                <span class="profile-value">{{ currentHostProfile.shell }}</span>
                <span v-if="currentHostProfile.packageManager" class="profile-value-secondary">| {{ currentHostProfile.packageManager }}</span>
              </div>
              <div v-if="currentHostProfile.installedTools?.length" class="profile-row">
                <span class="profile-label">工具:</span>
                <span class="profile-value tools-list">{{ currentHostProfile.installedTools.join(', ') }}</span>
              </div>
              <div v-if="currentHostProfile.notes?.length" class="profile-notes">
                <span class="profile-label">📝 已知信息:</span>
                <ul>
                  <li v-for="(note, idx) in currentHostProfile.notes.slice(-5)" :key="idx">{{ note }}</li>
                </ul>
              </div>
            </div>
            <div v-else-if="isLoadingProfile" class="host-profile-loading">
              加载中...
            </div>
            <div v-else class="host-profile-empty">
              <span>尚未探测，点击刷新按钮探测主机信息</span>
            </div>
          </div>

          <p class="welcome-section-title">💡 什么是 Agent 模式？</p>
          <p class="welcome-desc">Agent 可以自主执行命令来完成你的任务，你可以看到完整的执行过程。</p>
          
          <p class="welcome-section-title">🎯 使用示例</p>
          <ul>
            <li>「查看服务器磁盘空间，如果超过80%就清理日志」</li>
            <li>「检查 nginx 服务状态，如果没运行就启动它」</li>
            <li>「找出占用内存最多的进程并显示详情」</li>
            <li>「在当前目录创建一个 backup 文件夹并备份所有配置文件」</li>
          </ul>

          <p class="welcome-section-title">{{ strictMode ? '🔒 严格模式' : '🔓 宽松模式' }} <span class="strict-badge" :class="{ relaxed: !strictMode }">{{ strictMode ? '已开启' : '已开启' }}</span></p>
          <ul>
            <li v-if="strictMode"><strong>每个命令都需要你确认</strong>后才会执行</li>
            <li v-if="strictMode">适合敏感环境，完全掌控每一步操作</li>
            <li v-if="!strictMode"><strong>安全命令自动执行</strong>，只有危险命令需要确认</li>
            <li v-if="!strictMode">适合日常使用，提高效率的同时保障安全</li>
            <li>所有命令都在终端执行，你可以看到完整输入输出</li>
          </ul>

          <p class="welcome-section-title">⚠️ 注意事项</p>
          <ul>
            <li>危险命令（如删除、修改系统文件）始终需要确认</li>
            <li>你可以随时点击「停止」中止 Agent 执行</li>
            <li><strong>不适合</strong>长时间运行的命令（如大型编译、数据迁移）</li>
            <li><strong>不适合</strong>循环/交互式命令（如 <code>watch</code>、<code>top</code>、<code>tail -f</code>、<code>vim</code>）</li>
          </ul>
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
              title="复制"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
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
                    <span class="thinking-text">Agent 启动中...</span>
                  </div>
                </div>
              </div>
            </div>
            
            <!-- 执行步骤（折叠块） -->
            <div v-if="group.steps.length > 0" class="message assistant">
              <div class="message-wrapper agent-steps-wrapper">
                <div class="message-content agent-steps-content">
                  <div class="agent-steps-header-inline" @click="toggleStepsCollapse(group.id)">
                    <span>🤖 {{ group.isCurrentTask && isAgentRunning ? 'Agent 执行中' : 'Agent 执行记录' }}</span>
                    <span v-if="group.isCurrentTask && isAgentRunning" class="agent-running-dot"></span>
                    <span class="steps-count">{{ group.steps.length }} 步</span>
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
                          v-html="renderMarkdown(step.content)"
                        ></div>
                        <div v-else class="step-text">
                          {{ step.content }}
                        </div>
                        <div v-if="step.toolResult && step.toolResult !== '已拒绝'" class="step-result">
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
                      <span class="thinking-text">AI 正在思考中...</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            
            <!-- 最终结果 -->
            <div v-if="group.finalResult" class="message assistant">
              <div class="message-wrapper agent-final-wrapper">
                <div class="message-content agent-final-content" :class="{ 'is-error': group.finalResult.startsWith('❌') }">
                  <div class="agent-final-header">
                    <span class="final-icon">{{ group.finalResult.startsWith('❌') ? '❌' : '✅' }}</span>
                    <span class="final-title">{{ group.finalResult.startsWith('❌') ? '任务失败' : '任务完成' }}</span>
                  </div>
                  <div class="agent-final-body markdown-content" v-html="renderMarkdown(group.finalResult.replace(/^[❌✅]\s*(Agent\s*(执行失败|运行出错)[:\s]*)?/, ''))"></div>
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
                  <span class="pending-label">补充信息（等待处理）</span>
                  <span class="pending-spinner"></span>
                </div>
                <div class="pending-supplement-content">{{ supplement }}</div>
              </div>
            </div>
          </div>
        </template>

        <!-- Agent 确认对话框（融入对话流） -->
        <div v-if="pendingConfirm" class="message assistant">
          <div class="message-wrapper">
            <div class="message-content agent-confirm-inline">
              <div class="confirm-header-inline">
                <span class="confirm-icon">⚠️</span>
                <span class="confirm-title">需要确认</span>
                <span class="confirm-risk-badge" :class="getRiskClass(pendingConfirm.riskLevel)">
                  {{ pendingConfirm.riskLevel === 'dangerous' ? '高风险' : '中风险' }}
                </span>
              </div>
              <div class="confirm-detail">
                <div class="confirm-tool-name">{{ getToolDisplayName(pendingConfirm.toolName) }}</div>
                <pre class="confirm-args-inline">{{ formatConfirmArgs(pendingConfirm) }}</pre>
              </div>
              <div class="confirm-actions-inline">
                <button class="btn btn-sm btn-outline-danger" @click="confirmToolCall(false)">
                  拒绝
                </button>
                <button class="btn btn-sm btn-primary" @click="confirmToolCall(true)">
                  允许执行
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- 新消息指示器 -->
        <div v-if="hasNewMessage" class="new-message-indicator" @click="scrollToBottom" title="点击滚动到底部">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
          <span>新消息</span>
        </div>
      </div>

      <!-- 上下文使用情况 -->
      <div v-if="messages.length > 0 || (agentMode && agentUserTask)" class="context-stats">
        <div class="context-info">
          <span class="context-label">上下文</span>
          <span class="context-value">~{{ contextStats.tokenEstimate.toLocaleString() }} / {{ (contextStats.maxTokens / 1000).toFixed(0) }}K</span>
        </div>
        <div class="context-bar" :title="`${contextStats.percentage}% 已使用`">
          <div 
            class="context-bar-fill" 
            :style="{ width: contextStats.percentage + '%' }"
            :class="{ 
              'warning': contextStats.percentage > 60, 
              'danger': contextStats.percentage > 85 
            }"
          ></div>
        </div>
      </div>

      <!-- 已上传文档列表 -->
      <div v-if="uploadedDocs.length > 0" class="uploaded-docs">
        <div class="uploaded-docs-header">
          <span class="uploaded-docs-title">📎 已上传文档 ({{ uploadedDocs.length }})</span>
          <button class="btn-clear-docs" @click="clearUploadedDocs" title="清空所有文档">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
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
            <span v-if="doc.error" class="doc-error" :title="doc.error">⚠️</span>
            <button class="btn-remove-doc" @click="removeUploadedDoc(index)" title="移除">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>
      </div>

      <!-- 输入区域 -->
      <div class="ai-input">
        <div class="input-container">
          <!-- 上传按钮 -->
          <button 
            class="upload-btn" 
            @click="() => selectAndUploadDocs()" 
            :disabled="isUploadingDocs"
            title="上传文档 (PDF/Word/文本)"
          >
            <svg v-if="!isUploadingDocs" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
            </svg>
            <span v-else class="upload-spinner"></span>
          </button>
          <textarea
            v-model="inputText"
            :placeholder="isAgentRunning ? '输入补充信息（将在下一步生效）...' : (agentMode ? '描述你想让 Agent 完成的任务...' : '输入问题或描述你想要的命令...')"
            rows="1"
            @keydown.enter.exact.prevent="handleSend"
          ></textarea>
          <!-- 停止按钮 (普通对话模式) -->
          <button
            v-if="isLoading && !agentMode"
            class="btn btn-danger stop-btn"
            @click="stopGeneration"
            title="停止生成"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2"/>
            </svg>
          </button>
          <!-- Agent 运行中：有输入显示补充按钮，无输入显示停止按钮 -->
          <button
            v-else-if="isAgentRunning && inputText.trim()"
            class="send-btn send-btn-supplement"
            title="发送补充信息 (Enter)"
            @click="handleSend"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="22" y1="2" x2="11" y2="13"/>
              <polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
          </button>
          <button
            v-else-if="isAgentRunning"
            class="btn btn-danger stop-btn"
            @click="abortAgent"
            title="停止 Agent"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2"/>
            </svg>
          </button>
          <!-- 发送按钮 -->
          <button
            v-else
            class="send-btn"
            :class="{ 'send-btn-agent': agentMode }"
            :disabled="!inputText.trim()"
            :title="agentMode ? '执行任务 (Enter)' : '发送消息 (Enter)'"
            @click="handleSend"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="22" y1="2" x2="11" y2="13"/>
              <polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
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
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
}

.ai-header h3 {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.ai-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
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
  padding: 8px 12px;
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

.ai-messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  user-select: text;
  position: relative;
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

/* 上下文使用情况 */
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
  padding: 16px;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.6;
}

.ai-welcome .welcome-section-title {
  font-weight: 600;
  color: var(--text-primary);
  margin-top: 14px;
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.ai-welcome .welcome-desc {
  color: var(--text-muted);
  font-size: 12px;
  margin-bottom: 4px;
}

/* 主机档案区域 */
.host-profile-section {
  background: var(--bg-tertiary);
  border-radius: 8px;
  padding: 12px;
  margin: 8px 0 16px 0;
  border: 1px solid var(--border-color);
}

.host-profile-section .welcome-section-title {
  margin-top: 0;
  margin-bottom: 10px;
}

.refresh-profile-btn {
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 14px;
  transition: all 0.2s ease;
}

.refresh-profile-btn:hover:not(:disabled) {
  background: var(--bg-surface);
}

.refresh-profile-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.refresh-profile-btn .spinning {
  display: inline-block;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.host-profile-info {
  font-size: 12px;
}

.profile-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
}

.profile-label {
  color: var(--text-secondary);
  min-width: 40px;
}

.profile-value {
  color: var(--text-primary);
}

.profile-value-secondary {
  color: var(--text-muted);
  font-size: 11px;
}

.profile-value.tools-list {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--accent-primary);
}

.profile-notes {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border-color);
}

.profile-notes .profile-label {
  display: block;
  margin-bottom: 4px;
  font-size: 11px;
}

.profile-notes ul {
  margin: 0;
  padding-left: 16px;
}

.profile-notes li {
  color: var(--text-muted);
  font-size: 11px;
  padding: 2px 0;
}

.host-profile-loading,
.host-profile-empty {
  color: var(--text-muted);
  font-size: 12px;
  font-style: italic;
}

.ai-welcome ul {
  margin: 6px 0 8px;
  padding-left: 18px;
}

.ai-welcome li {
  margin: 4px 0;
  color: var(--text-muted);
  font-size: 12px;
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

.message {
  margin-bottom: 12px;
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
  display: flex;
  align-items: flex-end;
  gap: 10px;
  padding: 12px 14px 14px;
  border-top: 1px solid var(--border-color);
  background: linear-gradient(180deg, var(--bg-tertiary) 0%, var(--bg-primary) 100%);
}

/* 输入框容器 - 包含输入框和按钮的统一容器 */
.input-container {
  flex: 1;
  display: flex;
  align-items: flex-end;
  gap: 10px;
  padding: 8px 10px 8px 12px;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 16px;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.03);
}

.input-container:focus-within {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 3px rgba(100, 150, 255, 0.15), 0 4px 12px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.05);
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
  max-height: 120px;
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
}

.mode-btn {
  flex: 1;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.mode-btn:hover {
  background: var(--bg-surface);
  color: var(--text-primary);
}

.mode-btn.active {
  background: var(--accent-primary);
  color: #fff;
  border-color: var(--accent-primary);
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
  padding: 2px 4px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  color: var(--text-primary);
  cursor: pointer;
  outline: none;
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
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.08), rgba(139, 92, 246, 0.08));
  border-radius: 8px;
  border: 1px solid rgba(99, 102, 241, 0.15);
}

.thinking-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(99, 102, 241, 0.2);
  border-top-color: #6366f1;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

.thinking-text {
  font-size: 13px;
  color: rgba(99, 102, 241, 0.9);
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
  color: rgba(99, 102, 241, 0.9);
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

.agent-step-inline.user_supplement {
  background: rgba(245, 158, 11, 0.1);
  border-left: 3px solid #f59e0b;
  padding-left: 10px;
  margin-left: -2px;
  border-radius: 4px;
  color: var(--text-primary);
}

.agent-step-inline.user_supplement .step-icon {
  color: #f59e0b;
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
  background: linear-gradient(135deg, rgba(245, 158, 11, 0.15), rgba(245, 158, 11, 0.05)) !important;
  border: 1px solid rgba(245, 158, 11, 0.3) !important;
}

.confirm-header-inline {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.confirm-icon {
  font-size: 18px;
}

.confirm-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.confirm-risk-badge {
  padding: 3px 8px;
  font-size: 10px;
  font-weight: 600;
  border-radius: 10px;
  margin-left: auto;
}

.confirm-risk-badge.risk-dangerous {
  background: rgba(239, 68, 68, 0.2);
  color: #ef4444;
}

.confirm-risk-badge.risk-moderate {
  background: rgba(245, 158, 11, 0.2);
  color: #f59e0b;
}

.confirm-detail {
  margin-bottom: 12px;
}

.confirm-tool-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent-primary);
  margin-bottom: 6px;
}

.confirm-args-inline {
  padding: 10px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 6px;
  font-family: var(--font-mono);
  font-size: 12px;
  margin: 0;
  max-height: 100px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-primary);
}

.confirm-actions-inline {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}

.btn-outline-danger {
  background: transparent;
  border: 1px solid #ef4444;
  color: #ef4444;
}

.btn-outline-danger:hover {
  background: rgba(239, 68, 68, 0.1);
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
</style>
