<script setup lang="ts">
/**
 * 钢铁军团控制台界面
 * 多终端 Agent 协调模式的控制面板
 * 参照 AiPanel 设计的对话流式界面
 */
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { Trash2 } from 'lucide-vue-next'
import { useIronLegionStore } from '../stores/ironLegion'
import { useTerminalStore } from '../stores/terminal'
import { useConfigStore } from '../stores/config'
import { useMarkdown } from '../composables'
import type { ConfirmStrategy } from '../composables/useIronLegion'
import AgentPlanView from './AgentPlanView.vue'

const { t } = useI18n()
const configStore = useConfigStore()
const legionStore = useIronLegionStore()
const terminalStore = useTerminalStore()

// Markdown 渲染
const { renderMarkdown, handleCodeBlockClick, copyMessage } = useMarkdown()

// AI 配置
const aiProfiles = computed(() => configStore.aiProfiles)
const activeAiProfile = computed(() => configStore.activeAiProfile)
const selectedProfileId = ref(activeAiProfile.value?.id || '')

// 同步选中的 profile（当全局配置改变时）
watch(activeAiProfile, (newProfile) => {
  if (newProfile && !selectedProfileId.value) {
    selectedProfileId.value = newProfile.id
  }
}, { immediate: true })

// 任务输入
const taskInput = ref('')
const taskInputRef = ref<HTMLTextAreaElement | null>(null)
const messagesRef = ref<HTMLDivElement | null>(null)

// 确认策略
const confirmStrategy = ref<ConfirmStrategy>('batch')
const showStrategyMenu = ref(false)

// Worker 区域折叠状态
const workersCollapsed = ref(false)

// Plan 展开状态
const planExpanded = ref(false)

// 策略显示名称和描述
const strategyConfig: Record<ConfirmStrategy, { label: string; desc: string }> = {
  cautious: { label: '审慎模式', desc: '每个命令都需要确认' },
  batch: { label: '批量确认', desc: '按主机批量确认' },
  free: { label: '自由模式', desc: '自动执行所有命令' }
}

// 获取当前协调器的 Worker 终端列表
const workerTabs = computed(() => {
  if (!legionStore.orchestratorId) return []
  return terminalStore.getLegionWorkerTabs(legionStore.orchestratorId)
})

// 最小化面板
const minimizePanel = () => {
  legionStore.minimize()
}

// 关闭面板（最小化到状态栏）
const closePanel = () => {
  legionStore.minimize()
}

// 选择确认策略
const selectStrategy = (strategy: ConfirmStrategy) => {
  confirmStrategy.value = strategy
  showStrategyMenu.value = false
}

// 开始执行任务
const startTask = async () => {
  if (!taskInput.value.trim() || legionStore.isRunning) return
  
  await legionStore.startTask(taskInput.value, {
    confirmStrategy: confirmStrategy.value,
    profileId: selectedProfileId.value || undefined
  })
  
  // 清空输入框
  taskInput.value = ''
  
  // 滚动到底部
  await nextTick()
  scrollToBottom()
}

// 停止执行
const stopTask = () => {
  legionStore.stopTask()
}

// 清空对话
const clearMessages = () => {
  // 关闭所有 Worker 终端
  if (legionStore.orchestratorId) {
    terminalStore.closeLegionWorkerTabs(legionStore.orchestratorId)
  }
  legionStore.clearSession()
  taskInput.value = ''
}

// 切换到指定的 Worker 终端
const switchToWorker = (tabId: string) => {
  terminalStore.setActiveTab(tabId)
  // 最小化钢铁军团面板，让用户专注于终端
  legionStore.minimize()
}

// 获取 Worker 状态图标
const getWorkerStatusIcon = (status: string) => {
  switch (status) {
    case 'connecting': return '🔄'
    case 'idle': return '⏸️'
    case 'running': return '⚡'
    case 'completed': return '✅'
    case 'failed': return '❌'
    case 'timeout': return '⏰'
    default: return '❓'
  }
}

// 获取 Worker 状态颜色类
const getWorkerStatusClass = (status: string) => {
  switch (status) {
    case 'running': return 'status-running'
    case 'completed': return 'status-completed'
    case 'failed': return 'status-failed'
    case 'timeout': return 'status-timeout'
    default: return 'status-idle'
  }
}

// 消息图标
const getMessageIcon = (type: string) => {
  switch (type) {
    case 'user': return '👤'
    case 'agent': return '🤖'
    case 'progress': return '⏳'
    default: return 'ℹ️'
  }
}

// 滚动到底部
const scrollToBottom = () => {
  if (messagesRef.value) {
    messagesRef.value.scrollTop = messagesRef.value.scrollHeight
  }
}

// 监听消息变化，自动滚动
watch(() => legionStore.messages.length, async () => {
  await nextTick()
  scrollToBottom()
})

// 点击外部关闭策略菜单
const handleClickOutside = (e: MouseEvent) => {
  const target = e.target as HTMLElement
  if (!target.closest('.strategy-dropdown')) {
    showStrategyMenu.value = false
  }
}

// 批量确认处理
const handleBatchConfirm = (action: 'cancel' | 'current' | 'all') => {
  legionStore.respondBatchConfirm(action)
}

// 获取风险等级样式类
const getRiskClass = (level?: string) => {
  switch (level) {
    case 'dangerous': return 'risk-dangerous'
    case 'moderate': return 'risk-moderate'
    case 'safe': return 'risk-safe'
    default: return ''
  }
}

onMounted(async () => {
  document.addEventListener('click', handleClickOutside)
  legionStore.loadHosts()
  legionStore.setupListeners()
  
  // 自动聚焦输入框
  await nextTick()
  taskInputRef.value?.focus()
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})
</script>

<template>
  <div class="iron-legion-console">
    <!-- 顶部导航栏 -->
    <header class="console-header">
      <div class="header-left">
        <button class="btn-minimize" @click="minimizePanel" :title="t('legion.minimizePanel')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M6 9l6 6 6-6"/>
          </svg>
        </button>
        <h1 class="console-title">
          <span class="title-icon">🤖</span>
          {{ t('welcome.ironLegion') }}
        </h1>
        <span v-if="legionStore.isRunning" class="running-badge">
          <span class="pulse-dot"></span>
          运行中
        </span>
      </div>
      <div class="header-actions">
        <!-- 模型选择 -->
        <select 
          v-if="aiProfiles.length > 0"
          v-model="selectedProfileId"
          class="model-select"
          :disabled="legionStore.isRunning"
          :title="t('ai.switchModel')"
        >
          <option v-for="profile in aiProfiles" :key="profile.id" :value="profile.id">
            {{ profile.name }} ({{ profile.model }})
          </option>
        </select>
        <button class="btn-icon" @click="clearMessages" :title="t('common.clear')">
          <Trash2 :size="18" />
        </button>
        <button class="btn-icon btn-close" @click="closePanel" :title="t('common.close')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    </header>

    <!-- Worker 状态栏（可折叠） -->
    <div v-if="legionStore.workers.length > 0" class="workers-bar">
      <div class="workers-header" @click="workersCollapsed = !workersCollapsed">
        <div class="workers-header-left">
          <span class="workers-icon">🖥️</span>
          <span class="workers-title">Worker 终端</span>
          <span class="workers-count">{{ legionStore.workers.length }} 个</span>
        </div>
        <span class="collapse-icon" :class="{ collapsed: workersCollapsed }">▼</span>
      </div>
      <div v-show="!workersCollapsed" class="workers-grid">
        <div 
          v-for="worker in legionStore.workers" 
          :key="worker.terminalId"
          class="worker-chip"
          :class="getWorkerStatusClass(worker.status)"
          @click="switchToWorker(worker.terminalId)"
          :title="worker.currentTask || worker.status"
        >
          <span class="worker-status-icon">{{ getWorkerStatusIcon(worker.status) }}</span>
          <span class="worker-name">{{ worker.hostName }}</span>
        </div>
      </div>
    </div>

    <!-- Plan 固定顶部区域 -->
    <div v-if="legionStore.currentPlan" class="plan-sticky-header">
      <AgentPlanView 
        :plan="legionStore.currentPlan" 
        :compact="!planExpanded" 
        @toggle="planExpanded = !planExpanded" 
      />
    </div>

    <!-- 消息对话流 -->
    <div ref="messagesRef" class="messages-container" @click="handleCodeBlockClick">
      <!-- 空状态欢迎界面 -->
      <div v-if="legionStore.messages.length === 0" class="welcome-state">
        <div class="welcome-icon">🚀</div>
        <div class="welcome-title">{{ t('legion.emptyTitle') }}</div>
        <div class="welcome-desc">{{ t('legion.emptyDesc') }}</div>
        
        <div class="welcome-section">
          <div class="welcome-section-title">💡 功能说明</div>
          <ul class="welcome-list">
            <li><strong>多主机并行执行</strong> - 同时在多台服务器上执行任务</li>
            <li><strong>智能任务分发</strong> - AI 自动规划和分配任务</li>
            <li><strong>实时状态监控</strong> - 查看每个 Worker 的执行进度</li>
          </ul>
        </div>

        <div class="welcome-section">
          <div class="welcome-section-title">🎯 示例任务</div>
          <div class="example-chips">
            <span class="example-chip" @click="taskInput = '检查所有生产服务器的磁盘使用情况'">
              检查磁盘使用
            </span>
            <span class="example-chip" @click="taskInput = '查看各服务器的内存和CPU负载'">
              查看系统负载
            </span>
            <span class="example-chip" @click="taskInput = '检查 nginx 服务是否正常运行'">
              检查服务状态
            </span>
          </div>
        </div>
      </div>

      <!-- 消息列表 -->
      <template v-else>
        <div
          v-for="msg in legionStore.messages"
          :key="msg.id"
          class="message"
          :class="msg.type"
        >
          <div class="message-wrapper">
            <div class="message-content">
              <!-- 用户消息直接显示文本 -->
              <span v-if="msg.type === 'user'">{{ msg.content }}</span>
              <!-- Agent 消息使用 Markdown 渲染 -->
              <div v-else-if="msg.type === 'agent'" v-html="renderMarkdown(msg.content)" class="markdown-content"></div>
              <!-- 系统消息 -->
              <div v-else class="system-message">
                <span class="system-icon">{{ getMessageIcon(msg.type) }}</span>
                <span>{{ msg.content }}</span>
              </div>
            </div>
            <!-- 复制按钮（仅 agent 消息） -->
            <button
              v-if="msg.type === 'agent' && msg.content"
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

        <!-- 批量确认对话框（融入对话流） -->
        <div v-if="legionStore.pendingBatchConfirm" class="message assistant">
          <div class="message-wrapper">
            <div class="message-content batch-confirm-inline">
              <div class="confirm-header-inline">
                <span class="confirm-icon">⚠️</span>
                <span class="confirm-title">需要确认执行</span>
                <span class="confirm-risk-badge" :class="getRiskClass(legionStore.pendingBatchConfirm.riskLevel)">
                  {{ legionStore.pendingBatchConfirm.riskLevel === 'dangerous' ? '高风险' : '中风险' }}
                </span>
              </div>
              <div class="confirm-detail">
                <div class="confirm-command">{{ legionStore.pendingBatchConfirm.command }}</div>
                <div class="confirm-targets">
                  <span class="targets-label">目标终端:</span>
                  <div class="targets-list">
                    <span 
                      v-for="target in legionStore.pendingBatchConfirm.targetTerminals" 
                      :key="target.terminalId"
                      class="target-badge"
                    >
                      {{ target.terminalName }}
                    </span>
                  </div>
                </div>
              </div>
              <div class="confirm-actions-inline">
                <button class="btn btn-sm btn-outline-danger" @click="handleBatchConfirm('cancel')">
                  取消
                </button>
                <button class="btn btn-sm btn-outline" @click="handleBatchConfirm('current')">
                  仅当前
                </button>
                <button class="btn btn-sm btn-primary" @click="handleBatchConfirm('all')">
                  全部执行
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- 执行结果展示 -->
        <div v-if="legionStore.result && !legionStore.isRunning" class="message assistant">
          <div class="message-wrapper">
            <div class="message-content result-summary">
              <div class="result-header">
                <span class="result-icon">{{ legionStore.result.failedCount === 0 ? '✅' : '⚠️' }}</span>
                <span class="result-title">任务完成</span>
              </div>
              <div class="result-stats">
                <span class="stat-item success">
                  <span class="stat-value">{{ legionStore.result.successCount }}</span>
                  <span class="stat-label">成功</span>
                </span>
                <span class="stat-item failed" v-if="legionStore.result.failedCount > 0">
                  <span class="stat-value">{{ legionStore.result.failedCount }}</span>
                  <span class="stat-label">失败</span>
                </span>
                <span class="stat-item total">
                  <span class="stat-value">{{ legionStore.result.totalCount }}</span>
                  <span class="stat-label">总计</span>
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- AI 思考中指示器 -->
        <div v-if="legionStore.isRunning && legionStore.messages.length > 0" class="message assistant">
          <div class="message-wrapper">
            <div class="message-content thinking-indicator">
              <span class="thinking-spinner"></span>
              <span class="thinking-text">AI 正在协调执行...</span>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- 底部输入区域 -->
    <div class="input-area">
      <div class="input-container">
        <!-- 策略选择 -->
        <div class="strategy-dropdown" v-if="!legionStore.isRunning">
          <button class="btn-strategy" @click.stop="showStrategyMenu = !showStrategyMenu">
            <span class="strategy-label">{{ strategyConfig[confirmStrategy].label }}</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M6 9l6 6 6-6"/>
            </svg>
          </button>
          <div v-if="showStrategyMenu" class="strategy-menu">
            <div 
              v-for="(config, key) in strategyConfig" 
              :key="key"
              class="strategy-option"
              :class="{ active: confirmStrategy === key }"
              @click="selectStrategy(key as ConfirmStrategy)"
            >
              <span class="option-label">{{ config.label }}</span>
              <span class="option-desc">{{ config.desc }}</span>
            </div>
          </div>
        </div>
        
        <!-- 输入框 -->
        <textarea
          ref="taskInputRef"
          v-model="taskInput"
          class="task-input"
          :placeholder="legionStore.isRunning ? '任务执行中...' : t('legion.inputPlaceholder')"
          :disabled="legionStore.isRunning"
          rows="1"
          @keydown.ctrl.enter="startTask"
          @keydown.meta.enter="startTask"
        ></textarea>
        
        <!-- 发送/停止按钮 -->
        <button 
          v-if="!legionStore.isRunning"
          class="send-btn" 
          :disabled="!taskInput.trim()"
          @click="startTask"
          title="开始执行 (Ctrl+Enter)"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="22" y1="2" x2="11" y2="13"/>
            <polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
        <button 
          v-else
          class="stop-btn" 
          @click="stopTask"
          title="停止执行"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2"/>
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.iron-legion-console {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-primary);
}

/* 顶部导航栏 */
.console-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  -webkit-app-region: drag;
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
  -webkit-app-region: no-drag;
}

.btn-minimize {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-minimize:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.console-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.title-icon {
  font-size: 16px;
}

.running-badge {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  background: rgba(16, 185, 129, 0.1);
  border: 1px solid rgba(16, 185, 129, 0.3);
  border-radius: 12px;
  font-size: 11px;
  font-weight: 500;
  color: #10b981;
}

.pulse-dot {
  width: 6px;
  height: 6px;
  background: #10b981;
  border-radius: 50%;
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(0.8); }
}

.header-actions {
  display: flex;
  gap: 6px;
  align-items: center;
  -webkit-app-region: no-drag;
}

.model-select {
  padding: 4px 8px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 11px;
  cursor: pointer;
  outline: none;
  max-width: 150px;
}

.btn-icon {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-icon:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.btn-close:hover {
  background: rgba(239, 68, 68, 0.1);
  border-color: rgba(239, 68, 68, 0.3);
  color: #ef4444;
}

/* Worker 状态栏 */
.workers-bar {
  padding: 10px 16px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.workers-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  user-select: none;
}

.workers-header:hover {
  opacity: 0.8;
}

.workers-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.workers-icon {
  font-size: 14px;
}

.workers-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}

.workers-count {
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg-surface);
  padding: 2px 8px;
  border-radius: 10px;
}

.collapse-icon {
  font-size: 10px;
  color: var(--text-muted);
  transition: transform 0.2s ease;
}

.collapse-icon.collapsed {
  transform: rotate(-90deg);
}

.workers-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.worker-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 16px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.worker-chip:hover {
  border-color: var(--accent-primary);
  transform: translateY(-1px);
}

.worker-chip.status-running {
  border-color: rgba(59, 130, 246, 0.5);
  background: rgba(59, 130, 246, 0.08);
}

.worker-chip.status-completed {
  border-color: rgba(16, 185, 129, 0.5);
  background: rgba(16, 185, 129, 0.08);
}

.worker-chip.status-failed,
.worker-chip.status-timeout {
  border-color: rgba(239, 68, 68, 0.5);
  background: rgba(239, 68, 68, 0.08);
}

.worker-status-icon {
  font-size: 12px;
}

.worker-name {
  color: var(--text-primary);
  font-weight: 500;
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Plan 固定顶部区域 */
.plan-sticky-header {
  flex-shrink: 0;
  padding: 8px 12px;
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border-color);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

/* 消息容器 */
.messages-container {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  user-select: text;
  -webkit-user-select: text;
}

/* 欢迎状态 */
.welcome-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 40px 20px;
  flex: 1;
}

.welcome-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.welcome-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 8px;
}

.welcome-desc {
  font-size: 13px;
  color: var(--text-muted);
  margin-bottom: 24px;
}

.welcome-section {
  width: 100%;
  max-width: 400px;
  text-align: left;
  margin-bottom: 20px;
}

.welcome-section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 10px;
}

.welcome-list {
  margin: 0;
  padding-left: 20px;
  font-size: 12px;
  color: var(--text-secondary);
}

.welcome-list li {
  margin: 6px 0;
}

.welcome-list strong {
  color: var(--accent-primary);
}

.example-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
}

.example-chip {
  padding: 8px 14px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 18px;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s ease;
}

.example-chip:hover {
  border-color: var(--accent-primary);
  color: var(--text-primary);
  background: var(--bg-surface);
}

/* 消息样式 */
.message {
  display: flex;
}

.message.user {
  justify-content: flex-end;
}

.message.assistant,
.message.system,
.message.agent,
.message.progress {
  justify-content: flex-start;
}

.message-wrapper {
  position: relative;
  max-width: 85%;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.message-content {
  user-select: text;
  -webkit-user-select: text;
  cursor: text;
}

.message.user .message-content {
  background: var(--accent-primary);
  color: #fff;
  border-radius: 12px 12px 4px 12px;
  padding: 10px 14px;
  font-size: 13px;
  line-height: 1.5;
}

.message.assistant .message-content,
.message.agent .message-content {
  background: var(--bg-surface);
  color: var(--text-primary);
  border-radius: 12px 12px 12px 4px;
  padding: 10px 14px;
  font-size: 13px;
  line-height: 1.5;
}

.message.system .message-content,
.message.progress .message-content {
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 12px;
}

.system-message {
  display: flex;
  align-items: center;
  gap: 8px;
}

.system-icon {
  font-size: 14px;
}

/* Markdown 样式 */
.markdown-content {
  width: 100%;
  user-select: text;
  -webkit-user-select: text;
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

.markdown-content :deep(ul),
.markdown-content :deep(ol) {
  margin: 8px 0;
  padding-left: 20px;
}

.markdown-content :deep(li) {
  margin: 4px 0;
}

.markdown-content :deep(code) {
  background: rgba(255, 255, 255, 0.1);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 12px;
}

.markdown-content :deep(pre) {
  margin: 8px 0;
  padding: 10px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 6px;
  overflow-x: auto;
}

.markdown-content :deep(pre code) {
  background: transparent;
  padding: 0;
}

/* 代码块样式 */
.markdown-content :deep(.code-block) {
  margin: 12px 0;
  border-radius: 8px;
  overflow: hidden;
  background: #1a1b26;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.markdown-content :deep(.code-header) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  font-size: 11px;
  color: #7aa2f7;
  background: #16161e;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
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
}

.markdown-content :deep(.code-copy-btn:hover) {
  color: #7aa2f7;
  background: rgba(122, 162, 247, 0.15);
}

.markdown-content :deep(.code-send-btn:hover) {
  color: #9ece6a;
  background: rgba(158, 206, 106, 0.15);
}

.markdown-content :deep(.code-block pre) {
  margin: 0;
  padding: 14px 16px;
  background: #1a1b26;
}

.markdown-content :deep(.code-block code) {
  font-family: 'Fira Code', 'JetBrains Mono', monospace;
  font-size: 13px;
  line-height: 1.6;
  color: #a9b1d6;
}

/* 复制按钮 */
.copy-btn {
  align-self: flex-start;
  padding: 4px 8px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--text-muted);
  cursor: pointer;
  opacity: 0.6;
  transition: all 0.2s ease;
}

.copy-btn:hover {
  opacity: 1;
  background: var(--bg-hover);
  color: var(--accent-primary);
}

/* 批量确认对话框 */
.batch-confirm-inline {
  padding: 14px !important;
  background: linear-gradient(135deg, rgba(245, 158, 11, 0.15), rgba(245, 158, 11, 0.05)) !important;
  border: 1px solid rgba(245, 158, 11, 0.3) !important;
}

.confirm-header-inline {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
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

.confirm-risk-badge.risk-safe {
  background: rgba(16, 185, 129, 0.2);
  color: #10b981;
}

.confirm-detail {
  margin-bottom: 14px;
}

.confirm-command {
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 10px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 6px;
  margin-bottom: 10px;
  word-break: break-all;
}

.confirm-targets {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.targets-label {
  font-size: 11px;
  color: var(--text-muted);
}

.targets-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.target-badge {
  padding: 4px 10px;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  font-size: 11px;
  color: var(--text-secondary);
}

.confirm-actions-inline {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}

/* 结果摘要 */
.result-summary {
  padding: 14px !important;
}

.result-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.result-icon {
  font-size: 20px;
}

.result-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.result-stats {
  display: flex;
  gap: 16px;
}

.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 10px 16px;
  border-radius: 8px;
}

.stat-item.success {
  background: rgba(16, 185, 129, 0.1);
}

.stat-item.failed {
  background: rgba(239, 68, 68, 0.1);
}

.stat-item.total {
  background: var(--bg-tertiary);
}

.stat-value {
  font-size: 20px;
  font-weight: 700;
}

.stat-item.success .stat-value { color: #10b981; }
.stat-item.failed .stat-value { color: #ef4444; }
.stat-item.total .stat-value { color: var(--text-primary); }

.stat-label {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 2px;
}

/* 思考指示器 */
.thinking-indicator {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px !important;
  background: linear-gradient(135deg, rgba(52, 211, 153, 0.06), rgba(16, 185, 129, 0.06)) !important;
  border: 1px solid rgba(52, 211, 153, 0.12) !important;
}

.thinking-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(52, 211, 153, 0.2);
  border-top-color: #34d399;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.thinking-text {
  font-size: 13px;
  color: rgba(110, 231, 183, 0.9);
  animation: pulse-text 2s ease-in-out infinite;
}

@keyframes pulse-text {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

/* 底部输入区域 */
.input-area {
  padding: 12px 16px 16px;
  border-top: 1px solid var(--border-color);
  background: linear-gradient(180deg, var(--bg-tertiary) 0%, var(--bg-primary) 100%);
  flex-shrink: 0;
}

.input-container {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  padding: 8px 10px 8px 12px;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 16px;
  transition: all 0.3s ease;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}

.input-container:focus-within {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 3px rgba(100, 150, 255, 0.15), 0 4px 12px rgba(0, 0, 0, 0.2);
}

/* 策略选择 */
.strategy-dropdown {
  position: relative;
  flex-shrink: 0;
}

.btn-strategy {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
}

.btn-strategy:hover {
  background: var(--bg-surface);
  color: var(--text-primary);
}

.strategy-menu {
  position: absolute;
  bottom: 100%;
  left: 0;
  margin-bottom: 6px;
  min-width: 160px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
  overflow: hidden;
  z-index: 100;
}

.strategy-option {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 14px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.strategy-option:hover {
  background: var(--bg-tertiary);
}

.strategy-option.active {
  background: rgba(59, 130, 246, 0.1);
}

.option-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.strategy-option.active .option-label {
  color: var(--accent-primary);
}

.option-desc {
  font-size: 11px;
  color: var(--text-muted);
}

/* 任务输入 */
.task-input {
  flex: 1;
  padding: 8px 4px;
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

.task-input::placeholder {
  color: var(--text-muted);
  opacity: 0.7;
}

.task-input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* 发送按钮 */
.send-btn {
  flex-shrink: 0;
  padding: 10px 14px;
  border-radius: 12px;
  background: linear-gradient(135deg, #34d399 0%, #10b981 50%, #059669 100%);
  border: none;
  color: #fff;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(16, 185, 129, 0.35);
  transition: all 0.25s ease;
}

.send-btn:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 16px rgba(16, 185, 129, 0.45);
}

.send-btn:active:not(:disabled) {
  transform: translateY(0) scale(0.97);
}

.send-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  box-shadow: none;
}

/* 停止按钮 */
.stop-btn {
  flex-shrink: 0;
  padding: 10px 14px;
  border-radius: 12px;
  background: linear-gradient(135deg, #f87171 0%, #ef4444 50%, #dc2626 100%);
  border: none;
  color: #fff;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(239, 68, 68, 0.35);
  animation: pulse-glow 1.5s ease-in-out infinite;
  transition: all 0.25s ease;
}

.stop-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 16px rgba(239, 68, 68, 0.5);
}

@keyframes pulse-glow {
  0%, 100% {
    box-shadow: 0 2px 8px rgba(239, 68, 68, 0.35);
  }
  50% {
    box-shadow: 0 2px 16px rgba(239, 68, 68, 0.55);
  }
}

/* 按钮样式 */
.btn {
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 500;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-sm {
  padding: 5px 10px;
  font-size: 11px;
}

.btn-primary {
  background: var(--accent-primary);
  border: 1px solid var(--accent-primary);
  color: #fff;
}

.btn-primary:hover {
  filter: brightness(1.1);
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

.btn-outline-danger {
  background: transparent;
  border: 1px solid #ef4444;
  color: #ef4444;
}

.btn-outline-danger:hover {
  background: rgba(239, 68, 68, 0.1);
}
</style>
